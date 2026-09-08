import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

export async function publishCatalog(
  directory: string,
  snapshot: TextCatalogSnapshot,
  runtime: string,
  compiled: string,
) {
  await mkdir(directory, { recursive: true });
  const payload = {
    formatVersion: 1,
    ...structuredClone(identity),
    artifacts: {
      runtime: {
        path: "catalog.ts",
        sha256: createHash("sha256").update(runtime).digest("hex"),
      },
      compiled: {
        path: "catalog.compiled.ts",
        sha256: createHash("sha256").update(compiled).digest("hex"),
      },
    },
    ...structuredClone(snapshot),
  };
  const manifest = {
    ...payload,
    generation: createHash("sha256").update(canonical(payload)).digest("hex"),
  };
  await writeFile(path.join(directory, "catalog.ts"), runtime);
  await writeFile(path.join(directory, "catalog.compiled.ts"), compiled);
  await writeFile(
    path.join(directory, "catalog.build.json"),
    JSON.stringify(manifest),
  );
  return manifest;
}
