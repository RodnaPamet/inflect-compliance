# 2026-10-25 — Access reviews: nobody decides their own access, reassignment, evidence regeneration

**Commit:** `<sha>` fix(access-reviews): nobody decides their own access, and a campaign can be reassigned and its evidence produced again

## Design

Issue #4130 collected fourteen defects on the member access-review surface. Most
were page fixes; four changed what the server does.

**Nobody decides their own access.** A member campaign snapshots every in-scope
membership, the reviewer's and the admins' included, and `submitDecision` only
asked "assigned reviewer or `canAdmin`". So a reviewer could certify their own
access, and any ADMIN or OWNER could too, as the backup. That is the
segregation-of-duties failure an access review exists to catch. Now:

```
submitDecision / revokeDecision
  reviewer gate (unchanged) ──► subject === caller? ──► 403 CAMPAIGN_SUBJECT_MAY_NOT_DECIDE_OWN_ACCESS
                                                        + ACCESS_REVIEW_DECISION_REFUSED / _REVOKE_REFUSED
closeAccessReview
  … #3727 rules … ──► rule 5: decidedByUserId === subjectUserId ──► 409, whole close, audited
```

The refusal is named in `member-decision-rules.ts` beside the #3727 reasons, so
`namedCampaignRefusalOf` audits it in its own transaction, as it does those. The
close-time half catches a verdict stored before the rule, the same "refused,
never applied, never dropped" stance #3727 took.

**An AI admin's role change is OWNER-tier at close.** The members page needs
`admin.owner_management` to move a member out of an owner-managed role, and the
close checked only live OWNER subjects. Rule 3b refuses a MODIFY of a live
owner-managed role without that key (`AI_ADMIN_SUBJECT_NEEDS_OWNER_CLOSER`), on
the live role, before any row executes. A REVOKE is not refused, matching the
members page today.

**Reviewer and due date.** `updateAccessReviewSettings` + `PATCH
/access-reviews/:id` (`access_reviews.create`, `assertCanAdmin`) changes the
reviewer and/or due date of a campaign that is not CLOSED. The body schema is
strict, the new reviewer must be an ACTIVE member, the write is conditional on
the status, and `ACCESS_REVIEW_UPDATED` records before/after.

**Regenerating a failed PDF.** The close commits before it renders the PDF, so a
storage failure left a CLOSED campaign with no evidence and no way to make any.
Phase 2 is now `storeMemberEvidencePdf`, built from one mapping
(`memberEvidencePdfInput`) that the close and `regenerateAccessReviewEvidence`
(`POST …/evidence/regenerate`, `access_reviews.close`) both use. Regeneration
reads the stored decisions, the outcome each `ACCESS_REVIEW_DECISION_EXECUTED`
audit row recorded, and the closer and close time on the campaign, so the
regenerated artefact carries the same content hash the close would have. The
link is `attachEvidence`: conditional on CLOSED and no evidence, and it never
rewrites `closedByUserId` (the old phase 2 re-ran `closeCampaign`, which would
have stamped the regenerator as the closer).

## Files

| File | Role |
| --- | --- |
| `src/lib/access-review/member-decision-rules.ts` | Two new named refusals and their messages |
| `src/lib/access-review/scope.ts` | `campaignSettingsEditable`: every scope but AGENT |
| `src/app-layer/usecases/access-review.ts` | Own-row rule, rule 3b and 5 at close, decided counts on the list, the shared evidence builder, `regenerateAccessReviewEvidence`, `updateAccessReviewSettings` |
| `src/app-layer/repositories/AccessReviewRepository.ts` | `countDecidedByReview`, `attachEvidence`, `updateSettings`; the execution read selects notes, decidedAt, decidedByUserId |
| `src/app-layer/schemas/access-review.schemas.ts` | `UpdateAccessReviewSettingsSchema` |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/route.ts` | `PATCH` |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/evidence/regenerate/route.ts` | The regeneration leaf |
| `src/lib/security/route-permissions.ts` | The two rules |
| `src/app-layer/notifications/app-link.ts` | `appLink`: email links made absolute against `APP_URL` |
| `src/app-layer/notifications/templates.ts`, `digest-templates.ts` | Every in-app link through `appLink`; the overdue email's options corrected |
| `src/app-layer/jobs/access-review-overdue-escalation.ts` | Passes `canReassign` |

## Decisions

- **The own-row rule binds OWNERs too.** The owner's decision was that nobody
  decides their own row. A workspace whose only admin is also the only reviewer
  cannot close a campaign that covers them until someone else is made an admin
  or the reviewer; the help docs say so.
- **AGENT campaigns keep their reviewer.** An AGENT campaign's reviewer reads
  register data (`mayReadAgentSubjects`), and the agent flow has no verb that
  moves it. A generic settings edit deciding who reads the register would be a
  second writer of that authority, so it is refused by name
  (`CAMPAIGN_SETTINGS_FIXED_FOR_SCOPE`), and the overdue email leaves the
  reassignment line out for one.
- **Regeneration is member-only.** The connected close files its evidence
  against controls as well as storing it; regenerating that is a different
  flow, left for when it is needed.
- **An unrecorded outcome is printed, not guessed.** If a decision has no
  execution audit row, the regenerated PDF says `UNRECORDED`. Deriving
  `EXECUTED` from `executedAt` would hide a SKIPPED_STALE or SKIPPED_LAST_OWNER.
- **`APP_URL` unset leaves links relative.** That is the vendor-assessment
  reminder's existing behaviour, and inventing a host would send a customer a
  link to their own machine.
- **One primary paid for another.** The settings dialog's save must be primary
  (`modal-action-order`). The header Close trigger, which only opens the close
  dialog, was demoted to secondary to pay for it, so the product-wide primary
  count is unchanged.
