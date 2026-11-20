# 2026-11-20 — Agent canvas: the remaining entry points and the approver's diff

**Commit:** `feat(agents): open an agent on the canvas from its Behaviour tab and a map's agent step, and draw a version's changes for its approver (#5334)`

Phase 2.3 and 2.4 of `docs/ai-architecture/langflow.md`.

## Design

```
Behaviour tab ──link──▶ /processes/agents/:id?version=<v>               (2.3)
              ──link──▶ /processes/agents/:id?version=<v>&compare=<in force>  (2.4)

map agent step ─double-click─▶ drillTargetOf(shape) = { agent, ruleId }
               ─inspector link─▶                                      (2.3)
   workspace: GET rule ─▶ agentIdOfInvokeRule ─▶ router.push(agentCanvasHref)

/processes/agents/:id page:
   projectAgentForCanvas(version) ┐
   projectAgentForCanvas(compare) ┴▶ buildAgentViewDiff ─▶ AgentCanvasClient
                                                         ─▶ AgentCanvasView (marked shapes)
```

Every way in is a plain string built by `agent-canvas-link.ts`, so no agent
page imports the canvas and the editor guard needs no exception. The view is
still read-only and stores nothing; the diff is a second projection through the
same usecase and its gates, compared by a pure function.

## Files

| File | Role |
| --- | --- |
| `src/lib/processes/agent-view/agent-canvas-link.ts` | The canvas href with `version`/`compare`, and the agent an INVOKE_AGENT rule names |
| `src/lib/processes/agent-view/agent-canvas-diff.ts` | `diffAgentProfileLayers` and `buildAgentViewDiff`: the changes in words, and the marked graph |
| `src/components/processes/tldraw/drill-scope-host.ts` | `drillTargetOf`: a group enters its sub-flow, an agent step hands up its rule id |
| `src/components/processes/TldrawProcessCanvas.tsx`, `TldrawProcessMap.tsx` | The double-click asks `drillTargetOf`; `onOpenAgent` threaded |
| `src/components/processes/TldrawProcessWorkspace.tsx` | Reads the agent from the rule, asks about unsaved work, navigates |
| `src/components/processes/ProcessInspector.tsx`, `AutomationInspectorPanel.tsx` | The agent step's "Open the agent on canvas" link |
| `src/app/t/[tenantSlug]/(app)/processes/page.tsx`, `ProcessesClient.tsx` | `mayReadAgentInventory` decides the drill; the router lives here |
| `src/app/t/[tenantSlug]/(app)/processes/agents/[agentId]/page.tsx`, `AgentCanvasClient.tsx` | `?compare=`, the change list, unavailable comparison said |
| `src/components/processes/agent-view/AgentCanvasView.tsx`, `AgentViewNodeShapeUtil.tsx` | Draws the diff graph; a `change` prop drives the border |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourTab.tsx` | The per-version and compare links |

## Decisions

- **Not `canvas-changes-tldraw.ts` / `CanvasDiffOverlay`.** The roadmap named
  them; neither compares two agent versions. The first classifies a live
  editor's store events for autosave, the second fetches a process map's
  snapshot by map id. Phase 4.3 made the same call for flows (`diffFlows`).
  The diff is pure over the projection the view already draws.
- **Compared by what the version names, not by run state.** Tools by name,
  skills by origin and name, triggers as a set; model tier, effort, turn limit
  and output kind as settings. A tool whose offered state changed because of a
  grant is not a change the version made, and is drawn on the node already.
- **Removals are drawn.** An element the version removes and that the new graph
  would not draw (a trigger, a skill, an ungranted tool) is added from the old
  graph as a spoke, with no badges and no reason: a reviewer who cannot see what
  went away is approving half a change.
- **The drill hands up the RULE, not the agent.** The workspace reads the rule
  as the server stores it, so nothing the shape carries can point the drill
  elsewhere. A rule naming no agent is a toast, not a navigation.
- **Double-click on an agent step takes nothing away.** Process nodes are never
  label-edited on the canvas (`canEdit` is tldraw's default false; renaming is
  the inspector's), so the old comment protecting "label editing" described a
  gesture that did not exist.
- **The router stays in `ProcessesClient`.** The workspace mounts in several
  tests with no App Router; it takes a navigate callback instead, and its
  absence is the "may not read the register" answer.
- **Router navigation asks about unsaved work itself.** The click-capture guard
  sees only links; a programmatic push is invisible to it, so the workspace asks
  the same question with the same message first.
