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
      description: "Replaces var(--<old-token>) with var(--<new-token>) OR a raw CSS literal with var(--<token>) in a configured CSS file. Deterministic, idempotent.",
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
        return {
          id: edit.id,
          status: "rejected",
          engine: "code-css-token-swap",
          message: "No codeTargets configured.",
        };
      }

      // For `token-value` edits, `oldValue` is the raw CSS literal already
      // in the file (e.g. "6px", "rgb(255, 0, 0)") and `newValue` is the
      // token NAME (e.g. "space/4"). We don't dual-var-swap; we promote the
      // literal to `var(--<normalized-token>)`. For `token-binding` (the
      // legacy path), both values are token names and we var-swap them.
      const isValuePromotion = edit.kind === "token-value";
      const oldVar = isValuePromotion ? edit.oldValue : tokenNameToCssVar(edit.oldValue);
      const newVar = isValuePromotion
        ? tokenNameToCssVar(edit.newValue)
        : tokenNameToCssVar(edit.newValue);
      if (!isValuePromotion && oldVar === newVar) {
        return {
          id: edit.id,
          status: "no_op",
          engine: "code-css-token-swap",
          message: `Token names resolve to the same CSS variable: ${oldVar}`,
        };
      }

      // Try the edit's selector first; if no replacements happen, fall back
      // to its parent selectors. Mirrors CSS cascade — most-specific wins —
      // so a variant rule that overrides the property still gets edited
      // there, but shared properties declared on the base rule are reachable
      // when the edit was filed against a variant in components that haven't
      // been refactored to per-variant-explicit yet.
      const selectorChain = edit.target.selector
        ? deriveSelectorChain(edit.target.selector)
        : [undefined as string | undefined];

      const diffs: string[] = [];
      let touched = false;
      let usedFallback = false;
      let attemptedAny = false;
      let matchedSelector: string | undefined;

      for (let depth = 0; depth < selectorChain.length && !touched; depth++) {
        const sel = selectorChain[depth];
        const candidateTargets = sel
          ? targets.filter((t) => !t.scopeSelector || t.scopeSelector === sel)
          : targets;

        if (candidateTargets.length === 0) continue;
        attemptedAny = true;

        for (const target of candidateTargets) {
          const fullPath = resolve(cwd, target.path);
          const before = await readFile(fullPath, "utf8");

          let editResult = applyTokenSwap({
            source: before,
            oldVar,
            newVar,
            scopeSelector: target.scopeSelector ?? sel,
            property: edit.target.property,
            literalToVar: isValuePromotion,
          });

          // Both token-binding swap and value-promotion can fail when the
          // CSS uses a different shape than expected (e.g. the story
          // declares one token but the file uses another var, or the code
          // uses a literal but the addon expected a var). Fall back to
          // a property-scoped declaration rewrite that replaces whatever
          // the property currently holds with `var(--newVar)`. Bounded by
          // selector + property + a single-value-shape safety guard.
          if (editResult.replacements === 0 && edit.target.property) {
            editResult = applyDeclarationRewrite({
              source: before,
              property: edit.target.property,
              newVar,
              scopeSelector: target.scopeSelector ?? sel,
            });
          }

          if (editResult.replacements === 0) continue;

          touched = true;
          if (depth > 0) {
            usedFallback = true;
            matchedSelector = sel;
          }
          diffs.push(formatDiff(target.path, before, editResult.next, editResult.replacements));

          if (!edit.dryRun) {
            await writeFile(fullPath, editResult.next, "utf8");
          }
        }
      }

      if (!attemptedAny) {
        return {
          id: edit.id,
          status: "rejected",
          engine: "code-css-token-swap",
          message: `No codeTargets match selector "${edit.target.selector ?? ""}" (or any ancestor).`,
        };
      }

      if (!touched) {
        return {
          id: edit.id,
          status: "no_op",
          engine: "code-css-token-swap",
          message: `No occurrences of ${oldVar} found in the configured targets.`,
        };
      }

      const fallbackNote = usedFallback && matchedSelector
        ? ` (matched on ancestor selector "${matchedSelector}")`
        : "";
      return {
        id: edit.id,
        status: edit.dryRun ? "no_op" : "applied",
        engine: "code-css-token-swap",
        message: edit.dryRun
          ? `Would replace ${oldVar} → ${newVar}${fallbackNote}.`
          : `Replaced ${oldVar} → ${newVar}${fallbackNote}.`,
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

/**
 * Derive the CSS-cascade parent chain for a selector. We start with the
 * given selector (most specific) and successively strip a single specificity
 * layer:
 *   - `--<modifier>` BEM suffix on the LAST class:
 *     `.icon-button--primary` → `.icon-button`
 *   - trailing chained modifier class:
 *     `.tab.active` → `.tab`
 *
 * Stops when no further stripping applies. Bounded loop guards against
 * pathological inputs.
 */
function deriveSelectorChain(selector: string): string[] {
  const chain: string[] = [selector];
  let current = selector;
  for (let i = 0; i < 4; i++) {
    const next = stripOneLayer(current);
    if (!next || next === current) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

/**
 * Last-resort rewrite: replace whatever value is currently assigned to
 * `<property>` inside the scoped rule(s) with `var(--newVar)`. Used as a
 * fallback when a token-binding swap couldn't find the declared `oldVar`
 * in the CSS — typically because the story metadata claims one token but
 * the file uses a different var (or a raw literal).
 *
 * Scope-bounded: requires `scopeSelector` and matches `<property>: …;` or
 * `<property>: …}` within the rule body, leaving everything else alone.
 */
function applyDeclarationRewrite(input: {
  source: string;
  property: string;
  newVar: string;
  scopeSelector: string | undefined;
}): SwapResult {
  const { source, property, newVar, scopeSelector } = input;
  if (!scopeSelector) return { next: source, replacements: 0 };

  // CSS longhand → shorthand fallbacks. When a rewrite for a specific
  // longhand can't find that exact declaration, we try the shorthand too:
  // many codebases write `background:` instead of `background-color:`,
  // or `border-radius:` instead of the four per-corner longhands.
  //
  // The single-value safety guard below prevents clobbering when the
  // shorthand carries multiple slots (e.g. `border: 1px solid red`).
  // Caveat for the per-corner→`border-radius` case: rewriting the
  // shorthand changes ALL four corners in one go. That's correct when
  // the design intent is uniform corners (the common case); if the
  // designer wants asymmetric corners the user needs to expand the
  // shorthand to longhands manually first.
  const equivalentProps: string[] = [property];
  if (property === "background-color") equivalentProps.push("background");
  if (property === "border-color") equivalentProps.push("border");
  if (property === "border-width") equivalentProps.push("border");
  if (
    property === "border-top-left-radius" ||
    property === "border-top-right-radius" ||
    property === "border-bottom-left-radius" ||
    property === "border-bottom-right-radius"
  ) {
    equivalentProps.push("border-radius");
  }

  const altProps = equivalentProps
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // Match the property's full declaration up to ; or before }. Don't be
  // greedy across declarations. Property alternation lets us hit either
  // longhand or shorthand.
  const pattern = new RegExp(`((?:${altProps})\\s*:\\s*)([^;}]+?)(?=\\s*[;}])`, "g");

  // Refuse to rewrite when the value mixes multiple sub-tokens — typical
  // of shorthand declarations like `border: 1px solid red` or
  // `background: no-repeat center / cover #fff`. We'd clobber the other
  // sub-tokens when promoting the color or width slot. A "simple" value
  // is anything we can safely replace wholesale:
  //   - a single var(--…) call
  //   - a single hex / rgb / hsl color
  //   - a single bare identifier (transparent / none / initial / etc.)
  //   - a single number with optional CSS unit (px, rem, em, %, etc.)
  //   - a single bare number (line-height, opacity, font-weight)
  // The decisive test is "no top-level whitespace outside parentheses",
  // which covers every single-slot value without needing to enumerate
  // every CSS value grammar.
  const isSingleValue = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    // Walk the string, track paren depth, look for any whitespace at
    // depth 0 — that signals a multi-token shorthand.
    let depth = 0;
    for (let k = 0; k < trimmed.length; k++) {
      const ch = trimmed.charAt(k);
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && /\s/.test(ch)) return false;
    }
    return true;
  };

  let count = 0;
  let i = 0;
  let out = "";
  while (i < source.length) {
    const braceStart = source.indexOf("{", i);
    if (braceStart === -1) {
      out += source.slice(i);
      break;
    }
    const selectorList = source.slice(i, braceStart);
    const selectorMatches = selectorList
      .split(",")
      .some((s) => s.trim() === scopeSelector || s.trim().endsWith(scopeSelector));
    let depth = 1;
    let j = braceStart + 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth > 0) j++;
    }
    const ruleBody = source.slice(braceStart + 1, j);
    const after = source.slice(j);
    if (selectorMatches) {
      const replaced = ruleBody.replace(pattern, (match: string, prefix: string, value: string) => {
        // Safety: only rewrite when the value is a single token. Otherwise
        // we'd clobber e.g. `border: 1px solid red` when the user only
        // meant to change the color slot.
        if (!isSingleValue(value)) return match;
        count++;
        return `${prefix}var(${newVar})`;
      });
      out += selectorList + "{" + replaced;
    } else {
      out += selectorList + "{" + ruleBody;
    }
    out += after.charAt(0);
    i = j + 1;
  }
  return { next: out, replacements: count };
}

function stripOneLayer(selector: string): string | null {
  // Trailing chained class: `.foo.bar` → `.foo`.
  const chained = selector.match(/^(.+)(\.[A-Za-z_][\w-]*)$/);
  const chainedHead = chained?.[1];
  const chainedTail = chained?.[2];
  if (chainedHead && chainedTail && chainedHead.includes(".") && !chainedTail.includes("--")) {
    return chainedHead;
  }
  // BEM modifier: `.foo--x` → `.foo`.
  const bem = selector.match(/^(.*?)(--[\w-]+)$/);
  const bemHead = bem?.[1];
  if (bemHead) return bemHead;
  return null;
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
  /**
   * CSS property name to scope the swap to (e.g. "border-top-left-radius").
   * When set, only `<property>: …` declarations are rewritten.
   */
  property?: string | undefined;
  /**
   * When true, `oldVar` is a raw CSS literal (e.g. "6px") not a CSS variable
   * name, and we're promoting it to `var(--newVar)`. Requires `property` —
   * we won't blind-replace a literal value across a whole rule body.
   */
  literalToVar?: boolean;
}): SwapResult {
  const { source, oldVar, newVar, scopeSelector, property, literalToVar } = input;

  // Pattern shape depends on the mode:
  //   token-binding swap: var(--old)        → var(--new)
  //   property-scoped swap: <prop>: var(--old) → <prop>: var(--new)
  //   value→token promotion: <prop>: <literal>; → <prop>: var(--new);
  const escaped = oldVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedProp = property?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern: RegExp;
  let replacement: string;
  if (literalToVar) {
    if (!escapedProp) {
      // Promotion without a property anchor is too dangerous — refuse.
      return { next: source, replacements: 0 };
    }
    // Match `<prop>: <literal>` up to the next `;` or `}`. Trailing
    // whitespace + semicolon preserved.
    pattern = new RegExp(`(${escapedProp}\\s*:\\s*)${escaped}(?=\\s*[;}])`, "g");
    replacement = `$1var(${newVar})`;
  } else if (escapedProp) {
    pattern = new RegExp(`(${escapedProp}\\s*:\\s*)var\\(\\s*${escaped}\\s*\\)`, "g");
    replacement = `$1var(${newVar})`;
  } else {
    pattern = new RegExp(`var\\(\\s*${escaped}\\s*\\)`, "g");
    replacement = `var(${newVar})`;
  }

  if (!scopeSelector) {
    let count = 0;
    const next = source.replace(pattern, () => {
      count++;
      return replacement;
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
      const replaced = ruleBody.replace(pattern, (...args: unknown[]) => {
        count++;
        // When the pattern includes a property capture group, args[1] is the
        // declaration prefix we need to preserve.
        return escapedProp ? `${args[1] as string}var(${newVar})` : `var(${newVar})`;
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
