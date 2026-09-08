import { hasInjectionContext, inject, type App, type InjectionKey } from "vue";
import { languageFactory } from "../language.js";
import type {
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  CompiledCatalog,
  InterpolationParameters,
} from "../types.js";

export type {
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  CompiledCatalog,
} from "../types.js";

/** Lookup-free companion facade for the compiled Vite mode. */
export function createCompiledCatalog(options: CatalogLanguageOptions) {
  const createLanguage = languageFactory(options);
  const sanitizeHtml = options.sanitizeHtml;
  const key: InjectionKey<CompiledCatalog> = Symbol("TextCatalog");

  function createCatalog(
    instance: CatalogInstanceOptions = {},
  ): CompiledCatalog {
    const gettext = createLanguage(instance.locale);
    const sanitize = instance.sanitizeHtml ?? sanitizeHtml;
    function htmlPgettext(
      context: string,
      source: string,
      parameters?: InterpolationParameters,
    ): string {
      if (!sanitize)
        throw new Error(
          "Catalog HTML requires an injected sanitizeHtml function.",
        );
      return sanitize(gettext.$pgettext(context, source, parameters));
    }
    return { gettext, htmlPgettext };
  }

  // Private and never installed: every facade has its own fixed source-language fallback.
  const source = createCatalog();
  function current(): CompiledCatalog {
    return hasInjectionContext() ? inject(key, source) : source;
  }
  function installCatalog(app: App, catalog: CompiledCatalog): void {
    app.provide(key, catalog);
    app.config.globalProperties.$htmlPgettext = catalog.htmlPgettext;
    app.use(catalog.gettext);
  }
  function pgettext(
    context: string,
    source: string,
    parameters?: InterpolationParameters,
  ): string {
    return current().gettext.$pgettext(context, source, parameters);
  }
  function npgettext(
    context: string,
    singular: string,
    plural: string,
    count: number,
    parameters?: InterpolationParameters,
  ): string {
    return current().gettext.$npgettext(
      context,
      singular,
      plural,
      count,
      parameters,
    );
  }
  function htmlPgettext(
    context: string,
    source: string,
    parameters?: InterpolationParameters,
  ): string {
    return current().htmlPgettext(context, source, parameters);
  }
  return { pgettext, npgettext, htmlPgettext, createCatalog, installCatalog };
}
