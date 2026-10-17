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
private-key block). A verdict with `met: true` and no evidence counts as not
met.

### Findings

`code` is one of `SHADOW_AGENT`, `UNPINNED_WRITE_TOOL`, `ORPHAN_CREDENTIAL`,
`INCOMPLETE_SOURCE`; `severity` is `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`;
`discoveredId` and `evidence` are pointers or `null`. A scan that discovers no
agents is not a clean scan; the receiving side treats an empty population as a
finding in its own right.

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
| `SCHEMA` | The body breaks this contract; the refusal lists each issue. |

## Transport

This document defines the report and its verification. The route that receives
reports, and the tables it writes, are specified by step `1a` (#3665).

## Versioning

A change that adds, removes or reinterprets a member is a new contract id
(`inflect-agent-harness/2`). The verifier accepts exactly the id it was built
for.
