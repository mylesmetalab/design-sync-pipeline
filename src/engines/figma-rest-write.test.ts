import { afterEach, describe, expect, it, vi } from "vitest";
import { createFigmaRestWriteEngine, parseColor } from "./figma-rest-write.js";
import type { Edit } from "../types.js";

/**
 * All Figma calls are mocked — FIGMA_PAT is never read from env here
 * (the engine takes the PAT via its context argument).
 */

const VARIABLES_PAYLOAD = {
  meta: {
    variables: {
      "VariableID:1:1": {
        id: "VariableID:1:1",
        name: "color/accent",
        resolvedType: "COLOR",
        variableCollectionId: "VariableCollectionId:1:0",
        valuesByMode: { "1:0": { r: 0, g: 0, b: 0 } },
      },
      "VariableID:1:2": {
        id: "VariableID:1:2",
        name: "space/8",
        resolvedType: "FLOAT",
        variableCollectionId: "VariableCollectionId:1:0",
        valuesByMode: { "1:0": 8 },
      },
    },
    variableCollections: {
      "VariableCollectionId:1:0": {
        id: "VariableCollectionId:1:0",
        name: "Downmark Tokens",
        modes: [{ modeId: "1:0", name: "Light" }],
        defaultModeId: "1:0",
      },
    },
  },
};

function mockVariablesFetch(payload: unknown = VARIABLES_PAYLOAD): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function makeEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: "edit-1",
    kind: "token-value",
    scope: "figma",
    target: { property: "background-color", fileKey: "FILEKEY" },
    oldValue: "rgb(0, 0, 0) (token: color/accent)",
    newValue: "rgb(37, 99, 235) (token: color/accent)",
    source: "test",
    timestamp: new Date().toISOString(),
    dryRun: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("figma-rest-write: unknown mode rejection (item 4)", () => {
  it("rejects when edit.modes names a mode the collection doesn't have, listing available modes", async () => {
    mockVariablesFetch();
    const engine = createFigmaRestWriteEngine({ pat: "test-pat" });
    // Collection only has "Light"; the edit asks for dark.
    const result = await engine.apply(makeEdit({ modes: { dark: "rgb(37, 99, 235)" } }));
    expect(result.status).toBe("rejected");
    expect(result.message).toContain('Mode "dark" not found in collection "Downmark Tokens"');
    expect(result.message).toContain("Available modes: Light");
  });

  it("uses the named mode when it exists", async () => {
    const payload = structuredClone(VARIABLES_PAYLOAD);
    payload.meta.variableCollections["VariableCollectionId:1:0"]!.modes.push({
      modeId: "1:1",
      name: "Dark",
    });
    (payload.meta.variables["VariableID:1:1"]!.valuesByMode as Record<string, unknown>)["1:1"] = {
      r: 1,
      g: 1,
      b: 1,
    };
    mockVariablesFetch(payload);
    const engine = createFigmaRestWriteEngine({ pat: "test-pat" });
    const result = await engine.apply(makeEdit({ modes: { dark: "rgb(37, 99, 235)" } }));
    expect(result.status).toBe("no_op"); // dry-run
    expect(result.message).toContain("(Dark)");
  });

  it("falls back to the default mode when no mode is named", async () => {
    mockVariablesFetch();
    const engine = createFigmaRestWriteEngine({ pat: "test-pat" });
    const result = await engine.apply(makeEdit());
    expect(result.status).toBe("no_op"); // dry-run
    expect(result.message).toContain("(Light)");
  });
});

describe("figma-rest-write: color bounds validation (item 5)", () => {
  it("rejects rgb components above 255 through the engine path", async () => {
    mockVariablesFetch();
    const engine = createFigmaRestWriteEngine({ pat: "test-pat" });
    const result = await engine.apply(
      makeEdit({ newValue: "rgb(999, 999, 999) (token: color/accent)" }),
    );
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Could not parse");
  });

  it("rejects alpha values above 1 through the engine path", async () => {
    mockVariablesFetch();
    const engine = createFigmaRestWriteEngine({ pat: "test-pat" });
    const result = await engine.apply(
      makeEdit({ newValue: "rgba(37, 99, 235, 2.5) (token: color/accent)" }),
    );
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Could not parse");
  });

  it("parseColor enforces RGB 0–255 and alpha 0–1", () => {
    expect(parseColor("rgb(999, 0, 0)")).toBeNull();
    expect(parseColor("rgb(0, 256, 0)")).toBeNull();
    expect(parseColor("rgb(0, 0, 300)")).toBeNull();
    expect(parseColor("rgba(10, 20, 30, 2.5)")).toBeNull();
    expect(parseColor("rgba(10, 20, 30, 1.01)")).toBeNull();
    expect(parseColor("rgba(10, 20, 30, 1..5)")).toBeNull(); // NaN alpha
    expect(parseColor("rgb(255, 255, 255)")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("rgba(37, 99, 235, 1)")).toEqual({
      r: 37 / 255,
      g: 99 / 255,
      b: 235 / 255,
      a: 1,
    });
  });

  it("parseColor hex path only accepts well-formed 6-digit hex (always in bounds)", () => {
    expect(parseColor("#2563eb")).toEqual({ r: 37 / 255, g: 99 / 255, b: 235 / 255 });
    expect(parseColor("#FFFFFF")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseColor("#gggggg")).toBeNull();
    expect(parseColor("#fff")).toBeNull(); // 3-digit shorthand unsupported
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("not-a-color")).toBeNull();
  });
});

describe("figma-rest-write: preconditions", () => {
  it("errors without a PAT (no env read, no fetch)", async () => {
    const fetchMock = mockVariablesFetch();
    const engine = createFigmaRestWriteEngine({ pat: undefined });
    const result = await engine.apply(makeEdit());
    expect(result.status).toBe("error");
    expect(result.message).toBe("FIGMA_PAT not set.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
