# @metalab/design-sync-pipeline

> **Part of the design-sync system** —
> [`addon`](https://github.com/mylesmetalab/storybook-design-sync) ·
> [`pipeline`](https://github.com/mylesmetalab/design-sync-pipeline) ·
> [`figma-plugin`](https://github.com/mylesmetalab/design-sync-figma-plugin) ·
> [architecture](./ARCHITECTURE.md)

Local orchestration service that receives `Edit` events from front-door
tools (the `storybook-design-sync` addon, the `design-sync-figma-plugin`)
and routes them to write-capable engines.

This is the **pipeline** layer in the three-layer model:

```
Front doors  →  Pipeline  →  Engines
(addon,           (this        (CSS token swap, Baluarte
 plugin)          repo)         for codegen, Figma REST/MCP)
```

The pipeline is intentionally small. It owns:

- The HTTP surface that front-doors POST to
- The `Edit` / `EditResult` contract
- An engine registry + router
- The audit/confirmation layer (read-only mode by default for new installs)

It does **not** own:

- Drift detection — that's the addon
- Code generation — that's an engine (e.g. [Baluarte](https://github.com/romedinaML/baluarte))
- Figma writes — separate engines, deferred past v0
- Auth, persistence, multi-user — all later

## Install

```sh
npm i -D @metalab/design-sync-pipeline
```

Or pin a tag from GitHub:

```sh
npm i -D mylesmetalab/design-sync-pipeline#v0.0.1
```

## Configure

`design-sync-pipeline.config.json` at the consuming project's root:

```json
{
  "port": 7099,
  "cors": "*",
  "writeEnabled": true,
  "codeTargets": [
    { "path": "src/style.css", "scopeSelector": ".icon-button" },
    { "path": "src/style.css", "scopeSelector": ".file-item" }
  ]
}
```

`codeTargets` declares which files (and optionally which CSS rules) the
`code-css-postcss` engine is allowed to touch. Edits referencing
selectors outside this list are rejected with a clear message.

`writeEnabled: false` puts the pipeline in dry-run mode — every edit
returns a diff but writes nothing. Recommended for first-time setup.

## Run

```sh
npx design-sync-pipeline serve
# design-sync-pipeline listening on http://127.0.0.1:7099
```

Or via the script alias:

```sh
npm run serve
```

Bind is hard-coded to `127.0.0.1`. The pipeline never accepts connections
from the LAN.

## HTTP surface

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET`  | `/health`  | — | `{ ok: true, writeEnabled }` |
| `GET`  | `/engines` | — | List of registered engines |
| `POST` | `/edits`   | `Edit` | `EditResult` |

### Edit shape

```ts
{
  id: string;                            // uuid for tracking/idempotency
  kind: "token-binding" | "token-value" | "copy" | "props";
  scope: "code" | "figma";
  target: {
    storyId?: string;
    selector?: string;                   // CSS selector for code scope
    property: string;
    nodeId?: string;
    fileKey?: string;
    path?: string;
  };
  oldValue: string;                      // safety check
  newValue: string;
  modes?: { light?: string; dark?: string };
  source: string;                        // "storybook-design-sync", etc.
  timestamp: string;
  dryRun?: boolean;                      // forced true if writeEnabled=false
}
```

### EditResult

```ts
{
  id: string;
  status: "applied" | "rejected" | "needs_review" | "error" | "no_op";
  engine?: string;
  message?: string;
  diff?: string;                         // human-readable summary
}
```

## v0 engines

| Name | Handles | Notes |
|------|---------|-------|
| `code-css-postcss` | `token-binding` × `code`, `token-value` × `code` | PostCSS AST engine. Swaps `var(--<old>)` for `var(--<new>)` or promotes a raw CSS literal to `var(--<token>)`, scoped to a specific rule + property. Walks the cascade chain (`.tab.active` → `.tab`) for components not yet per-variant-explicit. Stale-check is strict: if the rule's current value disagrees with `oldValue`, the engine refuses with an "expected X, found Y" message rather than silently rewriting. Replaced the regex-based `code-css-token-swap` engine in pipeline v0.0.8. |

## CLI subcommands

In addition to `serve`, the CLI exposes two utility commands:

```sh
# Walk Storybook + Figma to seed .design-sync/registry.json
design-sync-pipeline seed

# Pull Figma Variables → DTCG tokens.json
design-sync-pipeline pull-tokens \
  --out src/tokens/tokens.json \
  --known-phantoms typography/ui/14
```

`pull-tokens` reads `/v1/files/:key/variables/local`, walks the named
collection, and emits a DTCG-shaped `tokens.json`. Type mapping:

| Figma type | Group | DTCG `$type` | Value shape |
|---|---|---|---|
| `COLOR` | any | `color` | hex (alpha appended if `< 1`, e.g. `#ffffffb8`) |
| `FLOAT` | `z/*` | `number` | unitless string (`"4000"`) |
| `FLOAT` | other | `dimension` | px-suffixed string (`"16px"`) |
| `STRING` | any | `string` | verbatim |
| `BOOLEAN` | any | `boolean` | `"true"` / `"false"` |

Mode handling: the collection's default mode populates `$value`; other
modes go in `$modes` only when their value differs from the default
(no-op overrides are suppressed). Variable scopes are preserved under
`$extensions.figma.scopes`. `VARIABLE_ALIAS` values resolve to their
target's literal in the same mode.

`fileKey` and `pullTokens.{collection,knownPhantoms}` can be set in
`design-sync-pipeline.config.json` to avoid passing them on every run.
Variables whose names lack a `/` separator (e.g. designer scratch
variables) are skipped with a warning.

## Adding an engine

```ts
import type { PipelineEngine } from "@metalab/design-sync-pipeline";

export const createMyEngine = (): PipelineEngine => ({
  info: {
    name: "my-engine",
    description: "...",
    handles: [{ kind: "token-binding", scope: "code" }],
    idempotent: true,
    writeCapable: true,
  },
  canHandle(edit) {
    return /* ... */;
  },
  async apply(edit) {
    // ...do the thing...
    return { id: edit.id, status: "applied", engine: "my-engine" };
  },
});
```

For v0 engines are hard-coded into `src/engines/index.ts`. A pluggable
registry (`pipeline.engines.ts` in the consuming repo, or
[Baluarte](https://github.com/romedinaML/baluarte) as a transitive dep)
comes later.

## Out of scope for v0

- Figma writes (any kind)
- LLM/MCP-routed stochastic edits
- Multi-edit transactions
- Persistence, history, audit log
- Network exposure (LAN/internet)
- Auth
- Replacing or hooking into Syncything (intentionally independent)

## License

MIT
