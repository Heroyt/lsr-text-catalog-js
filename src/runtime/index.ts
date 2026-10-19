import { hasInjectionContext, inject, type App, type InjectionKey } from "vue";
import { createTextRegistry } from "../registry.js";

/** @internal Entry point of the Vite plugin's generated group modules. */
export { loadCatalogGroups } from "../registry.js";
import type {
  CatalogHelpers,
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  CatalogLoading,
  InterpolationParameters,
  RuntimeCatalog,
  RuntimeCatalogGroups,
} from "../types.js";

export type {
  CatalogHelpers,
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  CatalogLoading,
  RuntimeCatalog,
} from "../types.js";

export interface RuntimeCatalogOptions<
  Key extends string,
  Group extends string,
  Locale extends string,
> extends CatalogLanguageOptions<Locale> {
  readonly catalogGroups: RuntimeCatalogGroups<Group>;
  readonly htmlTextKeys: readonly Key[];
}

/** One consumer-local authoring facade; each createCatalog call creates independent app/request state. */
export function createRuntimeCatalog<
  Key extends string,
  Group extends string,
  Locale extends string,
>(options: RuntimeCatalogOptions<Key, Group, Locale>) {
  const registry = createTextRegistry(options, true);
  const { loadTexts, loadLocale }: CatalogLoading<Group, Locale> = registry;
  const sanitizeHtml = options.sanitizeHtml;
  const htmlKeys = new Set<string>(options.htmlTextKeys);
  const key: InjectionKey<CatalogHelpers<Key>> = Symbol("TextCatalog");

  /** Source copy of a key whose group was loaded with loadTexts(). */
  function text(key: Key): string {
    return registry.sourceText(key);
  }

  function createCatalog(
    instance: CatalogInstanceOptions<Locale> = {},
    tracked = true,
  ): RuntimeCatalog<Key, Locale> {
    const gettext = registry.createLanguage(instance.locale, tracked);
    const sanitize = instance.sanitizeHtml ?? sanitizeHtml;
    function langText(key: Key, parameters?: InterpolationParameters): string {
      const source = registry.sourceText(key);
      registry.assertLoaded(gettext, key);
      return gettext.$pgettext(key, source, parameters);
    }
    function langTextPlural(
      singularKey: Extract<Key, `${string}.one`>,
      pluralKey: Extract<Key, `${string}.plural`>,
      count: number,
      parameters?: InterpolationParameters,
    ): string {
      const context = singularKey.slice(0, -".one".length);
      if (!singularKey.endsWith(".one") || pluralKey !== `${context}.plural`) {
        throw new Error(
          'Catalog plural keys must be sibling ".one" and ".plural" entries.',
        );
      }
      const singular = registry.sourceText(singularKey);
      const plural = registry.sourceText(pluralKey);
      registry.assertLoaded(gettext, context);
      return gettext.$npgettext(context, singular, plural, count, parameters);
    }
    function langHtmlText(
      key: Key,
      parameters?: InterpolationParameters,
    ): string {
      if (!htmlKeys.has(key))
        throw new Error(`Catalog key "${key}" is not declared as HTML.`);
      if (!sanitize)
        throw new Error(
          "Catalog HTML requires an injected sanitizeHtml function.",
        );
      return sanitize(langText(key, parameters));
    }
    return {
      gettext,
      langText,
      langTextPlural,
      langHtmlText,
      setLocale: (locale) => registry.setLocale(gettext, locale),
      usedGroups: () => registry.usedGroups(gettext),
    };
  }

  // Do not expose or install the source translator: its locale must remain fixed.
  const {
    langText: sourceText,
    langTextPlural: sourcePlural,
    langHtmlText: sourceHtml,
  } = createCatalog({}, false);
  const source = Object.freeze({
    langText: sourceText,
    langTextPlural: sourcePlural,
    langHtmlText: sourceHtml,
  });
  function current(): CatalogHelpers<Key> {
    return hasInjectionContext() ? inject(key, source) : source;
  }
  function installCatalog(
    app: App,
    catalog: RuntimeCatalog<Key, Locale>,
  ): void {
    app.provide(key, catalog);
    app.config.globalProperties.$langText = catalog.langText;
    app.config.globalProperties.$langTextPlural = catalog.langTextPlural;
    app.config.globalProperties.$langHtmlText = catalog.langHtmlText;
    app.use(catalog.gettext);
  }
  const langText: CatalogHelpers<Key>["langText"] = (key, parameters) =>
    current().langText(key, parameters);
  const langTextPlural: CatalogHelpers<Key>["langTextPlural"] = (
    one,
    plural,
    count,
    parameters,
  ) => current().langTextPlural(one, plural, count, parameters);
  const langHtmlText: CatalogHelpers<Key>["langHtmlText"] = (key, parameters) =>
    current().langHtmlText(key, parameters);
  return {
    text,
    langText,
    langTextPlural,
    langHtmlText,
    createCatalog: (instance?: CatalogInstanceOptions<Locale>) =>
      createCatalog(instance),
    installCatalog,
    loadTexts,
    loadLocale,
  };
}

// Consumer facades can augment these with their catalog-specific key types instead.
// The package does not install a global catalog or globally claim one app's key union.
