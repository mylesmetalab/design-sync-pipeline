import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCssPostcssEngine, deriveSelectorChain, isSingleValue } from "./code-css-postcss.js";
import type { Edit } from "../types.js";

/**
 * The pipeline's first tests. The legacy regex engine had zero coverage
 * which is why every Apply bug we shipped was discovered in mde 24-48
 * hours after the fact. Each case below corresponds to a fallback path
 * the regex engine had to handle; the AST handles them as straight
 * code, but having them as tests pins the behavior so the next
 * refactor doesn't silently regress.
 */

let dir: string;
let cssPath: string;

async function setup(css: string): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "design-sync-test-"));
  cssPath = join(dir, "style.css");
  await writeFile(cssPath, css, "utf8");
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function bindingEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: "test-edit",
    kind: "token-binding",
    scope: "code",
    target: { selector: ".icon-button", property: "border-top-left-radius" },
    oldValue: "radius/xl",
    newValue: "radius/lg",
    source: "test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function valueEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: "test-edit",
    kind: "token-value",
    scope: "code",
    target: { selector: ".icon-button", property: "padding-top" },
    oldValue: "8px",
    newValue: "space/8",
    source: "test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("createCssPostcssEngine — token-binding swap", () => {
  it("rewrites a single longhand declaration in the exact rule", async () => {
    await setup(`
.icon-button {
  border-top-left-radius: var(--radius-xl);
  border-top-right-radius: var(--radius-xl);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(cssPath, "utf8");
    expect(after).toContain("border-top-left-radius: var(--radius-lg)");
    // Sibling longhand untouched — property scoping.
    expect(after).toContain("border-top-right-radius: var(--radius-xl)");
  });

  it("falls back to the ancestor selector when the variant rule lacks the property", async () => {
    await setup(`
.tab {
  background-color: var(--color-bg-input);
}
.tab.active {
  color: var(--color-text-primary);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".tab" },
      { path: "style.css", scopeSelector: ".tab.active" },
    ]);
    const result = await engine.apply(bindingEdit({
      target: { selector: ".tab.active", property: "background-color" },
      oldValue: "color/bg/input",
      newValue: "color/bg/kbd",
    }));
    expect(result.status).toBe("applied");
    expect(result.message).toMatch(/matched ancestor selector ".tab"/);
    const after = await readFile(cssPath, "utf8");
    expect(after).toContain("background-color: var(--color-bg-kbd)");
  });

  it("refuses to apply when the current value isn't what oldValue claims (stale check)", async () => {
    await setup(`
.icon-button {
  border-top-left-radius: var(--radius-round);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(bindingEdit()); // oldValue: radius/xl
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/Stale: expected var\(--radius-xl\)/);
    expect(result.message).toMatch(/found "var\(--radius-round\)"/);
    // File unchanged.
    const after = await readFile(cssPath, "utf8");
    expect(after).toContain("var(--radius-round)");
  });

  it("is idempotent on a second apply (no_op the second time)", async () => {
    await setup(`
.icon-button {
  border-top-left-radius: var(--radius-xl);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    expect((await engine.apply(bindingEdit())).status).toBe("applied");
    // Second time the file already has var(--radius-lg); oldValue=radius/xl
    // is now stale, so the engine refuses (the strict behavior). A truly
    // idempotent re-apply would carry oldValue=radius/lg and resolve to
    // no_op via "already at desired value".
    const second = await engine.apply(bindingEdit({
      oldValue: "radius/lg",
      newValue: "radius/lg",
    }));
    expect(second.status).toBe("no_op");
    expect(second.message).toMatch(/Token names resolve to the same CSS variable/);
  });

  it("rewrites the shorthand and flags the side-effect when only shorthand is present", async () => {
    await setup(`
.icon-button {
  padding: var(--space-8);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(bindingEdit({
      target: { selector: ".icon-button", property: "padding-top" },
      oldValue: "space/8",
      newValue: "space/12",
    }));
    expect(result.status).toBe("applied");
    expect(result.message).toMatch(/Rewrote shorthand "padding" — affects all sides/);
    const after = await readFile(cssPath, "utf8");
    expect(after).toContain("padding: var(--space-12)");
  });

  it("returns no_op when the property isn't declared anywhere in the chain", async () => {
    await setup(`
.icon-button {
  background-color: var(--color-bg-input);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(bindingEdit({
      target: { selector: ".icon-button", property: "color" }, // not declared
      oldValue: "color/text/faint",
      newValue: "color/text/primary",
    }));
    expect(result.status).toBe("no_op");
    expect(result.message).toMatch(/no declaration for color/i);
  });
});

describe("createCssPostcssEngine — token-value promotion", () => {
  it("promotes a single CSS literal to var(--token)", async () => {
    await setup(`
.icon-button {
  padding-top: 8px;
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(valueEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(cssPath, "utf8");
    expect(after).toContain("padding-top: var(--space-8)");
  });

  it("refuses to promote a multi-slot shorthand value", async () => {
    await setup(`
.icon-button {
  border: 1px solid red;
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(valueEdit({
      target: { selector: ".icon-button", property: "border" },
      oldValue: "1px solid red",
      newValue: "color/semantic/danger",
    }));
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/multi-slot value/i);
    const after = await readFile(cssPath, "utf8");
    expect(after).toContain("1px solid red"); // untouched
  });

  it("refuses when the literal on disk doesn't match oldValue", async () => {
    await setup(`
.icon-button {
  padding-top: 12px;
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const result = await engine.apply(valueEdit()); // oldValue: 8px
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/Stale: expected padding-top value "8px", found "12px"/);
  });
});

describe("createCssPostcssEngine — config / wiring", () => {
  it("rejects when no codeTargets are configured", async () => {
    await setup(`.foo { color: red; }`);
    const engine = createCssPostcssEngine(dir, []);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/No codeTargets configured/);
  });

  it("rejects when the selector matches no codeTarget (or ancestor)", async () => {
    await setup(`.foo { color: red; }`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".some-other-thing" },
    ]);
    const result = await engine.apply(bindingEdit({
      target: { selector: ".icon-button", property: "color" },
    }));
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/No codeTargets match selector/);
  });

  it("respects dryRun — no file write, status is no_op", async () => {
    await setup(`
.icon-button {
  border-top-left-radius: var(--radius-xl);
}
`);
    const engine = createCssPostcssEngine(dir, [
      { path: "style.css", scopeSelector: ".icon-button" },
    ]);
    const original = await readFile(cssPath, "utf8");
    const result = await engine.apply(bindingEdit({ dryRun: true }));
    expect(result.status).toBe("no_op");
    expect(result.message).toMatch(/Would replace/);
    expect(await readFile(cssPath, "utf8")).toBe(original);
  });
});

describe("helpers", () => {
  describe("deriveSelectorChain", () => {
    it("strips BEM modifier", () => {
      expect(deriveSelectorChain(".icon-button--accent")).toEqual([
        ".icon-button--accent",
        ".icon-button",
      ]);
    });
    it("strips chained class", () => {
      expect(deriveSelectorChain(".tab.active")).toEqual([
        ".tab.active",
        ".tab",
      ]);
    });
    it("returns singleton for bare class", () => {
      expect(deriveSelectorChain(".foo")).toEqual([".foo"]);
    });
  });

  describe("isSingleValue", () => {
    it("treats a bare var() as single", () => {
      expect(isSingleValue("var(--space-8)")).toBe(true);
    });
    it("treats hex colors as single", () => {
      expect(isSingleValue("#ff0000")).toBe(true);
    });
    it("treats numbers with units as single", () => {
      expect(isSingleValue("8px")).toBe(true);
    });
    it("treats rgb() as single (whitespace inside parens is allowed)", () => {
      expect(isSingleValue("rgb(31, 30, 30)")).toBe(true);
    });
    it("treats shorthand declarations as multi-slot", () => {
      expect(isSingleValue("1px solid red")).toBe(false);
      expect(isSingleValue("var(--shadow) center / cover")).toBe(false);
    });
    it("treats empty string as non-single", () => {
      expect(isSingleValue("")).toBe(false);
      expect(isSingleValue("   ")).toBe(false);
    });
  });
});
