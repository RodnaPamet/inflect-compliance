# 2026-11-19 — Risk and asset nodes linked to their records

**Commit:** `feat(processes): risk and asset nodes link to their records and show their live state`

## Design

The sequel to `2026-11-19-control-node-linked-record.md`. `risk` and `asset`
nodes get the same treatment control nodes did, which retires the last use of
`ProcessNode.dataJson.linkedEntityId` as a link (owner decisions, 2026-11-19:
risk and asset in one change; a risk card leads with the residual score, else
the inherent one; the card says whether the risk's mitigating controls are on
the map).

```
node props: controlId | riskId | assetId  (its own kind's field, nothing else)
        │ save                                   ▲ card
        ▼                                        │
planNodeLinks ─▶ one ownership read per kind ─▶ ProcessNode{Control,Risk,Asset}
                                                 │
CanvasLinkedFactsProvider ─▶ /processes/:id/{control,risk,asset}-facts?ids=…&v=<version>
```

One table-driven rule replaces the control-only one: `NODE_LINK_FIELD` maps each
linked kind to its field, `planNodeLinks` plans all three, and every reader,
writer, serializer and card goes through it.

## Files

| File | Role |
| --- | --- |
| migration `20261119180000_process_node_risk_asset_links`, `processes.prisma` | The two tables, RLS triple, cascades, backfill |
| `src/app-layer/schemas/process-map.ts` | `riskId` / `assetId`, `NODE_LINK_FIELD`, `linkFieldForNodeType` |
| `src/app-layer/repositories/ProcessMapRepository.ts` | `planNodeLinks`, per-kind ownership reads and link writes, load and snapshot fields, `listMapsByRiskNode` / `listMapsByAssetNode` (the JSON-path `listMapsByLinkedEntity` is gone) |
| `src/app-layer/usecases/process-map-risk-asset-facts.ts`, `…/risk-facts`, `…/asset-facts` routes | The live facts reads |
| `src/lib/processes/canvas-linked-facts.tsx`, `risk-asset-facts-types.ts` | One provider and card model for all three kinds (replaces `canvas-control-facts.tsx`) |
| `src/components/processes/tldraw/*`, `use-tldraw-selection.ts`, `canvas-diff.ts`, `TldrawProcessWorkspace.tsx` | Shape props, serializer, card rendering, picker write, version diff |

## Decisions

- **Sibling tables, not one generic link table.** A polymorphic table cannot
  carry a foreign key to Control, Risk and Asset at once, and the foreign key —
  tenant-bound by the composite key, cascading on delete — is the point.
- **A node carries only its own kind's field.** A risk node sending `controlId`
  is a 400, not a dropped value; the serializer sends only the node's own field,
  so a node whose kind changed cannot carry its old link along.
- **The band is the tenant's.** `getRiskMatrixConfig` + `resolveBandForScore`,
  computed on the server, so the node says what the register and the heat map
  say. A score no configured band covers shows no chip, never the helper's grey
  "Unbanded" fallback. The legacy fixed-percentage ladder is not used.
- **Mitigation is measured against the map as saved.** The risk's live
  `RiskControl` links (a trashed control does not count) against the controls on
  control nodes and connections in the saved graph. The provider puts the saved
  map version in each request key, so every save re-reads it.
- **A retired asset still on a map is shown in warning tone.** It is the one
  asset fact that says the process may be describing something that no longer
  runs.
- **The picker writes nothing into `dataJson` any more.** All three kinds the
  picker mounts on carry their own prop; a patch for any other kind is dropped.
  The p2b guard that pinned the old merge now pins the new write.
