import { hasInjectionContext, inject, type App, type InjectionKey } from "vue";
import { languageFactory } from "../language.js";
import type {
  CatalogHelpers,
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  InterpolationParameters,
  RuntimeCatalog,
} from "../types.js";

export type {
  CatalogHelpers,
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  RuntimeCatalog,
} from "../types.js";

export interface RuntimeCatalogOptions<
  Key extends string,
> extends CatalogLanguageOptions {
  readonly catalog: Readonly<Record<Key, string>>;
  readonly htmlTextKeys: readonly NoInfer<Key>[];
}

/** One consumer-local authoring facade; each createCatalog call creates independent app/request state. */
export function createRuntimeCatalog<Key extends string>(
  options: RuntimeCatalogOptions<Key>,
) {
  const createLanguage = languageFactory(options);
  const sanitizeHtml = options.sanitizeHtml;
  const catalog = options.catalog;
  const htmlKeys = new Set(options.htmlTextKeys);
  const key: InjectionKey<CatalogHelpers<Key>> = Symbol("TextCatalog");

  function text(key: Key): string {
    if (!Object.hasOwn(catalog, key))
      throw new Error(`Unknown catalog key "${key}".`);
    return catalog[key];
  }

  function createCatalog(
    instance: CatalogInstanceOptions = {},
  ): RuntimeCatalog<Key> {
    const gettext = createLanguage(instance.locale);
    const sanitize = instance.sanitizeHtml ?? sanitizeHtml;
    function langText(key: Key, parameters?: InterpolationParameters): string {
      return gettext.$pgettext(key, text(key), parameters);
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
      return gettext.$npgettext(
        context,
        text(singularKey),
        text(pluralKey),
        count,
        parameters,
      );
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
    return { gettext, langText, langTextPlural, langHtmlText };
  }

  // Do not expose or install the source translator: its locale must remain fixed.
  const {
    langText: sourceText,
    langTextPlural: sourcePlural,
    langHtmlText: sourceHtml,
  } = createCatalog();
  const source = Object.freeze({
    langText: sourceText,
    langTextPlural: sourcePlural,
    langHtmlText: sourceHtml,
  });
  function current(): CatalogHelpers<Key> {
    return hasInjectionContext() ? inject(key, source) : source;
  }
  function installCatalog(app: App, catalog: RuntimeCatalog<Key>): void {
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
    createCatalog,
    installCatalog,
  };
}

// Consumer facades can augment these with their catalog-specific key types instead.
// The package does not install a global catalog or globally claim one app's key union.
