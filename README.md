# Text Catalog for Vue and Vite

`@lsr/text-catalog` supplies typed Vue/gettext helpers and a Vite plugin for NEON source-copy catalogs compiled by the independently versioned [PHP package](https://packagist.org/packages/lsr/text-catalog).

The behavioral reference is [code-hunt-game ADR 0007](https://github.com/eSoul-cz/code-hunt-game/blob/master/docs/adr/0007-neon-source-copy-catalog-with-gettext.md), reviewed at `4aa85bce33f6846c0213f62574e779040cd01d23`. The reference application was not modified. The shared [extraction record and release gates](https://github.com/Heroyt/lsr-text-catalog/blob/master/docs/extraction-plan.md) live in the PHP repository; no sibling file is required at runtime.

## Installation

Install from [npm](https://www.npmjs.com/package/@lsr/text-catalog) together with its Vue/gettext peers:

```sh
npm install @lsr/text-catalog vue vue3-gettext
```

For Vite integration, also install the host build tools:

```sh
npm install --save-dev vite @vitejs/plugin-vue typescript
```

Use the PHP compiler to generate or update catalog artifacts:

```sh
composer require lsr/text-catalog
```

Prebuilt frontend catalogs do not require PHP at runtime. Applications supply their own HTML sanitizer; no sanitizer package is installed automatically.

## Requirements and exports

Node `^20.19.0 || >=22.12.0`; ESM only. Host peers: Vue `^3.5.42` and vue3-gettext `^4.0.1`. `/vite` additionally needs Vite `^8.2.2` (an optional peer so prebuilt runtime consumers do not need Vite).

| Export | Responsibility |
| --- | --- |
| `@lsr/text-catalog/runtime` | `createRuntimeCatalog`: typed dynamic source lookup, contextual/plural translation and guarded HTML rendering. |
| `@lsr/text-catalog/compiled` | `createCompiledCatalog`: lookup-free contextual/plural/HTML adapters for transformed calls. |
| `@lsr/text-catalog/types` | Reusable catalog, translation, interpolation and instance types. Consumer-specific key unions are generated locally. |
| `@lsr/text-catalog/vite` | `textCatalog`: Node-only compiler orchestration, versioned artifact validation and literal transformation. |

Babel, Vue compilers, MagicString and TypeScript are direct dependencies because the shipped Node plugin executes them. Browser entry points do not import the Node plugin or its filesystem/compiler modules. PHP is needed only when the consumer's compiler callback invokes it, not to use prebuilt frontend data.

For local package development, build before linking a checkout with pnpm `link:`. Consumer applications should normally install a released npm version instead of a local link.

## Generate consumer-owned artifacts

Configure `Lsr\TextCatalog\TextCatalogCompiler` with explicit source/language directories, source-reference root, domain, locales, source locale, cache file, and frontend directory. Run it before standalone `tsc`/`vue-tsc` checks; Vite generation cannot supply types to a command that ran earlier.

The frontend directory contains `catalog.ts`, `catalog.compiled.ts`, and `catalog.build.json`. Generated files import this package's `/types` export, not application aliases. Keep these files in the consumer's normal TypeScript resolution graph.

## Runtime facade

Create a real consumer module such as `src/copy.ts`:

```ts
import * as generated from '../generated/catalog.js';
import { createRuntimeCatalog } from '@lsr/text-catalog/runtime';
import { sanitizeCopyHtml } from './sanitizeCopyHtml.js';

export const {
  text, langText, langTextPlural, langHtmlText, createCatalog, installCatalog,
} = createRuntimeCatalog({ ...generated, sanitizeHtml: sanitizeCopyHtml });
export type { TextKey, HtmlTextKey } from '../generated/catalog.js';
```

`sanitizeCopyHtml` is an application implementation, not a package export. Omit `sanitizeHtml` for plain-text-only consumers; HTML calls then throw rather than return raw markup.

Create and install a new instance for **each Vue app and SSR request**:

```ts
import { createSSRApp } from 'vue';
import App from './App.vue';
import { createCatalog, installCatalog } from './copy.js';

const app = createSSRApp(App);
const copy = createCatalog({ locale: 'cs_CZ' });
installCatalog(app, copy);
```

Use the same initial locale and sanitizer output policy during SSR and hydration. The instance exposes `gettext`; changing `copy.gettext.current` updates that instance. Each instance owns cloned nested translation/plural data. Consumer facades have distinct Vue injection keys. Helpers select the current app at invocation time; outside an injection context they use a private, fixed source-language fallback. For ordinary non-Vue code needing a selected locale, call the explicit instance's helpers instead of relying on ambient state.

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

## Vite configuration

```ts
import { execFileSync } from 'node:child_process';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { textCatalog } from '@lsr/text-catalog/vite';

export default defineConfig({
  plugins: [
    textCatalog({
      mode: 'runtime', // default; 'compiled' is explicit opt-in
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
});
```

Paths are relative to the configured Vite root (or explicit `root`) unless absolute. The callback may return a promise; the consumer owns its command, environment and bootstrap. Plugin and PHP identity/output configuration must agree. No game-specific command, domain, locale, alias or environment defaults are injected.

The plugin validates **artifact format 1**: identity, source/HTML/plural references, exact artifact-byte SHA-256 digests and the canonical generation digest. Missing/unknown formats, tampering and mixed generations fail before output is used. A successful compiler callback alone is not sufficient. Client, SSR and custom environments use the same validated generation, and stale in-flight generations are not published.

Development watches source and editable PO inputs, updates unchanged callers and evaluated SSR, and preserves ordinary Vue HMR. Build-watch mode handles nested input creation/deletion and recovery, including cleaned generated-output directories. Compilation failure blocks reads/builds until repaired; it does not silently serve the last good generation. Generated PO/output writes do not cause perpetual watch loops.

## Compiled mode

Add `src/copy.compiled.ts`:

```ts
import * as generated from '../generated/catalog.compiled.js';
import { createCompiledCatalog } from '@lsr/text-catalog/compiled';
import { sanitizeCopyHtml } from './sanitizeCopyHtml.js';

export const {
  pgettext, npgettext, htmlPgettext, createCatalog, installCatalog,
} = createCompiledCatalog({ ...generated, sanitizeHtml: sanitizeCopyHtml });
```

Keep authored imports pointed at `src/copy.ts`; set `mode: 'compiled'`. The plugin resolves the configured facade canonically through Vite, including aliases and symlinks, and redirects bootstrap/adapter imports to its compiled companion. It expands literal-key calls before Vue, without a runtime lookup-map fallback.

Compiled mode is deliberately stricter: dynamic keys, first-class helper escapes, unsupported import/SFC/macro forms, mismatched plurals and ineligible HTML calls are errors. Unrelated lexical bindings are not rewritten. Non-key argument evaluation order, source maps, contextual translation and interpolation are preserved. Generated compiled `text` is declaration-only and must not escape the transform into JavaScript execution.

Application sanitizers remain responsible for final-output safety in both modes, including SSR DOM lifetimes. This package does not import DOMPurify, jsdom, Inertia or the reference application's HTML policy.

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

The build emits ESM and declarations into `dist`; package exports point only at these files. `prepack` rebuilds them. The npm tarball also includes `src` so JavaScript and declaration source maps resolve to the original TypeScript. Tests cover runtime/request isolation, source-map and macro boundaries, manifest validation, real Vite client/SSR/custom-environment lifecycle and native build-watch behavior with synthetic inputs. The external-consumer gate additionally runs the actual PHP compiler and browser hydration in both modes.

During verification, Vite emitted an upstream browser-externalization warning for `fs` from `pofile 1.1.4`, a dependency of `vue3-gettext 4.0.1`. Both production modes and SSR hydration passed without browser console errors. The package's browser entries do not import its Node plugin; recheck the upstream warning when choosing release peer versions rather than suppressing it globally.

## License and maintenance

[MIT](LICENSE), copyright (c) 2026 Tomáš Vojík. Source and issue tracking: [Heroyt/lsr-text-catalog-js](https://github.com/Heroyt/lsr-text-catalog-js). npm releases are independent of PHP/Packagist releases and artifact format versions.

The manifest targets public publication on `https://registry.npmjs.org/`. Build and inspect the tarball with `npm pack` before a release; packing does not publish it. Registry scope ownership, credentials and release authorization are maintainer prerequisites. Current publication state and release gates are recorded in the [extraction record](https://github.com/Heroyt/lsr-text-catalog/blob/master/docs/extraction-plan.md).
