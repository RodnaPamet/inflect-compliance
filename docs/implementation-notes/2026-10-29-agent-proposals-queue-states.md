# 2026-10-29 — The agent proposals queue says where each decision stands (#4473)

**Commit:** `fix(agentic): the proposals queue shows each proposal's window, signatures and key`
(with the three commits before it on the same branch)

## Design

Four changes to `/agents/proposals` and the routes filed beside it.

**Route gates (security).** `compose/` and `sample-audits/` were the two
directories under `/api/t/:slug/agent-proposals` that #4493 left untriaged. Each
now takes its own page's gate as a literal `requirePermission`:

| route | page | gate | then |
| --- | --- | --- | --- |
| `GET`, `POST /agent-proposals/compose` | `/agents/compose` | `admin.view` | POST: the usecase's `assertCanWrite` |
| `GET /agent-proposals/sample-audits`, `POST …/sample-audits/:id` | `/agents/review-quality` | `admin.agent_registry` | POST: `assertCanWrite` and the not-the-approver refusal |

With every route under it gated, `agent-proposals` is one whole privileged root
in `api-permission-coverage.test.ts` instead of three leaf roots.

**Refusals in words.** `refuseFourEyes` throws the sentence `fourEyesRefusal`
already composed; `refuseExpired` throws `EXPIRED_REFUSAL_MESSAGE`. Each carries
its code in `details.reason`, as the dissent refusal does. The audit rows do not
change.

**The queue's facts.** The page reads `PROPOSAL_QUEUE_PAGE_SIZE + 1` and says it
is truncated only when that many came back. `annotateProposalQueue`
(`usecases/agent-proposal-queue.ts`) reads, in one query each, the signatures
recorded per proposal (with whether the viewer is a signer) and the `keyPrefix` of
the key each came through. The page judges each row's window against its own
clock (`isProposalExpired`) and forwards the deadline.

**Labels.** `src/lib/agentic/proposal-labels.ts` holds closed lists of the five
kinds and of every key a stored payload can carry. The kind badge and
`ProposalDiffPanel` render labels from them.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/agent-proposals/compose/route.ts` | `admin.view` on both handlers |
| `src/app/api/t/[tenantSlug]/agent-proposals/sample-audits/**/route.ts` | `admin.agent_registry` |
| `src/lib/security/route-permissions.ts` | the two rules |
| `src/app-layer/usecases/agent-proposals.ts` | the two refusal sentences |
| `src/app-layer/usecases/agent-proposal-queue.ts` | page size, signatures, key prefixes |
| `src/lib/agentic/proposal-labels.ts` | the closed kind and field lists |
| `src/app/t/[tenantSlug]/(app)/agents/proposals/page.tsx` | one-past-the-cap read, window, annotations |
| `src/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient.tsx` | the states and labels |
| `src/components/agentic/ProposalDiffPanel.tsx` | field labels (queue and canvas) |

## Decisions

- **A closed window hides Approve and Reject.** Hiding, not greying: no role can
  decide the row, so there is no permission to explain. The row's checkbox is
  disabled instead, as the page already does for checkboxes, because a bulk
  reject would only report it back as skipped. The row stays listed, with a
  notice, until the nightly sweep stamps it EXPIRED. Removing it at render would
  make the queue disagree with the views-menu badge, which counts PENDING rows.
- **The window is judged on the server.** Judging it in the browser would make the
  server render and the hydrated page disagree for a row that crosses its
  deadline in between. A row that expires while the page is open is refused by
  the server, and the reviewer now reads why.
- **The signer is not offered a second Approve.** `signedByViewer` replaces the
  button with a sentence. The client-only `awaitingSecondApproval` flag is gone:
  the approve response now updates the same two fields the page reads.
- **The key is named by its prefix, never by its name.** That is what the API Keys
  page and the agents register show. A key's name is text an operator wrote, and
  this surface did not show it before.
- **Field labels come from a closed list, not from `t.has`.** A stored payload is
  the parsed output of its kind's schema, so the population is known, and a unit
  test holds the list equal to the schemas' keys. A name off the list is shown as
  stored.
- **The bulk-reject report names causes, not a fixed pair.** The response already
  carried each skipped row's reason. The client maps the reasons to sentences
  through a `Record<BulkRejectSkipReason, …>`, so a new reason fails to compile
  until it has one. A reason the client does not know names no cause.
