# 2026-11-11 — Every agent, read-only, on the process canvas (langflow.md Phase 2)

**Commit:** `feat(agents): view an agent read-only on the process canvas`

## Design

```
/t/:slug/agents/:id  ── "Open on canvas" (only where processCanvasEnabled) ──┐
                                                                             ▼
/t/:slug/processes/agents/:id   (inside the processes segment: its layout 404s without the module)
  page.tsx (server) ── mayReadAgentInventory ── projectAgentForCanvas(ctx, id, { versionId? })
        │                                           ├─ getRegisteredAgent      envelope + tenant boundary
        │                                           ├─ listAgentTools          grants vs effective ceiling
        │                                           ├─ policy card / breaker / kill switch (one column each)
        │                                           ├─ getAgentProfile         profile layer, its own gate
        │                                           │     └─ offerToolSet(resolveMcpInvocation({...ctx, agentId}))
        │                                           └─ INVOKE_AGENT rules → maps + registry workflows
        ▼
  AgentCanvasClient (EntityDetailLayout: Canvas | Elements)
        └─ buildAgentViewGraph (pure) → layoutAgentViewGraph (dagre, LR) → AgentCanvasView (tldraw, read-only)
```

The view stores nothing. Layout is recomputed on every open from the
projection; the editor is put in read-only mode before anything is shown and
no store listener exists, so there is no save path to reach.

A form-built agent is drawn hub and spoke: every edge touches the agent node.
The only ordered edges are a code-registered workflow's own steps, dashed when
the definition asks for a reasoning engine (the order is advisory there).

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-canvas-projection.ts` | The projection's shape, no I/O and no renderer |
| `src/app-layer/usecases/agent-canvas-projection.ts` | `projectAgentForCanvas`: every layer read through its owning usecase |
| `src/lib/processes/agent-view/agent-canvas-graph.ts` | Pure graph builder and deterministic layout |
| `src/components/processes/node-taxonomy.ts` | `AGENT_VIEW_NODE_TAXONOMY`: icon and accent per agent-view kind |
| `src/components/processes/agent-view/AgentViewNodeShapeUtil.tsx` | tldraw shape util for an agent-view node; reason in a Tooltip |
| `src/components/processes/agent-view/AgentCanvasView.tsx` | Mounts tldraw read-only, draws nodes and arrows |
| `src/components/processes/agent-view/agent-view-text.ts` | One translator for both tabs |
| `src/app/t/[tenantSlug]/(app)/processes/agents/[agentId]/` | The route: server page and client |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/{page,AgentDetailClient}.tsx` | "Open on canvas" link |
| `eslint.config.mjs` | `@xyflow/*` refused at error level over every agent-flow file |
| `messages/{en,bg}.json` | `agentCanvas` namespace |

## Decisions

- **The profile gate is caught, not copied.** `getAgentProfile` refuses with a
  404 `PROFILES_DISABLED` or a 403; the projection maps those to `OFF` and
  `NOT_PERMITTED` and re-throws anything else. A second copy of the gate would
  be the one that drifts.
- **Tool states are the probe's, against a run's invocation.** The view calls
  `offerToolSet` with the options a profile run passes (`profileTools`, and
  `readOnly` for `ANSWER_ONLY`) on `resolveMcpInvocation({ ...ctx, agentId })`.
  The cost is that building the invocation lists the tools of every external
  connection the agent holds a grant on, as a run does. Paid once per open.
- **No probe for an agent that is not ACTIVE.** Admission refuses its runs, and
  for a DRAFT agent the invocation's exposure term is absent (no governed agent),
  so the probe would answer about a run that cannot exist. Its tools read
  `AGENT_NOT_ACTIVE` instead.
- **A separate kind record, not new `ProcessNodeKind` members.** No map may store
  an agent-view kind, and joining the union would put seven unpersistable kinds
  into every record the palette, inspector and serializer key on.
- **Layout from `computeAutoLayout`, not `auto-layout-host.ts`.** The host reads
  positions out of a mounted editor; this view lays out before it draws, from
  data, which is also what makes the layout testable and deterministic.
- **Unbound arrows.** Edges are tldraw arrows placed from the layout, with no
  bindings, because nothing on a read-only view can move.
- **Two tabs over one graph.** The Elements tab lists every node with its
  reason in words, readable without a pointer, and is what the rendered test
  reads; the canvas is tested against a live editor's store.
- **A missing profile layer is named.** "Profiles are off", "needs the register
  permission" and "no version yet" are three different next steps.
- **Remaining for Phase 2:** the Behaviour tab's link (2.3), drill-down from a
  map's `agent` node (2.3), and the approver's diff (2.4). The drawn-flow layer
  waits on Phase 1.
