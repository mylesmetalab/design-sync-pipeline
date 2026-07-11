import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss, { type Root, type Rule, type Declaration } from "postcss";
import {
  deriveSelectorChain,
  isSingleValue,
  tokenNameToCssVar,
} from "@metalab/design-sync-core";
import type { Edit, EditResult, PipelineEngine } from "../types.js";
import type { CodeTarget } from "../config.js";

/**
 * PostCSS-AST-based CSS token-swap engine. Replaces the regex-based
 * `code-css-token-swap` engine that accumulated four overlapping
 * fallback paths (cascade fallback, property scoping, declaration
 * rewrite, single-value safety guard). The AST gives those properties
 * for free; each is now one straight-line code path, not a separate
 * fallback layer.
 *
 * Handles two `Edit` kinds in the `code` scope:
 *
 *   - **token-binding** — change `var(--<old>)` to `var(--<new>)` inside
 *     a specific rule's specific property. Requires the file to currently
 *     contain `var(--<old>)` for that property; otherwise refuses with a
 *     clear "expected X, found Y" message. (Stricter than the legacy
 *     engine; see notes below.)
 *
 *   - **token-value** — promote a raw CSS literal to `var(--<new>)`.
 *     `oldValue` carries the literal the addon read from the file; the
 *     engine still asserts the current decl value is a single-token value
 *     (no top-level whitespace outside parentheses) so we never clobber
 *     a multi-slot shorthand like `border: 1px solid red`.
 *
 * Selector resolution: when the edit's `selector` doesn't have a rule
 * declaring `property`, the engine walks up the cascade chain
 * (`.icon-button--accent` → `.icon-button`, `.tab.active` → `.tab`) and
 * tries the parent. Mirrors CSS specificity — most-specific wins. Needed
 * because per-variant-explicit isn't done across mde yet (Phase 3.1).
 *
 * Shorthand handling: if `property` is a longhand (e.g. `padding-top`)
 * and the rule has only the shorthand (`padding`) declared with a bare
 * `var(--…)`, the engine rewrites the shorthand. The result message
 * flags the side-effect ("affects all sides") so callers know. Stronger
 * cases (`background: var(--c) center/cover`) are refused by the
 * single-value guard.
 *
 * On stale-check strictness: the previous engine's declaration-rewrite
 * fallback existed primarily to paper over `parameters.designSync.tokens`
 * lying about what the CSS contained. Phase 1.1 killed that third copy —
 * the addon now reads CSS as source of truth — so we can demand the
 * stated `oldValue` actually be present and surface the mismatch when
 * it isn't, rather than silently rewriting whatever's there.
 */
export function createCssPostcssEngine(
  cwd: string,
  targets: CodeTarget[],
): PipelineEngine {
  return {
    info: {
      name: "code-css-postcss",
      description:
        "PostCSS AST engine. Replaces var(--<old>) with var(--<new>) or promotes a CSS literal to var(--<token>) in a scoped rule. Idempotent, stricter stale-check than the legacy regex engine.",
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
        typeof edit.newValue === "string"
      );
    },
    async apply(edit: Edit): Promise<EditResult> {
      if (targets.length === 0) {
        return reject(edit.id, "No codeTargets configured.");
      }

      const newVar = tokenNameToCssVar(edit.newValue);
      const oldVar = edit.kind === "token-binding"
        ? tokenNameToCssVar(edit.oldValue)
        : null; // token-value edits carry a literal in oldValue, not a token
      if (oldVar && oldVar === newVar) {
        return noOp(
          edit.id,
          `Token names resolve to the same CSS variable: ${oldVar}`,
        );
      }

      const selectorChain = edit.target.selector
        ? deriveSelectorChain(edit.target.selector)
        : [undefined as string | undefined];

      // Track the most informative reason if every attempt fails — used
      // for the rejection message so consumers know *why* nothing worked
      // (selector not found vs. property not declared vs. stale value).
      let lastReason: string | null = null;
      let attemptedAny = false;

      for (const selector of selectorChain) {
        const candidates = selector
          ? targets.filter(
              (t) => !t.scopeSelector || t.scopeSelector === selector,
            )
          : targets;
        if (candidates.length === 0) continue;
        attemptedAny = true;

        for (const target of candidates) {
          const fullPath = resolve(cwd, target.path);
          const source = await readFile(fullPath, "utf8");
          const root = postcss.parse(source, { from: fullPath });

          const scope = target.scopeSelector ?? selector;
          const rule = scope ? findRule(root, scope) : null;
          if (!rule) {
            lastReason = `No rule for selector "${scope}" in ${target.path}.`;
            continue;
          }

          const outcome = tryMutate(rule, edit, oldVar, newVar);
          if (outcome.status === "no-match") {
            lastReason = outcome.reason;
            continue;
          }
          if (outcome.status === "refused") {
            // Refusals are decisive — we found the right place but the
            // current value disagreed with the edit's premise. Don't
            // keep walking the chain; surface the mismatch immediately.
            return reject(edit.id, outcome.reason);
          }

          // Outcome is "mutated". Serialize and (unless dryRun) write.
          const next = root.toString();
          if (next === source) {
            // Belt-and-braces: PostCSS mutation that produced no change
            // means the edit was already in place. Treat as idempotent.
            return noOp(edit.id, `Already at desired value: var(${newVar}).`);
          }
          if (!edit.dryRun) {
            await writeFile(fullPath, next, "utf8");
          }
          const diff = formatDiff(target.path, source, next);
          const cascadeNote = selector !== edit.target.selector
            ? ` (matched ancestor selector "${selector}")`
            : "";
          const shorthandNote = outcome.shorthand
            ? ` Rewrote shorthand "${outcome.shorthand}" — affects all sides.`
            : "";
          return {
            id: edit.id,
            status: edit.dryRun ? "no_op" : "applied",
            engine: "code-css-postcss",
            message: (edit.dryRun ? "Would replace" : "Replaced")
              + ` ${describeEdit(edit, oldVar, newVar)}${cascadeNote}.${shorthandNote}`,
            diff,
          };
        }
      }

      if (!attemptedAny) {
        return reject(
          edit.id,
          `No codeTargets match selector "${edit.target.selector ?? ""}" (or any ancestor).`,
        );
      }
      return noOp(
        edit.id,
        lastReason
          ?? `No matching declaration for ${edit.target.property} in any rule reachable from "${edit.target.selector}".`,
      );
    },
  };
}

// ─── selector / rule helpers ────────────────────────────────────────────

// `deriveSelectorChain` / `stripOneLayer` now live in
// `@metalab/design-sync-core` (imported above) — shared with the addon's
// scanner so both sides walk the cascade identically.

/**
 * Find the first top-level rule whose selector list contains `target`.
 * Matches compound selectors precisely (split on commas + trim) — does
 * not match descendant compounds (`.foo .bar` doesn't satisfy a request
 * for `.bar`). The previous regex engine matched via `endsWith`, which
 * was too loose; mde's config doesn't use descendant compounds so this
 * is a no-op behavior change in practice.
 *
 * Ignores nested at-rules (`@media`, `@supports`) for v0. Storybook
 * stories snapshot the resting, no-media-query state; tokens inside
 * media queries are out of scope until we have a story-level mode
 * signal that maps to a media-query state.
 */
function findRule(root: Root, selector: string): Rule | null {
  let found: Rule | null = null;
  root.walkRules((rule) => {
    if (found) return false;
    if (rule.parent?.type !== "root") return; // skip nested rules
    const selectors = rule.selector.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) {
      found = rule;
      return false;
    }
    return;
  });
  return found;
}

// ─── mutation ───────────────────────────────────────────────────────────

type MutateOutcome =
  | { status: "mutated"; shorthand: string | null }
  | { status: "no-match"; reason: string }
  | { status: "refused"; reason: string };

/**
 * Walk decls in `rule` and try to apply the edit. Returns:
 *  - `mutated` if a decl's value was changed (rule was modified in place)
 *  - `refused` if the right decl was found but its current value
 *    disagreed with the edit's premise (stale-check failure)
 *  - `no-match` if no decl for the requested property exists — caller
 *    walks the cascade chain
 */
function tryMutate(
  rule: Rule,
  edit: Edit,
  oldVar: string | null,
  newVar: string,
): MutateOutcome {
  const property = edit.target.property;
  if (!property) {
    return {
      status: "refused",
      reason: "Edit is missing target.property — engine cannot scope the write.",
    };
  }

  // Walk decls. We collect the longhand match first; if missing, fall
  // back to a known shorthand. PostCSS visits decls in source order.
  let longhand: Declaration | null = null;
  let shorthand: { decl: Declaration; prop: string } | null = null;
  rule.walkDecls((decl) => {
    if (decl.prop === property) {
      longhand = decl;
      return false; // stop — exact match wins
    }
    if (!shorthand) {
      const sh = shorthandFor(property);
      if (sh && decl.prop === sh) shorthand = { decl, prop: sh };
    }
    return;
  });

  if (!longhand && !shorthand) {
    return {
      status: "no-match",
      reason: `Rule "${rule.selector}" has no declaration for ${property} (or any known shorthand).`,
    };
  }

  // Prefer longhand. If only the shorthand is present, edit it but flag
  // the side-effect in the outcome so the caller can include it in the
  // user-facing message.
  const decl: Declaration = longhand ?? shorthand!.decl;
  const shorthandProp = longhand ? null : shorthand!.prop;

  if (edit.kind === "token-binding") {
    return mutateBinding(decl, oldVar!, newVar, shorthandProp);
  }
  return mutateValue(decl, edit.oldValue, newVar, shorthandProp);
}

/**
 * token-binding: swap `var(--old)` for `var(--new)` within the decl
 * value. Stale-check: the current value must contain `var(--old)` — if
 * it doesn't, refuse with a clear "expected X, found Y" message rather
 * than silently rewriting (the legacy engine's declaration-rewrite
 * fallback did the latter).
 *
 * Multi-var values (rare but possible: `box-shadow: var(--shadow-a),
 * var(--shadow-b)`) get every occurrence of the matching var replaced.
 */
function mutateBinding(
  decl: Declaration,
  oldVar: string,
  newVar: string,
  shorthandProp: string | null,
): MutateOutcome {
  const oldRef = varRefRegex(oldVar);
  if (!oldRef.test(decl.value)) {
    return {
      status: "refused",
      reason:
        `Stale: expected var(${oldVar}) in ${decl.prop} of "${decl.parent?.toString().split("{")[0]?.trim() ?? "?"}", `
        + `found ${describeCurrentValue(decl.value)}. Re-run drift check and try again.`,
    };
  }
  // Reset lastIndex on the global regex before the replace.
  oldRef.lastIndex = 0;
  const next = decl.value.replace(oldRef, `var(${newVar})`);
  if (next === decl.value) {
    return { status: "no-match", reason: "Idempotent no-op." };
  }
  decl.value = next;
  return { status: "mutated", shorthand: shorthandProp };
}

/**
 * token-value: replace a raw CSS literal with `var(--new)`. Refuses on
 * multi-token values (`isSingleValue` returns false for anything with
 * top-level whitespace) — we'd otherwise clobber slots like the width
 * in `border: 1px solid red` when only the color was meant.
 *
 * Stale-check: the current value (trimmed) must equal `oldValue`
 * (trimmed). Different shape on disk → refuse, point at the truth.
 */
function mutateValue(
  decl: Declaration,
  oldLiteral: string,
  newVar: string,
  shorthandProp: string | null,
): MutateOutcome {
  const current = decl.value.trim();
  if (!isSingleValue(current)) {
    return {
      status: "refused",
      reason:
        `Refusing to promote multi-slot value "${decl.value}" on ${decl.prop}. `
        + `Split the shorthand into longhand declarations first.`,
    };
  }
  if (current !== oldLiteral.trim()) {
    return {
      status: "refused",
      reason:
        `Stale: expected ${decl.prop} value "${oldLiteral}", found "${decl.value}". `
        + "Re-run drift check and try again.",
    };
  }
  decl.value = `var(${newVar})`;
  return { status: "mutated", shorthand: shorthandProp };
}

// ─── value-shape helpers ────────────────────────────────────────────────

/**
 * Build a global regex that matches `var(--name)` with optional internal
 * whitespace. `name` is escaped for regex literal use.
 */
function varRefRegex(varName: string): RegExp {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`var\\(\\s*${escaped}\\s*(?:,[^)]*)?\\)`, "g");
}

// `isSingleValue` now lives in `@metalab/design-sync-core` (imported
// above) — the value-shape guard shared with the addon.

/**
 * Known longhand → shorthand fallbacks. Matches what the legacy engine
 * supported plus a couple of obvious additions. Conservative on
 * purpose: each entry is a property where rewriting the shorthand has
 * a uniform-side-effect that's acceptable to flag with a note.
 *
 * Not in the map: `font`, `border`, `transition` — multi-slot
 * shorthands where rewriting would always clobber other tokens. The
 * single-value guard catches those at the value-shape level even if
 * they did make it into the map.
 */
function shorthandFor(longhand: string): string | null {
  if (longhand.startsWith("padding-")) return "padding";
  if (longhand.startsWith("margin-")) return "margin";
  if (
    longhand === "border-top-left-radius" ||
    longhand === "border-top-right-radius" ||
    longhand === "border-bottom-left-radius" ||
    longhand === "border-bottom-right-radius"
  ) {
    return "border-radius";
  }
  if (longhand === "background-color") return "background";
  return null;
}

// `tokenNameToCssVar` now lives in `@metalab/design-sync-core` (imported
// above) — shared with the addon's normalizer.

// ─── result-shape helpers ───────────────────────────────────────────────

function reject(id: string, message: string): EditResult {
  return { id, status: "rejected", engine: "code-css-postcss", message };
}

function noOp(id: string, message: string): EditResult {
  return { id, status: "no_op", engine: "code-css-postcss", message };
}

function describeEdit(
  edit: Edit,
  oldVar: string | null,
  newVar: string,
): string {
  if (edit.kind === "token-binding") return `var(${oldVar}) → var(${newVar})`;
  return `"${edit.oldValue}" → var(${newVar})`;
}

function describeCurrentValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 60) return `"${trimmed}"`;
  return `"${trimmed.slice(0, 57)}…"`;
}

/**
 * Minimal change summary — not a real unified diff. The addon panel
 * renders this as a code block under the row. Showing only changed
 * lines keeps the panel readable.
 */
function formatDiff(path: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const changed: string[] = [];
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) {
      if (beforeLines[i] !== undefined) changed.push(`- ${beforeLines[i]}`);
      if (afterLines[i] !== undefined) changed.push(`+ ${afterLines[i]}`);
    }
  }
  return `${path}\n${changed.join("\n")}`;
}
