import type { PipelineEngine, Edit, EditResult } from "../types.js";
import type { PipelineConfig } from "../config.js";
import { createCssPostcssEngine } from "./code-css-postcss.js";
import { createTsxInlineEngine } from "./code-tsx-inline.js";
import { createFigmaRestWriteEngine } from "./figma-rest-write.js";

/**
 * Build the engine roster from a config + cwd. v0 hard-codes the registry;
 * future versions will let consumers register additional engines at boot
 * via a `pipeline.engines.ts` file or similar.
 *
 * Engine ordering: `pickEngine` picks the first engine whose `handles`
 * matrix matches AND whose `canHandle` returns true. The TSX and CSS
 * engines both declare `code × token-binding` / `code × token-value`;
 * each one's `canHandle` is what disambiguates — both filter
 * `codeTargets` by file extension at construction time and return true
 * only if at least one target matches. No extension overlap, so order
 * is a non-issue. TSX listed first as a stylistic convention.
 */
export function buildEngines(cwd: string, config: PipelineConfig): PipelineEngine[] {
  return [
    createTsxInlineEngine(cwd, config.codeTargets),
    createCssPostcssEngine(cwd, config.codeTargets),
    createFigmaRestWriteEngine({ pat: process.env.FIGMA_PAT }),
  ];
}

/**
 * Pick the first engine that claims to handle the edit. Returns null if
 * none — caller should respond with `rejected: no engine`.
 */
export function pickEngine(
  engines: PipelineEngine[],
  edit: Edit,
): PipelineEngine | null {
  for (const engine of engines) {
    const declared = engine.info.handles.some(
      (h) => h.kind === edit.kind && h.scope === edit.scope,
    );
    if (declared && engine.canHandle(edit)) return engine;
  }
  return null;
}

export async function applyEdit(
  engines: PipelineEngine[],
  edit: Edit,
  writeEnabled: boolean,
): Promise<EditResult> {
  const engine = pickEngine(engines, edit);
  if (!engine) {
    return {
      id: edit.id,
      status: "rejected",
      message: `No engine handles ${edit.kind}/${edit.scope}.`,
    };
  }
  // Force dryRun when the pipeline is in read-only mode.
  const effectiveEdit: Edit = writeEnabled ? edit : { ...edit, dryRun: true };
  return engine.apply(effectiveEdit);
}
