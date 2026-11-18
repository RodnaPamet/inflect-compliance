# Processes canvas

The canvas under **Manage → Processes** maps business and IT processes, places
governance controls on the connections between steps, and — on an automation
map — is the visual editor for the automation rules those steps configure. It
is drawn with [tldraw](https://tldraw.dev) 3.15.6 (`^3.15.6`, whose licence
needs no key provided the watermark stays). The earlier `@xyflow/react`
renderer was deleted in #3079. The design rationale for the node vocabulary is
in [the semantics doc](./processes-canvas-semantics.md).

## A module a tenant has or does not

The canvas is a tenant **module**, off by default
(`src/app-layer/usecases/process-canvas-module.ts`). The `processes` route
segment's layout answers `notFound()` where the tenant does not have it, and
the editor ships only in that segment's chunk. The switch governs the surface,
never the rows: `ProcessNode`, `ProcessEdge` and `ProcessEdgeControl` stay, and
coverage, traceability and the audit-pack renderer read them with the module
off.

## Architecture (top → bottom)

| Layer | File | Owns |
|---|---|---|
| Route | `src/app/t/[tenantSlug]/(app)/processes/page.tsx` | Server entry: lists the tenant's maps and resolves what the viewer may do (edit maps, delete maps, manage rules, review and operate checkpoints) |
| Page client | `.../processes/ProcessesClient.tsx` | `<WorkspaceShell>`, the tab bar (Canvas, Rules, Analytics, Monitor) and the `ssr:false` boundary for the editor |
| Workspace | `src/components/processes/TldrawProcessWorkspace.tsx` | Map selection, the document bar, autosave, history, the inspector and the palette around the canvas |
| Canvas | `src/components/processes/TldrawProcessCanvas.tsx` | The tldraw editor, seeded from the stored rows and reporting its own dirty state |
| Shapes and bindings | `src/components/processes/tldraw/` | `ProcessNodeShapeUtil`, `ProcessEdgeShapeUtil` and `ProcessEdgeBindingUtil`; `serializer.ts` converts rows to shapes and back |
| Taxonomy | `src/components/processes/node-taxonomy.ts` | Every node kind: icon, accent, shape, category, palette order |
| Palette | `src/components/processes/ProcessPalette.tsx` | Draggable node kinds; the automation section appears only on an automation map |
| Inspector | `src/components/processes/ProcessInspector.tsx`, `AutomationInspectorPanel.tsx` | The selected step's properties; on an automation map, the rule it configures |
| Mode | `src/lib/processes/canvas-mode-context.tsx` | `ProcessMap.canvasMode` (`DOCUMENT` / `AUTOMATION`), read by every child that gates an automation-only affordance |
| Usecases | `src/app-layer/usecases/process-map.ts` | List, read, create, save, mode and status changes, snapshots, restore, delete |
| Schema | `prisma/schema/processes.prisma` | `ProcessMap`, `ProcessMapSnapshot`, `ProcessNode`, `ProcessEdge`, `ProcessEdgeControl` |

The seed is applied with `createShapes` / `createBindings` on mount, not from a
store snapshot, so every record passes the same validators the live canvas
uses; and the change listener is registered after the seed, so loading a map
never marks it dirty. Undo and redo are the editor's own history. Notes, text,
drawings, frames and unconnected arrows are not process rows: they are saved as
tldraw records in `ProcessMap.freeformJson` and restored on load.

## Saving

`saveProcessMap` replaces the map's graph in one transaction and writes a
`ProcessMapSnapshot` (`graphJson` in the shape the canvas sends). A save
carries `expectedVersion`; a stale one is a 409 (`STALE_DATA`), which the
canvas reports with an offer to reload the map rather than overwrite another
person's edit. The snapshot
routes (`/processes/:id/snapshots`, `…/snapshots/:version`, `…/restore`) back
the history sidebar and its diff overlay.

Writes follow the gates their routes take: map writes need `processes.edit`
plus the write tier, deleting a map and every rule write need the Admin tier
(`admin.manage` at the route). The page computes the matching affordances on
the server, so the canvas offers only what the server will accept.

## Document and automation maps

A map is either a **document** (the default) or an **automation** map; the
document bar switches it with a metadata-only `PATCH` of `canvasMode`.

- **Document maps** use the seven document kinds — `processStep`, `decision`,
  `risk`, `asset`, `external`, `group`, `annotation` — and controls sit on the
  edges between steps.
- **Automation maps** add five kinds — `trigger`, `condition`, `action`,
  `agent` and `slaGate`. Each `action` or `agent` step owns one
  `AutomationRule`, linked by `dataJson.ruleId`, and the steps wired into it
  configure that rule (`src/lib/processes/canvas-rule-wiring.ts`): a trigger
  sets its event, a condition its filter, an SLA gate its time window. On
  save, `syncCanvasToRules` (`src/app-layer/services/canvas-rule-sync.ts`)
  creates or updates the rules and hands their ids back to the open canvas,
  and a save that omits a step's rule id keeps the stored link. A new step's
  rule starts with an unset trigger the dispatcher never selects, and enabling
  a rule that lacks a trigger or a complete action is refused. A `group` on an
  automation map is a sub-flow: nesting writes the group's membership, so an
  `INVOKE_SUBFLOW` action starts the group's entry rule.

The **Rules** tab lists the tenant's automation rules and opens a rule's step
on the canvas (`?step=`). **Analytics** shows rule counts, execution volume,
success and error rates and SLA breaches. **Monitor** is the operator console:
a live activity feed, a watchdog for executions hung past their timeout, the
manual trigger panel, and runs parked on a human checkpoint. A map exports as
PNG, SVG or PDF from the canvas; an automation map also exports as a
compliance evidence pack of its rules and 30-day execution figures
(`/processes/:id/export-automation`).

## Proposed maps

The assistant, or an agent holding the `propose_process_map` tool, can propose
a process map instead of drawing one (#5056, #5320). The proposal is an
`AgentProposal` of kind `PROCESS_MAP`, reviewed in the proposal queue with a
read-only preview (`ProposedProcessMapCanvas`). Approving it needs
`processes.edit` as well as the queue's own approval rules
(`src/app-layer/usecases/process-map-proposal.ts`), refuses edits, and creates
the map as a DRAFT document map owned by the approver, in one transaction, with
the proposal named on its creation audit row. Audit rows carry counts and ids,
never step labels. An API key used for the tool carries `processes:read`, never
`processes:write`.

## Related surfaces in the segment

- `/processes/governance` — every automation map as a card, ringed by
  execution health, with the sub-flow calls between them.
- `/processes/agents/:agentId` — one registered agent drawn read-only on the
  canvas, gated like the agent page's inventory read; `…/flow` is the agent's
  flow view.

## Concurrent editing

Two people editing one map are kept apart by the version check, not merged.
`use-canvas-presence.ts` is a no-op seam; the plan for presence and live sync
is [processes-realtime-collab.md](./processes-realtime-collab.md).
