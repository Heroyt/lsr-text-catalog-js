import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { catalogGroup } from "../group.js";
import type { CatalogIdentity, TextCatalogSnapshot } from "./types.js";

interface Artifact<Path extends string = string> {
  readonly path: Path;
  readonly sha256: string;
}

export interface CatalogManifest extends TextCatalogSnapshot, CatalogIdentity {
  readonly formatVersion: 2;
  readonly artifacts: {
    readonly runtime: Artifact<"catalog.ts">;
    readonly compiled: Artifact<"catalog.compiled.ts">;
    /** Lazy modules per root-key group; translations exist only for non-source locales. */
    readonly groups: Readonly<
      Record<
        string,
        {
          readonly source: Artifact;
          readonly translations: Readonly<Record<string, Artifact>>;
        }
      >
    >;
  };
  readonly generation: string;
}

export interface CatalogArtifacts {
  readonly manifest: CatalogManifest;
  readonly runtime: string;
  readonly compiled: string;
  /** Verified group module contents keyed by their frontend-directory-relative path. */
  readonly groups: Readonly<Record<string, string>>;
}

/** Byte-ordered compact UTF-8 JSON, matching PHP's unescaped Unicode/slash encoding. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Catalog manifest contains a non-JSON value.");
  return encoded;
}

const keyPattern = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Catalog ${label} must be an object.`);
  return value as Record<string, unknown>;
}

function ascii(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/u.test(value))
    throw new Error(`Catalog ${label} must be a nonempty ASCII string.`);
}

/**
 * Read one complete generation; no legacy manifest or stale-artifact fallback is accepted. A
 * compiler in another process may replace artifacts while they are read: when the manifest
 * changed meanwhile, the newer generation gets exactly one more attempt.
 */
export function readCatalogManifest(
  directory: string,
  identity: CatalogIdentity,
): CatalogArtifacts {
  const manifestFile = path.join(directory, "catalog.build.json");
  const before = readFileSync(manifestFile, "utf8");
  try {
    return readGeneration(directory, identity, before);
  } catch (error) {
    let after: string;
    try {
      after = readFileSync(manifestFile, "utf8");
    } catch {
      throw error;
    }
    if (after === before) throw error;
    return readGeneration(directory, identity, after);
  }
}

function readGeneration(
  directory: string,
  identity: CatalogIdentity,
  manifestText: string,
): CatalogArtifacts {
  const manifestFile = path.join(directory, "catalog.build.json");
  const raw = object(JSON.parse(manifestText), "manifest");
  if (raw.formatVersion !== 2)
    throw new Error(
      `Unsupported catalog formatVersion: ${String(raw.formatVersion)}.`,
    );
  ascii(raw.sourceLocale, "sourceLocale");
  ascii(raw.domain, "domain");
  if (!Array.isArray(raw.locales) || raw.locales.length === 0)
    throw new Error("Catalog locales must be a nonempty array.");
  for (const locale of raw.locales) ascii(locale, "locale");
  if (
    new Set(raw.locales).size !== raw.locales.length ||
    !raw.locales.includes(raw.sourceLocale)
  ) {
    throw new Error("Catalog locales must be unique and contain sourceLocale.");
  }
  if (
    raw.sourceLocale !== identity.sourceLocale ||
    raw.domain !== identity.domain ||
    JSON.stringify(raw.locales) !== JSON.stringify(identity.locales)
  ) {
    throw new Error(
      "Catalog manifest identity does not match the configured domain/locales/sourceLocale.",
    );
  }
  const texts = object(raw.texts, "texts");
  const htmlKeys = object(raw.htmlKeys, "htmlKeys");
  const plurals = object(raw.plurals, "plurals");
  for (const [key, value] of Object.entries(texts)) {
    if (!keyPattern.test(key) || typeof value !== "string")
      throw new Error(`Invalid catalog text ${JSON.stringify(key)}.`);
  }
  for (const [key, value] of Object.entries(htmlKeys)) {
    if (value !== true || !Object.hasOwn(texts, key))
      throw new Error(
        `Catalog HTML key ${JSON.stringify(key)} must reference an existing text.`,
      );
  }
  for (const [key, value] of Object.entries(plurals)) {
    const pair = object(value, `plural ${JSON.stringify(key)}`);
    if (
      !keyPattern.test(key) ||
      pair.one !== `${key}.one` ||
      pair.plural !== `${key}.plural` ||
      !Object.hasOwn(texts, pair.one) ||
      !Object.hasOwn(texts, pair.plural)
    ) {
      throw new Error(
        `Catalog plural ${JSON.stringify(key)} must reference existing sibling one/plural text keys.`,
      );
    }
  }
  const artifacts = object(raw.artifacts, "artifacts");
  const realDirectory = realpathSync(directory);
  const paths = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Every artifact path is fully determined by its role; the manifest only carries the digest.
  function read(value: unknown, expected: string, label: string): string {
    const artifact = object(value, `${label} artifact`);
    if (artifact.path !== expected || paths.has(expected))
      throw new Error(
        `Unsafe or duplicate catalog artifact path for ${label}.`,
      );
    paths.add(expected);
    if (
      typeof artifact.sha256 !== "string" ||
      !digestPattern.test(artifact.sha256)
    )
      throw new Error(`Invalid ${label} artifact digest.`);
    const file = realpathSync(path.join(directory, expected));
    if (
      path.dirname(file) !== path.join(realDirectory, path.dirname(expected)) ||
      paths.has(file)
    )
      throw new Error(
        `Unsafe or duplicate resolved catalog artifact path for ${label}.`,
      );
    paths.add(file);
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
      throw new Error(`Catalog ${label} artifact digest mismatch.`);
    return decoder.decode(bytes);
  }
  const runtime = read(artifacts.runtime, "catalog.ts", "runtime");
  const compiled = read(artifacts.compiled, "catalog.compiled.ts", "compiled");
  const groupArtifacts = object(artifacts.groups, "groups artifact");
  const expectedGroups = [
    ...new Set(Object.keys(texts).map(catalogGroup)),
  ].sort();
  const targets = (raw.locales as string[]).filter(
    (locale) => locale !== raw.sourceLocale,
  );
  if (
    JSON.stringify(Object.keys(groupArtifacts).sort()) !==
    JSON.stringify(expectedGroups)
  )
    throw new Error("Catalog group artifacts do not match the catalog keys.");
  const groups: Record<string, string> = {};
  for (const group of expectedGroups) {
    const artifact = object(groupArtifacts[group], `group ${group}`);
    const source = `texts/${group}.ts`;
    groups[source] = read(artifact.source, source, `group ${group} source`);
    const translations = object(
      artifact.translations,
      `group ${group} translations`,
    );
    if (
      JSON.stringify(Object.keys(translations).sort()) !==
      JSON.stringify([...targets].sort())
    )
      throw new Error(
        `Catalog group ${group} translations do not match the non-source locales.`,
      );
    for (const locale of targets) {
      const file = `texts/${group}.${locale}.ts`;
      groups[file] = read(
        translations[locale],
        file,
        `group ${group} ${locale}`,
      );
    }
  }
  const { generation, ...payload } = raw;
  if (
    typeof generation !== "string" ||
    !digestPattern.test(generation) ||
    createHash("sha256").update(canonicalJson(payload)).digest("hex") !==
      generation
  ) {
    throw new Error("Catalog manifest generation digest mismatch.");
  }
  // A concurrently published manifest must not authorize the artifacts read above.
  if (
    canonicalJson(JSON.parse(readFileSync(manifestFile, "utf8"))) !==
    canonicalJson(raw)
  ) {
    throw new Error("Catalog generation changed while reading its artifacts.");
  }
  return {
    manifest: raw as unknown as CatalogManifest,
    runtime,
    compiled,
    groups,
  };
}
