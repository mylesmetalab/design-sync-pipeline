# design-sync — one-pager

**TL;DR** — A bidirectional sync tool that detects drift between a Storybook
story and its Figma counterpart, and lets you fix it in either direction
with one click. Three sibling repos. Replaces Syncything. Sits beside Baluarte.

---

## The problem

Component code drifts from Figma designs. A radius gets bumped in one place
and not the other. A color gets re-bound to a different token. By the time
anyone notices, the cause is buried in a week of commits and design changes.

## The pieces

```
       📖 Storybook                       🎨 Figma
       ──────────                          ──────
   design-sync addon                  design-sync plugin
       (front door)                       (front door)
            │                                  │
            ▼                                  ▼
       ┌──────────────────────────────────────────────┐
       │          design-sync-pipeline                │
       │    Edit { kind, scope, oldValue, newValue }  │
       └──────────────────────────────────────────────┘
            │                                  │
            ▼                                  ▼
       Code engines:                    Figma engines:
        ✅ CSS token swap                 ✅ Plugin API (via plugin)
        ⏳ Baluarte (codegen)             ⏳ figma-rest-write (values)
            │                                  │
            ▼                                  ▼
        Codebase                            Figma file
```

Three sibling repos, all on GitHub:

- **[storybook-design-sync](https://github.com/mylesmetalab/storybook-design-sync)** —
  the Storybook addon. Detects drift, renders a per-row diff, has Apply
  buttons in either direction.
- **[design-sync-pipeline](https://github.com/mylesmetalab/design-sync-pipeline)** —
  the orchestration layer. Receives Edits, routes to engines, queues figma-side
  writes for the plugin to drain. **Replaces Syncything.**
- **[design-sync-figma-plugin](https://github.com/mylesmetalab/design-sync-figma-plugin)** —
  Figma plugin. Picks up figma-scope Edits from the pipeline's queue and
  applies them via the Plugin API (the only Figma surface where
  `boundVariables` can be set on a node).

## What it does today

- Reads drift across **5 dimensions**: `token-value`, `token-binding`,
  `variant-set`, `copy`, `props`. (Two more — `structure`, `motion` —
  are placeholders for future engines.)
- **Mode-aware** — compares both light and dark Figma values against
  what code resolves to in each mode.
- **One-click fix in either direction**: "Update code" writes Figma's value
  into the CSS file; "Update Figma" writes code's value into the Figma file
  via the plugin.
- **Dry-run by default** on the Figma side. The plugin has an "Apply for
  real" checkbox that's unchecked until you opt in.
- **Localhost-only** — pipeline binds to 127.0.0.1, no auth, single user.

## How it relates to existing tools

| Tool | Job | Status |
|------|-----|--------|
| **Baluarte** | Codegen pipeline (creates components from designs) | Existing, separate. Future: integrate as a code-side engine for AST-aware writes. |
| **Syncything** | Previous sync solution | **Replaced** by `design-sync-pipeline`. Independent code. |
| **storybook-design-inspector** | Sibling Storybook addon (live token inspection) | Already exists. Future: emit `proposedEdit` events to the pipeline. |

## How to try it

```sh
# 1. Pipeline (terminal 1)
cd ~/your-project
npx -p mylesmetalab/design-sync-pipeline#v0.0.2 design-sync-pipeline serve

# 2. Storybook (terminal 2)
npm run storybook        # addon picks up parameters.designSync from each story

# 3. Figma (optional, for figma-side writes)
# Open Figma desktop → Plugins → Development → Import plugin from manifest
# Pick design-sync-figma-plugin/manifest.json → run → click Connect
```

Click **Check drift** in any registered story, click **Update code** or
**Update Figma** on a drift row.

## Open questions

- One pipeline or two? (Codegen + sync are different concerns; today separate.)
- Is the Figma plugin a "front door" or an "engine"? Today both. Long-term split?
- Real-time pushes vs. polled checks? Today: pull on click.
- What's the right ergonomics for multi-repo setups?

## Caveats

- **Proof of concept.** Built side-of-desk. Architecture is OK; corners are
  rough.
- The plugin must be open in Figma desktop for figma-side writes to work.
  Not a server.
- Apply buttons are single-mode only (dual-mode reading works; dual-mode
  applying is deferred).
- Variable-value writes (e.g. change `radius/lg` from 6 → 8) not implemented;
  binding re-targets only.

## Where to dig deeper

- [Architecture (Mermaid diagram)](./../ARCHITECTURE.md)
- [Roadmap](https://github.com/mylesmetalab/storybook-design-sync/blob/main/docs/roadmap.md)
- [Editable architecture diagram](./architecture.excalidraw) — drag onto excalidraw.com
