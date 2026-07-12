import { describe, expect, it } from "vitest";
import { EditQueue } from "./queue.js";
import type { Edit, EditResult } from "./types.js";

function makeEdit(id: string): Edit {
  return {
    id,
    kind: "token-binding",
    scope: "figma",
    target: { property: "fill" },
    oldValue: "old",
    newValue: "new",
    source: "test",
    timestamp: new Date().toISOString(),
  };
}

describe("EditQueue", () => {
  it("enqueue → claim → reportResult round-trip", () => {
    const queue = new EditQueue();
    queue.enqueue(makeEdit("e1"));
    expect(queue.getStatus("e1")?.status).toBe("needs_review");

    const claimed = queue.claim();
    expect(claimed.map((e) => e.id)).toEqual(["e1"]);
    expect(queue.getStatus("e1")?.message).toBe("Claimed by worker.");

    const final: EditResult = { id: "e1", status: "applied", engine: "figma-plugin" };
    expect(queue.reportResult("e1", final)).toBe(true);
    expect(queue.getStatus("e1")).toEqual(final);
  });

  it("reportResult returns false for unknown ids", () => {
    const queue = new EditQueue();
    expect(queue.reportResult("nope", { id: "nope", status: "applied" })).toBe(false);
  });

  it("awaitResult resolves with the reported terminal result", async () => {
    const queue = new EditQueue();
    queue.enqueue(makeEdit("e2"));
    setTimeout(() => {
      queue.reportResult("e2", { id: "e2", status: "applied", engine: "figma-plugin" });
    }, 50);
    const result = await queue.awaitResult("e2", 2_000, 10);
    expect(result.status).toBe("applied");
  });

  it("awaitResult timeout returns status error (not needs_review) with a clear message", async () => {
    const queue = new EditQueue();
    queue.enqueue(makeEdit("e3"));
    const result = await queue.awaitResult("e3", 100, 20);
    expect(result.status).toBe("error");
    expect(result.engine).toBe("queue");
    expect(result.message).toMatch(/did not report a result within 100ms/);
  });

  it("awaitResult timeout PERSISTS the error so later polls see it", async () => {
    const queue = new EditQueue();
    queue.enqueue(makeEdit("e4"));
    const result = await queue.awaitResult("e4", 100, 20);
    // The fabricated timeout result must be persisted — callers polling
    // GET /edits/:id afterwards must be able to distinguish "worker hung"
    // (error) from "still in flight" (needs_review).
    expect(queue.getStatus("e4")).toEqual(result);
    expect(queue.getStatus("e4")?.status).toBe("error");
  });
});
