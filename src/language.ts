import { createGettext } from "vue3-gettext";
import type {
  CatalogLanguageOptions,
  Language,
  Translations,
} from "./types.js";

/** Gettext normalizes only its outer catalog; clone every mutable nested plural array. */
function cloneTranslations(source: Translations): Translations {
  const translations: Translations = {};
  for (const [locale, sourceMessages] of Object.entries(source)) {
    const messages = { ...sourceMessages };
    for (const [key, message] of Object.entries(messages)) {
      if (typeof message === "string") continue;
      if (Array.isArray(message)) {
        messages[key] = message.slice();
        continue;
      }
      const contexts = { ...message };
      for (const [context, translation] of Object.entries(contexts)) {
        if (Array.isArray(translation)) contexts[context] = translation.slice();
      }
      messages[key] = contexts;
    }
    translations[locale] = messages;
  }
  return translations;
}

/** Capture facade identity once; never borrow an application's mutable locale. */
export function languageFactory(
  options: CatalogLanguageOptions,
): (locale?: string) => Language {
  const sourceLocale = options.sourceLocale;
  const locales = [...options.locales];
  if (
    !sourceLocale ||
    !locales.includes(sourceLocale) ||
    new Set(locales).size !== locales.length
  ) {
    throw new Error(
      "Catalog locales must be unique and include the source locale.",
    );
  }
  const availableLanguages = Object.fromEntries(
    locales.map((locale) => [
      locale,
      options.languageNames?.[locale] ?? locale,
    ]),
  );
  const translations = options.catalogTranslations;
  return (locale = sourceLocale) => {
    if (!locales.includes(locale))
      throw new Error(`Unknown catalog locale "${locale}".`);
    return createGettext({
      availableLanguages: { ...availableLanguages },
      defaultLanguage: locale,
      sourceCodeLanguage: sourceLocale,
      translations: cloneTranslations(translations),
    });
  };
}
