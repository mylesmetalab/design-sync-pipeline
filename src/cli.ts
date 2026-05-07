#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

/**
 * Tiny CLI entry. v0 supports one command:
 *   design-sync-pipeline serve [--port N] [--read-only]
 *
 * Reads `design-sync-pipeline.config.json` from the current working
 * directory (defaults if absent), then starts the HTTP server on the
 * configured port.
 */

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command !== "serve") {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

const portFlag = args.indexOf("--port");
const portOverride = portFlag !== -1 ? Number(args[portFlag + 1]) : undefined;
const readOnly = args.includes("--read-only");

const config = await loadConfig();
if (portOverride && Number.isFinite(portOverride)) config.port = portOverride;
if (readOnly) config.writeEnabled = false;

const handle = await startServer(process.cwd(), config);

console.log(`design-sync-pipeline listening on http://127.0.0.1:${handle.port}`);
console.log(
  `  health:   GET  /health`,
);
console.log(
  `  engines:  GET  /engines`,
);
console.log(
  `  apply:    POST /edits`,
);
if (!config.writeEnabled) {
  console.log("  (read-only mode — every edit is forced to dryRun)");
}

const shutdown = async (): Promise<void> => {
  console.log("\nShutting down…");
  await handle.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function printHelp(): void {
  console.log(`design-sync-pipeline — local Edit router

Usage:
  design-sync-pipeline serve [--port N] [--read-only]

Reads design-sync-pipeline.config.json from cwd. Without one, uses defaults.
Bind: 127.0.0.1 only — never exposes to LAN.
`);
}
