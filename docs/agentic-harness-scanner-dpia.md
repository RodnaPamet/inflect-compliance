# Data protection impact assessment: the agent harness scanner and its ingest

This assessment covers two processing operations. The **scanner** is to run
in a client's environment and read the agent-shaped principals there. The
**ingest** receives the scanner's signed `inflect-agent-harness/1` or `/2`
report into that client's own Inflect tenant. The report format is
[`docs/agent-harness-contract.md`](agent-harness-contract.md) and its schemas
and verifier are `src/lib/agentic/harness-contract.ts`.

Both belong to step `1a` (#3665) of [the agentic IAM design](agentic-iam-roadmap.md),
which is delivered in parts:

| Part | Where |
|---|---|
| The ingest: the route `/api/t/:slug/admin/agents/harness-scans`, the derived levels and findings, and the five tables `AgentHarnessScannerKey`, `AgentHarnessScan`, `DiscoveredAgent`, `AgentHarnessScanItem` and `AgentHarnessAcceptance` | #3688, merged on 2026-10-17 |
| Conditions 7 and 10 on the ingest, and the no-cascade rule under [Retention](#retention) | #3692, merged on 2026-10-17 |
| The scanner package and container | #3686 |
| The harness matrix, and the evidence emitted from a scan | #3687 |

Where a safeguard is enforced by code on `main`, the code is named. Where it is
a requirement on a part that is not on `main`, it is listed under
[Conditions on step 1a](#conditions-on-step-1a) with the issue or pull request
that owns it, and the assessment holds only while every condition does.

The assessment is signed by the owner's merge of the pull request that carries
it (see [Sign-off](#sign-off)).

Out of scope: any later step that hands scan data to a model, such as the
owner-attribution skill used at intake in step `2a`. Each is assessed with its
own step. One such reader is assessed here, because it reads a column this
assessment covers: a model reading the owner reference through the MCP tool
`get_discovered_agent`, which #3710 made reachable. See
[A model as a reader of the owner reference](#a-model-as-a-reader-of-the-owner-reference).

## Roles

| Party | Role | Basis |
|---|---|---|
| The client | Controller of the data in its estate and in its tenant | DPA §1 and §2, [`docs/data-processing-agreement-template.md`](data-processing-agreement-template.md) |
| Inflect | Processor for the ingest and for storage in the client's tenant | DPA §2 |
| The scanner | Software that Inflect supplies and the client is to run on its own infrastructure with its own credentials. Inflect does not operate it, so its reads are the client's own processing. | #3686: the scanner is its own package and container, run in the client environment |

For the pilot, the estate is Inflect's own (decision 10 of the design), so
Inflect is controller and processor at once.

## Personal data

**Data subjects.** The client's staff named as the owners of agents; the staff
who accept or revoke a harness-shortfall risk acceptance; the staff who add or
revoke a trusted scanner key; and any person whose name the client has built
into an identifier the scanner reads, for example a service principal named
after the person who created it.

**Categories in the report.** The report carries identifiers, flags, counts and
pointers. Exactly one member is personal data by design:

| Report member | What it holds | Personal data |
|---|---|---|
| `agents[].owner` | `kind` (`user` or `group`), `id`, and `source`, the place the scanner read it | **Yes** when `kind` is `user`: a directory or register identifier of a person. The contract bounds its length and does not constrain its form, so it is a user principal name or an email address wherever that is what the source records. |
| `agents[].discoveredId` | The principal's id in the source that found it, e.g. `entra:sp:<objectId>` | No, unless the client named the principal after a person |
| `agents[].registeredAgentId` | The Inflect register id, or `null` | No |
| `agents[].credentials[]` | `ref`, a `scheme://locator` reference; age in days; whether it expires; whether it is bound to the agent; the grant kind | No by design. A locator carries a person's name only if the client's own paths do. |
| `agents[].tools[]`, `agents[].skills[]` | Server URL, tool name, manifest hash, pin flag, read-only hint; skill name, licence, declared flag | No |
| `unboundCredentials[]` (`/2` only) | `ref`, a `scheme://locator` reference to a credential no discovered agent holds, and the source kind that saw it | No by design; the same caveat as an agent's credential locator |
| `agents[].tools[].calls`, `windowDays` (`/2` only, optional) | How many times the agent called the tool, and over how many days | No: a count of an agent's calls, carrying nothing of what it sent or received |
| `agents[].models[]` (`/2` only, optional) | `endpoint`, a `scheme://locator` or a host, and the model's id | No by design; the same caveat as a locator. Verified with the report and not stored |
| `agents[].verdicts[].evidence`, `findings[].evidence` | A pointer of at most 512 characters | No by design; the same caveat as a locator |
| `scan.scanner` | The scanner's own register id, version and manifest hash | No |
| `signature` | Algorithm, public key, signature | No |

**What the report does not carry.** No member carries content. The contract has
no field for a tool's description (the manifest hash stands for it), a prompt, a
payload, a message, a file or a credential value, and it refuses a member it
does not define. No member is suited to special category data: each is an
identifier, a flag, a count or a bounded pointer.

**What the ingest stores.** The owner reference is stored on
`DiscoveredAgent` (`ownerKind`, `ownerRef`), which each scan updates in place.
An unbound credential is not stored as such: when its source was read in full,
the ingest raises an `ORPHAN_CREDENTIAL` finding whose title and description
name the reference, which carries a person's name only if the client's own
locator does (the description is in the field-encryption manifest, as for
every finding).
A scan item holds one agent's derived level, reach, criterion verdicts and tool
names with manifest digests; a scan holds its signer, the digest of the signed
body, the signature and the per-source completeness. The schema is
`prisma/schema/agentic.prisma`.

**The acceptance record.** `AgentHarnessAcceptance` (decision 7 of the design)
is the only one of the five tables that holds free text. It has the shape of
`ControlException` (`prisma/schema/controls.prisma`), per agent instead of per
control. It names people by user id, `acceptedByUserId` (the registered agent's
owner, who accepts the risk) and `revokedByUserId`, and carries a written
`justification`. The user ids are personal data: each records a person's
decision in their working role. The justification is written by the tenant's
staff about an agent's shortfall. It is not meant to be about a person and can
mention one. It is in the field-encryption manifest
(`src/lib/security/encrypted-fields.ts`) and passes through `sanitizePlainText`
at the write seam (`src/app-layer/usecases/agent-harness-acceptance.ts`), the
treatment `ControlException` has (condition 11).

**The scanner key.** `AgentHarnessScannerKey` holds public key material only,
and names the staff who added and revoked it (`createdByUserId`,
`revokedByUserId`).

**The audit trail.** The ingest audits its write through `logEvent`
(`src/app-layer/events/audit.ts`): the hash-chained `AGENT_HARNESS_SCAN_INGESTED`
row carries the scan reference, the scanner agent, the report digest and the
finding counts. That records the acting principal in the tenant's hash-chained
audit trail, which is existing processing under the DPA, not new processing.

## Purpose

One purpose: to keep an inventory of the agent-shaped principals in the
client's estate and the harness each runs under, so that the client can find
unregistered agents, score each on the harness ladder
(`src/lib/agentic/harness-ladder.ts`), and evidence its inventory and access
controls.

The owner reference serves two checks only: whether an agent has an
accountable owner (criterion `H1.owner`), and reconciliation against the owner
the register records. The model that reads it (below) serves the same two and no
third: the assessment skill judges `H1.owner`, and the attribution skill
suggests the accountable owner for a person to confirm. The acceptance's user ids record who accepted a risk and
who revoked the acceptance; the scanner key's record who decided the tenant
trusts a signer and who withdrew that trust. None of it is used to evaluate or
profile the people named, and Inflect uses none of it for a purpose of its own
(DPA §2).

## A model as a reader of the owner reference

Added by #3710, the reach half of step `1d`. Before it, no model could read
`DiscoveredAgent.ownerRef`: the facts read behind `get_discovered_agent` took
`admin.agent_registry`, which no bearer token carries, and every agentic run on
the Flue engine is started by an agent-bound key. Since #3710 the read takes the
read-only inventory key `admin.agent_registry_view`, which a key carries through
the named scope `admin:agent_registry_view`. So a model can now read the owner
reference, and this section names it as a reader.

**Who reads it.** The owner reference is read, through `getDiscoveredAgentFacts`
(`src/app-layer/usecases/agent-harness-facts.ts`), by:

| Reader | Through | Since |
|---|---|---|
| The tenant's own staff holding the inventory view key — OWNER, ADMIN, AI_ADMIN, AUDITOR, or a custom role carrying it — or the register key | The agent register, `/agents/reports` and the `admin/agents` read routes | #3688, #3710 |
| A model, in a run of the `discovered-agent-review` workflow | The MCP read tool `get_discovered_agent`, which returns the owner as its source records it (`sourceOwner`) | #3710 |

**Only under all of these.** A model reads it only when every one holds; each is
enforced in code, and each refusal writes a hash-chained `AUTHZ_DENIED` row:

- the run's API key carries `mcp:read` and the named scope
  `admin:agent_registry_view`. Neither `*` nor `admin:*` carries the scope
  (`WILDCARD_EXCLUDED_ACTIONS` in `src/lib/auth/api-key-auth.ts`), so no key
  issued before #3710 reads it;
- the person the key speaks for holds the view key themselves — the key's
  permissions are that person's intersected with its scopes;
- the run's registered agent is granted `get_discovered_agent` under
  `admin.agent_tool_exposure`, on a deny-by-default list, and its policy card
  and autonomy ceiling allow the call;
- the read is of the key's own tenant: row-level security and the tenant
  predicate scope it, and another tenant's agent is not found.

**What the model is told about it.** The payload is labelled
`THIRD_PARTY_INGESTED` and carries the rule that it is data, never instruction
(`MCP_TOOL_CORPUS` and `buildProvenanceEnvelope` in
`src/lib/agentic/content-provenance.ts`). The run's own input, the discovered
agent's id, reaches the prompt the same way: fenced, neutralised and labelled
(`src/lib/agentic/flue/run-message.ts`).

**What it may do with it.** Nothing but answer. The workflow is read-only — one
read and one synthesis, no proposal and no checkpoint
(`src/lib/agentic/workflows/discovered-agent-review.ts`). An attribution answer
parses through `parseOwnershipAttribution`
(`src/lib/agentic/iam-skill-outputs.ts`), whose status cannot be `LINKED`, so
the model can only suggest an owner, and a person confirms one at registration
intake (step `2a`) before it becomes the register's owner.

**Where it goes.** The model is the deployment's Flue model, chosen by the
tenant's `aiResidency`:

| Residency | Model | The owner reference |
|---|---|---|
| `LOCAL_ONLY` | The local model (`AI_LOCAL_MODEL`) | Stays in the deployment |
| `EXTERNAL`, the default | The external provider, `inflect-external` (Anthropic by default, `AGENT_FLUE_MODEL`) | Leaves the deployment to that provider, in the model call |

A run of the workflow on the static engine calls no model. There the owner
reference lands only in the encrypted run context and step output
(`WorkflowRun.contextJson`, `WorkflowStep.outputJson`).

**What is stored of the model's answer.** The Art 12 record of each model call,
`AiDecisionLog`, stores a digest of the prompt, never its content, and a bounded,
sanitised summary of the final answer (`outputSummary`). An attribution answer
names the owner it suggests, so for `agentic-run:discovered-agent-review` that
summary can carry an owner reference. `AiDecisionLog` is append-only and a
Regulatory artefact in [`docs/data-retention.md`](data-retention.md), whose row
names it DSAR-relevant for that feature (condition 7), and it has no erasure path
for one person.

### Conditions on #3710

| Condition | Status |
|---|---|
| 12. Before a tenant's Flue runs of `discovered-agent-review` send the owner reference to an external model provider, [`docs/sub-processors.md`](sub-processors.md) names that data in the provider's row and the notice [`docs/sub-processor-change-policy.md`](sub-processor-change-policy.md) requires is given, or the repository owner records why it is not required. | **Met** — the Anthropic row and its section (c) in `docs/sub-processors.md` name an agent run's payload, the owner reference included. The repository owner recorded on 2026-10-18 that the note on the existing row is enough and that no separate notice window or code gate is required before these runs ship. |
| 13. A model reads the owner reference only through `get_discovered_agent`, under the named scope and a tool grant, and labelled untrusted. | Met by #3710 (`tests/integration/agent-registry-view-key.test.ts`) |
| 14. Every stored column the model's answer can reach that names a person is named DSAR-relevant, as condition 7 requires of the ingest's. | Met by #3710 for `AiDecisionLog.outputSummary` |

## Lawful basis

The repository cannot answer this; the controller does. Two questions for the
controller, both **open**:

1. On what basis does it read its own directory, secrets inventory and MCP
   servers with the scanner?
2. On what basis does it record, in its tenant, which of its staff own which
   agents and which of them accepted a risk?

For the pilot, Inflect is the controller. Neither question has an answer on
record. The signature (see [Sign-off](#sign-off)) covers the assessment as
written, with both questions open; the controller's answers are recorded on
#3664 when given.

## Minimisation

Enforced on `main` by the contract, `src/lib/agentic/harness-contract.ts`:

- **Strict objects.** Every schema is `.strict()`, so a member the contract
  does not define is a `SCHEMA` refusal rather than a stored extra.
- **References, not values.** `credentialRef` accepts only the `REFERENCE`
  shape (`scheme://locator`) and refuses any value that `looksLikeSecret`
  matches against `SECRET_SHAPES`: GitHub, AWS, Slack and `sk-` token shapes,
  private-key blocks and JWTs, including inside a reference. The contract runs
  that check on credential references only — an agent's, and in `/2` each of
  `unboundCredentials[]`. Condition 10 requires the ingest to run it on every
  other string, which it does since #3692, and its walk reaches the `/2`
  member like any other.
- **Bounded members.** `MAX_ID_CHARS` (256) for ids, names, owner and licence
  fields and the two signature fields. A credential reference is bounded by the
  `REFERENCE` pattern instead: a scheme of at most 32 characters and a locator
  of at most 480, 515 characters in all. `MAX_EVIDENCE_CHARS` (512) for
  evidence pointers and tool server URLs, `MAX_REPORT_BYTES` (5 MiB) for the
  whole report, and caps on sources, agents, credentials, tools, skills,
  verdicts and findings.
- **Verify before reading.** `verifyAndParseHarnessReport` checks the size,
  then the JSON, then the Ed25519 signature by a key the tenant trusts, and
  only then the schema. A report signed by any other key is refused before its
  content is interpreted.
- **Nothing self-declared.** The report carries no level (the ingest derives
  it with `scoreHarness`) and no completeness flag (`isScanComplete` derives it
  from the sources).

### Conditions on step 1a

Where each condition stands:

| Conditions | Owned by | Status |
|---|---|---|
| 5, 6, 9 and 11 | The ingest, #3688 | Met; #3688 merged on 2026-10-17 |
| 7 and 10 | The ingest, #3692 | Met; #3692 merged on 2026-10-17, with the no-cascade rule under [Retention](#retention) |
| 1, 2, 3 and 4 | The scanner, #3686 | Open |
| 8 | The scan evidence, #3687 | Open |
| 15 | The `code` source, #3737 | Open |

For the two sources step `4a` built (#3678), Okta and Azure Key Vault,
conditions 2 to 4 hold and are tested by request log: each source sends only
GET requests to its own host, plus the OAuth token exchange to the identity
platform for Key Vault; the vault reader calls only the two list endpoints,
which return no value; and the scanner posts only to the ingest, over HTTPS.
Neither source has a field for a write credential. Condition 1 concerns MCP,
which neither reads, so it stays with #3686. Step `4a` also stores one new
reference to a person, the owner of each source of a client estate
(`AgentHarnessEstateSource.ownerUserId`), a tenant member chosen by the tenant's
own staff, and its `docs/data-retention.md` row names it DSAR-relevant.

#3686's hardening checklist carries condition 1 and the write-credential half
of condition 2. The assessment holds for the scanner only when #3686 meets all
four of its conditions, and for the evidence emitted from a scan only when
#3687 meets condition 8.

1. The scanner sends an MCP server `initialize` and `tools/list` only, asserted
   by its request log.
2. The scanner holds no write credential and never calls `tools/call`.
3. The vault reader lists secret names, references and metadata, and never
   reads a secret's value.
4. The scanner sends nothing anywhere except, over HTTPS, the ingest route of
   the client's own tenant.
5. The three scan tables hold identifiers, flags, counts and pointers, with no
   free text, and the ingest does not store the raw report body.
6. A refused report, whatever the refusal, writes no row to the four tables
   and stores nothing of its body. The ingest records only the refusal code
   (`HarnessRefusal`) and the credential that sent it.
7. Every stored column that names a person is named DSAR-relevant in its
   `docs/data-retention.md` row, as `IdentityWriteJournal.externalUserId` is:
   an owner reference, if the ingest stores one, and each user id on
   `AgentHarnessAcceptance`.
8. The evidence emitted from a scan renders no owner reference.
   `Evidence.content` is outside the field-encryption manifest, is rendered
   into PDF exports and is reachable through an audit-pack share link
   (`src/lib/agentic/evidence-artefact.ts`), so it is the widest surface a
   scan's data could reach.
9. The ingest calls no external service and no model: it verifies, parses,
   scores with `scoreHarness`, reconciles and writes.
10. The ingest runs `looksLikeSecret` over every string member of a report, not
    only credential references, and refuses a report in which one matches,
    naming the member.
11. `AgentHarnessAcceptance`'s free-text columns are in the field-encryption
    manifest and pass through `sanitizePlainText` at the write seam, as
    `ControlException`'s do.

Condition 15 is on the `code` source that `inflect-agent-harness/2` added
(#3754), numbered after #3710's conditions 12 to 14:

15. A `code` source reads files and never imports or executes what it reads,
    and reports a credential written into the code by its location (`code://…`)
    or by the environment variable it names (`env://…`), never by its value.

## Retention

All four models this assessment covers are Business records (decision 11 of the
design), the class [`docs/data-retention.md`](data-retention.md) gives each of
them on `main`, and the design's
[retention classes](agentic-iam-roadmap.md#retention-classes) carry the same:

| Model | Class | Reason |
|---|---|---|
| `AgentHarnessScan` | Business record | An inventory of the client's own agents, which a tenant deletion asks Inflect to remove, so it is purged with the tenant and is not a regulatory artefact. The hash-chained `AGENT_HARNESS_SCAN_INGESTED` audit row, carrying the report digest and the signer, is the record that survives it. |
| `AgentHarnessScanItem` | Business record | The per-agent half of a scan, deleted with its scan and purged with the tenant, for the same reason. |
| `DiscoveredAgent` | Business record | The inventory of agents a scanner has seen, updated in place by each scan and never deleted by age. |
| `AgentHarnessAcceptance` | Business record | A time-limited risk acceptance, classed with `ControlException`, whose shape it has. |

The fifth table, `AgentHarnessScannerKey`, is Configuration in the same
document.

None of the four is deleted by age: no sweep reaches them and none carries a
`retentionUntil` column. Each is kept while the tenant is active and is deleted
by the tenant purge.

**The no-cascade rule: nothing kept longer is deleted with a discovered
agent.** The rule is that scan items and acceptances reference
`DiscoveredAgent` with `ON DELETE NO ACTION`, so that deleting a discovered
agent fails rather than taking its scan history or a risk acceptance with it.
#3688 shipped both foreign keys `ON DELETE CASCADE`, which did not meet it;
#3692 changed both to `ON DELETE NO ACTION` with the forward migration
`20261017215000_harness_discovered_agent_no_cascade`, leaving #3688's migration
unedited, so the rule holds on `main`. Nothing in
the application deletes a `DiscoveredAgent`, and the tenant purge deletes
children before parents, so the purge is unaffected by the change.

A refused report leaves only its refusal code and sender on record (condition
6). The `Evidence` emitted from a scan (#3687) follows the evidence retention
flow in `docs/data-retention.md`, which does not reach a scan, so a scan can
outlive its evidence.

**Erasure.** No model has an automated erasure path for one person beyond
`User`'s soft-delete, which `docs/data-retention.md` records, and that
soft-delete leaves an acceptance's and a scanner key's user ids in place. A
request to erase a person's owner reference from the discovered-agent
inventory, or their user id from an acceptance, therefore has no automated
path; the tenant purge is the only automated deletion.

## Transfers

None from the scanner or the ingest. The one transfer this assessment now
covers is the model call above: on a tenant whose `aiResidency` is `EXTERNAL`,
a Flue run of `discovered-agent-review` sends the owner reference to the
external model provider (US or global, per `docs/sub-processors.md`), whose row
names that data (condition 12, met). Under condition 4 the scanner sends a report only over HTTPS to the
ingest route of the client's own tenant. The ingest runs in the existing `app`
service, so what it keeps of a report is written to the same database as the
rest of that tenant's data: on Inflect's production deployment, Google Cloud
`europe-west1`, with disk snapshots in the `eu` multi-region (DPA §8). No copy
goes to another party or another region. On a self-hosted deployment the tenant
lives wherever its operator runs it, and the report goes no further.

A client outside the EEA that pushes a report sends it by the same route as any
data it enters in its tenant. This assessment adds no transfer and no transfer
mechanism.

## Sub-processors

**The scanner and the ingest introduce no sub-processor.** A model reading the
owner reference can: on a tenant whose `aiResidency` is `EXTERNAL`, a Flue run of
`discovered-agent-review` sends it to the external model provider. That provider
is listed, and its row names this data category (condition 12, met; see [A model as a reader of the owner reference](#a-model-as-a-reader-of-the-owner-reference)).

- The scanner is to run on the client's infrastructure, under the client's
  control, and read the client's own systems. The identity provider, vault, MCP
  servers and CI/CD it reads are services the client has chosen; they are the
  client's processors, not Inflect's.
- The ingest runs in the existing `app` service on the existing Google Cloud
  hosting, which `docs/sub-processors.md` already lists.
- The ingest is deterministic: verify, parse, `scoreHarness`, reconcile,
  write. It calls no external service and no model (condition 9).

[`docs/sub-processors.md`](sub-processors.md) records this position in its
inventory, in a row for the harness scanner and ingest beside the `legacy-mcp`
row, which records the same position for a connection whose far end is the
customer's own system.

A step that sends scan data to a model provider or any other third party
introduces a sub-processor, and goes through
[`docs/sub-processor-change-policy.md`](sub-processor-change-policy.md),
including its 30-day notice window, before that data moves.

## Risks and mitigations

| | Risk to the people concerned | Mitigation | Held by |
|---|---|---|---|
| R1 | A credential value reaches Inflect inside a report and is stored in the tenant. | Credentials travel as references, and a secret-shaped value is refused inside a credential reference. The contract checks no other member, so condition 10 requires the ingest to check every string member, which it does since #3692. Residual: a secret in a shape `SECRET_SHAPES` does not list passes both checks. | `credentialRef`, `looksLikeSecret`; condition 10 (#3692) |
| R2 | The scanner collects content written by or about staff: tool descriptions, prompts, payloads. | The contract has no member for content and refuses unknown members; the scanner sends `initialize` and `tools/list` only. | `.strict()` schemas; condition 1 |
| R3 | The scanner reads secret values in the client's estate while listing a vault. | The vault reader lists metadata and references only. | Condition 3 |
| R4 | A forged report attributes an agent to the wrong person, or invents an owner. | The signature by a tenant-trusted key is checked before the body is read. The report's owner is a claim: intake has a person confirm it before it becomes the register's owner. | `verifyAndParseHarnessReport`; step `2a` intake |
| R5 | Scan rows become visible in another tenant. | Row-level security, a tenant-leading index and a two-tenant test on every new table. The route is tenant-scoped, and an API key for another tenant is refused (`getTenantCtx`, `src/app-layer/context.ts`). | Step `1a` checklist; `getTenantCtx` |
| R6 | An owner reference reaches readers outside the tenant's members through emitted evidence. | Emitted evidence renders no owner reference. | Condition 8 |
| R7 | Owner references and user ids are kept longer than needed. | Every model is a Business record, kept while the tenant is active and purged with it. Residual: no automated erasure path for one person's reference. | Retention classes; `docs/data-retention.md` |
| R8 | An identifier field carries free text about a person. | Length bounds; no free text in the three scan tables; rendered as text only. Residual: an identifier can still contain a name. Accepted, because the naming is the client's own. | `MAX_ID_CHARS`, `MAX_EVIDENCE_CHARS`, `REFERENCE`; condition 5 |
| R9 | A later step sends scan data to a model or a third party. | Each such step is assessed with it and goes through the sub-processor notice window first. The one assessed here, a model reading the owner reference (#3710), is named with its conditions above. | `docs/sub-processor-change-policy.md`; conditions 12–14 |
| R12 | A model reads a person's directory identifier and decides something about them. | The workflow is read-only. The attribution answer can only suggest an owner (`parseOwnershipAttribution` cannot express `LINKED`), and a person confirms one at intake. | `discovered-agent-review`; step `2a` |
| R13 | A credential or a model reads owner references it was not meant to. | Only the named scope reaches the read, no wildcard does, the principal must hold the view key, the agent must hold the tool grant, and each refusal writes an `AUTHZ_DENIED` row. | Condition 13 |
| R14 | An owner reference is kept in an append-only record. | `AiDecisionLog.outputSummary` is bounded and sanitised and named DSAR-relevant. Residual: no erasure path for one person, as for the other append-only records. Accepted pending the retention answer `docs/data-retention.md` records as open. | Condition 14 |
| R10 | A shortfall finding names the owner of an agent below the bar, and colleagues read it. | Findings carry identifiers only and stay in the controller's own tenant, read by its own staff. Residual: accepted. | Step `1a` findings |
| R11 | An acceptance's justification names or describes a person, and is read beyond its purpose. | Encrypted at rest, sanitised at the write seam, and kept in the controller's own tenant. Residual: free text can still mention a person. Accepted, as it is for `ControlException`. | Condition 11 |

## Gaps

What this assessment relies on that has no source on `main` today, and who
owns it:

| Gap | Owner |
|---|---|
| The scanner package and container | #3686 |
| A read of the register for the scanner. No tool in `src/lib/mcp/tools/` and no resource in `src/lib/mcp/resources.ts` returns `RegisteredAgent` rows. | Step `1a` |
| The harness matrix, and the evidence emitted from a scan | #3687 |
| A person confirming a discovered agent's owner | Step `2a` |
| The controller's answers to the two lawful-basis questions | Open; recorded on #3664 when given |
| An erasure path for one person's owner reference or user ids | None planned |

## Sign-off

The signature is the repository owner's merge of the pull request that carries
this text (decision 9 of the design). Auto-merge on green is the owner's
standing authorisation for that merge, which the owner re-confirmed on
2026-10-17. This repository names no data protection lead, so the approver of
record is the repository owner, as
[`docs/sub-processor-change-policy.md`](sub-processor-change-policy.md) records
for its own approvals.

The signature covers the assessment as written, including the two
[lawful-basis](#lawful-basis) questions it leaves open. It does not answer
them; their answers are recorded on #3664 when given.

The assessment is reopened, and signed again the same way, when any of these
changes: the contract ids the ingest accepts (`HARNESS_CONTRACT_IDS`), the
source kinds in `SOURCE_KINDS`, a stored column that holds a person's identifier, a condition
on step `1a`, or where scan data goes. #3710 reopened it on the last of those —
a model became a reader of the owner reference — and the merge of the pull
request that carries the amendment signs it again, with condition 12 met.

#3754 reopened it on two of those: the contract id, `inflect-agent-harness/2`,
and the source kinds in `SOURCE_KINDS`, which gained `code`. `/2` adds
`unboundCredentials[]`, which carries credential references under the rules an
agent's credential already had; an optional call count with its window on each
tool, stored with the tool; and optional model endpoints, references verified
and not stored. None of them adds a data category or carries content; the `code`
kind brings a reader of source code and configuration into the estate, held by
condition 15 and owned by #3737. No stored column that names a person was added.
The merge of the pull request that carries this paragraph signs the amendment.

Step `4a` (#3678) reopened it on a stored column that holds a person's
identifier, the owner of each source of a client estate, and added two sources,
Okta and Azure Key Vault. The owner accepted the paragraph that records them
under [Conditions on step 1a](#conditions-on-step-1a) on 2026-10-19, and that
answer is the decision that extends this sign-off to the two new sources; the
merge of the pull request that carries it (#3740) signs the amendment.
