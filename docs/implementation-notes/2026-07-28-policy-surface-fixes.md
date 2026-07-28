# 2026-07-28 — Policy surface fixes (POL-2)

**Commit:** `<sha>` fix(policy): reversible archive, honest bulk actions, non-stale acknowledgements

Follows PR #1731 (approval lifecycle) and #1732 (custom-role gate coverage),
which closed the SERVER-side policy gaps. This wave closes the surface ones:
places where the UI offered an action the server would reject, hid an action
the server allowed, or reported a state the server had already changed.

## Design

The unifying defect is **the client and the server disagreeing about what is
possible**, in both directions. Four shapes of that:

### 1. Affordances that contradicted the server (POL-2.2, POL-2.3)

The header **Publish** button lit up in a state the server always rejects.
Creating a version demotes the policy to DRAFT but leaves `currentVersionId`
on the OLD version, which still carries its APPROVED approval — so the gate's
`headerHasApproved && !headerIsPublished` was true while the status was DRAFT,
and every click threw `is DRAFT; cannot publish`.

Two things were wrong, not one. The gate ignored the policy's own status, AND
it targeted `headerVersion`, which is not the version the server would accept:
nothing updates `currentVersionId` when a version is created or approved. The
publish target is now derived from the approval record (most recently decided
APPROVED row) — exactly what `publishPolicy` binds against. The comment at
`policy.ts:858` claimed version creation sets `currentVersionId`;
`PolicyVersionRepository.create` demonstrably does not, so the comment was
stale and the gate wrong, rather than the code having regressed.

The approval banner disabled **both** Approve and Reject on a self-request,
citing a rule that does not exist: `decidePolicyApproval` refuses
`decision === 'APPROVED' && requester === me` only, and permits self-rejection
precisely so a requester can WITHDRAW. The effect was a trap — the one person
who most wants to withdraw was the one person refused, and the policy sat in
IN_REVIEW with no route out. The per-version card turned out to be RIGHT, so
the fix makes the banner agree with the card rather than the reverse.

### 2. Saving a live policy silently withdrew it (POL-2.1)

Creating a version on a PUBLISHED policy demotes it to DRAFT, and
`attestPolicy` requires PUBLISHED — so pressing Save in the editor stopped
every outstanding acknowledgement and dropped the policy from coverage, with
no warning in that tab. `proposeOnly` existed on the usecase for exactly this
and was unreachable from the UI (the HTTP schema stripped it), so the
SharePoint pull could use it while the editor structurally could not.

Chose `proposeOnly` over the "warn first" alternative, and kept the warning
too: warning alone still withdraws the policy, the user just knows it is
happening. APPROVED counts as live alongside PUBLISHED — `createPolicyVersion`
demotes it too.

### 3. Archive was a one-way door (POL-2.4)

Archiving is a STATUS transition, and nothing anywhere set the status back.
The two paths that write DRAFT (`createPolicyVersion` and a rejected approval)
both refuse archived policies outright, so an archived policy could not be
edited, reviewed, published, or recovered by any route — destroyed by a single
**unconfirmed** click.

`restorePolicy` did not help: it reverses a SOFT DELETE (`deletedAt`), an
independent axis. A policy can be archived without being deleted, and
`/restore` does nothing for an archived one.

New `unarchivePolicy` + `POST …/policies/[id]/unarchive`, admin-gated to match
`archivePolicy`. It lands the policy in **DRAFT**, deliberately, rather than
the status it held before: restoring straight to PUBLISHED would put a live
document back in front of users — and re-open acknowledgement obligations —
without passing the approval gate. DRAFT means the normal review path applies,
which is the conservative reading of "undo the archive". Archive also gained
the confirm it never had, at `tone="warning"` rather than `"danger"` because
it is now genuinely reversible.

### 4. State reported after the server changed it (POL-2.5, POL-2.6)

`PolicyAcknowledgementsPanel`'s fetch effect depended only on stable values,
so a mounted panel never refetched. Both publish and rollback run
`carryForwardAckCampaign`, which deliberately RE-OPENS everyone's
acknowledgement against the new version — the whole point being that people
must re-read what changed. The panel kept rendering "You acknowledged this
policy" and a stale percent-complete bar after the campaign underneath it had
been reset: the most dangerous possible staleness, telling someone they are
compliant when the system has just recorded that they are not. A
`refreshToken` bumped by the parent after both operations forces the refetch.

Assignments are version-scoped (keyed on `currentVersionId`), so the roster now
names which version it describes — the same numbers mean something different
after a republish, and on a DRAFT policy they describe the last PUBLISHED
version, not the draft being edited.

### 5. Bulk actions had their consequences inverted (POL-2.7)

Delete (a reversible SOFT delete) carried a blocking confirm; Archive (which
blocks every edit path) had none. Swapped: Delete routes through the Epic 67
undo-toast, Archive takes the confirm.

Underneath, `bulk-action-bar`'s `onApply` was called bare while the policies
handler was `async` and threw — an unhandled promise rejection. No toast, no
error state, and the selection left intact as though nothing had been
attempted. `bulk.failed` was referenced in the handler but could never reach a
user, and the success path said nothing either. `onApply` is now awaited at the
primitive (its type widened to `void | Promise<void>`), the handler catches and
surfaces the server's own error text, and both outcomes toast.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/policy.ts` | New `unarchivePolicy` — admin gate, not-archived conflict, DRAFT landing, `POLICY_UNARCHIVED` audit. |
| `src/app/api/t/[tenantSlug]/policies/[id]/unarchive/route.ts` | New route, mirroring the `archive` sibling (thin, `withApiErrorHandling`, usecase owns authz). |
| `src/app/api/t/[tenantSlug]/policies/[id]/versions/route.ts` | Passes `proposeOnly` through to the usecase. |
| `src/lib/schemas/index.ts` | `CreatePolicyVersionSchema` accepts `proposeOnly` (it was stripped here). |
| `public/openapi.json` + `tests/**/api-schemas.test.ts.snap` | Regenerated for the schema change. |
| `src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx` | Publish-gate rewrite, self-request Approve/Reject split, Restore button, archive confirm, `ackRefreshToken`. |
| `src/components/ui/ApprovalBanner.tsx` | Approve and Reject gated separately; stale PENDING rows show "No longer current". |
| `src/components/policies/PolicyAcknowledgementsPanel.tsx` | `refreshToken` + version-labelled roster + not-published roster hint. |
| `src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx` | Bulk delete → undo-toast, archive → confirm, success/error toasts. |
| `src/components/ui/bulk-action-bar.tsx` | `onApply` awaited; rejections surface instead of escaping the React tree. |
| `messages/{en,bg}.json` | New keys; `cannotRejectOwnTitle` retired (it asserted a nonexistent rule). |

## Decisions

- **Unarchive lands in DRAFT, not the prior status.** The alternative
  (remember and restore the pre-archive status) is more "faithful" but
  republishes a live document without approval and silently re-opens
  acknowledgement obligations. Two unit tests pin the DRAFT landing, one of
  them specifically for a policy archived while PUBLISHED.
- **Unarchive is a separate verb from `restorePolicy`, not an overload.**
  Archive-status and soft-delete are independent axes; a policy can be in
  either, both, or neither. Collapsing them would make `/restore` on an
  archived-but-not-deleted policy do something surprising.
- **`tone="warning"` on the archive confirm.** The destructive-action
  vocabulary reserves `danger` for irreversible effects. Archive became
  reversible in this same diff, so `warning` is the honest tone — and the
  confirmLabel `Archive policy` is already the canonical `Archive {Entity}`
  verb.
- **Bulk delete uses the undo-toast rather than keeping its confirm.** Epic 67
  is explicit that reversible destructive actions take the undo window and that
  blocking confirms are the anti-pattern it replaces. The optimistic cache
  update carries a `guardrail-ignore` with its reason: the server still owns
  the list filter, and `mutate()` restores on Undo or failure.
- **The publish target derives from the approval record, not
  `currentVersionId`.** Fixing `currentVersionId` to track new versions would
  be the deeper fix, but it is load-bearing for acknowledgement scoping
  (assignments key on it) — changing it would silently re-point live ack
  campaigns. Deriving the target locally is the change whose blast radius is
  the button.
- **No route-permissions entry for `/unarchive`.** `policies/` is not a
  `PRIVILEGED_ROOTS` entry in the C.1 guardrail; the whole policy surface gates
  in the usecase layer (`assertCanAdminPolicies`). The new route matches its
  `archive` sibling exactly — adding a lone `requirePermission` here would make
  the surface inconsistent, not safer.
