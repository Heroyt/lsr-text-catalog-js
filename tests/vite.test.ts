// @vitest-environment node
import vue from "@vitejs/plugin-vue";
import { readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  build,
  createRunnableDevEnvironment,
  createServer,
  isRunnableDevEnvironment,
  type InlineConfig,
  type ViteDevServer,
} from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { textCatalog, type TextCatalogOptions } from "../src/vite/index.js";
import type { TextCatalogSnapshot } from "../src/vite/types.js";
import { catalogPreloadFiles } from "../src/preload.js";
import { identity, publishCatalog } from "./fixtures.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn(fs.watch) };
});

const cleanup: (() => Promise<unknown>)[] = [];
const source = `import { text, catalogTranslations } from '#catalog';
export const label = text('copy.title');
export const messages = catalogTranslations;
`;

interface EntryResult {
  label: string;
  messages: Record<string, string>;
}

interface Fixture {
  root: string;
  calls: string[];
  beforeCompile?: (snapshot: TextCatalogSnapshot) => Promise<void>;
  config: InlineConfig;
  setTexts: (texts: Record<string, string>, file?: string) => Promise<void>;
  setTranslations: (translations: Record<string, string>) => Promise<void>;
}

function isNotification(
  payload: unknown,
  type: "error" | "full-reload" | "update",
): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    "type" in payload &&
    payload.type === type
  );
}

async function fixture(
  options: Pick<TextCatalogOptions, "mode"> = { mode: "compiled" },
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "text-catalog-vite-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "copy-sources"), { recursive: true }),
    mkdir(path.join(root, "generated"), { recursive: true }),
    mkdir(path.join(root, "src"), { recursive: true }),
    symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      path.join(root, "node_modules"),
      "dir",
    ),
  ]);
  await writeFile(path.join(root, "src/entry.ts"), source);
  await writeFile(path.join(root, "src/copy.ts"), "export {};");
  await writeFile(path.join(root, "src/copy.compiled.ts"), "export {};");
  const state: Fixture = {
    root,
    calls: [],
    config: {},
    async setTexts(texts, file = "copy.neon") {
      const target = path.join(root, "copy-sources", file);
      await mkdir(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(texts));
    },
    async setTranslations(translations) {
      const target = path.join(root, "translations/en_US/LC_MESSAGES/APP.po");
      await mkdir(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(translations));
    },
  };
  // Model compiler output here; PHP catalog tests cover NEON validation.
  const compile = async () => {
    const texts: Record<string, string> = {};
    const directory = path.join(root, "copy-sources");
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".neon")) {
        Object.assign(
          texts,
          JSON.parse(
            await readFile(path.join(entry.parentPath, entry.name), "utf8"),
          ),
        );
      }
    }
    let translations = texts;
    try {
      translations = JSON.parse(
        await readFile(
          path.join(root, "translations/en_US/LC_MESSAGES/APP.po"),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const snapshot: TextCatalogSnapshot = { texts, htmlKeys: {}, plurals: {} };
    state.calls.push(texts["copy.title"] ?? "<missing>");
    await state.beforeCompile?.(snapshot);
    if (texts["copy.title"] === "invalid")
      throw new Error("fixture compiler rejected invalid copy");
    const runtime = `export const catalog = ${JSON.stringify(texts)} as const;
export type TextKey = keyof typeof catalog;
export type HtmlTextKey = never;
export const htmlTextKeys: readonly TextKey[] = [];
export const catalogTranslations = ${JSON.stringify(translations)};
export const sourceLocale = 'en_US';
export const locales = ['en_US'] as const;
export function text(key: TextKey): string {
    if (!Object.hasOwn(catalog, key)) throw new Error('Unknown fixture copy: ' + key);
    return catalog[key];
}
`;
    const compiled = `export const catalogTranslations = ${JSON.stringify(translations)};
export const sourceLocale = 'en_US';
export const locales = ['en_US'] as const;
export type TextKey = ${
      Object.keys(texts)
        .map((key) => JSON.stringify(key))
        .join(" | ") || "never"
    };
export type HtmlTextKey = never;
export declare function text(key: TextKey): string;
`;
    await publishCatalog(
      path.join(root, "generated"),
      snapshot,
      runtime,
      compiled,
    );
  };
  state.config = {
    configFile: false,
    root,
    logLevel: "silent",
    clearScreen: false,
    publicDir: false,
    plugins: [
      textCatalog({
        ...options,
        ...identity,
        root,
        compile,
        sourceDirectory: "copy-sources",
        languageDirectory: "translations",
        frontendDirectory: "generated",
        facade: "src/copy.ts",
        compiledFacade: "src/copy.compiled.ts",
      }),
      vue(),
    ],
    resolve: {
      alias: {
        "#catalog": path.join(root, "generated/catalog.ts"),
        "#copy": path.join(root, "src/copy.ts"),
      },
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      hmr: { port: 0 },
      // Polling avoids macOS replaying fixture setup writes as new HMR edits.
      watch: { usePolling: true, interval: 10 },
    },
    environments: {
      worker: {
        consumer: "server",
        dev: {
          createEnvironment: (name, config) =>
            createRunnableDevEnvironment(name, config),
        },
      },
    },
  };
  await state.setTexts({ "copy.title": "First" });
  return state;
}

async function dev(state: Fixture): Promise<ViteDevServer> {
  const server = await createServer(state.config);
  cleanup.push(() => server.close());
  return server;
}

async function importEntry(server: ViteDevServer, environmentName = "ssr") {
  const environment = server.environments[environmentName];
  if (!environment || !isRunnableDevEnvironment(environment))
    throw new Error(`Missing runnable ${environmentName} environment`);
  return environment.runner.import<EntryResult>("/src/entry.ts");
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

describe("Text catalog Vite lifecycle", () => {
  it("refreshes PO-only edits and translation-directory recreation in evaluated environments", async () => {
    const state = await fixture();
    const server = await dev(state);
    await Promise.all([importEntry(server), importEntry(server, "worker")]);
    await state.setTranslations({ "copy.title": "Translated" });
    await vi.waitFor(async () =>
      expect((await importEntry(server)).messages["copy.title"]).toBe(
        "Translated",
      ),
    );
    expect((await importEntry(server, "worker")).messages["copy.title"]).toBe(
      "Translated",
    );
    expect((await importEntry(server)).label).toBe("First");
    await state.setTranslations({ "copy.title": "Changed" });
    await vi.waitFor(async () =>
      expect((await importEntry(server)).messages["copy.title"]).toBe(
        "Changed",
      ),
    );
    await rm(path.join(state.root, "translations"), { recursive: true });
    await vi.waitFor(async () =>
      expect((await importEntry(server)).messages["copy.title"]).toBe("First"),
    );
    await state.setTranslations({ "copy.title": "Restored" });
    await vi.waitFor(async () =>
      expect((await importEntry(server, "worker")).messages["copy.title"]).toBe(
        "Restored",
      ),
    );
  });

  it("defaults to the original runtime catalog and helpers with dynamic keys", async () => {
    const state = await fixture({});
    await state.setTexts({ "copy.title": "First", "copy.other": "Other" });
    await writeFile(
      path.join(state.root, "src/copy.ts"),
      `import { text } from '#catalog'; export function langText(key: string) { return '[' + text(key) + ']'; }`,
    );
    await writeFile(
      path.join(state.root, "src/entry.ts"),
      `import { text } from '#catalog';
import { langText } from '#copy';
export function choose(key: string) { return text(key); }
export function translated(key: string) { return langText(key); }`,
    );
    const server = await dev(state);
    const environment = server.environments.ssr!;
    if (!isRunnableDevEnvironment(environment))
      throw new Error("Missing runnable SSR environment");
    interface DynamicCopy {
      choose(key: string): string;
      translated(key: string): string;
    }
    const initial =
      await environment.runner.import<DynamicCopy>("/src/entry.ts");
    expect(initial.choose("copy.title")).toBe("First");
    expect(initial.choose("copy.other")).toBe("Other");
    expect(initial.translated("copy.other")).toBe("[Other]");
    expect(() => initial.choose("missing")).toThrow("Unknown fixture copy");
    await state.setTexts({ "copy.title": "Updated", "copy.other": "Changed" });
    await vi.waitFor(async () => {
      const next =
        await environment.runner.import<DynamicCopy>("/src/entry.ts");
      expect(next.choose("copy.title")).toBe("Updated");
      expect(next.translated("copy.other")).toBe("[Changed]");
    });
  });

  it("redirects only the canonical facade in compiled mode for alias and relative imports", async () => {
    const state = await fixture({ mode: "compiled" });
    await mkdir(path.join(state.root, "src/other"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(state.root, "src/copy.ts"),
        `export function pgettext(_context: string, source: string) { return 'runtime:' + source; }`,
      ),
      writeFile(
        path.join(state.root, "src/copy.compiled.ts"),
        `export function pgettext(_context: string, source: string) { return source.toUpperCase(); }`,
      ),
      writeFile(
        path.join(state.root, "src/other/copy.ts"),
        `export function pgettext(_context: string, source: string) { return source.toLowerCase(); }`,
      ),
      writeFile(
        path.join(state.root, "src/entry.ts"),
        `import { pgettext as alias } from '#copy';
import { pgettext as relative } from './copy.ts';
import { pgettext as unrelated } from './other/copy';
import { pgettext as javascript } from './copy.js';
export const label = alias('one', 'upper') + ' ' + relative('two', 'next') + ' ' + unrelated('three', 'KEEP') + ' ' + javascript('four', 'fallback');
export const messages = {};`,
      ),
    ]);
    const server = await dev(state);
    expect((await importEntry(server)).label).toBe("UPPER NEXT keep FALLBACK");
  });

  it("refreshes unchanged callers, translations, and already evaluated SSR environments before notifying the client", async () => {
    const state = await fixture();
    const server = await dev(state);
    const client = server.environments.client;
    const [initial, ssr, worker] = await Promise.all([
      client!.transformRequest("/src/entry.ts"),
      importEntry(server),
      importEntry(server, "worker"),
    ]);
    expect(ssr.label).toBe("First");
    expect(worker.label).toBe("First");
    expect(state.calls).toEqual(["First"]);
    const notifications: string[] = [];
    const renderedAtReload: Promise<EntryResult>[] = [];
    const send = client!.hot.send.bind(client!.hot);
    vi.spyOn(client!.hot, "send").mockImplementation((...args) => {
      const payload = args[0];
      if (isNotification(payload, "full-reload")) {
        renderedAtReload.push(
          importEntry(server),
          importEntry(server, "worker"),
        );
        notifications.push("reload");
      }
      send(...args);
    });
    await state.setTexts({ "copy.title": "Second" });
    await vi.waitFor(() => expect(notifications).toEqual(["reload"]));
    expect(
      (await Promise.all(renderedAtReload)).map(({ label, messages }) => ({
        label,
        messages,
      })),
    ).toEqual([
      { label: "Second", messages: { "copy.title": "Second" } },
      { label: "Second", messages: { "copy.title": "Second" } },
    ]);
    const [nextClient, nextSsr, nextWorker] = await Promise.all([
      client!.transformRequest("/src/entry.ts"),
      importEntry(server),
      importEntry(server, "worker"),
    ]);
    expect(nextSsr).toMatchObject({
      label: "Second",
      messages: { "copy.title": "Second" },
    });
    expect(nextWorker.label).toBe("Second");
    expect(state.calls).toEqual(["First", "Second"]);
  });

  it("blocks stale literals and generated translations after failure, then recovers on the next valid edit", async () => {
    const state = await fixture();
    const server = await dev(state);
    expect((await importEntry(server)).label).toBe("First");
    const notifications = vi.spyOn(server.environments.client!.hot, "send");
    await state.setTexts({ "copy.title": "invalid" });
    await vi.waitFor(() => {
      expect(
        notifications.mock.calls.some(([payload]) =>
          isNotification(payload, "error"),
        ),
      ).toBe(true);
    });
    expect(
      notifications.mock.calls.some(([payload]) =>
        isNotification(payload, "full-reload"),
      ),
    ).toBe(false);
    await expect(importEntry(server)).rejects.toThrow(
      "fixture compiler rejected invalid copy",
    );
    await expect(
      server.environments.client!.transformRequest("/generated/catalog.ts"),
    ).rejects.toThrow("fixture compiler rejected invalid copy");
    expect(state.calls).toEqual(["First", "invalid"]);
    await state.setTexts({ "copy.title": "Recovered" });
    await vi.waitFor(() => {
      expect(
        notifications.mock.calls.some(([payload]) =>
          isNotification(payload, "full-reload"),
        ),
      ).toBe(true);
    });
    expect(await importEntry(server)).toMatchObject({
      label: "Recovered",
      messages: { "copy.title": "Recovered" },
    });
    expect(state.calls).toEqual(["First", "invalid", "Recovered"]);
  });

  it("serializes overlapping generation and never publishes the superseded in-flight snapshot", async () => {
    const state = await fixture();
    const server = await dev(state);
    await importEntry(server);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    cleanup.push(async () => {
      release();
    });
    let active = 0;
    let maximumActive = 0;
    state.beforeCompile = async (snapshot) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (snapshot.texts["copy.title"] === "Intermediate") await held;
      active--;
    };
    const notifications = vi.spyOn(server.environments.client!.hot, "send");
    await state.setTexts({ "copy.title": "Intermediate" });
    await vi.waitFor(() => expect(state.calls).toContain("Intermediate"));
    const requested =
      server.environments.client!.transformRequest("/src/entry.ts");
    await state.setTexts({ "copy.title": "Final" });
    release();
    await requested;
    expect((await importEntry(server)).label).toBe("Final");
    await vi.waitFor(() => {
      expect(
        notifications.mock.calls.filter(([payload]) =>
          isNotification(payload, "full-reload"),
        ),
      ).toHaveLength(1);
    });
    expect(maximumActive).toBe(1);
    expect(state.calls).toEqual(["First", "Intermediate", "Final"]);
  });

  it("discovers nested catalog creation and deletion without changing the importing source", async () => {
    const state = await fixture();
    const server = await dev(state);
    await importEntry(server);
    const notifications = vi.spyOn(server.environments.client!.hot, "send");
    await state.setTexts({ "nested.extra": "Created" }, "nested/extra.neon");
    await vi.waitFor(async () =>
      expect((await importEntry(server)).messages["nested.extra"]).toBe(
        "Created",
      ),
    );
    notifications.mockClear();
    await rm(path.join(state.root, "copy-sources/nested"), { recursive: true });
    await vi.waitFor(async () =>
      expect((await importEntry(server)).messages).not.toHaveProperty(
        "nested.extra",
      ),
    );
    expect((await importEntry(server)).label).toBe("First");
    expect(
      notifications.mock.calls.some(([payload]) =>
        isNotification(payload, "full-reload"),
      ),
    ).toBe(true);
  });

  it("keeps watching a deleted catalog root and recovers when it is recreated", async () => {
    const state = await fixture();
    const server = await dev(state);
    await importEntry(server);
    const notifications = vi.spyOn(server.environments.client!.hot, "send");
    await rm(path.join(state.root, "copy-sources"), { recursive: true });
    await vi.waitFor(() => {
      expect(
        notifications.mock.calls.some(([payload]) =>
          isNotification(payload, "error"),
        ),
      ).toBe(true);
    });
    await expect(importEntry(server)).rejects.toThrow(
      "Text catalog compilation failed",
    );
    await state.setTexts({ "copy.title": "Recreated" });
    await vi.waitFor(async () =>
      expect((await importEntry(server)).label).toBe("Recreated"),
    );
  });

  it("preserves native Vue HMR and refreshes evaluated SSR runners after preprocessed source edits", async () => {
    const state = await fixture();
    const component = path.join(state.root, "src/View.vue");
    const initialSource = `<script setup lang="ts">import { text } from '#catalog'; const title = text('copy.title');</script><template><h1>{{ title }}</h1></template>`;
    await writeFile(component, initialSource);
    await writeFile(
      path.join(state.root, "src/render.ts"),
      `import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import View from './View.vue';
export function render() { return renderToString(createSSRApp(View)); }`,
    );
    const server = await dev(state);
    const client = server.environments.client!;
    const render = async (name: string) => {
      const environment = server.environments[name]!;
      if (!isRunnableDevEnvironment(environment))
        throw new Error(`Missing runnable ${name} environment`);
      const module = await environment.runner.import<{
        render(): Promise<string>;
      }>("/src/render.ts");
      return module.render();
    };
    await client.transformRequest("/src/View.vue");
    expect(await render("ssr")).toBe("<h1>First</h1>");
    expect(await render("worker")).toBe("<h1>First</h1>");
    const notifications = vi.spyOn(client.hot, "send");
    server.watcher.emit(
      "change",
      path.join(state.root, "copy-sources/copy.neon"),
    );
    // The script is unchanged: preprocessing must not make Vue mistake this for a script update.
    await writeFile(component, initialSource.replaceAll("h1", "h2"));
    await vi.waitFor(() => {
      expect(
        notifications.mock.calls.some(([payload]) =>
          isNotification(payload, "update"),
        ),
      ).toBe(true);
    });
    await client.transformRequest("/src/View.vue");
    expect(await render("ssr")).toBe("<h2>First</h2>");
    expect(await render("worker")).toBe("<h2>First</h2>");
    expect(
      notifications.mock.calls.some(([payload]) =>
        isNotification(payload, "full-reload"),
      ),
    ).toBe(false);
    notifications.mockClear();
    await writeFile(
      component,
      initialSource.replace("text('copy.title')", "text('copy.title') + '!'"),
    );
    await vi.waitFor(() => {
      expect(
        notifications.mock.calls.some(([payload]) =>
          isNotification(payload, "update"),
        ),
      ).toBe(true);
    });
    await client.transformRequest("/src/View.vue");
    expect(await render("ssr")).toBe("<h1>First!</h1>");
    expect(await render("worker")).toBe("<h1>First!</h1>");
    expect(
      notifications.mock.calls.some(([payload]) =>
        isNotification(payload, "full-reload"),
      ),
    ).toBe(false);
    expect(state.calls).toEqual(["First"]);
  });

  it("rebuilds without publishing stale output when copy changes during the first transform", async () => {
    const state = await fixture();
    let changed = false;
    const watcher = await build({
      ...state.config,
      plugins: [
        ...state.config.plugins!,
        {
          name: "edit-copy-during-transform",
          enforce: "post",
          async transform(_source, id) {
            if (changed || !id.endsWith("/src/entry.ts")) return;
            changed = true;
            await state.setTexts({ "copy.title": "Changed during build" });
          },
        },
      ],
      build: {
        watch: {},
        minify: false,
        lib: {
          entry: path.join(state.root, "src/entry.ts"),
          formats: ["cjs"],
          fileName: () => "fixture.cjs",
        },
        outDir: path.join(state.root, "dist"),
      },
    });
    if (!("on" in watcher))
      throw new Error("Expected an actual Vite build watcher");
    cleanup.push(() => watcher.close());
    const emitted: (string | undefined)[] = [];
    let buildError: Error | undefined;
    watcher.on("event", (event) => {
      if (event.code === "ERROR") buildError = event.error;
      if (event.code !== "BUNDLE_END") return;
      const exports: { label?: string } = {};
      runInNewContext(
        readFileSync(path.join(state.root, "dist/fixture.cjs"), "utf8"),
        { exports, module: { exports } },
      );
      emitted.push(exports.label);
    });
    await vi.waitFor(
      () => {
        if (emitted.length === 0 && buildError) throw buildError;
        expect(emitted).toContain("Changed during build");
      },
      { timeout: 5000 },
    );
    expect(emitted).not.toContain("First");
  }, 10000);

  it("invalidates Rolldown transform caches on updates and nested create/delete without generated-output watch loops", async () => {
    const state = await fixture();
    const watcher = await build({
      ...state.config,
      build: {
        watch: {},
        minify: false,
        lib: {
          entry: path.join(state.root, "src/entry.ts"),
          formats: ["cjs"],
          fileName: () => "fixture.cjs",
        },
        outDir: path.join(state.root, "dist"),
      },
    });
    if (!("on" in watcher))
      throw new Error("Expected an actual Vite build watcher");
    cleanup.push(() => watcher.close());
    let buildError: Error | undefined;
    let building = true;
    let completed = 0;
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_START") {
        buildError = undefined;
        building = true;
      }
      if (event.code === "ERROR") buildError = event.error;
      if (event.code === "END") {
        building = false;
        completed++;
      }
    });
    const built = async () => {
      if (buildError) throw buildError;
      if (building) throw new Error("Waiting for the native watcher END event");
      const exports: { label?: string; messages?: Record<string, string> } = {};
      const code = await readFile(
        path.join(state.root, "dist/fixture.cjs"),
        "utf8",
      );
      runInNewContext(code, { exports, module: { exports } });
      return exports;
    };
    await vi.waitFor(async () => expect((await built()).label).toBe("First"), {
      timeout: 15000,
    });
    // Keep real OS watchers, but inject a deterministic platform failure and a failed replacement.
    const directory = await realpath(path.join(state.root, "copy-sources"));
    const watched = vi.mocked(watch);
    const nativeWatch = watched.getMockImplementation();
    const index = watched.mock.calls.findLastIndex(
      ([file]) => String(file) === directory,
    );
    const failed = watched.mock.results[index];
    if (!nativeWatch || failed?.type !== "return")
      throw new Error("Missing actual catalog source watcher");
    let rejectRecreation = true;
    watched.mockImplementation((...args) => {
      if (rejectRecreation && String(args[0]) === directory)
        throw new Error("fixture source watcher unavailable");
      return nativeWatch(...args);
    });
    cleanup.push(async () => {
      watched.mockImplementation(nativeWatch);
    });
    failed.value.close();
    failed.value.emit("error", new Error("fixture source watcher unavailable"));
    await vi.waitFor(
      () =>
        expect(buildError?.message).toContain(
          "fixture source watcher unavailable",
        ),
      { timeout: 15000 },
    );
    rejectRecreation = false;
    await state.setTexts({ "copy.title": "Recovered" });
    await vi.waitFor(
      async () => expect((await built()).label).toBe("Recovered"),
      { timeout: 15000 },
    );
    // Subsequent unknown nested paths must still be observed by the replacement source watcher.
    // Deliver a real source-watcher event before asynchronous recompilation can restore cleaned output.
    const active =
      watched.mock.results[
        watched.mock.calls.findLastIndex(([file]) => String(file) === directory)
      ];
    if (active?.type !== "return")
      throw new Error("Missing replacement source watcher");
    rmSync(path.join(state.root, "generated"), { recursive: true });
    writeFileSync(
      path.join(directory, "copy.neon"),
      JSON.stringify({ "copy.title": "Updated" }),
    );
    active.value.emit("change", "change", "copy.neon");
    await vi.waitFor(
      async () =>
        expect(await built()).toMatchObject({
          label: "Updated",
          messages: { "copy.title": "Updated" },
        }),
      {
        timeout: 15000,
      },
    );
    await state.setTexts({ "nested.extra": "Added" }, "nested/extra.neon");
    await vi.waitFor(
      async () =>
        expect((await built()).messages?.["nested.extra"]).toBe("Added"),
      { timeout: 15000 },
    );
    await rm(path.join(state.root, "copy-sources/nested"), { recursive: true });
    await vi.waitFor(
      async () =>
        expect((await built()).messages).not.toHaveProperty("nested.extra"),
      { timeout: 15000 },
    );
    await state.setTranslations({ "copy.title": "Translated" });
    await vi.waitFor(
      async () =>
        expect((await built()).messages?.["copy.title"]).toBe("Translated"),
      { timeout: 15000 },
    );
    await state.setTranslations({ "copy.title": "Changed" });
    await vi.waitFor(
      async () =>
        expect((await built()).messages?.["copy.title"]).toBe("Changed"),
      { timeout: 15000 },
    );
    await rm(path.join(state.root, "translations"), { recursive: true });
    await vi.waitFor(
      async () =>
        expect((await built()).messages?.["copy.title"]).toBe("Updated"),
      { timeout: 15000 },
    );
    await state.setTranslations({ "copy.title": "Restored" });
    await vi.waitFor(
      async () =>
        expect((await built()).messages?.["copy.title"]).toBe("Restored"),
      { timeout: 15000 },
    );
    // Directory events can still queue a legitimate build after its content is current.
    // Require the watcher to converge; a generated-output loop never reaches this quiet window.
    // Native filesystem/Rolldown debounce runs outside Vitest's fake clock.
    await vi.waitFor(
      async () => {
        const settledBuilds = completed;
        const settledCompiles = state.calls.length;
        const { promise: quiet, resolve: settled } =
          Promise.withResolvers<void>();
        setTimeout(settled, 250);
        await quiet;
        expect(completed).toBe(settledBuilds);
        expect(state.calls).toHaveLength(settledCompiles);
      },
      { timeout: 3000 },
    );
  }, 60000);
});

describe("split catalog groups", () => {
  const trilingual = { ...identity, locales: ["en_US", "cs_CZ", "de_DE"] };
  const texts = { "game.title": "Play", "shop.cart": "Cart" };
  const translations: Record<string, Record<string, object>> = {
    cs_CZ: {
      game: { Play: { "game.title": "Hrát" } },
      shop: { Cart: { "shop.cart": "Košík" } },
    },
    de_DE: {
      game: { Play: { "game.title": "Spielen" } },
      shop: { Cart: { "shop.cart": "Warenkorb" } },
    },
  };
  const groupsModule = (source: boolean) => `export const catalogGroups = {
${["game", "shop"]
  .map(
    (
      group,
    ) => `  ${group}: {${source ? `\n    source: () => import('./texts/${group}.js'),` : ""}
    translations: {
      cs_CZ: () => import('./texts/${group}.cs_CZ.js'),
      de_DE: () => import('./texts/${group}.de_DE.js'),
    },
  },`,
  )
  .join("\n")}
};
export const sourceLocale = 'en_US' as const;
export const locales = ['en_US', 'cs_CZ', 'de_DE'] as const;
export type TextKey = "game.title" | "shop.cart";
`;

  async function app(
    entry: string,
    split?: TextCatalogOptions["split"],
    mode: TextCatalogOptions["mode"] = "compiled",
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), "text-catalog-split-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const write = async (file: string, content: string) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    };
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      path.join(root, "node_modules"),
      "dir",
    );
    await write("copy-sources/game.neon", "");
    await write(
      "src/copy.ts",
      `import * as generated from '../generated/catalog.js';
import { createRuntimeCatalog } from 'lsr-text-catalog/runtime';
// No loadTexts export: generated group modules load through the package.
export const { langText, createCatalog, installCatalog, loadLocale } =
  createRuntimeCatalog({ ...generated, htmlTextKeys: [] });
`,
    );
    await write(
      "src/copy.compiled.ts",
      `import * as generated from '../generated/catalog.compiled.js';
import { createCompiledCatalog } from 'lsr-text-catalog/compiled';
export const { pgettext, npgettext, htmlPgettext, createCatalog, installCatalog, loadLocale } =
  createCompiledCatalog(generated);
`,
    );
    await write(
      "src/game.ts",
      `import { langText } from './copy';\nexport const label = () => langText('game.title');\n`,
    );
    await write(
      "src/shop.ts",
      `import { langText } from './copy';\nexport const label = () => langText('shop.cart');\n`,
    );
    await write("src/entry.ts", entry);
    const compile = async () => {
      await publishCatalog(
        path.join(root, "generated"),
        { texts, htmlKeys: {}, plurals: {} },
        groupsModule(true),
        `${groupsModule(false)}export declare function text(key: TextKey): string;\n`,
        {
          identity: trilingual,
          files: Object.fromEntries(
            Object.entries(translations).flatMap(([locale, groups]) =>
              Object.entries(groups).map(([group, messages]) => [
                `texts/${group}.${locale}.ts`,
                `export default ${JSON.stringify(messages)};\n`,
              ]),
            ),
          ),
        },
      );
    };
    const config = (ssr: boolean): InlineConfig => ({
      configFile: false,
      root,
      logLevel: "silent",
      publicDir: false,
      plugins: [
        textCatalog({
          ...trilingual,
          mode,
          root,
          compile,
          split,
          sourceDirectory: "copy-sources",
          languageDirectory: "translations",
          frontendDirectory: "generated",
          facade: "src/copy.ts",
          compiledFacade: "src/copy.compiled.ts",
        }),
      ],
      resolve: {
        alias: {
          "lsr-text-catalog/runtime": fileURLToPath(
            new URL("../src/runtime/index.ts", import.meta.url),
          ),
          "lsr-text-catalog/compiled": fileURLToPath(
            new URL("../src/compiled/index.ts", import.meta.url),
          ),
        },
      },
      ssr: { noExternal: true, external: ["vue", "vue3-gettext"] },
      build: {
        ssr,
        outDir: ssr ? "dist-ssr" : "dist",
        minify: false,
        rolldownOptions: {
          input: path.join(root, "src/entry.ts"),
          ...(ssr ? {} : { external: ["vue", "vue3-gettext"] }),
          preserveEntrySignatures: "exports-only",
        },
      },
    });
    return { root, config };
  }

  const renderEntry = `import { createSSRApp } from 'vue';
import { createCatalog, installCatalog, loadLocale } from './copy';
export async function render(locale: string, page: 'game' | 'shop') {
  await loadLocale(locale);
  const module = page === 'game' ? await import('./game') : await import('./shop');
  const app = createSSRApp({});
  installCatalog(app, createCatalog({ locale }));
  return app.runWithContext(() => module.label());
}
`;

  // Chunk partition of the four translations: [cs game, cs shop, de game, de shop].
  it.each([
    ["split groups and locales", undefined, [1, 2, 3, 4]],
    ["unsplit groups", { groups: false }, [1, 1, 2, 2]],
    ["unsplit locales", { locales: false }, [1, 2, 1, 2]],
    ["nothing split", { groups: false, locales: false }, [1, 1, 1, 1]],
  ] as const)(
    "bundles translations for %s and loads them before translated modules run",
    async (_name, split, partition) => {
      const { root, config } = await app(renderEntry, split);
      await build(config(false));
      const files = await readdir(path.join(root, "dist/assets"));
      const contents = await Promise.all(
        files.map((file) =>
          readFile(path.join(root, "dist/assets", file), "utf8"),
        ),
      );
      const chunkOf = (text: string | RegExp) => {
        const holding = files.filter((_, index) =>
          typeof text === "string"
            ? contents[index]!.includes(text)
            : text.test(contents[index]!),
        );
        expect(holding).toHaveLength(1);
        return holding[0]!;
      };
      const chunks = ["Hrát", "Košík", "Spielen", "Warenkorb"].map(chunkOf);
      // Same chunk exactly where the partition says so; never next to the page's source copy.
      for (const [a, chunk] of chunks.entries())
        for (const [b, other] of chunks.entries())
          expect(chunk === other).toBe(partition[a] === partition[b]);
      expect(chunks).not.toContain(
        chunkOf(/pgettext\)?\(\s*"game\.title",\s*"Play"/u),
      );
      // Bundles are real chunks: no per-group/locale facade modules are left behind.
      if (split)
        expect(files.filter((file) => /^(game|shop)\./u.test(file))).toEqual(
          [],
        );

      await build(config(true));
      const [entry] = (await readdir(path.join(root, "dist-ssr"))).filter(
        (file) => file.startsWith("entry."),
      );
      // Built output exists only after build(); its path cannot be imported statically.
      const { render } = (await import(
        path.join(root, "dist-ssr", entry!)
      )) as {
        render: (locale: string, page: string) => Promise<string>;
      };
      expect(await render("en_US", "game")).toBe("Play");
      expect(await render("cs_CZ", "game")).toBe("Hrát");
      expect(await render("de_DE", "shop")).toBe("Warenkorb");
      expect(await render("cs_CZ", "shop")).toBe("Košík");
    },
    30000,
  );

  it("loads runtime-mode groups implicitly from literal keys and literal key maps", async () => {
    const { root, config } = await app(renderEntry, undefined, "runtime");
    // A finite dynamic selection; runtime mode keeps the lookup dynamic.
    await writeFile(
      path.join(root, "src/shop.ts"),
      `import { langText } from './copy';
const keys: Record<string, 'shop.cart'> = { cart: 'shop.cart' };
export const label = (name = 'cart') => langText(keys[name]!);
`,
    );
    await build(config(false));
    const files = await readdir(path.join(root, "dist/assets"));
    const contents = await Promise.all(
      files.map((file) =>
        readFile(path.join(root, "dist/assets", file), "utf8"),
      ),
    );
    const holding = (pattern: RegExp) =>
      files.filter((_, index) => pattern.test(contents[index]!));
    // Source copy (group-relative keys) is split per group as well, away from the pages using it.
    const game = holding(/"?title"?:\s*"Play"/u);
    const shop = holding(/"?cart"?:\s*"Cart"/u);
    expect(game).toHaveLength(1);
    expect(shop).toHaveLength(1);
    expect(game).not.toEqual(shop);

    await build(config(true));
    const [entry] = (await readdir(path.join(root, "dist-ssr"))).filter(
      (file) => file.startsWith("entry."),
    );
    // Built output exists only after build(); its path cannot be imported statically.
    const { render } = (await import(path.join(root, "dist-ssr", entry!))) as {
      render: (locale: string, page: string) => Promise<string>;
    };
    expect(await render("en_US", "game")).toBe("Play");
    expect(await render("cs_CZ", "game")).toBe("Hrát");
    expect(await render("de_DE", "shop")).toBe("Warenkorb");
  }, 30000);

  it("starts every group of a chunk at once and emits a preload manifest", async () => {
    const { root, config } = await app(`import { label as game } from './game';
import { label as shop } from './shop';
export const labels = () => [game(), shop()];
`);
    await build(config(false));
    const assets = path.join(root, "dist/assets");
    const files = await readdir(assets);
    const contents: Record<string, string> = Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          await readFile(path.join(assets, file), "utf8"),
        ]),
      ),
    );
    const loading = Object.values(contents).filter((code) =>
      code.includes("loadCatalogGroups(catalogGroups"),
    );
    expect(loading).toHaveLength(1);
    // Both group modules of the entry chunk carry the whole chunk's group list.
    expect(
      loading[0]!.match(/\["game", "shop"\]|\["game","shop"\]/gu),
    ).toHaveLength(2);
    expect(loading[0]).not.toContain("__LSR_TEXT_CATALOG_CHUNK_GROUPS__");

    const manifest = JSON.parse(
      await readFile(path.join(root, "dist/.vite/text-catalog.json"), "utf8"),
    );
    const preloads = catalogPreloadFiles(manifest, ["game", "shop"], "cs_CZ");
    const preloaded = preloads.map(
      (file) => contents[path.basename(file)] ?? "",
    );
    for (const text of ["Hrát", "Košík"])
      expect(preloaded.some((code) => code.includes(text))).toBe(true);
    expect(preloaded.some((code) => code.includes("Spielen"))).toBe(false);
    // Compiled source-locale renders need no data at all.
    expect(catalogPreloadFiles(manifest, ["game"], "en_US")).toEqual([]);
  }, 30000);

  it("rejects non-boolean split settings", () => {
    expect(() =>
      textCatalog({
        ...trilingual,
        compile: () => {},
        split: { groups: "no" as never },
        sourceDirectory: "copy",
        languageDirectory: "languages",
        frontendDirectory: "generated",
        facade: "src/copy.ts",
      }),
    ).toThrow(/must be booleans/);
  });

  it("rejects group modules that the current generation does not contain", async () => {
    const { config } = await app(
      `import 'virtual:lsr-text-catalog/group/missing';\nexport const value = 1;\n`,
    );
    await expect(build(config(false))).rejects.toThrow(
      /Unknown text catalog group "missing"/,
    );
  });
});
