# 2026-11-14 — Sub-flow group membership from canvas nesting (#5477)

**Commit:** `fix(automation): write sub-flow group membership from canvas nesting`

## Design

`INVOKE_SUBFLOW` enqueues `subflow-dispatch` with the action's `targetGroupId`
(a group node's `nodeKey`). The dispatcher starts the group's entry rule: the
ENABLED rule whose `AutomationRule.subFlowGroupId` equals that key. Nothing
wrote `subFlowGroupId`, so every invocation settled "not dispatched".

Owner decisions (2026-11-14):

1. **Membership = canvas nesting.** A rule belongs to the group its owning
   canvas step sits in (`ProcessNode.parentNodeKey` → a `group` node).
2. **Entry rule = highest priority.** Kept; ties now resolve deterministically.
3. **Target picker.** The rule builder lists the tenant's groups by map and
   group label; the stored value stays the `nodeKey`.

```
saveProcessMap
  readMapGroupKeys (before replaceGraph)       ── prior group keys
  replaceGraph
  syncCanvasToRules(…, { priorGroupKeys })
    stub rules, chain wiring (unchanged)
    reconcileSubFlowMembership                  ── the only writer of subFlowGroupId
      desired(rule) = nearest enclosing group of its step, or null
      + every rule naming one of this map's groups (before or after) that is
        no longer on the canvas → null, unless a step on another live map owns it
      any write → assertCanManageAutomation
```

The dispatcher orders `priority desc, createdAt asc, id asc`.
`GET /api/t/:slug/processes/subflow-groups` (`listSubflowGroups`,
`assertCanRead`, the canvas's read) feeds the `<Combobox>` in
`RuleBuilderModal` and the label in `RuleDetailSheet`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/canvas-subflow-membership.ts` | Nearest-group walk, prior-group read, membership reconcile (only `subFlowGroupId` writer) |
| `src/app-layer/services/canvas-rule-sync.ts` | Calls the reconcile; counts and audits membership changes |
| `src/app-layer/usecases/process-map.ts` | Reads prior group keys before `replaceGraph`; `listSubflowGroups` read |
| `src/app-layer/repositories/ProcessMapRepository.ts` | `listSubflowGroups`: group nodes on live AUTOMATION maps |
| `src/app/api/t/[tenantSlug]/processes/subflow-groups/route.ts` | GET for the picker |
| `src/lib/processes/subflow-groups.ts` | Client-safe `SubflowGroupItem` shape |
| `src/lib/swr-keys.ts` | `processes.subflowGroups()` key |
| `src/app-layer/jobs/subflow-dispatcher.ts` | `id asc` tie-break; comments |
| `src/components/processes/RuleBuilderModal.tsx` | Free-text target → `<Combobox>` picker |
| `src/components/processes/RuleDetailSheet.tsx` | Shows "map › group" instead of the raw key |
| `messages/en.json`, `messages/bg.json` | Picker and label strings |
| `docs/automation-events.md` | Sub-flow membership paragraph |

## Decisions

- **Nearest enclosing group only.** A step in G2 inside G1 is a member of G2.
  Membership in every ancestor would let invoking G1 start a step buried in G2
  because it carried the highest priority.
- **A separate module, not the sync file.** The VR-3 guard holds the sync to
  never naming `parentNodeKey`. Membership is the one structural fact the
  owner decided a rule takes from the canvas, so it lives beside the sync; the
  guard now holds that module to one rule write, `subFlowGroupId`, and no
  position.
- **Prior group keys are read before `replaceGraph`.** Without them a rule
  whose step and group were both deleted in one save would keep naming a group
  no map has, and no later save of that map would see it.
- **Off-canvas clears skip rules another map's step owns.** `nodeKey` is unique
  per map, not per tenant; a group key another map shares belongs to that map's
  save. Minted keys (`node-<ms>-<rand>`) make that collision unlikely, but the
  dispatcher cannot tell two such groups apart, and neither can the picker.
- **A clear-only save is gated too.** The sync asserted
  `assertCanManageAutomation` only when the canvas had rule-owning steps or
  chain edges; a save that only clears membership now asserts it in the
  reconcile, so no lower-privilege path changes which rule a sub-flow starts.
- **Picker lists AUTOMATION maps only.** Only their saves write membership; a
  group on a DOCUMENT map would start nothing. A stored key no listed group
  carries stays selectable, labelled missing, so editing an old rule never
  drops its target silently.
- **Not changed:** snapshot restore and map deletion do not run the sync (as
  for chain links), so they do not rewrite membership.
