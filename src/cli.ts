#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { parseServeFlags } from "./cli-args.js";
import { startServer } from "./server.js";
import { defaultSeedOptions, parseSeedFlags, seedRegistry } from "./seed.js";
import {
  defaultPullTokensOptions,
  parsePullTokensFlags,
  pullTokens,
} from "./pull-tokens.js";

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

if (command === "pull-tokens") {
  await runPullTokens(args.slice(1));
  process.exit(0);
}

if (command !== "serve") {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

const parsed = parseServeFlags(args.slice(1));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}

const config = await loadConfig();
if (parsed.flags.port !== undefined) config.port = parsed.flags.port;
if (parsed.flags.readOnly) config.writeEnabled = false;

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
  design-sync-pipeline serve       [--port N] [--read-only]
  design-sync-pipeline seed        [--storybook-url URL] [--out PATH]
                                   [--file-key KEY] [--dry-run]
  design-sync-pipeline pull-tokens [--out PATH] [--file-key KEY]
                                   [--collection NAME]
                                   [--known-phantoms a,b,c] [--dry-run]

\`serve\` starts the HTTP server. Reads design-sync-pipeline.config.json from cwd.

\`seed\` walks Storybook's index.json + Figma's components endpoint and best-effort
generates .design-sync/registry.json. Existing entries in the registry are
preserved (manual curation wins). Requires FIGMA_PAT in env. Storybook must be
running (default http://localhost:6006/index.json).

\`pull-tokens\` reads /v1/files/:key/variables/local and writes a DTCG-shaped
tokens.json to --out (default .tokens-pull-output.json). Requires FIGMA_PAT in
env. Reads fileKey + pullTokens defaults from design-sync-pipeline.config.json
when flags are omitted.
`);
}

async function runPullTokens(pullArgs: string[]): Promise<void> {
  const config = await loadConfig();
  const flags = parsePullTokensFlags(pullArgs);
  const defaults = defaultPullTokensOptions(process.cwd());
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

  const collection = flags.collection ?? config.pullTokens?.collection;
  const opts = {
    fileKey,
    pat,
    outPath: flags.outPath ?? defaults.outPath,
    knownPhantoms: flags.knownPhantoms ?? config.pullTokens?.knownPhantoms ?? [],
    dryRun: flags.dryRun ?? false,
    ...(collection ? { collection } : {}),
  };

  console.log(`Pulling tokens from Figma file ${fileKey}...`);
  if (opts.collection) console.log(`  Collection: ${opts.collection}`);
  console.log(`  Output:     ${opts.outPath}${opts.dryRun ? " (dry-run)" : ""}`);
  if (opts.knownPhantoms.length > 0) {
    console.log(`  Phantoms:   ${opts.knownPhantoms.join(", ")}`);
  }

  try {
    const result = await pullTokens(opts);
    console.log("");
    console.log(
      `Wrote ${result.variableCount} token(s) from collection "${result.collection}" (modes: ${result.modes.join(", ")}).`,
    );
    if (result.skippedPhantoms.length > 0) {
      console.log(`Skipped ${result.skippedPhantoms.length} phantom(s): ${result.skippedPhantoms.join(", ")}`);
    }
    if (result.dryRun) console.log(`(dry-run — no file written)`);
    else console.log(`→ ${result.outPath}`);
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`pull-tokens failed: ${m}`);
    process.exit(1);
  }
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
