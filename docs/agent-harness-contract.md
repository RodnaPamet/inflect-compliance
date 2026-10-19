# The `inflect-agent-harness/1` report contract

How a harness scanner reports what it found in a client environment. A scanner
runs inside the client's perimeter, enumerates agent-shaped principals and the
harness each one runs under, and returns one signed report. This document is
normative: `MUST`, `MUST NOT`, `SHOULD` and `MAY` carry their RFC 2119 meanings.

`tests/helpers/agent-harness-fake-scanner.ts` is the **reference
implementation**. Where this prose and that file disagree, the file is the one
the suite validates against the schemas, so it is the one to copy. The schemas
and the verifier are `src/lib/agentic/harness-contract.ts`; the ladder that
scores the verdicts is `src/lib/agentic/harness-ladder.ts`.
`packages/agent-harness-scanner` is the deployable scanner (#3678). It builds
its report against those schemas and refuses to sign one they would refuse.

## What the report may and may not say

- It reports **verdicts per criterion**, never a level. The receiving side
  derives the level with the harness ladder.
- It names credentials by **reference**, never by value.
- It reports each source as `COMPLETE` or `INCOMPLETE`. Whether the scan as a
  whole is complete is derived from its sources and is never declared.
- It carries **identifiers and pointers, not content**: no tool description
  text (the manifest hash stands for it), no prompt, no payload.

## Signing and verification

The report is a JSON object: a body plus a `signature` member.

```json
{ "contract": "inflect-agent-harness/1", "scan": {}, "population": {}, "agents": [], "findings": [],
  "signature": { "alg": "ed25519", "signerKey": "<hex or base64 raw public key>", "sig": "<hex or base64>" } }
```

- The signed message MUST be SHA-256 over the canonical JSON of the report with
  the `signature` member removed. Canonical JSON sorts object keys recursively,
  keeps array order and emits no whitespace (`src/lib/canonical-json.ts`). Key
  order on the wire is therefore irrelevant.
- The signature MUST be Ed25519 by the scanner's key. The receiving tenant holds
  the public keys of the scanners it trusts; a report signed by any other key
  MUST be refused, even when its signature is mathematically valid.
- The verifier MUST check, in this order: size, JSON syntax, signature by a
  trusted key, then the schema. Nothing in the body is interpreted before a
  trusted key has vouched for it.

## The body

Every object is strict: a member this contract does not define MUST cause a
refusal.

| Member | Meaning |
|---|---|
| `contract` | Exactly `inflect-agent-harness/1`. |
| `scan.id` | The scanner's id for this run, unique per tenant. |
| `scan.asOf` | ISO 8601 time the scan describes. |
| `scan.scanner` | The scanner's own `agentId` in the register, its `version`, and the `sha256:` manifest hash of its own tool surface. |
| `population.sources[]` | One entry per source kind read: `kind`, `status`, `rows`, and `reason` exactly when `status` is `INCOMPLETE`. Each kind appears once. |
| `agents[]` | One entry per discovered agent, unique by `discoveredId`. |
| `findings[]` | Coded findings the scanner raises itself. |

### Sources

`kind` is one of `entra-sp`, `okta-app`, `vault`, `mcp`, `runtime`, `cicd`,
`inflect-register`. An `INCOMPLETE` source MUST name one of `BYTE_CAP`,
`TIME_BOX`, `AUTH_FAILED`, `UNREACHABLE`, `PAGINATION_TORN`, `RATE_LIMITED`. A
`COMPLETE` source MUST NOT carry a reason. A scanner MUST NOT drop a source it
could not read: an unread source is reported `INCOMPLETE`.

### Agents

| Member | Meaning |
|---|---|
| `discoveredId` | Stable id in the source that found it, e.g. `entra:sp:<objectId>`. |
| `discoveredVia[]` | Every source kind that saw this agent. |
| `registeredAgentId` | The register's id when the agent is registered, else `null`. |
| `owner` | `{ kind: user \| group, id, source }`, or `null` when no owner is recorded anywhere. |
| `credentials[]` | `ref` (a `scheme://locator` reference), `ageDays`, `expires`, `boundToAgent`, and `grant`: `delegated`, `app-only` or `unknown`. |
| `tools[]` | `server` (URL), `name`, `manifestHash` (`sha256:` or `null`), `pinned`, and `readOnlyHint` as the server declares it. An undeclared hint counts as a write. |
| `skills[]` | `name`, `license` (or `null`), `declared`. |
| `verdicts[]` | `criterion` (an id from the harness ladder), `met`, and `evidence`: a pointer to where the scanner saw it, or `null`. |

A credential `ref` MUST match `scheme://locator` and MUST NOT contain a value
with the shape of a secret (a GitHub, AWS, Slack or OpenAI-style token, a JWT, a
private-key block, or a URL carrying a password: `scheme://user:password@host`). The same rule holds for **every** string in the report: the
contract checks credential references, and the ingest refuses a report in which
any other string member has a secret's shape (`SECRET_IN_REPORT`, under
Transport). A verdict with `met: true` and no evidence counts as not met.

### Findings

`code` is one of `SHADOW_AGENT`, `UNPINNED_WRITE_TOOL`, `ORPHAN_CREDENTIAL`,
`INCOMPLETE_SOURCE`; `severity` is `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`;
`discoveredId` and `evidence` are pointers or `null`. A scan that discovers no
agents is not a clean scan; the receiving side treats an empty population as a
finding in its own right. The receiving side does not act on this member: it
derives its own findings (see **Transport**).

## Bounds

| Dimension | Maximum |
|---|---|
| Report size before parsing | 5 MiB |
| Sources | 50 |
| Agents | 5,000 |
| Credentials, tools, skills per agent | 100, 500, 100 |
| Findings | 20,000 |
| Identifier or reference | 256 characters |
| Evidence pointer | 512 characters |

## Refusals

| Code | Cause |
|---|---|
| `TOO_LARGE` | The raw report exceeds the size bound. |
| `NOT_JSON` | The body is not JSON. |
| `NOT_AN_OBJECT` | The JSON root is not an object. |
| `UNSIGNED` | No `signature` member. |
| `MALFORMED_SIGNATURE` | The signature member or its encodings do not parse. |
| `UNTRUSTED_SIGNER` | The signing key is not one this tenant trusts. |
| `BAD_SIGNATURE` | The signature does not verify over the canonical body. |
| `SCHEMA` | The body breaks this contract; the refusal lists each issue by path. An issue names no part of the body: an unknown key is counted, never quoted, because a key is content the signer chose. |

## Transport

A scanner posts the serialised report, unchanged, to
`POST /api/t/{tenantSlug}/admin/agents/harness-scans`. The route reads at most
the size bound before it parses anything: a declared `Content-Length` above it
is refused unread, and a body that streams past it is cut off. The usecase is
`src/app-layer/usecases/agent-harness-scans.ts`, the only writer of the scan
tables.

**Who may post.** The route requires `admin.agent_harness_ingest`. OWNER and
ADMIN hold it; a scanner holds it through an API key with the
`admin:harness_ingest` scope, which grants that one key and nothing else. A
scanner key does not need, and should not have, any other scope.

**Whose reports count.** The tenant registers the scanner's public key with
`POST /api/t/{tenantSlug}/admin/agents/harness-scanner-keys`
(`{ agentId, publicKey }`, raw 32-byte Ed25519 key in hex or base64). That
route requires `admin.agent_registry`, never the ingest key, so a scanner
cannot vouch for itself. Each key belongs to one registered agent, the scanner,
and is identified by the SHA-256 of its SPKI form, so two spellings of one key
are one key. `DELETE …/harness-scanner-keys/{keyId}` revokes a key; it then
verifies nothing, and its row stays for the scans it signed.

**What the ingest adds to the contract's refusals.** After the contract's own
checks pass:

| Code | Status | Cause |
|---|---|---|
| `SECRET_IN_REPORT` | 400 | A string member has the shape of a secret. The refusal names the member's path, never its value. |
| `SCANNER_MISMATCH` | 400 | `scan.scanner.agentId` is not the agent the signing key belongs to. |
| `SUBMITTER_MISMATCH` | 403 | The API key is bound to an agent other than that scanner. |
| `REPLAY` | 409 | A scan with this `scan.id` is already ingested for the tenant. |

Every refusal is reported as `harness_report_refused: <CODE>` and writes
nothing.

**What a verified report becomes.** One `AgentHarnessScan` (signer, digest of
the signed body, signature, the per-source completeness), one `DiscoveredAgent`
per agent keyed by `discoveredId`, and one `AgentHarnessScanItem` per agent.
The ingest DERIVES each agent's level with the ladder and its reach from its
tools, and links `registeredAgentId` only when the register holds that row; a
claimed id the register does not hold is treated as no link at all. An agent the
report links to nothing is linked by the register's own record when the
registration intake registered a row from it (`RegisteredAgent.intakeDiscoveredAgentId`)
and that row is live and not RETIRED; such a link resolves `SHADOW_AGENT` only
on a complete scan, and a report that names a different live row wins, with the
disagreement audited as `AGENT_INTAKE_LINK_CONFLICT` on the intake row. The
report's own `findings` member is not acted on: the ingest raises its own
findings, with `sourceKind = 'AGENT_HARNESS'`, from what it derived —
`SHADOW_AGENT`, `UNPINNED_WRITE_TOOL`, `HARNESS_SHORTFALL`, `LEVEL_DROP`,
`EMPTY_SCAN` and `INCOMPLETE_SOURCE` — and resolves one only on positive
evidence. An agent absent from a scan resolves nothing about it.
`ORPHAN_CREDENTIAL` is not derived from the agents' credentials, so the ingest
raises none.

**Accepting a shortfall.** A `HARNESS_SHORTFALL` closes when a later scan shows
the agent at the bar, or when the agent's owner records a time-limited
acceptance at `POST /api/t/{tenantSlug}/admin/agents/harness-acceptances`
(at most 365 days). The nightly exception expiry monitor reopens the shortfall
when the acceptance lapses and the agent is still below the bar. The bar is
report-only throughout: no level or acceptance gates an agent.

## Versioning

A change that adds, removes or reinterprets a member is a new contract id
(`inflect-agent-harness/2`). The verifier accepts exactly the id it was built
for.
