import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, startServer, type ServerHandle } from "./server.js";
import { DEFAULT_CORS_ALLOWLIST, type PipelineConfig } from "./config.js";
import type { Edit } from "./types.js";

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    port: 0, // ephemeral — the handle reports the bound port
    cors: DEFAULT_CORS_ALLOWLIST.join(","),
    writeEnabled: false,
    codeTargets: [],
    ...overrides,
  };
}

function makeEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: `edit-${Math.random().toString(36).slice(2)}`,
    kind: "token-binding",
    scope: "figma",
    target: { property: "fill" },
    oldValue: "old",
    newValue: "new",
    source: "test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const handles: ServerHandle[] = [];

async function boot(config: PipelineConfig = makeConfig()): Promise<{ base: string; handle: ServerHandle }> {
  const handle = await startServer(process.cwd(), config);
  handles.push(handle);
  return { base: `http://127.0.0.1:${handle.port}`, handle };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((h) => h.close().catch(() => undefined)));
});

describe("server: request-size limit (item 1)", () => {
  it("responds 413 when the body exceeds MAX_BODY_BYTES", async () => {
    const { base } = await boot();
    const oversized = "x".repeat(MAX_BODY_BYTES + 1024);
    const res = await fetch(`${base}/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exceeds the \d+-byte limit/);
  });

  it("accepts bodies under the limit", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeEdit({ kind: "props", scope: "code" })),
    });
    expect(res.status).toBe(200);
  });
});

describe("server: POST /edits/:id/result id validation (item 3)", () => {
  it("rejects unknown ids with 404 WITHOUT parsing the body", async () => {
    const { base } = await boot();
    // Invalid JSON body: the old code parsed first and answered 400.
    // The hardened code checks the id first and answers 404.
    const res = await fetch(`${base}/edits/unknown-id/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{not json",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No edit with id unknown-id/);
  });

  it("still validates the body (400) for known ids, and accepts valid results", async () => {
    const { base } = await boot();
    const edit = makeEdit(); // token-binding × figma → queued for the worker

    // Fire the apply; it long-polls until the worker reports.
    const applyPromise = fetch(`${base}/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit),
    });

    // Wait for the edit to be claimable, then claim it like the plugin would.
    let claimed: Edit[] = [];
    for (let i = 0; i < 100 && claimed.length === 0; i++) {
      const pending = await fetch(`${base}/edits/pending`);
      claimed = ((await pending.json()) as { edits: Edit[] }).edits;
      if (claimed.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(claimed.map((e) => e.id)).toEqual([edit.id]);

    // Known id + garbage body → 400 (body validation still happens).
    const badBody = await fetch(`${base}/edits/${edit.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{not json",
    });
    expect(badBody.status).toBe(400);

    // Known id + valid body → 200, and the long-poll resolves with it.
    const good = await fetch(`${base}/edits/${edit.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: edit.id, status: "applied", engine: "figma-plugin" }),
    });
    expect(good.status).toBe(200);

    const applyRes = await applyPromise;
    const result = (await applyRes.json()) as { status: string; engine: string };
    expect(result.status).toBe("applied");
    expect(result.engine).toBe("figma-plugin");
  });
});

describe("server: CORS pinning (item 6)", () => {
  it("echoes the Origin for allowlisted localhost dev origins", async () => {
    const { base } = await boot();
    for (const origin of ["http://localhost:6006", "http://127.0.0.1:5173", "http://localhost:3000"]) {
      const res = await fetch(`${base}/health`, { headers: { Origin: origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toBe("Origin");
    }
  });

  it("omits Access-Control-Allow-Origin for disallowed origins", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`, { headers: { Origin: "http://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("honors an explicit '*' config but warns at startup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { base } = await boot(makeConfig({ cors: "*" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cors is configured as "*"'));
    const res = await fetch(`${base}/health`, { headers: { Origin: "http://anywhere.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("honors an explicit custom allowlist", async () => {
    const { base } = await boot(makeConfig({ cors: "http://localhost:8080" }));
    const allowed = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:8080" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:8080");
    const denied = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:6006" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("server: outcome logging (item 7)", () => {
  it("logs the outcome (id, status, engine) and warns on rejection", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { base } = await boot();

    // props × code has no engine → rejected outcome.
    const edit = makeEdit({ kind: "props", scope: "code" });
    const res = await fetch(`${base}/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edit),
    });
    expect(res.status).toBe(200);

    const outcomeLine = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("edit result:"));
    expect(outcomeLine).toBeDefined();
    expect(outcomeLine).toContain(`id=${edit.id}`);
    expect(outcomeLine).toContain("status=rejected");

    const warnLine = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("edit rejected:"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain(`id=${edit.id}`);
  });
});
