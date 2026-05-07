# Architecture

The design-sync system is **three sibling repos** plus the consuming
codebases (e.g. Downmark) and the Figma file. Each repo does one thing.
This file is the central index — start here.

## The three layers

```mermaid
flowchart LR
  subgraph storybook ["📖 Storybook (front door)"]
    addon["design-sync<br/>addon"]
    inspector["design-inspector<br/>addon (sibling)"]
  end

  subgraph figma ["🎨 Figma (front door)"]
    plugin["design-sync<br/>plugin"]
  end

  pipeline["⚙️ design-sync-pipeline<br/>local Node service"]

  subgraph codeengines ["Code engines"]
    cssEng["CSS token swap"]
    bal["Baluarte<br/>(codegen)"]
  end

  subgraph figmaengines ["Figma engines"]
    pluginEng["Plugin API<br/>(via plugin)"]
    restEng["figma-rest-write<br/>(variable values)"]
  end

  codebase[("Codebase")]
  fileDesign[("Figma file")]

  addon <-->|"Edits, drift checks"| pipeline
  inspector -.->|"future:<br/>proposedEdit"| pipeline
  plugin <-->|"poll queue,<br/>report results"| pipeline

  pipeline --> cssEng --> codebase
  pipeline -.-> bal -.-> codebase
  pipeline -.-> restEng -.-> fileDesign
  pipeline --> pluginEng
  pluginEng --> fileDesign

  classDef built fill:#d1f4e0,stroke:#16a34a,color:#000;
  classDef future fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#000;

  class addon,plugin,pipeline,cssEng,pluginEng built
  class bal,restEng,inspector future
```

**Solid green = built.** Dashed grey = the seam exists, the implementation is
deferred.

## Layer 1 — Front doors

Where humans see and trigger things.

| Repo | Surface | What it does |
|------|---------|--------------|
| [`storybook-design-sync`](https://github.com/mylesmetalab/storybook-design-sync) | Storybook addon | Detects drift between a story and its Figma counterpart. Renders a per-row diff. Apply buttons in either direction. |
| [`design-sync-figma-plugin`](https://github.com/mylesmetalab/design-sync-figma-plugin) | Figma plugin | Connects to the pipeline, picks up Figma-scope Edits from its queue, applies them via Plugin API. Also acts as the engine for Figma binding writes. |

A second Storybook addon — `storybook-design-inspector` — emits
`design-sync:proposedEdit` events when users edit tokens live. The pipeline
will consume those once routing is wired up. Listed as future-built above.

## Layer 2 — Pipeline

This repo. **Replaces Syncything.**

- Defines the `Edit` and `EditResult` contract
- Receives Edits via `POST /edits`
- Routes code-scope Edits synchronously through engines
- Routes figma-scope Edits via a queue (the plugin polls it)
- Gates writes (read-only by default; `writeEnabled: true` to enable)
- Localhost-only HTTP, no auth

The pipeline doesn't care what produced the Edit or what consumes it. Front
doors and engines plug in around it.

## Layer 3 — Engines

Engines do the actual writes. Each engine declares which `(kind, scope)`
combinations it handles; the router picks the first match.

| Engine | Built? | Scope × Kind | Notes |
|--------|--------|--------------|-------|
| `code-css-token-swap` | ✅ | `code × token-binding` | Regex-based `var(--old)` → `var(--new)` in configured CSS files. Deterministic, idempotent. |
| Plugin API (via plugin) | ✅ | `figma × token-binding` | The Figma plugin acts as both a front door and an engine. Re-binds variants' boundVariables. |
| `figma-rest-write` | future | `figma × token-value` | Writes variable *values* (e.g. change `radius/lg` from 6 → 8). Doesn't touch bindings. |
| Baluarte | future | `code × *` | AST-aware code edits. Sits next to the CSS engine, picks up edits the regex swap can't handle. |

## How Baluarte fits

[Baluarte](https://github.com/romedinaML/baluarte) is the **codegen pipeline** —
its job is making components from designs (or templates).

This repo is the **sync pipeline** — its job is keeping existing components
and designs in sync after the fact.

They're complementary. Both can run in the same project. Eventually the sync
pipeline will be able to call into Baluarte as a code-side engine for any
edit that needs more than a regex replace. Until then, they coexist as
parallel tools that each own their layer.

## How a drift fix flows

```
1. User clicks "Check drift" in Storybook
   → addon → fetches story DOM + Figma node, computes diff
   → renders table

2. User clicks "Update Figma" on a drift row
   → addon constructs Edit { scope: "figma", oldValue: figma, newValue: code, target.nodeId }
   → POST /edits to pipeline (long-poll, 30s)
   → pipeline enqueues; code-side caller waits

3. Figma plugin polls /edits/pending every 1.5s
   → drains queue, sees the Edit
   → resolves the variable by name, finds the node, calls setBoundVariable
   → POST /edits/:id/result with the EditResult

4. Pipeline matches result to the long-polled request
   → returns to addon

5. Addon's row turns green ✓
```

The reverse direction (`Update code`) skips the queue entirely — it's
synchronous: pipeline → CSS engine → file write → result back.

## Out of scope

- Figma webhooks / push notifications (today: pull on click)
- Auth, multi-user, network exposure
- Multi-edit transactions
- Persistence / audit log
- Hooking into Syncything (intentionally independent)

## Roadmap

See [`storybook-design-sync/docs/roadmap.md`](https://github.com/mylesmetalab/storybook-design-sync/blob/main/docs/roadmap.md)
for the prioritized list of post-PoC work, including:

- Apply for dual-mode rows (currently single-mode only)
- `figma-rest-write` engine for variable-value drift
- Hash-based skip path for unchanged checks
- CI runner that fails PRs on drift
