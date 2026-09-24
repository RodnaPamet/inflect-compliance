# 2026-09-24 — credential-named fields out of `configJson` (#2837)

## Design

`ConnectionConfigSchema` has two halves and they are two storage decisions, not
two ways of describing one bag:

| half | stored in | returned by the API |
| --- | --- | --- |
| `secretFields` | `secretEncrypted` (AES-256-GCM, Epic B) | never |
| `configFields` | `configJson` (plain Json column) | yes, by `GET /admin/integrations` |

`CONFIG_FIELD_RULES` in `src/app-layer/integrations/config-schema.ts` is the
accept-list for the second half: a key with a rule is admitted into
`configJson` by `validateProviderConfig`, and a key without one is a 400.

Ten keys that providers declare in `secretFields` also carried a rule there, so
`validateProviderConfig` would have accepted a bind password, an API token or an
OAuth client secret into the unencrypted column — under a response payload that
advertises `secretStatus: '••••••••'`, a mask describing the *other* bag. The
guard PR (#2845) pinned them as a baseline that may only shrink; this shrinks it
to zero.

Two halves shipped together, because the accept-list is only the write side:

1. **Write.** All ten rules removed, plus `sharepoint.accessToken` — the same
   defect on the one provider the guard's cross-walk cannot see, since SharePoint
   is not a registry provider and so declares no `secretFields` to compare
   against.
2. **Read.** The admin GET spread the whole row (`...c`). It now projects an
   explicit, independently written field list, so a column added to the usecase's
   `select` cannot reach a client as a side effect of widening a read.

## Files

| file | role |
| --- | --- |
| `src/app-layer/integrations/config-schema.ts` | 11 rules removed; docblock states why a `secretFields` key may never carry one |
| `src/app/api/t/[tenantSlug]/admin/integrations/route.ts` | `CONNECTION_RESPONSE_FIELDS` projection replaces the row spread |
| `tests/guards/config-field-classification.test.ts` | baseline emptied; the secret-vs-config axis gained a denominator |
| `tests/unit/provider-config-validation.test.ts` | one refusal per provider + a config-still-saves positive control |
| `tests/unit/integrations-connection-response-projection.test.ts` | new — the projection drops a column the read grew |

## Decisions

- **Nothing kept, `bindDN` included.** It is a distinguished name rather than a
  password, so it was the one plausible candidate for a legitimate config use.
  It has none: the AD provider's `validateConnection` reads `secrets.bindDN`
  exclusively, `identity-sync` hands `listAccounts` the merged
  `{ ...configJson, ...decryptedSecrets }` bag where the secret wins, and the
  single `config.bindDN` read — `describeWriteReadiness` in
  `identity-write-readiness.ts` — is already unreachable: it is `||`'d with
  `merged.bindDN`, which is a superset, and the `merged === null` arm returns
  `UNKNOWN` before that line. Two comments in that subsystem still assert
  "`bindDN` is config"; they were stale before this change and are stale by the
  same amount after it. Left for a diff that can test the readiness surface.
- **The projection is a SECOND list on purpose.** Deriving it from the usecase's
  Prisma `select` would give zero protection — the point is that a widened read
  has to be widened twice, once in a file whose name says "response". It changes
  nothing on the wire today, which is the intended state for a fence.
- **`configJson` stays in the projection.** `handleEdit` in the admin page
  repopulates the form from `conn.configJson`; dropping it would blank every
  config field on edit. `authFailedAt` / `authFailureReason` stay too — three
  provider modules name this endpoint as where an operator reads that reason.
- **`hris.*` left alone.** Those rules are keyed by directory name while
  BambooHR's provider id is `bamboohr`, so they never execute; changing which
  ids the table covers is a write-boundary change of its own, as the module
  docblock already says.
- **The guard's fourth axis gained a denominator.** With the baseline at `[]` the
  assertion reduces to `found === []`, which a cross-walk that compared nothing
  would satisfy just as well. It now also asserts it compared >20 rule keys
  against >5 declared secret fields — proved by blinding `declaredFields()` to
  `secretFields`, which leaves `found` empty and reddens only the denominator.
