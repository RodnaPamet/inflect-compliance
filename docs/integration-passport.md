# The integration passport

An integration passport is one record per external connection that states what
the connection lets an agent do: how it authenticates, which tools on it a person
has accepted, which agents may reach them, how far a write may go, and who is
accountable. This document specifies it. Step 2d (#3672) is the step that builds
it: a weekly sweep that assembles each passport from rows the product already
stores, compares it with the previous week's, and raises a finding with a named
owner for each difference the rules below call drift.

No passport is built on `main`. What this document states as true today is the
source of each field: the table and column it is read from on `main`. Everything
else here (how a passport is built, how two weeks are compared, which change is a
finding and who owns it) is a requirement on step 2d, and is written as one. A
field with no source on `main` is listed as a gap, not invented. See
[`docs/agentic-iam-roadmap.md`](agentic-iam-roadmap.md), UC5.

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
`src/app-layer/usecases/external-mcp-tools.ts` finds a connection's pins.

**This narrows step 2d's stated scope.** The 2d issue states its goal as "every
external connection". This specification limits the population to `mcp-server`
connections, and 2d's goal and acceptance test are to be read with the same
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

## How step 2d must build a passport

- **From stored rows only.** The builder must not call the server, mint a token
  or run `tools/list`. A definition the server changed since a person approved it
  is caught by the funnel, not by the passport: the runtime offers an external
  tool only when its live definition verifies as `APPROVED` against its pin
  (`resolveGrantedExternalTools` in
  `src/app-layer/usecases/external-mcp-tools.ts`), and the tool boundary refuses
  a definition that has moved (`assertToolManifestPinned` in
  `src/lib/mcp/authorize.ts`). The passport records what was accepted and by
  whom; the funnel enforces it on every run.
- **One secret read, presence only.** The grant kind (field P3) depends on which
  credential fields a connection holds, and some of them live in the encrypted
  `IntegrationConnection.secretEncrypted`. The builder must resolve the kind with
  the same resolver the runtime and the Test button use, `resolveMcpCredentials`
  in `src/app-layer/integrations/mcp/token.ts`, and keep only the kind. No secret
  value, and no hash of one, may enter a passport.
- **Canonical and comparable.** A passport must be serialised as canonical JSON
  (`src/lib/canonical-json.ts`) and carry a SHA-256 digest of that
  serialisation. Two weeks are compared by digest first and field by field only
  when the digests differ.
- **Derived, not stored as a table of its own.** Step 2d must emit each week's
  passports as Evidence through the existing emission path
  (`src/lib/agentic/evidence-artefact.ts`). Where it recovers the previous week's
  passport from is its own choice; the comparison rules below do not depend on
  it.

## The fields

The Source column is true on `main` today. The Drift rule column states what the
sweep must raise.

"Owner" in the last column means the connection's accountable owner, field P11.
**While a connection has no owner (P11 absent), every finding on it is owned by
the tenant's OWNER role** (the holders of `admin.tenant_lifecycle`), carries no
assignee, and names the role in its description, beside the
`CONNECTION_OWNER_MISSING` finding for the same connection. Every connection on
`main` is in that state today, because P11 has no source.

| # | Field | Source on `main` | Drift rule | Finding owner |
|---|---|---|---|---|
| P1 | Endpoint | `IntegrationConnection.configJson.url` | Any change is a finding, **HIGH**. The stored credential is presented to whatever this field names. For a connection that holds a stored secret, an update that changes it without re-supplying the credential is refused by `redirectsStoredCredential` (`src/app-layer/integrations/config-schema.ts`; the refusal in `upsertIntegrationConnection`, `src/app-layer/usecases/integrations.ts`, runs only when the existing row has a `secretEncrypted`), so a change there means somebody also supplied a credential. For a connection with no stored secret, such as one of grant kind `none`, nothing refuses the change and the endpoint can move freely. | Owner |
| P2 | Enabled | `IntegrationConnection.isEnabled` | `false` to `true` is a finding, **MEDIUM**: reach is restored. `true` to `false` is a finding, **LOW**. | Owner |
| P3 | Grant kind | Derived, not stored: `resolveMcpCredentials(configJson, secrets)` over `configJson.tenantId`, `configJson.clientId`, `configJson.scope` and the decrypted `secretEncrypted` keys `clientSecret`, `refreshToken` and `authorization`. Values: `delegated` (`McpCredentials.kind`; a refresh token is present, so every token carries a named person's privileges); `app-only` (`McpCredentials.kind`; client secret and scope, no refresh token, so no person bounds the token); `static-header` (the resolver returns null and `authorization` is set; the grant behind a pasted value cannot be known); `none` (nothing set); `invalid` (the resolver throws because the configuration is partial). | Any change of kind is a finding. **HIGH** when the change leaves `delegated`, because the ceiling of a named person is removed; `token.ts` keeps the two grants a required discriminant for this reason. **MEDIUM** otherwise, including any change to `invalid`. | Owner |
| P4 | Scope | `IntegrationConnection.configJson.scope`, trimmed. For a `delegated` grant with no stored scope, the effective scope is `ENTRA_MCP_SCOPE` (`src/app-layer/integrations/mcp/token.ts`), recorded with `defaulted: true`. For `static-header` and `none` the stored value is reported but no token is minted with it. | A change in the effective scope is a finding, **MEDIUM**. | Owner |
| P5 | Audience | Derived from P4: each space-separated entry except `offline_access`, with a trailing `/.default` removed. For `static-header` and `none` the audience is `unknown`: the product never decodes a pasted token. | Any change is a finding, **HIGH**. `config-schema.ts` classifies `scope` as `inert` because a token minted for the wrong audience fails at the intended server. The other direction is not inert: the token is minted for the new resource and presented to the same endpoint (P1), which then holds a token it can present to that resource. A scope change can be saved without re-supplying the secret. | Owner |
| P6 | Pinned tools | `McpToolManifestPin` rows whose `toolName` starts with `mcp__<connectionId>__`: the four hashes `src/lib/mcp/tool-manifest.ts` defines (`descriptionHash`, `schemaHash`, `manifestHash` and `annotationsHash`), plus `revision`, `approvalSource`, `approvedByUserId`, `approvedAt` and `previousManifestHash`. | One finding per tool that is added, removed, or whose `revision` moved. It names which hashes changed, the approver and the replaced `previousManifestHash`. **HIGH** when `descriptionHash` moved, because the description is instruction text the model reads. **HIGH** when `annotationsHash` moved, because the annotations carry `readOnlyHint`, and the live hint decides whether a call takes the external write path at all (`declaresWrite` in `src/lib/mcp/tool-write-classification.ts`, read in `src/lib/mcp/tools/external-tools.ts`): a re-approval that redeclares a write tool as read-only takes it off the ladder. **MEDIUM** otherwise. A pin on this connection with `approvalSource = 'BASELINE'` is a finding, **HIGH**: external pins are written as `APPROVED` with a named approver by `approveExternalToolManifest`, so a baseline here is a definition nobody accepted. A pin on this connection with a null `annotationsHash` is a finding, **HIGH**: `verifyToolManifest` compares annotations only when the pin holds that hash, so the server can flip `readOnlyHint` on the tool and the runtime still offers it as `APPROVED`. Its write declaration is not attested. Re-approving the tool writes the hash (`writeToolManifestPin` in `src/app-layer/usecases/mcp-tool-manifest.ts`). | Owner |
| P7 | Granted agents | `RegisteredAgentTool` rows whose `toolName` starts with `mcp__<connectionId>__`: `agentId`, `toolName`, `grantedByUserId`, `createdAt`. | A new grant is a finding, **MEDIUM**: another agent can reach the third party. A removed grant is a finding, **LOW**. | Owner |
| P8 | Write rung | `IntegrationConnection.externalWriteMode`, read through `coerceStoredMode`, and `externalWriteModeSince` (`src/lib/integrations/external-write-ladder.ts`). | A widening is a finding, **HIGH**. A narrowing is a finding, **LOW**. A stored value `coerceStoredMode` had to translate is a finding, **MEDIUM**: it reads as `DISABLED` and fails closed, but something wrote a rung this build does not know. Each move is audited as `EXTERNAL_WRITE_MODE_CHANGED`, and the finding cites that entry. | Owner |
| P9 | Prior-state pairings | `ExternalToolPriorStateRead` rows whose `writeToolName` starts with `mcp__<connectionId>__`: `writeToolName`, `readToolName`, `approvedByUserId`, `updatedAt`. | A pairing added, removed, or pointed at a different read is a finding, **MEDIUM**. The pairing decides what is read from the customer's system before it is changed. | Owner |
| P10 | Parameter sets | `ExternalToolParameterSet` rows whose `toolName` starts with `mcp__<connectionId>__`: `label`, `revision`, `parametersHash`, `approvalSource`, `approvedByUserId`, `targetPopulation`, and whether `pendingHash` is set. | A set added, removed, or whose `revision` moved is a finding, **MEDIUM**. A changed `targetPopulation` is a finding, **HIGH**: it changes which rows an `AUTOMATIC` write may be about. A pending edit is reported and is not drift; it is not in force until four eyes promote it. | Owner |
| P11 | Owner | **Gap.** No column on `IntegrationConnection` names an accountable person. The creator appears only in the audit trail, as the actor of `INTEGRATION_CONNECTION_CREATED` written by `upsertIntegrationConnection` (`src/app-layer/usecases/integrations.ts`), and creating a connection is not accepting accountability for it. Step 2d adds the source. | No owner is a finding, **HIGH** (`CONNECTION_OWNER_MISSING`), raised rather than skipped. A changed owner is a finding, **MEDIUM**. | No owner: the tenant's OWNER role, the holders of `admin.tenant_lifecycle`, who already set every connection's rung and pairings. Changed owner: the new owner. |
| P12 | Last validated | `IntegrationConnection.lastTestedAt` and `lastTestStatus`, written as `ok` or `error` by `testConnectionCredentials` through `updateConnectionTestStatus` (`src/app-layer/usecases/integrations.ts`). | `ok` to `error` is a finding, **MEDIUM**. A connection never tested (`lastTestedAt` null) is a finding, **LOW**. Age alone is reported and is not drift: the columns move only when a person presses Test, so a connection in daily use and one nobody touches age alike. | Owner |

`authFailedAt` and `authFailureReason` are not passport fields. They are written
only by `markAuthFailure` callers (the identity, HRIS, cloud-posture and
legacy-access syncs), and no `mcp-server` path calls it.

## Gaps

| Gap | Why it has no source today | Closed by |
|---|---|---|
| Owner (P11) | `IntegrationConnection` has no owner column, and the audit trail records who created a connection, not who answers for it. | Step 2d adds the source. Until a connection has one, its passport raises `CONNECTION_OWNER_MISSING`, and its other findings fall back to the tenant's OWNER role. |
| Write declaration per pinned tool | The pin stores `annotationsHash`, not the `readOnlyHint` it covers. `declaresWrite` (`src/lib/mcp/tool-write-classification.ts`) needs the live annotations, so a passport built from stored rows cannot list the pinned tools that declare a write or the write tools that lack a pairing. | Step 2d decides whether to store the declaration beside the pin when it is approved. |

## Rules step 2d must apply to every field

1. **Week on week.** A passport is compared with the last one emitted for the
   same connection. A connection's first passport is its baseline: it raises the
   absence findings (no owner, never tested, a `BASELINE` pin, a pin with a null
   `annotationsHash`) and no "added" findings.
2. **One finding per condition.** Each finding is keyed by connection, field and
   rule. A week that finds a condition already covered by an open finding adds
   nothing, so the sweep is idempotent. The key fits the existing columns
   `Finding.sourceKind` and `Finding.sourceRef`, which carry the index
   `[tenantId, sourceKind, sourceRef]`.
3. **A finding is a `Finding` row** with `assigneeUserId` set to the owner named
   in the table and `severity` as stated (`FindingSeverity`). Where the table
   names the connection's owner and P11 is absent, the owner is the tenant's
   OWNER role, as stated above the table. A finding owned by the tenant's OWNER
   role carries no assignee and names the role in its description.
4. **A vanished connection is a finding.** A connection present last week and
   absent this week was removed outside the product's own paths, because the
   product disables and never deletes an `mcp-server` connection. **HIGH**,
   owned by the tenant's OWNER role.
5. **Findings carry identifiers, not content.** A finding names fields, hashes,
   rung names, ids and the audit entries for the change in the window. It never
   carries a secret, a tool description or schema, a parameter value or a
   prior-state payload. The hashes stand for the text, as they do in the
   `inflect-agent-harness/1` report (`docs/agent-harness-contract.md`).

## What a passport never contains

- A secret value, or a hash of one.
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

## Future work

Step 2d (#3672) builds the pure builder over exactly the fields above, the
weekly `integration-passport-sweep`, the Evidence emission and a passport view
per connection on the integrations admin page, and closes the two gaps. When
step 2e (#3673) adds A2A peer records, the passport extends to a peer's outbound
route under the same rules, with the peer's agent-card pin treated as a pinned
definition under P6. The A2A side is modelled in
[`docs/a2a-threat-model.md`](a2a-threat-model.md).
