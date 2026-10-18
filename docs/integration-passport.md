# The integration passport

An integration passport is one record per external connection that states what
the connection lets an agent do: how it authenticates, which tools on it a person
has accepted, which agents may reach them, how far a write may go, and who is
accountable. This document specifies it, and step 2d (#3672) built it: the weekly
`integration-passport-sweep` assembles each passport from rows the product
already stores, compares it with the last one emitted, raises a finding with a
named owner for each difference the rules below call drift, and emits the week's
passports as Evidence. An OWNER reads one connection's passport, live, on that
connection's page under the integrations admin page. See
[`docs/agentic-iam-roadmap.md`](agentic-iam-roadmap.md), UC5.

The code is `src/lib/agentic/integration-passport.ts` (the builder, the canonical
bundle and the evidence body), `src/lib/agentic/integration-passport-drift.ts`
(the drift rules and who owns each finding),
`src/app-layer/usecases/integration-passport.ts` (the reads, the sweep's write
transaction, the view and the owner setter) and
`src/app-layer/jobs/integration-passport-sweep.ts` (the job).

The owner's merge of the pull request that adds this document is the owner's
sign-off on it. The security owner's review is a separate act that the merge
does not supply; it is recorded on #3662 when given.

## Which connections have a passport

Every `IntegrationConnection` whose `provider` is `mcp-server`
(`MCP_SERVER_PROVIDER_ID` in
`src/app-layer/integrations/providers/mcp-server-provider.ts`), enabled or not.

That provider is the only path by which an agent reaches a system outside the
platform. Its tools enter the funnel under the qualified name
`mcp__<connectionId>__<tool>` (`externalToolName` in
`src/lib/mcp/external-tool-name.ts`), and every per-tool row below is found by
that prefix, the way `listExternalMcpTools` in
`src/app-layer/usecases/external-mcp-tools.ts` finds a connection's pins. The
builder matches the whole prefix, trailing `__` included, so the rows of a
connection `ck12` never enter the passport of a connection `ck1`.

**This narrows step 2d's stated scope.** The 2d issue states its goal as "every
external connection". This specification limits the population to `mcp-server`
connections, and 2d's goal and acceptance test are read with the same
population. The other providers are out of scope for this reason: they are
driven by scheduled jobs rather than by agents, no agent holds a grant, a pin, a
pairing or a parameter set on them, and the directory writes among them are
governed by the identity ladder in `src/lib/identity/write-ladder.ts`, not by the
external write ladder this passport reports on.

A disabled connection keeps its passport. The product disables a connection
rather than deleting it (`removeIntegrationConnection` in
`src/app-layer/usecases/integrations.ts` sets `isEnabled = false`), and a
disabled connection keeps its pins, grants and rung, so it can be re-enabled
with all of them in force.

A passport is keyed by `IntegrationConnection.id`. The connection's `name` is
carried for readability. Renaming a connection changes no grant, pin, parameter
set or pairing, because each of those is keyed by the id inside the qualified
tool name.

## How a passport is built

- **From stored rows only.** The builder does not call the server, mint a token
  or run `tools/list`. A definition the server changed since a person approved
  it is caught by the funnel, not by the passport: the runtime offers an
  external tool only when its live definition verifies as `APPROVED` against its
  pin, and `resolveGrantedExternalTools` in
  `src/app-layer/usecases/external-mcp-tools.ts` drops the tool for every other
  verdict. That includes a move in the annotations alone: the tool boundary
  (`assertToolManifestPinned` in `src/lib/mcp/authorize.ts`) records that
  verdict as a security event without refusing it, so the refusal for an
  external tool is the resolver's. The passport records what was accepted and
  by whom; the funnel enforces it on every run.
- **One secret read, kind only.** The grant kind (field P3) depends on which
  credential fields a connection holds, and some of them live in the encrypted
  `IntegrationConnection.secretEncrypted`. The sweep decrypts each connection's
  secret once and the builder resolves the kind with the same resolver the
  runtime and the Test button use, `resolveMcpCredentials` in
  `src/app-layer/integrations/mcp/token.ts`, keeping only the kind. No secret
  value, and no hash of one, enters a passport. A secret that does not decrypt
  is reported as grant kind `invalid`, with a warning that names the connection
  and nothing about the value: the runtime could not mint a token from it
  either.
- **Canonical and comparable.** A passport is serialised as canonical JSON
  (`src/lib/canonical-json.ts`) and carries a SHA-256 digest of that
  serialisation. Every timestamp is an ISO string before the digest is taken,
  because `canonicalJson` serialises a `Date` as `{}`, and every list is sorted
  by code unit, because the database's row order is not a fact about a
  connection. Two weeks are compared by digest first and field by field only
  when the digests differ.
- **Derived, not stored as a table of its own.** The week's passports are
  emitted as Evidence through the agentic emission path
  (`src/lib/agentic/evidence-artefact.ts`,
  `src/app-layer/usecases/agentic-evidence-emission.ts`), as artefact kind
  `INTEGRATION_PASSPORTS` over the ISO week (Monday 00:00 UTC to the next
  Monday, labelled `2026-W42`). One artefact per target control per week
  bundles every `mcp-server` connection of the tenant, because an artefact's
  identity is `(tenant, control, kind, period)` and has no connection
  dimension. The Evidence body is a summary line per connection, the bundle's
  digest, a redaction contract, and the canonical bundle itself between
  `-----BEGIN INTEGRATION PASSPORT BUNDLE-----` and
  `-----END INTEGRATION PASSPORT BUNDLE-----`, with `<`, `>`, `&`, U+2028 and
  U+2029 written as JSON escapes so that no HTML-active byte reaches the body
  and every value survives exactly. The artefact's `sourceDigest` is the SHA-256
  of that embedded text. A bundle over 1,000,000 bytes is not emitted.

### Where last week's passport comes from

The previous passport is the newest `INTEGRATION_PASSPORTS` artefact whose
period starts **strictly before** this week, read out of its `Evidence.content`
and verified against the artefact's `sourceDigest`. Verification checks, in
order: the bundle block is present, its SHA-256 equals `sourceDigest`, it is
canonical, its format tag is `inflect-integration-passport/1`, its period is the
artefact's, and every passport's digest recomputes. Every artefact of one week
holds the same bundle, so the first copy that verifies is the prior.

- The emitted artefact is the only stored thing that can answer added, removed
  or changed field by field. Findings record only differences, so they cannot
  reconstruct a passport.
- `IntegrationExecution.resultJson` is purged by retention and has no unique
  key, so next week could neither rely on it nor find it.
- `Evidence.content` is user-editable and `sourceDigest` has no route writer, so
  verifying one against the other turns an editable body into a tamper-evident
  one. A prior whose every copy fails is never a silent baseline: it raises the
  HIGH finding `PASSPORT_PRIOR_UNVERIFIABLE` and only then is every connection
  treated as a first passport. A withdrawn artefact fails too, because
  withdrawal replaces the body with a notice.
- "Strictly before" makes a re-run inside the same week compare against the
  same prior, so the comparison is a function of last week and now, which is
  what makes the sweep idempotent per week.

The cost of that choice: a tenant with no target control emits nothing and so
never has a prior. Its drift is not compared, and the sweep says so with the
finding `PASSPORT_NOT_EVIDENCED` (reason `NO_TARGET_CONTROL`) rather than
looking quiet.

### Who reads a passport

The emitted passport is Evidence, and Evidence is read under `assertCanRead`:
every role holding evidence read, READER, EDITOR and AUDITOR as well as ADMIN
and OWNER, and anyone holding the share link of an audit pack that includes
it. That is by design, because evidence exists to be read by whoever
assesses the control, and the findings raised from a passport are readable as
widely. So a passport carries only what may be read that widely: identifiers,
rung names, hashes and the endpoint's origin. The endpoint is the one field
where that is a choice rather than a given: a URL can carry a credential in its
path or query (`https://mcp.vendor.com/s/<key>/mcp`), and `configJson.url` is
otherwise read only under `admin.manage`, so the passport holds the origin and
a keyed digest of the URL, never the URL (P1).

The view below is OWNER-only because it sits beside the surfaces that change
what it reports, not because it holds anything the evidence does not.

### Where the passports are evidenced

Six requirements receive the week's artefact, each where the tenant has a
control mapped to it:

| Framework | Requirement | What the passport evidences |
|---|---|---|
| OWASP Agentic AI Top 10 | `ASI04` Agentic Supply Chain | which third-party tool definitions a named person accepted, by hash and revision |
| OWASP Agentic AI Top 10 | `ASI03` Identity and Privilege Abuse | grant kind, token audience, granted agents, write rung, owner |
| ISO/IEC 27001 | `A.5.19` Supplier relationships | what each connection to a supplier permits, with an owner |
| ISO/IEC 27001 | `A.5.15` Access control | the rule set an agent's access to a third party runs under |
| SOC 2 | `CC9.1` Vendor risk | each third-party system agents reach and who answers for it |
| SOC 2 | `CC6.1` Logical access security | credential class, audience, grants and write authority |

ISO requirements resolve through both spellings of their Annex A codes
(`requirementCodeSpellings`), so a catalogue that seeds `5.19` and a library
that installs `A.5.19` both receive it. SOC 2 has one sub-code per criterion in
this catalogue, so there is no `CC9.2`. The daily withdrawal pass judges a
passport artefact like any other: one whose control is no longer mapped is
withdrawn as `OBLIGATION_UNMAPPED`, labelled with its ISO week, and next week's
sweep reports the prior as unverifiable unless another copy survives.

## The sweep

`integration-passport-sweep` runs weekly, Sunday 05:45 UTC
(`src/app-layer/jobs/schedules.ts` states why that slot): the ISO week ends on
Sunday, so the run lands on the last day of the week it evidences, 45 minutes
before the daily 06:30 `agentic-evidence-emission` whose withdrawal pass then
judges the new artefacts the same morning.

- **Which tenants.** Those holding an `mcp-server` connection, plus those
  holding a passport artefact from the last five weeks. The second population
  is what lets rule 4 fire for a tenant whose last connection disappeared. Both
  are drained, never capped.
- **One tenant's pass.** One read transaction loads every connection and every
  per-tool row of the tenant (one bounded read per table, each read as cap plus
  one: 200 connections, 5,000 rows per table), the owners' memberships, the
  target controls, the prior and the audit entries since it. The passports are
  built and the findings planned outside any transaction. One write
  transaction, under a tenant lock namespaced `integration-passport:<tenantId>`
  so it never queues behind the audit chain's own lock, emits the week's
  artefacts, reconciles the findings raised against them and moves every open
  finding about a connection to its accountable owner (rule 3), so the week's
  passport and its findings land together or not at all. The audit rows for the
  findings and one `INTEGRATION_PASSPORT_SWEPT` row are written after that
  transaction commits.
- **A truncated read** (any read at its cap) compares nothing, emits nothing and
  closes nothing, because a row past the cap would read as removed and a
  connection past it as vanished. It raises `PASSPORT_NOT_EVIDENCED` (reason
  `POPULATION_TRUNCATED`) and the state findings of the rows it did read (no
  accountable owner, never tested, a `BASELINE` pin, a pin with a null
  `annotationsHash`, an unrecognised rung). Each of those is a condition
  observed on a row that was read, true whatever lies past the cap, so a tenant
  over a cap still has its absences raised rather than skipped.
- **Idempotent per ISO week**, durably rather than by a job id: the comparison
  is a function of the newest prior strictly before this week; the artefact
  identity is a unique index, so a re-run updates in place; state finding keys
  carry no week and event keys carry it, so a re-run finds the rows it would
  create; the tenant lock serialises overlapping passes; and findings and
  artefacts share one transaction. The job runs with one attempt, so a
  systematic failure surfaces once and next Sunday is the retry.
- **A week is named, the rows are read now.** The payload's `asOf` names the
  ISO week; the passports are built from the rows as they are when the pass
  runs. So the job refuses a week that has not begun, and a pass for a week
  earlier than one the tenant already holds passports for is refused (`409`,
  under the tenant lock, before anything is written): rebuilt from today's
  rows, that week's evidence would state what was not true that week, and its
  comparison against the week before it would raise later weeks' changes again
  under its key. A late pass for a week that no later week has superseded, such
  as a retry of a tenant that failed, evidences that week with the rows as
  stored when it runs.
- **Every tenant ends in a counted outcome** on the metric
  `agentic.integration_passport.sweep`: `COMPARED`, `BASELINE`,
  `PRIOR_UNVERIFIABLE`, `NOT_EVIDENCED`, `TRUNCATED` and `NO_CONNECTIONS` from
  the pass, `NO_ACTOR` and `FAILED` from the job, and `SWEPT_NOBODY` once when
  discovery finds no tenant at all.

## The view

`GET /api/t/{slug}/admin/integration-passport/{connectionId}` returns one
connection's passport built live from the same rows the sweep reads, what the
last emission said (its week, whether it verified, whether this connection's
passport is unchanged since), the events the next sweep would raise against it
(a preview: nothing is written), the pinned tools that declare a write with and
without a prior-state pairing, the pins whose declaration was not recorded, and
the connection's passport findings that are not closed. It is
`admin.tenant_lifecycle`, OWNER-only, because it is placed with the surfaces
that change what it reports: the write rung (P8) and the prior-state pairings
(P9) are changed only under that key, and the OWNER role holds every finding on
a connection that has no owner. That is a placement, not a confidentiality
boundary: the same passport is the week's Evidence, read as stated in
[Who reads a passport](#who-reads-a-passport). It is a sibling of
`admin/integrations/` because route-permission matching is first-match-wins and
that prefix resolves to `admin.manage`. Any connection that is not `mcp-server`
is a 404.

The connection's page under the integrations admin page renders it as the
integration passport card, mounted only for an OWNER, beside a connection owner
card for anybody holding `admin.manage`. Both cards render nothing for a
connection of any other provider.

## The fields

The Source column is true on `main`. The Drift rule column states what the sweep
raises, by finding code.

"Owner" in the last column means the connection's accountable owner, field P11.
**While a connection has no accountable owner, every finding on it is owned by
the tenant's OWNER role** (the holders of `admin.tenant_lifecycle`), carries no
assignee, and names the role in its description, beside the
`CONNECTION_OWNER_MISSING` finding for the same connection.

| # | Field | Source on `main` | Drift rule | Finding owner |
|---|---|---|---|---|
| P1 | Endpoint | `IntegrationConnection.configJson.url`, trimmed; empty reads as none. Carried as its `origin` (scheme, host and port; none when the value is not an absolute http(s) URL) and `urlDigest`, the `keyedChangeDigest` (`src/lib/security/encryption.ts`, HMAC-SHA256 under the deployment's lookup key) of the whole URL. The URL itself is never carried: its path or query can hold a credential, and a passport is read by every evidence reader. Nobody without the deployment key can test a guess against the digest, and rotating the master key re-keys it. | Any change, of the origin or of the digest, is `ENDPOINT_CHANGED`, **HIGH**; the finding names origins and digests, never a path or query. The stored credential is presented to whatever this field names. For a connection that holds a stored secret, an update that changes it without re-supplying the credential is refused by `redirectsStoredCredential` (`src/app-layer/integrations/config-schema.ts`; the refusal in `upsertIntegrationConnection`, `src/app-layer/usecases/integrations.ts`, runs only when the existing row has a `secretEncrypted`), so a change there means somebody also supplied a credential. For a connection with no stored secret, such as one of grant kind `none`, nothing refuses the change and the endpoint can move freely. | Owner |
| P2 | Enabled | `IntegrationConnection.isEnabled` | `false` to `true` is `CONNECTION_REENABLED`, **MEDIUM**: reach is restored. `true` to `false` is `CONNECTION_DISABLED`, **LOW**. | Owner |
| P3 | Grant kind | Derived, not stored: `resolveMcpCredentials(configJson, secrets)` over `configJson.tenantId`, `configJson.clientId`, `configJson.scope` and the decrypted `secretEncrypted` keys `clientSecret`, `refreshToken` and `authorization`. Values: `delegated` (`McpCredentials.kind`; a refresh token is present, so every token carries a named person's privileges); `app-only` (`McpCredentials.kind`; client secret and scope, no refresh token, so no person bounds the token); `static-header` (the resolver returns null and `authorization` is set; the grant behind a pasted value cannot be known); `none` (nothing set); `invalid` (the resolver throws because the configuration is partial, or the secret does not decrypt). A row holding OAuth fields beside a static header resolves as the runtime does: to its OAuth kind when the OAuth configuration is complete, and to `invalid` when it is partial. | Any change of kind is `GRANT_KIND_CHANGED`. **HIGH** when the change leaves `delegated`, because the ceiling of a named person is removed; `token.ts` keeps the two grants a required discriminant for this reason. **MEDIUM** otherwise, including any change to `invalid`. | Owner |
| P4 | Scope | `IntegrationConnection.configJson.scope`, trimmed, reported as `stored`; the scope a token is minted with is `effective`. For a `delegated` grant with no stored scope, the effective scope is `ENTRA_MCP_SCOPE` (`src/app-layer/integrations/mcp/token.ts`), recorded with `defaulted: true`. For `static-header`, `none` and `invalid` the stored value is reported and the effective scope is none, because no token is minted with it. | A change in the effective scope is `EFFECTIVE_SCOPE_CHANGED`, **MEDIUM**. | Owner |
| P5 | Audience | Derived from P4's effective scope: each space-separated entry except `offline_access`, with a trailing `/.default` removed, deduplicated and sorted. With no effective scope the audience is `unknown`: the product never decodes a pasted token. | Any change is `AUDIENCE_CHANGED`, **HIGH**. `config-schema.ts` classifies `scope` as `inert` because a token minted for the wrong audience fails at the intended server. The other direction is not inert: the token is minted for the new resource and presented to the same endpoint (P1), which then holds a token it can present to that resource. A scope change can be saved without re-supplying the secret. | Owner |
| P6 | Pinned tools | `McpToolManifestPin` rows whose `toolName` starts with `mcp__<connectionId>__`: the four hashes `src/lib/mcp/tool-manifest.ts` defines (`descriptionHash`, `schemaHash`, `manifestHash` and `annotationsHash`), plus `revision`, `approvalSource`, `approvedByUserId`, `approvedAt`, `previousManifestHash` and `declaresWrite`. `declaresWrite` is written by `writeToolManifestPin` (`src/app-layer/usecases/mcp-tool-manifest.ts`) when `approveExternalToolManifest` accepts a definition, from the same catalogue read the hashes came from; it is null on a `BASELINE` pin, on a built-in's pin, and on a pin approved before the column existed. | One finding per tool: `PIN_ADDED`, `PIN_REMOVED`, or `PIN_CHANGED` when its `revision` or any of its hashes moved (a hash that moved without a revision is a write from outside the product). It names which hashes changed, the approver and the replaced `previousManifestHash`, and calls out a definition redeclared read-only. **HIGH** when `descriptionHash` moved, because the description is instruction text the model reads. **HIGH** when `annotationsHash` moved, because the annotations carry `readOnlyHint`, and the live hint decides whether a call takes the external write path at all (`declaresWrite` in `src/lib/mcp/tool-write-classification.ts`, read in `src/lib/mcp/tools/external-tools.ts`): a re-approval that redeclares a write tool as read-only takes it off the ladder. **MEDIUM** otherwise. A pin on this connection with `approvalSource = 'BASELINE'` is `PIN_BASELINE`, **HIGH**: external pins are written as `APPROVED` with a named approver by `approveExternalToolManifest`, so a baseline here is a definition nobody accepted. Approving that same definition records the acceptance: `writeToolManifestPin` turns a `BASELINE` pin whose hashes match into an `APPROVED` revision. A pin on this connection with a null `annotationsHash` is `PIN_ANNOTATIONS_UNATTESTED`, **HIGH**: `verifyToolManifest` compares annotations only when the pin holds that hash, so the server can flip `readOnlyHint` on the tool and the runtime still offers it as `APPROVED`. Re-approving the tool writes the hash. | Owner |
| P7 | Granted agents | `RegisteredAgentTool` rows whose `toolName` starts with `mcp__<connectionId>__`: `agentId`, `toolName`, `grantedByUserId`, `createdAt`. | A new grant is `GRANT_ADDED`, **MEDIUM**: another agent can reach the third party. A grant revoked and made again carries a new `createdAt` and counts as added. A removed grant is `GRANT_REMOVED`, **LOW**. | Owner |
| P8 | Write rung | `IntegrationConnection.externalWriteMode`, read through `coerceStoredMode`, and `externalWriteModeSince` (`src/lib/integrations/external-write-ladder.ts`). A stored value that is not a rung of `LADDER` is reported beside the coerced rung. | A widening is `WRITE_RUNG_WIDENED`, **HIGH**. A narrowing is `WRITE_RUNG_NARROWED`, **LOW**. The comparison is ordinal over `LADDER`. A stored value `coerceStoredMode` had to translate is `WRITE_RUNG_UNRECOGNISED`, **MEDIUM**: it reads as `DISABLED` and fails closed, but something wrote a rung this build does not know. Each move is audited as `EXTERNAL_WRITE_MODE_CHANGED`, and the finding cites that entry. | Owner |
| P9 | Prior-state pairings | `ExternalToolPriorStateRead` rows whose `writeToolName` starts with `mcp__<connectionId>__`: `writeToolName`, `readToolName`, `approvedByUserId`, `updatedAt`. | A pairing added, removed, or pointed at a different read is `PAIRING_ADDED`, `PAIRING_REMOVED` or `PAIRING_REPOINTED`, **MEDIUM**. The pairing decides what is read from the customer's system before it is changed. Setting a pairing is audited as `EXTERNAL_PRIOR_STATE_READ_SET` and clearing one as `EXTERNAL_PRIOR_STATE_READ_CLEARED`. | Owner |
| P10 | Parameter sets | `ExternalToolParameterSet` rows whose `toolName` starts with `mcp__<connectionId>__`: `label`, `revision`, `parametersHash`, `approvalSource`, `approvedByUserId`, `targetPopulation`, and whether `pendingHash` is set. The parameters themselves are never read. | A set added, removed, or whose `revision` moved is `PARAMETER_SET_ADDED`, `PARAMETER_SET_REMOVED` or `PARAMETER_SET_REVISED`, **MEDIUM**. A changed `targetPopulation` is `PARAMETER_SET_TARGET_CHANGED`, **HIGH**: it changes which rows an `AUTOMATIC` write may be about. A pending edit is reported and is not drift; it is not in force until four eyes promote it. | Owner |
| P11 | Owner | `IntegrationConnection.ownerUserId`, set by `PUT /api/t/{slug}/admin/integrations/{connectionId}/owner` (`setIntegrationConnectionOwner`) under `admin.manage`, the connection-write permission. The owner must hold an ACTIVE membership of the tenant; `null` clears it; each change is audited as `INTEGRATION_CONNECTION_OWNER_SET`. The owner is accountable only while that membership stays ACTIVE. Deleting the user sets the column to null. | No accountable owner is `CONNECTION_OWNER_MISSING`, **HIGH**, raised rather than skipped: the named owner may be absent or may hold no ACTIVE membership. A changed owner is `OWNER_CHANGED`, **MEDIUM**. | No owner: the tenant's OWNER role, the holders of `admin.tenant_lifecycle`, who already set every connection's rung and pairings. Changed owner: the new owner. |
| P12 | Last validated | `IntegrationConnection.lastTestedAt` and `lastTestStatus`, written as `ok` or `error` by `testConnectionCredentials` through `updateConnectionTestStatus` (`src/app-layer/usecases/integrations.ts`). `testConnectionCredentials` saves its verdict even when the request supplied a configuration that was never saved, so `ok` can describe a configuration that is not the stored one. | `ok` to `error` is `CONNECTION_TEST_FAILED`, **MEDIUM**. A connection never tested (`lastTestedAt` null) is `CONNECTION_NEVER_TESTED`, **LOW**. Age alone is reported and is not drift: the columns move only when a person presses Test, so a connection in daily use and one nobody touches age alike. The Test button writes no audit entry, so this finding cites none. | Owner |

`authFailedAt` and `authFailureReason` are not passport fields. They are written
only by `markAuthFailure` callers (the identity, HRIS, cloud-posture and
legacy-access syncs), and no `mcp-server` path calls it.

Not drift, though each moves the passport's digest and so the week's artefact: a
connection's name; `externalWriteModeSince`; a pairing's `approvedByUserId` or
`updatedAt`; a pin's `approvedAt` with no revision or hash moved; a parameter
set's pending edit; and the age in P12.

## The two facts that had no source

The specification listed two gaps. Step 2d closed both.

| Gap | Why it had no source | How it is closed |
|---|---|---|
| Owner (P11) | `IntegrationConnection` had no owner column, and the audit trail records who created a connection, not who answers for it. | `IntegrationConnection.ownerUserId`, named on the connection owner card under `admin.manage`. Every connection starts unowned, so the first sweep raises `CONNECTION_OWNER_MISSING` for each until somebody is named. |
| Write declaration per pinned tool | The pin stored `annotationsHash`, not the `readOnlyHint` it covers. `declaresWrite` (`src/lib/mcp/tool-write-classification.ts`) needs the live annotations, so a passport built from stored rows could not list the pinned tools that declare a write or the write tools that lack a pairing. | `McpToolManifestPin.declaresWrite`, stored when a person accepts an external definition. The passport carries it per pin (P6). The evidence summary counts, and the view lists, the tools that declare a write, those of them with no prior-state pairing, and the pins whose declaration was not recorded. A write tool with no pairing is reported, not raised: dispatch already refuses such a write, and no rule here defines a finding for it. |

## Rules the sweep applies to every field

1. **Week on week.** A passport is compared with the last one emitted, the
   newest strictly before this week, and only when that one verifies. A
   connection's first passport is its baseline: it raises the absence findings
   (no owner, never tested, a `BASELINE` pin, a pin with a null
   `annotationsHash`) and no "added" findings. A connection that is new since
   the last emission is a baseline too.
2. **One finding per condition.** Each finding is a `Finding` with `sourceKind`
   `INTEGRATION_PASSPORT` and a `sourceRef` that begins with the connection, the
   field and the rule (`<connectionId>:P11:OWNER_MISSING`), which the index
   `[tenantId, sourceKind, sourceRef]` serves. A week that finds a condition
   already covered by a finding that is not closed adds nothing, so the sweep is
   idempotent. Two kinds of finding share that key space:
   - A **state** finding (the absence findings, `WRITE_RUNG_UNRECOGNISED` and
     `PASSPORT_NOT_EVIDENCED`) is a condition of this week's passport. Its key
     carries no week. It reopens when the condition returns after somebody
     closed it, and the sweep closes it only on positive evidence: the subject
     is present and the condition is observed false. Absence closes nothing: a
     removed pin's `PIN_BASELINE` stays open beside its `PIN_REMOVED`.
   - An **event** finding (every change between two weeks) carries the ISO
     week in its key (`<connectionId>:P3:GRANT_KIND_CHANGED@2026-W42`). With the
     connection, field and rule alone, a second change to one connection while
     the first finding is still open would be folded into it, and a re-run in
     the same week after somebody closed the finding could only reopen a triaged
     event or stay silent for good. The sweep never closes or reopens an event
     finding. Events are raised only by a pass that also emits the passport they
     were found against, in the same transaction; a pass that raised events
     without emitting would leave the same prior in place and raise them again
     next week.
3. **A finding is a `Finding` row** with `assigneeUserId` set to the owner named
   in the table and `severity` as stated (`FindingSeverity`). Where the table
   names the connection's owner and the connection has no accountable owner,
   the owner is the tenant's OWNER role, as stated above the table. A finding
   owned by the tenant's OWNER role carries no assignee and names the role in
   its description. "The OWNER role" and "the holders of
   `admin.tenant_lifecycle`" are the same people for the built-in roles; a
   custom role can separate them, which changes nothing here because such a
   finding carries no assignee. The rule holds for as long as a finding is
   open: each sweep moves every open finding about a connection, state and
   event alike, to the connection's current accountable owner, or to the OWNER
   role while it has none. So the first week's findings, raised while every
   connection is unowned, reach the owner once one is named, and a departed
   owner's findings return to the OWNER role. Only the ownership sentence at
   the end of the description is rewritten, and each move is audited. A
   passport finding reassigned by hand is moved back at the next sweep: a
   connection's findings are handed to somebody by naming them its owner. A
   finding is linked to the week's passport Evidence through `FindingEvidence`.
4. **A vanished connection is a finding.** A connection present in last week's
   verified passports and absent this week was removed outside the product's
   own paths, because the product disables and never deletes an `mcp-server`
   connection. `CONNECTION_VANISHED`, **HIGH**, owned by the tenant's OWNER
   role, keyed `<connectionId>:VANISHED` with no week, because an id vanishes
   once.
5. **Findings carry identifiers, not content.** A finding names fields, hashes,
   rung names, ids and the audit entries for the change in the window since the
   last emission: up to ten entries by id, action, actor and time, a note when
   the window was larger than the sweep reads, a statement when no entry
   records the change, and a sentence when every cited change was made by the
   assignee. It never carries a secret, a tool description or schema, a
   parameter value or a prior-state payload. The hashes stand for the text, as
   they do in the `inflect-agent-harness/1` report
   (`docs/agent-harness-contract.md`). Titles and descriptions are sanitised at
   the write, and `Finding.description` is encrypted at rest.
6. **Never silent.** A week whose passports are not emitted raises
   `PASSPORT_NOT_EVIDENCED`, **MEDIUM**, owned by the tenant's OWNER role, with
   its reason: `NO_TARGET_CONTROL`, `POPULATION_TRUNCATED` or
   `BUNDLE_TOO_LARGE`. A prior that does not verify raises
   `PASSPORT_PRIOR_UNVERIFIABLE`, **HIGH**, owned by the tenant's OWNER role and
   keyed by the prior's week, so a prior that stays bad is reported once.
   Without them, a tenant whose drift is never compared would look the same as
   a tenant with no drift.

`CONNECTION_OWNER_MISSING`, `PIN_BASELINE`, `PIN_ANNOTATIONS_UNATTESTED`,
`CONNECTION_VANISHED` and `PASSPORT_PRIOR_UNVERIFIABLE` are nonconformities;
every other passport finding is an observation.

## What a passport never contains

- A secret value, or an unkeyed hash of one.
- An endpoint's path, query, fragment or userinfo: any of them can carry a
  credential. P1 is the origin and a keyed digest.
- An access token. Tokens minted from a refresh token or a client secret live
  only in process memory (the cache in `src/app-layer/integrations/mcp/token.ts`).
  Two kinds of bearer are stored, encrypted, in
  `IntegrationConnection.secretEncrypted`: a static `authorization` value,
  including the grant-endpoint token Inflect mints in
  `src/app-layer/usecases/mcp-server-token.ts`, and a refresh token, which
  `persistRotatedRefreshToken` in `src/app-layer/usecases/external-mcp-tools.ts`
  rewrites when Entra rotates it. The passport reads only whether each is present
  (P3).
- A tool's description or schema text. The pin's hashes stand for them.
- Parameter values. `parametersHash` stands for them.
- Any `ExternalWriteJournal` payload. `argumentsJson`, `priorStateJson` and
  `detail` are encrypted at rest (`src/lib/security/encrypted-fields.ts`) and
  stay in the journal.
- A person's name or address. The owner, approvers and granters are user ids;
  the view resolves the owner's name for display only.

## Future work

When step 2e (#3673) adds A2A peer records, the passport extends to a peer's
outbound route under the same rules, with the peer's agent-card pin treated as a
pinned definition under P6. The A2A side is modelled in
[`docs/a2a-threat-model.md`](a2a-threat-model.md).
