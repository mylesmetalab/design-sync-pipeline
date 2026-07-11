import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Project, SyntaxKind, type SourceFile, type ObjectLiteralExpression } from "ts-morph";
import type { Edit, EditResult, PipelineEngine } from "../types.js";
import type { CodeTarget } from "../config.js";

/**
 * AST-based JSX text-content write engine. Pairs with the Figma plugin's
 * `characters` write to make `kind: "copy"` drift round-trippable.
 *
 * What it does: walks every `.tsx` / `.jsx` `codeTargets` entry, finds
 * JSX text whose trimmed value equals the edit's `oldValue`, and
 * rewrites it to `newValue`. Two text shapes are recognized:
 *
 *   - **JsxText** — the bare text child between tags: `<span>Hello</span>`
 *   - **JsxExpression wrapping a StringLiteral** — `<span>{"Hello"}</span>`
 *
 * Dynamic children (`{props.label}`, template strings, conditionals) are
 * intentionally skipped. The engine refuses with a clear message when no
 * static text matches, rather than guessing where to write the value;
 * that's the same trade-off `code-tsx-inline` makes for non-literal style
 * values.
 *
 * Why `oldValue` rather than `target.path` + node lookup: the addon's
 * drift report doesn't know the source file. Matching by text content
 * works across the whole target set in one pass and doubles as a stale-
 * check — if the code has drifted since the snapshot, the old value
 * isn't there to replace and the engine refuses.
 */

const TSX_EXTS = [".tsx", ".jsx"];

function isTsxTarget(t: CodeTarget): boolean {
  return TSX_EXTS.some((ext) => t.path.endsWith(ext));
}

const ENGINE_NAME = "code-tsx-text";

interface FileReplacement {
  file: string;
  count: number;
  before: string;
  after: string;
}

function reject(id: string, message: string): EditResult {
  return { id, status: "rejected", engine: ENGINE_NAME, message };
}

function applied(id: string, message: string, diff?: string): EditResult {
  return diff
    ? { id, status: "applied", engine: ENGINE_NAME, message, diff }
    : { id, status: "applied", engine: ENGINE_NAME, message };
}

function noOp(id: string, message: string): EditResult {
  return { id, status: "no_op", engine: ENGINE_NAME, message };
}

/**
 * Map a Storybook story id to its expected named export. Storybook IDs
 * are kebab-case `<title>--<storyName>`; the export symbol is the
 * PascalCased part after `--`. So:
 *   molecules-rowbutton--state-default → "StateDefault"
 *   atoms-caret--default               → "Default"
 *
 * Returns null when the id doesn't follow the convention (e.g. legacy
 * stories with custom ids); the engine then skips the story-args path
 * for that edit.
 */
function storyIdToExportName(storyId: string | undefined): string | null {
  if (!storyId) return null;
  const idx = storyId.indexOf("--");
  if (idx === -1) return null;
  const tail = storyId.slice(idx + 2);
  if (!tail) return null;
  return tail
    .split("-")
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
}

/**
 * Derive the conventional sibling story-file path for a component file.
 * `Foo.tsx` → `Foo.stories.tsx` (and `.ts` variant). Returns whichever
 * exists, or null when neither does. Picking up other layouts (e.g. a
 * `Foo/index.stories.tsx`) is out of scope for v0 — the consumer can
 * add an explicit codeTarget if needed.
 */
function findStoryFile(cwd: string, componentPath: string): string | null {
  const stripped = componentPath.replace(/\.(tsx|jsx|ts|js)$/, "");
  const candidates = [`${stripped}.stories.tsx`, `${stripped}.stories.ts`];
  for (const c of candidates) {
    const abs = resolve(cwd, c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Rewrite string args on a single named story export. Walks the export's
 * initializer for an `args: { … }` property and replaces any string
 * property whose value equals `oldValue`. Returns the number of
 * replacements made.
 *
 * Why this exists: the canonical source of a component's display text
 * is often a story arg (`args: { label: 'randomize' }`) rather than a
 * literal JSX child. Without this path, copy round-trip works in only
 * one direction (push code → Figma) and `Update code` rejects with
 * "no static JSX text found" — accurate but useless when the truth
 * lives one file over.
 */
function rewriteStoryArgs(
  source: SourceFile,
  exportName: string,
  oldValue: string,
  newValue: string,
): number {
  const exportDecl = source
    .getVariableStatements()
    .find((vs) => vs.getDeclarations().some((d) => d.getName() === exportName));
  if (!exportDecl) return 0;

  const decl = exportDecl
    .getDeclarations()
    .find((d) => d.getName() === exportName);
  if (!decl) return 0;
  const init = decl.getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return 0;
  const obj = init as ObjectLiteralExpression;

  // Find the `args` property within the story export object.
  const argsProp = obj
    .getProperties()
    .find(
      (p) =>
        p.getKind() === SyntaxKind.PropertyAssignment &&
        (p as { getNameNode: () => { getText: () => string } })
          .getNameNode()
          .getText() === "args",
    );
  if (!argsProp) return 0;
  const argsInit = (argsProp as { getInitializer: () => { getKind: () => SyntaxKind } | undefined }).getInitializer?.();
  if (!argsInit || argsInit.getKind() !== SyntaxKind.ObjectLiteralExpression) return 0;
  const argsObj = argsInit as ObjectLiteralExpression;

  let count = 0;
  for (const prop of argsObj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pa = prop as { getInitializer: () => { getKind: () => SyntaxKind; getText: () => string; replaceWithText: (s: string) => void } | undefined };
    const propInit = pa.getInitializer();
    if (!propInit || propInit.getKind() !== SyntaxKind.StringLiteral) continue;
    const raw = propInit.getText();
    const unquoted = raw.slice(1, -1);
    if (unquoted !== oldValue) continue;
    const quote = raw[0];
    propInit.replaceWithText(`${quote}${newValue}${quote}`);
    count++;
  }
  return count;
}

export function createTsxTextEngine(
  cwd: string,
  targets: CodeTarget[],
): PipelineEngine {
  const tsxTargets = targets.filter(isTsxTarget);

  return {
    info: {
      name: ENGINE_NAME,
      description:
        "Rewrites static JSX text children in .tsx/.jsx files. Pairs with the Figma plugin's characters write so `copy` drift is round-trippable.",
      handles: [{ kind: "copy", scope: "code" }],
      idempotent: true,
      writeCapable: true,
    },
    canHandle(edit: Edit): boolean {
      return (
        edit.kind === "copy" &&
        edit.scope === "code" &&
        typeof edit.oldValue === "string" &&
        typeof edit.newValue === "string" &&
        edit.oldValue.length > 0 &&
        tsxTargets.length > 0
      );
    },
    async apply(edit: Edit): Promise<EditResult> {
      if (tsxTargets.length === 0) {
        return reject(edit.id, "No TSX/JSX paths in codeTargets.");
      }
      if (edit.oldValue === edit.newValue) {
        return noOp(edit.id, "oldValue equals newValue.");
      }

      const project = new Project({
        useInMemoryFileSystem: false,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, jsx: 2 /* JsxEmit.React */ },
      });

      const replacements: FileReplacement[] = [];
      const exportName = storyIdToExportName(edit.target.storyId);

      for (const target of tsxTargets) {
        const absPath = resolve(cwd, target.path);
        let source: SourceFile;
        try {
          source = project.addSourceFileAtPath(absPath);
        } catch {
          // Missing files are non-fatal — same convention as code-tsx-inline.
          continue;
        }

        let count = 0;

        // 1. JsxText nodes — bare text children. ts-morph normalizes leading/
        //    trailing whitespace; compare on trimmed text. The replacement
        //    preserves surrounding whitespace by re-stringifying via setLiteralValue.
        for (const jsxText of source.getDescendantsOfKind(SyntaxKind.JsxText)) {
          const raw = jsxText.getText();
          if (raw.trim() !== edit.oldValue) continue;
          // Preserve the indentation around the literal — replace only the
          // visible token, not the whitespace bracketing it.
          const newRaw = raw.replace(edit.oldValue, edit.newValue);
          jsxText.replaceWithText(newRaw);
          count++;
        }

        // 2. JsxExpression wrapping a StringLiteral — `<span>{"Hello"}</span>`.
        for (const expr of source.getDescendantsOfKind(SyntaxKind.JsxExpression)) {
          // Only consider expressions whose parent is a JSX element (i.e. they
          // are a child). Attribute expressions also use JsxExpression and we
          // don't want to touch those.
          const parent = expr.getParent();
          const parentKind = parent?.getKind();
          if (
            parentKind !== SyntaxKind.JsxElement &&
            parentKind !== SyntaxKind.JsxFragment
          ) {
            continue;
          }
          const inner = expr.getExpression();
          if (!inner || inner.getKind() !== SyntaxKind.StringLiteral) continue;
          const literalText = (inner.getText().match(/^"(.*)"$|^'(.*)'$/) ?? [])[0];
          if (!literalText) continue;
          const unquoted = literalText.slice(1, -1);
          if (unquoted !== edit.oldValue) continue;
          // Use the source quote style so the diff stays minimal.
          const quote = literalText[0];
          inner.replaceWithText(`${quote}${edit.newValue}${quote}`);
          count++;
        }

        if (count > 0) {
          const before = edit.oldValue;
          const after = edit.newValue;
          replacements.push({ file: target.path, count, before, after });
        }

        // Sibling story-file pass — when the component carries a dynamic
        // child (`{label}`) the canonical text is usually in a co-located
        // `.stories.tsx` args object. Skip if no storyId on the edit or
        // the file doesn't exist (lots of codeTargets don't have stories).
        if (exportName) {
          const storyPath = findStoryFile(cwd, target.path);
          if (storyPath) {
            let storyFile: SourceFile;
            try {
              storyFile = project.addSourceFileAtPath(storyPath);
            } catch {
              continue;
            }
            const storyCount = rewriteStoryArgs(
              storyFile,
              exportName,
              edit.oldValue,
              edit.newValue,
            );
            if (storyCount > 0) {
              replacements.push({
                file: storyPath.replace(cwd + "/", ""),
                count: storyCount,
                before: edit.oldValue,
                after: edit.newValue,
              });
            }
          }
        }
      }

      if (replacements.length === 0) {
        const tail = exportName
          ? ` Also checked sibling .stories.tsx files for an \`args\` entry under \`${exportName}\` — no match there either.`
          : "";
        return reject(
          edit.id,
          `No static JSX text matching "${edit.oldValue}" found across ${tsxTargets.length} TSX target(s).${tail} Code may have drifted since the snapshot — re-run Check drift, or the text may be dynamic (props/template) and needs a manual edit.`,
        );
      }

      if (edit.dryRun) {
        return {
          id: edit.id,
          status: "no_op",
          engine: ENGINE_NAME,
          message: `Dry-run. Would rewrite "${edit.oldValue}" → "${edit.newValue}" in ${replacements.length} file(s) (${replacements.reduce((a, r) => a + r.count, 0)} occurrence(s)).`,
          diff: replacements.map((r) => `${r.file}: ${r.count}× "${r.before}" → "${r.after}"`).join("\n"),
        };
      }

      try {
        await project.save();
      } catch (err: unknown) {
        return reject(edit.id, `Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      return applied(
        edit.id,
        `Rewrote "${edit.oldValue}" → "${edit.newValue}" in ${replacements.length} file(s) (${replacements.reduce((a, r) => a + r.count, 0)} occurrence(s)).`,
        replacements.map((r) => `${r.file}: ${r.count}× "${r.before}" → "${r.after}"`).join("\n"),
      );
    },
  };
}
