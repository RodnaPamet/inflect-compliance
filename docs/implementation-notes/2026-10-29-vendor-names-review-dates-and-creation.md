# 2026-10-29 — Vendors: live-only names, review dates that stay overdue, gated creation

**Commit:** the `fix(vendors)` series on `claude/fix-vendors-page` (#4462)

## Design

Three owner decisions of 2026-10-29 change how the vendor register behaves,
and each moves a rule to where every writer meets it.

```
name uniqueness   full UNIQUE (tenantId, name)  →  partial UNIQUE … WHERE "deletedAt" IS NULL
                  + createVendor / updateVendor ask findLiveByName first → 409 VENDOR_NAME_TAKEN

nextReviewAt      02:00 sweep set now+365d for every overdue vendor (unaudited)
                  →  sweep reminds the owner and writes nothing to the vendor
                  →  only a completed review (applyAssessmentRiskWriteback) or a person moves it

ACTIVE            updateVendor + bulk status gated, createVendor not
                  →  createVendor runs assertVendorActivationAllowed → 400 VENDOR_ACTIVATION_NEEDS_REVIEW
```

The refusal reasons live in `src/lib/vendor-refusal-reasons.ts`, which has no
server imports, so a page can read `error.details.reason` and show its own
sentence. That is the shape `src/lib/asset-name-taken.ts` set for Assets.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261029190000_vendor_name_unique_among_live/migration.sql` | builds the partial index, then drops the full one; rollback in the header |
| `prisma/schema/vendor.prisma` | drops `@@unique([tenantId, name])`; says why the partial index cannot be declared |
| `src/app-layer/repositories/VendorRepository.ts` | `findLiveByName` — the index's own question |
| `src/app-layer/usecases/vendor.ts` | name check on create and rename; activation gate on create |
| `src/app-layer/usecases/vendor-reassessment-reminder.ts` | reminder only, deduped per (vendor, owner, due date) |
| `src/lib/vendor-refusal-reasons.ts` | the two named reasons, client-safe |

## Decisions

- **The new index has its own name** (`Vendor_tenantId_name_live_key`). It is
  built before the old one is dropped, so both exist for a moment, and a
  rollback can do the same in reverse without a name collision.
- **No plain `(tenantId, name)` index.** Asset kept one beside its partial
  index; nothing here reads vendors by name across deleted rows, and the
  partial index serves the live-row lookup. `prisma migrate diff` does not
  read partial indexes, so the fresh-DB drift gate sees no residue.
- **The reminder is deduped on the due date, not on today.** The bump was
  what stopped a nightly reminder before; without it the same overdue vendor
  would notify its owner every night. A key naming `nextReviewAt`'s day keeps
  the old "once per vendor per cycle", and a new owner or a new date is a new
  reminder. The 07:00 digest still emails while the vendor is overdue.
- **Owner-less vendors: the docstring now matches the code.** It promised an
  in-app notice to admins that was never sent. No new fan-out was added: the
  07:00 digest already routes unowned overdue reviews to owners and admins,
  and the bump had been hiding them from it.
- **A review that completes without a risk rating does not move the date.**
  `applyAssessmentRiskWriteback` returns early on a null rating, so such a
  vendor stays overdue. That is the existing rule; whether a rating-less
  review counts as completed is an open product question, not changed here.
- **No vendor restore was built.** A deleted vendor frees its name, but
  nothing restores one; the `Vendor` entry in `RESTORE_VALIDATORS` is still
  the no-op. A restore route would need the Asset validator's taken-name
  check.
