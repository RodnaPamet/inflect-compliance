# 2026-11-11 — propose_process_map: an agent proposes a process map (#5053 deploy 2)

**Commit:** _(this PR)_ `feat(agentic): propose_process_map — an approved proposal creates a draft map (#5053 deploy 2)`

## Design

Deploy 1 taught every reader the `PROCESS_MAP` proposal kind and refused every
writer. This deploy adds the writer and the approval, and flips the brake.

```
agent / assistant ── propose_process_map (scope processes:read)
        │  createAgentProposal: refused while the brake is off, CREATE only;
        │  parse → sanitise → re-parse → store the CANONICAL form (keys n1..nN)
        ▼
AgentProposal(kind PROCESS_MAP, PENDING)
        │
        ├─ review: buildProposalDiffs → readProposedProcessMap
        │          → server layout (proposed-map-layout.ts, dagre LR)
        │          → buildProcessMapPreview  ⇒  diff.processMap
        │    ProposalDiffPanel ⇒ ProcessMapProposalPreview
        │      numbered steps, arrows, notes, "what approval creates"   ← the record
        │      read-only mini canvas, next/dynamic + ssr:false          ← a picture
        │    Approve offered only where viewerMayApprove is true
        │
        └─ approve: PENDING → brake → prepareProcessMapApproval (no edits,
                    payload still reads) → guard re-scan → apiKeyId refusal
                    → assertMayApproveProcessMap (processes.edit, AUTHZ_DENIED)
                    → signature + claim → applyApprovedProcessMap
                    → createProcessMapWithGraph: ONE transaction, DRAFT, DOCUMENT
```

**One reader for review and approval.** `readProposedProcessMap` is the only
function that turns a stored payload into a map, and the layout module is the
only thing that places it. The review diff and the approval both call them, so
a map the review surfaces cannot render cannot be approved over the API, and
the boxes a reviewer sees are the boxes the map is created at.

**The review rendering.** The list is the record: every step numbered in
stored order with its type, label and subtitle; every arrow named by the
numbers and labels of its ends; the notes; and a fixed sentence saying approval
creates a draft map in Process map mode on the Processes page. All plain React
text. Under it, the map drawn on the real process canvas
(`ProposedProcessMapCanvas`, which mounts `TldrawProcessCanvas` with
`readOnly` and the new `embedded` prop) at the server's boxes, through the
`buildTemplateGraph` builder approval uses.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/process-map-proposal.ts` | Client-safe schema, caps, canonical form, reader, preview types and builder |
| `src/lib/processes/proposed-map-layout.ts` | Server-only dagre layout, constants copied from the canvas and pinned by a text-reading unit test |
| `src/lib/processes/proposed-map-read.ts` | `previewStoredProcessMap`, `prepareProcessMapApproval` (shared by review and approval) |
| `src/lib/processes/template-graph.ts` | `buildTemplateGraph`, moved out of `components/processes` so the server can use it |
| `src/lib/agentic/proposal-approve-permission.ts` | The extra key a kind's approver needs; `viewerMayApproveProposal` |
| `src/app-layer/usecases/process-map-proposal.ts` | `assertMayApproveProcessMap`, `applyApprovedProcessMap` |
| `src/app-layer/usecases/process-map.ts` | `createProcessMapWithGraph` from extracted `…InTx` halves |
| `src/lib/mcp/tools/propose-tools.ts` | The `propose_process_map` tool; `loadableProposeTools` drops it while the brake is off |
| `src/components/agentic/ProcessMapProposalPreview.tsx` | The list, the notes, the fixed sentence, and the dynamically loaded picture |
| `src/components/processes/ProposedProcessMapCanvas.tsx` | The picture: the process canvas, read-only and embedded, at the server's boxes |
| `src/components/processes/TldrawProcessCanvas.tsx` | `embedded`: no tldraw UI, locked camera, no auto-focus, no drop target |
| `AgentProposalsClient.tsx`, `CheckpointReviewPanel.tsx` | Approve gated on the server's `viewerMayApprove` |
| `src/lib/agentic/proposal-kind-rollout.ts` | The brake, flipped to true |

## Decisions

- **The scope is `processes:read`** (owner decision), because proposing writes
  nothing; the write is the approver's.
- **The approver needs `processes.edit`** (owner decision), asserted with
  `assertPermission` after the API-key refusal and before the signature and
  the claim, so a refusal writes one hash-chained `AUTHZ_DENIED` row and the
  row stays PENDING. The 403 carries
  `PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT` so both review surfaces word it.
- **Approve is offered only where the server would take it.** The page and the
  checkpoint read compute `viewerMayApprove` with `viewerMayApproveProposal`,
  the table the usecase asserts. A viewer with the role-tier write but not the
  kind's key sees a sentence where Approve would be; Reject stays.
- **Approve-with-edits is refused for this kind**
  (`PROCESS_MAP_PROPOSAL_NOT_EDITABLE`). The shallow `{...base, ...edits}` merge
  could replace the steps without the arrows, so the rendered graph would no
  longer be the applied graph.
- **The agent chooses no identifier and no position.** Keys are re-minted
  `n1..nN`, arrows are `e<i+1>` by position, and positions, parents,
  `dataJson`, edge controls, edge kinds, mode, status and the freeform layer
  are refused by the strict schema. At most 40 steps and 80 arrows.
- **Layout is a separate server-only module**, not the canvas's
  `canvas-auto-layout.ts`, whose `"use client"` stays (owner decision). The
  copied constants are pinned by reading both files as text.
- **The picture is loaded with `next/dynamic`, `ssr: false`**, from inside the
  canvas module directory (`canvas-editor-stays-inside-its-module`), so tldraw
  adds nothing to the First Load JS of `/agents/proposals`. The loader's
  rejection is caught into a component that throws, and an error boundary
  around the picture turns either failure into one sentence; the list is
  outside the boundary.
- **The picture is non-interactive in three ways**: the store is read-only,
  the embedded canvas has a locked camera and never auto-focuses (an editor
  that focuses takes the page's keyboard, which on the canvas page would be a
  second editor answering the map's shortcuts), and the frame is `inert` with
  no pointer events. To assistive technology it is one image whose label says
  the list is the full proposal.
- **The canvas module switch does not gate the picture.** It is fetched only
  when a process-map proposal is on screen. Whether the tool itself should be
  withheld from a workspace with the process canvas module off is a separate
  question; this deploy does not decide it.
- **The brake also withdraws the tool**, so reverting
  `PROCESS_MAP_PROPOSALS_IMPLEMENTED` to false stops new rows as well as
  approvals, and the deploy-1 readers keep reading the rows that exist. The
  flip is its own commit so it reverts alone.
- **The suites follow the brake rather than pin it**, so the revert really is
  one line. `propose-commits-nothing` walks the released tools and expects a
  withdrawn one to be refused; the deploy-2 integration suite is skipped while
  the brake is off; the rollout test derives PROCESS_MAP's stage from the
  brake. The refused side is held whatever the flag reads by
  `agent-proposal-process-map-brake.test.ts`, which forces the brake off for
  the modules it loads (`withheldProposalDiff` takes the brake as a defaulted
  parameter so the real body runs).
- **The assistant's proposing rule is built from the tools the turn offers**,
  not written as a fixed sentence: a READER is offered no propose tool, a
  custom role without `processes.edit` no `propose_process_map`, and the brake
  withdraws it. A fixed sentence would tell the model to call a tool it does
  not have.
- **Unsafe text is a superset of the shared invisible-character check**, built
  from `\u` escapes and composed with `hasInvisible`, and it is asked again
  after sanitising, so an entity such as `&shy;` cannot smuggle one in.
- **A canvas that fails replaces its frame with a plain sentence.** The image
  role and `inert` belong to a canvas that rendered; a failure drawn inside
  them would be unreachable to a screen reader.
