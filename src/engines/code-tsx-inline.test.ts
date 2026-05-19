import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTsxInlineEngine } from "./code-tsx-inline.js";
import type { Edit } from "../types.js";

/**
 * Mirrors `code-css-postcss.test.ts` shape. Each case covers one
 * behavior the engine has to honor (no_op idempotency, stale-check,
 * dry-run, multi-file, refusal on no match, etc.) so we don't regress
 * a category quietly.
 */

let dir: string;

async function setup(files: Record<string, string>): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "tsx-engine-test-"));
  for (const [rel, source] of Object.entries(files)) {
    await writeFile(join(dir, rel), source, "utf8");
  }
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function bindingEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: "test-edit",
    kind: "token-binding",
    scope: "code",
    target: { property: "color" },
    oldValue: "label-text",
    newValue: "button-text",
    source: "test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("createTsxInlineEngine — token-binding swap", () => {
  it("rewrites var(--old) → var(--new) inside a JSX style prop", async () => {
    await setup({
      "Row.tsx": `
        export function Row() {
          return <div style={{ color: "var(--label-text)" }}>hi</div>;
        }
      `,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("applied");
    expect(result.engine).toBe("code-tsx-inline");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toContain('color: "var(--button-text)"');
    expect(after).not.toContain("var(--label-text)");
  });

  it("is idempotent — re-applying the same edit is a no_op", async () => {
    await setup({
      "Row.tsx": `
        export function Row() {
          return <div style={{ color: "var(--button-text)" }}>hi</div>;
        }
      `,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/Stale|No inline-style/);
  });

  it("dry-run reports the would-change without writing", async () => {
    const source = `
      export function Row() {
        return <div style={{ color: "var(--label-text)" }}>hi</div>;
      }
    `;
    await setup({ "Row.tsx": source });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit({ dryRun: true }));
    expect(result.status).toBe("no_op");
    expect(result.message).toMatch(/Dry-run/);
    expect(result.diff).toContain("color");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toBe(source);
  });

  it("rejects when the property exists but with a different binding (stale)", async () => {
    await setup({
      "Row.tsx": `
        export function Row() {
          return <div style={{ color: "var(--something-else)" }}>hi</div>;
        }
      `,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/Stale.*var\(--label-text\)/);
    expect(result.message).toContain("--something-else");
  });

  it("rejects when no inline-style declaration for the property exists", async () => {
    await setup({
      "Row.tsx": `
        export function Row() {
          return <div style={{ background: "var(--row-bg)" }}>hi</div>;
        }
      `,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/No inline-style declaration for color/);
  });

  it("rewrites multiple files in one edit", async () => {
    await setup({
      "A.tsx": `<div style={{ color: "var(--label-text)" }} />`,
      "B.tsx": `<span style={{ color: "var(--label-text)" }} />`,
    });
    const engine = createTsxInlineEngine(dir, [
      { path: "A.tsx" },
      { path: "B.tsx" },
    ]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("applied");
    expect(result.message).toMatch(/2 references? across 2 files?/);
    expect(await readFile(join(dir, "A.tsx"), "utf8")).toContain("var(--button-text)");
    expect(await readFile(join(dir, "B.tsx"), "utf8")).toContain("var(--button-text)");
  });

  it("kebab-cases CSS prop to camelCase JSX key", async () => {
    await setup({
      "Row.tsx": `<div style={{ backgroundColor: "var(--row-bg)" }} />`,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(
      bindingEdit({
        target: { property: "background-color" },
        oldValue: "row-bg",
        newValue: "panel-bg",
      }),
    );
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toContain('backgroundColor: "var(--panel-bg)"');
  });

  it("rejects when target.property is missing", async () => {
    await setup({ "Row.tsx": `<div />` });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(
      bindingEdit({ target: {} as never }),
    );
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/target\.property/);
  });

  it("noops when newValue and oldValue resolve to the same CSS var", async () => {
    await setup({
      "Row.tsx": `<div style={{ color: "var(--label-text)" }} />`,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(
      bindingEdit({ oldValue: "label-text", newValue: "label-text" }),
    );
    expect(result.status).toBe("no_op");
  });

  it("ignores non-style JSX attributes", async () => {
    await setup({
      "Row.tsx": `<div data-tokens="var(--label-text)" style={{}} />`,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("rejected");
    // data-tokens never gets touched — only inline-style props.
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toContain("data-tokens=\"var(--label-text)\"");
  });

  it("follows an identifier reference to a const declaration", async () => {
    await setup({
      "Row.tsx": `
        const styles = { color: "var(--label-text)" };
        export function Row() {
          return <div style={styles} />;
        }
      `,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(bindingEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toContain('color: "var(--button-text)"');
  });

  it("does not handle code-css edits (canHandle filters by extension)", () => {
    const engine = createTsxInlineEngine(dir, [{ path: "style.css" }]);
    expect(engine.canHandle(bindingEdit())).toBe(false);
  });
});

describe("createTsxInlineEngine — token-value promotion", () => {
  function valueEdit(overrides: Partial<Edit> = {}): Edit {
    return {
      id: "test-edit",
      kind: "token-value",
      scope: "code",
      target: { property: "font-size" },
      oldValue: "11px",
      newValue: "font-size/11",
      source: "test",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it("rewrites a literal string value to var(--token)", async () => {
    await setup({
      "Row.tsx": `<div style={{ fontSize: "11px" }} />`,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(valueEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toContain('fontSize: "var(--font-size-11)"');
  });

  it("surfaces stale when the literal doesn't match oldValue", async () => {
    await setup({
      "Row.tsx": `<div style={{ fontSize: "16px" }} />`,
    });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(valueEdit());
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/Stale.*11px/);
    expect(result.message).toContain("16px");
  });

  it("dry-run shows what would change without writing", async () => {
    const source = `<div style={{ fontSize: "11px" }} />`;
    await setup({ "Row.tsx": source });
    const engine = createTsxInlineEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(valueEdit({ dryRun: true }));
    expect(result.status).toBe("no_op");
    expect(result.diff).toContain("fontSize");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toBe(source);
  });
});

describe("createTsxInlineEngine — registry/canHandle gate", () => {
  it("returns false when no codeTargets are TSX/JSX", () => {
    const engine = createTsxInlineEngine("/tmp", [{ path: "style.css" }]);
    expect(
      engine.canHandle({
        id: "x",
        kind: "token-binding",
        scope: "code",
        target: { property: "color" },
        oldValue: "a",
        newValue: "b",
        source: "test",
        timestamp: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("returns false for figma-scope edits", () => {
    const engine = createTsxInlineEngine("/tmp", [{ path: "x.tsx" }]);
    expect(
      engine.canHandle({
        id: "x",
        kind: "token-binding",
        scope: "figma",
        target: { property: "color" },
        oldValue: "a",
        newValue: "b",
        source: "test",
        timestamp: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("returns false for non-binding/value kinds", () => {
    const engine = createTsxInlineEngine("/tmp", [{ path: "x.tsx" }]);
    expect(
      engine.canHandle({
        id: "x",
        kind: "copy",
        scope: "code",
        target: { property: "text" },
        oldValue: "a",
        newValue: "b",
        source: "test",
        timestamp: new Date().toISOString(),
      } as unknown as Edit),
    ).toBe(false);
  });
});
