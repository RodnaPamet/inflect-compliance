# `@inflect/agent-harness-scanner`

The reference harness scanner (#3678, owner decision of 2026-10-18 on that
issue). It runs inside a client's estate, reads that estate's sources
**read-only**, builds an `inflect-agent-harness/3` report
([`docs/agent-harness-contract.md`](../../docs/agent-harness-contract.md)),
signs it with an Ed25519 key the tenant registered, and posts it unchanged to
the tenant's ingest. The ingest accepts `/2` and `/3`. `/3` adds the `gcp-sa`
source kind (#3785). `/1` was retired with this scanner's container (#3686), so a
scanner built before #3754 is refused and must be rebuilt from this package.

## Sources

One interface (`src/source.ts`), one adapter per product. A source that cannot
be read is reported `INCOMPLETE` with the contract's reason, never left out.

| Kind | Product | What it reads | Requests |
|---|---|---|---|
| `entra-sp` | Entra (#3686) | Service principals of applications registered in the directory, and managed identities, with the credentials on each principal and its application registration, by reference, and their owners. Microsoft's own applications and disabled principals never; third-party applications only when the estate opts in | `POST` the client-credentials token exchange to `login.microsoftonline.com` for the Graph audience, then `GET /v1.0/applications`, `GET /v1.0/servicePrincipals` on `graph.microsoft.com` |
| `mcp` | MCP servers (#3686) | Each configured server's tools, by name, with a hash of each definition, the server's `readOnlyHint`, and whether the estate's pin matches the live listing. Reported against the agents the configuration lists for the server, and in place of a `code` agent's `<key>:*` placeholder for the same URL | `POST` to each configured endpoint: `initialize`, `notifications/initialized`, `tools/list`. Never `tools/call` |
| `inflect-register` | The scanner's own tenant (#3686) | Each live registered agent: its owner, its own API keys by reference, and the verdicts the register can evidence; and each principal a person confirmed as an agent, linked to it. The only source that links to the register | `POST` to the ingest host's `/api/mcp`: `initialize`, `notifications/initialized`, and one `tools/call` of `get_harness_register` |
| `okta-app` | Okta | Service apps (OAuth clients with `application_type: service`) and API tokens, with their owners: an app's `profile.owner`, a token's `userId`. Every token is reported except the scanner's own, identified by id from `/api-tokens/current` | `GET /api/v1/apps`, `GET /api/v1/api-tokens/current`, `GET /api/v1/api-tokens` |
| `vault` | Azure Key Vault | Secrets and certificates tagged with the principal they belong to (`inflect-principal`), with an `owner` tag | `POST` the client-credentials token exchange to `login.microsoftonline.com`, then `GET /secrets`, `GET /certificates` |
| `runtime` | LangSmith | Tracing projects that called a tool in a bounded window, and deployments when the estate opts in, with each one's tools and their call counts. Aggregates only: no run is ever fetched | `GET /api/v1/sessions`; with `readDeployments`, `GET /v2/deployments` (`/api-host/v2/deployments` self-hosted) |
| `cicd` | GitHub Actions (#3784) | Each workflow file on each configured repository's default branch that holds a secret, whose run token may write, or that reaches secrets dynamically; its secrets and run token by reference. The repository's Actions secrets by name, and each one no workflow references, as unbound | `GET /repos/{owner}/{repo}`, `GET /repos/{owner}/{repo}/contents/.github/workflows`, `GET …/contents/.github/workflows/{file}`, `GET /repos/{owner}/{repo}/actions/secrets` on `api.github.com` |
| `gcp-sa` | Google Cloud IAM (#3785) | Each enabled service account in each configured project, by its numeric id, with its enabled user-managed keys by reference. Never its e-mail address, display name or description; never the scanner's own account | `POST` the JWT-bearer token exchange to `oauth2.googleapis.com`, then `GET /v1/projects/{project}/serviceAccounts` and `GET /v1/projects/{project}/serviceAccounts/{account}/keys?keyTypes=USER_MANAGED` on `iam.googleapis.com` |
| `code` | LangChain and LangGraph (#3737), the Claude Agent SDK (#4156) | Agent definitions in the Python, JavaScript and TypeScript files under the configured roots: each agent's tools, the model endpoints it calls and the credentials those reference, by reference; for an Agent SDK agent, the options that fail a ladder criterion | None. Local reads only (`lstat`, `readdir`, `readFile`) |

### Entra

Which service principals are agents is the owner's decision of 2026-10-19 on
#3686: an `Application` principal whose application is registered in this
directory (`appOwnerOrganizationId` is the configured `directoryId`), and every
`ManagedIdentity`. A third-party application's principal is reported only with
`"includeThirdPartyApplications": true`, and Microsoft's first-party
applications never are. A disabled principal is counted in `rows` and reported
as nothing.

Each is `entra:sp:<objectId>`. Its credentials are the password and certificate
credentials on its application registration and on the principal itself,
referenced as `entra://<directoryId>/applications/<appId>/password/<keyId>` (or
`…/certificate/…`, or `…/servicePrincipals/<id>/…`), with their age and expiry.
A certificate whose `usage` is `Sign`, such as a SAML signing certificate, is not
a credential the principal signs in with, and is left out. Its owner is the
first user, by object id, among the registration's owners, else the principal's.
`H2.credential_bound` is reported met when it holds a credential of its own or is
a managed identity. The grant kind is not reported: whether a credential acts
for a person depends on the permissions granted to it, which the source does not
read, so every credential's `grant` is `unknown`.

A credential on an application registration that has no service principal in
the directory signs in as nothing there. It is reported in `/2`'s
`unboundCredentials[]`, and only after both listings were read in full.

Graph returns each password credential's `hint`, the first characters of the
secret, and free-text display names, with the members the source asks for.
Neither is read; both are dropped with the page, and the tests hold a marker in
each out of the report and the log.

### MCP

Each configured server is asked what it serves and nothing else: `initialize`,
the one-way `notifications/initialized` the protocol requires, then
`tools/list`, paged by cursor (DPIA condition 1, as amended by owner decision 5
on #3686). The wire the source holds has two functions, `open` and `listTools`,
and no method parameter, so it cannot spell `tools/call`. A JSON body and a
Server-Sent Events stream are both read, under the byte cap, and a stream is
cancelled as soon as the answer arrives.

A tool is reported with:
- its name, by digest when it is not an identifier;
- the server's configured URL;
- `readOnlyHint` as the server's annotations declare it, else `null`, which the
  contract counts as a write;
- `manifestHash`, SHA-256 over the canonical JSON of the definition as served.
  The definition's text never leaves the source; the hash stands for it.
- `pinned`, true only when the server's `pinnedManifestHash` equals the hash of
  its whole listing read live: SHA-256 over each tool's name and hash, in name
  order. The scanner logs each server's listing hash (`mcp server read`), which
  is the value to pin.

Neither answer names a caller, so a server's tools reach an agent two ways (owner
decision 2):
- the agents the configuration lists for the server, by `discoveredId`;
- a `<key>:*` placeholder another source reported at the same URL, which the
  `code` source does for a tool set its agent fetches at run time. The report
  builder replaces it with the server's tools and adds `mcp` to the agent's
  `discoveredVia`, but only for a server read in full. A partial read replaces
  nothing, and the placeholder stays, counting as a write.

A server may take a read token (owner decision 6): `readTokenEnv`, sent as a
bearer token with the three messages above and nothing else. For Inflect's own
`/api/mcp` it is an API key holding `mcp:read` and no other MCP scope. A
configured token missing from the environment leaves that server unread
(`AUTH_FAILED`), and the other servers are still read.

Each server is a host the customer names, so it is checked as the self-hosted
LangSmith is: at configuration, and again before every request, with an optional
`egressPrivateCidrAllowlist` per server. The source is complete only when every
server was read to the end of its listing.

### The register

The scanner's own tenant's register, read through the one MCP tool the scanner
may call (DPIA condition 2, as amended by owner decision 7 on #3686):
`get_harness_register`, on the ingest host's `/api/mcp`, with the ingest key. The
key needs `mcp:read` beside `admin:harness_ingest`, and the scanner agent must be
granted the tool (owner decision 3). The source takes no configuration field:
`{ "kind": "inflect-register" }`.

Per live registered agent (not deleted, not `RETIRED`, not a legacy placeholder),
it reports (owner decision 4):
- each principal a person confirmed as the agent, as that principal's own id
  (`entra:sp:<objectId>`), linked to the agent, so the Entra source's
  observation of it merges with this one. An agent with no confirmed principal
  is `inflect:agent:<id>`.
- its owner, an Inflect user id;
- its own live API keys, as
  `inflect://<host>/t/<slug>/api-keys/<id>`, bound to the agent and `app-only`;
- `H1.registered`, `H1.owner`, `H1.axes_declared`, `H1.tier_scored_fresh` (a
  scored tier whose newest assessment is not stale), `H2.tools_allowlisted`
  (deny-by-default grants) and `H2.policy_card`. `H2.credential_bound` and
  `H2.grant_kind_declared` are reported only when the agent has a key of its
  own, so the register's silence never outvotes another source that sees the
  credential. `H2.audience_tokens` is not claimed.

It is the only source whose `registeredAgentId` reaches the report. A register
larger than one read returns is read as far as it goes and reported `BYTE_CAP`.

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
`UNPINNED_WRITE_TOOL` for every agent that called a tool. The call counts are not
in the report: `inflect-agent-harness/2` has a member for them (`calls`, with
`windowDays`), which a follow-up of #3738 fills, and until then the log line
reports their total (`toolCalls`). A tool name that is not a plain identifier, such as a run name set
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

### GitHub Actions

Decision 10 puts CI/CD in the pilot (#3784). A workflow runs unattended, holds
credentials, and those credentials reach production, so it is an agent-shaped
principal. The source reads what each configured repository declares about its
workflows, with a fine-grained token holding **Contents: read** and **Secrets:
read** and nothing else. Secrets: read lists names; GitHub has no read of a
secret's value.

| Agent | Id | Reported when |
|---|---|---|
| A workflow file | `github:workflow:<owner>/<repo>/<file>` | it references a repository, organisation or environment secret; or any job's token may write (a `write` scope, `write-all`, or no `permissions:` at all, which takes a repository default the source does not read); or it reaches secrets dynamically |

A workflow that only reads and holds no secret is counted in `rows` and
reported as nothing.

**What a workflow holds,** by reference and never by value:

- its run token, `github-token://github.com/<owner>/<repo>/.github/workflows/<file>`:
  bound, app-only, minted for each job and expiring with it;
- an OIDC token, `github-oidc://…`, when a job may mint one (`id-token: write`
  or `write-all`): the identity a workflow federates into a cloud with;
- each secret it references, `github-secret://github.com/<owner>/<repo>/<NAME>`,
  aged from the listing's `updated_at`. A repository secret is readable by every
  workflow in the repository, so it is reported as not bound to this one. A
  secret the repository's listing does not hold (an organisation's or an
  environment's) is reported with its age unknown.

**What counts as a reference** is an expression only: the inside of a
`${{ … }}` span, or a whole `if:` value. A script that mentions `secrets.FOO` in
its text holds nothing. Names compare upper-case, as GitHub's do.

**Dynamic access** is a computed index (`secrets[matrix.key]`), the whole
context (`toJSON(secrets)`), or `secrets: inherit` on a call to a workflow in
another repository. Such a workflow is a principal whatever else it holds, its
`H2.credential_bound` is evidenced false, and no secret of that repository is
reported unbound. `secrets: inherit` on a call to a workflow in the same
repository hides nothing, because the callee's own file is read.

**Verdicts** come from the file:

- `H2.credential_bound` is false when the workflow holds a secret or reaches
  secrets dynamically. When its only credentials are the run's own, it is true,
  and so is `H2.grant_kind_declared`.
- `H2.tools_allowlisted` is true when every job's token scope is an explicit
  `permissions:` map, and false otherwise, naming the first job that is not.
  `read-all` and `write-all` are not allowlists.

**Unbound secrets.** A repository secret that no workflow file references is
reported in `unboundCredentials[]`, and the ingest raises `ORPHAN_CREDENTIAL`.
This happens only when every workflow file was read and parsed and none reaches
secrets dynamically: "referenced by no file I read" is evidence only when there
is no file the source could not read.

**Completeness.**

- A repository the token cannot see answers 404 at `GET /repos/{owner}/{repo}`,
  and the read is `UNREACHABLE`, never zero workflows. A 404 on the
  workflow directory, asked only after the repository answered, is zero
  workflows.
- A directory listing at GitHub's 1,000-entry cap, or a file GitHub serves
  without content (over 1 MB) or over 512 KiB decoded, is `BYTE_CAP`.
- A secrets listing whose `total_count` changes between pages, or does not match
  the secrets read, is `PAGINATION_TORN`.
- A file that is not one YAML document with a `jobs` mapping, or that declares
  a `permissions:` value other than `read-all`, `write-all` or a map of `read`,
  `write` and `none`, is `UNPARSEABLE`. The other files are still reported, and
  that repository reports no unbound secret.

The YAML is parsed by `js-yaml` under its safe core schema: no type construction,
at most 1,000 aliases, and 100 levels of nesting.

**Not read:** organisation and environment secret listings, CODEOWNERS (a
workflow's owner is reported `null`, which the ingest reads as unowned), and
GitHub Enterprise Server.

### Google Cloud service accounts

`/3`'s `gcp-sa` kind (#3785, owner decision 2026-10-19). A service account acts
as itself: a workload attached to it, or anyone holding one of its keys, calls
Google's APIs with its authority and no person in the loop. Every enabled
account in each configured project is reported:

| Agent | Id | Reported when |
|---|---|---|
| A service account | `gcp:sa:<uniqueId>` | it is enabled and is not the account the scanner authenticates as. The project's default accounts (Compute Engine's, App Engine's) are in the listing and are reported; Google-managed service agents are not in it |

**Its credentials are its user-managed keys,** each
`gcp-sa-key://<project>/<uniqueId>/<keyId>`:
- bound to the account, app-only;
- aged from `validAfterTime`;
- expiring when `validBeforeTime` is not Google's `9999` "never".

A disabled key authenticates nothing and is not reported. An account with no
user-managed key reports none, because its tokens are minted by Google for the
workload it is attached to and never leave Google. Google returns key metadata
only: there is no read of a private key after it was created.

**The scanner's own account** is identified by the `client_email` of the key it
signs with, the account Google authenticated it as, and is not reported. This is
the Okta source's rule for its own token.

**What is never kept.** The listing returns each account's e-mail address,
display name and description, any of which can name a person. A principal is
its numeric id, so none of them reaches the report, and a test holds a marker in
each out of the result.

**Authentication** is the OAuth 2.0 JWT-bearer grant (RFC 7523):
- The source signs a ten-minute RS256 assertion with the key, and exchanges it
  at `oauth2.googleapis.com/token`.
- That endpoint is a constant. The key file's own `token_uri` is never used: a
  key file is the one input that names a host, and it is not trusted to.
- The scope is `cloud-platform`, because the IAM API takes no read-only scope.
  What keeps the read read-only is the account's role,
  `roles/iam.serviceAccountViewer` (lists accounts and key metadata, changes
  neither), and the GET-only wire.

**Completeness.**
- A key file that does not parse, or cannot sign, is `AUTH_FAILED` before any
  request.
- A refused assertion or a project the account cannot read is `AUTH_FAILED`.
- An account with no usable id, an account listed twice, a key with no usable
  id, or a key listing that claims to be paged is `PAGINATION_TORN`.
- An empty project (Google omits the empty collection) is read in full with zero
  rows.

**Not read:** role bindings (`getIamPolicy` is a POST, and the wire has no verb
for it), an owner (an account carries none, so each is reported unowned), and
any project the configuration does not list.

### The `code` source

`src/sources/langchain.ts` reads the roots it is given and recognises:

- LangChain's agent factories (`create_tool_calling_agent`, `create_react_agent`,
  `initialize_agent`, `createToolCallingAgent`, …) and the `AgentExecutor` that
  wraps one, reported once;
- LangGraph's prebuilt `create_react_agent` / `createReactAgent`, and a
  compiled `StateGraph` that has a `ToolNode` or binds tools to a model;
- their tools — `@tool` functions, `Tool(...)`, `tool()`,
  `DynamicStructuredTool`, prebuilt tool and toolkit classes, and an MCP
  client's servers (`MultiServerMCPClient`), each as `<server>:*`;
- their chat models (`ChatOpenAI`, `ChatAnthropic`, `init_chat_model`, a
  `provider:model` string, …) with the endpoint each calls;
- the credentials those take, as `env://NAME` or, for a value written into the
  code, `code://<label>/<path>#L<line>` — never the value;
- Claude Agent SDK agents (#4156): `query` from `@anthropic-ai/claude-agent-sdk`,
  and `query` or `ClaudeSDKClient` from `claude_agent_sdk`, with their options,
  plus a Python `ClaudeAgentOptions` that no such call in its file consumes.
  Each agent's tools are the built-ins `tools` turns on (every built-in when it
  is left out), less `disallowedTools`, plus each `mcpServers` entry as
  `<server>:*` and each `mcp__<server>__<tool>` that `allowedTools` approves on
  a server the options configure. Its model is Anthropic's endpoint, or
  `ANTHROPIC_BASE_URL` from its `env`, and its key is the `env` entry that
  names one or else `ANTHROPIC_API_KEY`.

Every name is resolved through the file's own imports: only what is imported
from a `langchain`, `langgraph` or Claude Agent SDK module counts, and a file
that names none of those modules is not parsed at all.

An Agent SDK agent's options also become verdicts, as the owner mapped them
(#4156, 2026-10-29; `AGENT_SDK_OPTION_CRITERIA` in
`src/lib/agentic/harness-findings.ts`). Each is NOT MET with the option's
`code://` locator as evidence:
- `bypassPermissions` fails `H3.propose_not_commit`;
- host settings loaded fail `H3.skills_declared` and `H2.tools_allowlisted`;
- an `allowedTools` wildcard fails `H2.tools_allowlisted`;
- a callable `Bash` or `WebFetch` fails `H2.tools_allowlisted`;
- no hook, with `settingSources: []`, fails `H3.payloads_guarded`.

Nothing is ever MET from code, and an option the reader could not resolve
concludes nothing. Python is read by a bounded
tokenizer and expression reader (`src/sources/code/python.ts`); JavaScript and
TypeScript by TypeScript's syntax-only parser (`src/sources/code/javascript.ts`).
Neither imports, evaluates or spawns anything, and `eslint.config.mjs` refuses
`child_process`, `vm`, `worker_threads`, `require()`, `import()` and `eval` in
those files. A file that does not parse, or a definition built from something the
reader cannot see — a tool list returned by a function, a model passed in as a
parameter, `**kwargs` — makes the source `INCOMPLETE` `UNPARSEABLE`, and the
agent is still reported with what resolved.

Each agent's model endpoints go into `/2`'s optional `models[]`: the https URL,
the `env://` reference it is read from, or, when neither is knowable, the
`code://` locator of the model's construction. The ingest verifies them and
keeps them on the agent's scan item (#3759), and the harness matrix lists them.

**Unbound credentials.** `/2`'s `unboundCredentials[]` lists credential
references a source saw bound to no principal, from which the ingest derives
`ORPHAN_CREDENTIAL`. A source returns them on its read
(`SourceRead.unboundCredentials`), and the report builder drops any reference a
principal in the merged population holds. Entra returns the credentials of an
application registration with no service principal in the directory. Okta and
Key Vault report every credential against the principal it belongs to, so
neither returns one. Nor does the `code` source: a reference in code that no
agent uses is not evidence that a credential exists.

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
- **Link to the register.** Only the `inflect-register` source's
  `registeredAgentId` reaches the report; the builder drops the member from any
  other source, because a label in the estate being scanned is something its
  administrator can write.
- **Leave their origin.** Every request is https, on the configured host, with
  redirects refused; a next-page link anywhere else ends the read as
  `PAGINATION_TORN`. Each source has a time box and a byte budget.
- **Run what they read.** The `code` source parses text. It follows no symbolic
  link, caps each file at 1 MiB and the whole read at 20,000 files and 128 MiB,
  and stops at the scan's deadline, reporting each as its reason.

`src/scanner-surface.ts` declares every request the scanner can make, and its
hash is the report's `scan.scanner.manifestHash`. The tests hold every request
the HTTP fakes see to that declaration.

## What it may import

Itself; Node's built-ins; `zod`; `typescript`, whose syntax-only parser the
`code` source reads JavaScript and TypeScript with (already the repository's own
dependency, and needed by `tsx`, which runs the scanner; the scanner container,
#3686, installs a pinned version of it, owner answer 2026-10-19); `js-yaml`,
which the `cicd` source reads workflow files with (already the repository's own
dependency, #3784); the wire
contract from the application —
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
    {
      "kind": "entra-sp", "directoryId": "<Entra directory id, a GUID>",
      "clientId": "<app id>", "clientSecretEnv": "ENTRA_CLIENT_SECRET"
    },
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
    },
    {
      "kind": "cicd", "product": "github-actions",
      "repositories": ["acme/payments-api", "acme/infra"],
      "tokenEnv": "GITHUB_READ_TOKEN"
    },
    {
      "kind": "gcp-sa", "product": "gcp-iam",
      "projects": ["acme-prod", "acme-data"],
      "keyEnv": "GCP_SCANNER_KEY"
    },
    {
      "kind": "code", "product": "langchain",
      "roots": [{ "label": "support-bot", "path": "/estate/repos/support-bot" }]
    },
    { "kind": "inflect-register" },
    {
      "kind": "mcp",
      "servers": [
        {
          "label": "crm", "url": "https://mcp.acme.example/crm/mcp",
          "agents": ["entra:sp:<objectId>"],
          "pinnedManifestHash": "sha256:<the listing hash from the log>",
          "readTokenEnv": "MCP_CRM_TOKEN"
        }
      ]
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
- `INFLECT_INGEST_KEY`: an API key bound to the scanner agent, with the
  `admin:harness_ingest` scope, and `mcp:read` when the estate reads the register
  (`inflect-register`), and no other. The scanner agent must then be granted the
  tool `get_harness_register`.
- `ENTRA_CLIENT_SECRET`: an Entra application holding the Microsoft Graph
  application permission `Application.Read.All`, which lists registrations and
  service principals and cannot change them. Add
  `"includeThirdPartyApplications": true` to report third-party applications
  consented into the directory as well.
- `OKTA_API_TOKEN`: an SSWS token for a read-only administrator.
- `MCP_CRM_TOKEN` (any name, per server, optional): a READ token for that MCP
  server. For Inflect's own `/api/mcp`, an API key holding `mcp:read` and no
  other MCP scope. It is sent with `initialize`, the initialized notification
  and `tools/list`, and nothing else.
- `AZURE_CLIENT_SECRET`: an Entra application holding `Key Vault Reader` on each
  vault, which reads metadata and cannot read a secret's contents.
- `LANGSMITH_API_KEY`: a LangSmith service key holding the workspace Viewer
  role, where the workspace can assign one; otherwise the key carries its
  issuer's rights and the GET-only wire is what keeps the read read-only.
  `workspaceId` is sent as `X-Tenant-Id`; leave it out for a key scoped to one
  workspace.
- `GITHUB_READ_TOKEN`: a fine-grained personal access token, or a GitHub App
  installation token, limited to the listed repositories and holding the
  repository permissions **Contents: read** and **Secrets: read**, and no other.
- `GCP_SCANNER_KEY`: the JSON key file of a service account holding
  `roles/iam.serviceAccountViewer` on the listed projects, and no other role.

Entra is read from `graph.microsoft.com`, Okta orgs must be on `*.okta.com` or `*.oktapreview.com`, vaults on
`*.vault.azure.net`, LangSmith on `api.smith.langchain.com` (`"cloud": "us"`) or
`eu.api.smith.langchain.com` (`"cloud": "eu"`), GitHub on `api.github.com`,
Google Cloud on `iam.googleapis.com` with its token from `oauth2.googleapis.com`,
and the ingest on https.
A `code` root is an absolute path with no `..` segment, reported only by its
label; it takes no credential.

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

## Container

The scanner runs in a client's estate as a container (#3686). It is built and
smoke-tested in CI, and a client builds it from a checkout of this repository,
at its root (owner decision, 2026-10-19). The one published copy is for
Inflect's own estate, whose scanner runs on the production VM (owner decision,
2026-10-20). The dispatch-only `Scanner image` workflow
(`.github/workflows/scanner-image.yml`) builds it, runs the smoke test and the
Trivy gate below, then pushes it to the repository's private GHCR package as
`ghcr.io/rodnapamet/agent-harness-scanner:sha-<commit>`. It reports the digest,
which is what a deployment pins. It has no `:latest` tag. On the production VM
it runs from the opt-in Compose overlay `deploy/docker-compose.harness-scanner.yml`.
The pilot estate's configuration and environment-file templates are in
`deploy/harness-scanner/`, and the overlay's header lists the preconditions.

```bash
docker build -f packages/agent-harness-scanner/Dockerfile -t agent-harness-scanner .

docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e SCANNER_SIGNING_KEY -v /etc/agent-harness-scanner:/etc/agent-harness-scanner:ro \
  agent-harness-scanner public-key --config /etc/agent-harness-scanner/config.json

docker run -d --name agent-harness-scanner --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env-file /etc/agent-harness-scanner/scanner.env \
  -v /etc/agent-harness-scanner:/etc/agent-harness-scanner:ro \
  -v /srv/repos/support-bot:/estate/repos/support-bot:ro \
  agent-harness-scanner
```

With no command the container runs `schedule --config
/etc/agent-harness-scanner/config.json`; `scan --dry-run` and `public-key` are
given as the command. Mount the configuration and each `code` root read-only, at
the paths the configuration names, and supply every environment variable it
names (the signing key, the ingest key, each source's credential) from the
estate's own secret store, such as an `--env-file` readable only by the
operator. The image holds no credential and no configuration. It runs as uid
1000, so each mounted file and directory must be readable by that user.
`public-key` needs no network.

What the image is, and why:

- **What it holds.** The scanner's source, the eight application modules it
  imports (the wire contract and what that imports), and four packages pinned
  exactly in its own manifest, `container/package.json`, with its own lockfile:
  `tsx`, which runs it; `typescript`, whose parser the `code` source reads
  JavaScript and TypeScript with (owner answer, 2026-10-19); `js-yaml`, which
  the `cicd` source reads workflow files with (#3784); and `zod`. No npm,
  no npx, no corepack. The build context is an allowlist,
  `Dockerfile.dockerignore`, so a file kept beside the checkout, such as an
  environment file holding the signing key, never reaches the build.
  `tests/unit/agent-harness-scanner/scanner-image.test.ts` holds the COPY lines
  and the allowlist to the import closure of `src/cli.ts`, and the packages to
  the manifest and its lockfile.
- **Its base is pinned by digest**, so the image a client builds is the image CI
  scanned. Dependabot proposes the digest's and the packages' updates.
- **It runs as the image's `node` user**, never root, with nothing under `/app`
  writable, and works with a read-only root filesystem: tsx compiles each start
  rather than caching (`TSX_DISABLE_CACHE`).
- **The scanner is process 1** (`node --import tsx`, no wrapper), and stops at
  once on `SIGTERM` or `SIGINT`. A scan cut short posts nothing.

CI's `Scanner image` job builds it on every pull request, runs
`container/smoke.sh` against it, and gates on Trivy at `CRITICAL,HIGH`. The
smoke test runs the image as above, with no network: it checks the user and the
absence of npm, that `public-key` prints the given key, that `scan --dry-run`
over an estate of one Python and one TypeScript agent prints a report that
verifies against that key through the image's own contract module and holds
both agents, and that a scan with nowhere to post exits non-zero. Run it against
an image you built with `packages/agent-harness-scanner/container/smoke.sh
agent-harness-scanner`.
