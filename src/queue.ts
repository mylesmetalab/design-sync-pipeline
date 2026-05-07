import type { Edit, EditResult } from "./types.js";

/**
 * In-memory queue for figma-scope Edits awaiting an external worker (the
 * Figma plugin). v0 assumes a single subscriber — `claim()` drains the
 * queue. Multi-subscriber routing is future work.
 *
 * Edits move through three states:
 *   - queued      → in queue, no worker has claimed yet
 *   - in_flight   → claimed by a worker via GET /edits/pending
 *   - <terminal>  → applied | rejected | needs_review | error | no_op
 *
 * `awaitResult` is a long-poll helper for clients that want a synchronous
 * apply experience.
 */
export class EditQueue {
  private readonly pending: Edit[] = [];
  private readonly status = new Map<string, EditResult>();

  enqueue(edit: Edit): EditResult {
    this.pending.push(edit);
    const result: EditResult = {
      id: edit.id,
      status: "needs_review",
      engine: "queue",
      message: "Queued for figma worker.",
    };
    this.status.set(edit.id, result);
    return result;
  }

  /**
   * Atomically take all currently-pending edits. Each becomes in_flight
   * until a result is reported. Single-subscriber semantics for v0.
   */
  claim(): Edit[] {
    const claimed = this.pending.splice(0);
    for (const edit of claimed) {
      this.status.set(edit.id, {
        id: edit.id,
        status: "needs_review",
        engine: "queue",
        message: "Claimed by worker.",
      });
    }
    return claimed;
  }

  reportResult(id: string, result: EditResult): boolean {
    if (!this.status.has(id)) return false;
    this.status.set(id, result);
    return true;
  }

  getStatus(id: string): EditResult | undefined {
    return this.status.get(id);
  }

  /**
   * Long-poll up to `timeoutMs` for a terminal status on `id`.
   * Returns the final result, or a `needs_review` placeholder on timeout.
   */
  async awaitResult(id: string, timeoutMs = 30_000, pollMs = 200): Promise<EditResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = this.status.get(id);
      if (current && isTerminal(current.status)) return current;
      await sleep(pollMs);
    }
    return {
      id,
      status: "needs_review",
      engine: "queue",
      message: `Worker did not report within ${timeoutMs}ms — left in flight.`,
    };
  }
}

function isTerminal(status: EditResult["status"]): boolean {
  return status === "applied" || status === "rejected" || status === "error" || status === "no_op";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
