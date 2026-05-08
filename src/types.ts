/**
 * Public contract for the pipeline's HTTP surface and engine adapters.
 *
 * The shapes here mirror (intentionally) the `ProposedEdit` event shape on
 * the addon's channel, plus a typed result. Front-door tools (the Storybook
 * addon, a future Figma plugin) construct `Edit` objects and POST them; the
 * pipeline classifies and routes to a registered engine.
 *
 * Frozen for v0. Changes here ripple to every front door — coordinate.
 */

export type EditKind = "token-binding" | "token-value" | "copy" | "props";
export type EditScope = "code" | "figma";

export interface EditTarget {
  /** Storybook story id, when the edit originates from a story drift row. */
  storyId?: string;
  /** CSS selector identifying the rule to edit (code scope). */
  selector?: string;
  /** Property being edited (CSS prop or Figma binding key). */
  property: string;
  /** Figma node id (figma scope). */
  nodeId?: string;
  /** Figma file key (figma scope). */
  fileKey?: string;
  /** Optional path hint — file that should be edited, when known. */
  path?: string;
}

export interface ModeAwareValue {
  light?: string;
  dark?: string;
}

export interface Edit {
  /** Stable identifier for idempotency / tracking. UUIDv4 recommended. */
  id: string;
  kind: EditKind;
  scope: EditScope;
  target: EditTarget;
  /**
   * The value the edit assumes is currently in place. Engines refuse to
   * apply if the value on disk doesn't match — protects against the
   * source-of-truth having drifted between detection and apply.
   */
  oldValue: string;
  /** The desired new value. */
  newValue: string;
  /** Mode-aware values when the edit is theme-specific. */
  modes?: ModeAwareValue;
  /** Free-form source identifier ("storybook-design-sync", "design-inspector", ...). */
  source: string;
  /** ISO-8601 timestamp from the producer. */
  timestamp: string;
  /**
   * If true, the engine reports what *would* happen (returns a diff) without
   * writing. Required-on for first-contact integration tests.
   */
  dryRun?: boolean;
  /**
   * Inverse of dryRun for engines that default to dry-run (figma-rest-write,
   * figma-plugin). Real writes only happen when `confirm: true`. Producers
   * opt in explicitly per-edit; not a global flag.
   */
  confirm?: boolean;
}

export type EditResultStatus =
  | "applied"
  | "rejected"
  | "needs_review"
  | "error"
  | "no_op";

export interface EditResult {
  id: string;
  status: EditResultStatus;
  /** Engine name that handled (or refused) the edit. */
  engine?: string;
  /** Short human-readable reason. */
  message?: string;
  /** Unified-diff text of what changed (or would change in dry-run). */
  diff?: string;
}

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
