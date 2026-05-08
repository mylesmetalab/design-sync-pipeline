import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Pull Figma Variables → DTCG `tokens.json`.
 *
 * Replaces Syncything's pull half. Reads `/v1/files/:key/variables/local`,
 * walks the named collection, and projects each variable to the DTCG shape
 * the consuming project (e.g. Downmark) already uses on disk.
 *
 * Inputs:
 *   - Figma fileKey + PAT (env)
 *   - Collection name (defaults to first/only collection in the file)
 *   - Optional knownPhantoms: variables that exist on disk but should be
 *     dropped from the pull output (or vice versa — names that exist in
 *     the consuming tokens.json but not in Figma; we never write those back)
 *
 * Output: writes a single JSON file at `outPath`. Shape:
 *   {
 *     "<group>": {
 *       "<key>": {
 *         "$value": "<default-mode value>",
 *         "$type": "color" | "dimension" | "number" | "string" | "boolean",
 *         "$modes": { "<mode-name>": <value>, ... },   // omitted if no other modes
 *         "$extensions": { "figma": { "scopes": [...] } }
 *       }
 *     }
 *   }
 *
 * Type mapping (matches Downmark's existing tokens.json conventions):
 *   - COLOR     → "color"     (hex, with alpha appended if alpha < 1)
 *   - FLOAT in `z/*` group → "number"  (unitless string, e.g. "200")
 *   - FLOAT elsewhere      → "dimension" (px-suffixed string, e.g. "16px")
 *   - STRING    → "string"    (verbatim)
 *   - BOOLEAN   → "boolean"
 *
 * Variable aliases (`{ type: "VARIABLE_ALIAS", id }`) are resolved to the
 * underlying literal in the same mode. Unresolvable aliases throw.
 */

export interface PullTokensOptions {
  fileKey: string;
  pat: string;
  outPath: string;
  collection?: string;
  knownPhantoms: string[];
  dryRun: boolean;
}

export interface PullTokensResult {
  outPath: string;
  variableCount: number;
  modes: string[];
  collection: string;
  skippedPhantoms: string[];
  dryRun: boolean;
}

interface FigmaVariablesLocal {
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: "FLOAT" | "COLOR" | "STRING" | "BOOLEAN";
  variableCollectionId: string;
  valuesByMode: Record<string, FigmaValue>;
  scopes?: string[];
}

interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
}

type FigmaValue =
  | number
  | string
  | boolean
  | { r: number; g: number; b: number; a?: number }
  | { type: "VARIABLE_ALIAS"; id: string };

interface DTCGToken {
  $value: string;
  $type: "color" | "dimension" | "number" | "string" | "boolean";
  $modes?: Record<string, string>;
  $extensions?: { figma?: { scopes?: string[] } };
}

type DTCGTree = Record<string, Record<string, DTCGToken>>;

const FIGMA_API = "https://api.figma.com/v1";

export interface PullTokensFlags {
  fileKey?: string;
  outPath?: string;
  collection?: string;
  knownPhantoms?: string[];
  dryRun?: boolean;
}

export function parsePullTokensFlags(args: string[]): PullTokensFlags {
  const out: PullTokensFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => args[++i] ?? "";
    if (a === "--file-key") out.fileKey = next();
    else if (a === "--out") out.outPath = next();
    else if (a === "--collection") out.collection = next();
    else if (a === "--known-phantoms") {
      const v = args[++i] ?? "";
      out.knownPhantoms = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

export function defaultPullTokensOptions(cwd: string): Pick<PullTokensOptions, "outPath"> {
  return { outPath: resolve(cwd, ".tokens-pull-output.json") };
}

export async function pullTokens(opts: PullTokensOptions): Promise<PullTokensResult> {
  const url = `${FIGMA_API}/files/${encodeURIComponent(opts.fileKey)}/variables/local`;
  const res = await fetch(url, { headers: { "X-Figma-Token": opts.pat } });
  if (!res.ok) {
    throw new Error(`Figma /variables/local ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as FigmaVariablesLocal;

  const collections = Object.values(data.meta.variableCollections);
  if (collections.length === 0) {
    throw new Error(`No variable collections in file ${opts.fileKey}.`);
  }
  const collection = opts.collection
    ? collections.find((c) => c.name === opts.collection)
    : collections[0]!;
  if (!collection) {
    throw new Error(
      `Collection "${opts.collection}" not found. Available: ${collections.map((c) => c.name).join(", ")}.`,
    );
  }

  const defaultMode = collection.modes.find((m) => m.modeId === collection.defaultModeId);
  if (!defaultMode) {
    throw new Error(`Collection "${collection.name}" has no default mode.`);
  }
  const otherModes = collection.modes.filter((m) => m.modeId !== collection.defaultModeId);

  const phantomSet = new Set(opts.knownPhantoms);
  const skippedPhantoms: string[] = [];

  const variables = Object.values(data.meta.variables).filter(
    (v) => v.variableCollectionId === collection.id,
  );

  const tree: DTCGTree = {};
  let included = 0;

  for (const variable of variables) {
    if (phantomSet.has(variable.name)) {
      skippedPhantoms.push(variable.name);
      continue;
    }

    const [group, ...rest] = variable.name.split("/");
    if (!group || rest.length === 0) {
      // Non-grouped variable (e.g. a designer's orphaned scratch token).
      // Skip with a warning rather than aborting — the consuming project
      // can add it to knownPhantoms to silence this if intentional.
      console.warn(
        `  ! skipping "${variable.name}" — no group/key separator (expected "group/name")`,
      );
      continue;
    }
    const key = rest.join("/");

    const $type = mapType(variable, group);
    const defaultRaw = variable.valuesByMode[defaultMode.modeId];
    if (defaultRaw === undefined) {
      throw new Error(`Variable "${variable.name}" missing value for default mode "${defaultMode.name}".`);
    }
    const $value = formatValue(defaultRaw, $type, variable, defaultMode.modeId, data.meta.variables);

    const $modes: Record<string, string> = {};
    for (const m of otherModes) {
      const raw = variable.valuesByMode[m.modeId];
      if (raw === undefined) continue;
      const formatted = formatValue(raw, $type, variable, m.modeId, data.meta.variables);
      // Suppress no-op overrides — if the mode value equals the default,
      // don't bloat tokens.json with a redundant $modes entry. Matches the
      // existing tokens.json convention (Light == Dark traffic lights and
      // mode-invariant non-color tokens carry no $modes block).
      if (formatted === $value) continue;
      $modes[m.name.toLowerCase()] = formatted;
    }

    const token: DTCGToken = { $value, $type };
    if (Object.keys($modes).length > 0) token.$modes = $modes;
    if (variable.scopes && variable.scopes.length > 0) {
      token.$extensions = { figma: { scopes: [...variable.scopes] } };
    }

    if (!tree[group]) tree[group] = {};
    tree[group]![key] = token;
    included++;
  }

  if (!opts.dryRun) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, JSON.stringify(tree, null, 2) + "\n", "utf8");
  }

  return {
    outPath: opts.outPath,
    variableCount: included,
    modes: collection.modes.map((m) => m.name),
    collection: collection.name,
    skippedPhantoms,
    dryRun: opts.dryRun,
  };
}

function mapType(variable: FigmaVariable, group: string): DTCGToken["$type"] {
  switch (variable.resolvedType) {
    case "COLOR":
      return "color";
    case "STRING":
      return "string";
    case "BOOLEAN":
      return "boolean";
    case "FLOAT":
      // Convention: the `z/*` group holds unitless layering numbers; everything
      // else is a CSS dimension. Matches Downmark's existing tokens.json.
      return group === "z" ? "number" : "dimension";
  }
}

function formatValue(
  raw: FigmaValue,
  type: DTCGToken["$type"],
  variable: FigmaVariable,
  modeId: string,
  allVariables: Record<string, FigmaVariable>,
): string {
  // Resolve aliases to the target's literal in the same mode.
  if (isAlias(raw)) {
    const target = allVariables[raw.id];
    if (!target) {
      throw new Error(`Variable "${variable.name}" aliases unknown variable id ${raw.id}.`);
    }
    const targetRaw = target.valuesByMode[modeId];
    if (targetRaw === undefined) {
      throw new Error(
        `Alias "${variable.name}" → "${target.name}" missing value for mode ${modeId}.`,
      );
    }
    return formatValue(targetRaw, type, target, modeId, allVariables);
  }

  switch (type) {
    case "color":
      return formatColor(raw);
    case "dimension":
      if (typeof raw !== "number") {
        throw new Error(`Variable "${variable.name}" expected FLOAT, got ${typeof raw}.`);
      }
      return `${formatNumber(raw)}px`;
    case "number":
      if (typeof raw !== "number") {
        throw new Error(`Variable "${variable.name}" expected FLOAT, got ${typeof raw}.`);
      }
      return formatNumber(raw);
    case "string":
      if (typeof raw !== "string") {
        throw new Error(`Variable "${variable.name}" expected STRING, got ${typeof raw}.`);
      }
      return raw;
    case "boolean":
      if (typeof raw !== "boolean") {
        throw new Error(`Variable "${variable.name}" expected BOOLEAN, got ${typeof raw}.`);
      }
      return raw ? "true" : "false";
  }
}

function isAlias(v: FigmaValue): v is { type: "VARIABLE_ALIAS"; id: string } {
  return typeof v === "object" && v !== null && "type" in v && (v as { type?: string }).type === "VARIABLE_ALIAS";
}

function formatColor(raw: FigmaValue): string {
  if (typeof raw !== "object" || raw === null || !("r" in raw)) {
    throw new Error(`Expected a {r,g,b,a} color value, got ${JSON.stringify(raw)}.`);
  }
  const { r, g, b, a = 1 } = raw;
  const hex = (n: number): string => {
    const v = Math.round(Math.max(0, Math.min(1, n)) * 255);
    return v.toString(16).padStart(2, "0");
  };
  let out = `#${hex(r)}${hex(g)}${hex(b)}`;
  if (a < 1) out += hex(a);
  return out;
}

function formatNumber(n: number): string {
  // Figma stores integers as floats; trim trailing ".0" but preserve real
  // fractional values (rare for these token types but harmless).
  return Number.isInteger(n) ? String(n) : String(n);
}

export async function readKnownPhantomsFromConfig(
  cwd: string,
): Promise<string[] | undefined> {
  // Convenience: read knownPhantoms from design-sync-pipeline.config.json's
  // pullTokens block if present. CLI `--known-phantoms` flag overrides.
  try {
    const raw = await readFile(resolve(cwd, "design-sync-pipeline.config.json"), "utf8");
    const cfg = JSON.parse(raw) as { pullTokens?: { knownPhantoms?: unknown } };
    const v = cfg.pullTokens?.knownPhantoms;
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
      return v as string[];
    }
  } catch {
    /* no config or unreadable — caller falls back */
  }
  return undefined;
}
