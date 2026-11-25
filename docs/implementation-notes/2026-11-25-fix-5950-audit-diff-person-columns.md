# 2026-11-25 — The audit diff names person columns without values; the auth hash is keyed (#5950 part 2)

**Commit:** see the `fix(audit): …` commits on `fix/fix-5950-audit-diff-person-columns`.

## Design

Part 1 (`2026-11-25-fix-5950-audit-ids-only.md`) held every audit WRITER to ids
only, and left one writer for the owner: the `$allModels` audit extension in
`src/lib/prisma.ts`, which records the VALUES of the columns an update or upsert
changed. The owner decided, the same day:

1. The extension names a person column and never records its value.
2. The workspace sender settings keep their values: they are configuration.
3. The auth rows' `identifierHash` becomes the deployment's keyed lookup hash.

```
update / upsert in a tenant context
        │
buildDiffJson(action, data, result, priorState, model)
        │   encrypted (Epic B)  → undiffableFields, no value   (#5292)
        │   PERSON_COLUMNS      → changedFields + withheldFields, no value   (this)
        │   everything else     → changedFields, before / after values
        ▼
AuditLog.diffJson { changedFields, withheldFields?, after, before? }
AuditLog.detailsJson { changedFields, withheldFields?, after }  ──► SIEM (C.4)

src/lib/security/person-columns.ts
  PERSON_COLUMNS      Model → fields whose value is withheld
  NOT_PERSON_COLUMNS  "Model.field" → reason its value is kept
        ▲
tests/guardrails/audit-person-columns-classified.test.ts
  every String/Json column matching /mail|name/i is in exactly one list;
  no stale entries; every reason written
```

`hashEmailForLog` (`src/lib/auth/security-events.ts`) is now `hashForLookup`:
HMAC-SHA256 under `LOOKUP_HASH_KEY` (the master key's derivation while that is
unset), 64 hex characters, equal to `User.emailHash` for the same address. It
was the first 16 hex characters of an unsalted SHA-256.

## The columns classified

**Person (value withheld):**

| Model | Columns |
| --- | --- |
| `User` | `email`, `emailHash`, `name` |
| `AuditorAccount` | `email`, `emailHash`, `name` |
| `UserIdentityLink` | `emailAtLinkTime`, `emailAtLinkTimeHash` |
| `TenantInvite`, `OrgInvite` | `email` |
| `NotificationOutbox` | `toEmail`, `toEmailEncrypted` |
| `ConnectedIdentityAccount` | `email`, `displayName`, `mailNickname`, `samAccountName`, `userPrincipalName` |
| `Employee` | `fullName`, `givenName`, `familyName`, `middleName`, `preferredName`, `legalName`, `workEmail` |
| `PreHire` | `fullName` |
| `LegacyAccount` | `username`, `displayName`, `givenName`, `familyName`, `email` |
| `TrustCenterAccessRequest` | `requesterName`, `requesterEmail` |
| `VendorContact` | `name`, `nameEncrypted`, `email`, `emailEncrypted`, `emailHash`, `phone`, `phoneEncrypted` |
| `VendorAssessment` | `respondentEmail` |

**Not a person (value kept), each with its reason in the manifest:** the three
workspace sender settings (owner decision 2), `TenantIdentityProvider.emailDomains`,
and 64 columns that name a thing: organisations and workspaces, directory
groups, a third-party application, a device host name, agents, tools, models,
key and connection labels, compliance records, uploaded file names.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/person-columns.ts` | The manifest: person columns and not-person columns with reasons |
| `src/lib/prisma.ts` | `buildDiffJson` withholds a person column's value; the extension copies `withheldFields` into `detailsJson` |
| `src/lib/auth/security-events.ts` | `hashEmailForLog` is `hashForLookup` |
| `tests/guardrails/audit-person-columns-classified.test.ts` | The classification guard |
| `tests/integration/audit-diff-person-columns.test.ts` | An Employee update through the real extension |
| `tests/unit/audit-diff-withholds-person-columns.test.ts` | `buildDiffJson` cases: decrypted prior PII, an inserting upsert, an unmoved value, a per-model name |
| `tests/unit/security-events.test.ts` | A sign-in row's hash is the keyed one |
| `CLAUDE.md` (C.4), `docs/data-retention.md`, `docs/dsar.md`, `docs/auth.md` | The rule, and that old rows keep what they hold |

## Decisions

- **Named in `changedFields` AND listed in `withheldFields`.** A person column is
  plaintext at the comparison (except the PII-`@map`'d ones, below), so whether
  it moved is evidence, unlike an Epic B field, which the extension cannot
  compare and so lists only in `undiffableFields`. `withheldFields` is the
  explicit "value not recorded" so a reader does not mistake the missing value
  for a missing result.
- **"In any form": ciphertext and lookup-hash columns are person columns too.**
  The prior row is read through the decrypting client, so a PII column
  `@map`'d to its ciphertext (`User.email`, `User.name`, `AuditorAccount.*`,
  `UserIdentityLink.emailAtLinkTime`) reached `before` as PLAINTEXT — the
  #5292 defect for the PII middleware's columns, which `ENCRYPTED_FIELDS` does
  not list. A lookup hash is the address in another spelling for whoever holds
  the key.
- **The guard's population is a name pattern, `/mail|name/i`, over `String` and
  `Json` columns.** Broad on purpose: it asks about every bare `name`, because a
  `Contact.name` must not slip through for looking like a `Control.name`. It
  cannot see a person column named otherwise; `VendorContact.phone` is listed
  voluntarily, and the guard checks every listed column exists.
- **The manifest is per model.** `name` is a person on `User` and a thing on
  `Control`; a flat set of field names would withhold every control's name.
- **A login is a person column** (`LegacyAccount.username`,
  `ConnectedIdentityAccount.samAccountName`, `mailNickname`,
  `userPrincipalName`): it is usually built from the name, and a UPN is often
  the address. `LegacyAccount.accountKey` stays out, as part 1 classified it.
- **`identifierHash` is the full `hashForLookup`, not a prefix.** "The
  deployment's keyed lookup hash" is that value; a prefix would be a third
  hash. No reader matches rows on `identifierHash` — `git grep` finds only its
  writers (`security-events.ts`, the sign-in callback's and SCIM's log lines)
  and tests — so changing it moves no lookup. The log lines change with it, so
  a log line and a row still correlate. Rows and log lines written before keep
  the old value, and an old and a new value for one address do not compare
  equal: per-identifier counts across the change do not join.

## Not changed, and why

- **The PII-`@map`'d columns still always read as changed.** Their `data` is
  ciphertext and their prior value plaintext, so the comparison never matches;
  they are named in `changedFields` whenever a payload names them. Values are
  withheld either way. Moving them to `undiffableFields` would need the PII
  middleware's map exported; left as it is.
- **`Employee.employeeNumber` and other person identifiers that are neither a
  name nor an address** are not in the guard's population and are not listed.
- **Rows written before keep their values.** Every identity and HRIS sync
  before this change recorded names and work addresses, before and after. An
  audit row cannot be rewritten: the immutability trigger admits one UPDATE,
  `userId` → NULL with every other column unchanged, and the entry hash covers
  `detailsJson`.
