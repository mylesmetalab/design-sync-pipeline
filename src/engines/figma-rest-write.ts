import type { Edit, EditResult, PipelineEngine } from "../types.js";

/**
 * Figma REST write engine — handles `token-value × figma` edits by updating
 * a *variable's value in a specific mode* via Figma's POST /v1/files/:key/variables.
 *
 * What it changes
 *   The numeric/color value of an existing Figma variable, in a specific
 *   mode (e.g. "Light" or "Dark"). Doesn't touch bindings — those go via
 *   the figma-plugin worker.
 *
 * What it doesn't do
 *   - Create variables / collections / modes
 *   - Set boundVariables on a node (Plugin API surface only)
 *   - Aliased variables (where one variable references another)
 *
 * Risks
 *   Variable value writes are GLOBAL — every node in the file (and any
 *   library consumer) bound to that variable picks up the new value. The
 *   blast radius is one click → potentially many components. Keep dry-run
 *   default; require explicit `confirm: true` to actually write.
 *
 * Auth
 *   FIGMA_PAT must have write scope ("file_variables:write" + "file_content:read"
 *   on the file). Read-only PATs hit 403 with a clear message.
 */

const FIGMA_API = "https://api.figma.com/v1";
const ENGINE_NAME = "figma-rest-write";

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
  valuesByMode: Record<string, unknown>;
}

interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
}

interface PostVariablesBody {
  variableModeValues?: Array<{
    variableId: string;
    modeId: string;
    value: number | string | boolean | { r: number; g: number; b: number; a?: number };
  }>;
}

export interface FigmaRestWriteContext {
  pat: string | undefined;
}

export function createFigmaRestWriteEngine(ctx: FigmaRestWriteContext): PipelineEngine {
  return {
    info: {
      name: ENGINE_NAME,
      description: "Updates a Figma variable's value in a specific mode via REST. Use for token-value drift on the Figma side. Cannot set boundVariables — that's the Plugin API.",
      handles: [{ kind: "token-value", scope: "figma" }],
      idempotent: false,
      writeCapable: true,
    },
    canHandle(edit: Edit): boolean {
      return edit.scope === "figma" && edit.kind === "token-value";
    },
    async apply(edit: Edit): Promise<EditResult> {
      if (!ctx.pat) {
        return { id: edit.id, status: "error", engine: ENGINE_NAME, message: "FIGMA_PAT not set." };
      }
      if (!edit.target.fileKey) {
        return { id: edit.id, status: "rejected", engine: ENGINE_NAME, message: "target.fileKey is required." };
      }

      // The edit must specify which variable, by name. We resolve via the
      // local-variables endpoint.
      const variableName = edit.newValue.startsWith("@token:")
        ? edit.newValue.slice("@token:".length)
        : extractTokenNameFromHint(edit) || "";
      if (!variableName) {
        return {
          id: edit.id,
          status: "rejected",
          engine: ENGINE_NAME,
          message: "Could not determine which variable to update. Pass the token name in oldValue/newValue or via target.property.",
        };
      }

      const fetchUrl = `${FIGMA_API}/files/${encodeURIComponent(edit.target.fileKey)}/variables/local`;
      const variablesRes = await fetch(fetchUrl, { headers: { "X-Figma-Token": ctx.pat } });
      if (!variablesRes.ok) {
        return {
          id: edit.id,
          status: "error",
          engine: ENGINE_NAME,
          message: `Figma /variables/local returned ${variablesRes.status}.`,
        };
      }
      const variables = (await variablesRes.json()) as FigmaVariablesLocal;

      const variable = Object.values(variables.meta.variables).find((v) => v.name === variableName);
      if (!variable) {
        return {
          id: edit.id,
          status: "rejected",
          engine: ENGINE_NAME,
          message: `Variable "${variableName}" not found in file ${edit.target.fileKey}.`,
        };
      }

      const collection = variables.meta.variableCollections[variable.variableCollectionId];
      if (!collection) {
        return { id: edit.id, status: "error", engine: ENGINE_NAME, message: "Variable's collection not found." };
      }

      // Pick the mode. Edit may carry one explicitly via modes.{light,dark};
      // otherwise default to the collection's default mode. A named mode
      // that doesn't exist in the collection is a hard rejection — silently
      // writing the default mode instead would corrupt the wrong theme.
      let targetMode = collection.modes.find((m) => m.modeId === collection.defaultModeId)!;
      const modeOverride = edit.modes?.light ? "light" : edit.modes?.dark ? "dark" : null;
      if (modeOverride) {
        const found = collection.modes.find((m) => m.name.toLowerCase() === modeOverride);
        if (!found) {
          const available = collection.modes.map((m) => m.name).join(", ");
          return {
            id: edit.id,
            status: "rejected",
            engine: ENGINE_NAME,
            message: `Mode "${modeOverride}" not found in collection "${collection.name}". Available modes: ${available}.`,
          };
        }
        targetMode = found;
      }

      // Parse the desired value from the edit. For numeric variables we
      // expect a "8px" or "8" string; for colors we expect "rgb(...)" or
      // a hex string.
      const parsedValue = parseValueForVariable(edit.newValue, variable.resolvedType);
      if (parsedValue === null) {
        return {
          id: edit.id,
          status: "rejected",
          engine: ENGINE_NAME,
          message: `Could not parse "${edit.newValue}" as ${variable.resolvedType}.`,
        };
      }

      const before = variable.valuesByMode[targetMode.modeId];
      const diff = `${variable.name} (mode: ${targetMode.name})\n- ${JSON.stringify(before)}\n+ ${JSON.stringify(parsedValue)}`;

      // Two gates close on real writes:
      //   1) `edit.dryRun: true` — producer explicitly requested a preview.
      //      Honored even when `confirm: true` is also set (producer wins
      //      both directions; dry-run is the safer outcome on conflict).
      //   2) `!edit.confirm` — producer hasn't opted in. Engines that write
      //      Figma default to dry-run; real writes are always explicit.
      if (edit.dryRun || !edit.confirm) {
        return {
          id: edit.id,
          status: "no_op",
          engine: ENGINE_NAME,
          message: `Dry-run. Would update ${variable.name} (${targetMode.name}) → ${edit.newValue}.`,
          diff,
        };
      }

      // Real write: POST /v1/files/:key/variables
      const writeUrl = `${FIGMA_API}/files/${encodeURIComponent(edit.target.fileKey)}/variables`;
      const body: PostVariablesBody = {
        variableModeValues: [
          {
            variableId: variable.id,
            modeId: targetMode.modeId,
            value: parsedValue,
          },
        ],
      };
      const writeRes = await fetch(writeUrl, {
        method: "POST",
        headers: {
          "X-Figma-Token": ctx.pat,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!writeRes.ok) {
        const text = await writeRes.text();
        return {
          id: edit.id,
          status: "error",
          engine: ENGINE_NAME,
          message: `Figma write returned ${writeRes.status}: ${text.slice(0, 200)}`,
        };
      }

      return {
        id: edit.id,
        status: "applied",
        engine: ENGINE_NAME,
        message: `Updated ${variable.name} (${targetMode.name}) → ${edit.newValue}`,
        diff,
      };
    },
  };
}

/**
 * The drift report emits Figma values like "8px (token: space/8)" or
 * "rgb(37, 99, 235)" — strings that bake the token name and value
 * together. The token-value Edit's newValue carries one of these
 * shapes; we extract the token name when present.
 */
function extractTokenNameFromHint(edit: Edit): string | null {
  const m = /token:\s*([^)]+)\)/.exec(edit.newValue);
  if (m) return m[1]?.trim() ?? null;
  const m2 = /token:\s*([^)]+)\)/.exec(edit.oldValue);
  if (m2) return m2[1]?.trim() ?? null;
  return null;
}

/**
 * Parse a string like "8px" or "rgb(37, 99, 235)" or "#2563eb" into
 * the wire shape Figma expects for the variable's resolvedType.
 */
function parseValueForVariable(
  raw: string,
  type: FigmaVariable["resolvedType"],
): number | string | boolean | { r: number; g: number; b: number; a?: number } | null {
  if (type === "FLOAT") {
    const m = /(-?\d+(?:\.\d+)?)/.exec(raw);
    return m ? Number(m[1]) : null;
  }
  if (type === "BOOLEAN") {
    if (/^true$/i.test(raw)) return true;
    if (/^false$/i.test(raw)) return false;
    return null;
  }
  if (type === "STRING") return raw;
  if (type === "COLOR") {
    return parseColor(raw);
  }
  return null;
}

/**
 * Exported for unit tests. Bounds are enforced: RGB components must be
 * 0–255 and alpha 0–1 — out-of-range input returns null, which the
 * engine surfaces as a rejection instead of writing a garbage color.
 */
export function parseColor(raw: string): { r: number; g: number; b: number; a?: number } | null {
  const rgbMatch = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(raw);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    if (r > 255 || g > 255 || b > 255) return null;
    let a: number | undefined;
    if (rgbMatch[4] !== undefined) {
      a = Number(rgbMatch[4]);
      if (!Number.isFinite(a) || a < 0 || a > 1) return null;
    }
    return {
      r: r / 255,
      g: g / 255,
      b: b / 255,
      ...(a !== undefined ? { a } : {}),
    };
  }
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(raw.trim());
  if (hexMatch) {
    const hex = hexMatch[1]!;
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  return null;
}
