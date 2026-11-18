# Processes canvas — semantic graph language

The Processes canvas (Manage → Processes) is not a generic diagram editor. It is a
domain-specific surface for **business + IT process documentation with governance
context**. This document records the design commitments that make it so —
how the visual vocabulary maps to the IC domain, and the rules a future
contributor should not break without a good reason.

## Three levels of visual distinction

Every node on the canvas reads at three levels:

1. **Category** (Roadmap-26 PR-D) — `flow` / `context` / `note`. Controls the <!-- docs-accuracy-allow: phase name, not future tense -->
   surface tone:
   - `flow` nodes carry a solid surface tint. They ARE the process.
   - `context` nodes carry a muted, more transparent surface. They
     ANNOTATE the process.
   - `note` is a flat sticker. It is not part of the graph at all.

2. **Shape** — `rect` / `note`. A note is universally a sticker; everything
   else is a rectangle. The decision diamond was retired in R31: a branch
   point reads by its `GitBranch` icon and corner sticker, not by divergent
   geometry.

3. **Accent + icon** — per-kind colour-coding and icon. The accent
   distinguishes one rectangular context node from another (risk = warning
   amber, asset = success green, external = subtle/dashed).

## The document kinds

| Kind | Category | Shape | Accent | Icon | In palette? |
|---|---|---|---|---|---|
| `processStep` | flow | rect | brand | Box | ✅ |
| `decision` | flow | rect | neutral | GitBranch | ✅ |
| `control` | context | rect | brand-secondary | ShieldCheck | ❌ (edge-only) |
| `risk` | context | rect | warning | AlertTriangle | ✅ |
| `asset` | context | rect | success | FileText | ✅ |
| `external` | context | rect | subtle (dashed) | Globe | ✅ |
| `annotation` | note | note | subtle | StickyNote | ✅ |
| `group` | group | rect | subtle | Group | ✅ |

A `group` is a labelled, translucent container that bundles steps under one
heading. It carries no connections itself: edges run into and out of the steps
inside it. On an automation map a group is a sub-flow.

An **automation** map adds five flow kinds, offered in their own palette
section only in that mode: `trigger`, `condition`, `action`, `agent` and
`slaGate`. The `action` and `agent` steps each own an automation rule, and the
steps wired into them configure it; see
[the canvas architecture](./processes-canvas.md#document-and-automation-maps).

## Why control is **edge-first**

Controls in IC are governance objects that GATE a transition between two
process steps. The Roadmap-25 brief committed to representing them ON the <!-- docs-accuracy-allow: phase name, not future tense -->
connection rather than as standalone nodes floating beside the flow.
R26-PR-D enforces that commitment:

- Controls are not offered in the palette. A control is attached to a
  connection through the inspector's Control picker when the edge is
  selected; an edge can carry several, each persisted as a
  `ProcessEdgeControl` row and listed as a pill in the inspector.
- The `control` taxonomy entry stays in `NODE_TAXONOMY` so legacy map data
  (R25 + R26-PR-A/B/C era) carrying `nodeType: 'control'` still rehydrates
  correctly. The kind renders identically to other context nodes when it
  appears; we just don't surface it as a primary affordance for NEW maps.

A future PR is free to re-introduce a "node-style control" pattern if a
strong use case emerges. The bar for re-adding it to the palette is high —
edge-mounted is the architecturally chosen canonical surface.

## Why risks and assets stay as nodes

Risks and assets describe **what** a step touches; they are first-class
entities in IC (their own list pages, detail pages, lifecycle). On the
canvas they remain nodes because:

- A risk often has its own attention story (severity, owner, treatment plan)
  worth surfacing on the canvas.
- An asset often appears as the data store / system / document the step
  acts upon — calling it out visibly tells the reader "this step writes
  to this asset" without needing to read the step's prose.

To keep the canvas from competing with the flow, both kinds are rendered
with the **context surface tone** (lower opacity, dashed-or-light border)
so the eye reads them as ANNOTATIONS on the flow, not as PARTS of the flow.

## Why external is dashed

The dashed border on external-party nodes is a long-standing universal
visual convention for "outside the org". One quick look and the reader knows
"this step is performed by them, not us" without needing to read the label.

## What this document is NOT

This is not a developer setup guide. For the architecture, persistence and
automation mode see [the canvas architecture](./processes-canvas.md); for the
palette and taxonomy implementation see
`src/components/processes/node-taxonomy.ts`.

This document is purely the design rationale future contributors need to
NOT accidentally undo when "tidying up" the canvas.
