import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Walk Figma + Storybook and best-effort generate `.design-sync/registry.json`.
 *
 * Inputs:
 *   - Figma fileKey + PAT (from env or flags)
 *   - Storybook index URL (default http://localhost:6006/index.json)
 *   - Output path (default .design-sync/registry.json)
 *
 * Algorithm (intentionally conservative — unmatched stories are reported,
 * not invented):
 *   1. Fetch Figma /v1/files/:key/components → list of (name, node_id, parent)
 *   2. Build a "component name → [variants]" index, where the key is the
 *      *lowercased, hyphens-stripped* form so `.icon-button` matches
 *      "IconButton" automatically.
 *   3. Fetch Storybook's `index.json` (the v4+ format). For each story id
 *      like `atoms-iconbutton--accent`:
 *        a. Extract the component segment ("iconbutton" — last word of the
 *           pre-`--` part)
 *        b. Look up that component in the Figma index
 *        c. Extract the variant suffix ("accent")
 *        d. Find the Figma variant whose name *contains* "accent"
 *           (case-insensitive). State=Accent matches.
 *        e. If found, register `storyId → nodeId`. Else: report unmatched.
 *   4. Merge with existing registry (preserve manually-curated entries),
 *      write the result.
 */

interface SeedOptions {
  fileKey: string;
  pat: string;
  storybookUrl: string;
  outPath: string;
  dryRun: boolean;
}

interface FigmaComponent {
  name: string;
  node_id: string;
  containing_frame?: { nodeId?: string; name?: string; pageName?: string };
}

interface FigmaComponentsResponse {
  meta?: { components?: FigmaComponent[] };
}

interface StorybookIndexEntry {
  id: string;
  type: "story" | "docs";
  title: string;
  name: string;
  importPath?: string;
}

interface StorybookIndex {
  v?: number;
  entries: Record<string, StorybookIndexEntry>;
}

interface ExistingRegistry {
  fileKey: string;
  stories: Record<string, { nodeId: string; lastSyncedHash: string | null }>;
}

interface SeedResult {
  registered: number;
  unmatched: string[];
  preserved: number;
  outPath: string;
  dryRun: boolean;
}

const stripHyphens = (s: string): string => s.replace(/[-_]/g, "").toLowerCase();

export async function seedRegistry(opts: SeedOptions): Promise<SeedResult> {
  const componentsUrl = `https://api.figma.com/v1/files/${encodeURIComponent(opts.fileKey)}/components`;
  const compRes = await fetch(componentsUrl, { headers: { "X-Figma-Token": opts.pat } });
  if (!compRes.ok) {
    throw new Error(`Figma /components ${compRes.status}: ${await compRes.text()}`);
  }
  const compData = (await compRes.json()) as FigmaComponentsResponse;
  const components = compData.meta?.components ?? [];

  // Build "compName-stripped → [variants]" index
  const byComponent = new Map<string, Array<{ name: string; nodeId: string }>>();
  // Also index the parent COMPONENT_SET names for matching
  const setNames = new Map<string, string>(); // parentNodeId → parentName
  for (const c of components) {
    const parentName = c.containing_frame?.name;
    const parentId = c.containing_frame?.nodeId;
    if (parentName && parentId && parentName !== c.containing_frame?.pageName) {
      // Variant within a SET
      const key = stripHyphens(parentName);
      if (!byComponent.has(key)) byComponent.set(key, []);
      byComponent.get(key)!.push({ name: c.name, nodeId: c.node_id });
      setNames.set(parentId, parentName);
    } else {
      // Top-level COMPONENT (no SET parent, or parent is the page itself)
      const key = stripHyphens(c.name);
      if (!byComponent.has(key)) byComponent.set(key, []);
      byComponent.get(key)!.push({ name: c.name, nodeId: c.node_id });
    }
  }

  // Fetch Storybook index
  const indexRes = await fetch(opts.storybookUrl);
  if (!indexRes.ok) {
    throw new Error(`Storybook index ${indexRes.status}: is Storybook running on ${opts.storybookUrl}?`);
  }
  const idx = (await indexRes.json()) as StorybookIndex;

  // Read existing registry (if any) so we preserve manually-curated entries
  let existing: ExistingRegistry = { fileKey: opts.fileKey, stories: {} };
  try {
    const raw = await readFile(opts.outPath, "utf8");
    existing = JSON.parse(raw) as ExistingRegistry;
  } catch {
    /* no existing registry; start fresh */
  }

  const newRegistry: ExistingRegistry = {
    fileKey: opts.fileKey,
    stories: { ...existing.stories },
  };

  const unmatched: string[] = [];
  let registeredThisRun = 0;

  for (const [id, entry] of Object.entries(idx.entries)) {
    if (entry.type !== "story") continue;
    if (existing.stories[id]) continue; // preserve manual curation

    // storyId → component segment + variant suffix
    const beforeDoubleDash = id.split("--")[0] ?? "";
    const variant = id.split("--")[1] ?? "";
    const segments = beforeDoubleDash.split("-");
    // Try the last segment first (most specific), then progressively join
    // earlier segments in case the component name is multi-word
    // ("nav-history-buttons" → "navhistorybuttons" matches "NavHistoryButtons").
    const candidates: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      candidates.push(stripHyphens(segments.slice(i).join("")));
    }

    let match: { name: string; nodeId: string } | null = null;
    let matchedKey: string | null = null;
    for (const candidate of candidates) {
      const variants = byComponent.get(candidate);
      if (!variants || variants.length === 0) continue;
      matchedKey = candidate;
      // Find variant whose name contains the suffix (case-insensitive).
      // For sets: "State=Accent" contains "accent"; for top-level COMPONENT
      // there's only one variant which we accept.
      if (variants.length === 1) {
        match = variants[0]!;
      } else {
        const v = variants.find((x) => stripHyphens(x.name).includes(stripHyphens(variant)));
        match = v ?? variants[0]!;
      }
      break;
    }

    if (match) {
      newRegistry.stories[id] = { nodeId: match.nodeId, lastSyncedHash: null };
      registeredThisRun++;
    } else {
      unmatched.push(id);
    }
  }

  if (!opts.dryRun) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, JSON.stringify(newRegistry, null, 2) + "\n", "utf8");
  }

  return {
    registered: registeredThisRun,
    unmatched,
    preserved: Object.keys(existing.stories).length,
    outPath: opts.outPath,
    dryRun: opts.dryRun,
  };
}

export function parseSeedFlags(args: string[]): Partial<SeedOptions> {
  const out: Partial<SeedOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];
    if (flag === "--file-key" && next) { out.fileKey = next; i++; }
    else if (flag === "--storybook-url" && next) { out.storybookUrl = next; i++; }
    else if (flag === "--out" && next) { out.outPath = next; i++; }
    else if (flag === "--dry-run") { out.dryRun = true; }
  }
  return out;
}

export function defaultSeedOptions(cwd: string): Partial<SeedOptions> {
  return {
    storybookUrl: "http://localhost:6006/index.json",
    outPath: resolve(cwd, ".design-sync/registry.json"),
    dryRun: false,
  };
}
