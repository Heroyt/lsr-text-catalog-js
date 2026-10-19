import type { Language, LanguageData, Translations } from "vue3-gettext";

export type { Language, Translations } from "vue3-gettext";

export type InterpolationParameters = Record<string, string | number>;
export type HtmlSanitizer = (html: string) => string;

/** Source copy of one catalog group: semantic key → source text. */
export type CatalogSourceTexts = Readonly<Record<string, string>>;
/** Translations of one catalog group for one locale: msgid → context → message. */
export type CatalogMessages = LanguageData;

/**
 * Several groups and/or locales delivered by one module. The Vite plugin serves generated loaders
 * from such bundles when its `split` option disables group or locale splitting.
 */
export interface CatalogBundle {
  /** Source copy by group (runtime mode). */
  readonly sources?: Readonly<Record<string, CatalogSourceTexts>>;
  /** Translations by locale, then group. */
  readonly translations?: Readonly<
    Record<string, Readonly<Record<string, CatalogMessages>>>
  >;
}

type ModuleLoader<T> = () => Promise<{ readonly default: T } | CatalogBundle>;

/** Translation loaders keyed by non-source locale. The source locale needs no translation data. */
export type CatalogTranslationLoaders = Readonly<
  Record<string, ModuleLoader<CatalogMessages>>
>;

export interface CompiledCatalogGroup {
  readonly translations: CatalogTranslationLoaders;
}

export interface RuntimeCatalogGroup extends CompiledCatalogGroup {
  readonly source: ModuleLoader<CatalogSourceTexts>;
}

/** Generated lazy group loaders; a group is the root segment of its semantic keys. */
export type RuntimeCatalogGroups<Group extends string> = Readonly<
  Record<Group, RuntimeCatalogGroup>
>;
export type CompiledCatalogGroups<Group extends string> = Readonly<
  Record<Group, CompiledCatalogGroup>
>;

/** `Locale` is inferred from the generated `locales` tuple, so locale typos fail type checking. */
export interface CatalogLanguageOptions<Locale extends string = string> {
  readonly sourceLocale: NoInfer<Locale>;
  readonly locales: readonly Locale[];
  /** Optional display names; locale identifiers are used by default. */
  readonly languageNames?: Readonly<Partial<Record<Locale, string>>>;
  /** Required whenever HTML is rendered, including outside an installed app. */
  readonly sanitizeHtml?: HtmlSanitizer;
}

export interface CatalogInstanceOptions<Locale extends string = string> {
  readonly locale?: Locale;
  /** Override the facade's sanitizer for this app/request only. */
  readonly sanitizeHtml?: HtmlSanitizer;
}

/** Facade-level lazy loading shared by every app/request instance of one facade. */
export interface CatalogLoading<
  Group extends string,
  Locale extends string = string,
> {
  /**
   * Require groups (all when omitted) and load them for every activated locale.
   * Runtime facades also load the groups' source copy.
   */
  loadTexts(groups?: readonly Group[]): Promise<void>;
  /** Activate a locale and load every required group for it. */
  loadLocale(locale: Locale): Promise<void>;
}

export interface CatalogHelpers<Key extends string> {
  langText(key: Key, parameters?: InterpolationParameters): string;
  langTextPlural(
    singularKey: Extract<Key, `${string}.one`>,
    pluralKey: Extract<Key, `${string}.plural`>,
    count: number,
    parameters?: InterpolationParameters,
  ): string;
  langHtmlText(key: Key, parameters?: InterpolationParameters): string;
}

/** Extend Vue's ComponentCustomProperties in the consumer facade to type its template globals. */
export interface CatalogComponentProperties<Key extends string> {
  $langText: CatalogHelpers<Key>["langText"];
  $langTextPlural: CatalogHelpers<Key>["langTextPlural"];
  $langHtmlText: CatalogHelpers<Key>["langHtmlText"];
}

interface CatalogInstance<Locale extends string> {
  gettext: Language;
  /** Load the locale's required groups, then switch this instance to it (latest call wins). */
  setLocale(locale: Locale): Promise<void>;
  /**
   * Catalog groups this instance has rendered, e.g. to emit `<link rel="modulepreload">` for
   * their modules after SSR (see `lsr-text-catalog/preload`).
   */
  usedGroups(): readonly string[];
}

export interface RuntimeCatalog<
  Key extends string,
  Locale extends string = string,
>
  extends CatalogHelpers<Key>, CatalogInstance<Locale> {}

export interface CompiledCatalog<
  Locale extends string = string,
> extends CatalogInstance<Locale> {
  htmlPgettext(
    context: string,
    source: string,
    parameters?: InterpolationParameters,
  ): string;
}
