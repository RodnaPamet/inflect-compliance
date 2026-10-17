# Data protection impact assessment: the agent harness scanner and its ingest

This assessment covers two processing operations. The **scanner** is to run
in a client's environment and read the agent-shaped principals there. The
**ingest** receives the scanner's signed `inflect-agent-harness/1` report into
that client's own Inflect tenant. The report format is
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

Out of scope: any later step that hands scan data to a model, such as the IAM
skills of step `1d` or the owner-attribution skill used at intake in step `2a`.
Each is assessed with its own step.

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
the register records. The acceptance's user ids record who accepted a risk and
who revoked the acceptance; the scanner key's record who decided the tenant
trusts a signer and who withdrew that trust. None of it is used to evaluate or
profile the people named, and Inflect uses none of it for a purpose of its own
(DPA §2).

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
  that check on credential references only. Condition 10 requires the ingest to
  run it on every other string, which it does since #3692.
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

None. Under condition 4 the scanner sends a report only over HTTPS to the
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

**The scanner and the ingest introduce no sub-processor.**

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
| R9 | A later step sends scan data to a model or a third party. | Outside this assessment; that step is assessed with it and goes through the sub-processor notice window first. | `docs/sub-processor-change-policy.md` |
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
changes: the contract id (`inflect-agent-harness/2`), the source kinds in
`SOURCE_KINDS`, a stored column that holds a person's identifier, a condition
on step `1a`, or where scan data goes.
