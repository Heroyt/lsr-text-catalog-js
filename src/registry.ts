import { catalogGroup } from "./group.js";
import { createGettext } from "vue3-gettext";
import type {
  CatalogLanguageOptions,
  CatalogMessages,
  CatalogSourceTexts,
  CompiledCatalogGroup,
  Language,
  RuntimeCatalogGroup,
  Translations,
} from "./types.js";

type Message = string | string[];
type MessageContexts = Record<string, Message>;
type MessageTable = Record<string, Message | MessageContexts>;

// Data keys are arbitrary source texts; never let "__proto__" mutate a prototype.
function assign(target: Record<string, unknown>, key: string, value: unknown) {
  if (key === "__proto__")
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  else target[key] = value;
}

/** Merge one loaded group into a locale table without sharing mutable nested data between apps. */
function mergeMessages(target: MessageTable, messages: CatalogMessages): void {
  for (const [rawId, message] of Object.entries(messages)) {
    // vue3-gettext normalizes line endings of msgids in its own constructor/setter.
    const id = rawId.replaceAll(/\r?\n/gu, "\n");
    if (typeof message === "string" || Array.isArray(message)) {
      assign(target, id, typeof message === "string" ? message : [...message]);
      continue;
    }
    const existing = Object.hasOwn(target, id) ? target[id] : undefined;
    const contexts: MessageContexts =
      typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    for (const [context, translation] of Object.entries(message))
      assign(
        contexts,
        context,
        Array.isArray(translation) ? [...translation] : translation,
      );
    if (contexts !== existing) assign(target, id, contexts);
  }
}

export interface TextRegistryOptions<
  Group extends string,
  Locale extends string,
> extends CatalogLanguageOptions<Locale> {
  readonly catalogGroups: Readonly<
    Record<Group, CompiledCatalogGroup | RuntimeCatalogGroup>
  >;
}

type GroupLoader = (groups: readonly string[]) => Promise<void>;

// Generated `catalogGroups` object → every facade created from it (weak: facades may be dropped).
const facades = new WeakMap<
  object,
  { loaders: Set<WeakRef<GroupLoader>>; queued: Set<string> }
>();

function facadesOf(catalogGroups: object) {
  let entry = facades.get(catalogGroups);
  if (!entry)
    facades.set(
      catalogGroups,
      (entry = { loaders: new Set(), queued: new Set() }),
    );
  return entry;
}

/**
 * Load groups into every facade created from these generated catalog groups; the Vite plugin's
 * group modules use it, so consumer facades need not export a loading API.
 *
 * - `chunkGroups` is every group of the importing build chunk: bundled modules await sequentially,
 *   so the first group module of a chunk starts all of them in parallel.
 * - Never rejects: a rejected top-level await would permanently fail the importing module. Failures
 *   become the cause of the "not loaded" error on use, which also retries the load.
 * - Groups requested before any facade exists (an import cycle through the facade) load once one
 *   is created.
 */
export async function loadCatalogGroups(
  catalogGroups: object,
  groups: readonly string[],
  chunkGroups?: readonly string[] | string,
): Promise<void> {
  const wanted = Array.isArray(chunkGroups)
    ? [...new Set([...groups, ...chunkGroups])]
    : groups;
  const entry = facadesOf(catalogGroups);
  const loaders: GroupLoader[] = [];
  for (const reference of entry.loaders) {
    const load = reference.deref();
    if (load) loaders.push(load);
    else entry.loaders.delete(reference);
  }
  if (!loaders.length) {
    for (const group of wanted) entry.queued.add(group);
    return;
  }
  await Promise.all(loaders.map((load) => load(wanted)));
}

interface InstanceState {
  /** Catalog groups this instance rendered, for preloading their modules. */
  readonly used: Set<string>;
  /** Latest setLocale() call; earlier, slower calls must not win. */
  switching: number;
}

/**
 * One facade's immutable lazily loaded catalog data. Loaded groups are shared by every app/request
 * instance of the facade; per-instance gettext state receives its own cloned copies of the
 * locales it uses.
 */
export function createTextRegistry<Group extends string, Locale extends string>(
  options: TextRegistryOptions<Group, Locale>,
  withSources: boolean,
) {
  const sourceLocale: string = options.sourceLocale;
  const locales = new Set<string>(options.locales);
  if (
    !sourceLocale ||
    !locales.has(sourceLocale) ||
    locales.size !== options.locales.length
  ) {
    throw new Error(
      "Catalog locales must be unique and include the source locale.",
    );
  }
  const groups = new Map<string, CompiledCatalogGroup | RuntimeCatalogGroup>();
  for (const [name, group] of Object.entries(options.catalogGroups) as [
    string,
    CompiledCatalogGroup | RuntimeCatalogGroup,
  ][]) {
    for (const locale of locales) {
      if (
        locale !== sourceLocale &&
        (!Object.hasOwn(group.translations, locale) ||
          typeof group.translations[locale] !== "function")
      )
        throw new Error(
          `Catalog group "${name}" has no translation loader for locale "${locale}".`,
        );
    }
    if (
      withSources &&
      typeof (group as RuntimeCatalogGroup).source !== "function"
    )
      throw new Error(`Catalog group "${name}" has no source copy loader.`);
    groups.set(name, group);
  }
  const availableLanguages = Object.fromEntries(
    [...locales].map((locale) => [
      locale,
      options.languageNames?.[locale as Locale] ?? locale,
    ]),
  );
  const required = new Set<string>();
  // Target locales whose required groups are loaded; the source locale needs no translations.
  const active = new Set<string>();
  const sources = new Map<string, CatalogSourceTexts>();
  const translations = new Map<string, Map<string, CatalogMessages>>();
  const pending = new Map<string, Promise<void>>();
  // Last failure per load id, kept as the cause of "not loaded" errors until the load succeeds.
  const failures = new Map<string, unknown>();
  // Weak: SSR request instances must not be retained by the shared facade.
  const languages = new Set<WeakRef<Language>>();
  const finalizer = new FinalizationRegistry<WeakRef<Language>>((reference) =>
    languages.delete(reference),
  );
  const instances = new WeakMap<Language, InstanceState>();

  function stateOf(language: Language): InstanceState {
    let state = instances.get(language);
    if (!state)
      instances.set(language, (state = { used: new Set(), switching: 0 }));
    return state;
  }

  function assertLocale(locale: string): void {
    if (!locales.has(locale))
      throw new Error(`Unknown catalog locale "${locale}".`);
  }

  function once(id: string, task: () => Promise<void>): Promise<void> {
    let promise = pending.get(id);
    if (!promise) {
      // A failed load is not cached: the next request retries it.
      promise = task()
        .then(
          () => void failures.delete(id),
          (error: unknown) => {
            failures.set(id, error);
            throw error;
          },
        )
        .finally(() => pending.delete(id));
      pending.set(id, promise);
    }
    return promise;
  }

  /** Start a load nobody awaits; its failure is recorded by once() for the barrier error. */
  function background(load: Promise<void>): void {
    load.catch(() => {});
  }

  function loadSource(group: string): Promise<void> {
    if (sources.has(group)) return Promise.resolve();
    return once(`source\0${group}`, async () => {
      // Generated modules `satisfies` CatalogSourceTexts; the Vite plugin verifies their digests.
      const module = await (groups.get(group) as RuntimeCatalogGroup).source();
      if ("default" in module) sources.set(group, module.default);
      else
        for (const [name, texts] of Object.entries(module.sources ?? {}))
          if (!sources.has(name)) sources.set(name, texts);
      if (!sources.has(group))
        throw new Error(
          `Catalog module of group "${group}" provides no source copy.`,
        );
    });
  }

  function storeTranslations(
    locale: string,
    group: string,
    messages: CatalogMessages,
  ): void {
    let loaded = translations.get(locale);
    if (!loaded) translations.set(locale, (loaded = new Map()));
    if (loaded.has(group)) return;
    loaded.set(group, messages);
    for (const reference of languages) {
      const language = reference.deref();
      // Only instances already holding this locale; others materialize it when they switch.
      const table = language?.translations;
      // Mutate the reactive table in place: only renders reading these msgids are triggered.
      if (table && Object.hasOwn(table, locale))
        mergeMessages(table[locale] as MessageTable, messages);
    }
  }

  function loadTranslations(locale: string, group: string): Promise<void> {
    if (translations.get(locale)?.has(group)) return Promise.resolve();
    return once(`${locale}\0${group}`, async () => {
      const module = await groups.get(group)!.translations[locale]!();
      if ("default" in module) storeTranslations(locale, group, module.default);
      // A bundle (unsplit groups/locales) loads every group/locale it contains at once.
      else
        for (const [target, bundled] of Object.entries(
          module.translations ?? {},
        ))
          for (const [name, messages] of Object.entries(bundled))
            storeTranslations(target, name, messages);
      if (!translations.get(locale)?.has(group))
        throw new Error(
          `Catalog module of group "${group}" provides no translations for locale "${locale}".`,
        );
    });
  }

  async function loadTexts(names?: readonly Group[]): Promise<void> {
    const list: string[] =
      names === undefined ? [...groups.keys()] : [...names];
    for (const group of list)
      if (!groups.has(group))
        throw new Error(`Unknown catalog group "${group}".`);
    // Register synchronously: a concurrent loadLocale() then covers these groups too.
    for (const group of list) required.add(group);
    await Promise.all(
      list.flatMap((group) => [
        ...(withSources ? [loadSource(group)] : []),
        ...[...active].map((locale) => loadTranslations(locale, group)),
      ]),
    );
  }

  async function loadLocale(locale: Locale): Promise<void> {
    assertLocale(locale);
    if (locale === sourceLocale) return;
    active.add(locale);
    await Promise.all(
      [...required].map((group) => loadTranslations(locale, group)),
    );
  }

  /** Give an instance its own copy of a locale's loaded groups; later loads merge into it. */
  function materialize(language: Language, locale: string): void {
    if (
      locale === sourceLocale ||
      !locales.has(locale) ||
      Object.hasOwn(language.translations, locale)
    )
      return;
    const table: MessageTable = {};
    for (const messages of translations.get(locale)?.values() ?? [])
      mergeMessages(table, messages);
    language.translations[locale] = table;
  }

  /**
   * Strict barrier: a missing group would otherwise silently render source-language copy.
   * Only configured target locales have lazily loaded data; contexts outside the catalog's groups
   * and locales an application assigned to `gettext` itself (with its own translations) pass
   * through. A failed or never-requested group is (re)loaded in the background before throwing.
   */
  function assertLoaded(language: Language, context: string): void {
    const locale = language.current;
    // Compiled source-locale calls need no data: keep the hot path allocation-free.
    if (locale === sourceLocale && !withSources) return;
    const group = catalogGroup(context);
    if (!groups.has(group)) return;
    stateOf(language).used.add(group);
    if (locale === sourceLocale || !locales.has(locale)) return;
    if (translations.get(locale)?.has(group)) {
      // `gettext.current` assigned directly instead of through setLocale().
      materialize(language, locale);
      return;
    }
    background(loadTranslations(locale, group));
    throw new Error(
      `Catalog group "${group}" is not loaded for locale "${locale}". Await loadTexts(), loadLocale() or setLocale() before rendering it.`,
      { cause: failures.get(`${locale}\0${group}`) },
    );
  }

  /** Source copy of a key; generated source modules store keys relative to their group. */
  function sourceText(key: string): string {
    const group = catalogGroup(key);
    if (!groups.has(group)) throw new Error(`Unknown catalog key "${key}".`);
    const texts = sources.get(group);
    if (!texts) {
      background(loadSource(group));
      throw new Error(
        `Catalog group "${group}" source copy is not loaded. Await loadTexts(["${group}"]) before using its keys.`,
        { cause: failures.get(`source\0${group}`) },
      );
    }
    const relative =
      key.length === group.length ? "" : key.slice(group.length + 1);
    if (!Object.hasOwn(texts, relative))
      throw new Error(`Unknown catalog key "${key}".`);
    return texts[relative]!;
  }

  /** `tracked: false` only for a facade's private, fixed source-locale fallback: it needs no translations. */
  function createLanguage(
    locale: Locale = sourceLocale as Locale,
    tracked = true,
  ): Language {
    assertLocale(locale);
    const initial: Translations = { [sourceLocale]: {} };
    const language = createGettext({
      availableLanguages: { ...availableLanguages },
      defaultLanguage: locale,
      sourceCodeLanguage: sourceLocale,
      // Source copy is the msgid itself; untranslated lookups there are expected, not warnings.
      mutedLanguages: [sourceLocale],
      translations: initial,
    });
    if (tracked) {
      if (locale !== sourceLocale) active.add(locale);
      materialize(language, locale);
      const reference = new WeakRef(language);
      languages.add(reference);
      finalizer.register(language, reference);
    }
    return language;
  }

  function inUse(locale: string): boolean {
    for (const reference of languages)
      if (reference.deref()?.current === locale) return true;
    return false;
  }

  async function setLocale(language: Language, locale: Locale): Promise<void> {
    const state = stateOf(language);
    const call = ++state.switching;
    await loadLocale(locale);
    // A later setLocale() was issued while this one loaded: it decides the locale.
    if (state.switching !== call) return;
    materialize(language, locale);
    const previous = language.current;
    language.current = locale;
    // Stop loading lazily imported groups for a locale nobody displays any more.
    if (previous !== locale && !inUse(previous)) active.delete(previous);
  }

  function usedGroups(language: Language): readonly string[] {
    return [...stateOf(language).used];
  }

  // Never rejects (see loadCatalogGroups); group names come from validated generated modules.
  // Returned below so the facade keeps it alive; the shared map only holds it weakly.
  const loadGroups: GroupLoader = (names) =>
    loadTexts(names as Group[]).catch(() => {});
  const facade = facadesOf(options.catalogGroups);
  facade.loaders.add(new WeakRef(loadGroups));
  if (facade.queued.size) {
    // Requested before this facade existed (an import cycle through it).
    background(loadTexts([...facade.queued] as Group[]));
    facade.queued.clear();
  }

  return {
    loadTexts,
    loadLocale,
    assertLoaded,
    sourceText,
    createLanguage,
    setLocale,
    usedGroups,
    loadGroups,
  };
}
