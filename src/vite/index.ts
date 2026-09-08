import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import path from "node:path";
import {
  isRunnableDevEnvironment,
  normalizePath,
  type Plugin,
  type ViteDevServer,
} from "vite";

import { transformTextCatalog } from "./transform.js";
import type {
  CatalogIdentity,
  TextCatalogSnapshot,
  TextCatalogTransformOptions,
} from "./types.js";
import { readCatalogManifest } from "./manifest.js";

export type TextCatalogMode = "runtime" | "compiled";

export interface TextCatalogOptions extends CatalogIdentity {
  /** Preserve dynamic runtime lookups by default; opt into literal expansion explicitly. */
  mode?: TextCatalogMode;
  root?: string;
  /** Input/output paths are relative to root, or absolute. No app-specific defaults. */
  sourceDirectory: string;
  languageDirectory: string;
  frontendDirectory: string;
  /** Real consumer-local authoring facade, also resolved by standalone TypeScript. */
  facade: string;
  /** Required in compiled mode; exports createCatalog/installCatalog and gettext adapters. */
  compiledFacade?: string;
  /** Compile and publish all format-v1 artifacts. The host owns process/env/bootstrap choices. */
  compile: (root: string) => void | Promise<void>;
}

interface PublishedCatalog {
  revision: string;
  snapshot: TextCatalogSnapshot;
  frontend: string;
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** Generate Text catalog, optionally expanding literals before Vue, with one coherent snapshot across environments. */
export function textCatalog(options: TextCatalogOptions): Plugin {
  if (typeof options.compile !== "function")
    throw new Error("textCatalog requires a compiler callback.");
  const mode = options.mode ?? "runtime";
  if (mode !== "runtime" && mode !== "compiled")
    throw new Error("Unknown text catalog mode.");
  if (mode === "compiled" && !options.compiledFacade)
    throw new Error("Compiled mode requires a compiledFacade file.");
  for (const name of [
    "sourceDirectory",
    "languageDirectory",
    "frontendDirectory",
    "facade",
  ] as const) {
    if (!options[name]) throw new Error(`textCatalog requires ${name}.`);
  }
  const identity: CatalogIdentity = {
    domain: options.domain,
    sourceLocale: options.sourceLocale,
    locales: [...options.locales],
  };
  let root = path.resolve(options.root ?? ".");
  let catalogDirectory = path.resolve(root, options.sourceDirectory);
  let languageDirectory = path.resolve(root, options.languageDirectory);
  let frontendDirectory = path.resolve(root, options.frontendDirectory);
  let frontendFile = path.join(frontendDirectory, "catalog.ts");
  let compiledFrontendFile = path.join(
    frontendDirectory,
    "catalog.compiled.ts",
  );
  let facadeFile = path.resolve(root, options.facade);
  let compiledFacadeFile = path.resolve(
    root,
    options.compiledFacade ?? options.facade,
  );
  let configuredRoot = root;
  let revisionFile = path.join(frontendDirectory, "catalog.watch");
  const sourceWatchers = new Map<string, FSWatcher>();
  let sourceWatchError: Error | undefined;
  let watchBuild = false;
  let buildCatalog: PublishedCatalog | undefined;
  let markerRevision: string | undefined;
  let sourceVersion = 0;
  let buildSourceVersion = 0;
  let watchRetry: NodeJS.Timeout | undefined;
  let server: ViteDevServer | undefined;
  let published: PublishedCatalog | undefined;
  let pending: Promise<PublishedCatalog> | undefined;
  let failure: { revision: string; error: Error } | undefined;
  let dirty = true;
  let lastReloaded: PublishedCatalog | undefined;
  const dependencies = new Set<string>();
  const sourceFiles = new Set<string>();
  const compile = options.compile;

  function canonicalFile(file: string): string {
    // Vite resolves modules through realpath, while Chokidar can report the configured symlink path.
    return configuredRoot !== root && isWithin(configuredRoot, file)
      ? path.join(root, path.relative(configuredRoot, file))
      : file;
  }

  function transformOptions(
    resolve: (
      source: string,
      importer: string,
    ) => Promise<{ id: string } | null>,
  ): TextCatalogTransformOptions {
    return {
      root,
      facade: normalizePath(facadeFile),
      async resolveModule(source, importer) {
        const resolved = await resolve(source, importer);
        if (!resolved || /[?#\0]/u.test(resolved.id)) return undefined;
        const file = canonicalFile(resolved.id);
        if (file === facadeFile || file === compiledFacadeFile) return "copy";
        if (file === frontendFile || file === compiledFrontendFile)
          return "catalog";
        return undefined;
      },
    };
  }

  function isGenerated(file: string): boolean {
    return (
      isWithin(frontendDirectory, file) ||
      (isWithin(languageDirectory, file) && /\.(?:pot|mo)$/.test(file))
    );
  }

  function isSource(id: string): boolean {
    return (
      !id.includes("\0") &&
      !/[?#]/.test(id) &&
      !normalizePath(id).includes("/node_modules/") &&
      !isGenerated(id) &&
      id !== facadeFile &&
      id !== compiledFacadeFile &&
      /\.(?:vue|[cm]?[jt]sx?)$/.test(id) &&
      !/\.d\.[cm]?ts$/.test(id)
    );
  }

  function isCatalogInput(file: string): boolean {
    return (
      (isWithin(catalogDirectory, file) &&
        (file.endsWith(".neon") ||
          dependencies.has(file) ||
          path.extname(file) === "")) ||
      (isWithin(languageDirectory, file) &&
        (file.endsWith(".po") ||
          dependencies.has(file) ||
          path.extname(file) === ""))
    );
  }

  function updateWatchRevision(force = false): void {
    const revision = scan();
    if (!force && markerRevision === revision) return;
    markerRevision = revision;
    sourceVersion++;
    markDirty();
    // Rolldown 1.2 watches directories non-recursively and ignores events for unknown child paths.
    // A real watched file bridges those structural events into its native transform dependency graph.
    mkdirSync(path.dirname(revisionFile), { recursive: true });
    writeFileSync(revisionFile, `${revision}\n${sourceVersion}\n`);
  }

  function startSourceWatcher(): void {
    if (sourceWatchers.size && !sourceWatchError) return;
    mkdirSync(path.dirname(revisionFile), { recursive: true });
    function synchronize(): void {
      // Watch only input trees recursively. The shallow root watch restores
      // them after deletion without traversing node_modules or build output.
      const directories = new Map<string, boolean>();
      for (const input of [catalogDirectory, languageDirectory]) {
        if (existsSync(input)) directories.set(input, true);
        let parent = path.dirname(input);
        while (!existsSync(parent) && path.dirname(parent) !== parent)
          parent = path.dirname(parent);
        if (!directories.has(parent)) directories.set(parent, false);
      }
      for (const [directory, watcher] of sourceWatchers) {
        if (!directories.has(directory)) {
          watcher.close();
          sourceWatchers.delete(directory);
        }
      }
      for (const [directory, recursive] of directories) {
        if (sourceWatchers.has(directory)) continue;
        let watcher: FSWatcher;
        try {
          watcher = watch(directory, { recursive }, (_event, filename) => {
            if (filename !== null) {
              const file = path.resolve(directory, filename.toString());
              if (
                !isCatalogInput(file) &&
                !isWithin(file, catalogDirectory) &&
                !isWithin(file, languageDirectory)
              )
                return;
            }
            synchronize();
            updateWatchRevision();
          });
        } catch (cause) {
          sourceWatchError =
            cause instanceof Error ? cause : new Error(String(cause));
          return;
        }
        sourceWatchers.set(directory, watcher);
        watcher.on("error", (error) => {
          if (sourceWatchers.get(directory) !== watcher) return;
          watcher.close();
          sourceWatchers.delete(directory);
          sourceWatchError = error;
          synchronize();
          updateWatchRevision(true);
        });
      }
      sourceWatchError = undefined;
    }
    synchronize();
    updateWatchRevision();
    dependencies.add(revisionFile);
  }

  function scan(): string {
    const hash = createHash("sha256");
    sourceFiles.clear();
    // Keep deleted paths registered, and an existing ancestor to detect a missing root being recreated.
    for (const input of [catalogDirectory, languageDirectory]) {
      let ancestor = input;
      while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor)
        ancestor = path.dirname(ancestor);
      dependencies.add(ancestor);
      dependencies.add(input);
    }
    function visit(directory: string, extension: ".neon" | ".po"): void {
      dependencies.add(directory);
      hash.update(`directory\0${path.relative(root, directory)}\0`);
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("missing\0");
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(file, extension);
        } else if (
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.endsWith(extension)
        ) {
          dependencies.add(file);
          hash.update(`file\0${path.relative(root, file)}\0`);
          try {
            hash.update(readFileSync(file));
            sourceFiles.add(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            hash.update("missing\0");
          }
          hash.update("\0");
        }
      }
    }
    visit(catalogDirectory, ".neon");
    visit(languageDirectory, ".po");
    server?.watcher.add([...dependencies]);
    return hash.digest("hex");
  }

  function invalidate(): void {
    if (!server) return;
    for (const environment of Object.values(server.environments)) {
      const active = environment.moduleGraph.idToModuleMap.size > 0;
      environment.moduleGraph.invalidateAll();
      // Invalidating the transform graph alone does not clear evaluated SSR exports.
      if (active && isRunnableDevEnvironment(environment))
        environment.runner.clearCache();
    }
  }

  function markDirty(): void {
    if (!dirty) invalidate();
    dirty = true;
  }

  async function generate(): Promise<PublishedCatalog> {
    for (;;) {
      dirty = false;
      const revision = scan();
      if (published?.revision === revision && !failure) return published;
      if (failure?.revision === revision) throw failure.error;
      try {
        await compile(root);
        const artifacts = readCatalogManifest(frontendDirectory, identity);
        const snapshot = artifacts.manifest;
        const frontend = artifacts[mode];
        // A compile can overlap edits even before a watcher delivers its event. Never publish it then.
        if (scan() !== revision) continue;
        dirty = false;
        const initial = !published && !failure;
        failure = undefined;
        published = { revision, snapshot, frontend };
        // Startup watcher events for unchanged inputs must not reset an already mounted app.
        if (initial) lastReloaded = published;
        return published;
      } catch (cause) {
        if (scan() !== revision) continue;
        dirty = false;
        const detail = cause instanceof Error ? cause.message : String(cause);
        const error = new Error(`Text catalog compilation failed: ${detail}`, {
          cause,
        });
        failure = { revision, error };
        // Keep the previous object private; every reader goes through this failed revision barrier.
        throw error;
      }
    }
  }

  async function current(): Promise<PublishedCatalog> {
    if (pending) return pending;
    if (!dirty && failure) throw failure.error;
    if (!dirty && published) return published;
    pending = generate();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }

  function reload(): void {
    if (!server) return;
    invalidate();
    const clientChannel = server.environments.client?.hot;
    const notified = new Set([clientChannel]);
    for (const environment of Object.values(server.environments)) {
      // Local runners were synchronously cleared above. Their channels can be shared with the
      // client or forward runner HMR; sending again can produce duplicate browser reloads.
      if (
        isRunnableDevEnvironment(environment) ||
        notified.has(environment.hot)
      )
        continue;
      notified.add(environment.hot);
      environment.hot.send({ type: "full-reload", path: "*" });
    }
    clientChannel?.send({ type: "full-reload", path: "*" });
  }

  async function refreshCatalog(): Promise<void> {
    const next = await current();
    if (lastReloaded === next) return;
    lastReloaded = next;
    reload();
  }

  return {
    name: "text-catalog",
    enforce: "pre",
    config(config) {
      if (!config.build?.watch) return;
      const configuredRoot = path.resolve(options.root ?? config.root ?? ".");
      const existing = config.build.watch.exclude;
      return {
        build: {
          watch: {
            exclude: [
              ...(Array.isArray(existing)
                ? existing
                : existing
                  ? [existing]
                  : []),
              `${normalizePath(path.resolve(realpathSync(configuredRoot), options.frontendDirectory))}/*.{ts,json,php}`,
              `${normalizePath(path.resolve(realpathSync(configuredRoot), options.languageDirectory))}/**/*.{po,pot,mo}`,
            ],
          },
        },
      };
    },
    configResolved(config) {
      configuredRoot = path.resolve(options.root ?? config.root);
      root = realpathSync(configuredRoot);
      catalogDirectory = path.resolve(root, options.sourceDirectory);
      languageDirectory = path.resolve(root, options.languageDirectory);
      facadeFile = path.resolve(root, options.facade);
      compiledFacadeFile = path.resolve(
        root,
        options.compiledFacade ?? options.facade,
      );
      frontendDirectory = path.resolve(root, options.frontendDirectory);
      frontendFile = path.join(frontendDirectory, "catalog.ts");
      compiledFrontendFile = path.join(
        frontendDirectory,
        "catalog.compiled.ts",
      );
      facadeFile = realpathSync(facadeFile);
      if (mode === "compiled")
        compiledFacadeFile = realpathSync(compiledFacadeFile);
      if (mode === "compiled" && facadeFile === compiledFacadeFile)
        throw new Error("Compiled and runtime facades must be distinct files.");
      for (const input of [catalogDirectory, languageDirectory]) {
        if (
          isWithin(frontendDirectory, input) ||
          isWithin(input, frontendDirectory)
        ) {
          throw new Error(
            "Catalog input and frontend output directories must not overlap.",
          );
        }
      }
      revisionFile = path.join(frontendDirectory, "catalog.watch");
      watchBuild = config.command === "build" && !!config.build.watch;
      if (mode === "compiled") {
        const vue = config.plugins.find((plugin) => plugin.name === "vite:vue");
        const hook = vue?.handleHotUpdate;
        if (vue && hook) {
          const handler = typeof hook === "function" ? hook : hook.handler;
          // Vite keeps modern hotUpdate and legacy handleHotUpdate contexts separate.
          // Vue must compare the same preprocessed SFCs that its transform cached.
          const wrapped: typeof handler = function (context) {
            if (
              !isSource(canonicalFile(context.file)) ||
              !context.file.endsWith(".vue")
            )
              return handler.call(this, context);
            const read = context.read;
            return handler.call(this, {
              ...context,
              read: async () => {
                const source = await read();
                const next = await current();
                return (
                  (
                    await transformTextCatalog(
                      source,
                      canonicalFile(context.file),
                      next.snapshot,
                      transformOptions((source, importer) =>
                        context.server.environments.client!.pluginContainer.resolveId(
                          source,
                          importer,
                        ),
                      ),
                    )
                  )?.code ?? source
                );
              },
            });
          };
          vue.handleHotUpdate =
            typeof hook === "function"
              ? wrapped
              : { ...hook, handler: wrapped };
        }
      }
    },
    configureServer(devServer) {
      server = devServer;
      scan();
      // Vite's hotUpdate covers files, but not empty directory creation/deletion.
      const directoryChanged = (directory: string) => {
        const file = canonicalFile(directory);
        if (
          !isWithin(catalogDirectory, file) &&
          !isWithin(languageDirectory, file)
        )
          return;
        markDirty();
        void refreshCatalog().catch((error: Error) => {
          devServer.config.logger.error(error.message);
          devServer.environments.client?.hot.send({
            type: "error",
            err: { message: error.message, stack: error.stack ?? "" },
          });
        });
      };
      devServer.watcher.on("addDir", directoryChanged);
      devServer.watcher.on("unlinkDir", directoryChanged);
      devServer.httpServer?.once("close", () => {
        devServer.watcher.off("addDir", directoryChanged);
        devServer.watcher.off("unlinkDir", directoryChanged);
      });
    },
    async buildStart() {
      if (watchBuild) startSourceWatcher();
      if (sourceWatchError) this.error(sourceWatchError);
      markDirty();
      scan();
      for (const file of dependencies) this.addWatchFile(file);
      buildCatalog = await current();
      buildSourceVersion = sourceVersion;
      for (const file of dependencies) this.addWatchFile(file);
    },
    renderStart() {
      if (!watchBuild || !buildCatalog) return;
      if (
        sourceVersion !== buildSourceVersion ||
        scan() !== buildCatalog.revision
      ) {
        // Rolldown can coalesce marker events with the failing build. Keep signaling until
        // it acknowledges the revision event; never publish a mixed or stale build.
        updateWatchRevision(true);
        watchRetry ??= setInterval(() => {
          try {
            updateWatchRevision(true);
          } catch (error) {
            this.warn(error instanceof Error ? error : String(error));
          }
        }, 100);
        this.error(
          "Text catalog changed during compilation; waiting for the next watch build.",
        );
      }
    },
    closeWatcher() {
      clearInterval(watchRetry);
      watchRetry = undefined;
      for (const watcher of sourceWatchers.values()) watcher.close();
      sourceWatchers.clear();
    },
    async resolveId(source, importer) {
      if (mode !== "compiled" || source.includes("\0") || /[?#]/.test(source))
        return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved) return null;
      const file = canonicalFile(resolved.id);
      if (file === facadeFile) return compiledFacadeFile;
      if (file === frontendFile) return compiledFrontendFile;
      return resolved;
    },
    watchChange(id) {
      const file = canonicalFile(id);
      if (file === revisionFile) {
        clearInterval(watchRetry);
        watchRetry = undefined;
      }
      if (file === revisionFile || isCatalogInput(file)) markDirty();
    },
    async load(id) {
      if (
        canonicalFile(id) !== frontendFile &&
        canonicalFile(id) !== compiledFrontendFile
      )
        return null;
      const next = server
        ? await current()
        : (buildCatalog ?? (await current()));
      for (const file of server ? sourceFiles : dependencies)
        this.addWatchFile(file);
      return next.frontend;
    },
    async transform(source, id) {
      id = canonicalFile(id);
      if (id === frontendFile || id === compiledFrontendFile) {
        // Generated translations also depend on catalog inputs, despite being excluded from output watches.
        for (const file of server ? sourceFiles : dependencies)
          this.addWatchFile(file);
        return null;
      }
      if (mode === "runtime" || !isSource(id)) return null;
      const next = server
        ? await current()
        : (buildCatalog ?? (await current()));
      const result = await transformTextCatalog(
        source,
        id,
        next.snapshot,
        transformOptions((source, importer) =>
          this.resolve(source, importer, { skipSelf: true }),
        ),
      );
      if (result !== null) {
        // Rolldown 1.2 does not implement shouldTransformCachedModule. These transform dependencies
        // are its supported cache-invalidation seam, including currently empty/new/deleted paths.
        // Vite resolves transform watches as imports: directories/deleted files instead belong
        // to its server watcher, while Rolldown accepts them directly as transform dependencies.
        for (const file of server ? sourceFiles : dependencies)
          this.addWatchFile(file);
      }
      return result;
    },
    hotUpdate: {
      order: "pre",
      async handler(context) {
        const file = canonicalFile(context.file);
        if (isGenerated(file)) return [];
        if (isCatalogInput(file)) {
          markDirty();
          await refreshCatalog();
          return [];
        }
        if (
          mode === "compiled" &&
          isSource(file) &&
          file.endsWith(".vue") &&
          this.environment.name !== "client"
        ) {
          const environment = this.environment;
          if (!isRunnableDevEnvironment(environment)) return;
          await current();
          const active = environment.moduleGraph.idToModuleMap.size > 0;
          environment.moduleGraph.invalidateAll();
          if (active) environment.runner.clearCache();
          // Native Vue HMR owns the browser update. Local evaluated runners need fresh
          // exports, not HMR notifications that can share the browser's channel.
          return [];
        }
      },
    },
  };
}
