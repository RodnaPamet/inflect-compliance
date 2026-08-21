# 2026-08-21 — Giving the break-glass rail a producer

**Commit:** `<pending>` feat(jml): let an operator mark an account never-offboard

`disableAccount` has refused a protected account since #2036. The refusal, its
reason and its outcome were all in place and tested. Nothing ever set the flag —
`DisableAccountInput.isProtected` had no producer anywhere in the codebase — so
the rail was a guard bound to nothing.

Under the DRY_RUN clamp that was tolerable: such an account is reported as
would-be-disabled and an operator reading the pass sees it. It stops being
tolerable the moment a tenant is promoted, because then the first AUTOMATIC run
disables a break-glass credential with nothing in front of it.

## Design

### Why a flag on the account

The original plan specified `protectedAccountIds` as a connection config field.
The operator chose a flag on the account instead, and two alternatives were put
up and rejected on their failure modes:

- **Deriving protection from `isAdmin`** fails OPEN across an entire directory on
  one swallowed Graph 403. A rail that silently stops protecting is worse than no
  rail, because nobody watches for its absence.
- **A PROPOSE-style approval queue** duplicates a rung the ladder already has,
  and this rail has to work at AUTOMATIC — the mode where, by definition, nothing
  else stands in front of the write.

What the feature deliberately does NOT do is decide which accounts belong on the
list. Nothing in the schema identifies a break-glass credential and any rule
invented here would be fiction. The narrowing fact: a pure service account with
no Employee row can never be a candidate at all, because links are created only
by exact email match. The real target is narrower and nastier — an address that
used to be a person's, kept as the emergency credential, whose link is
legitimate and re-verified nightly.

### The single most important line is an omission

The four new columns are **absent from the sync upsert's `update` block**. The
nightly sync would otherwise clear the flag, and the failure is invisible until
the one night it matters.

Prisma's explicit field lists are what make the omission sufficient: the upsert
is not a spread, so a new column is opted IN rather than swept along. That is
stated in the schema and again at the upsert, because it is the kind of thing a
later "tidy the sync to use a spread" would silently undo.

### A reason is required to protect, and meaningless to release

The whole value of this list a year from now is that every entry says why it is
there; an unexplained never-offboard flag is indistinguishable from a mistake.
Releasing needs no justification, and clears the provenance rather than leaving
it — a stale "protected by X on the 3rd" beside an unprotected account is a
sentence that reads as true and is not.

The requirement lives in the usecase, not only in the UI: the submit button is a
courtesy, the refusal is the rule. It also refuses **before opening the
transaction**, so a malformed request costs no DB round-trip.

### Encrypted, and why the flag beside it is not

`protectionReason` joins the Epic B manifest. It is operator free text that will
routinely name a person or the purpose of a credential — the same shape as
`IdentityWriteJournal.detail`. Adding it to the manifest then required
classifying the model for Epic D.2's sanitiser coverage; it is sanitised at the
write path, per C.5, because the roster page and anything that later renders the
protected set read the row back verbatim.

`isProtected` and `externalUserId` are deliberately NOT encrypted, and a test
asserts it: one drives a refusal and the other addresses a directory write.
Encrypting either would break the feature rather than protect anyone. The
manifest is for free text about people, not for flags.

### The path dissolves a hazard rather than navigating it

`PATCH /api/t/:slug/admin/identity-account-protection/:accountId` is a **sibling**
of `admin/identity-write-policy` and `admin/identity-leaver-passes`, not nested
under `admin/integrations/identity-accounts` where the roster GET lives.

Route matching is first-match-wins and the `admin/integrations` rule resolves to
`admin.manage`. A nested path would have required inserting a rule above it, and
getting that wrong leaves the permission map documenting a weaker gate than the
handler enforces — a disagreement no guardrail catches. Choosing the path removes
the possibility.

Gated `admin.tenant_lifecycle`: deciding the product may NOT disable an account
is authority of the same class as deciding that it may, and releasing one hands
back standing power to disable it.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/personnel.prisma` | `isProtected` + `protectedAt` / `protectedByUserId` / `protectionReason` |
| `prisma/migrations/20260821100000_connected_identity_account_protection/` | additive; `NOT NULL DEFAULT false` needs no backfill |
| `src/app-layer/usecases/identity-account-protection.ts` | new — set and release, with the audit entry |
| `src/app-layer/usecases/identity-sync.ts` | the omission, stated where a reader will look |
| `src/app-layer/usecases/identity-disable-account.ts` | `findLeaverCandidates` selects and maps the flag |
| `src/app-layer/usecases/integrations.ts` | the roster returns it — FIELDS added, shape unchanged |
| `src/app/api/.../admin/identity-account-protection/[accountId]/route.ts` | the write surface |
| `src/lib/security/route-permissions.ts`, `tests/guardrails/admin-route-coverage.test.ts` | registration |
| `src/lib/security/encrypted-fields.ts`, `tests/guardrails/sanitize-rich-text-coverage.test.ts` | manifest + classification |
| the roster page, `messages/{en,bg}.json` | the operator surface |

## Decisions

- **`REFUSED_PROTECTED` accounts still count toward the blast-radius breaker**,
  and that is a choice rather than an oversight. The breaker measures the roster
  the pass was handed, and a roster that is mostly protected service accounts is
  itself an anomaly worth refusing on. Excluding them would make a
  misconfigured population look smaller and safer than it is.
- **The response SHAPE of the roster endpoint is unchanged.** Its other consumer
  checks `Array.isArray()` against an object, so its gate is permanently inert
  and fails open. Adding fields cannot disturb that; changing the shape would
  flip it to failing loudly. Filed separately rather than fixed here.
- **No StatusBadge in the protection column.** The page sits at the
  badge-density cap of 5 — but the better reason is that this is an ACTION
  column, and an unclickable badge beside a button reads as two controls where
  there is one.
- **A bare `protectedByUserId` string, not a `User` relation.** The
  hash-chained audit log is the authoritative record of who protected what; the
  column is a display convenience, and a relation would add a back-relation and
  an FK index for something nothing joins.
