// @vitest-environment happy-dom

import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import * as serverRenderer from "@vue/server-renderer";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

import { createCompiledCatalog } from "../src/compiled/index.js";
const {
  createCatalog: createProductCopy,
  htmlPgettext,
  installCatalog: installProductCopy,
  npgettext,
  pgettext,
} = createCompiledCatalog({
  catalogTranslations: {},
  sourceLocale: "en_US",
  locales: ["en_US", "en", "de_DE"],
});
import { transformTextCatalog } from "../src/vite/transform.js";
import type { TextCatalogSnapshot } from "../src/vite/types.js";

const { createApp: createActualApp } = await vi.importActual<typeof Vue>("vue");

const root = "/project";
const difficult =
  "Quotes \" ' ` \\ &amp; &#160; <b>Unicode Žluťoučký 𐍈</b>\n</script> {{ inner }} ] = / %{name}\u2028\u2029";
const snapshot: TextCatalogSnapshot = {
  texts: {
    greeting: "Hello %{name}",
    other: "Hello %{name}",
    plain: "Plain source",
    difficult,
    html: "<strong>%{name}</strong>",
    "items.one": "%{n} item",
    "items.plural": "%{n} items",
    attribute: "data-label",
    sequence: "ab",
  },
  htmlKeys: { html: true },
  plurals: { items: { one: "items.one", plural: "items.plural" } },
};
const runtime = { pgettext, npgettext, htmlPgettext };
const transformOptions = {
  root,
  facade: "/project/src/copy.ts",
  resolveModule: (source: string): "copy" | "catalog" | undefined => {
    if (["#copy", "./copy", "/project/src/copy.ts"].includes(source))
      return "copy";
    if (["#catalog", "../generated/catalog.ts"].includes(source))
      return "catalog";
    return undefined;
  },
};

async function expand(source: string, id = `${root}/src/fixture.ts`) {
  const transformed = await transformTextCatalog(
    source,
    id,
    snapshot,
    transformOptions,
  );
  if (!transformed || typeof transformed === "string")
    throw new Error("Fixture did not produce a transform result");
  return transformed;
}

function evaluate<T>(source: string, extras: Record<string, unknown> = {}): T {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
    },
  });
  const module = { exports: {} };
  const modules: Record<string, unknown> = {
    vue: Vue,
    "@vue/server-renderer": serverRenderer,
    "vue/server-renderer": serverRenderer,
    "#copy": runtime,
    "/project/src/copy.ts": runtime,
    "./copy": runtime,
    "#catalog": {},
    "../generated/catalog.ts": {},
    ...extras,
  };
  new Function("require", "exports", "module", compiled.outputText)(
    (name: string) => {
      if (!Object.hasOwn(modules, name))
        throw new Error(`Unexpected runtime import: ${name}`);
      return modules[name];
    },
    module.exports,
    module,
  );
  // Fixtures control their exports; executing with macro-free modules proves no lookup survives.
  return module.exports as T;
}

async function component(source: string, ssr = false): Promise<Vue.Component> {
  const transformed = await expand(source, `${root}/src/Fixture.vue`);
  const { descriptor, errors } = parse(transformed.code);
  expect(errors).toEqual([]);
  let script = "const __component = {};";
  let bindings;
  if (descriptor.script || descriptor.scriptSetup) {
    const compiled = compileScript(descriptor, {
      id: "fixture",
      genDefaultAs: "__component",
    });
    script = compiled.content;
    bindings = compiled.bindings;
  }
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: "Fixture.vue",
    id: "fixture",
    ssr,
    compilerOptions: { bindingMetadata: bindings },
  });
  expect(template.errors).toEqual([]);
  const compiled = evaluate<{ default: Vue.Component }>(
    `${script}\n${template.code}\n__component.${ssr ? "ssrRender = ssrRender" : "render = render"};\nexport default __component;`,
  );
  return compiled.default;
}

function translatedCopy(sanitize?: (html: string) => string) {
  const copy = createProductCopy({ sanitizeHtml: sanitize });
  copy.gettext.available.en = "English";
  copy.gettext.translations = {
    en: {
      "Hello %{name}": {
        greeting: ["Welcome %{name}"],
        other: ["Goodbye %{name}"],
      },
      "%{n} item": { items: ["%{n} object", "%{n} objects"] },
      "<strong>%{name}</strong>": { html: ["<em>%{name}</em>"] },
    },
  };
  copy.gettext.current = "en";
  return copy;
}

describe("Text catalog source compiler", () => {
  it("resolves named aliases and relative imports without touching lexical shadows or unrelated helpers", async () => {
    const result = evaluate<{ values: string[] }>(
      (
        await expand(`
            import { text as sourceText } from '../generated/catalog.ts';
            import { langText as label } from './copy';
            import { text } from './unrelated';
            const nested = (sourceText: (key: string) => string) => sourceText('missing');
            export const values = [sourceText('plain'), label('greeting', { name: 'Ada' }), nested(key => 'local:' + key), text('missing')];
        `)
      ).code,
      { "./unrelated": { text: (key: string) => `other:${key}` } },
    );
    expect(result.values).toEqual([
      "Plain source",
      "Hello Ada",
      "local:missing",
      "other:missing",
    ]);
  });

  it("avoids generated adapter collisions even when identifiers use Unicode escapes", async () => {
    const result = evaluate<{ run: () => string }>(
      (
        await expand(`
            import { langText } from '#copy';
            export const run = () => {
                const \\u005f_textCatalog_pgettext_0 = () => 'wrong';
                return langText('plain');
            };
        `)
      ).code,
    );
    expect(result.run()).toBe("Plain source");
  });

  it("preserves namespace runtime members while removing only macro member calls", async () => {
    const result = evaluate<{ values: string[] }>(
      (
        await expand(`
            import * as copy from '#copy';
            import * as catalog from '#catalog';
            export const values = [catalog.text('plain'), copy.langText('greeting', { name: 'Ada' }), copy.pgettext('unused', 'Direct')];
        `)
      ).code,
    );
    expect(result.values).toEqual(["Plain source", "Hello Ada", "Direct"]);
  });

  it("preserves literal data exactly in scripts, including source-only interpolation placeholders", async () => {
    const result = evaluate<{ value: string }>(
      (
        await expand(
          `import { text } from '#catalog'; export const value = text('difficult');`,
        )
      ).code,
    );
    expect(result.value).toBe(difficult);
  });

  it("preserves per-call app selection, contextual identity, plural counts, and argument evaluation order", async () => {
    const app = Vue.createSSRApp({ render: () => null });
    const copy = translatedCopy();
    installProductCopy(app, copy);
    const result = evaluate<{
      run: (count: () => number, parameters: () => { n: number }) => string;
      singular: () => string[];
    }>(
      (
        await expand(`
            import { langText, langTextPlural } from '#copy';
            export const run = (count, parameters) => langTextPlural('items.one', 'items.plural', count(), parameters());
            export const singular = () => [langText('greeting', { name: 'Ada' }), langText('other', { name: 'Ada' })];
        `)
      ).code,
    );
    expect(app.runWithContext(result.singular)).toEqual([
      "Welcome Ada",
      "Goodbye Ada",
    ]);
    const calls: string[] = [];
    const value = app.runWithContext(() =>
      result.run(
        () => {
          calls.push("count");
          return 2;
        },
        () => {
          calls.push("parameters");
          return { n: 2 };
        },
      ),
    );
    expect(value).toBe("2 objects");
    expect(calls).toEqual(["count", "parameters"]);
    expect(result.singular()).toEqual(["Hello Ada", "Hello Ada"]);
    expect(
      app.runWithContext(() =>
        result.run(
          () => 1,
          () => ({ n: 1 }),
        ),
      ),
    ).toBe("1 object");
  });

  it("translates and interpolates HTML before selecting the app sanitizer", async () => {
    const sanitized: string[] = [];
    const copy = translatedCopy((html) => {
      sanitized.push(html);
      return html.replaceAll(/<\/?em>/gu, "");
    });
    const app = Vue.createSSRApp({ render: () => null });
    installProductCopy(app, copy);
    const result = evaluate<{ run: () => string }>(
      (
        await expand(
          `import { langHtmlText } from '#copy'; export const run = () => langHtmlText('html', { name: 'Ada' });`,
        )
      ).code,
    );
    expect(app.runWithContext(result.run)).toBe("Ada");
    expect(sanitized).toEqual(["<em>Ada</em>"]);
  });

  it("handles nested macro arguments once and chooses the translator after argument side effects", async () => {
    const copy = translatedCopy();
    const app = Vue.createSSRApp({ render: () => null });
    installProductCopy(app, copy);
    const result = evaluate<{ run: (change: () => object) => string }>(
      (
        await expand(`
            import { langText } from '#copy';
            export const run = change => langText('greeting', { ...change(), name: langText('plain') });
        `)
      ).code,
    );
    expect(
      app.runWithContext(() =>
        result.run(() => {
          copy.gettext.current = "de_DE";
          return {};
        }),
      ),
    ).toBe(snapshot.texts.greeting!.replace("%{name}", snapshot.texts.plain!));
  });

  it("keeps type-only macro references legal without creating runtime macro imports", async () => {
    const result = evaluate<{ value: string }>(
      (
        await expand(`
            import { langText } from '#copy';
            type Label = typeof langText;
            export type { langText };
            export const value = langText('plain');
        `)
      ).code,
    );
    expect(result.value).toBe("Plain source");
  });

  it.each(["js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx"])(
    "compiles the supported .%s source surface",
    async (extension) => {
      const code = (
        await expand(
          `import { text } from '#catalog'; export const value = text('plain');`,
          `${root}/file.${extension}`,
        )
      ).code;
      expect(evaluate<{ value: string }>(code).value).toBe("Plain source");
    },
  );

  it("preserves JSX expression semantics", async () => {
    const code = (
      await expand(
        `import { h } from 'vue'; import { text } from '#catalog'; export const node = <p>{text('plain')}</p>;`,
        `${root}/file.tsx`,
      )
    ).code;
    expect(evaluate<{ node: Vue.VNode }>(code).node.children).toBe(
      "Plain source",
    );
  });

  it("rejects JSX macro escapes instead of erasing their imports", async () => {
    await expect(
      expand(
        `import { langText as Label } from '#copy'; export const node = <Label />;`,
        `${root}/file.tsx`,
      ),
    ).rejects.toThrow(/must be called directly/u);
    await expect(
      expand(
        `import * as copy from '#copy'; export const node = <copy.langText />;`,
        `${root}/file.tsx`,
      ),
    ).rejects.toThrow(/namespace cannot escape/u);
  });

  it.each([
    "?raw",
    "?url",
    "?vue&type=script&lang.ts",
    "?vue&type=template",
    "?worker",
    "?commonjs-proxy",
  ])("does not process generated or asset requests (%s)", async (query) => {
    expect(
      await transformTextCatalog(
        `import { text } from '#catalog'; text(dynamic);`,
        `${root}/file.ts${query}`,
        snapshot,
        transformOptions,
      ),
    ).toBeNull();
  });

  it("leaves dependencies, virtual modules, styles and unrelated sources untouched", async () => {
    for (const id of [
      "/project/node_modules/lib/file.ts",
      "\0file.ts",
      "virtual:file.ts",
      "/project/style.css",
    ]) {
      expect(
        await transformTextCatalog(
          `import { text } from '#catalog'; text(dynamic);`,
          id,
          snapshot,
          transformOptions,
        ),
      ).toBeNull();
    }
    expect(
      await transformTextCatalog(
        "const text = value => value; text(dynamic)",
        `${root}/file.ts`,
        snapshot,
        transformOptions,
      ),
    ).toBeNull();
  });

  it("treats source lookup exported by the consumer facade as a macro too", async () => {
    const code = await expand(
      `import { text as source } from '#copy'; export const label = source('plain');`,
    );
    expect(evaluate<{ label: string }>(code.code).label).toBe("Plain source");
  });

  it.each([
    [`import { text } from '#catalog'; text(key)`, /literal catalog key/u],
    [
      `import { text } from '#catalog'; text('unknown')`,
      /Unknown catalog key/u,
    ],
    [
      `import { text } from '#catalog'; text('toString')`,
      /Unknown catalog key/u,
    ],
    [
      `import { langHtmlText } from '#copy'; langHtmlText('plain')`,
      /not declared as HTML/u,
    ],
    [
      `import { langTextPlural } from '#copy'; langTextPlural('items.one', 'plain', 2)`,
      /Unknown plural catalog pair/u,
    ],
    [
      `import { langTextPlural } from '#copy'; langTextPlural('items.one', key, 2)`,
      /two literal catalog keys/u,
    ],
    [
      `import { text } from '#catalog'; text('plain', sideEffect())`,
      /ordinary arguments/u,
    ],
    [`import { langText } from '#copy'; langText(...values)`, /spreads/u],
    [`import { langText } from '#copy'; langText?.('plain')`, /optionally/u],
    [
      `import { langText } from '#copy'; consume(langText)`,
      /must be called directly/u,
    ],
    [`import { langText } from '#copy'; new langText('plain')`, /constructed/u],
    [
      `import { langText } from '#copy'; langText<string>('plain')`,
      /generic calls/u,
    ],
    [
      `import * as copy from '#copy'; copy['langText']('plain')`,
      /Computed namespace/u,
    ],
    [
      `import * as copy from '#copy'; consume(copy)`,
      /namespace cannot escape/u,
    ],
    [`export { langText } from '#copy'`, /cannot be re-exported/u],
    [`export * from '#catalog'`, /Re-exporting/u],
    [`import { langText } from '#copy'; export { langText }`, /re-exported/u],
    [`const copy = require('#copy')`, /Dynamic import\/require/u],
  ])(
    "reports unsupported runtime macro usage (%s)",
    async (source, message) => {
      await expect(expand(source)).rejects.toThrow(message);
    },
  );

  it("maps untouched expressions and replacement literals to their actual original source locations", async () => {
    const source = `import { text } from '#catalog';\nexport const value = [text('difficult'),\n  missing()];`;
    const result = await expand(source);
    const map = new TraceMap(JSON.stringify(result.map));
    const position = (offset: number) => {
      const before = result.code.slice(0, offset);
      return {
        line: before.split("\n").length,
        column: offset - before.lastIndexOf("\n") - 1,
      };
    };
    expect(
      originalPositionFor(map, position(result.code.indexOf("missing()"))),
    ).toMatchObject({
      source: `${root}/src/fixture.ts`,
      line: 3,
      column: 2,
    });
    const emittedLiteral = result.code.indexOf('["') + 1;
    expect(originalPositionFor(map, position(emittedLiteral))).toMatchObject({
      line: 2,
      column: source.split("\n")[1]!.indexOf("text("),
    });
    expect(map.sourcesContent).toEqual([source]);
  });
});

describe("Text catalog Vue source compiler", () => {
  it.each([false, true])(
    "renders template-only imported helpers and both script blocks (SSR compiler: %s)",
    async (ssr) => {
      const compiled = await component(
        `<script>import { text } from '#catalog'; const moduleLabel = text('plain');</script>
            <script setup>import { langText as label } from '#copy'; const name = 'Ada';</script>
            <template><p>{{ moduleLabel }}|{{ label('greeting', { name }) }}|{{ $langText('other', { name }) }}</p></template>`,
        ssr,
      );
      const app = Vue.createSSRApp(compiled);
      installProductCopy(app, translatedCopy());
      expect(await serverRenderer.renderToString(app)).toBe(
        "<p>Plain source|Welcome Ada|Goodbye Ada</p>",
      );
    },
  );

  it.each([false, true])(
    "round-trips difficult strings in interpolation and both attribute quote styles (SSR compiler: %s)",
    async (ssr) => {
      const compiled = await component(
        `<script setup>import { text as source } from '#catalog';</script>
            <template><p :title="source('difficult')" :data-copy='source("difficult")'>{{ source('difficult') }}</p></template>`,
        ssr,
      );
      const html = await serverRenderer.renderToString(
        Vue.createSSRApp(compiled),
      );
      const holder = document.createElement("div");
      holder.innerHTML = html;
      expect(holder.querySelector("p")!.textContent).toBe(difficult);
      expect(holder.querySelector("p")!.getAttribute("title")).toBe(difficult);
      expect(holder.querySelector("p")!.getAttribute("data-copy")).toBe(
        difficult,
      );
    },
  );

  it("does not confuse native HTML tags with imported helper aliases", async () => {
    const compiled = await component(
      `<script setup>import { langText as label } from '#copy';</script><template><label>{{ label('plain') }}</label></template>`,
    );
    const app = Vue.createSSRApp(compiled);
    installProductCopy(app, translatedCopy());
    expect(await serverRenderer.renderToString(app)).toBe(
      "<label>Plain source</label>",
    );
  });

  it("preserves entity-decoded attribute arguments and nested replacements", async () => {
    const compiled =
      await component(`<script setup>import { langText as label } from '#copy';</script>
            <template><p :title="'A &amp; ' + label(&quot;greeting&quot;, { name: '&lt;Ada&gt;' })">{{ [1].map(label => label + 1)[0] }}</p></template>`);
    const app = Vue.createSSRApp(compiled);
    installProductCopy(app, translatedCopy());
    const holder = document.createElement("div");
    holder.innerHTML = await serverRenderer.renderToString(app);
    expect(holder.querySelector("p")!.getAttribute("title")).toBe(
      "A & Welcome <Ada>",
    );
    expect(holder.querySelector("p")!.textContent).toBe("2");
  });

  it("uses Vue loop RHS, destructuring, slot and arrow scopes instead of matching spellings", async () => {
    const compiled = await component(`<script setup>
            import { text as source } from '#catalog';
            import { h } from 'vue';
            const local = key => 'local:' + key;
            const Slot = (_, { slots }) => slots.default({ $langText: local });
            </script><template><section>
            <i v-for="source in source('sequence')">{{ source }}</i>
            <b v-for="{ $langText } in [{ $langText: local }]">{{ $langText('missing') }}</b>
            <Slot v-slot="{ $langText }"><em>{{ $langText('missing') }}</em></Slot>
            <strong>{{ [local].map($langText => $langText('missing'))[0] }}</strong>
            </section></template>`);
    const html = await serverRenderer.renderToString(
      Vue.createSSRApp(compiled),
    );
    const holder = document.createElement("div");
    holder.innerHTML = html;
    expect(
      [...holder.querySelectorAll("i")].map((element) => element.textContent),
    ).toEqual(["a", "b"]);
    expect(holder.querySelector("b")!.textContent).toBe("local:missing");
    expect(holder.querySelector("em")!.textContent).toBe("local:missing");
    expect(holder.querySelector("strong")!.textContent).toBe("local:missing");
  });

  it("preserves setup bindings that shadow template globals", async () => {
    const compiled = await component(`<script setup lang="ts">
            import { text } from '#catalog';
            const $langText = key => 'local-text:' + key;
            const $langHtmlText = key => 'local-html:' + key;
            </script><template><p>{{ text('plain') }}|{{ $langText('missing') }}|{{ $langHtmlText('missing') }}</p></template>`);
    const app = Vue.createSSRApp(compiled);
    expect(await serverRenderer.renderToString(app)).toBe(
      "<p>Plain source|local-text:missing|local-html:missing</p>",
    );
  });

  it("preserves normal-script props shadowing unexposed macro imports", async () => {
    const compiled = await component(`<script lang="ts">
            import { langText } from '#copy';
            export default { props: { langText: Function } };
            </script><template><p>{{ langText('missing') }}</p></template>`);
    const app = Vue.createSSRApp(compiled, {
      langText: (key: string) => "prop:" + key,
    });
    expect(await serverRenderer.renderToString(app)).toBe(
      "<p>prop:missing</p>",
    );
  });

  it("executes event statements and dynamic directive arguments without corrupting HTML grammar", async () => {
    const compiled =
      await component(`<script setup>import { text } from '#catalog'; defineProps(['record']);</script>
            <template><button :[text('attribute')]="text('plain')" @click="record($langText('greeting', { name: 'Ada' })); record($langText('other', { name: 'Ada' }))">Go</button></template>`);
    const observed: string[] = [];
    const app = createActualApp(compiled, {
      record: (value: string) => observed.push(value),
    });
    installProductCopy(app, translatedCopy());
    const holder = document.createElement("div");
    app.mount(holder);
    try {
      const button = holder.querySelector("button")!;
      expect(button.getAttribute("data-label")).toBe("Plain source");
      button.click();
      await Vue.nextTick();
      expect(observed).toEqual(["Welcome Ada", "Goodbye Ada"]);
    } finally {
      app.unmount();
    }
  });

  it("preserves anonymous function handlers and object-form listeners", async () => {
    const compiled =
      await component(`<script setup>import { text } from '#catalog'; defineProps(['record']);</script>
            <template><section>
            <button id="function" @click="function () { record(text('plain')) }">Function</button>
            <button id="object" v-on="{ click: () => record(text('other')), blur: () => record('blur') }">Object</button>
            </section></template>`);
    const observed: string[] = [];
    const app = createActualApp(compiled, {
      record: (value: string) => observed.push(value),
    });
    const holder = document.createElement("div");
    app.mount(holder);
    try {
      holder.querySelector<HTMLButtonElement>("#function")!.click();
      holder.querySelector<HTMLButtonElement>("#object")!.click();
      holder.querySelector("#object")!.dispatchEvent(new Event("blur"));
      expect(observed).toEqual(["Plain source", "Hello %{name}", "blur"]);
    } finally {
      app.unmount();
    }
  });

  it("passes the native inline event instead of resolving a same-named macro import", async () => {
    const compiled =
      await component(`<script setup>import { langText as $event } from '#copy'; defineProps(['record']);</script>
            <template><button @click="record($event)">Go</button></template>`);
    const record = vi.fn();
    const app = createActualApp(compiled, { record });
    const holder = document.createElement("div");
    app.mount(holder);
    try {
      holder.querySelector("button")!.click();
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]![0]).toBeInstanceOf(MouseEvent);
    } finally {
      app.unmount();
    }
  });

  it.each([
    '@click="() => record($event)"',
    'v-on="{ click: $event }"',
    '@click="$event"',
  ])(
    "does not introduce an event binding in expression-valued listeners (%s)",
    async (listener) => {
      await expect(
        expand(
          `<script setup>import { langText as $event } from '#copy'; defineProps(['record']);</script>
                <template><button ${listener}>Go</button></template>`,
          `${root}/Fixture.vue`,
        ),
      ).rejects.toThrow(/must be called directly/u);
    },
  );

  it("maps decoded interpolation entities around and inside macro calls", async () => {
    const compiled =
      await component(`<script setup>import { text } from '#catalog';</script>
            <template><p>{{ text(&quot;plain&quot;) }}|{{ '&amp;' + text('plain') }}</p></template>`);
    expect(
      await serverRenderer.renderToString(Vue.createSSRApp(compiled)),
    ).toBe("<p>Plain source|&amp;Plain source</p>");
  });

  it("preserves text versus attribute entity rules, partial entities and UTF-16 offsets", async () => {
    const compiled = await component(`<script setup>
            import { text } from '#catalog';
            import { langText as label } from '#copy';
            </script><template>
            <p :title="'&notit;|&amp=|&#x10348;|&NotEqualTilde;|' + label('greeting', { name: '&#x10348;' })">{{ '&notit;|&amp=|&#x10348;|&NotEqualTilde;|' + label(&quot;greeting&quot;, { name: '&#x10348;' }) }}|{{ &nbsptext('plain') }}</p>
            </template>`);
    const app = Vue.createSSRApp(compiled);
    installProductCopy(app, translatedCopy());
    const holder = document.createElement("div");
    holder.innerHTML = await serverRenderer.renderToString(app);
    expect(holder.querySelector("p")!.getAttribute("title")).toBe(
      "&notit;|&amp=|\u{10348}|\u2242\u0338|Welcome \u{10348}",
    );
    expect(holder.querySelector("p")!.textContent).toBe(
      "¬it;|&=|\u{10348}|\u2242\u0338|Welcome \u{10348}|Plain source",
    );
  });

  it("renders global plural and HTML calls through the installed app runtime", async () => {
    const compiled = await component(
      `<template><section><p>{{ $langTextPlural('items.one', 'items.plural', 3, { n: 3 }) }}</p><div v-html="$langHtmlText('html', { name: 'Ada' })" /></section></template>`,
    );
    const app = Vue.createSSRApp(compiled);
    installProductCopy(
      app,
      translatedCopy((html) => html.replaceAll("em", "strong")),
    );
    expect(await serverRenderer.renderToString(app)).toBe(
      "<section><p>3 objects</p><div><strong>Ada</strong></div></section>",
    );
  });

  it.each([
    [
      `<template><p>{{ $langText(key) }}</p></template>`,
      /literal catalog key/u,
    ],
    [
      `<script setup>import { langText as label } from '#copy';</script><template><button @click="label" /></template>`,
      /must be called directly/u,
    ],
    [
      `<script setup>import { langText as label } from '#copy';</script><template><button @click="label = () => 'wrong'" /></template>`,
      /cannot be assigned/u,
    ],
    [
      `<script setup>import { langText as label } from '#copy';</script><template><p :label /></template>`,
      /v-bind shorthand/u,
    ],
    [
      `<script setup>import { langText as Label } from '#copy';</script><template><Label /></template>`,
      /components or directives/u,
    ],
    [
      `<script setup>import { langText } from '#copy';</script><template lang="pug">p=langText('plain')</template>`,
      /preprocessed/u,
    ],
    [
      `<script src="./external.ts"/><template>{{ $langText('plain') }}</template>`,
      /external/u,
    ],
    [
      `<script setup>import { langText } from '#copy';</script><template src="./external.html"/>`,
      /external/u,
    ],
    [
      `<script lang="coffee">import { langText } from '#copy'</script><template><p/></template>`,
      /preprocessed/u,
    ],
    [
      `<script setup>import { langText } from '#copy';</script><custom>langText('plain')</custom><template><p/></template>`,
      /custom SFC blocks/u,
    ],
  ])("diagnoses unsupported SFC macro usage (%s)", async (source, message) => {
    await expect(expand(source, `${root}/Fixture.vue`)).rejects.toThrow(
      message,
    );
  });
});
