import { describe, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createRuntimeCatalog } from "../src/runtime/index.js";
import { createCompiledCatalog } from "../src/compiled/index.js";
import type { Translations } from "../src/types.js";

const catalog = {
  greeting: "Hello %{name}",
  html: "<strong>%{name}</strong>",
  "items.one": "%{n} item",
  "items.plural": "%{n} items",
} as const;
const catalogTranslations: Translations = {
  en_US: {},
  de_DE: {
    "Hello %{name}": { greeting: "Hallo %{name}" },
    "<strong>%{name}</strong>": { html: "<em>%{name}</em>" },
    "%{n} item": { items: ["%{n} Ding", "%{n} Dinge"] },
    "%{n} task": ["%{n} Aufgabe", "%{n} Aufgaben"],
  },
};
const options = {
  catalog,
  htmlTextKeys: ["html"] as const,
  catalogTranslations,
  sourceLocale: "en_US",
  locales: ["en_US", "de_DE"],
};

describe("runtime catalog", () => {
  it("supports dynamic and escaped lookups while rejecting unknown and invalid HTML/plural keys", () => {
    const copy = createRuntimeCatalog(options);
    const lookup = copy.text;
    const translate = copy.langText;
    let key: keyof typeof catalog = "greeting";
    expect(lookup(key)).toBe("Hello %{name}");
    expect(translate(key, { name: "Ada" })).toBe("Hello Ada");
    key = "html";
    expect(translate(key, { name: "Ada" })).toBe("<strong>Ada</strong>");
    expect(() => lookup("unknown" as never)).toThrow(/Unknown catalog key/);
    expect(() => translate("toString" as never)).toThrow(/Unknown catalog key/);
    expect(() => copy.langHtmlText("greeting")).toThrow(/not declared as HTML/);
    expect(() => copy.langHtmlText("html")).toThrow(/sanitizeHtml/);
    expect(() =>
      copy.langTextPlural("items.one", "other.plural" as never, 2),
    ).toThrow(/sibling/);
  });

  it("selects each invocation context and keeps source fallbacks local to each facade", () => {
    const copy = createRuntimeCatalog(options);
    const other = createRuntimeCatalog({ ...options, sourceLocale: "de_DE" });
    const app = createSSRApp({});
    const state = copy.createCatalog({ locale: "de_DE" });
    copy.installCatalog(app, state);
    const callback = app.runWithContext(
      () => () => copy.langText("greeting", { name: "Ada" }),
    );
    expect(app.runWithContext(callback)).toBe("Hallo Ada");
    expect(callback()).toBe("Hello Ada");
    expect(other.langText("greeting", { name: "Ada" })).toBe("Hallo Ada");
    state.gettext.current = "en_US";
    expect(app.runWithContext(callback)).toBe("Hello Ada");
    expect(other.langText("greeting", { name: "Ada" })).toBe("Hallo Ada");
    expect(createSSRApp({}).runWithContext(callback)).toBe("Hello Ada");
  });

  it("sanitizes translated interpolated HTML through the selected request, including globals", () => {
    const sanitize = vi.fn((html: string) => html.replaceAll(/<[^>]*>/gu, ""));
    const copy = createRuntimeCatalog(options);
    const app = createSSRApp({});
    copy.installCatalog(
      app,
      copy.createCatalog({ locale: "de_DE", sanitizeHtml: sanitize }),
    );
    expect(
      app.runWithContext(() =>
        copy.langHtmlText("html", { name: "<b>Ada</b>" }),
      ),
    ).toBe("Ada");
    expect(sanitize).toHaveBeenLastCalledWith("<em><b>Ada</b></em>");
    expect(
      app.config.globalProperties.$langHtmlText("html", { name: "Lin" }),
    ).toBe("Lin");
    expect(
      app.config.globalProperties.$langTextPlural(
        "items.one",
        "items.plural",
        2,
        { n: 2 },
      ),
    ).toBe("2 Dinge");
    expect(() => copy.langHtmlText("html")).toThrow(/sanitizeHtml/);
  });
});

describe("lookup-free compiled adapters", () => {
  it("isolates overlapping SSR renders and later requests", async () => {
    const copy = createCompiledCatalog(options);
    const barrier = Promise.withResolvers<void>();
    let started = 0;
    const label = defineComponent({
      async setup() {
        if (++started === 2) barrier.resolve();
        await barrier.promise;
        return () =>
          h("p", copy.pgettext("greeting", "Hello %{name}", { name: "Ada" }));
      },
    });
    const first = createSSRApp(label);
    const second = createSSRApp(label);
    copy.installCatalog(first, copy.createCatalog({ locale: "de_DE" }));
    copy.installCatalog(second, copy.createCatalog());
    expect(
      await Promise.all([renderToString(first), renderToString(second)]),
    ).toEqual(["<p>Hallo Ada</p>", "<p>Hello Ada</p>"]);
    const third = createSSRApp(label);
    copy.installCatalog(third, copy.createCatalog());
    expect(await renderToString(third)).toBe("<p>Hello Ada</p>");
    expect(copy.pgettext("greeting", "Hello %{name}", { name: "Ada" })).toBe(
      "Hello Ada",
    );
  });

  it("selects the translator after argument effects, not when callbacks are created", () => {
    const copy = createCompiledCatalog(options);
    const state = copy.createCatalog({ locale: "de_DE" });
    const app = createSSRApp({});
    copy.installCatalog(app, state);
    const gettext = state.gettext;
    const order: string[] = [];
    Object.defineProperty(state, "gettext", {
      get() {
        order.push("translator");
        return gettext;
      },
    });
    const run = app.runWithContext(
      () => () =>
        copy.pgettext("greeting", "Hello %{name}", {
          name: (() => {
            order.push("parameters");
            return "Ada";
          })(),
        }),
    );
    expect(app.runWithContext(run)).toBe("Hallo Ada");
    expect(order).toEqual(["parameters", "translator"]);
    expect(run()).toBe("Hello Ada");
    expect(createSSRApp({}).runWithContext(run)).toBe("Hello Ada");
  });

  it("clones contextual and context-free plural arrays for every app and later request", () => {
    const copy = createCompiledCatalog(options);
    const first = copy.createCatalog({ locale: "de_DE" });
    const second = copy.createCatalog({ locale: "de_DE" });
    const messages = first.gettext.translations.de_DE!;
    const forms = messages["%{n} item"];
    const tasks = messages["%{n} task"];
    if (
      !forms ||
      typeof forms === "string" ||
      Array.isArray(forms) ||
      !Array.isArray(forms.items) ||
      !Array.isArray(tasks)
    ) {
      throw new Error("Expected mutable gettext plural arrays.");
    }
    forms.items[1] = "%{n} changed";
    tasks[1] = "%{n} changed tasks";
    expect(
      first.gettext.$npgettext("items", "%{n} item", "%{n} items", 2, { n: 2 }),
    ).toBe("2 changed");
    expect(
      first.gettext.$ngettext("%{n} task", "%{n} tasks", 2, { n: 2 }),
    ).toBe("2 changed tasks");
    for (const state of [second, copy.createCatalog({ locale: "de_DE" })]) {
      expect(
        state.gettext.$npgettext("items", "%{n} item", "%{n} items", 2, {
          n: 2,
        }),
      ).toBe("2 Dinge");
      expect(
        state.gettext.$ngettext("%{n} task", "%{n} tasks", 2, { n: 2 }),
      ).toBe("2 Aufgaben");
    }
    expect(
      copy.npgettext("items", "%{n} item", "%{n} items", 2, { n: 2 }),
    ).toBe("2 items");
  });

  it("never allows unsanitized HTML, and fixes independent facade source fallbacks", () => {
    const copy = createCompiledCatalog(options);
    const german = createCompiledCatalog({ ...options, sourceLocale: "de_DE" });
    expect(() => copy.htmlPgettext("html", "<strong>%{name}</strong>")).toThrow(
      /sanitizeHtml/,
    );
    const app = createSSRApp({});
    copy.installCatalog(
      app,
      copy.createCatalog({
        sanitizeHtml: (html) => html.replaceAll(/<[^>]*>/gu, ""),
        locale: "de_DE",
      }),
    );
    expect(
      app.runWithContext(() =>
        copy.htmlPgettext("html", "<strong>%{name}</strong>", { name: "Ada" }),
      ),
    ).toBe("Ada");
    expect(() => copy.htmlPgettext("html", "<strong>Ada</strong>")).toThrow(
      /sanitizeHtml/,
    );
    expect(copy.pgettext("greeting", "Hello %{name}", { name: "Ada" })).toBe(
      "Hello Ada",
    );
    expect(german.pgettext("greeting", "Hello %{name}", { name: "Ada" })).toBe(
      "Hallo Ada",
    );
  });
});
