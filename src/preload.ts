/**
 * `.vite/text-catalog.json`, emitted by the Vite plugin into the client build output: the build
 * files (relative to the client `outDir`, static imports included) delivering each group's modules.
 */
export interface CatalogPreloadManifest {
  readonly groups: Readonly<
    Record<
      string,
      {
        /** Runtime-mode source copy. */
        readonly source?: readonly string[];
        /** Translations by non-source locale. */
        readonly translations: Readonly<Record<string, readonly string[]>>;
      }
    >
  >;
}

/**
 * Build files to `<link rel="modulepreload">` for groups an SSR render used (an instance's
 * `usedGroups()`) in its locale, so the browser fetches them in parallel with the page instead of
 * after the page module runs. Prefix them with the application's build `base`.
 */
export function catalogPreloadFiles(
  manifest: CatalogPreloadManifest,
  groups: Iterable<string>,
  locale: string,
): string[] {
  const files = new Set<string>();
  for (const group of groups) {
    if (!Object.hasOwn(manifest.groups, group)) continue;
    const entry = manifest.groups[group]!;
    for (const file of entry.source ?? []) files.add(file);
    if (Object.hasOwn(entry.translations, locale))
      for (const file of entry.translations[locale]!) files.add(file);
  }
  return [...files];
}
