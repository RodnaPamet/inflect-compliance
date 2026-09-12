# 2026-09-12 — The DISABLED mail told operators to read the journal; nothing could

**Commit:** `774fde520` feat(jml): make the DISABLED email's instruction true — a read surface for the write journal

At 05:00 UTC today this product performed its first real directory disable.
`DISABLED: 1`, evidence live, `IdentityWriteJournal`'s first row ever at
`APPLIED`, confirmed by the operator in the Entra portal. The notification that
went out carried this sentence:

> The state the account was in before the write was captured first, and is held
> against journal reference `<id>`. There is no self-service restore screen —
> quote that reference to your platform administrator, who can read the captured
> state and re-apply it.

Neither half of that was buildable from the product. There was no journal API
route and no journal page; `findRestorableState` had zero callers anywhere in
`src/`; `DirectoryWriter` declares no `enable()` verb. And
`recordPassExecution` dropped `journalId` when mapping decisions onto the pass
row, so the only in-product pointer from a disable to its capture was
`detailsJson.journalId` on the audit row — which the leaver-pass report cannot
reach and an operator reading that report cannot see.

This PR ships the READ half. It does not build `enable()`.

---

## Why the read half alone

The two halves of that sentence are not the same size of decision.

Reading a capture is a disclosure question: who may see what one of a customer's
accounts used to be. Re-applying it is a WRITE back into a directory we do not
own, at the end of a ladder (`DISABLED → DRY_RUN → AUTOMATIC`) whose entire
design is about making such writes deliberate. Bundling them would have smuggled
the second past the review the first deserves.

It is also the half that was doing harm. An instruction a product cannot honour
is worse than no instruction: it sends somebody hunting for a screen that does
not exist, at the exact moment they are trying to undo a disable. Surviving that
moment is the whole reason `beginWrite` commits before the provider is called.

---

## What landed

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-write-journal.ts` | `getJournalWrite` (by reference) + `listJournalWrites` (bounded index) + the shared narrow `select` |
| `src/app-layer/usecases/identity-leaver-pass.ts` | `recordPassExecution` carries `journalId` onto each decision |
| `src/app/api/t/[tenantSlug]/admin/identity-write-journal/route.ts` | OWNER-gated index |
| `src/app/api/t/[tenantSlug]/admin/identity-write-journal/[journalId]/route.ts` | OWNER-gated by-reference read — the captured prior state |
| `src/lib/security/route-permissions.ts` | one subtree rule at `admin.tenant_lifecycle` covering both |
| `tests/guardrails/admin-route-coverage.test.ts` | both route files registered |

---

## Decisions

**`journalId` goes onto the decision unscrubbed, and the comment says why rather
than leaving it implied.** Every `reason` on a decision runs through
`redactDirectoryIdentifiers`, because a provider- or rail-authored sentence
embeds the account it is about — "Entra refused to disable account `<guid>`". A
journal id is not a sentence. It is an opaque cuid minted by our own database,
tenant-scoped by RLS, resolvable only through an authorised read of a table we
own. Scrubbing it would be theatre, and it would corrupt the one field whose
entire value is being quotable verbatim against the mail. The invariant to
preserve is the one `DecisionBasis` already states about itself: a field may go
in unscrubbed only if it can name nobody.

**It is ABSENT, not `null`, on a decision that never reached a write.**
`journalId` exists only once `beginWrite` has committed a capture, so the three
refusals decided before it (self-account, protected, ladder) and the
stranded-connection refusal carry none. A `null` on the row would read on screen
as "a capture was attempted and produced nothing" — a different and far more
alarming claim than "no write was attempted". Same rule `basis` follows, for the
same reason.

**Two shapes, not one.** `listJournalWrites` is an index; `getJournalWrite` is
the answer. The index selects neither `priorStateJson` nor `detail`. A page of a
hundred rows must not ship a hundred directory captures to answer "which row was
it?", and must not decrypt a hundred `detail` values nobody reads — the same
shape `listUnsettledWrites` already refuses one function up, and for the same two
costs (a decrypt per row per sweep, and a per-row warning for ever on a key
problem).

**`detail` IS returned by the by-reference read. This was the judgement call.**
The column is on the Epic B encryption manifest, and that entry is right about
what it holds: free text about a NAMED person's access change, with provider
rejections routinely echoing the UPN back. Three things decided it:

  - *The manifest governs REST, not AUDIENCE.* Its job is that a stolen database
    file, a leaked backup or a replica read yields no plaintext. It makes no
    claim about who may read the value through an authorised, tenant-scoped
    request. The codebase already settles this one manifest entry over:
    `ConnectedIdentityAccount.protectionReason` holds the same shape of free text
    about the same people, is selected by the identity-accounts roster read, and
    is rendered on that page at `admin.manage`. This route is a full tier above
    that, at OWNER.
  - *Withholding it would defeat the lookup.* For an APPLIED row the prior state
    is the whole answer. For a FAILED or INDETERMINATE row, `detail` IS the
    answer — it is the provider's own account of what happened, and without it an
    INDETERMINATE row says "we do not know whether your directory changed" and
    offers not one clue toward finding out. That is precisely the row a human was
    summoned for.
  - *The alternative relocates the read rather than preventing it.* An operator
    denied the reason in-product opens the provider's own admin centre and reads
    the same message there, with none of this tenant's permission model in front
    of it and no audit row behind it.

**`externalUserId` is returned by neither.** This subsystem does not hand the raw
directory identifier out of the module — every surface that has ever received one
eventually persisted it somewhere unencrypted. `linkId` is the handle that does
the same job and resolves to a person only through an authorised read of the
roster. Leaving the column unselected makes that structural rather than a matter
of caller discipline, which is the same argument `listUnsettledWrites` makes.

**A SIBLING path, not `admin/integrations/identity-write-journal`.** Route
matching in `route-permissions.ts` is first-match-wins and the
`admin/integrations` rule resolves to `admin.manage`. Nesting would have left the
permission map documenting a weaker gate than the handler enforces — a
disagreement no guardrail catches, because the two mechanisms are read by
different consumers (the handler by requests, the map by SDK generation and
`/api/docs`). Choosing the path dissolves the hazard rather than navigating it.
One subtree rule covers the index and the by-reference read, so the two cannot
drift onto different keys.

**404, not 403, for an unknown reference.** The lookup is tenant-scoped by RLS
and by an explicit `tenantId` predicate, so a reference belonging to another
tenant is simply not there. Answering the same way for a mistyped id and a
foreign one keeps the response from becoming an oracle for whether a given cuid
exists somewhere else in the fleet.

---

## Not done, and what a follow-up needs

**A UI page.** Out of scope here deliberately — this PR ships the data surface.
A follow-up would want: a route under
`src/app/t/[tenantSlug]/(app)/admin/identity-write-journal/`, built on
`EntityListPage` with the index as its table; `priorState` rendered as a
key/value panel rather than raw JSON, since its shape is provider-specific and
deliberately unfrozen (`priorStateJson`'s schema comment says why); and a link
from each leaver-pass decision, which is now possible because the decision
carries `journalId`. The page is OWNER-gated like the routes, so it belongs
beside `admin/identity-write-policy` in the admin nav, not under integrations.

**`enable()`.** Still absent, still deliberate. Note that the restore an operator
performs today is manual, in the provider's own console, from the state this
surface now shows them — which is a real workflow, not a placeholder for one.
Building `enable()` would need its own rung of the ladder, its own blast-radius
breaker, and a decision about whether a REVERTED settle may be written by the
same actor who requested it.

**`findRestorableState` still has no caller.** This PR did not wire it, and that
is not an oversight: it is keyed by `(provider, externalUserId)` and the mail
hands out a journal id, so the by-id lookup is the shape the product actually
needs. `findRestorableState` is the shape `enable()` will want — it answers "what
is the newest restorable state for this account", including INDETERMINATE rows
whose capture may be the only surviving copy. Leave it for that.
