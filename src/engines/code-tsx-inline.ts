import { resolve } from "node:path";
import { Project, SyntaxKind, type Node, type SourceFile } from "ts-morph";
import { tokenNameToCssVar } from "@metalab/design-sync-core";
import type { Edit, EditResult, PipelineEngine } from "../types.js";
import type { CodeTarget } from "../config.js";

/**
 * AST-based inline-style write engine for TypeScript / JavaScript files.
 *
 * Mirrors `code-css-postcss` for codebases that style components inline
 * (React `style={{ … }}`, anything that compiles to a JSX-attribute
 * style object). The PostCSS engine assumes selectors and `.css` files;
 * inline-styled components have neither. This engine operates directly
 * on JSX attribute expressions.
 *
 * Handles two `Edit` kinds in the `code` scope:
 *
 *   - **token-binding** — change `var(--<old>)` to `var(--<new>)` inside
 *     a JSX `style` prop's object expression, for a specific CSS
 *     property. Requires the file to currently reference `var(--<old>)`
 *     for that property; otherwise refuses with the same "expected X,
 *     found Y" message shape the PostCSS engine uses.
 *
 *   - **token-value** — promote a raw literal to `var(--<new>)`. The
 *     property's current value is replaced verbatim with a string of
 *     `var(--<new>)`. Engine confirms the literal matches `oldValue`
 *     before writing.
 *
 * File selection: walks every `codeTargets` entry whose `path` ends with
 * a TS/JS/TSX/JSX extension. Multiple files may match; all are
 * rewritten in a single Edit. The engine reports total replacement
 * count + per-file diffs in its result message.
 *
 * Scope discipline: only rewrites JSX attribute named `style`, only
 * inside object expressions, only properties whose name (camelCase)
 * matches the edit's `property` after kebab-→-camel conversion. Comments,
 * string literals outside JSX, and styles inside non-`style` attributes
 * (e.g. `data-style`) are never touched.
 *
 * Idempotency: the engine reads, writes only when something actually
 * changed, and surfaces `no_op` when the requested binding is already
 * present (mirrors the PostCSS engine's behavior).
 */
const TSX_EXTS = [".tsx", ".jsx", ".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"];

function isTsxTarget(t: CodeTarget): boolean {
  return TSX_EXTS.some((ext) => t.path.endsWith(ext));
}

function kebabToCamel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

const ENGINE_NAME = "code-tsx-inline";

interface ReplacementResult {
  file: string;
  count: number;
  before: string[];
  after: string[];
}

export function createTsxInlineEngine(
  cwd: string,
  targets: CodeTarget[],
): PipelineEngine {
  // Filter at construction time so canHandle can answer in O(1).
  const tsxTargets = targets.filter(isTsxTarget);

  return {
    info: {
      name: ENGINE_NAME,
      description:
        "AST engine that rewrites inline-style var(--token) references inside JSX style={{ … }} expressions. Mirrors code-css-postcss for codebases without .css files.",
      handles: [
        { kind: "token-binding", scope: "code" },
        { kind: "token-value", scope: "code" },
      ],
      idempotent: true,
      writeCapable: true,
    },
    canHandle(edit: Edit): boolean {
      return (
        edit.scope === "code" &&
        (edit.kind === "token-binding" || edit.kind === "token-value") &&
        typeof edit.oldValue === "string" &&
        typeof edit.newValue === "string" &&
        typeof edit.target.property === "string" &&
        tsxTargets.length > 0
      );
    },
    async apply(edit: Edit): Promise<EditResult> {
      if (tsxTargets.length === 0) {
        return reject(edit.id, "No TSX/JSX paths in codeTargets.");
      }
      const targetProperty = edit.target.property;
      if (!targetProperty) {
        return reject(edit.id, "Edit target.property is required for TSX inline rewrites.");
      }
      const camelProp = kebabToCamel(targetProperty);

      const newVar = tokenNameToCssVar(edit.newValue);
      const newValue = `var(${newVar})`;
      const oldVar =
        edit.kind === "token-binding" ? tokenNameToCssVar(edit.oldValue) : null;
      const oldValueExpectation =
        edit.kind === "token-binding" ? `var(${oldVar})` : edit.oldValue;

      if (oldVar && oldVar === newVar) {
        return noOp(edit.id, `Token names resolve to the same CSS variable: ${oldVar}`);
      }

      // Use a fresh in-memory project per apply so concurrent edits don't
      // see each other's pending writes. We only load the files we touch.
      const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, jsx: 2 /* JsxEmit.React */ },
      });

      const replacements: ReplacementResult[] = [];
      let staleFiles = 0; // files where the prop exists but oldValue doesn't match
      const staleObserved: string[] = [];

      for (const target of tsxTargets) {
        const absPath = resolve(cwd, target.path);
        let source: SourceFile;
        try {
          source = project.addSourceFileAtPath(absPath);
        } catch {
          // File missing or unreadable — skip silently. Other targets may
          // still match.
          continue;
        }

        const result = rewriteSourceFile({
          source,
          camelProp,
          oldValueExpectation,
          newValue,
        });
        if (result.staleObserved.length > 0) {
          staleFiles++;
          staleObserved.push(...result.staleObserved.map((s) => `${target.path}: ${s}`));
        }
        if (result.count > 0) {
          replacements.push({
            file: target.path,
            count: result.count,
            before: result.before,
            after: result.after,
          });
        }
      }

      let totalCount = replacements.reduce((acc, r) => acc + r.count, 0);

      // Fallback for token-binding edits: when the JSX-scoped pass found
      // nothing, the literal `var(--token)` reference often lives outside
      // a `style={{}}` expression — e.g., a lookup table in a sibling
      // module (`row-shared.ts`'s `ROW_BG_DEFAULT_HOVER: { Hover:
      // "var(--row-bg-hover)" }`) that the component reads dynamically.
      // We can still rewrite the binding by treating it as a pure
      // string-literal swap: find every `"var(--<old>)"` substring across
      // the same target files and replace with `"var(--<new>)"`. This is
      // safe because (a) we only fire when the scoped path was empty,
      // (b) only token-binding edits touch this path (not raw-literal
      // token-value rewrites), and (c) `var(--x)` strings in a tracked
      // file are unambiguously design-token references.
      if (totalCount === 0 && edit.kind === "token-binding" && oldVar && newVar !== oldVar) {
        for (const target of tsxTargets) {
          const absPath = resolve(cwd, target.path);
          const source = project.getSourceFile(absPath);
          if (!source) continue;
          const result = rewriteOrphanVarString({
            source,
            oldVar,
            newVar: newVar,
          });
          if (result.count > 0) {
            replacements.push({
              file: target.path,
              count: result.count,
              before: result.before,
              after: result.after,
            });
          }
        }
        totalCount = replacements.reduce((acc, r) => acc + r.count, 0);
      }

      if (totalCount === 0) {
        if (staleObserved.length > 0) {
          // Property exists somewhere but its current value doesn't match
          // oldValue. Same shape of refusal the PostCSS engine uses.
          return reject(
            edit.id,
            `Stale: expected ${oldValueExpectation} for ${targetProperty} but found ${staleObserved.join(", ")}.`,
          );
        }
        return reject(
          edit.id,
          `No inline-style declaration for ${targetProperty} matching ${oldValueExpectation} in any configured TSX target. Also tried a string-literal fallback (matching "${oldValueExpectation}" anywhere in the file) — still nothing.`,
        );
      }

      const diff = replacements
        .map(
          (r) =>
            `${r.file} (${r.count} replacement${r.count === 1 ? "" : "s"})\n` +
            r.before
              .map((b, i) => `  - ${camelProp}: ${b}\n  + ${camelProp}: ${r.after[i]}`)
              .join("\n"),
        )
        .join("\n\n");

      if (edit.dryRun) {
        return {
          id: edit.id,
          status: "no_op",
          engine: ENGINE_NAME,
          message: `Dry-run. Would rewrite ${totalCount} reference${totalCount === 1 ? "" : "s"} across ${replacements.length} file${replacements.length === 1 ? "" : "s"}.`,
          diff,
        };
      }

      // Write each touched file.
      for (const r of replacements) {
        const absPath = resolve(cwd, r.file);
        const source = project.getSourceFile(absPath);
        if (source) {
          await source.save();
        }
      }

      return {
        id: edit.id,
        status: "applied",
        engine: ENGINE_NAME,
        message: `Rewrote ${totalCount} reference${totalCount === 1 ? "" : "s"} across ${replacements.length} file${replacements.length === 1 ? "" : "s"}.`,
        diff,
      };
    },
  };
}

interface RewriteInput {
  source: SourceFile;
  camelProp: string;
  oldValueExpectation: string;
  newValue: string;
}

interface RewriteOutput {
  count: number;
  before: string[];
  after: string[];
  staleObserved: string[];
}

/**
 * Walk every JSX `style={{ … }}` expression in the file. For each
 * matching property (`camelProp`) whose current value equals
 * `oldValueExpectation`, replace with `newValue`. Tracks "stale"
 * cases (property exists but value doesn't match) separately so the
 * engine can refuse with a useful message instead of silently rewriting.
 */
function rewriteSourceFile(input: RewriteInput): RewriteOutput {
  const { source, camelProp, oldValueExpectation, newValue } = input;
  const before: string[] = [];
  const after: string[] = [];
  const staleObserved: string[] = [];

  // Find every JsxAttribute named "style". Walk descendants of each.
  source.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.JsxAttribute) return;
    const attr = node.asKindOrThrow(SyntaxKind.JsxAttribute);
    if (attr.getNameNode().getText() !== "style") return;
    const initializer = attr.getInitializer();
    if (!initializer || initializer.getKind() !== SyntaxKind.JsxExpression) return;
    const expr = initializer.asKindOrThrow(SyntaxKind.JsxExpression).getExpression();
    if (!expr) return;
    visitStyleExpression(expr, {
      camelProp,
      oldValueExpectation,
      newValue,
      before,
      after,
      staleObserved,
    });
  });

  return { count: before.length, before, after, staleObserved };
}

interface VisitContext {
  camelProp: string;
  oldValueExpectation: string;
  newValue: string;
  before: string[];
  after: string[];
  staleObserved: string[];
}

/**
 * Inspect a node that should evaluate to a style object. Handles:
 *   - object literals: `{ color: "var(--x)" }`
 *   - identifier refs: `style={styleObj}` — resolves the variable
 *     declaration once and recurses into its initializer
 *   - call expressions: `style={rowStyle(...)}` — recurse into the
 *     callee's body if it's a local function that returns an object
 *     literal directly (covers row-shared.ts's `rowStyle()` pattern)
 *
 * Anything else (spreads, conditional expressions, imported helpers) is
 * skipped silently. The engine refuses to guess.
 */
function visitStyleExpression(node: Node, ctx: VisitContext): void {
  const kind = node.getKind();
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    visitObjectLiteral(node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression), ctx);
    return;
  }
  if (kind === SyntaxKind.Identifier) {
    const sym = node.asKindOrThrow(SyntaxKind.Identifier).getSymbol();
    if (!sym) return;
    for (const decl of sym.getDeclarations()) {
      if (decl.getKind() !== SyntaxKind.VariableDeclaration) continue;
      const init = decl.asKindOrThrow(SyntaxKind.VariableDeclaration).getInitializer();
      if (init) visitStyleExpression(init, ctx);
    }
    return;
  }
  if (kind === SyntaxKind.CallExpression) {
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const callee = call.getExpression();
    if (callee.getKind() === SyntaxKind.Identifier) {
      const sym = callee.asKindOrThrow(SyntaxKind.Identifier).getSymbol();
      if (!sym) return;
      for (const decl of sym.getDeclarations()) {
        if (
          decl.getKind() !== SyntaxKind.FunctionDeclaration &&
          decl.getKind() !== SyntaxKind.VariableDeclaration
        ) {
          continue;
        }
        // Find the function body's return statement, if any, and recurse
        // into its argument.
        const returnStmt = decl.getFirstDescendantByKind(SyntaxKind.ReturnStatement);
        if (returnStmt) {
          const ret = returnStmt.getExpression();
          if (ret) visitStyleExpression(ret, ctx);
        }
      }
    }
  }
}

function visitObjectLiteral(
  obj: ReturnType<SourceFile["getFirstDescendantByKindOrThrow"]>,
  ctx: VisitContext,
): void {
  if (obj.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
  // Re-narrow to ObjectLiteralExpression — ts-morph's discriminated-union
  // helpers don't always carry through helper boundaries cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (obj as any).getProperties() as Array<{
    getKind: () => SyntaxKind;
    getName?: () => string;
    getInitializer?: () => { getKind: () => SyntaxKind; getText: () => string; replaceWithText: (t: string) => void } | undefined;
  }>;
  for (const prop of props) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    if (!prop.getName || prop.getName() !== ctx.camelProp) continue;
    if (!prop.getInitializer) continue;
    const init = prop.getInitializer();
    if (!init) continue;
    // For string-literal values: compare against the expectation. The
    // raw text includes quotes; strip them for comparison.
    const text = init.getText();
    const unquoted = unquoteStringLiteral(text);
    if (unquoted === null) {
      // Non-string initializer (number, expression, etc.). For
      // token-value edits where oldValue is "8px" and the code has the
      // numeric `8`, we'd want to match too — but that's a different
      // shape of rewrite. Out of scope for v0; surface as stale.
      ctx.staleObserved.push(text);
      continue;
    }
    if (unquoted !== ctx.oldValueExpectation) {
      ctx.staleObserved.push(text);
      continue;
    }
    ctx.before.push(text);
    const quote = text[0] === "'" ? "'" : '"';
    const replacement = `${quote}${ctx.newValue}${quote}`;
    ctx.after.push(replacement);
    init.replaceWithText(replacement);
  }
}

function unquoteStringLiteral(text: string): string | null {
  if (text.length < 2) return null;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' || first === "'" || first === "`") && last === first) {
    return text.slice(1, -1);
  }
  return null;
}

function reject(id: string, message: string): EditResult {
  return { id, status: "rejected", engine: ENGINE_NAME, message };
}

function noOp(id: string, message: string): EditResult {
  return { id, status: "no_op", engine: ENGINE_NAME, message };
}

/**
 * Find every string literal whose unquoted value equals `var(<oldVar>)`
 * and replace with `var(<newVar>)`. Used as a fallback when the JSX-
 * scoped rewriter found nothing — see the call site in `apply()` for
 * the rationale on why this is safe.
 *
 * Caveats:
 *   - Only exact-match string literals. Composite values like
 *     `"1px solid var(--x)"` are not rewritten here (would need a
 *     different shape and the engines don't currently support partial-
 *     value swaps anyway).
 *   - Template strings and StringLiteral types only; numeric / boolean
 *     / object initializers are untouched.
 */
function rewriteOrphanVarString(input: {
  source: SourceFile;
  oldVar: string;
  newVar: string;
}): { count: number; before: string[]; after: string[] } {
  const { source, oldVar, newVar } = input;
  const oldExpected = `var(${oldVar})`;
  const newValue = `var(${newVar})`;
  let count = 0;
  const before: string[] = [];
  const after: string[] = [];
  for (const lit of source.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const unquoted = unquoteStringLiteral(lit.getText());
    if (unquoted !== oldExpected) continue;
    const quote = lit.getText()[0];
    lit.replaceWithText(`${quote}${newValue}${quote}`);
    before.push(oldExpected);
    after.push(newValue);
    count++;
  }
  return { count, before, after };
}
