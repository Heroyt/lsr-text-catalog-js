import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogGroup } from "../src/group.js";
import type {
  CatalogIdentity,
  TextCatalogSnapshot,
} from "../src/vite/types.js";

export const identity: CatalogIdentity = {
  domain: "messages",
  sourceLocale: "en_US",
  locales: ["en_US"],
};

// Independent fixture encoder; production readers must validate even freshly published artifacts.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const sha256 = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Publish one format-2 generation. Group modules default to the group's source copy and empty
 * translations; `files` overrides any `texts/…` module by its relative path.
 */
export async function publishCatalog(
  directory: string,
  snapshot: TextCatalogSnapshot,
  runtime: string,
  compiled: string,
  options: {
    identity?: CatalogIdentity;
    files?: Readonly<Record<string, string>>;
  } = {},
) {
  const configured = options.identity ?? identity;
  await mkdir(path.join(directory, "texts"), { recursive: true });
  const groups: Record<
    string,
    {
      source: { path: string; sha256: string };
      translations: Record<string, { path: string; sha256: string }>;
    }
  > = {};
  const names = [...new Set(Object.keys(snapshot.texts).map(catalogGroup))];
  for (const group of names.sort()) {
    const sourcePath = `texts/${group}.ts`;
    const sourceCopy =
      options.files?.[sourcePath] ??
      `export default ${JSON.stringify(
        // Group-relative keys, as the PHP compiler emits them.
        Object.fromEntries(
          Object.entries(snapshot.texts)
            .filter(([key]) => catalogGroup(key) === group)
            .map(([key, text]) => [key.slice(group.length + 1), text]),
        ),
      )};\n`;
    await writeFile(path.join(directory, sourcePath), sourceCopy);
    groups[group] = {
      source: { path: sourcePath, sha256: sha256(sourceCopy) },
      translations: {},
    };
    for (const locale of configured.locales) {
      if (locale === configured.sourceLocale) continue;
      const file = `texts/${group}.${locale}.ts`;
      const messages = options.files?.[file] ?? "export default {};\n";
      await writeFile(path.join(directory, file), messages);
      groups[group].translations[locale] = {
        path: file,
        sha256: sha256(messages),
      };
    }
  }
  const payload = {
    formatVersion: 2,
    ...structuredClone(configured),
    artifacts: {
      runtime: { path: "catalog.ts", sha256: sha256(runtime) },
      compiled: { path: "catalog.compiled.ts", sha256: sha256(compiled) },
      groups,
    },
    ...structuredClone(snapshot),
  };
  const manifest = { ...payload, generation: sha256(canonical(payload)) };
  await writeFile(path.join(directory, "catalog.ts"), runtime);
  await writeFile(path.join(directory, "catalog.compiled.ts"), compiled);
  await writeFile(
    path.join(directory, "catalog.build.json"),
    JSON.stringify(manifest),
  );
  return manifest;
}
