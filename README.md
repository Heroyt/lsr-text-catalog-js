# Text Catalog for Vue and Vite

`lsr-text-catalog` supplies typed Vue/gettext helpers and a Vite plugin for NEON source-copy catalogs compiled by the independently versioned [PHP package](https://packagist.org/packages/lsr/text-catalog).

## Installation

Install from [npm](https://www.npmjs.com/package/lsr-text-catalog) together with its Vue/gettext peers:

```sh
npm install lsr-text-catalog vue vue3-gettext
```

For Vite integration, also install the host build tools:

```sh
npm install --save-dev vite @vitejs/plugin-vue typescript
```

Use the PHP compiler to generate or update catalog artifacts:

```sh
composer require lsr/text-catalog:^0.3
```

npm `0.2` reads only artifact format 2, produced by PHP compiler `0.3`; upgrade both together and regenerate (see [Upgrading from 0.1](#upgrading-from-01-artifact-format-1)). Do not hand-edit generated files.

Prebuilt frontend catalogs do not require PHP at runtime. Applications supply their own HTML sanitizer; no sanitizer package is installed automatically.

## Requirements and exports

Node `^20.19.0 || >=22.12.0`; ESM only. Host peers: Vue `^3.5.42` and vue3-gettext `^4.0.1`. `/vite` additionally needs Vite `^8.2.2` (an optional peer so prebuilt runtime consumers do not need Vite).

| Export | Responsibility |
| --- | --- |
| `lsr-text-catalog/runtime` | `createRuntimeCatalog`: typed dynamic source lookup, contextual/plural translation and guarded HTML rendering. |
| `lsr-text-catalog/compiled` | `createCompiledCatalog`: lookup-free contextual/plural/HTML adapters for transformed calls. |
| `lsr-text-catalog/types` | Reusable catalog, translation, interpolation and instance types. Consumer-specific key unions are generated locally. |
| `lsr-text-catalog/preload` | `catalogPreloadFiles`: build files to `<link rel="modulepreload">` for the groups an SSR render used. |
| `lsr-text-catalog/vite` | `textCatalog`: Node-only compiler orchestration, versioned artifact validation and literal transformation. |

Babel, Vue compilers, MagicString and TypeScript are direct dependencies because the shipped Node plugin executes them. Browser entry points do not import the Node plugin or its filesystem/compiler modules. PHP is needed only when the consumer's compiler callback invokes it, not to use prebuilt frontend data.

For local package development, build before linking a checkout with pnpm `link:`. Consumer applications should normally install a released npm version instead of a local link.

## Generate consumer-owned artifacts

Configure `Lsr\TextCatalog\TextCatalogCompiler` with explicit source/language directories, source-reference root, domain, locales, source locale, cache file, and frontend directory. Run it before standalone `tsc`/`vue-tsc` checks; Vite generation cannot supply types to a command that ran earlier.

The frontend directory contains `catalog.ts`, `catalog.compiled.ts`, `catalog.build.json` and a `texts/` directory with one lazily imported module per **group** (root catalog key) and locale: `texts/<group>.ts` holds the group's source copy (runtime mode only) and `texts/<group>.<locale>.ts` its translations for each non-source locale. The source locale ships no translation data: its gettext msgid already is the source text. Generated files import this package's `/types` export, not application aliases. Keep these files in the consumer's normal TypeScript resolution graph.

## Runtime facade

Create a real consumer module such as `src/copy.ts`:

```ts
import * as generated from '../generated/catalog.js';
import { createRuntimeCatalog } from 'lsr-text-catalog/runtime';
import { sanitizeCopyHtml } from './sanitizeCopyHtml.js';

export const {
  text, langText, langTextPlural, langHtmlText, createCatalog, installCatalog, loadTexts, loadLocale,
} = createRuntimeCatalog({ ...generated, sanitizeHtml: sanitizeCopyHtml });
export type { TextKey, HtmlTextKey, TextGroup } from '../generated/catalog.js';
```

`sanitizeCopyHtml` is an application implementation, not a package export. Omit `sanitizeHtml` for plain-text-only consumers; HTML calls then throw rather than return raw markup.

Create and install a new instance for **each Vue app and SSR request**, after loading its locale:

```ts
import { createSSRApp } from 'vue';
import App from './App.vue';
import { createCatalog, installCatalog, loadLocale } from './copy.js';

await loadLocale('cs_CZ');
const app = createSSRApp(App);
const copy = createCatalog({ locale: 'cs_CZ' });
installCatalog(app, copy);
```

Use the same initial locale and sanitizer output policy during SSR and hydration. The instance exposes `gettext`; switch its locale with `await copy.setLocale(locale)`, which loads the locale's required groups before changing `gettext.current`. Each instance owns cloned nested translation/plural data. Consumer facades have distinct Vue injection keys. Helpers select the current app at invocation time; outside an injection context they use a private, fixed source-language fallback. For ordinary non-Vue code needing a selected locale, call the explicit instance's helpers instead of relying on ambient state.

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import { langText, langTextPlural, langHtmlText } from './copy.js';

const count = ref(3);
const label = computed(() => langText('example.title', { name: 'Ada' }));
</script>

<template>
  <h1>{{ label }}</h1>
  <p>{{ langTextPlural('example.count.one', 'example.count.plural', count, { count }) }}</p>
  <div v-html="langHtmlText('example.rich', { name: 'Ada' })" />
</template>
```

`text(key)` returns canonical source text without translating/interpolating. Runtime mode accepts typed dynamic keys. Plural helpers require sibling `.one`/`.plural` entries and use their parent as gettext context. Plain text uses ordinary escaped Vue rendering. `langHtmlText` validates HTML membership at runtime, translates/interpolates, and then sanitizes. A generated `HtmlTextKey` union is available to type stricter application wrappers.

## Lazy groups and locales

Catalog data is loaded per group and locale, on demand, by the facade shared by all its apps/requests:

- `loadTexts(groups?)` requires groups (all when omitted) and loads them for every activated locale; runtime facades also load the groups' source copy.
- `loadLocale(locale)` activates a locale and loads every required group for it. The source locale needs no data. `createCatalog({ locale })` also activates its locale, but cannot wait for it. Locales are typed from the generated `locales` tuple.
- `copy.setLocale(locale)` loads, then switches; when calls overlap, the latest one wins. A locale no live instance displays any more is deactivated, so later lazily loaded groups stop fetching it.
- Each instance copies only the locales it displays; groups loaded later are merged into instances holding that locale, and only renders reading the new messages update.
- Concurrent calls share one import per group/locale. A failed import rejects the call and is retried by the next one; using a key whose load failed throws with that failure as `cause` and retries in the background.
- SSR instances are held weakly and released with their request.

Missing data never falls back silently: using a key whose group is not loaded for the instance's current locale throws. In **compiled mode** this is automatic: each transformed module imports `virtual:lsr-text-catalog/group/<group>` for the groups it translates, and that module top-level-awaits `loadTexts([group])` before the importer runs. Bundlers then place every group's translations in its own chunk next to the pages using it, and only the active locale's chunks are fetched. Await `loadLocale(locale)` before rendering (on the client before resolving the first page, during SSR per request locale). A catalog whose only locale is the source locale needs no data in compiled mode: no group imports are emitted and no `loadTexts`/`loadLocale` calls are required. The barrier covers configured locales only; a locale an application installs on `gettext` itself, with its own translations, passes through.

In **runtime mode** with the Vite plugin, loading is implicit too: every source module containing a string literal equal to a catalog key (a direct call or a finite key map such as `{ cart: 'shop.cart' }`) imports that key's group module, which loads its source copy and translations before the module runs; calls stay dynamic and unrewritten. Only keys assembled at run time (for example `` `shop.${name}` ``) need an explicit `await loadTexts(['shop'])`; without the plugin (prebuilt data), call `loadTexts()` yourself. Group modules load through the package with the generated `catalogGroups` object, so facades need not export `loadTexts`; pass `catalogGroups` through from the generated module (`{ ...generated }`).

Group modules never reject (a rejected top-level await would fail the importing page module for good); a failure surfaces as the `cause` of the "not loaded" error, and that use retries the load. In production bundles the modules of one chunk run one after another, so the plugin hands every group module the full group list of its chunk: the first one starts all of them in parallel.

### Preloading

Translation modules are otherwise requested only once the page module runs. To fetch them alongside the page, preload the groups an SSR render used:

```ts
import { readFileSync } from 'node:fs';
import { catalogPreloadFiles } from 'lsr-text-catalog/preload';

// Emitted by the plugin into the client build: build files per group and locale.
const preloadManifest = JSON.parse(readFileSync('build/.vite/text-catalog.json', 'utf8'));

// After rendering with `copy` (one instance per request):
const links = catalogPreloadFiles(preloadManifest, copy.usedGroups(), locale)
  .map((file) => `<link rel="modulepreload" href="/build/${file}">`);
```

`usedGroups()` lists the groups an instance rendered. In compiled mode, source-locale renders need no files.

### Disabling splitting

The Vite plugin's `split` option turns either dimension off; both default to `true`:

```ts
textCatalog({
  // ...
  split: { groups: false, locales: true },
});
```

| `split` | Delivered as | Effect |
| --- | --- | --- |
| `{ groups: true, locales: true }` | one module per group and locale | Pages fetch only their groups in the active locale. |
| `{ groups: false }` | one module per locale (all groups) | The first translated page fetches every group of the locale; later pages fetch nothing. |
| `{ locales: false }` | one module per group (all locales) | `setLocale` to any locale fetches nothing for already loaded groups. |
| `{ groups: false, locales: false }` | one module with everything | A single translation request. |

The plugin resolves the generated loaders of one bundle to a single module and chunk, so the loading API is unchanged: loading any member stores every group/locale the bundle carries. Runtime-mode source copy is bundled per group (`locales: false`) or as one module (`groups: false`). With `groups: false`, `await loadTexts()` during bootstrap fetches the locale's translations before the first page instead of while importing it.

## Vite configuration

```ts
import { execFileSync } from 'node:child_process';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { textCatalog } from 'lsr-text-catalog/vite';

export default defineConfig(({ command }) => ({
  plugins: [
    textCatalog({
      // Runtime (the default) for development; compiled, automatically split groups for production.
      mode: command === 'build' ? 'compiled' : 'runtime',
      sourceDirectory: 'copy',
      languageDirectory: 'languages',
      frontendDirectory: 'generated',
      facade: 'src/copy.ts',
      compiledFacade: 'src/copy.compiled.ts',
      domain: 'example',
      sourceLocale: 'en_US',
      locales: ['en_US', 'cs_CZ'],
      compile(root) {
        execFileSync('php', ['compile.php'], { cwd: root, stdio: 'inherit' });
      },
    }),
    vue(),
  ],
}));
```

Paths are relative to the configured Vite root (or explicit `root`) unless absolute. The callback may return a promise; the consumer owns its command, environment and bootstrap. Plugin and PHP identity/output configuration must agree. No application-specific command, domain, locale, alias or environment defaults are injected.

The plugin validates **artifact format 2**: identity, source/HTML/plural references, the exact group/locale module set, exact artifact-byte SHA-256 digests and the canonical generation digest. Missing/unknown formats, tampering and mixed generations fail before output is used. A successful compiler callback alone is not sufficient. Client, SSR and custom environments use the same validated generation, and stale in-flight generations are not published. Generated `texts/` modules are served from that validated generation; files outside it are rejected.

Development watches source and editable PO inputs, updates unchanged callers and evaluated SSR, and preserves ordinary Vue HMR. Build-watch mode handles nested input creation/deletion and recovery, including cleaned generated-output directories. Compilation failure blocks reads/builds until repaired; it does not silently serve the last good generation. Generated PO/output writes do not cause perpetual watch loops.

## Compiled mode

Add `src/copy.compiled.ts`:

```ts
import * as generated from '../generated/catalog.compiled.js';
import { createCompiledCatalog } from 'lsr-text-catalog/compiled';
import { sanitizeCopyHtml } from './sanitizeCopyHtml.js';

export const {
  pgettext, npgettext, htmlPgettext, createCatalog, installCatalog, loadTexts, loadLocale,
} = createCompiledCatalog({ ...generated, sanitizeHtml: sanitizeCopyHtml });
```

Keep authored imports pointed at `src/copy.ts`; set `mode: 'compiled'`. The plugin resolves the configured facade canonically through Vite, including aliases and symlinks, and redirects bootstrap/adapter imports to its compiled companion. It expands literal-key calls before Vue, without a runtime lookup-map fallback.

Compiled mode is deliberately stricter: dynamic keys, first-class helper escapes, unsupported import/SFC/macro forms, mismatched plurals and ineligible HTML calls are errors. Unrelated lexical bindings are not rewritten. Non-key argument evaluation order, source maps, contextual translation and interpolation are preserved. Generated compiled `text` is declaration-only and must not escape the transform into JavaScript execution.

For selective merging beyond the plugin's `split` option, group the generated modules with Rolldown code splitting, for example one chunk per locale for the `admin` and `settings` groups (Rolldown keeps a tiny re-export chunk per merged module):

```ts
build: {
  rolldownOptions: {
    output: {
      codeSplitting: {
        groups: [{
          name: (id) => `texts-admin-${id.match(/\.([^.]+)\.ts$/)![1]}`,
          test: /\/generated\/texts\/(admin|settings)\.[^.]+\.ts$/,
        }],
      },
    },
  },
},
```

Application sanitizers remain responsible for final-output safety in both modes, including SSR DOM lifetimes. This package does not import DOMPurify, jsdom or Inertia and supplies no application-specific HTML policy.

## Upgrading from 0.1 (artifact format 1)

npm `0.2` with PHP `0.3` split the catalog into lazily loaded group/locale modules. Applications whose only locale is the source locale (and that use the Vite plugin) usually need no code changes.

1. Upgrade `lsr-text-catalog` to `^0.2` and `lsr/text-catalog` to `^0.3` together; each rejects the other's previous artifact format. PHP `0.2` already changed `TextTranslator` to take an `lsr/translations` `MessageTranslator`.
2. Regenerate the catalog before standalone type checks. The frontend directory gains `texts/`; commit it if generated files are committed.
3. Facades created from `{ ...generated }` keep working. Export `loadTexts`/`loadLocale` where the application calls them. The generated `catalog.ts` no longer exports `catalog`, `catalogTranslations` or `text()`: use the facade's `text`.
4. With a non-source locale: `await loadLocale(locale)` before the first render (client: before resolving the first page; SSR: per request), and switch with `await copy.setLocale(locale)` instead of assigning `gettext.current`.
5. Runtime mode: literal keys load implicitly through the plugin; keys assembled at run time need `await loadTexts([...groups])`, and prebuilt consumers without the plugin call `loadTexts()`.
6. Compiled builds with non-source locales use top-level await: keep the default Vite 8 `build.target` or another target supporting it.
7. Optional: `split` to bundle groups/locales, and [preloading](#preloading) after SSR.

Verify by compiling, type checking, running tests and building client and SSR; for multiple locales also switch languages in a browser and check that a page fetches only its groups' chunks.

## Development

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
pnpm run format:check
pnpm run format
npm pack --dry-run --ignore-scripts --json
```

The build emits ESM and declarations into `dist`; package exports point only at these files. `prepack` rebuilds them. The npm tarball also includes `src` so JavaScript and declaration source maps resolve to the original TypeScript. Tests cover runtime/request isolation, source-map and macro boundaries, manifest validation, real Vite client/SSR/custom-environment lifecycle and native build-watch behavior with synthetic inputs. Consumer verification should additionally exercise the actual PHP compiler and browser hydration in each supported mode.

During verification, Vite emitted an upstream browser-externalization warning for `fs` from `pofile 1.1.4`, a dependency of `vue3-gettext 4.0.1`. Both production modes and SSR hydration passed without browser console errors. The package's browser entries do not import its Node plugin; recheck the upstream warning when choosing release peer versions rather than suppressing it globally.

## Agent skill

Use the [lsr-text-catalog skill](https://github.com/Heroyt/lsr-skills/tree/master/skills/lsr-text-catalog) for generated artifacts, runtime/compiled mode selection, per-app/SSR catalog instances and application-owned sanitization.

```sh
npx skills add Heroyt/lsr-skills --skill lsr-text-catalog
```

The skill is guidance, not a runtime dependency; installing it does not install or publish either package.

## License and maintenance

[MIT](LICENSE), copyright (c) 2026 Tomáš Vojík. Source and issue tracking: [Heroyt/lsr-text-catalog-js](https://github.com/Heroyt/lsr-text-catalog-js). npm releases are independent of PHP/Packagist releases and artifact format versions.

The manifest targets public publication on `https://registry.npmjs.org/`. Build and inspect the tarball with `npm pack` before a release; packing or creating a Git tag does not publish it. Publishing credentials and release authorization are maintainer prerequisites.
