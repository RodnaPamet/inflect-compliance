# 2026-11-12 — The agent-flow canvas editor and its preview (langflow.md Phases 3–4)

**Commit:** `wf/flow-canvas-3-4` — feat(agents): draw an agent's flow on the canvas, saved as a draft version, with the engine's own run message beside it

## Design

```
/t/:slug/processes/agents/:id          Phase 2 view ── "Edit the flow" (profile layer shown) ──┐
                                                                                               ▼
/t/:slug/processes/agents/:id/flow     page.tsx (server, inside the processes segment)
   mayReadAgentInventory → getAgentProfile        (404 when profiles are off, 403 without admin.agent_registry)
                         → projectAgentForCanvas  (tool states: offerToolSet, as Phase 2)
                         → listFlowSubagentOptions (approved, in force, this tenant, not its own)
                         → previewProfileRunMessage (compileProfileDefinition + runMessage)
        │
        ▼
AgentFlowEditor (client)
   draft (LOGIC: FlowDraft)      held (LAYOUT: FlowLayout, session only)
     ▲    palette / inspector       ▲   AgentFlowCanvas.onMove
     │                               │
     └── diagnoseFlowDraft ── checkAgentFlow (the writer's schema) + grants / profiles / output kind
   Save ── flowVersionBody(opened, draft)  ──►  POST …/profile/versions   (existing route, existing usecase)
   Submit ─────────────────────────────────►  POST …/versions/:n/submit  (existing route)
   Compiled panel ◄── the server's preview and tool states, never computed here
   Diff mode ◄── diffFlows(inForce, opened), drawn read-only on the same canvas
```

The canvas (tldraw) owns geometry; the inspector owns logic. A box can be moved
and selected. It cannot be deleted from the canvas (a before-delete side
effect refuses every deletion the sync did not make), there is no toolbar, and
any shape the sync did not draw is removed at the next sync. So no gesture on
the canvas changes the flow.

## Files

| File | Role |
| --- | --- |
| `src/lib/processes/agent-flow/agent-flow-document.ts` | Pure: draft ⇄ flow, the round trip, layout, diagnostics, the save body, the approver's diff |
| `src/components/processes/agent-flow/AgentFlowNodeShapeUtil.tsx` | tldraw shape for a step: movable, not resizable, not editable, not bindable |
| `src/components/processes/agent-flow/AgentFlowCanvas.tsx` | Mounts tldraw, syncs shapes from props, reports moves and selection |
| `src/components/processes/agent-flow/AgentFlowEditor.tsx` | Palette, inspector, Save and Submit, Compiled panel, diff mode |
| `src/components/processes/node-taxonomy.ts` | `AGENT_FLOW_NODE_TAXONOMY`: icon and accent per flow kind |
| `src/app/t/[tenantSlug]/(app)/processes/agents/[agentId]/flow/` | The route: server page and client frame |
| `src/app/t/[tenantSlug]/(app)/processes/agents/[agentId]/AgentCanvasClient.tsx` | "Edit the flow" link on the Phase 2 view |
| `src/app-layer/usecases/agent-profiles.ts` | `listFlowSubagentOptions`; `assertMayManageProfiles` exported for the preview |
| `src/app-layer/usecases/agent-profile-runs.ts` | `previewProfileRunMessage` |
| `eslint.config.mjs` | The two new agent-flow folders join the `@xyflow/*` refusal |
| `messages/{en,bg}.json` | `agentFlow` namespace, `agentCanvas.editFlow` |

## Decisions

- **No new route.** The editor's one write is the existing version route
  (`createAgentProfileVersion`, `admin.agent_registry`, grants and in-tenant
  `profileRef` re-checked, audited with profile and version). The two reads it
  adds are usecases called by the server page, under the profile surface's own
  gate, so no route was added for them either and the API permission map is
  unchanged. This is the 2026-07-29 lesson applied in advance.
- **The save body takes no layout.** `flowVersionBody(base, draft)` has no
  layout parameter, so a position cannot reach the governed write by any
  refactor of the caller. It writes the edited version whole with its flow
  replaced, because a version is immutable and the next one is written whole;
  `toolNames` is never sent (the server derives it, and naming both is a 400).
- **Save is offered only for a change to the flow.** `draftChangesFlow`
  compares the canonical stored text, so an unedited open, a moved box or a
  reordered connection list offers no save and can create no spurious DRAFT.
  That is #2963's round-trip contract applied to this document. Two things
  keep it true after a save, where the writer sanitises and trims each label:
  `flowFromDraft` trims as the writer does, and the editor RE-SEEDS its draft
  from the version the refresh opens (keyed on the version number). Without
  the re-seed a label the writer altered left the draft different from the
  stored flow for good, so every Save click wrote another identical DRAFT.
- **Layout is not stored in this slice.** The roadmap asks for a layout record
  outside the version. That is a new tenant-scoped table, so a migration (RLS,
  index, retention classification) and a write route under the register key.
  It was left out of a time-boxed slice rather than half-built; the layout is
  computed by `computeAutoLayout` from the flow and the session's moves are
  kept until the page is left. Nothing about this slice has to change when the
  record lands: it becomes the `held` argument of `layoutForDraft`.
- **Diagnostics ask the writer's function.** `diagnoseFlowDraft` asks
  `checkAgentFlow` for the graph rules (a cycle, a duplicate connection, the
  step bound) and reports the writer's own reason codes. The rules that need
  server data (grants, approved profiles, output kind) are asked against the
  lists the server sent, under the server's codes; the server asks again.
- **The preview is of the saved version, from the server.** `run-message.ts`
  imports the sealed-context module, so it is not client code, and a second
  rendering in the browser would be the copy that drifts. So the panel shows
  `previewProfileRunMessage` (the resolver's `compileProfileDefinition` and
  the engines' `runMessage`, after the content hash is recomputed) for the
  version the editor opened, and says so once the draft differs. It never
  says a run receives the message of a version admission refuses: the preview
  asks `assertEngineRunsProfiles` for every driver, and while no engine runs a
  drawn flow (`runsFlows` is false for all, until Phase 5) every flow version
  is shown as refused `PROFILE_FLOW_NOT_RUNNABLE`, in force or not. Previewing a
  draft before save would need a read route; saving a draft is cheap and
  reversible (a new DRAFT supersedes it).
- **The diff is the flow's, not the process map's.** `canvas-changes-tldraw.ts`
  and `CanvasDiffOverlay` diff process-map rows; a flow is not one. `diffFlows`
  matches steps by key and connections as a set, and the same canvas draws the
  union read-only with each change marked, beside a list in words.
- **The canvas is writable while it draws.** tldraw drops every shape write
  while the instance is read-only, so each sync clears read-only, draws, and
  then sets it to the prop. Setting it only after the draw left the diff's
  drawing on the edit canvas when the approver went back to editing.
- **No checkpoint anywhere.** The palette is the schema's four kinds
  (D-L2-2); nothing in the editor names a checkpoint.

## Remaining

- The layout record (3.2), the history sidebar (3.1), the Behaviour tab's
  canvas link (2.3).
- A per-connection Tooltip naming why order is advisory (4.2); today the
  inspector says it once.
- Previewing an unsaved draft (4.1) would need a read route; deliberately not
  built.
