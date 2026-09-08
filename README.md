# Text Catalog JavaScript — skeleton only

Candidate package: `@lsr/text-catalog`. This private ESM directory is preparation only: no source has been extracted, and no runtime, plugin, authoring types, build, or tests are available today. Version `0.0.0` is not a release. The empty `src/runtime/`, `src/compiled/`, `src/vite/`, and `tests/` locations contain only `.gitkeep` files. There are deliberately no executable entry points, export mappings, scripts, or dependency declarations yet.

The read-only reference is [eSoul-cz/code-hunt-game](https://github.com/eSoul-cz/code-hunt-game), particularly [ADR 0007: NEON source-copy catalog with gettext](https://github.com/eSoul-cz/code-hunt-game/blob/master/docs/adr/0007-neon-source-copy-catalog-with-gettext.md). The single shared [extraction plan](https://github.com/Heroyt/lsr-text-catalog/blob/master/docs/extraction-plan.md) owns the migration and acceptance specification; this README only describes the npm skeleton and its intended boundary. In the workspace, the plan is at `../lsr-text-catalog/docs/extraction-plan.md`. The PHP package is independently versioned, not an npm dependency.

## Tentative future surfaces — not implemented

- `/vite`: Node-only Vite lifecycle, catalog compilation orchestration, snapshot validation, and source transformation. Keep Node filesystem/process APIs and compiler dependencies out of browser entry graphs. The reference defaults to runtime mode; compiled mode is explicit and transforms before Vue.
- `/runtime`: Vue/gettext integration with typed dynamic catalog lookup, plural helpers, and HTML helpers.
- `/compiled`: lookup-free gettext/HTML adapters used by transformed literal-key calls, not a dynamic-lookup fallback.
- Authoring-type exports (candidate `/types`, name undecided): types without importing the Node plugin or a full runtime lookup table. Application-specific generated keys/catalog data remain supplied by the consuming application.

These names are design candidates, not importable APIs. The inspected `vite/textCatalogTypes.ts` defines a build-only snapshot of texts, HTML membership, and plural pairs plus transform root options; it is not an existing published authoring-types entry point.

Every app/SSR request must own its mutable gettext state, including nested translation/plural arrays. A fixed source-language fallback must not expose shared mutable application state. Language configuration, generated catalog wiring, and canonical facade locations are application concerns, not hard-coded package defaults.

HTML translation and interpolation must be followed by an **application-supplied sanitizer**, including a request-owned DOM adapter where SSR needs one. Never supply a no-op sanitizer or import the reference application's sanitizer/aliases as library defaults. The PHP compilation command must likewise be supplied through an explicit integration seam rather than retaining the reference application's CLI path or environment defaults.

## Dependency intent and source evidence

No dependencies are needed by these empty directories. Before implementation, classify actual imports and verify supported ranges rather than copying the application's manifest. Versions below are **reference manifest observations, not verified compatibility promises or selected package constraints**.

| Intended role | Evidence in the reference checkout | Observed versions / extraction decision |
| --- | --- | --- |
| Direct dependencies of the shipped Node plugin | `vite/textCatalog.ts` imports `zod`; `vite/textCatalogTransform.ts` imports `@babel/parser`, `@babel/traverse`, `@babel/types`, `@vue/compiler-dom`, `magic-string`, and `typescript` as values | Zod `4.4.3`; Babel packages `^7.29.8`; compiler-dom `^3.5.42`; magic-string `^0.30.21`; TypeScript `^6.0.3`. Although several are app dev dependencies, a shipped plugin needs them at execution time, not solely as package dev dependencies. |
| Host peer for `/vite` | `vite/textCatalog.ts` imports Vite functions and types; transform imports `TransformResult` as a type | Vite `^8.2.2`. Establish a tested peer range and Node engine floor; no browser runtime should require Vite. Whether to mark the Vite peer optional must be decided with entry-point isolation tests, not assumed today. |
| Host/runtime peers for Vue adapters | `assets/js/productCopy.ts` and `productCopyCompiled.ts` import Vue; `productCopyLanguage.ts` imports `createGettext` from `vue3-gettext`; transform also imports `vue/compiler-sfc` | Vue `^3.5.42`, vue3-gettext `^4.0.1`. Prefer host peers to avoid duplicate Vue/gettext state; validate compiler-dom/compiler-sfc compatibility and which peers are needed by each surface. |
| Package development tooling | Reference `package.json` provides TypeScript, Vitest, `@types/node`, and `@types/babel__traverse` | TypeScript `^6.0.3`, Vitest `^4.1.11`, Node types `^26.4.1`, Babel traverse types `^7.28.0`. TypeScript has a separate direct-plugin role above. Node type versions do not establish a supported Node runtime. Add build/typecheck/test tools only alongside real implementation/configuration. |
| App-owned sanitizer/SSR adapters, not core package dependencies | `assets/js/lib/productCopyHtml.ts` imports DOMPurify and accepts a `WindowLike`; runtime/compiled facades accept a sanitizer callback | DOMPurify `^3.4.14`; the app also declares jsdom `^30.0.1`. Do not import its DOM policy, make jsdom a browser dependency, or promise an optional bundled adapter. Applications own the sanitizer and SSR DOM lifecycle. |

`node:*` imports are platform APIs, not npm dependencies. The reference's `@text-catalog` and `@/…` imports are application/generated aliases, not registry packages. Inertia, UI libraries, Tailwind, application Vite plugins, and the rest of the app dependency tree are outside this package boundary.

## Release gates

Keep `private: true` and `UNLICENSED` until extraction permission and licensing are explicitly approved: the reference application is proprietary, and neighboring MIT licenses do not grant rights to its source. No source or license text has been copied here. Registry scope ownership, final name, supported versions, implementations, export/build artifacts, and package/consumer verification must be confirmed before a separately authorized release. The user initialized this Git repository with origin [Heroyt/lsr-text-catalog-js](https://github.com/Heroyt/lsr-text-catalog-js); the manifest records that identity. No publish configuration, lockfile, installation, or release is established by this skeleton.
