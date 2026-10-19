import { describe, expect, it, vi } from "vitest";
import { computed, createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import {
  createRuntimeCatalog,
  loadCatalogGroups,
} from "../src/runtime/index.js";
import { createCompiledCatalog } from "../src/compiled/index.js";
import type {
  CatalogMessages,
  CatalogSourceTexts,
  RuntimeCatalogGroups,
} from "../src/types.js";

// Generated source modules store keys relative to their group.
const sources = {
  common: { greeting: "Hello %{name}", html: "<strong>%{name}</strong>" },
  items: { one: "%{n} item", plural: "%{n} items" },
} satisfies Record<string, CatalogSourceTexts>;
const german = {
  common: {
    "Hello %{name}": { "common.greeting": "Hallo %{name}" },
    "<strong>%{name}</strong>": { "common.html": "<em>%{name}</em>" },
  },
  items: {
    "%{n} item": { items: ["%{n} Ding", "%{n} Dinge"] },
    "%{n} task": ["%{n} Aufgabe", "%{n} Aufgaben"],
  },
} satisfies Record<string, CatalogMessages>;

/** Fresh loaders per facade, recording every module import; `gates` hold a load open. */
function fixture() {
  const loads: string[] = [];
  const failures = new Set<string>();
  const gates = new Map<string, Promise<void>>();
  function loader<T>(id: string, data: T) {
    return async () => {
      loads.push(id);
      await (gates.get(id) ?? Promise.resolve());
      if (failures.delete(id)) throw new Error(`network: ${id}`);
      return { default: data };
    };
  }
  const catalogGroups = {
    common: {
      source: loader("common", sources.common),
      translations: { de_DE: loader("common.de_DE", german.common) },
    },
    items: {
      source: loader("items", sources.items),
      translations: { de_DE: loader("items.de_DE", german.items) },
    },
  } satisfies RuntimeCatalogGroups<"common" | "items">;
  type Key =
    | `common.${keyof typeof sources.common}`
    | `items.${keyof typeof sources.items}`;
  const options = {
    catalogGroups,
    htmlTextKeys: ["common.html"] as readonly Key[],
    sourceLocale: "en_US",
    locales: ["en_US", "de_DE"],
  };
  return { loads, failures, gates, options };
}

describe("runtime catalog", () => {
  it("loads source copy per group and rejects keys of unloaded groups instead of falling back", async () => {
    const { loads, options } = fixture();
    const copy = createRuntimeCatalog(options);
    expect(() => copy.text("common.greeting")).toThrow(
      /group "common" source copy is not loaded/,
    );
    await copy.loadTexts(["common"]);
    expect(loads).toEqual(["common"]);
    let key: "common.greeting" | "common.html" = "common.greeting";
    expect(copy.text(key)).toBe("Hello %{name}");
    expect(copy.langText(key, { name: "Ada" })).toBe("Hello Ada");
    key = "common.html";
    expect(copy.langText(key, { name: "Ada" })).toBe("<strong>Ada</strong>");
    expect(() => copy.langText("items.one")).toThrow(/"items" source copy/);
    expect(() => copy.text("unknown" as never)).toThrow(/Unknown catalog key/);
    expect(() => copy.text("common.toString" as never)).toThrow(
      /Unknown catalog key/,
    );
    expect(() => copy.langHtmlText("common.greeting")).toThrow(
      /not declared as HTML/,
    );
    expect(() => copy.langHtmlText("common.html")).toThrow(/sanitizeHtml/);
    expect(() =>
      copy.langTextPlural("items.one", "other.plural" as never, 2),
    ).toThrow(/sibling/);
    await expect(copy.loadTexts(["unknown" as never])).rejects.toThrow(
      /Unknown catalog group/,
    );
  });

  it("loads only activated non-source locales, once, and pushes later groups into live apps", async () => {
    const { loads, options } = fixture();
    const copy = createRuntimeCatalog(options);
    await copy.loadTexts(["common"]);
    // The source locale never downloads translations.
    await copy.loadLocale("en_US");
    expect(loads).toEqual(["common"]);
    const state = copy.createCatalog({ locale: "de_DE" });
    expect(() => state.langText("common.greeting", { name: "Ada" })).toThrow(
      /group "common" is not loaded for locale "de_DE"/,
    );
    await Promise.all([copy.loadLocale("de_DE"), copy.loadLocale("de_DE")]);
    expect(state.langText("common.greeting", { name: "Ada" })).toBe(
      "Hallo Ada",
    );
    // An already rendered value recomputes when a lazily required group arrives.
    const label = computed(() =>
      state.gettext.$npgettext("items", "%{n} item", "%{n} items", 2, { n: 2 }),
    );
    expect(label.value).toBe("2 items");
    await Promise.all([copy.loadTexts(["items"]), copy.loadTexts(["items"])]);
    expect(label.value).toBe("2 Dinge");
    expect(state.langTextPlural("items.one", "items.plural", 1, { n: 1 })).toBe(
      "1 Ding",
    );
    expect(loads.sort()).toEqual([
      "common",
      "common.de_DE",
      "items",
      "items.de_DE",
    ]);
  });

  it("stores every group and locale an unsplit bundle delivers, and rejects bundles missing the requested one", async () => {
    let loads = 0;
    const bundle = async () => {
      loads++;
      return { sources, translations: { de_DE: german } };
    };
    const groups = {
      common: { source: bundle, translations: { de_DE: bundle } },
      items: { source: bundle, translations: { de_DE: bundle } },
    };
    const identity = { sourceLocale: "en_US", locales: ["en_US", "de_DE"] };
    const copy = createRuntimeCatalog({
      ...identity,
      catalogGroups: groups,
      htmlTextKeys: [] as readonly `items.${keyof typeof sources.items}`[],
    });
    const state = copy.createCatalog();
    await copy.loadTexts(["common"]);
    await state.setLocale("de_DE");
    await copy.loadTexts(["items"]);
    expect(loads).toBe(2);
    expect(state.langTextPlural("items.one", "items.plural", 2, { n: 2 })).toBe(
      "2 Dinge",
    );
    const empty = async () => ({ translations: {} });
    const broken = createCompiledCatalog({
      ...identity,
      catalogGroups: { common: { translations: { de_DE: empty } } },
    });
    await broken.loadTexts();
    await expect(broken.loadLocale("de_DE")).rejects.toThrow(
      /provides no translations for locale "de_DE"/,
    );
  });

  it("loads groups requested through generated catalog groups, also before the facade exists", async () => {
    const { loads, options } = fixture();
    // An import cycle can evaluate a group module before its facade: the request is kept.
    await loadCatalogGroups(options.catalogGroups, ["common"]);
    expect(loads).toEqual([]);
    const copy = createRuntimeCatalog(options);
    await vi.waitFor(() =>
      expect(copy.text("common.greeting")).toBe("Hello %{name}"),
    );
    await loadCatalogGroups(options.catalogGroups, ["items"]);
    expect(copy.text("items.one")).toBe("%{n} item");
    // The queued request was handed to the first facade only.
    createRuntimeCatalog(options);
    await Promise.resolve();
    expect(loads).toEqual(["common", "items"]);
    // A chunk's group list widens the request; a non-array (unbundled dev) token is ignored.
    const other = fixture();
    const facade = createRuntimeCatalog(other.options);
    await loadCatalogGroups(other.options.catalogGroups, ["common"], "token");
    expect(other.loads).toEqual(["common"]);
    await loadCatalogGroups(other.options.catalogGroups, ["common"], ["items"]);
    expect(other.loads).toEqual(["common", "items"]);
    expect(facade.text("items.plural")).toBe("%{n} items");
  });

  it("never rejects group-module loads, reports their failure as cause and retries on use", async () => {
    const { failures, options } = fixture();
    const copy = createRuntimeCatalog(options);
    await copy.loadLocale("de_DE");
    const state = copy.createCatalog({ locale: "de_DE" });
    failures.add("common.de_DE");
    // A rejection here would permanently fail the importing page module.
    await expect(
      loadCatalogGroups(options.catalogGroups, ["common"]),
    ).resolves.toBeUndefined();
    let error: unknown;
    try {
      state.langText("common.greeting", { name: "Ada" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: expect.stringMatching(/not loaded for locale "de_DE"/),
      cause: { message: "network: common.de_DE" },
    });
    // Using the key started a background retry.
    await vi.waitFor(() =>
      expect(state.langText("common.greeting", { name: "Ada" })).toBe(
        "Hallo Ada",
      ),
    );
  });

  it("keeps the latest setLocale, stops loading abandoned locales and copies only used locales", async () => {
    const { loads, gates, options } = fixture();
    const copy = createRuntimeCatalog(options);
    await copy.loadTexts(["common"]);
    const state = copy.createCatalog();
    expect(Object.hasOwn(state.gettext.translations, "de_DE")).toBe(false);
    const release = Promise.withResolvers<void>();
    gates.set("common.de_DE", release.promise);
    const slow = state.setLocale("de_DE");
    await state.setLocale("en_US");
    release.resolve();
    await slow;
    // The slower, earlier switch must not override the later one.
    expect(state.gettext.current).toBe("en_US");
    await state.setLocale("de_DE");
    expect(Object.hasOwn(state.gettext.translations, "de_DE")).toBe(true);
    expect(state.langText("common.greeting", { name: "Ada" })).toBe(
      "Hallo Ada",
    );
    expect(state.usedGroups()).toEqual(["common"]);
    await state.setLocale("en_US");
    // Nobody displays de_DE any more: lazily required groups load only their source copy.
    await copy.loadTexts(["items"]);
    expect(loads).not.toContain("items.de_DE");
    // A direct assignment still finds the already loaded locale.
    const direct = copy.createCatalog();
    direct.gettext.current = "de_DE";
    expect(direct.langText("common.greeting", { name: "Lin" })).toBe(
      "Hallo Lin",
    );
  });

  it("types locales from the generated tuple", () => {
    const typed = () => {
      const copy = createCompiledCatalog({
        catalogGroups: {},
        sourceLocale: "en_US",
        locales: ["en_US", "de_DE"] as const,
      });
      // @ts-expect-error unknown locales fail type checking
      copy.createCatalog({ locale: "fr_FR" });
      // @ts-expect-error unknown locales fail type checking
      return copy.loadLocale("en_GB");
    };
    expect(typeof typed).toBe("function");
  });

  it("switches locales only after loading them and retries failed loads", async () => {
    const { loads, failures, options } = fixture();
    const copy = createRuntimeCatalog(options);
    await copy.loadTexts();
    const state = copy.createCatalog();
    state.gettext.current = "de_DE";
    expect(() => state.langText("common.greeting", { name: "Ada" })).toThrow(
      /not loaded for locale "de_DE"/,
    );
    state.gettext.current = "en_US";
    failures.add("items.de_DE");
    await expect(state.setLocale("de_DE")).rejects.toThrow(/network/);
    expect(state.gettext.current).toBe("en_US");
    await state.setLocale("de_DE");
    expect(state.gettext.current).toBe("de_DE");
    expect(state.langText("common.greeting", { name: "Ada" })).toBe(
      "Hallo Ada",
    );
    expect(loads.filter((id) => id === "items.de_DE")).toHaveLength(2);
    await expect(state.setLocale("fr_FR")).rejects.toThrow(
      /Unknown catalog locale/,
    );
    // A locale the application installs on gettext itself is not lazily loaded, so not barred.
    state.gettext.translations = {
      ...state.gettext.translations,
      fr_FR: { "Hello %{name}": { "common.greeting": "Bonjour %{name}" } },
    };
    state.gettext.current = "fr_FR";
    expect(state.langText("common.greeting", { name: "Ada" })).toBe(
      "Bonjour Ada",
    );
  });

  it("selects each invocation context and keeps source fallbacks local to each facade", async () => {
    const { options } = fixture();
    const copy = createRuntimeCatalog(options);
    const other = createRuntimeCatalog(fixture().options);
    await Promise.all([copy.loadTexts(), copy.loadLocale("de_DE")]);
    await other.loadTexts();
    const app = createSSRApp({});
    const state = copy.createCatalog({ locale: "de_DE" });
    copy.installCatalog(app, state);
    const callback = app.runWithContext(
      () => () => copy.langText("common.greeting", { name: "Ada" }),
    );
    expect(app.runWithContext(callback)).toBe("Hallo Ada");
    expect(callback()).toBe("Hello Ada");
    expect(other.langText("common.greeting", { name: "Ada" })).toBe(
      "Hello Ada",
    );
    state.gettext.current = "en_US";
    expect(app.runWithContext(callback)).toBe("Hello Ada");
    expect(createSSRApp({}).runWithContext(callback)).toBe("Hello Ada");
  });

  it("sanitizes translated interpolated HTML through the selected request, including globals", async () => {
    const sanitize = vi.fn((html: string) => html.replaceAll(/<[^>]*>/gu, ""));
    const { options } = fixture();
    const copy = createRuntimeCatalog(options);
    await copy.loadLocale("de_DE");
    await copy.loadTexts();
    const app = createSSRApp({});
    copy.installCatalog(
      app,
      copy.createCatalog({ locale: "de_DE", sanitizeHtml: sanitize }),
    );
    expect(
      app.runWithContext(() =>
        copy.langHtmlText("common.html", { name: "<b>Ada</b>" }),
      ),
    ).toBe("Ada");
    expect(sanitize).toHaveBeenLastCalledWith("<em><b>Ada</b></em>");
    expect(
      app.config.globalProperties.$langHtmlText("common.html", { name: "Lin" }),
    ).toBe("Lin");
    expect(
      app.config.globalProperties.$langTextPlural(
        "items.one",
        "items.plural",
        2,
        { n: 2 },
      ),
    ).toBe("2 Dinge");
    expect(() => copy.langHtmlText("common.html")).toThrow(/sanitizeHtml/);
  });
});

describe("lookup-free compiled adapters", () => {
  async function compiled() {
    const { loads, options } = fixture();
    const copy = createCompiledCatalog(options);
    await copy.loadTexts();
    await copy.loadLocale("de_DE");
    return { copy, loads };
  }

  it("needs no data for the source locale and none of the runtime source copy", async () => {
    const { loads, options } = fixture();
    const copy = createCompiledCatalog(options);
    await copy.loadTexts();
    expect(loads).toEqual([]);
    expect(
      copy.pgettext("common.greeting", "Hello %{name}", { name: "Ada" }),
    ).toBe("Hello Ada");
  });

  it("guards template globals against unloaded groups but passes foreign contexts through", async () => {
    const { options } = fixture();
    const copy = createCompiledCatalog(options);
    const app = createSSRApp({});
    copy.installCatalog(app, copy.createCatalog({ locale: "de_DE" }));
    const globals = app.config.globalProperties;
    expect(() => globals.$pgettext("common.greeting", "Hello")).toThrow(
      /not loaded for locale "de_DE"/,
    );
    expect(globals.$pgettext("vendor", "Hello")).toBe("Hello");
    await copy.loadTexts(["items"]);
    expect(
      globals.$npgettext("items", "%{n} item", "%{n} items", 2, { n: 2 }),
    ).toBe("2 Dinge");
  });

  it("isolates overlapping SSR renders and later requests", async () => {
    const { copy } = await compiled();
    const barrier = Promise.withResolvers<void>();
    let started = 0;
    const label = defineComponent({
      async setup() {
        if (++started === 2) barrier.resolve();
        await barrier.promise;
        return () =>
          h(
            "p",
            copy.pgettext("common.greeting", "Hello %{name}", { name: "Ada" }),
          );
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
    expect(
      copy.pgettext("common.greeting", "Hello %{name}", { name: "Ada" }),
    ).toBe("Hello Ada");
  });

  it("selects the translator after argument effects, not when callbacks are created", async () => {
    const { copy } = await compiled();
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
        copy.pgettext("common.greeting", "Hello %{name}", {
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

  it("clones contextual and context-free plural arrays for every app and later request", async () => {
    const { copy } = await compiled();
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

  it("never allows unsanitized HTML, and fixes independent facade source fallbacks", async () => {
    const { copy } = await compiled();
    const other = createCompiledCatalog(fixture().options);
    expect(() =>
      copy.htmlPgettext("common.html", "<strong>%{name}</strong>"),
    ).toThrow(/sanitizeHtml/);
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
        copy.htmlPgettext("common.html", "<strong>%{name}</strong>", {
          name: "Ada",
        }),
      ),
    ).toBe("Ada");
    expect(() =>
      copy.htmlPgettext("common.html", "<strong>Ada</strong>"),
    ).toThrow(/sanitizeHtml/);
    expect(
      copy.pgettext("common.greeting", "Hello %{name}", { name: "Ada" }),
    ).toBe("Hello Ada");
    expect(
      other.pgettext("common.greeting", "Hello %{name}", { name: "Ada" }),
    ).toBe("Hello Ada");
  });
});
