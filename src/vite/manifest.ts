import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { CatalogIdentity, TextCatalogSnapshot } from "./types.js";

export interface CatalogManifest extends TextCatalogSnapshot, CatalogIdentity {
  readonly formatVersion: 1;
  readonly artifacts: {
    readonly runtime: { readonly path: "catalog.ts"; readonly sha256: string };
    readonly compiled: {
      readonly path: "catalog.compiled.ts";
      readonly sha256: string;
    };
  };
  readonly generation: string;
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

/** Read one complete generation; no legacy manifest or stale-artifact fallback is accepted. */
export function readCatalogManifest(
  directory: string,
  identity: CatalogIdentity,
): { manifest: CatalogManifest; runtime: string; compiled: string } {
  const manifestFile = path.join(directory, "catalog.build.json");
  const raw = object(
    JSON.parse(readFileSync(manifestFile, "utf8")),
    "manifest",
  );
  if (raw.formatVersion !== 1)
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
  const contents = { runtime: "", compiled: "" };
  const realDirectory = realpathSync(directory);
  const paths = new Set<string>();
  for (const mode of ["runtime", "compiled"] as const) {
    const artifact = object(artifacts[mode], `${mode} artifact`);
    const expected = mode === "runtime" ? "catalog.ts" : "catalog.compiled.ts";
    if (
      typeof artifact.path !== "string" ||
      artifact.path !== expected ||
      paths.has(artifact.path)
    )
      throw new Error(`Unsafe or duplicate catalog artifact path for ${mode}.`);
    paths.add(artifact.path);
    if (
      typeof artifact.sha256 !== "string" ||
      !digestPattern.test(artifact.sha256)
    )
      throw new Error(`Invalid ${mode} artifact digest.`);
    const file = realpathSync(path.join(directory, artifact.path));
    if (path.dirname(file) !== realDirectory || paths.has(file))
      throw new Error(
        `Unsafe or duplicate resolved catalog artifact path for ${mode}.`,
      );
    paths.add(file);
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
      throw new Error(`Catalog ${mode} artifact digest mismatch.`);
    contents[mode] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  return { manifest: raw as unknown as CatalogManifest, ...contents };
}
