import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTsxTextEngine } from "./code-tsx-text.js";
import type { Edit } from "../types.js";

let dir: string;

async function setup(files: Record<string, string>): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "tsx-text-engine-test-"));
  for (const [rel, source] of Object.entries(files)) {
    await writeFile(join(dir, rel), source, "utf8");
  }
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function copyEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: "copy-1",
    kind: "copy",
    scope: "code",
    target: { property: "text" },
    oldValue: "Save changes",
    newValue: "Save",
    source: "test",
    timestamp: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("createTsxTextEngine — JSX copy rewrite", () => {
  it("rewrites a bare JsxText child", async () => {
    await setup({
      "Button.tsx": `
        export function Button() {
          return <button>Save changes</button>;
        }
      `,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    const result = await engine.apply(copyEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Button.tsx"), "utf8");
    expect(after).toContain("<button>Save</button>");
    expect(after).not.toContain("Save changes");
  });

  it("preserves surrounding indentation on multi-line JsxText", async () => {
    await setup({
      "Button.tsx": `
        export function Button() {
          return (
            <button>
              Save changes
            </button>
          );
        }
      `,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    const result = await engine.apply(copyEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Button.tsx"), "utf8");
    expect(after).toMatch(/\n\s+Save\n/);
  });

  it("rewrites a {\"string\"} expression child, keeping quote style", async () => {
    await setup({
      "Label.tsx": `
        export function Label() {
          return <span>{'Save changes'}</span>;
        }
      `,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Label.tsx" }]);
    const result = await engine.apply(copyEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Label.tsx"), "utf8");
    expect(after).toContain("{'Save'}");
  });

  it("does not touch string literals in JSX attributes", async () => {
    await setup({
      "Button.tsx": `
        export function Button() {
          return <button aria-label="Save changes">Save changes</button>;
        }
      `,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    const result = await engine.apply(copyEdit());
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Button.tsx"), "utf8");
    // The child text changed; the attribute kept its value.
    expect(after).toContain('aria-label="Save changes"');
    expect(after).toContain(">Save</button>");
  });

  it("rewrites a story-args string via the sibling .stories.tsx (storyId path)", async () => {
    await setup({
      "Row.tsx": `
        export function Row({ label }: { label: string }) {
          return <div>{label}</div>;
        }
      `,
      "Row.stories.tsx": `
        export const StateDefault = {
          args: { label: "Save changes" },
        };
      `,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(
      copyEdit({ target: { property: "text", storyId: "molecules-row--state-default" } }),
    );
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "Row.stories.tsx"), "utf8");
    expect(after).toContain('label: "Save"');
  });

  it("rejects when the text is dynamic and no story arg matches", async () => {
    await setup({
      "Row.tsx": `
        export function Row({ label }: { label: string }) {
          return <div>{label}</div>;
        }
      `,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Row.tsx" }]);
    const result = await engine.apply(copyEdit());
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/dynamic|drifted/i);
  });

  it("rejects (stale) when oldValue is not present", async () => {
    await setup({
      "Button.tsx": `export const B = () => <button>Different text</button>;`,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    const result = await engine.apply(copyEdit());
    expect(result.status).toBe("rejected");
  });

  it("dry-run reports the change without writing", async () => {
    await setup({
      "Button.tsx": `export const B = () => <button>Save changes</button>;`,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    const result = await engine.apply(copyEdit({ dryRun: true }));
    expect(result.status).toBe("no_op");
    expect(result.message).toMatch(/dry-run/i);
    const after = await readFile(join(dir, "Button.tsx"), "utf8");
    expect(after).toContain("Save changes");
  });

  it("no_op when oldValue equals newValue", async () => {
    await setup({
      "Button.tsx": `export const B = () => <button>Save</button>;`,
    });
    const engine = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    const result = await engine.apply(copyEdit({ oldValue: "Save", newValue: "Save" }));
    expect(result.status).toBe("no_op");
  });

  it("canHandle gates on kind/scope and TSX targets", async () => {
    await setup({ "style.css": ".a { color: red; }" });
    const cssOnly = createTsxTextEngine(dir, [{ path: "style.css" }]);
    expect(cssOnly.canHandle(copyEdit())).toBe(false);
    const tsx = createTsxTextEngine(dir, [{ path: "Button.tsx" }]);
    expect(tsx.canHandle(copyEdit())).toBe(true);
    expect(tsx.canHandle(copyEdit({ scope: "figma" }))).toBe(false);
    expect(tsx.canHandle(copyEdit({ kind: "token-binding" }))).toBe(false);
  });
});
