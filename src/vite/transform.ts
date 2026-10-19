import { parse as parseJavaScript, type ParserPlugin } from "@babel/parser";
import traverseModule, {
  type Binding,
  type NodePath,
  type TraverseOptions,
} from "@babel/traverse";
import * as t from "@babel/types";
import {
  createTransformContext,
  isFnExpression,
  isMemberExpression,
  parse as parseHtml,
  type TransformContext,
} from "@vue/compiler-dom";
import MagicString from "magic-string";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import * as ts from "typescript";
import type { TransformResult } from "vite";
import {
  compileScript,
  parse as parseSfc,
  registerTS,
  type SFCDescriptor,
} from "@vue/compiler-sfc";
import { catalogGroup } from "../group.js";
import type {
  CatalogModule,
  TextCatalogSnapshot,
  TextCatalogTransformOptions,
} from "./types.js";

// Babel's CommonJS default is wrapped differently by native Node and Vite.
type Traverse = (node: t.Node, options: TraverseOptions) => void;
const babelTraverse = traverseModule as unknown as { default: Traverse };
const traverse: Traverse =
  typeof traverseModule === "function"
    ? (traverseModule as Traverse)
    : babelTraverse.default;
registerTS(() => ts);

/** Side-effect modules that top-level-await their catalog group before the importing module runs. */
export const groupModulePrefix = "virtual:lsr-text-catalog/group/";

type Macro = "text" | "langText" | "langTextPlural" | "langHtmlText";
type RuntimeHelper = "pgettext" | "npgettext" | "htmlPgettext";
type TemplateRoot = NonNullable<NonNullable<SFCDescriptor["template"]>["ast"]>;
type TemplateNode = TemplateRoot["children"][number];
type Element = Extract<TemplateNode, { type: 1 }>;
type Directive = Extract<Element["props"][number], { type: 7 }>;
type Expression = NonNullable<Directive["exp"]>;

interface MacroImport {
  binding: Binding;
  module: CatalogModule;
  macro?: Macro;
  declaration: t.ImportDeclaration;
  specifier: t.ImportSpecifier | t.ImportNamespaceSpecifier;
  runtimeUse: boolean;
  typeUse: boolean;
  references: WeakSet<t.Node>;
}

interface Script {
  ast: t.File;
  content: string;
  offset: number;
  imports: Map<Binding, MacroImport>;
  bindings: Map<string, Binding>;
  helpers: Map<RuntimeHelper, string>;
}

interface Region {
  content: string;
  /** Maps a decoded expression offset to the original file. */
  position: (offset: number) => number;
  encode: (value: string) => string;
}

interface Environment {
  script?: Script;
  imports?: Map<string, MacroImport>;
  shadows?: ReadonlySet<string>;
  template?: boolean;
}

const globals: Record<string, Exclude<Macro, "text">> = {
  $langText: "langText",
  $langTextPlural: "langTextPlural",
  $langHtmlText: "langHtmlText",
};
const runtimeHelpers: Record<Exclude<Macro, "text">, RuntimeHelper> = {
  langText: "pgettext",
  langTextPlural: "npgettext",
  langHtmlText: "htmlPgettext",
};
const scriptExtensions: Record<string, true> = {
  ".js": true,
  ".mjs": true,
  ".cjs": true,
  ".ts": true,
  ".mts": true,
  ".cts": true,
  ".jsx": true,
  ".tsx": true,
};
const scriptLanguages: Record<string, true> = {
  js: true,
  javascript: true,
  ts: true,
  typescript: true,
  jsx: true,
  tsx: true,
};

function macroExport(module: CatalogModule, name: string): Macro | undefined {
  if (module === "catalog") return name === "text" ? "text" : undefined;
  if (
    name === "text" ||
    name === "langText" ||
    name === "langTextPlural" ||
    name === "langHtmlText"
  )
    return name;
  return undefined;
}

function importedName(
  specifier: t.ImportSpecifier | t.ExportSpecifier,
): string {
  const name = t.isImportSpecifier(specifier)
    ? specifier.imported
    : specifier.local;
  return t.isIdentifier(name) ? name.name : name.value;
}

function literal(value: string): string {
  // Also safe in script raw text, interpolation delimiters, and dynamic directive names.
  return JSON.stringify(value).replace(
    /[<>&'{}\[\]=/\u2028\u2029\s]/gu,
    (char) => {
      if (char === " ") return "\\u0020";
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    },
  );
}

function encodeAttribute(value: string): string {
  return value.replace(/[&"'<>\s=`]/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function unwrapKey(node: t.Node): t.Node {
  while (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node) ||
    t.isTypeCastExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function isTypeReference(path: NodePath): boolean {
  for (
    let current: NodePath | null = path.parentPath;
    current;
    current = current.parentPath
  ) {
    const node = current.node;
    if (
      t.isTSAsExpression(node) ||
      t.isTSSatisfiesExpression(node) ||
      t.isTSNonNullExpression(node)
    ) {
      if (node.expression === path.node) return false;
      continue;
    }
    if (current.isExportSpecifier() && current.node.exportKind === "type")
      return true;
    if (
      current.isExportNamedDeclaration() &&
      current.node.exportKind === "type"
    )
      return true;
    if (
      current.isTSType() ||
      current.isTSTypeAnnotation() ||
      current.isTypeAnnotation()
    )
      return true;
    if (current.isExpression() || current.isStatement()) return false;
  }
  return false;
}

/** Expand only original application sources, before Vue owns SFC compilation. */
export async function transformTextCatalog(
  source: string,
  id: string,
  snapshot: TextCatalogSnapshot,
  options: TextCatalogTransformOptions,
): Promise<TransformResult | null> {
  if (
    id.includes("?") ||
    id.includes("#") ||
    id.includes("\0") ||
    id.startsWith("virtual:") ||
    /[/\\]node_modules[/\\]/u.test(id)
  )
    return null;
  const extension = extname(id);
  if (extension !== ".vue" && !Object.hasOwn(scriptExtensions, extension))
    return null;

  const filename = isAbsolute(id) ? id : resolve(options.root, id);
  const output = new MagicString(source);
  let changed = false;
  let serial = 0;
  let setupScript: Script | undefined;
  let normalScript: Script | undefined;
  const scripts: Script[] = [];
  const reservedNames = new Set<string>();

  function fail(message: string, offset: number): never {
    const before = source.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    const error = new Error(
      `[textCatalog] ${id}:${line}:${column}: ${message}`,
    );
    Object.assign(error, {
      id,
      pos: offset,
      loc: { file: id, line, column: column - 1 },
    });
    throw error;
  }

  // Translated literal keys need their lazily loaded group; source-only `text` expansions do not.
  const usedGroups = new Set<string>();

  const moduleIdentities = new Map<string, CatalogModule | undefined>();
  function moduleIdentity(specifier: string): CatalogModule | undefined {
    return moduleIdentities.get(specifier);
  }

  async function hasCatalogImport(
    content: string,
    importer: string,
  ): Promise<boolean> {
    // Unsupported preprocessors cannot be parsed as JS; resolve their import
    // specifiers before deciding that macro usage may safely pass through.
    for (const match of content.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu,
    )) {
      if (await options.resolveModule(match[1]!, importer)) return true;
    }
    return false;
  }

  function parseCode(
    content: string,
    language: string,
    offset: number,
  ): t.File {
    const plugins: ParserPlugin[] = [];
    if (["ts", "typescript", "tsx", "mts", "cts"].includes(language))
      plugins.push("typescript");
    if (["jsx", "tsx"].includes(language)) plugins.push("jsx");
    try {
      return parseJavaScript(content, {
        sourceType: "unambiguous",
        plugins,
        allowAwaitOutsideFunction: true,
      });
    } catch (error) {
      const parseError = error as Error & { pos?: number };
      return fail(
        `Cannot parse ${language} source: ${parseError.message}`,
        offset + (parseError.pos ?? 0),
      );
    }
  }

  async function readScript(
    content: string,
    language: string,
    offset: number,
  ): Promise<Script> {
    const ast = parseCode(content, language, offset);
    const specifiers = new Set<string>();
    t.traverseFast(ast, (node) => {
      if (
        (t.isImportDeclaration(node) ||
          t.isExportNamedDeclaration(node) ||
          t.isExportAllDeclaration(node)) &&
        node.source
      ) {
        specifiers.add(node.source.value);
      } else if (t.isImportExpression(node) && t.isStringLiteral(node.source)) {
        specifiers.add(node.source.value);
      } else if (
        t.isCallExpression(node) &&
        (t.isImport(node.callee) ||
          t.isIdentifier(node.callee, { name: "require" })) &&
        t.isStringLiteral(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].value);
      }
    });
    await Promise.all(
      [...specifiers]
        .filter((specifier) => !moduleIdentities.has(specifier))
        .map(async (specifier) => {
          moduleIdentities.set(
            specifier,
            await options.resolveModule(specifier, filename),
          );
        }),
    );
    const script: Script = {
      ast,
      content,
      offset,
      imports: new Map(),
      bindings: new Map(),
      helpers: new Map(),
    };
    traverse(ast, {
      Identifier(path) {
        reservedNames.add(path.node.name);
      },
      Program(path) {
        script.bindings = new Map(Object.entries(path.scope.bindings));
        for (const statement of path.node.body) {
          if (
            t.isExportAllDeclaration(statement) &&
            statement.exportKind !== "type" &&
            moduleIdentity(statement.source.value)
          ) {
            fail(
              "Re-exporting a compiler-macro module is unsupported. Import macros directly at their call sites; re-export runtime or type exports explicitly.",
              offset + statement.start!,
            );
          }
          if (
            t.isExportNamedDeclaration(statement) &&
            statement.source &&
            statement.exportKind !== "type"
          ) {
            const module = moduleIdentity(statement.source.value);
            if (
              module &&
              statement.specifiers.some(
                (specifier) =>
                  !t.isExportSpecifier(specifier) ||
                  (specifier.exportKind !== "type" &&
                    macroExport(module, importedName(specifier))),
              )
            ) {
              fail(
                "Compiler macros cannot be re-exported. Import them directly from the canonical module at each call site.",
                offset + statement.start!,
              );
            }
          }
          if (
            !t.isImportDeclaration(statement) ||
            statement.importKind === "type"
          )
            continue;
          const module = moduleIdentity(statement.source.value);
          if (!module) continue;
          for (const specifier of statement.specifiers) {
            if (t.isImportDefaultSpecifier(specifier)) continue;
            if (
              t.isImportSpecifier(specifier) &&
              specifier.importKind === "type"
            )
              continue;
            const macro = t.isImportSpecifier(specifier)
              ? macroExport(module, importedName(specifier))
              : undefined;
            if (!macro && !t.isImportNamespaceSpecifier(specifier)) continue;
            const binding = path.scope.getBinding(specifier.local.name)!;
            if (binding.constantViolations.length)
              fail(
                "Compiler macro imports cannot be assigned to.",
                offset + binding.constantViolations[0]!.node.start!,
              );
            script.imports.set(binding, {
              binding,
              module,
              macro,
              declaration: statement,
              specifier,
              runtimeUse: false,
              typeUse: false,
              references: new WeakSet(),
            });
          }
        }
      },
    });
    scripts.push(script);
    return script;
  }

  function helper(script: Script, name: RuntimeHelper): string {
    const existing = script.helpers.get(name);
    if (existing) return existing;
    let local: string;
    do local = `__textCatalog_${name}_${serial++}`;
    while (reservedNames.has(local) || source.includes(local));
    script.helpers.set(name, local);
    return local;
  }

  function replace(
    region: Region,
    start: number,
    end: number,
    value: string,
  ): void {
    output.overwrite(
      region.position(start),
      region.position(end),
      region.encode(value),
    );
    changed = true;
  }

  function transformAst(
    ast: t.File,
    region: Region,
    environment: Environment,
    prefix = 0,
  ): void {
    function location(node: t.Node): number {
      return region.position(Math.max(0, node.start! - prefix));
    }
    function resolveImport(
      path: NodePath<t.Identifier | t.JSXIdentifier>,
    ): MacroImport | undefined {
      const binding = path.scope.getBinding(path.node.name);
      if (binding) return environment.script?.imports.get(binding);
      if (environment.shadows?.has(path.node.name)) return undefined;
      if (environment.template) return environment.imports?.get(path.node.name);
      const outer = normalScript?.bindings.get(path.node.name);
      return outer ? normalScript?.imports.get(outer) : undefined;
    }
    traverse(ast, {
      "AssignmentExpression|UpdateExpression"(path) {
        if (!environment.template) return;
        const target = t.isAssignmentExpression(path.node)
          ? path.node.left
          : t.isUpdateExpression(path.node)
            ? path.node.argument
            : undefined;
        if (!target) return;
        for (const name of Object.keys(t.getBindingIdentifiers(target))) {
          if (path.scope.getBinding(name) || environment.shadows?.has(name))
            continue;
          if (environment.imports?.has(name) || Object.hasOwn(globals, name)) {
            fail(
              "Compiler macros cannot be assigned to from templates. Use a separate local state binding.",
              location(target),
            );
          }
        }
      },
      ImportExpression(path) {
        if (
          t.isStringLiteral(path.node.source) &&
          moduleIdentity(path.node.source.value)
        ) {
          fail(
            "Dynamic import of compiler-macro modules is unsupported. Use named ESM imports.",
            location(path.node),
          );
        }
      },
      CallExpression(path) {
        const callee = path.node.callee;
        if (
          (t.isImport(callee) ||
            (t.isIdentifier(callee, { name: "require" }) &&
              !path.scope.getBinding("require"))) &&
          t.isStringLiteral(path.node.arguments[0]) &&
          moduleIdentity(path.node.arguments[0].value)
        ) {
          fail(
            "Dynamic import/require of compiler-macro modules is unsupported. Use named ESM imports, or explicit namespace member calls.",
            location(path.node),
          );
        }
      },
      ReferencedIdentifier(path) {
        if (!path.isIdentifier() && !path.isJSXIdentifier()) return;
        const record = resolveImport(path);
        const global =
          !record &&
          environment.template &&
          !path.scope.hasBinding(path.node.name) &&
          !environment.shadows?.has(path.node.name) &&
          Object.hasOwn(globals, path.node.name)
            ? globals[path.node.name]
            : undefined;
        if (!record && !global) return;
        record?.references.add(path.node);
        if (isTypeReference(path)) {
          if (record) record.typeUse = true;
          return;
        }
        let macro = record?.macro ?? global;
        let callee: NodePath = path;
        if (record && !record.macro) {
          const parent = path.parentPath;
          if (
            (parent.isMemberExpression() ||
              parent.isOptionalMemberExpression()) &&
            parent.node.object === path.node
          ) {
            if (parent.node.computed || !t.isIdentifier(parent.node.property)) {
              fail(
                "Computed namespace access may escape a compiler macro. Use an explicit namespace.langText(...) or namespace.text(...) call.",
                location(parent.node),
              );
            }
            macro = macroExport(record.module, parent.node.property.name);
            if (!macro) {
              record.runtimeUse = true;
              return;
            }
            if (parent.isOptionalMemberExpression())
              fail(
                "Optional compiler-macro access is unsupported. Use a direct call with a literal key.",
                location(parent.node),
              );
            callee = parent;
          } else {
            fail(
              "A compiler-macro namespace cannot escape as a runtime value. Use explicit namespace member calls or named runtime imports.",
              location(path.node),
            );
          }
        }
        if (!macro) return;
        const call = callee.parentPath;
        if (!call?.isCallExpression() || call.node.callee !== callee.node) {
          fail(
            `Compiler macro ${macro} must be called directly, not escaped, re-exported, constructed, tagged, or called optionally. Use a literal-key call at the use site.`,
            location(callee.node),
          );
        }
        const args = call.node.arguments;
        const minimum = macro === "langTextPlural" ? 3 : 1;
        const maximum =
          macro === "text" ? 1 : macro === "langTextPlural" ? 4 : 2;
        if (
          call.node.typeParameters ||
          call.node.typeArguments ||
          args.length < minimum ||
          args.length > maximum ||
          args.some(
            (arg) => t.isSpreadElement(arg) || t.isArgumentPlaceholder(arg),
          )
        ) {
          fail(
            `${macro} requires ${minimum === maximum ? minimum : `${minimum}–${maximum}`} ordinary arguments; spreads, extra arguments and generic calls are unsupported.`,
            location(call.node),
          );
        }
        const keyNode = unwrapKey(args[0]!);
        const key = t.isStringLiteral(keyNode)
          ? keyNode.value
          : t.isTemplateLiteral(keyNode) && keyNode.expressions.length === 0
            ? keyNode.quasis[0]?.value.cooked
            : undefined;
        if (typeof key !== "string")
          fail(
            `${macro} requires a literal catalog key in compiled mode. Replace finite selectors with literal-key branches, or select runtime mode for dynamic keys.`,
            location(args[0]!),
          );
        const own = (map: object, name: string): boolean =>
          Object.prototype.hasOwnProperty.call(map, name);
        let values: string[];
        if (macro === "langTextPlural") {
          const pluralNode = unwrapKey(args[1]!);
          const pluralKey = t.isStringLiteral(pluralNode)
            ? pluralNode.value
            : t.isTemplateLiteral(pluralNode) &&
                pluralNode.expressions.length === 0
              ? pluralNode.quasis[0]?.value.cooked
              : undefined;
          if (typeof pluralKey !== "string")
            fail(
              "langTextPlural requires two literal catalog keys. Replace dynamic selectors with literal-key branches.",
              location(args[1]!),
            );
          const entry = Object.entries(snapshot.plurals).find(
            ([, pair]) => pair.one === key && pair.plural === pluralKey,
          );
          if (!entry)
            fail(
              `Unknown plural catalog pair ${JSON.stringify(key)}, ${JSON.stringify(pluralKey)}. Both keys must match one declared one/plural pair.`,
              location(args[0]!),
            );
          const [context, pair] = entry;
          if (
            !own(snapshot.texts, pair.one) ||
            !own(snapshot.texts, pair.plural)
          )
            fail(
              `Plural catalog key ${JSON.stringify(context)} references missing source keys. Recompile the catalog.`,
              location(args[0]!),
            );
          values = [
            context,
            snapshot.texts[pair.one]!,
            snapshot.texts[pair.plural]!,
          ];
        } else {
          if (!own(snapshot.texts, key))
            fail(
              `Unknown catalog key ${JSON.stringify(key)}. Add it to the source catalog or correct the literal.`,
              location(args[0]!),
            );
          if (macro === "langHtmlText" && !own(snapshot.htmlKeys, key))
            fail(
              `Catalog key ${JSON.stringify(key)} is not declared as HTML. Use langText or declare HTML source copy.`,
              location(args[0]!),
            );
          values = [key, snapshot.texts[key]!];
        }
        if (macro !== "text") usedGroups.add(catalogGroup(values[0]!));
        if (macro === "text") {
          replace(
            region,
            call.node.start! - prefix,
            call.node.end! - prefix,
            literal(values[1]!),
          );
          return;
        }
        const runtime = runtimeHelpers[macro];
        let target: string;
        if (global) {
          target = `$${runtime}`;
          if (environment.shadows?.has(target) || path.scope.hasBinding(target))
            fail(
              `The runtime translation global ${target} is shadowed here. Rename that local binding before using ${macro}.`,
              location(callee.node),
            );
        } else {
          const owner = environment.template ? setupScript : environment.script;
          if (!owner)
            fail(
              "Imported template compiler macros require an inline <script setup> block.",
              location(callee.node),
            );
          target = helper(owner, runtime);
        }
        // The original remaining arguments stay in place: evaluation happens once,
        // left-to-right, before the adapter selects the current app at invocation.
        replace(
          region,
          callee.node.start! - prefix,
          callee.node.end! - prefix,
          target,
        );
        replace(
          region,
          args[0]!.start! - prefix,
          args[macro === "langTextPlural" ? 1 : 0]!.end! - prefix,
          values.map(literal).join(","),
        );
      },
    });
  }

  let descriptor: SFCDescriptor | undefined;
  let templateImports = new Map<string, MacroImport>();
  const templateShadows = new Set<string>();
  if (extension === ".vue") {
    const parsed = parseSfc(source, {
      filename,
      templateParseOptions: { expressionPlugins: ["typescript"] },
    });
    descriptor = parsed.descriptor;
    if (parsed.errors.length) {
      const error = parsed.errors[0]!;
      fail(
        `Cannot parse Vue SFC: ${error.message}`,
        "loc" in error ? (error.loc?.start.offset ?? 0) : 0,
      );
    }
    for (const [block, setup] of [
      [descriptor.script, false],
      [descriptor.scriptSetup, true],
    ] as const) {
      if (
        !block ||
        block.src ||
        !Object.hasOwn(scriptLanguages, block.lang ?? "js")
      )
        continue;
      const script = await readScript(
        block.content,
        block.lang ?? "js",
        block.loc.start.offset,
      );
      if (setup) setupScript = script;
      else normalScript = script;
    }
    const hasMacroImports = scripts.some((script) => script.imports.size > 0);
    for (const block of descriptor.customBlocks) {
      if (
        hasMacroImports ||
        (await hasCatalogImport(block.content, filename)) ||
        /(?:\$?lang(?:Html)?Text(?:Plural)?|\btext)\s*\(/u.test(block.content)
      ) {
        fail(
          "Text catalog compilation does not support macro usage in custom SFC blocks.",
          block.loc.start.offset,
        );
      }
    }
    for (const block of [
      descriptor.script,
      descriptor.scriptSetup,
      descriptor.template,
    ]) {
      if (!block) continue;
      const unsupported =
        block.src ||
        (block.type === "template"
          ? block.lang && block.lang !== "html"
          : !Object.hasOwn(scriptLanguages, block.lang ?? "js"));
      if (!unsupported) continue;
      let content = block.content;
      let importer = filename;
      if (block.src) {
        const external = resolve(dirname(filename), block.src);
        importer = external;
        if (existsSync(external)) content += readFileSync(external, "utf8");
      }
      if (
        hasMacroImports ||
        (await hasCatalogImport(content, importer)) ||
        /(?:\$?lang(?:Html)?Text(?:Plural)?|\btext)\s*\(/u.test(
          content + source,
        )
      ) {
        fail(
          `Text catalog compilation does not support external or preprocessed <${block.type}> blocks. Move macro usage into ordinary inline JS/TS and HTML SFC blocks.`,
          block.loc.start.offset,
        );
      }
    }
    if (
      (descriptor.script || descriptor.scriptSetup) &&
      ![descriptor.script, descriptor.scriptSetup].some(
        (block) =>
          block &&
          (block.src || !Object.hasOwn(scriptLanguages, block.lang ?? "js")),
      )
    ) {
      // Vue owns props/Options API metadata and visibility between the two scripts.
      // Use its public analysis rather than treating every spelling as a global.
      const metadata = compileScript(descriptor, {
        id: filename,
        sourceMap: false,
      });
      for (const name of Object.keys(metadata.bindings ?? {}))
        templateShadows.add(name);
      templateImports = new Map();
      if (setupScript) {
        for (const script of scripts) {
          for (const record of script.imports.values()) {
            if (
              metadata.imports?.[record.specifier.local.name]?.isType === false
            ) {
              templateImports.set(record.specifier.local.name, record);
              templateShadows.delete(record.specifier.local.name);
            }
          }
        }
      }
    }
  } else {
    normalScript = await readScript(source, extension.slice(1), 0);
  }
  function reserveTemplateNames(node: TemplateNode): void {
    const expressions: Expression[] = [];
    if (node.type === 5) expressions.push(node.content);
    if (node.type === 1) {
      for (const prop of node.props) {
        if (prop.type !== 7) continue;
        if (prop.exp) expressions.push(prop.exp);
        if (prop.arg) expressions.push(prop.arg);
        if (prop.forParseResult) {
          for (const expression of [
            prop.forParseResult.source,
            prop.forParseResult.value,
            prop.forParseResult.key,
            prop.forParseResult.index,
          ]) {
            if (expression) expressions.push(expression);
          }
        }
      }
      for (const child of node.children) reserveTemplateNames(child);
    }
    for (const expression of expressions) {
      if (expression.ast) {
        t.traverseFast(expression.ast, (identifier) => {
          if (t.isIdentifier(identifier)) reservedNames.add(identifier.name);
        });
      } else if (expression.type === 4) {
        reservedNames.add(expression.content);
      }
    }
  }
  for (const child of descriptor?.template?.ast?.children ?? [])
    reserveTemplateNames(child);

  for (const script of scripts) {
    transformAst(
      script.ast,
      {
        content: script.content,
        position: (offset) => script.offset + offset,
        encode: (value) => value,
      },
      { script },
    );
  }

  // Vue decodes entities in both attributes and interpolations, using different
  // HTML rules. Keep the raw suffix of partially consumed named entities mapped
  // to its own UTF-16 offsets rather than to the entity's starting ampersand.
  const entityCaches = {
    attribute: new Map<string, string>(),
    text: new Map<string, string>(),
  };
  function decodeEntityToken(token: string, attribute: boolean): string {
    const cache = attribute ? entityCaches.attribute : entityCaches.text;
    const cached = cache.get(token);
    if (cached !== undefined) return cached;
    let value: string;
    if (attribute) {
      const element = parseHtml(`<i value="${token}"/>`).children[0] as Element;
      const prop = element.props[0]!;
      value = prop.type === 6 ? prop.value!.content : token;
    } else {
      // Sentinels prevent Vue from discarding whitespace-only text nodes.
      const text = parseHtml(`_${token}_`, { whitespace: "preserve" })
        .children[0]!;
      value = text.type === 2 ? text.content.slice(1, -1) : token;
    }
    cache.set(token, value);
    return value;
  }
  function regionFor(
    expression: Expression,
    attribute: boolean,
    argument = false,
  ): Region {
    if (expression.type !== 4)
      return fail(
        "Expected an original, uncompiled Vue expression.",
        expression.loc.start.offset,
      );
    let start = expression.loc.start.offset;
    let raw = expression.loc.source;
    if (argument && raw.startsWith("[") && raw.endsWith("]")) {
      start++;
      raw = raw.slice(1, -1);
    }
    const offsets: number[] = [];
    if (!argument && raw !== expression.content) {
      let decoded = "";
      let rawOffset = 0;
      for (const match of raw.matchAll(
        /&(?:#[xX][\da-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z\d]*;?)=?/gu,
      )) {
        for (; rawOffset < match.index; rawOffset++) {
          offsets.push(start + rawOffset);
          decoded += raw[rawOffset];
        }
        const token = match[0];
        const value = decodeEntityToken(token, attribute);
        let suffix = 0;
        while (
          suffix < value.length &&
          value[value.length - suffix - 1] === token[token.length - suffix - 1]
        )
          suffix++;
        // A decoded character can itself equal a raw trailing character
        // (e.g. &semi;). Only preserve a suffix the parser left untouched.
        while (
          suffix &&
          decodeEntityToken(token.slice(0, -suffix), attribute) !==
            value.slice(0, -suffix)
        )
          suffix--;
        for (let index = 0; index < value.length - suffix; index++)
          offsets.push(start + rawOffset);
        for (let index = token.length - suffix; index < token.length; index++)
          offsets.push(start + rawOffset + index);
        decoded += value;
        rawOffset += token.length;
      }
      for (; rawOffset < raw.length; rawOffset++) {
        offsets.push(start + rawOffset);
        decoded += raw[rawOffset];
      }
      offsets.push(start + raw.length);
      if (decoded !== expression.content)
        fail(
          "Cannot map the decoded Vue expression safely. Use semicolon-terminated HTML entities or move this expression into script setup.",
          start,
        );
    }
    return {
      content: expression.content,
      position: offsets.length
        ? (offset) => offsets[offset]!
        : (offset) => start + offset,
      encode: attribute && !argument ? encodeAttribute : (value) => value,
    };
  }

  function expressionAst(
    region: Region,
    shadows: ReadonlySet<string>,
    grammar: "expression" | "statements" | "params" = "expression",
    inlineEvent = false,
  ): t.File {
    const prefix =
      grammar === "statements"
        ? "($event)=>{"
        : inlineEvent
          ? "($event)=>("
          : "(";
    const suffix =
      grammar === "statements" ? "\n}" : grammar === "params" ? ")=>{}" : "\n)";
    const ast = parseCode(
      prefix + region.content + suffix,
      "ts",
      region.position(0) - prefix.length,
    );
    transformAst(
      ast,
      region,
      { template: true, imports: templateImports, shadows },
      prefix.length,
    );
    return ast;
  }

  function parameterNames(content: string, offset: number): string[] {
    const ast = parseCode(`(${content})=>{}`, "ts", offset - 1);
    const statement = ast.program.body[0];
    if (
      !t.isExpressionStatement(statement) ||
      !t.isArrowFunctionExpression(statement.expression)
    )
      fail("Expected Vue parameter bindings.", offset);
    return statement.expression.params.flatMap((parameter) =>
      Object.keys(t.getBindingIdentifiers(parameter)),
    );
  }

  let eventContext: TransformContext | undefined;

  function visitTemplate(
    node: TemplateNode,
    inherited: ReadonlySet<string>,
  ): void {
    if (node.type === 5) {
      expressionAst(regionFor(node.content, false), inherited);
      return;
    }
    if (node.type !== 1) return;
    const directives = node.props.filter(
      (prop): prop is Directive => prop.type === 7,
    );
    const loop = directives.find((prop) => prop.name === "for");
    const slot = directives.find((prop) => prop.name === "slot");
    const locals = new Set(inherited);
    if (loop?.exp) {
      const result = loop.forParseResult;
      if (!result || loop.exp.type !== 4)
        fail(
          "Cannot parse v-for. Use Vue's (value, key, index) in source syntax.",
          loop.loc.start.offset,
        );
      const region = regionFor(loop.exp, true);
      const segments = [result.value, result.key, result.index].filter(
        (part): part is Expression => !!part,
      );
      for (const part of segments) {
        if (part.type !== 4) continue;
        for (const name of parameterNames(part.content, part.loc.start.offset))
          locals.add(name);
      }
      const subregion = (part: Expression): Region => {
        if (part.type !== 4)
          fail("Expected an original v-for expression.", part.loc.start.offset);
        const offset = part.loc.start.offset - loop.exp!.loc.start.offset;
        return {
          content: part.content,
          position: (index) => region.position(offset + index),
          encode: region.encode,
        };
      };
      expressionAst(subregion(result.source), inherited);
      for (const part of segments)
        expressionAst(subregion(part), locals, "params");
    }
    const slotLocals = new Set(locals);
    if (slot?.exp?.type === 4) {
      for (const name of parameterNames(
        slot.exp.content,
        slot.exp.loc.start.offset,
      ))
        slotLocals.add(name);
      expressionAst(regionFor(slot.exp, true), slotLocals, "params");
    }
    for (const directive of directives) {
      // v-if has higher precedence than v-for on the same element. Slot
      // parameters belong to slot children, not the component's own props.
      const scope =
        directive.name === "if" || directive.name === "else-if"
          ? inherited
          : locals;
      if (directive.arg && directive.arg.type === 4 && !directive.arg.isStatic)
        expressionAst(regionFor(directive.arg, false, true), scope);
      if (directive.name === "for" || directive.name === "slot") continue;
      if (directive.exp) {
        let inlineEvent = false;
        let grammar: "expression" | "statements" = "expression";
        if (directive.name === "on" && directive.arg) {
          eventContext ??= createTransformContext(descriptor!.template!.ast!, {
            expressionPlugins: ["typescript"],
          });
          inlineEvent =
            !isMemberExpression(directive.exp, eventContext) &&
            !isFnExpression(directive.exp, eventContext);
          if (
            inlineEvent &&
            directive.exp.type === 4 &&
            directive.exp.content.includes(";")
          )
            grammar = "statements";
        }
        expressionAst(
          regionFor(directive.exp, true),
          scope,
          grammar,
          inlineEvent,
        );
      } else if (
        directive.name === "bind" &&
        directive.arg?.type === 4 &&
        directive.arg.isStatic
      ) {
        const name = directive.arg.content.replace(
          /-([a-z])/gu,
          (_, char: string) => char.toUpperCase(),
        );
        if (
          !scope.has(name) &&
          (templateImports.has(name) || Object.hasOwn(globals, name))
        )
          fail(
            "A compiler macro cannot escape through v-bind shorthand. Call it with a literal key.",
            directive.loc.start.offset,
          );
      }
    }
    // Component tags, directive identifiers and refs can also consume setup
    // imports without containing an expression; none may escape a macro.
    for (const [name, record] of templateImports) {
      if (locals.has(name)) continue;
      const kebab = name
        .replace(/\B[A-Z]/gu, (char) => `-${char.toLowerCase()}`)
        .toLowerCase();
      if (
        (node.tagType === 1 && (node.tag === name || node.tag === kebab)) ||
        directives.some((directive) => `v-${directive.name}` === kebab)
      ) {
        fail(
          "Compiler macros cannot be used as components or directives. Call them with literal keys.",
          node.loc.start.offset,
        );
      }
      if (node.tagType === 1 && node.tag.startsWith(`${name}.`)) {
        const member = node.tag.slice(name.length + 1).split(".")[0]!;
        if (record.macro || macroExport(record.module, member))
          fail(
            "Compiler macros cannot escape as namespaced components. Call them with literal keys.",
            node.loc.start.offset,
          );
        record.runtimeUse = true;
      }
    }
    for (const prop of node.props) {
      if (
        prop.type === 6 &&
        prop.name === "ref" &&
        prop.value &&
        templateImports.has(prop.value.content) &&
        !locals.has(prop.value.content)
      )
        fail(
          "A compiler macro cannot be used as a template ref.",
          prop.loc.start.offset,
        );
    }
    for (const child of node.children) visitTemplate(child, slotLocals);
  }

  if (
    descriptor?.template &&
    !descriptor.template.src &&
    (!descriptor.template.lang || descriptor.template.lang === "html")
  ) {
    for (const child of descriptor.template.ast?.children ?? [])
      visitTemplate(child, templateShadows);
  }

  for (const script of scripts) {
    const declarations = new Map<
      t.ImportDeclaration,
      Map<t.ImportDeclaration["specifiers"][number], MacroImport>
    >();
    for (const record of script.imports.values()) {
      for (const reference of record.binding.referencePaths) {
        if (record.references.has(reference.node)) continue;
        if (isTypeReference(reference)) {
          record.typeUse = true;
          continue;
        }
        fail(
          "Unsupported compiler-macro reference. Import the macro directly and call it with a literal key instead of exposing a runtime value.",
          script.offset + reference.node.start!,
        );
      }
      const records = declarations.get(record.declaration) ?? new Map();
      records.set(record.specifier, record);
      declarations.set(record.declaration, records);
    }
    for (const [declaration, records] of declarations) {
      const kept = declaration.specifiers.flatMap((specifier) => {
        const record = records.get(specifier);
        if (record && !record.runtimeUse && !record.typeUse) return [];
        const code = script.content.slice(specifier.start!, specifier.end!);
        return [
          {
            specifier,
            code:
              record && !record.runtimeUse && record.typeUse
                ? `type ${code}`
                : code,
            typeOnly: !!record && !record.runtimeUse && record.typeUse,
          },
        ];
      });
      if (
        kept.length === declaration.specifiers.length &&
        kept.every((part) => !part.typeOnly)
      )
        continue;
      const from = script.content.slice(
        declaration.source.start!,
        declaration.source.end!,
      );
      const tail = script.content.slice(
        declaration.source.end!,
        declaration.end!,
      );
      const ordinary = kept.filter(
        (part) => !t.isImportSpecifier(part.specifier),
      );
      const named = kept.filter((part) => t.isImportSpecifier(part.specifier));
      const imports = [
        ...ordinary.filter((part) => !part.typeOnly).map((part) => part.code),
        ...(named.length
          ? [`{ ${named.map((part) => part.code).join(", ")} }`]
          : []),
      ];
      const typeNamespaces = ordinary
        .filter((part) => part.typeOnly)
        .map(
          (part) =>
            `import type ${script.content.slice(part.specifier.start!, part.specifier.end!)} from ${from};\n`,
        )
        .join("");
      const replacement = imports.length
        ? `import ${imports.join(", ")} from ${from}${tail}`
        : `import ${from}${tail}`;
      output.overwrite(
        script.offset + declaration.start!,
        script.offset + declaration.end!,
        typeNamespaces + replacement,
      );
      changed = true;
    }
    if (script.helpers.size) {
      const names = [...script.helpers]
        .map(([name, local]) => `${name} as ${local}`)
        .join(", ");
      // Inserted imports intentionally have no invented original call location.
      const position = script.ast.program.interpreter?.end ?? 0;
      output.appendLeft(
        script.offset + position,
        `\nimport { ${names} } from ${JSON.stringify(options.facade)};\n`,
      );
    }
  }
  if (usedGroups.size && options.groupImports) {
    const imports = groupImportCode(usedGroups);
    const script =
      extension === ".vue" ? (setupScript ?? normalScript) : scripts[0];
    if (script) {
      output.appendLeft(
        script.offset + (script.ast.program.interpreter?.end ?? 0),
        `\n${imports}\n`,
      );
    } else {
      // Template-only SFC (external/preprocessed scripts with macros were rejected above).
      output.append(`\n<script>\n${imports}\n</script>\n`);
    }
    changed = true;
  }
  if (!changed) return null;
  return transformResult(output, id, source);
}

function groupImportCode(groups: Iterable<string>): string {
  return [...groups]
    .sort()
    .map((group) => `import ${JSON.stringify(groupModulePrefix + group)};`)
    .join("\n");
}

function transformResult(
  output: MagicString,
  id: string,
  source: string,
): TransformResult {
  const map = output.generateMap({
    source: id,
    includeContent: true,
    hires: true,
  });
  return {
    code: output.toString(),
    map: Object.assign(map, { sourcesContent: map.sourcesContent ?? [source] }),
  };
}

// A quoted catalog key: camelCase segments joined by dots, without interpolation.
const keyLiteral = /(["'`])([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*)\1/gu;

/**
 * Runtime mode: import the group of every string literal naming a catalog key, so literal calls and
 * finite literal-key maps load their groups implicitly. Keys assembled at run time still need
 * an explicit `loadTexts()`. Calls are not rewritten.
 */
export function importLiteralKeyGroups(
  source: string,
  id: string,
  snapshot: TextCatalogSnapshot,
): TransformResult | null {
  if (
    /[?#\0]/u.test(id) ||
    id.startsWith("virtual:") ||
    /[/\\]node_modules[/\\]/u.test(id)
  )
    return null;
  const extension = extname(id);
  if (extension !== ".vue" && !Object.hasOwn(scriptExtensions, extension))
    return null;
  const groups = new Set<string>();
  for (const [, , key] of source.matchAll(keyLiteral))
    if (Object.hasOwn(snapshot.texts, key!)) groups.add(catalogGroup(key!));
  if (!groups.size) return null;
  const imports = groupImportCode(groups);
  const output = new MagicString(source);
  if (extension === ".vue") {
    const { descriptor } = parseSfc(source, { filename: id });
    const block = descriptor.scriptSetup ?? descriptor.script;
    if (block) {
      // External or preprocessed scripts cannot take an import; such components load explicitly.
      if (block.src || !Object.hasOwn(scriptLanguages, block.lang ?? "js"))
        return null;
      output.appendLeft(block.loc.start.offset, `\n${imports}\n`);
    } else output.append(`\n<script>\n${imports}\n</script>\n`);
  } else {
    const line = source.indexOf("\n");
    const start = !source.startsWith("#!")
      ? 0
      : line < 0
        ? source.length
        : line + 1;
    output.appendLeft(start, `${imports}\n`);
  }
  return transformResult(output, id, source);
}
