import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCatalogManifest } from "../src/vite/manifest.js";
import { identity, publishCatalog } from "./fixtures.js";

// Lets a test serve one stale manifest read, as if another process republished meanwhile.
const staleReads = new Map<string, string>();
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: ((file: string, ...rest: unknown[]) => {
      const stale = staleReads.get(String(file));
      if (stale === undefined)
        return (fs.readFileSync as (...args: unknown[]) => unknown)(
          file,
          ...rest,
        );
      staleReads.delete(String(file));
      return stale;
    }) as typeof fs.readFileSync,
  };
});

const cleanup: string[] = [];
const snapshot = {
  texts: {
    "copy.title": 'Quotes " / Unicode Ř 𐍈\u2028\u2029',
    "items.one": "%{n} item",
    "items.plural": "%{n} items",
    html: "<strong>Safe</strong>",
  },
  htmlKeys: { html: true as const },
  plurals: { items: { one: "items.one", plural: "items.plural" } },
};
// One target locale, so every group also carries a translation artifact.
const bilingual = { ...identity, locales: ["en_US", "cs_CZ"] };
const czech = 'export default {"Safe":{"html":"Bezpečné"}};\n';
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "text-catalog-manifest-"),
  );
  cleanup.push(directory);
  const runtime = 'export const text = () => "Hello";\n';
  const compiled = "export const catalogGroups = {};\n";
  const manifest = await publishCatalog(
    directory,
    snapshot,
    runtime,
    compiled,
    {
      identity: bilingual,
      files: { "texts/html.cs_CZ.ts": czech },
    },
  );
  return { directory, manifest, runtime, compiled };
}
afterEach(async () => {
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("catalog format v2", () => {
  it("accepts a coherent generation with Unicode, line terminators, empty objects and exact artifact bytes", async () => {
    const state = await fixture();
    const read = readCatalogManifest(state.directory, bilingual);
    expect(read.manifest.texts["copy.title"]).toBe(
      snapshot.texts["copy.title"],
    );
    expect(read.runtime).toBe(state.runtime);
    expect(read.compiled).toBe(state.compiled);
    expect(Object.keys(read.groups).sort()).toEqual([
      "texts/copy.cs_CZ.ts",
      "texts/copy.ts",
      "texts/html.cs_CZ.ts",
      "texts/html.ts",
      "texts/items.cs_CZ.ts",
      "texts/items.ts",
    ]);
    expect(read.groups["texts/html.cs_CZ.ts"]).toBe(czech);
    await publishCatalog(
      state.directory,
      { texts: {}, htmlKeys: {}, plurals: {} },
      state.runtime,
      state.compiled,
    );
    const empty = readCatalogManifest(state.directory, identity);
    expect(empty.manifest.texts).toEqual({});
    expect(empty.groups).toEqual({});
  });

  it.each([
    [
      "missing version",
      (manifest: Record<string, any>) => {
        delete manifest.formatVersion;
      },
      /formatVersion/,
    ],
    [
      "previous monolithic version",
      (manifest: Record<string, any>) => {
        manifest.formatVersion = 1;
      },
      /formatVersion/,
    ],
    [
      "group artifact corruption",
      (manifest: Record<string, any>) => {
        manifest.artifacts.groups.items.translations.cs_CZ.sha256 = "0".repeat(
          64,
        );
      },
      /group items cs_CZ artifact digest/,
    ],
    [
      "missing group",
      (manifest: Record<string, any>) => {
        delete manifest.artifacts.groups.copy;
      },
      /group artifacts do not match/,
    ],
    [
      "foreign group",
      (manifest: Record<string, any>) => {
        manifest.artifacts.groups.extra = manifest.artifacts.groups.copy;
      },
      /group artifacts do not match/,
    ],
    [
      "source-locale translations",
      (manifest: Record<string, any>) => {
        manifest.artifacts.groups.copy.translations.en_US =
          manifest.artifacts.groups.copy.translations.cs_CZ;
      },
      /non-source locales/,
    ],
    [
      "unsafe group path",
      (manifest: Record<string, any>) => {
        manifest.artifacts.groups.copy.source.path = "../texts/copy.ts";
      },
      /Unsafe/,
    ],
    [
      "group path of another role",
      (manifest: Record<string, any>) => {
        manifest.artifacts.groups.copy.source.path = "texts/items.ts";
      },
      /Unsafe/,
    ],
    [
      "future version",
      (manifest: Record<string, any>) => {
        manifest.formatVersion = 3;
      },
      /formatVersion/,
    ],
    [
      "generation corruption",
      (manifest: Record<string, any>) => {
        manifest.generation = "0".repeat(64);
      },
      /generation digest/,
    ],
    [
      "artifact corruption",
      (manifest: Record<string, any>) => {
        manifest.artifacts.runtime.sha256 = "0".repeat(64);
      },
      /artifact digest/,
    ],
    [
      "unsafe artifact",
      (manifest: Record<string, any>) => {
        manifest.artifacts.runtime.path = "../catalog.ts";
      },
      /Unsafe/,
    ],
    [
      "duplicate artifact",
      (manifest: Record<string, any>) => {
        manifest.artifacts.compiled.path = "catalog.ts";
      },
      /duplicate/,
    ],
    [
      "missing HTML text",
      (manifest: Record<string, any>) => {
        manifest.htmlKeys.missing = true;
      },
      /existing text/,
    ],
    [
      "missing plural text",
      (manifest: Record<string, any>) => {
        delete manifest.texts["items.plural"];
      },
      /existing sibling/,
    ],
    [
      "unpaired plural",
      (manifest: Record<string, any>) => {
        manifest.plurals.items.plural = "copy.title";
      },
      /sibling/,
    ],
    [
      "different domain",
      (manifest: Record<string, any>) => {
        manifest.domain = "other";
      },
      /identity/,
    ],
    [
      "different locales",
      (manifest: Record<string, any>) => {
        manifest.locales.push("de_DE");
      },
      /identity/,
    ],
    [
      "array instead of map",
      (manifest: Record<string, any>) => {
        manifest.htmlKeys = [];
      },
      /object/,
    ],
  ] as const)(
    "rejects %s instead of exposing stale or mismatched artifacts",
    async (_name, mutate, error) => {
      const state = await fixture();
      mutate(state.manifest);
      await writeFile(
        path.join(state.directory, "catalog.build.json"),
        JSON.stringify(state.manifest),
      );
      expect(() => readCatalogManifest(state.directory, bilingual)).toThrow(
        error,
      );
    },
  );

  it("retries once with the newer generation when artifacts were replaced while reading", async () => {
    const state = await fixture();
    const manifestFile = path.join(state.directory, "catalog.build.json");
    const older = await readFile(manifestFile, "utf8");
    const runtime = 'export const text = () => "Replaced";\n';
    await publishCatalog(state.directory, snapshot, runtime, state.compiled, {
      identity: bilingual,
      files: { "texts/html.cs_CZ.ts": czech },
    });
    // The first read sees the previous manifest, whose digests no longer match the files.
    staleReads.set(manifestFile, older);
    expect(readCatalogManifest(state.directory, bilingual).runtime).toBe(
      runtime,
    );
    // An unchanged manifest gets no second attempt.
    await writeFile(path.join(state.directory, "catalog.ts"), "tampered");
    expect(() => readCatalogManifest(state.directory, bilingual)).toThrow(
      /runtime artifact digest mismatch/,
    );
  });

  it("rejects modified artifacts even while an older valid manifest remains present", async () => {
    const state = await fixture();
    await writeFile(
      path.join(state.directory, "catalog.compiled.ts"),
      state.compiled + "\n",
    );
    expect(() => readCatalogManifest(state.directory, bilingual)).toThrow(
      /compiled artifact digest mismatch/,
    );
    const fresh = await fixture();
    await writeFile(
      path.join(fresh.directory, "texts/html.cs_CZ.ts"),
      'export default {"Safe":{"html":"<img onerror>"}};\n',
    );
    expect(() => readCatalogManifest(fresh.directory, bilingual)).toThrow(
      /group html cs_CZ artifact digest mismatch/,
    );
  });

  it("rejects symlink escapes even when the referenced bytes and digest match", async () => {
    const state = await fixture();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "text-catalog-outside-"),
    );
    cleanup.push(outside);
    const target = path.join(outside, "catalog.ts");
    await writeFile(
      target,
      await readFile(path.join(state.directory, "catalog.ts")),
    );
    await rm(path.join(state.directory, "catalog.ts"));
    await symlink(target, path.join(state.directory, "catalog.ts"));
    expect(() => readCatalogManifest(state.directory, bilingual)).toThrow(
      /Unsafe/,
    );
  });
});
