import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCatalogManifest } from "../src/vite/manifest.js";
import { identity, publishCatalog } from "./fixtures.js";

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
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "text-catalog-manifest-"),
  );
  cleanup.push(directory);
  const runtime = 'export const text = () => "Hello";\n';
  const compiled = "export const catalogTranslations = {};\n";
  const manifest = await publishCatalog(directory, snapshot, runtime, compiled);
  return { directory, manifest, runtime, compiled };
}
afterEach(async () => {
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("catalog format v1", () => {
  it("accepts a coherent generation with Unicode, line terminators, empty objects and exact artifact bytes", async () => {
    const state = await fixture();
    const read = readCatalogManifest(state.directory, identity);
    expect(read.manifest.texts["copy.title"]).toBe(
      snapshot.texts["copy.title"],
    );
    expect(read.runtime).toBe(state.runtime);
    expect(read.compiled).toBe(state.compiled);
    await publishCatalog(
      state.directory,
      { texts: {}, htmlKeys: {}, plurals: {} },
      state.runtime,
      state.compiled,
    );
    expect(
      readCatalogManifest(state.directory, identity).manifest.texts,
    ).toEqual({});
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
      "future version",
      (manifest: Record<string, any>) => {
        manifest.formatVersion = 2;
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
      expect(() => readCatalogManifest(state.directory, identity)).toThrow(
        error,
      );
    },
  );

  it("rejects modified artifacts even while an older valid manifest remains present", async () => {
    const state = await fixture();
    await writeFile(
      path.join(state.directory, "catalog.compiled.ts"),
      state.compiled + "\n",
    );
    expect(() => readCatalogManifest(state.directory, identity)).toThrow(
      /compiled artifact digest mismatch/,
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
    expect(() => readCatalogManifest(state.directory, identity)).toThrow(
      /Unsafe/,
    );
  });
});
