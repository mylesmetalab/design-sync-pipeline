import type { PipelineEngine, Edit, EditResult } from "../types.js";
import type { PipelineConfig } from "../config.js";
import { createCssTokenSwapEngine } from "./code-css-token-swap.js";
import { createFigmaRestWriteEngine } from "./figma-rest-write.js";

/**
 * Build the engine roster from a config + cwd. v0 hard-codes the registry;
 * future versions will let consumers register additional engines (e.g.
 * Baluarte) at boot via a `pipeline.engines.ts` file or similar.
 */
export function buildEngines(cwd: string, config: PipelineConfig): PipelineEngine[] {
  return [
    createCssTokenSwapEngine(cwd, config.codeTargets),
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
