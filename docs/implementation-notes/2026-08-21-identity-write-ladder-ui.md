# 2026-08-21 — Identity write ladder: the operator surface

**Commit:** `(this PR)` feat(jml): give the write ladder a door

## Design

The write-mode ladder (`DISABLED → DRY_RUN → PROPOSE → AUTOMATIC`) shipped with a
usecase, an OWNER-gated route, a one-rung-at-a-time rule and a seven-day minimum
in `DRY_RUN` — and nothing in the product that called it. The practical
consequence was not cosmetic: **the mandated observation period could not be
STARTED through the product.** Moving a tenant off `DISABLED` required a
hand-made HTTP request from someone holding an OWNER session, so the ladder's
central design argument — that widening is a deliberate, reviewable act — rested
on folklore passed between operators rather than on anything the product did.

This adds the page. It is deliberately a read-and-two-buttons surface: the GET
already returns everything it needs, and the usecase already enforces the rules,
so the page **surfaces refusals rather than re-implementing them**. There is one
place the ladder's rules can be wrong, and it is not the client.

Three commitments separate it from a generic settings form. Each is the kind of
thing that passes a source scan while being visibly broken, which is why each is
pinned by a rendered test rather than a structural one.

1. **The refusal is on screen, next to the control it disables.** The GET returns
   `blockedReason` per direction precisely so a control can explain itself. A
   greyed-out button with no reason is how an operator concludes the feature is
   broken and goes looking for a bug that is not there.

2. **Widening is confirmed every time; narrowing is one click, never confirmed.**
   Narrowing is the emergency stop. A dialog in front of the stop is a reason to
   hesitate at the moment nobody should. The asymmetry is the design.

3. **A rung above what the runtime honours says so.** The leaver pass clamps
   itself at `LEAVER_MAX_MODE`; the joiner has no implementation at all. Both are
   settable and both would then do nothing. A control that accepts a value the
   system silently ignores is worse than one that refuses, so the GET now reports
   a `honoured` block (`maxMode` + `implemented`) and the page warns from it.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/admin/identity-write-policy/route.ts` | GET now reports `honoured` per direction — what the runtime will actually act on |
| `.../admin/identity-write-policy/page.tsx` | OWNER gate (`admin.tenant_lifecycle`) + forbidden fallback |
| `.../admin/identity-write-policy/WriteLadderClient.tsx` | The surface: two labelled regions, one rung of travel each way |
| `.../admin/integrations/page.tsx` | The door — same OWNER gate on the link as on the page |
| `src/lib/nav/page-segregation.ts`, `src/lib/nav/canonical-parents.ts` | Route classified as a subpage; breadcrumb parent agrees with the registry |
| `tests/guardrails/admin-layout-guard.test.ts` | Allowlisted as a genuinely stricter gate than the layout's `admin.view` |
| `tests/guardrails/design-system-drift.test.ts` | Promoted to `MIGRATED_PAGES` rather than parked in the unmigrated tally |

## Decisions

- **`warning` tone on the confirm, not `danger`.** This repo reserves `danger`
  for the irreversible — delete, revoke, rotate. Widening is reversible by
  construction: narrowing is always allowed and sits beside the button. Dressing
  a reversible act as an irreversible one spends the loudest signal the design
  has on the wrong thing, and leaves nothing louder for acts that truly cannot be
  undone.

- **`setMode` REJECTS on refusal, and that is load-bearing.** `Modal.Confirm`
  closes itself when `onConfirm` resolves and stays open when it rejects — "so
  the caller can surface an error", in its own words. Swallowing the failure
  would resolve, closing the dialog over a refusal the operator never read. The
  widen path renders the server's sentence inside the dialog; the narrow path has
  no dialog and reads the same message from the page-level notice.

- **The refusal renders as a `span.block`, not an `InlineNotice`.** The primitive
  renders `description` inside a `<p>`; a `div` there is invalid nesting that
  React reparents at runtime.

- **Each direction is a labelled `<section>`, not a bare card.** Two structurally
  identical blocks carry the SAME button words — "Widen to Dry run" appears in
  both when both sit at Off. Without a named landmark a screen-reader user meets
  the second set of controls with nothing to say which directory operation they
  govern, and on this page that is the difference between creating accounts and
  disabling them. It is an accessibility fix first; that it also gives the tests
  a locator which cannot drift is a second benefit, not the reason.

- **The page gate duplicates the layout's on purpose.** The admin layout gates on
  `admin.view`; this endpoint is `admin.tenant_lifecycle`, because deciding
  whether the product may disable accounts in a customer's directory is authority
  of the same class as tenant deletion. Without the page gate a non-OWNER admin
  reaches a rendered page and is told the policy "couldn't load" — a permission
  refusal wearing the costume of a broken backend.

- **Only the NEXT rung is offered, never a jump.** The usecase already refuses
  skips. Offering a jump the server will refuse would manufacture a failure the
  operator has to interpret.

## Still true after this PR

The page changes what an operator can express, not what the product does. The
leaver pass remains clamped at `DRY_RUN` and the joiner remains unimplemented, so
setting a wider rung records intent and nothing more — which is now stated on
screen instead of being discovered. The two non-code gates (Entra re-consent, the
per-connection `writesEnabled` flag) are also untouched and still apply.
