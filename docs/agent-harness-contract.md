# The `inflect-agent-harness` report contract (`/1` and `/2`)

How a harness scanner reports what it found in a client environment. A scanner
runs inside the client's perimeter, enumerates agent-shaped principals and the
harness each one runs under, and returns one signed report. This document is
normative: `MUST`, `MUST NOT`, `SHOULD` and `MAY` carry their RFC 2119 meanings.

Two contract ids are in force. `inflect-agent-harness/1` (#3660) is the first;
`inflect-agent-harness/2` (#3754) is `/1` plus five additions, and is what a
scanner built today emits. [The two ids](#the-two-ids) says what `/2` adds and
how the ingest holds each report to its own id.

`tests/helpers/agent-harness-fake-scanner.ts` is the **reference
implementation**. Where this prose and that file disagree, the file is the one
the suite validates against the schemas, so it is the one to copy. The schemas
and the verifier are `src/lib/agentic/harness-contract.ts`; the ladder that
scores the verdicts is `src/lib/agentic/harness-ladder.ts`.
`packages/agent-harness-scanner` is the deployable scanner (#3678). It emits
`/2`, builds its report against those schemas and refuses to sign one they
would refuse.
Putting a client estate under it, and the labels it reads owners and principals
from, is [`docs/agent-harness-scanner-onboarding.md`](agent-harness-scanner-onboarding.md).

## What the report may and may not say

- It reports **verdicts per criterion**, never a level. The receiving side
  derives the level with the harness ladder.
- It names credentials by **reference**, never by value.
- It reports each source as `COMPLETE` or `INCOMPLETE`. Whether the scan as a
  whole is complete is derived from its sources and is never declared.
- It carries **identifiers and pointers, not content**: no tool description
  text (the manifest hash stands for it), no prompt, no payload.
- It raises **no finding the receiving side acts on**. Its `findings` member is
  the scanner's own view. `/2`'s `unboundCredentials[]` is an observation, and
  the receiving side decides whether it is an `ORPHAN_CREDENTIAL`.

## The two ids

`/2` is `/1` with exactly these additions (owner decisions, 2026-10-19):

| Addition | Where | Why |
|---|---|---|
| The source kind `code` | `population.sources[].kind`, `agents[].discoveredVia[]`, `unboundCredentials[].sourceKind` | Agent definitions read from source code and configuration (#3737) |
| The INCOMPLETE reason `UNPARSEABLE` | `population.sources[].reason` | A source read a definition it could not resolve |
| The member `unboundCredentials[]` | the body | Credentials a source saw bound to no agent, from which the receiving side derives `ORPHAN_CREDENTIAL` (#3686) |
| Optional `calls` and `windowDays` on a tool | `agents[].tools[]` | How often the agent called the tool over the scan window (#3738 fills them) |
| Optional `models[]` | `agents[]` | The model endpoints the agent calls, by reference (#3737, #3738) |

Nothing in `/1` is removed or reinterpreted, and every `/1` bound is unchanged.
The two optional additions carry counts and references only: no input, no
output, no prompt — a model entry or a tool with any other member is refused.

**The transition rule.**

- The ingest verifies BOTH ids, through the same four steps in the same order:
  size, JSON, signature by a trusted key, then the strict schema. Only the last
  step differs, and the id that picks the schema is itself read only after the
  signature has verified. A deployed `/1` scanner keeps working.
- Each id has its OWN strict schema. A `/1` report that carries any `/2`
  addition — the member, the kind or the reason — MUST be refused (`SCHEMA`),
  never read as a `/2` report that forgot to say so. A `/2` report MUST carry
  `unboundCredentials`, empty when it saw none. An id the verifier does not
  accept is refused as `SCHEMA` without the refusal repeating it.
- A scanner SHOULD emit `/2`. A `/1` report has no member that speaks about
  unbound credentials, so it opens no `ORPHAN_CREDENTIAL` and closes none: its
  silence is not a statement that there are none.
- The ids the verifier accepts are `HARNESS_CONTRACT_IDS` in
  `src/lib/agentic/harness-contract-rules.ts`. Retiring `/1` is removing it from
  that list, a reviewed change made once no deployed scanner sends it. The
  owner set the moment on 2026-10-19: `/1` is retired at the release of the
  scanner container (#3686), the first deployment of the reference scanner,
  which emits `/2`.

## Signing and verification

The report is a JSON object: a body plus a `signature` member.

```json
{ "contract": "inflect-agent-harness/2", "scan": {}, "population": {}, "agents": [], "findings": [],
  "unboundCredentials": [],
  "signature": { "alg": "ed25519", "signerKey": "<hex or base64 raw public key>", "sig": "<hex or base64>" } }
```

A `/1` report is the same without `unboundCredentials`.

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
| `contract` | Exactly `inflect-agent-harness/1` or `inflect-agent-harness/2`. The rest of the body is held to that id's schema. |
| `scan.id` | The scanner's id for this run, unique per tenant. |
| `scan.asOf` | ISO 8601 time the scan describes. |
| `scan.scanner` | The scanner's own `agentId` in the register, its `version`, and the `sha256:` manifest hash of its own tool surface. |
| `population.sources[]` | One entry per source kind read: `kind`, `status`, `rows`, and `reason` exactly when `status` is `INCOMPLETE`. Each kind appears once. |
| `agents[]` | One entry per discovered agent, unique by `discoveredId`. |
| `findings[]` | Coded findings the scanner raises itself. |
| `unboundCredentials[]` | `/2` only, and required there: credentials a source saw bound to no discovered agent. See [Unbound credentials](#unbound-credentials). |

### Sources

`kind` is one of `entra-sp`, `okta-app`, `vault`, `mcp`, `runtime`, `cicd`,
`inflect-register`, and in `/2` also `code`. An `INCOMPLETE` source MUST name
one of `BYTE_CAP`, `TIME_BOX`, `AUTH_FAILED`, `UNREACHABLE`, `PAGINATION_TORN`,
`RATE_LIMITED`, and in `/2` also `UNPARSEABLE`. A `COMPLETE` source MUST NOT
carry a reason. A scanner MUST NOT drop a source it could not read: an unread
source is reported `INCOMPLETE`.

**The `code` source (`/2`).** Agent definitions a scanner reads from source code
and configuration, by static parsing only: it MUST NOT import or execute what it
reads. A location it cannot read is `INCOMPLETE` with the matching reason, and a
definition it read but could not resolve is `INCOMPLETE` `UNPARSEABLE`; neither
is left out. How it fills the members every source shares:

- `discoveredId` names where the definition is, e.g. `code:<path>#<name>`.
- A tool served from no server — one the agent defines in its own code, or a
  library tool it constructs there — has as its `server` the `code://` locator
  of that definition or construction: a URL that names where the tool is, which
  nothing on the receiving side follows. Its `readOnlyHint` is `null` unless
  the definition declares one: an undeclared hint counts as a write. A tool
  whose `server` is a `code://` locator is judged by a complete `code` read, not
  an `mcp` one (see **Transport**).
- A tool set the code fetches from an MCP server at run time is one entry per
  server: `server` is the server's URL (or, for a server the code starts as a
  local command, the `code://` locator of its configuration) and `name` is
  `<server key>:*`, every tool that server lists.
- A credential is a reference to where the value lives (`env://<NAME>` for an
  environment variable, `code://<path>#L<line>` for a literal written into the
  code). The value itself is never copied, whatever its shape.
- A model the definition calls is a `models[]` entry: its endpoint as an https
  URL, an `env://` reference to where the URL is configured, or, when neither is
  knowable, the `code://` locator of the model's construction.

### Agents

| Member | Meaning |
|---|---|
| `discoveredId` | Stable id in the source that found it, e.g. `entra:sp:<objectId>`. |
| `discoveredVia[]` | Every source kind that saw this agent. |
| `registeredAgentId` | The register's id when the agent is registered, else `null`. |
| `owner` | `{ kind: user \| group, id, source }`, or `null` when no owner is recorded anywhere. |
| `credentials[]` | `ref` (a `scheme://locator` reference), `ageDays`, `expires`, `boundToAgent`, and `grant`: `delegated`, `app-only` or `unknown`. |
| `tools[]` | `server` (URL), `name`, `manifestHash` (`sha256:` or `null`), `pinned`, and `readOnlyHint` as the server declares it. An undeclared hint counts as a write. In `/2` a tool MAY carry `calls`, the number of times the agent called it, with `windowDays`, the days it was counted over (1 to 366): both or neither. |
| `models[]` | `/2` only, optional. One entry per model endpoint the agent calls: `endpoint`, a `scheme://locator` (`https://api.openai.com/v1`, `env://AZURE_OPENAI_ENDPOINT`, `code://…`) or a bare host, and `model`, the model's id there or `null`. An endpoint MUST NOT carry userinfo or a secret's shape. |
| `skills[]` | `name`, `license` (or `null`), `declared`. |
| `verdicts[]` | `criterion` (an id from the harness ladder), `met`, and `evidence`: a pointer to where the scanner saw it, or `null`. |

A credential `ref` MUST match `scheme://locator` and MUST NOT contain a value
with the shape of a secret (a GitHub, AWS, Slack or OpenAI-style token, a JWT, a
private-key block, or a URL carrying a password: `scheme://user:password@host`). The same rule holds for **every** string in the report: the
contract checks credential references, and the ingest refuses a report in which
any other string member has a secret's shape (`SECRET_IN_REPORT`, under
Transport). A verdict with `met: true` and no evidence counts as not met.

### Unbound credentials

`/2` only. One entry per credential a source saw bound to no discovered agent:

| Member | Meaning |
|---|---|
| `ref` | A `scheme://locator` reference, under the same rules as an agent's credential `ref`: never a value, and never a secret's shape inside one. |
| `sourceKind` | The source kind that saw it. |

Each is checked against the rest of the report, and a report that contradicts
itself MUST be refused (`SCHEMA`):

- each (`sourceKind`, `ref`) pair appears once — the same reference seen by two
  sources is two entries;
- `sourceKind` is a source the report lists in `population.sources`;
- `ref` is held by no agent in the same report: "bound to no agent" and "this
  agent's credential" cannot both be true.

An entry from a source that stopped early is allowed — what was read is real —
but the receiving side acts only on entries whose source is `COMPLETE`, and opens
a finding only when every identity-bearing source the report lists is
`COMPLETE` too (see Transport).

### Findings

`code` is one of `SHADOW_AGENT`, `UNPINNED_WRITE_TOOL`, `ORPHAN_CREDENTIAL`,
`INCOMPLETE_SOURCE`; `severity` is `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`;
`discoveredId` and `evidence` are pointers or `null`. A scan that discovers no
agents is not a clean scan; the receiving side treats an empty population as a
finding in its own right. The receiving side does not act on this member: it
derives its own findings (see **Transport**), `ORPHAN_CREDENTIAL` included.

## Bounds

| Dimension | Maximum |
|---|---|
| Report size before parsing | 5 MiB |
| Sources | 50 |
| Agents | 5,000 |
| Credentials, tools, skills per agent | 100, 500, 100 |
| Findings | 20,000 |
| Unbound credentials (`/2`) | 10,000 |
| Model endpoints per agent (`/2`) | 50 |
| A tool's `calls` (`/2`) | 1,000,000,000 |
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
`EMPTY_SCAN`, `INCOMPLETE_SOURCE` and `ORPHAN_CREDENTIAL` — and resolves one
only on positive evidence. An agent absent from a scan resolves nothing about
it.

**`UNPINNED_WRITE_TOOL`: which read closes it.** A scan in which an agent has
no unpinned write tool closes the finding only when every source that could
have reported a missing tool was read in full (owner answer, 2026-10-19).
Which source that is follows the tool's `server`:

| A tool whose `server` is | Is judged by a complete read of |
|---|---|
| a `code://` locator: defined or constructed in the agent's code, or an MCP server the code starts as a local command (see [Sources](#sources)) | `code` |
| anything else: an MCP server's URL | `mcp` |

The finding closes only when the source of EVERY tool the report lists for the
agent was read in full, and, for a tool the report may have left out, the
source where it would have been: `code` for an agent discovered via `code`, and
`mcp` for an agent discovered via any other kind. So a complete `code` read
never closes an MCP-served tool, a complete `mcp` read never closes a
code-defined one, and an agent reported with no tools is not closed on nothing.
The derived reach is unaffected: an agent is `READ_ONLY` only when the `mcp`
source was read in full.

**`ORPHAN_CREDENTIAL` (`/2`).** Derived from `unboundCredentials[]` by the
planner (`src/lib/agentic/harness-findings.ts`), never from the report's
`findings`, and keyed by the scanner, the source kind and the reference
(`ORPHAN_CREDENTIAL:<scanner>:<kind>:<ref>`):

- it OPENS only when the source that saw the credential AND every
  identity-bearing source the report lists were read in full (owner answer,
  2026-10-19). "Unbound" means that no agent in the report holds the
  reference, and the agent that does hold it may be the part an incomplete
  identity-bearing source did not read. A kind the report does not list was not
  read at all, and holds nothing back;
- it CLOSES only when the same scanner read the same source in full and no
  longer saw the credential unbound — two scanners' `vault` sources can be two
  different vaults, so one scanner's read says nothing about the other's. An
  incomplete identity-bearing source can make a credential look unbound, never
  bound, so it does not hold a close back; but a credential the source still
  lists is never closed, whether or not that scan could open it;
- an absent or `INCOMPLETE` source closes nothing, and neither does a `/1`
  report. An incomplete identity-bearing source therefore opens nothing and
  closes nothing.

A source kind is **identity-bearing** when it can report the agent a credential
is bound to, by listing the credential among that agent's `credentials[]`. The
classification is `IDENTITY_BEARING_SOURCE` in the planner, a table over every
kind, so a kind added to the contract fails to compile until it is classified:

| Kind | Identity-bearing | Why |
|---|---|---|
| `entra-sp` | Yes | A service principal, and the password and key credentials it holds |
| `okta-app` | Yes | An app, and its client credentials and API tokens |
| `vault` | Yes | A credential, tagged with the principal it belongs to |
| `runtime` | Yes | A deployment, and the secrets it runs with. LangSmith's deployment listing carries them; a reader that declines to read them does not change what the kind can report |
| `cicd` | Yes | A pipeline identity, and the secrets its jobs receive |
| `inflect-register` | Yes | A registered agent, and the API keys that speak for it |
| `code` | Yes | An agent definition, and the credential references it reads |
| `mcp` | **No** | A scanner sends an MCP server `initialize` and `tools/list` only, and neither answer names a caller or holds a credential |

It is an `OBSERVATION` of `MEDIUM` severity, written through the same seam as
every harness finding.

**Call counts and model endpoints (`/2`).** A tool's `calls` and `windowDays`
are stored with the tool on the scan item (`AgentHarnessScanItem.toolsJson`), so
they round-trip and read back with it. No stored field holds a model endpoint:
`models[]` is verified with the rest of the report — schema, then the secret
scan over every string — and is not stored. That is the owner's answer of
2026-10-19: endpoints stay verify-only under this contract, and a column on the
scan item to hold them is a separate follow-up issue's change. Neither raises
or closes a finding.

**Accepting a shortfall.** A `HARNESS_SHORTFALL` closes when a later scan shows
the agent at the bar, or when the agent's owner records a time-limited
acceptance at `POST /api/t/{tenantSlug}/admin/agents/harness-acceptances`
(at most 365 days). The nightly exception expiry monitor reopens the shortfall
when the acceptance lapses and the agent is still below the bar. The bar is
report-only throughout: no level or acceptance gates an agent.

## Versioning

A change that adds, removes or reinterprets a member is a new contract id.
`inflect-agent-harness/2` is the first such change; the next one is `/3`. The
verifier accepts exactly the ids in `HARNESS_CONTRACT_IDS`, each against its own
strict schema, under the [transition rule](#the-two-ids). Stored scans do not
record the id they arrived under, so a stored source is re-read against every
kind and reason any accepted id can carry (`SOURCE_KINDS`,
`INCOMPLETE_REASONS`), and a client estate may declare exactly those kinds: the
database CHECK on `AgentHarnessEstateSource.kind` lists the same eight. The
migration that widened it for `code` (`20261019070000`) was kept as built by
the owner on 2026-10-19.
