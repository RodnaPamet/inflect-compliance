# 2026-07-29 — Automation data loss, plus the residue two audits left behind

**Commit:** `<sha>` fix(automation): forward dropped rule fields; move the webhook HMAC key out of plaintext

Five items in one change, because they share a shape: each is a place where a
value the system *accepted* never reached the place that needed it.

| # | Item | Origin |
|---|---|---|
| 1 | Routes silently dropped `elseRuleId` + `scheduleConfig` | P2.1 (HIGH) |
| 2 | Filter data loss on rule edit | P2.2 (HIGH) — **already fixed**, verified only |
| 3 | Webhook HMAC key sat in plaintext `actionConfigJson.secretRef` | left open by the part-2 audit |
| 4 | Webhook dedupe ran pre-auth and globally | left open by the part-2 audit |
| 5 | Edge `controlId` written without an ownership check | P1.10 residue |

## 1 — the two dropped fields, and why the guard matters more than the fix

`elseRuleId` and `scheduleConfig` were accepted by the Zod schema, persisted by
the repository, and constructed by the builder — and referenced **zero** times in
either route. Both routes enumerate fields by hand and stop after
`nextRuleDelay`.

The consequences were total, not partial:

- the entire "Else / when conditions fail" control was **write-only theatre**;
- `scheduleConfigJson` stayed `null`, so the schedule sweep **could never fire a
  SCHEDULE rule** — despite an in-code comment claiming that was already fixed.

Forwarding two fields fixes today. The root cause is hand-enumeration, so the
durable fix is `tests/guards/automation-route-field-forwarding.test.ts`: it
parses the schema — **following `...SlaFields` spreads**, which is where both
dropped fields actually live — and names any field a route does not forward.
A parser that ignored spreads would have reported both as absent from the schema
and passed vacuously; a sanity assertion on the parsed field count exists because
the first draft of the parser did exactly that.

## 2 — P2.2 was fixed five days before the audit said it was open

`filterJson` round-trips correctly through the builder as of PR #1697
(2026-07-24). No code was written. Recorded here because "verified already fixed"
and "not looked at" are indistinguishable in a diff.

## 3 — the HMAC key, and why the migration deliberately does not backfill

`secretRef` is documented as "a reference, never the raw secret" and is used
directly as the HMAC key. So the raw value sat in plaintext `actionConfigJson`,
outside the Epic B manifest. Part 2 fixed the *dishonesty* (the type and call
site now say what happens) and left the storage.

Now: a new `AutomationRule.webhookSecretEncrypted` column, in the Epic B
manifest. The migration adds the column **and stops there**. It cannot backfill:
the column's value is produced by the Prisma middleware from the per-tenant DEK,
so a SQL backfill would write plaintext into a column the application then tries
to decrypt — corrupting it. `scripts/migrate-webhook-secrets.ts` does the move
through the application layer, idempotently.

`fireWebhook` prefers the encrypted column and falls back to `cfg.secretRef`, so
the two can coexist while the backfill runs.

⚠️ **Rotation is required and is not something this change can do.** Every value
the script moves has been in clear in the database and in every backup taken
since the rule was created. Encrypting it in place does not undo that exposure.

## 4 — the dedupe was in the wrong place, not the wrong shape

The check ran at step 2.5: **before signature verification**, unscoped by tenant,
and matching `status: 'received'` as well as `'processed'`. Post-fail-closed that
made it the cheapest remaining attack — replay a body so the *genuine*
redelivery is dropped as a duplicate. `received` is worse than it looks: it
matches an event that was accepted and then failed, so a transient failure
poisoned every retry of the same delivery.

It now runs at step 6a, after verification, scoped by `tenantId`, matching
`status: 'processed'` only, and excluding the row's own id.

**A test pinned the old design** — "DEDUPE hit within window → ignored (no
persist, no provider dispatch)". It was replaced by two: one asserting the replay
*is* persisted, one asserting the query is tenant-scoped and processed-only. A
test asserting the vulnerability is not a reason to keep it.

## 5 — the edge `controlId` nobody checked

`ProcessMapRepository.replaceGraph` stamped `tenantId: ctx.tenantId` onto a
caller-supplied `controlId` that was never verified. The row's own `tenantId` is
correct, so **RLS does not help** — it is the *reference* that is foreign, and FK
checks bypass row security. The stored row then reads as though the tenant owns a
control it does not.

The check is hoisted above the edge loop into one `findMany`, not because it is
tidier but because a per-edge lookup is an N+1 that the query-shape ratchet
rejects — and that this change has already tripped twice. It carries a
`guardrail-allow: unbounded` pragma: the query is bounded by the caller's own
edge list, and a `take:` would silently truncate the owned set and reject
legitimate controls as foreign.

## Decisions

- **`slaBreachConfigJson` is now typed `NotifyUserConfig`, and the validation
  applies to writes only.** A stricter read-side schema would have made
  pre-existing rules with malformed config unlistable and unfixable — the
  strictness would have locked users out of the only surface that could repair
  them.

- **The dedupe fix is behaviour change for existing tenants.** A replayed body
  now persists an event row where it previously did not. That is the correct
  reading of "process each verified delivery once", but it is visible.

- **Item 2 produced no code and is still in the note.** The value of an audit
  round is partly in what it rules out.
