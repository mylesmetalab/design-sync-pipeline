import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Edit, EditResult, PipelineEngine } from "../types.js";
import type { CodeTarget } from "../config.js";

/**
 * Deterministic CSS token-swap engine.
 *
 * Handles `token-binding` edits in the `code` scope. Given an edit like
 *   { property: "border-radius", oldValue: "radius/xl", newValue: "radius/lg",
 *     target: { selector: ".icon-button" } }
 *
 * the engine:
 *   1. Loads each configured CodeTarget
 *   2. If the target has a `scopeSelector`, narrows to that CSS rule
 *   3. Replaces `var(--radius-xl)` references with `var(--radius-lg)`
 *      (token names are kebabified: "radius/xl" → "--radius-xl")
 *   4. Verifies oldValue is actually present before touching anything
 *   5. Writes the file (unless dryRun) and returns a unified-diff-shaped
 *      summary of what changed
 *
 * Refuses to apply if:
 *   - No CodeTarget is configured
 *   - The configured file doesn't contain the old token reference
 *   - `target.selector` doesn't match any configured CodeTarget's scopeSelector
 *
 * Idempotent: applying twice (with the second oldValue=newValue) is a no-op.
 */
export function createCssTokenSwapEngine(
  cwd: string,
  targets: CodeTarget[],
): PipelineEngine {
  return {
    info: {
      name: "code-css-token-swap",
      description: "Replaces var(--<old-token>) with var(--<new-token>) in a configured CSS file. Deterministic, idempotent.",
      handles: [{ kind: "token-binding", scope: "code" }],
      idempotent: true,
      writeCapable: true,
    },
    canHandle(edit: Edit): boolean {
      return (
        edit.scope === "code" &&
        edit.kind === "token-binding" &&
        typeof edit.oldValue === "string" &&
        typeof edit.newValue === "string"
      );
    },
    async apply(edit: Edit): Promise<EditResult> {
      if (targets.length === 0) {
        return {
          id: edit.id,
          status: "rejected",
          engine: "code-css-token-swap",
          message: "No codeTargets configured.",
        };
      }

      const oldVar = tokenNameToCssVar(edit.oldValue);
      const newVar = tokenNameToCssVar(edit.newValue);
      if (oldVar === newVar) {
        return {
          id: edit.id,
          status: "no_op",
          engine: "code-css-token-swap",
          message: `Token names resolve to the same CSS variable: ${oldVar}`,
        };
      }

      // Filter targets to those matching the edit's selector (if specified).
      const candidateTargets = edit.target.selector
        ? targets.filter((t) => !t.scopeSelector || t.scopeSelector === edit.target.selector)
        : targets;

      if (candidateTargets.length === 0) {
        return {
          id: edit.id,
          status: "rejected",
          engine: "code-css-token-swap",
          message: `No codeTargets match selector "${edit.target.selector ?? ""}".`,
        };
      }

      const diffs: string[] = [];
      let touched = false;

      for (const target of candidateTargets) {
        const fullPath = resolve(cwd, target.path);
        const before = await readFile(fullPath, "utf8");

        const editResult = applyTokenSwap({
          source: before,
          oldVar,
          newVar,
          scopeSelector: target.scopeSelector,
        });

        if (editResult.replacements === 0) continue;

        touched = true;
        diffs.push(formatDiff(target.path, before, editResult.next, editResult.replacements));

        if (!edit.dryRun) {
          await writeFile(fullPath, editResult.next, "utf8");
        }
      }

      if (!touched) {
        return {
          id: edit.id,
          status: "no_op",
          engine: "code-css-token-swap",
          message: `No occurrences of ${oldVar} found in the configured targets.`,
        };
      }

      return {
        id: edit.id,
        status: edit.dryRun ? "no_op" : "applied",
        engine: "code-css-token-swap",
        message: edit.dryRun
          ? `Would replace ${oldVar} → ${newVar}.`
          : `Replaced ${oldVar} → ${newVar}.`,
        diff: diffs.join("\n"),
      };
    },
  };
}

/**
 * Convert a Figma token name like "radius/xl" or "color/accent/blue" to the
 * conventional CSS custom property name "--radius-xl" / "--color-accent-blue".
 *
 * Replaces "/" with "-", lowercases. Conservative — front doors that need
 * different naming conventions can pre-transform before sending the edit.
 */
function tokenNameToCssVar(token: string): string {
  return "--" + token.replace(/\//g, "-").toLowerCase();
}

interface SwapResult {
  next: string;
  replacements: number;
}

function applyTokenSwap(input: {
  source: string;
  oldVar: string;
  newVar: string;
  scopeSelector?: string | undefined;
}): SwapResult {
  const { source, oldVar, newVar, scopeSelector } = input;

  // Pattern: var(--name) — capture the closing paren so we don't accidentally
  // match a longer-prefixed token (e.g. var(--radius-xl-foo)).
  const escaped = oldVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`var\\(\\s*${escaped}\\s*\\)`, "g");

  if (!scopeSelector) {
    let count = 0;
    const next = source.replace(pattern, () => {
      count++;
      return `var(${newVar})`;
    });
    return { next, replacements: count };
  }

  // Scope-aware: only replace inside the rule(s) whose selector list contains
  // `scopeSelector`. We do a balanced-brace scan rather than a full CSS parse
  // — sufficient for hand-written CSS without nested at-rules in the rule body.
  let count = 0;
  let i = 0;
  let out = "";

  while (i < source.length) {
    const braceStart = source.indexOf("{", i);
    if (braceStart === -1) {
      out += source.slice(i);
      break;
    }

    // The selector list is whatever's between `i` and `braceStart`.
    const selectorList = source.slice(i, braceStart);
    const selectorMatches = selectorList
      .split(",")
      .some((s) => s.trim() === scopeSelector || s.trim().endsWith(scopeSelector));

    // Find matching closing brace, respecting nested braces.
    let depth = 1;
    let j = braceStart + 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth > 0) j++;
    }
    const ruleBody = source.slice(braceStart + 1, j);
    const after = source.slice(j); // includes the closing "}"

    if (selectorMatches) {
      const replaced = ruleBody.replace(pattern, () => {
        count++;
        return `var(${newVar})`;
      });
      out += selectorList + "{" + replaced;
    } else {
      out += selectorList + "{" + ruleBody;
    }

    out += after.charAt(0); // the closing brace
    i = j + 1;
  }

  return { next: out, replacements: count };
}

function formatDiff(
  path: string,
  before: string,
  after: string,
  replacements: number,
): string {
  // We're not generating a real unified diff — for v0 a summary of what
  // changed is enough. Front doors render this verbatim.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const changedLines: string[] = [];
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) {
      if (beforeLines[i] !== undefined) changedLines.push(`- ${beforeLines[i]}`);
      if (afterLines[i] !== undefined) changedLines.push(`+ ${afterLines[i]}`);
    }
  }
  return `${path} (${replacements} replacement${replacements === 1 ? "" : "s"})\n${changedLines.join("\n")}`;
}
