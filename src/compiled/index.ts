import { hasInjectionContext, inject, type App, type InjectionKey } from "vue";
import { createTextRegistry } from "../registry.js";

/** @internal Entry point of the Vite plugin's generated group modules. */
export { loadCatalogGroups } from "../registry.js";
import type {
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  CatalogLoading,
  CompiledCatalog,
  CompiledCatalogGroups,
  InterpolationParameters,
  Language,
} from "../types.js";

export type {
  CatalogInstanceOptions,
  CatalogLanguageOptions,
  CatalogLoading,
  CompiledCatalog,
} from "../types.js";

export interface CompiledCatalogOptions<
  Group extends string,
  Locale extends string,
> extends CatalogLanguageOptions<Locale> {
  readonly catalogGroups: CompiledCatalogGroups<Group>;
}

/** Lookup-free companion facade for the compiled Vite mode. */
export function createCompiledCatalog<
  Group extends string,
  Locale extends string,
>(options: CompiledCatalogOptions<Group, Locale>) {
  const registry = createTextRegistry(options, false);
  const { loadTexts, loadLocale }: CatalogLoading<Group, Locale> = registry;
  const sanitizeHtml = options.sanitizeHtml;
  const key: InjectionKey<CompiledCatalog<Locale>> = Symbol("TextCatalog");

  function createCatalog(
    instance: CatalogInstanceOptions<Locale> = {},
    tracked = true,
  ): CompiledCatalog<Locale> {
    const gettext = registry.createLanguage(instance.locale, tracked);
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
      registry.assertLoaded(gettext, context);
      return sanitize(gettext.$pgettext(context, source, parameters));
    }
    return {
      gettext,
      htmlPgettext,
      setLocale: (locale) => registry.setLocale(gettext, locale),
      usedGroups: () => registry.usedGroups(gettext),
    };
  }

  // Private and never installed: every facade has its own fixed source-language fallback.
  const source = createCatalog({}, false);
  function current(): CompiledCatalog<Locale> {
    return hasInjectionContext() ? inject(key, source) : source;
  }
  function installCatalog(app: App, catalog: CompiledCatalog<Locale>): void {
    const gettext = catalog.gettext;
    app.provide(key, catalog);
    app.use(gettext);
    // Template globals emitted by the compiled transform get the same loaded-group barrier.
    const pgettextGlobal: Language["$pgettext"] = (
      context,
      msgid,
      parameters,
    ) => {
      registry.assertLoaded(gettext, context);
      return gettext.$pgettext(context, msgid, parameters);
    };
    const npgettextGlobal: Language["$npgettext"] = (
      context,
      msgid,
      plural,
      count,
      parameters,
    ) => {
      registry.assertLoaded(gettext, context);
      return gettext.$npgettext(context, msgid, plural, count, parameters);
    };
    const globals = app.config.globalProperties;
    globals.$pgettext = pgettextGlobal;
    globals.$npgettext = npgettextGlobal;
    globals.$htmlPgettext = catalog.htmlPgettext;
  }
  function pgettext(
    context: string,
    source: string,
    parameters?: InterpolationParameters,
  ): string {
    const { gettext } = current();
    registry.assertLoaded(gettext, context);
    return gettext.$pgettext(context, source, parameters);
  }
  function npgettext(
    context: string,
    singular: string,
    plural: string,
    count: number,
    parameters?: InterpolationParameters,
  ): string {
    const { gettext } = current();
    registry.assertLoaded(gettext, context);
    return gettext.$npgettext(context, singular, plural, count, parameters);
  }
  function htmlPgettext(
    context: string,
    source: string,
    parameters?: InterpolationParameters,
  ): string {
    return current().htmlPgettext(context, source, parameters);
  }
  return {
    pgettext,
    npgettext,
    htmlPgettext,
    createCatalog: (instance?: CatalogInstanceOptions<Locale>) =>
      createCatalog(instance),
    installCatalog,
    loadTexts,
    loadLocale,
  };
}
