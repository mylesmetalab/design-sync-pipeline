/**
 * Public contract for the pipeline's HTTP surface and engine adapters.
 *
 * The wire-contract types (`Edit`, `EditResult`, and their supporting
 * shapes) now live in `@metalab/design-sync-core` — the single source of
 * truth shared across the addon, the pipeline, and the Figma plugin. They
 * are re-exported here so `src/index.ts` consumers see the same surface
 * they always have.
 *
 * The pipeline-specific `EngineInfo` / `PipelineEngine` interfaces stay
 * local; they reference the shared `Edit` / `EditResult` types imported
 * from core.
 *
 * Frozen for v0. Changes to the wire contract belong in core — coordinate.
 */

export type {
  EditKind,
  EditScope,
  EditTarget,
  ModeAwareValue,
  Edit,
  EditResultStatus,
  EditResult,
} from "@metalab/design-sync-core";

import type { Edit, EditKind, EditScope, EditResult } from "@metalab/design-sync-core";

export interface EngineInfo {
  name: string;
  /** Brief description shown in `GET /engines` output. */
  description: string;
  /**
   * The kinds + scopes this engine claims to handle. Used by the router to
   * pick a candidate; the engine's own `canHandle` is the final word.
   */
  handles: Array<{ kind: EditKind; scope: EditScope }>;
  /** Engines where idempotent re-apply is safe can advertise this. */
  idempotent: boolean;
  /** Whether this engine writes (vs. dry-run only). */
  writeCapable: boolean;
}

export interface PipelineEngine {
  readonly info: EngineInfo;
  canHandle(edit: Edit): boolean;
  apply(edit: Edit): Promise<EditResult>;
}
