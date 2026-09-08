import type { Language, Translations } from "vue3-gettext";

export type { Language, Translations } from "vue3-gettext";

export type InterpolationParameters = Record<string, string | number>;
export type HtmlSanitizer = (html: string) => string;

export interface CatalogLanguageOptions {
  readonly catalogTranslations: Translations;
  readonly sourceLocale: string;
  readonly locales: readonly string[];
  /** Optional display names; locale identifiers are used by default. */
  readonly languageNames?: Readonly<Record<string, string>>;
  /** Required whenever HTML is rendered, including outside an installed app. */
  readonly sanitizeHtml?: HtmlSanitizer;
}

export interface CatalogInstanceOptions {
  readonly locale?: string;
  /** Override the facade's sanitizer for this app/request only. */
  readonly sanitizeHtml?: HtmlSanitizer;
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

export interface RuntimeCatalog<
  Key extends string,
> extends CatalogHelpers<Key> {
  gettext: Language;
}

export interface CompiledCatalog {
  gettext: Language;
  htmlPgettext(
    context: string,
    source: string,
    parameters?: InterpolationParameters,
  ): string;
}
