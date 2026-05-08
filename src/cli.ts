#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";
import { defaultSeedOptions, parseSeedFlags, seedRegistry } from "./seed.js";

/**
 * CLI entry. Commands:
 *   design-sync-pipeline serve [--port N] [--read-only]
 *   design-sync-pipeline seed  [--storybook-url URL] [--out PATH] [--dry-run]
 *
 * Reads `design-sync-pipeline.config.json` from cwd for `serve`. `seed`
 * additionally reads FIGMA_PAT from env and the fileKey from the same
 * config (or the --file-key flag).
 */

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "seed") {
  await runSeed(args.slice(1));
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
  design-sync-pipeline seed  [--storybook-url URL] [--out PATH]
                             [--file-key KEY] [--dry-run]

\`serve\` starts the HTTP server. Reads design-sync-pipeline.config.json from cwd.

\`seed\` walks Storybook's index.json + Figma's components endpoint and best-effort
generates .design-sync/registry.json. Existing entries in the registry are
preserved (manual curation wins). Requires FIGMA_PAT in env. Storybook must be
running (default http://localhost:6006/index.json).
`);
}

async function runSeed(seedArgs: string[]): Promise<void> {
  const config = await loadConfig();
  const flags = parseSeedFlags(seedArgs);
  const defaults = defaultSeedOptions(process.cwd());
  const fileKey = flags.fileKey ?? config.fileKey;
  const pat = process.env.FIGMA_PAT;

  if (!fileKey) {
    console.error("Missing fileKey. Pass --file-key or set fileKey in design-sync-pipeline.config.json.");
    process.exit(1);
  }
  if (!pat) {
    console.error("Missing FIGMA_PAT in env.");
    process.exit(1);
  }

  const opts = {
    fileKey,
    pat,
    storybookUrl: flags.storybookUrl ?? defaults.storybookUrl!,
    outPath: flags.outPath ?? defaults.outPath!,
    dryRun: flags.dryRun ?? false,
  };

  console.log(`Seeding from Figma file ${fileKey}...`);
  console.log(`  Storybook: ${opts.storybookUrl}`);
  console.log(`  Output:    ${opts.outPath}${opts.dryRun ? " (dry-run)" : ""}`);

  try {
    const result = await seedRegistry(opts);
    console.log("");
    console.log(`Registered ${result.registered} new stories (preserved ${result.preserved} existing).`);
    if (result.unmatched.length > 0) {
      console.log(`Unmatched: ${result.unmatched.length} stories — no Figma component found:`);
      for (const id of result.unmatched.slice(0, 20)) console.log(`  · ${id}`);
      if (result.unmatched.length > 20) console.log(`  ... +${result.unmatched.length - 20} more`);
    }
    if (result.dryRun) console.log(`(dry-run — no file written)`);
    else console.log(`Wrote ${result.outPath}`);
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`Seed failed: ${m}`);
    process.exit(1);
  }
}
