/**
 * Argument parsing for `design-sync-pipeline serve`, extracted from cli.ts
 * so it's unit-testable (cli.ts has import-time side effects — it starts
 * the server — so tests import this module instead).
 */

export interface ServeFlags {
  /** Port override from --port. Undefined when the flag wasn't passed. */
  port?: number;
  readOnly: boolean;
}

export type ServeFlagsResult =
  | { ok: true; flags: ServeFlags }
  | { ok: false; error: string };

/**
 * Parse `serve` flags. `--port` with a missing or non-numeric value is an
 * error, not a silent ignore.
 */
export function parseServeFlags(args: string[]): ServeFlagsResult {
  const flags: ServeFlags = { readOnly: args.includes("--read-only") };

  const portFlag = args.indexOf("--port");
  if (portFlag !== -1) {
    const rawValue = args[portFlag + 1];
    if (rawValue === undefined || rawValue.startsWith("--")) {
      return { ok: false, error: "--port requires a value (e.g. --port 7099)." };
    }
    const port = Number(rawValue);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return {
        ok: false,
        error: `Invalid --port value "${rawValue}" — expected an integer between 0 and 65535.`,
      };
    }
    flags.port = port;
  }

  return { ok: true, flags };
}
