# `@inflect/agent-harness-scanner`

The reference harness scanner (#3678, owner decision of 2026-10-18 on that
issue). It runs inside a client's estate, reads that estate's sources
**read-only**, builds an `inflect-agent-harness/1` report
([`docs/agent-harness-contract.md`](../../docs/agent-harness-contract.md)),
signs it with an Ed25519 key the tenant registered, and posts it unchanged to
the tenant's ingest.

## Sources

One interface (`src/source.ts`), one adapter per product. A source that cannot
be read is reported `INCOMPLETE` with the contract's reason, never left out.

| Kind | Product | What it reads | Requests |
|---|---|---|---|
| `okta-app` | Okta | Service apps (OAuth clients with `application_type: service`) and API tokens, with their owners: an app's `profile.owner`, a token's `userId`. Every token is reported except the scanner's own, identified by id from `/api-tokens/current` | `GET /api/v1/apps`, `GET /api/v1/api-tokens/current`, `GET /api/v1/api-tokens` |
| `vault` | Azure Key Vault | Secrets and certificates tagged with the principal they belong to (`inflect-principal`), with an `owner` tag | `POST` the client-credentials token exchange to `login.microsoftonline.com`, then `GET /secrets`, `GET /certificates` |
| `runtime` | LangSmith | Tracing projects that called a tool in a bounded window, and deployments when the estate opts in, with each one's tools and their call counts. Aggregates only: no run is ever fetched | `GET /api/v1/sessions`; with `readDeployments`, `GET /v2/deployments` (`/api-host/v2/deployments` self-hosted) |

Azure Key Vault is the only vault adapter and LangSmith the only runtime
adapter. The `vault` and `runtime` kinds and the `product` field keep the
interface generic for the next one.

### LangSmith

Two kinds of agent, each identified by LangSmith's own id:

| Agent | Id | Reported when |
|---|---|---|
| A tracing project | `langsmith:project:<id>` | it recorded at least one tool call in the window, and no listed deployment writes to it |
| A deployment (LangSmith Deployment) | `langsmith:deployment:<id>` | the estate opted in with `"readDeployments": true`; then always, since a deployment is an agent server by existence |

A project that only called a model is counted in `rows` and reported as nothing,
and an evaluation experiment is not listed. A deployment's tools are those its
tracing project recorded.

**Deployments are opt-in** (owner decision, 2026-10-19). LangSmith's
deployments listing carries each deployment's `secrets`, name and value, so by
default the scanner never requests it and reads projects only. An estate that
wants its deployments listed sets `"readDeployments": true`, and the scanner
then receives that listing, keeps each deployment's id and tracing project, and
drops the rest with the page.

**Tool usage is an aggregate.** The projects listing is asked for its stats over
the window (`windowDays`, 7 by default, at most 30), filtered to tool runs: the
count of tool calls, and the run facets that split it by tool name. Each tool is
reported with `server` set to the project its calls were traced in
(`langsmith://<host>/projects/<id>`), `manifestHash: null`, `pinned: false` and
`readOnlyHint: null`, because LangSmith records no definition, pin or hint. The
contract counts an undeclared hint as a write, so the ingest raises
`UNPINNED_WRITE_TOOL` for every agent that called a tool. The call counts have no
member in `inflect-agent-harness/1`; the log line reports their total
(`toolCalls`). A tool name that is not a plain identifier, such as a run name set
at call time, is reported as a digest (`tool-sha256:<16 hex>`).

**Completeness is proven.** The facets must account for every call the count
records, or the read is `PAGINATION_TORN`: a facet list cut short is never
reported as the whole. So is a page cut short, absent stats, and a project listed
twice across offsets. A rejected or expired key is `AUTH_FAILED`, a host that
cannot be reached `UNREACHABLE`, and a refusal from LangSmith's rate limiter
`RATE_LIMITED`. A window with no tool call and no deployment reports no agent,
and the ingest raises `EMPTY_SCAN` for a scan that found none.

**What is never kept.** Both listings return more than the source reads: a
deployment's `secrets` and source configuration, a project's description and
metadata, and facets over run tags and metadata. Only ids, a deployment's
tracing project, and a project's tool-call count and tool-name facets are read.

The endpoint paths are one table, `LANGSMITH_READ_PATHS` in
`src/sources/langsmith.ts`. The paths and query parameters are in LangSmith's
published OpenAPI documents. The members of one run facet (`key`, `value`, `n`)
are not documented there, and a facet that does not read as a count stops the
read rather than being skipped. Before the first estate scans a real workspace,
one dry run confirms the outcome
([onboarding, section 4](../../docs/agent-harness-scanner-onboarding.md#4-the-scanner-configuration-and-its-schedule)).

### The labelling conventions

These are the documented defaults (owner decision, 2026-10-19). Each can be
overridden for one estate in its configuration:

| What | Default | Override |
|---|---|---|
| An Okta service app's owner | the app's `profile.owner` | `ownerProfileKey` on the `okta-app` source |
| The principal a Key Vault secret or certificate belongs to | the tag `inflect-principal`, holding the principal's id (`okta:app:<id>`, `entra:sp:<objectId>`, …) | `principalTag` on the `vault` source |
| A Key Vault credential's owner | the tag `owner` | `ownerTag` on the `vault` source |

Onboarding a client estate end to end, with these conventions, is
[`docs/agent-harness-scanner-onboarding.md`](../../docs/agent-harness-scanner-onboarding.md).

What the sources never do:

- **Write.** A source holds a `ReadOnlyHttp`, whose only verb is a GET. The token
  exchange is the one POST, to the identity provider, behind its own interface.
- **Read a secret's value.** Neither `GET /api/v1/apps/{id}/credentials/secrets`
  (Okta returns client secrets there) nor `GET {vault}/secrets/{name}` is
  called. Credentials are reported by reference (`okta://…`, `azure-kv://…`).
  One listing the scanner can call carries values it never reads: LangSmith's
  deployments listing documents each deployment's `secrets`, name and value. It
  is requested only when the estate opts in (`readDeployments`); the source then
  reads a deployment's id and tracing project and nothing else, and the tests
  hold a marker in that member out of the report and the log.
- **Read a run.** No LangSmith run, trace or run content is fetched: not
  `GET /api/v1/runs/{id}`, not `POST /api/v1/runs/query`. Tool usage comes from
  the projects listing's aggregates.
- **Link to the register.** `registeredAgentId` is always `null` from these
  sources: a label in the estate being scanned is something its administrator can
  write. The register is the `inflect-register` source's (#3686).
- **Leave their origin.** Every request is https, on the configured host, with
  redirects refused; a next-page link anywhere else ends the read as
  `PAGINATION_TORN`. Each source has a time box and a byte budget.

`src/scanner-surface.ts` declares every request the scanner can make, and its
hash is the report's `scan.scanner.manifestHash`. The tests hold every request
the HTTP fakes see to that declaration.

## What it may import

Itself; Node's built-ins; `zod`; the wire contract from the application —
`@/lib/agentic/harness-contract`, `@/lib/agentic/harness-findings`,
`@/lib/agentic/harness-ladder` and `@/lib/canonical-json`; and the application's
pure CIDR parser, `@/lib/security/cidr`, so a private-range allowlist parses
exactly as the application's egress allowlist does. Nothing else:
`eslint.config.mjs` refuses any other `@/` import from `src/`, and any
`@prisma/*`, `next` or `@inflect/ui` import, at error level. Sharing the contract
is deliberate. The scanner checks its report against the ingest's own schema and
secret-shape scan **before** it signs, and signs the message the ingest
verifies, through one function rather than a copy.

## Configuration

One JSON file per estate. Strict: an unknown key is an error. No credential is
ever in the file; each is named by the environment variable that holds it, and a
secret-shaped string anywhere in the file is refused by path.

```json
{
  "estate": "acme-prod",
  "scanner": { "agentId": "<the scanner's register id>", "signingKeyEnv": "SCANNER_SIGNING_KEY" },
  "inflect": { "baseUrl": "https://inflect.example.com", "tenantSlug": "acme", "apiKeyEnv": "INFLECT_INGEST_KEY" },
  "schedule": { "everyHours": 24 },
  "sources": [
    { "kind": "okta-app", "orgUrl": "https://acme.okta.com", "apiTokenEnv": "OKTA_API_TOKEN" },
    {
      "kind": "vault", "product": "azure-key-vault",
      "vaultUrls": ["https://acme-agents.vault.azure.net"],
      "directoryTenantId": "<Entra tenant id>", "clientId": "<app id>",
      "clientSecretEnv": "AZURE_CLIENT_SECRET"
    },
    {
      "kind": "runtime", "product": "langsmith",
      "endpoint": { "cloud": "eu" },
      "apiKeyEnv": "LANGSMITH_API_KEY",
      "workspaceId": "<workspace id>", "windowDays": 7
    }
  ]
}
```

A self-hosted LangSmith names its own host instead:
`"endpoint": { "selfHosted": "https://langsmith.acme.example" }`, with
`"egressPrivateCidrAllowlist": ["10.20.0.0/16"]` beside it when that host is on
the estate's own network (below). Add `"readDeployments": true` to list
deployments as well; leave it out for a LangSmith that runs no deployment
control plane.

- `SCANNER_SIGNING_KEY`: the Ed25519 private key, PKCS#8 PEM. Register its
  public half at `POST /api/t/{slug}/admin/agents/harness-scanner-keys`
  (`public-key` prints it).
- `INFLECT_INGEST_KEY`: an API key with the `admin:harness_ingest` scope and no
  other.
- `OKTA_API_TOKEN`: an SSWS token for a read-only administrator.
- `AZURE_CLIENT_SECRET`: an Entra application holding `Key Vault Reader` on each
  vault, which reads metadata and cannot read a secret's contents.
- `LANGSMITH_API_KEY`: a LangSmith service key holding the workspace Viewer
  role, where the workspace can assign one; otherwise the key carries its
  issuer's rights and the GET-only wire is what keeps the read read-only.
  `workspaceId` is sent as `X-Tenant-Id`; leave it out for a key scoped to one
  workspace.

Okta orgs must be on `*.okta.com` or `*.oktapreview.com`, vaults on
`*.vault.azure.net`, LangSmith on `api.smith.langchain.com` (`"cloud": "us"`) or
`eu.api.smith.langchain.com` (`"cloud": "eu"`), and the ingest on https.

A self-hosted LangSmith is the one host the configuration lets a person type, so
it is checked the way the application checks any customer-named host
(`src/customer-host.ts`, after the `publicOrigin` rule kind): it must be a bare
https origin, not a literal private, loopback or link-local address, not
`localhost` or a metadata name, and not a `.local` or `.internal` name. Before
every request the scanner resolves the host again and refuses to send the key
if any address it resolves to is private, so a name repointed after the file was
written stops the read as `UNREACHABLE`.

**A self-hosted LangSmith on the estate's own network** names the private ranges
its host may resolve into, in `egressPrivateCidrAllowlist` on the `selfHosted`
endpoint. This mirrors the application's self-hosted egress allowlist
(`EGRESS_PRIVATE_CIDR_ALLOWLIST`, #3328), and keeps its three properties:

- It is the estate's own file. No tenant column, form or route reaches it.
- Metadata, loopback and link-local stay refused inside it: `127.0.0.0/8`,
  `0.0.0.0/8`, `169.254.0.0/16`, `::1`, `::` and `fe80::/10` are checked before
  the allowlist, so even `0.0.0.0/0` cannot reach `169.254.169.254`. The blocked
  names stay refused too.
- It widens which addresses are acceptable and removes no other check. The host
  is still resolved before every request with every address tested, so a name
  that resolves outside the listed ranges sends nothing.

With an allowlist, an internal name such as `langsmith.corp.internal` is
accepted, because the question becomes the address rather than the name. Each
entry must be a CIDR, or the configuration is refused.

## Running

```bash
npx tsx packages/agent-harness-scanner/src/cli.ts public-key --config estate.json
npx tsx packages/agent-harness-scanner/src/cli.ts scan --config estate.json --dry-run
npx tsx packages/agent-harness-scanner/src/cli.ts scan --config estate.json
npx tsx packages/agent-harness-scanner/src/cli.ts schedule --config estate.json
```

`schedule` scans at once and then every `schedule.everyHours`, anchored to each
run's start. A failed run is logged and the schedule continues. The tenant
declares the same cadence on the estate
(`POST /api/t/{slug}/admin/agents/harness-estates`), and the harness tab on
`/agents/reports` shows the estate as stale once its last complete scan is older
than one and a half cadences.

The log is one JSON line per event on stderr, with kinds and counts only. A
string with a secret's shape is replaced before it is written.

The container that runs this in a client's estate, and the Entra, MCP and
register sources, are #3686.
