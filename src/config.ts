import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Pipeline configuration. Read from `design-sync-pipeline.config.json` in
 * the working directory of the consuming project (e.g. Downmark).
 *
 * The pipeline is started with `cwd` pointing at that project; it reads
 * the config, instantiates engines accordingly, and serves on the
 * configured port.
 */

export interface CodeTarget {
  /** Path to the file (relative to project root). */
  path: string;
  /**
   * Optional CSS selector that scopes which rule(s) inside the file the
   * engine is allowed to touch. When set, edits referencing other selectors
   * are rejected.
   */
  scopeSelector?: string;
}

export interface PipelineConfig {
  /** Port to serve on. Default 7099. */
  port: number;
  /** Allowed origin(s) for CORS. Default `*` (localhost dev). */
  cors: string;
  /** Whether to allow writes. When false, every edit is forced to dryRun. */
  writeEnabled: boolean;
  /**
   * Code-side targets the `code-css-token-swap` engine knows about. v0 is
   * a flat list; later versions will key by storyId / selector. Adding
   * more advanced engines (Baluarte, AST) later means adding sibling
   * config sections, not changing this one.
   */
  codeTargets: CodeTarget[];
  /**
   * Default Figma file key. Optional for `serve`; used by `seed` and
   * `pull-tokens` when no --file-key flag is passed.
   */
  fileKey?: string;
  /**
   * Defaults for the `pull-tokens` command. Overridden by CLI flags.
   */
  pullTokens?: {
    /** Variable collection name. Defaults to first collection in the file. */
    collection?: string;
    /**
     * Variable names that exist in the consuming project's tokens.json but
     * not in Figma (or vice versa). Skipped from pull output.
     */
    knownPhantoms?: string[];
  };
}

const DEFAULTS: PipelineConfig = {
  port: 7099,
  cors: "*",
  // Read-only by default — matches the stated principle in the README and
  // ARCHITECTURE.md. First-touch installs get a safe pipeline that returns
  // diffs without writing; producers must opt in via
  // `writeEnabled: true` in their config (or pass `--write` at the CLI).
  writeEnabled: false,
  codeTargets: [],
};

const CANDIDATES = ["design-sync-pipeline.config.json"];

export async function loadConfig(cwd: string = process.cwd()): Promise<PipelineConfig> {
  for (const name of CANDIDATES) {
    const full = resolve(cwd, name);
    try {
      const raw = await readFile(full, "utf8");
      return normalize(JSON.parse(raw));
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
  // No config — return safe defaults. The pipeline still serves; engines
  // with no targets simply refuse all edits with a helpful message.
  return { ...DEFAULTS };
}

function normalize(raw: unknown): PipelineConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("[design-sync-pipeline] Config must be an object.");
  }
  const r = raw as Partial<PipelineConfig>;
  const out: PipelineConfig = {
    port: r.port ?? DEFAULTS.port,
    cors: r.cors ?? DEFAULTS.cors,
    writeEnabled: r.writeEnabled ?? DEFAULTS.writeEnabled,
    codeTargets: r.codeTargets ?? DEFAULTS.codeTargets,
  };
  if (r.fileKey) out.fileKey = r.fileKey;
  if (r.pullTokens) out.pullTokens = r.pullTokens;
  return out;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
