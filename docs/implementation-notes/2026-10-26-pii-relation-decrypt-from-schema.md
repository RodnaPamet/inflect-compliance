# 2026-10-26 — PII decryption follows every relation, read from the schema

**Commit:** see the pull request that adds this note (`fix(security): …`).

## Design

The PII middleware (`src/lib/security/pii-middleware.ts`) decrypts `User`,
`AuditorAccount`, `UserIdentityLink`, `VendorContact`, `NotificationOutbox` and
`Account` fields on read. A row of a managed model reached through a relation
(`accessReview.reviewer.email`) is decrypted by a walk over the result tree.

That walk recognised relations through `RELATION_KEY_TO_MODEL`, a hand-kept
table of nine relation NAMES matched at any depth. Measured against the schema
there are 34 relation fields into a managed model, and 29 of them were missing:

```
accounts, actor, applicabilityDecidedBy, approvedBy, auditorAccounts, closedBy,
completedBy, contacts, createdBy, decidedBy, deletedBy, executedBy, frozenBy,
grantedBy, handledBy, identityLinks, notificationOutbox, ownerUser, rejectedBy,
requestedBy, resolvedBy, reviewedBy, reviewer, riskAcceptedBy, sentBy,
subjectUser, target, uploadedBy, vendorContacts
```

Three of the nine names (`inviter`, `invitedByUser`, `creator`) are relations
nowhere in the schema. `identityLink` was mapped to `UserIdentityLink`, but the
only relation with that name, `ConnectedIdentityAccount.identityLink`, points at
`IdentityAccountLink`.

A read through a missing relation handed the caller ciphertext. The visible
effects were:

- the access-review reminder queued to a `v1:…` address, so it was undeliverable;
- the overdue escalation and the evidence PDFs printed the ciphertext;
- `user-combobox.tsx` had to hide ciphertext "observed on prod 2026-04-29".

The walk is now model-aware. `RELATION_TARGETS` is built once at module load from
`Prisma.dmmf.datamodel`: model → relation field → target model, for every
relation. `decryptTree(result, model)` decrypts the queried model's managed
fields and follows only that model's relation fields, each with its own target
model. A relation added to the schema is walked the day it exists.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/pii-middleware.ts` | `RELATION_TARGETS` from the DMMF; `decryptTree` / `decryptRecord` replace `RELATION_KEY_TO_MODEL` / `decryptNested` |
| `tests/unit/security/pii-middleware-every-relation.test.ts` | one case per relation into a managed model, population read from the DMMF |
| `tests/unit/security/pii-middleware-bulk-and-nested.test.ts` | `inviter` (not a relation) replaced by `invitedBy`; Json columns not walked; multi-hop walk |
| `tests/integration/pii-relation-decrypt.test.ts` | real client and database: the stored column is ciphertext, relation reads and the reminder's outbox address are plaintext |

## Decisions

- **Keyed by parent model and field, not by name.** A name can mean different
  things on different models, and it also matched keys that are not relations.
  The old walk descended into every object, Json columns included, so a Json
  payload carrying a `user` key would have had its contents "decrypted" on read.
  The new walk follows real relations only, so stored data is returned as stored.
- **Read from the DMMF at runtime, not generated into a file.**
  `src/lib/db/rls-middleware.ts` already reads `Prisma.dmmf` the same way, the
  module is server-only (imported by `src/lib/prisma.ts` alone), and a generated
  file would be one more artefact that can go stale beside its source.
- **The exhaustive test reads its population from the same DMMF.** It is not a
  second hand-kept list: a relation into a managed model added later is tested
  automatically, and the positive controls stop the population from being
  silently empty.
- **The depth backstop counts relation hops** (`MAX_RELATION_DEPTH`, 8), not
  object levels. The old cap of 4 levels counted arrays as levels too, so under
  a `findMany` it stopped decrypting three relations down.
- **The business-field encryption middleware is unaffected.**
  `src/lib/db/encryption-middleware.ts` walks every nested object and decrypts by
  manifest field name. It keeps no relation table, so it never had this gap.
- **Why it survived.** `access-review-reminder.test.ts` writes its users through
  a raw client with no PII extension, so the stored address is plaintext and the
  relation read looks correct. The new integration suite writes through
  `prismaTestClient()`, which encrypts as production does, and asserts that the
  stored column is ciphertext before it tests anything else.
