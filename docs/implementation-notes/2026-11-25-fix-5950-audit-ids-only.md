# 2026-11-25 — New audit rows name a person by id only (#5950)

**Commit:** see the `fix(audit): …` commits on `fix/fix-5950-audit-ids-only`.

## Design

Owner decision, 2026-11-25: new audit rows carry the person's user id and no
e-mail address or name, in `details` and `detailsJson` alike. A reader resolves
the id while the person exists; after an erasure only the id remains. Existing
rows keep what they hold.

Why: an audit row is immutable and hash-chained, so a DSAR erasure can move
`userId` to NULL and nothing else, and `detailsJson` streams to the tenant's
SIEM (Epic C.4), whose contract is an opaque user id.

```
writer  ──►  details / detailsJson: ids only
             (targetUserId, or entityId = the person's record,
              or the record holding the address for a person with no account)
                     │
reader  ──►  auditPersonRef(row) ──► AuditLogRepository.resolvePeople (one read per kind)
             Audit log page: "Person" column = name / address, or the bare id once gone
             Org audit page: invite rows resolve detailsJson.inviteId → OrgInvite.email
                     │
guard   ──►  local/no-person-identity-in-audit-payload (ESLint, src/**, no exemptions)
```

## The writers found, and what changed

Found by an AST scan of every `logEvent` / `appendAuditEntry` /
`appendAuditEntryWithin` / `appendAuditEntryOrQueue` / `appendOrgAuditEntry` /
`logAudit` / `buildAuditEntry` / `auditLog.create` call site under `src/`, of
every wrapper that forwards a parameter into one of their payloads, and then by
the lint rule itself over `src/`.

| Writer (file) | Action(s) | Carried | Now |
| --- | --- | --- | --- |
| `usecases/access-review.ts` | `ACCESS_REVIEW_DECISION_EXECUTED` | subject's e-mail in `detailsJson.summary` | summary names the decision and outcome; `targetUserId` (already there) names the subject |
| `usecases/tenant-admin.ts` | `MEMBER_ROLE_CHANGED` | member's e-mail in `details` | no address; `detailsJson.targetUserId` added |
| `usecases/tenant-admin.ts` | `MEMBER_DEACTIVATED`, `MEMBER_REMOVED` | member's e-mail in `details` | no address; `targetUserId` (since #5940) names them |
| `usecases/custom-roles.ts` (`logCustomRoleChange`) | `MEMBER_CUSTOM_ROLE_CHANGED` | member's e-mail in `details` | no address; `detailsJson.targetUserId` added |
| `usecases/audit-readiness/sharing.ts` | `AUDITOR_INVITED` / `AUDITOR_REACTIVATED`, `AUDITOR_ACCOUNT_REVOKED`, `AUDITOR_GRANTED` | auditor's e-mail in `details` and `detailsJson.detail` | no address; `targetUserId` (the auditor ACCOUNT id, the existing convention) names them |
| `usecases/tenant-invites.ts` | `MEMBER_INVITED`, `MEMBER_INVITE_REVOKED` | invitee's e-mail in `details`, `summary`, `after.email` | no address; the row names the INVITE (`entityId`, `after.inviteId`) |
| `usecases/org-invites.ts` | `ORG_INVITE_CREATED`, `ORG_INVITE_REVOKED` | invitee's e-mail in `detailsJson.email` | no address; `inviteId` (already there) names the invite |
| `usecases/tenant-lifecycle.ts` | `TENANT_CREATED` | `detailsJson.ownerEmail` | removed; `ownerUserId` (already there) names the owner |
| `usecases/scim-users.ts` (`emitScimAudit`) | `SCIM_USER_CREATED`, `_REACTIVATED`, `_UPDATED`, `_DEACTIVATED` | `email` (the SCIM `userName`), `displayName`, and in a PATCH's `changes` the new display, given and family name | no address or name; `entityId` is the user id; `changes` names the attribute (`displayName`, `givenName`, `familyName`, `name`) without its value |
| `usecases/personnel.ts` | `CREATE` / `UPDATE` on `Employee` | employee's full name in `details` and `summary`, work e-mail in `after` | no name or address; `entityId` is the employee record |
| `usecases/hris-sync.ts` | `UPDATE` on `Employee` (role change) | employee's full name in `details` and `summary` | no name; `entityId` is the employee record |
| `usecases/vendor-assessment-send.ts` | `VENDOR_ASSESSMENT_SENT`, `VENDOR_ASSESSMENT_RESENT` | respondent's e-mail in `details` and `after.respondentEmail` | no address; `entityId` is the assessment |

## Borderline cases, and how they were classified

- **An invitee before any account exists** (tenant and org invites): a person.
  There is no user id, so the row names the invite, which holds the address
  while it exists. Kept the invite id, as the brief suggested.
- **An employee record's name** (`Employee.fullName`, `workEmail`): a person,
  who may have no user account. The row names the employee record by
  `entityId`; the page resolves it while the record exists.
- **A SCIM `userName`**: the address the identity provider sends, so a person's
  e-mail. Removed; `entityId` is already the user id.
- **A vendor assessment's respondent**: a person at the vendor, with no account.
  Removed; the assessment id names them. The VENDOR's name stays: an
  organisation is not a person.
- **An external auditor** (`AuditorAccount`): a person. The rows already named
  the account by `targetUserId` (an auditor account id, not a user id; the
  reader resolves it against the auditor list).
- **The workspace's mail sender identity** (`NOTIFICATION_SETTINGS_UPDATED`:
  `defaultFromName`, `defaultFromEmail`, `complianceMailbox`): classified as
  CONFIGURATION, not a person record, like an organisation's name. Its values
  stay in the row, because who redirected the compliance mailbox to what is the
  forensic question that row answers. If the owner reads it as a person's
  address, the fix is to record those three fields by name only.
- **The auth rows' `identifierHash`** (`security-events.ts`): a truncated,
  unsalted SHA-256 of the address, not the address; every such row also carries
  `userId`. Left as it is. The rule does not read arguments of a hash function.
- **A legacy application's `accountKey`** (`legacy-reviewer-actions.ts`): an
  account identifier in the application's own namespace, sometimes a login
  name. Classified as an identifier, like a SCIM `externalId`, and left alone.
- **Names of things**: a control's, a vendor's, a campaign's, a tool's, a
  skill's name. Not people; untouched, and the rule does not report a bare
  `.name`.

## Readers

- **Audit log page** (`/admin/audit-log`): gains a "Person" column.
  `listAuditLogPage` reads each row's reference (`auditPersonRef`: the
  `targetUserId`; a SCIM row's user id; an `Employee`, `TenantInvite` or a
  vendor assessment send's own record) and resolves them in one bounded read
  per kind (`AuditLogRepository.resolvePeople`). A person who no longer exists
  shows as the bare id. The Details column now reads, for example, "Removed
  member" where it read "Removed member: alice@…"; the Person column carries
  who. Rows written before this change show both.
- **Org audit page**: the invite rows' summary read `detailsJson.email`. The
  read now resolves `detailsJson.inviteId` to the invite's address while the
  invite exists (`OrgAuditRow.invitee`); an old row falls back to the address it
  holds; neither gives a dash.
- **Not changed**: the dashboard's recent-activity feed already resolves the
  entity by id and shows no details text. `listAuditLogs` (the API) returns the
  stored rows. The SIEM stream carries ids, as C.4 always said.

## Files

| File | Role |
| --- | --- |
| `eslint-rules/rules/no-person-identity-in-audit-payload.js` | The guard |
| `eslint-rules/__tests__/no-person-identity-in-audit-payload.test.ts` | Its RuleTester cases |
| `eslint.config.mjs`, `eslint-rules/index.js` | Registration, `src/**`, `payloadArgs: { emitScimAudit: 3 }` |
| `src/lib/audit/audit-person.ts` | Which person a row is about, by id (pure) |
| `src/app-layer/repositories/AuditLogRepository.ts` | `entityId` in the page read; `resolvePeople` |
| `src/app-layer/usecases/auditLog.ts` | The page read returns `person` per row |
| `src/app/t/[tenantSlug]/(app)/admin/audit-log/*` | The Person column |
| `src/app-layer/usecases/org-audit.ts`, `src/app/org/[orgSlug]/(app)/audit/AuditLogTable.tsx` | Invite rows resolve the invitee |
| The twelve writers in the table above | Ids only |
| `docs/data-retention.md`, `docs/dsar.md`, `CLAUDE.md` | The rule, and that old rows keep what they hold |

## Decisions

- **An ESLint rule, not a source-scan guard.** The shape is syntactic. It reads
  the stored members of a writer's payload (`details`, `detailsJson`,
  `metadata`, `metadataJson`, `diffJson`), any `detailsJson` property wherever
  it is written (so a wrapper taking `{ detailsJson }` needs no entry), and a
  configured positional payload argument (`emitScimAudit`'s fourth). It follows
  an identifier one step to a `const` initialiser only when the payload uses
  the whole value; `auditor.id` or `after[f]` contributes one member, which is
  judged by its own name. Both narrowings were forced by the first full-tree
  run, which flagged `auditor.id` (the const was built from an upsert whose
  `create` held the address) and the notification settings' computed reads.
- **No exemption list.** After the writer changes the rule reports nothing in
  `src/`.
- **`MEMBER_ROLE_CHANGED` and `MEMBER_CUSTOM_ROLE_CHANGED` gained
  `targetUserId`.** They had no id for the member at all: the membership id in
  `entityId` stops naming anybody once the membership is deleted. They are not
  added to the DSAR reader's `TARGET_RECORD_ACTIONS`, which lists the END of a
  membership; under an unlisted action the key is ignored.
- **The summary of `ACCESS_REVIEW_DECISION_EXECUTED` does not interpolate the
  id either.** The page shows the person in its own column.

## Not changed, and why (owner question)

The `$allModels` audit extension in `src/lib/prisma.ts` writes a row for every
`update` / `upsert` in a tenant context, with `detailsJson.after` (and `before`,
when the prior row could be read) holding the VALUES of the changed columns,
redacted only by secret-shaped name. Plaintext person columns therefore reach
`detailsJson`: `Employee.fullName`, `givenName`, `familyName`, `legalName`,
`workEmail` on every HRIS sync upsert; `ConnectedIdentityAccount.email` and
`displayName` on every identity sync; `PreHire.fullName`,
`TrustCenterAccessRequest.requesterEmail`, `VendorContact.name`/`email`,
`LegacyAccount` names when updated. `User.email`/`name` reach it as
ciphertext. This writer is not a call site that names a person, so this change
does not touch it; the options are in the pull request's report.
