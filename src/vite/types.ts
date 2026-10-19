/** Validated build-only source data; never imported by the client runtime. */
export interface TextCatalogSnapshot {
  readonly texts: Readonly<Record<string, string>>;
  readonly htmlKeys: Readonly<Record<string, true>>;
  readonly plurals: Readonly<
    Record<string, { readonly one: string; readonly plural: string }>
  >;
}

export interface CatalogIdentity {
  readonly sourceLocale: string;
  readonly locales: readonly string[];
  readonly domain: string;
}

export type CatalogModule = "copy" | "catalog";

export interface TextCatalogTransformOptions {
  readonly root: string;
  /** Resolved consumer authoring facade used for emitted runtime-adapter imports. */
  readonly facade: string;
  /**
   * Import each translated group's loader module. Off when the catalog has no non-source locale:
   * compiled calls then need no lazily loaded data at all.
   */
  readonly groupImports: boolean;
  /** Resolve module identities through Vite, not through guessed aliases or filenames. */
  readonly resolveModule: (
    specifier: string,
    importer: string,
  ) => CatalogModule | undefined | Promise<CatalogModule | undefined>;
}
