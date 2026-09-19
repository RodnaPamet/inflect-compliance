# 2026-09-19 — JML HRIS write-back, Phase 1 (credential + vocabulary)

**Issue:** #2639. **Design:** `docs/jml-hris-write-back-design.md` (Phasing → Phase 1).

## Design

Phase 1 of the outbound work-email write-back is *"credential and vocabulary. No
writes."* Phase 0 (#2549) shipped the ADDRESS — `Employee.hrisRecordId`, still
with no reader. Phase 2 (the write) is blocked: the design says it *"must not
ship before the joiner settles what a pre-hire is. It has no subject until
then."*

So this change names the three things a write will later need permission from,
and stops:

```
                      gateWriteBackPreflight()          ← no network
  tenant JOINER rung ──┐
                       ├─ mode DISABLED            → REFUSED_MODE
                       ├─ isAboveClamp(mode, DRY_RUN) → REFUSED_MODE
  connection config ───┤
                       └─ writeBackEnabled !== true → REFUSED_WRITE_BACK_DISABLED
                              │ null = "go and look"
                              ▼
                 preflightOrangeHrmWriteBack()      ← two GETs, one OAuth POST
                   1. token exchange                 → REFUSED_CREDENTIAL / INDETERMINATE
                   2. GET /pim/employees?limit=1     → handle (empNumber)
                   3. GET /pim/employee/{n}/contact-details → the identity field
                              ▼
                     WRITE_PATH_READABLE            (writeProven: false, always)
```

The verdict is deliberately not "the credential can write". Proving that
requires writing. `HrisWriteBackPreflightResult.writeProven` is typed as the
literal `false`, so widening it is the type change that makes Phase 2 visible in
review.

**Two reads, not one, and that is the finding rather than a convenience.** On a
live `orangehrm/orangehrm:5.9` (#2587) the list row carries the write-back
handle (`empNumber`) and does NOT carry the work email at any `model` — proved
by A/B, since the same employee's contact-details endpoint returns an address
the list row omits. "Handle present, identity field absent" is a real vendor
shape, so the result reports `handleObserved` and `identityFieldReadable`
separately and the preflight never reads the identity field off a roster page.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/hris/write-back.ts` | New. The vocabulary: `writeBackEnabled` read strictly, `HRIS_WRITEBACK_MAX_MODE`, the outcome union, the result factory and its honesty invariant, the non-network gate, the provider seam. |
| `src/app-layer/integrations/providers/orangehrm/write-back-preflight.ts` | New. The live preflight — two reads, no write, Decision 4's proven/not-proven classification. |
| `src/app-layer/integrations/providers/orangehrm/index.ts` | Declares the `writeBackEnabled` config field and implements `writeBackPreflight`, gate first. |
| `src/app-layer/integrations/providers/orangehrm/token.ts` | `OrangeHrmTokenError` carries the HTTP status so the preflight classifies by number rather than by parsing a message. |
| `src/app-layer/integrations/config-schema.ts` | Classifies `orangehrm.writeBackEnabled` — `validateProviderConfig` rejects an undeclared key outright. |
| `tests/unit/hris-write-back-preflight.test.ts` | New. Gate, live preflight, provider wiring, and the deliberate BambooHR absence. |

## Decisions

- **The flag is its own, not Entra's `writesEnabled`** (owner decision
  2026-09-19). That one is consent to disable accounts in a DIRECTORY. This is a
  different vendor's token writing into a customer's system of record, where the
  correction is made by hand by somebody who does not know we did it. Riding on
  a flag approved for directory writes would be consent by accident.

- **BambooHR does NOT get the checkbox, and that is a decision.** Decision 1 of
  the design still makes it the first CUSTOMER target. But Open Question 1 —
  does BambooHR expose an employee-update API at the same gateway base with the
  same Basic auth? — is *unanswerable from here*, and `liveValidation = false`
  means nothing has ever proven that key does anything. A checkbox is a question
  put to a customer; asking them to grant a write we cannot attempt and cannot
  preflight is the same accidental consent one level up. The absence is pinned
  by a test that says to delete itself when a BambooHR preflight exists.

- **The clamp lands with a reader.** `write-ladder.ts` warns that *"a clamp
  constant with no pass reading it is a fourth thing to keep in sync"*.
  `HRIS_WRITEBACK_MAX_MODE` is read by `gateWriteBackPreflight` in this same
  commit, so it is load bearing on the day it lands. It is `DRY_RUN` because
  there is no write for an `AUTOMATIC` tenant to be granted.

- **`isAboveClamp`, not `!==` — stated honestly.** The two agree TODAY, because
  once `DISABLED` is handled separately the only rungs left are `DRY_RUN` (equal)
  and `AUTOMATIC` (above). They stop agreeing the moment Phase 2 raises the
  constant, which is the change this constant exists to make one line. Unlike the
  leaver's clamp branch, this one is reachable today — a tenant at `AUTOMATIC` is
  refused — so the test needs no invented mode.

- **`mode` is a parameter, not a read.** Per Decision 2 the write-back inherits
  the joiner's rung; reading `getIdentityWritePolicy` here would pull prisma and
  the tenant-context helpers into every provider that imports the seam, which is
  the same reason `write-ladder.ts` carries no server imports.

- **A failed roster read is `PREFLIGHT_INDETERMINATE`, never `REFUSED_NO_HANDLE`.**
  `REFUSED_NO_HANDLE` is a claim about what the roster CONTAINS, and a read that
  failed proves nothing about that. Only 401/403 shortcut to a credential
  refusal, mirroring `DirectoryWriteError.definitivelyNotApplied`'s default-false
  direction: a refusal decided once for a whole batch is sound only when proven.

- **Present-and-null is readable; key-absent is not.** An empty work-email field
  is the expected pre-hire state and the case the write exists for. On 5.9
  sibling keys come back as explicit `null`, so an ABSENT key means absent from
  the shape — which is what makes the distinction observable at all. The probe
  subject's field being NON-empty is not a refusal either: emptiness is a
  candidate fact belonging to Phase 2's conditional, and reading it as a
  connection fact would refuse a batch because employee #1 happens to have an
  address.

- **The status moved onto the error rather than staying in its message.**
  `OrangeHrmTokenError` keeps the message byte-identical; what it adds is a
  number a caller can ask for. Recovering it by parsing prose is the shape that
  starts silently answering "unknown" the day somebody rewords the sentence. It
  still does not classify the OAuth error BODY — that gap is shared with Workday,
  Google DWD and Entra, and still belongs solved once.

## Not in this change, deliberately

The design's Phase 1 line also names the `WRITE_BACK_WORK_EMAIL` member of
`IdentityWriteAction` and the `'writeback'` metric label. Neither is here:

- The enum member needs an additive Postgres enum value plus a regenerated
  Prisma client. Adding the TS union member alone would compile against a
  generated client that does not carry the value.
- A metric label with no emitter is the "fourth thing to keep in sync" the
  ladder module warns about. It lands with the write that records an outcome.
