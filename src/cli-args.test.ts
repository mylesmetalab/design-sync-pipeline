import { describe, expect, it } from "vitest";
import { parseServeFlags } from "./cli-args.js";

describe("parseServeFlags (item 8)", () => {
  it("parses a valid --port", () => {
    const result = parseServeFlags(["--port", "8080"]);
    expect(result).toEqual({ ok: true, flags: { readOnly: false, port: 8080 } });
  });

  it("errors when --port has no value (was silently ignored)", () => {
    const result = parseServeFlags(["--port"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--port requires a value/);
  });

  it("errors when --port is followed by another flag", () => {
    const result = parseServeFlags(["--port", "--read-only"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--port requires a value/);
  });

  it("errors on non-numeric --port values (was silently ignored)", () => {
    for (const bad of ["abc", "80a", "7.5", "-1", "70000"]) {
      const result = parseServeFlags(["--port", bad]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`"${bad}"`);
    }
  });

  it("parses --read-only with and without --port", () => {
    expect(parseServeFlags(["--read-only"])).toEqual({
      ok: true,
      flags: { readOnly: true },
    });
    expect(parseServeFlags(["--read-only", "--port", "7099"])).toEqual({
      ok: true,
      flags: { readOnly: true, port: 7099 },
    });
  });

  it("accepts no flags", () => {
    expect(parseServeFlags([])).toEqual({ ok: true, flags: { readOnly: false } });
  });
});
