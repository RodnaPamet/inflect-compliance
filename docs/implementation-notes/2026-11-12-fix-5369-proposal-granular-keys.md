# 2026-11-12 — Finding and risk writes floor on their granular keys (#5369)

## Design

The finding routes take `findings.create` / `findings.edit` (#4574) and the
risk routes `risks.create` / `risks.edit`, but `createFinding`,
`updateFinding`, `createRisk` and `updateRisk` asserted only the role-tier
write. `approveAgentProposal` runs those four as the approver, so a custom
role on an EDITOR base with `findings.create: false` could not create a
finding through the API and could by approving an agent's FINDING proposal.
Same for risks.

Two layers, the controls/policies pattern plus the #5053 queue table:

1. **The usecases floor on the keys.** `assertCanCreateFinding` /
   `assertCanUpdateFinding` (new `policies/finding.policies.ts`) and
   `assertCanCreateRisk` / `assertCanUpdateRisk` (`policies/risk.policies.ts`,
   previously unused, now with the granular term) are the coarse write AND,
   when a granular layer is present, the flag explicitly granted — the shape
   of `assertCanCreateControl`. Every caller is held, not only the queue.
2. **The queue refuses before it writes.** `PROPOSAL_KIND_APPROVE_PERMISSION`
   is now keyed by kind AND operation, and lists FINDING and RISK beside
   PROCESS_MAP. `approveAgentProposal` asks `assertMayApproveRecordProposal`
   where it asks the process-map key: after the API-key refusal, before the
   signature and the claim. `assertPermission` writes the one hash-chained
   `AUTHZ_DENIED` row; the 403 carries a named `details.reason`
   (`FINDING_APPROVER_NEEDS_FINDINGS_CREATE`, `…_EDIT`,
   `RISK_APPROVER_NEEDS_RISKS_CREATE`, `…_EDIT`), worded in both languages.
   The review surfaces pass the operation to `viewerMayApproveProposal`, so
   Approve is offered only where it is taken.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/policies/finding.policies.ts` | new: the two finding floors |
| `src/app-layer/policies/risk.policies.ts` | create/update floors gain the granular term |
| `src/app-layer/usecases/finding.ts`, `risk.ts` | the four usecases assert the floors |
| `src/lib/agentic/proposal-approve-permission.ts` | table keyed by kind and operation; FINDING and RISK added |
| `src/app-layer/usecases/proposal-kind-approval.ts` | new: the queue's audited refusal for FINDING/RISK |
| `src/app-layer/usecases/agent-proposals.ts` | asks it before the signature and the claim |
| `src/app-layer/usecases/run-checkpoint-review.ts`, `agents/proposals/page.tsx` | pass the operation to `viewerMayApproveProposal` |
| `src/lib/agentic/proposal-refusal-keys.ts`, `messages/{en,bg}.json` | the four reasons, worded |
| `findings/FindingDetailSheet.tsx`, `risks/_shared/bulk-permissions.ts` | comments that described the old floor |

## Decisions

- **Both layers, not one.** The usecase floor alone would refuse an approval
  only after the claim, and a claimed proposal is deliberately never handed
  back (it would read ACCEPTED with nothing created). The queue check alone
  would leave every other caller — materialisers, vulnerability conversion,
  the status route — on the coarse tier.
- **Keyed by operation.** An UPDATE proposal edits the record and needs the
  edit key; anything else runs the create path and needs the create key —
  the same reading `approveAgentProposal` makes of `operation`.
- **CONTROL and POLICY are not added to the table** — out of this issue's
  scope. Their usecases already floor on granular keys, so an approver
  without the key is still refused, but by the usecase after the claim, which
  leaves the proposal claimed with nothing created. Adding them here is the
  same one-line change per kind; reported separately.
- **System callers keep working.** `buildSystemContext` grants ADMIN's
  `PermissionSet`, so the vendor-monitoring job holds every key. A context with
  no granular layer at all keeps the coarse rule, as for controls.
