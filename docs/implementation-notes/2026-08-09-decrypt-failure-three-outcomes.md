# 2026-08-09 — The decrypt-failure catch splits three ways

**Commit:** `<pending>` fix(encryption): return null for a no-DEK-by-design read

## The problem

`decryptResultNode` had one catch for every way a decrypt could fail, and it
did the same thing in all of them: log a warn and leave the field as the raw
ciphertext.

Failing open on a read is right — a list page that 500s over one bad row is
its own outage. But "never throw" is not the same as "always hand back the
ciphertext", and the caller receives a `string` it cannot distinguish from
plaintext. A `v2:`-prefixed blob then flows on to every consumer of the row:
the UI, PDF exports, audit-pack share links, SDK readers. For a product
whose rows land in evidence artefacts, an unreadable blob rendered as if it
were content is worse than an absent value.

Three distinct situations were collapsed into that one branch, and they do
not deserve the same answer.

## The split

| Situation | Was | Now |
|---|---|---|
| No DEK **by design** — the `Tenant` model, no ambient `tenantId`, or a `BYPASS_SOURCES` caller | ciphertext | **`null`** |
| DEK lookup **threw** — tenantId present, lookup failed | ciphertext | ciphertext, labelled `dek_resolve_failed` |
| Decrypt failed **with** a DEK — AES-GCM rejected the value | ciphertext | ciphertext, labelled `decrypt_failed` |

The first two were previously indistinguishable at the source:
`resolveTenantDekPair` returned the same `NO_DEK_PAIR` constant for "no DEK
expected" and "the lookup blew up". `TenantDekPair` now carries a `reason`
(`resolved` / `by-design` / `resolve-failed`), and `decryptValue` throws a
typed `NoTenantDekError` carrying it — a class, not a message match, because
branching on `err.message` is the kind of coupling that survives a refactor
as a silent behaviour change.

## Why only the by-design case returns null

Callers on that path are cross-tenant by construction and have no business
reading tenant plaintext. `null` costs a sweep that only counts or deletes
rows nothing at all, and a sweep that genuinely needed the value has a bug
that now surfaces on the next line instead of shipping a ciphertext blob
into an export.

The other two are different: a `tenantId` WAS present, so there is a
legitimate reader waiting. Nulling every encrypted field on a page because
of a transient DB blip would be its own outage. They stay open — but they
are now *counted separately*, which is the point. The metric
`encryption.field.decrypt_failed` gained an `outcome` label, so a genuine
key mismatch no longer hides inside routine by-design noise.

## Decisions

- **The `null` is a deliberate type lie for eight fields.** Eight manifest
  fields are non-nullable in Prisma (`Finding.description`,
  `TaskComment.body`, `AuditChecklistItem.prompt`,
  `ControlException.justification`, `AgentProposal.payloadJson`,
  `Incident.description`, `IncidentTimelineEntry.entry`,
  `AuditPackShareComment.body`), so `null` contradicts their declared
  `string`. That is the intended outcome. For a field whose type promises a
  string, the honest representation of "this value could not be produced" is
  `null`, and a `TypeError` at the first read is strictly better than a blob
  that reads as a valid string all the way into a customer-facing export.

- **Case B is deliberately NOT flipped to throwing.** One corrupt row would
  500 a whole list page. The sequencing is: ship the by-design null (which
  strictly reduces exposure and cannot break a sweep that was not reading
  plaintext), watch `outcome="decrypt_failed"`, and flip once it is zero in
  steady state. If it is not zero, those are real anomalies worth fixing
  first — which is worth knowing whichever posture you land on.

- **Rejected — a typed sentinel.** Cleanest in theory, but the type layer
  declares these fields `string` across 100+ call sites. Either refactor all
  of them (each then has to decide what to render) or put a sentinel object
  where the types promise a string — an unmarked type lie that surfaces as
  `.toUpperCase is not a function` somewhere stranger than a 500.

- **Rejected — marking the value.** Keeps the `string` type, so the marked
  value still reaches the PDF exporter and the audit-pack share link. Trades
  an unreadable blob for a readable placeholder *inside an evidence
  artefact*. Better for the UI, no better for the contract that matters.

- **`BYPASS_SOURCES` is dead in production.** Nothing in `src/` sets
  `source` to `seed`, `job`, or `system`. So the by-design path is reached
  today only via the `Tenant` model or a missing ambient `tenantId` — which
  is what the context-less BullMQ jobs hit. Left in place as the documented
  contract for cross-tenant work.

## How this composes with the webhook-signing fix

The dispatchers that read `AutomationRule.webhookSecretEncrypted` without a
tenant context were fixed separately (see
`2026-08-09-automation-webhook-signing-key.md`). This change is the backstop
underneath it: if a dispatcher lost its wrapper again, `signingSecret` would
now be `null` and the webhook would go out **unsigned** rather than signed
with the ciphertext. Absent beats plausible-but-wrong. The integration test
for that fix asserts exactly this.
