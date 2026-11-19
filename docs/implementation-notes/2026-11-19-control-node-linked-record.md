# 2026-11-19 — A control node linked to its Control record

**Commit:** `feat(processes): a control node links to its Control record and shows its live status`

## Design

The owner's decisions of 2026-11-19: the `control` node returns to the canvas
palette alongside controls on connections, one control per node, and a map may
be saved with an unlinked control node (drawn dashed, as a draft).

```
canvas shape props.controlId ──save──▶ replaceGraph ──▶ ProcessNodeControl (FK row)
        ▲                                   │ one tenant-ownership read for
        │ inspector picker                  │ node + edge controls
        │                                   ▼
CanvasControlFactsProvider ──GET /processes/:id/control-facts?ids=…──▶ live Control
        │ (ids read from the tldraw store; translated text)
        ▼
ProcessNodeBody: code · name / status · effectiveness · last test
```

Before this, a control node's link was `dataJson.linkedEntityId`: a string in an
opaque JSON blob with no foreign key, no tenant check at save, read by
traceability with a JSON-path query, and left behind when the control was
deleted. Edge controls already had a real table (`ProcessEdgeControl`), but it
copies the control's `label`, so a renamed control kept its old name on a map.

Now the link is a row in `ProcessNodeControl`, and nothing about the control is
stored on the canvas. The card reads the control's current facts every time the
canvas opens, its ids change, or the window regains focus.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/processes.prisma`, migration `20261119120000_process_node_control_link` | The table, RLS triple, cascades, and the backfill from `linkedEntityId` |
| `src/app-layer/schemas/process-map.ts` | `controlId` on a node (string / null / absent), `CONTROL_NODE_TYPE` |
| `src/app-layer/repositories/ProcessMapRepository.ts` | `planNodeControlLinks`, link rows in `replaceGraph`, `controlId` on load and in snapshots, `listMapsByControlNode` |
| `src/app-layer/usecases/process-map-control-facts.ts`, `api/.../processes/[id]/control-facts/route.ts` | The live facts read |
| `src/app-layer/usecases/{process-map,traceability}.ts` | Reverse lookup and coverage read the table |
| `src/lib/processes/canvas-control-facts.tsx`, `control-facts-types.ts` | The card provider and its client-safe wire types |
| `src/components/processes/tldraw/*`, `ProcessInspector.tsx`, `TldrawProcessWorkspace.tsx`, `node-taxonomy.ts` | The shape prop, serializer, card, palette entry, "Open control" |
| `src/lib/processes/{use-tldraw-selection,canvas-diff}.ts` | The picker writes `controlId`; the version diff reads either form of the link |

## Decisions

- **The link references the node row (`nodeId`), rebuilt every save.** The same
  shape as `ProcessEdgeControl`: `replaceGraph` deletes the map's link rows and
  writes one per linked node in the transaction that upserts the nodes, so a
  redrawn node (new row) gets its link back from the payload. BIA moved off a
  row-id reference because nothing re-wrote it; this one is re-written by
  construction.
- **`controlId` has three states.** A string links and is checked strictly (a
  control that is not this tenant's refuses the whole save, like edge controls).
  `null` is unlinked. Absent means the sender predates the field: an old
  snapshot being restored, or a browser tab from before the deploy. Its legacy
  `linkedEntityId` is lifted, best effort, and kept only if it names one of this
  tenant's controls, which is the rule the backfill applies. The serializer
  always sends the field for a control node, so a current client never
  triggers the lift.
- **`linkedEntityId` is stripped from a control node on save, and kept by the
  migration.** One home for the link. The migration copies rather than moves,
  so a rollback to the previous image keeps every unsaved map's links readable.
- **The facts read takes ids from the client, scoped to a readable map.** A link
  picked a moment ago fills in before autosave. An id that is not this tenant's
  control answers exactly like a deleted one (`missing`), so the read says
  nothing about other tenants. The capped controls list the picker uses cannot
  serve this: a linked control past the cap would read as removed.
- **A viewer without controls access gets `restricted`, not a 403.** A 403 would
  write an `AUTHZ_DENIED` row every time such a viewer opened a map.
- **A failed read is `unavailable`, never `removed`.** Only the server saying
  "not found" makes a card say a control is gone.
- **The card is plain text; the link is changed only in the inspector.** The
  rule the agent-flow shape states holds here: a gesture on the canvas has no
  path to the governed write.
- **Risk and asset nodes are untouched.** They keep `dataJson.linkedEntityId`;
  `listMapsByLinkedEntity` now takes only `'risk' | 'asset'`, so a control
  lookup cannot fall back to the JSON path.
