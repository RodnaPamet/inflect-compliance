# 2026-10-25 — A published policy can be revised, and every action names the right version

**Commit:** `<sha>` fix(policies): a published policy can be revised, and each action acts on the right version (#4127)

## Design

Two defects shared one cause: `Policy.currentVersionId` is the PUBLISHED
pointer (it moves only on publish and rollback, and is seeded when a policy is
created with content), and the detail page read it as "the version to act on".

1. **Version targeting.** Once a draft had been edited, the header's Request
   Approval asked about the old version, Publish without approval published it,
   the Current tab showed it, and the editor reopened on its text.
2. **No way to revise a live policy.** The editor saved a change to a
   PUBLISHED policy as a proposal (`proposeOnly`), but `requestPolicyApproval`
   refused every request while PUBLISHED, so nothing could be approved or
   published. Archive and restore was the only way out, and it withdrew the
   policy.

The rules now live in ONE pure module, `src/lib/policy/publication-state.ts`,
called by both the usecases and the page:

```
newest version   = highest versionNumber        → editor, header Request Approval, bypass publish
live version     = currentVersionId, if PUBLISHED → Current tab (else the newest)
revision         = a version NEWER than the live one, on a PUBLISHED policy
publishable      = APPROVED:  latest decided APPROVED approval's version
                   PUBLISHED: a revision whose approval is the LATEST approval cycle
decidable        = PENDING and (IN_REVIEW, or PUBLISHED and asking about a revision)
```

A revision goes request → approve → publish while the policy stays PUBLISHED:

| step | IN_REVIEW flow (unchanged) | revision of a PUBLISHED policy |
| --- | --- | --- |
| request | status → IN_REVIEW | status stays PUBLISHED |
| approve / reject | status → APPROVED / DRAFT | status stays PUBLISHED |
| publish | needs status APPROVED, bound to `latestApproved` | needs `publishableVersionId === versionId` |

Publishing a revision is the existing publish: the pointer moves, the outgoing
version enters `lifecycleHistoryJson` (so rollback reaches it), and
`carryForwardAckCampaign` re-requests acknowledgement.

## Files

| File | Role |
| --- | --- |
| `src/lib/policy/publication-state.ts` | The shared version-targeting rules |
| `src/app-layer/usecases/policy.ts` | Request / decide / publish accept a revision; rollback closes requests it makes stale; approval emails go to active Owners and Admins; the decision comment is sanitised and stored |
| `src/app-layer/repositories/PolicyApprovalRepository.ts` | `getById` selects the live version; `supersedePending` can be narrowed to versions |
| `src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx` | Every action reads the shared rules; error messages, comment, status label, notices; File Upload removed |

## Decisions

- **A revision must be strictly NEWER than the live version.** Asking about the
  live version has nothing to review; going back to an older one is rollback's
  job. It also gives "is this approval still the open question?" a definite
  answer without a new column.
- **An approval's standing on a PUBLISHED policy is "latest cycle", not a
  status.** There is no APPROVED status to lose, so a later request (open,
  rejected, or superseded by a publish) ends the earlier approval's standing —
  the same effect re-requesting has on an APPROVED policy. Picking "latest
  APPROVED row" instead would have made an old approval of v1 publishable again
  after v2 was bypass-published over it.
- **No schema change.** `currentVersionId` keeps its meaning and is still seeded
  at creation; the page derives "live" as pointer AND PUBLISHED, which is what
  the Versions tab's Published badge already did.
- **Rollback supersedes open requests for versions no longer newer than the one
  it restores.** Such a row can never be decided, and an open request blocks
  every new one, so leaving it would strand the workflow. A request for a
  version still newer than the restored one stands.
- **The four-eyes rule is unchanged** and applies to revisions: the requester
  and the version's author cannot approve.
- **Archive and restore still works**: it lands in DRAFT and takes the ordinary
  IN_REVIEW → APPROVED → publish route. It is no longer needed to revise.
