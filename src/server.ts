import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { applyEdit, buildEngines } from "./engines/index.js";
import type { PipelineConfig } from "./config.js";
import type { Edit, EditResult } from "./types.js";
import { EditQueue } from "./queue.js";

export interface ServerHandle {
  close: () => Promise<void>;
  port: number;
}

/**
 * Maximum accepted request-body size. Edits are small JSON documents; a
 * megabyte is orders of magnitude more than any legitimate payload.
 * Anything larger is destroyed mid-stream and answered with 413.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Start the pipeline HTTP server. Returns a handle with a close() method.
 *
 * Routes:
 *   GET  /health    → liveness check
 *   GET  /engines   → describe registered engines
 *   POST /edits     → apply a single Edit; respond with EditResult
 *
 * No auth, no TLS — strictly localhost-dev. Bind explicitly to 127.0.0.1
 * so we don't accidentally expose to the LAN.
 */
export async function startServer(
  cwd: string,
  config: PipelineConfig,
): Promise<ServerHandle> {
  const engines = buildEngines(cwd, config);
  const queue = new EditQueue();
  const allowedOrigins = parseCorsList(config.cors);
  if (allowedOrigins.includes("*")) {
    // eslint-disable-next-line no-console
    console.warn(
      "[pipeline] cors is configured as \"*\" — any web page can talk to this pipeline. Prefer an explicit origin allowlist.",
    );
  }

  const server = createServer(async (req, res) => {
    setCors(req, res, allowedOrigins);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true, writeEnabled: config.writeEnabled });
        return;
      }

      if (req.method === "GET" && req.url === "/engines") {
        sendJson(res, 200, {
          engines: engines.map((e) => e.info),
          writeEnabled: config.writeEnabled,
        });
        return;
      }

      if (req.method === "POST" && req.url === "/edits") {
        const body = await readBody(req);
        const edit = parseEdit(body);
        if (!edit) {
          sendJson(res, 400, { error: "Invalid Edit payload." });
          return;
        }
        // Try the engine registry first — works for code-scope and any
        // figma-scope edit a registered engine claims (e.g. figma-rest-write
        // for token-value edits). If no engine handles it, fall through to
        // the queue (which the figma-plugin worker drains for token-binding
        // writes that require Plugin API access).
        // eslint-disable-next-line no-console
        console.log(`[pipeline] edit received: kind=${edit.kind} scope=${edit.scope} property=${edit.target.property} oldValue=${JSON.stringify(edit.oldValue)} newValue=${JSON.stringify(edit.newValue)}`);
        const engineResult = await applyEdit(engines, edit, config.writeEnabled);
        if (engineResult.status !== "rejected" || engineResult.message?.startsWith("No engine handles") !== true) {
          logOutcome(engineResult);
          sendJson(res, 200, engineResult);
          return;
        }
        if (edit.scope === "figma") {
          queue.enqueue(edit);
          const result = await queue.awaitResult(edit.id);
          logOutcome(result);
          sendJson(res, 200, result);
          return;
        }
        logOutcome(engineResult);
        sendJson(res, 200, engineResult);
        return;
      }

      // Figma worker (plugin) endpoints.
      if (req.method === "GET" && req.url === "/edits/pending") {
        sendJson(res, 200, { edits: queue.claim() });
        return;
      }

      const resultMatch = req.url?.match(/^\/edits\/([^/]+)\/result$/);
      if (req.method === "POST" && resultMatch) {
        const id = decodeURIComponent(resultMatch[1]!);
        // Validate the id BEFORE parsing the body — unknown ids get a 404
        // without the server buffering or JSON-parsing anything.
        if (!queue.getStatus(id)) {
          req.resume();
          sendJson(res, 404, { error: `No edit with id ${id}` });
          return;
        }
        const body = await readBody(req);
        const result = parseEditResult(body);
        if (!result) {
          sendJson(res, 400, { error: "Invalid EditResult payload." });
          return;
        }
        if (!queue.reportResult(id, { ...result, id })) {
          sendJson(res, 404, { error: `No edit with id ${id}` });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const statusMatch = req.url?.match(/^\/edits\/([^/]+)$/);
      if (req.method === "GET" && statusMatch) {
        const id = decodeURIComponent(statusMatch[1]!);
        const status = queue.getStatus(id);
        if (!status) {
          sendJson(res, 404, { error: `No edit with id ${id}` });
          return;
        }
        sendJson(res, 200, status);
        return;
      }

      sendJson(res, 404, { error: `Not found: ${req.method} ${req.url}` });
    } catch (err: unknown) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        res.once("finish", () => req.destroy());
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, "127.0.0.1", resolve);
  });

  // config.port may be 0 (ephemeral) — report the port actually bound.
  const boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function parseCorsList(cors: string): string[] {
  return cors
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * CORS: echo the request Origin only when it appears in the allowlist.
 * `"*"` (explicit config only — never a default) allows everything.
 * Disallowed origins get no Access-Control-Allow-Origin header at all,
 * so the browser blocks the cross-origin read.
 */
function setCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const origin = req.headers.origin;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function logOutcome(result: EditResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `[pipeline] edit result: id=${result.id} status=${result.status} engine=${result.engine ?? "-"}`,
  );
  if (result.status === "rejected" || result.status === "error") {
    // eslint-disable-next-line no-console
    console.warn(
      `[pipeline] edit ${result.status}: id=${result.id} engine=${result.engine ?? "-"} message=${result.message ?? "-"}`,
    );
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Validate an incoming Edit. Permissive — only the fields the pipeline
 * actually depends on are required. Engines do their own validation.
 */
function parseEdit(raw: string): Edit | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Edit>;
    if (!parsed.id || typeof parsed.id !== "string") return null;
    if (!parsed.kind || !parsed.scope) return null;
    if (typeof parsed.oldValue !== "string" || typeof parsed.newValue !== "string") return null;
    if (!parsed.target || typeof parsed.target !== "object") return null;
    if (!parsed.source || !parsed.timestamp) return null;
    return parsed as Edit;
  } catch {
    return null;
  }
}

function parseEditResult(raw: string): EditResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EditResult>;
    if (typeof parsed.status !== "string") return null;
    return parsed as EditResult;
  } catch {
    return null;
  }
}
