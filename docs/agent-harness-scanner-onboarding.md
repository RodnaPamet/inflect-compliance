# Onboarding a client estate to the harness scanner

How a tenant puts one client estate under the reference harness scanner,
`packages/agent-harness-scanner` (#3678; its LangSmith source is #3738): what to
register in Inflect, what to prepare in the estate, how to label the estate's
principals so the scanner can attribute them, and how the estate's schedule
health is judged. The report the
scanner sends is specified in [`docs/agent-harness-contract.md`](agent-harness-contract.md);
the scanner's own reference is `packages/agent-harness-scanner/README.md`.

An **estate** is one client environment that one scanner deployment covers: a
name, the registered scanner agent whose signed reports describe it, the
cadence a complete scan is expected at, and the sources it reads, each with a
named owner. A tenant may declare several. A scan belongs to the estate whose
scanner signed it, so each estate has a scanner of its own.

## 1. In Inflect

1. **Register the scanner** as an agent in the tenant's register. It is the
   principal that signs the estate's reports, so it has an accountable owner like
   any other agent.
2. **Trust its signing key.** Generate an Ed25519 key in the estate, print its
   public half with `public-key`, and register it at
   `POST /api/t/{slug}/admin/agents/harness-scanner-keys` (`admin.agent_registry`).
3. **Issue the ingest key**: an API key with the `admin:harness_ingest` scope,
   bound to the scanner agent. If the estate reads the register (the
   `inflect-register` source, which the pilot does), give the key `mcp:read` as
   well and grant the scanner agent the tool `get_harness_register`. The key
   holds no other scope.
4. **Declare the estate** at `POST /api/t/{slug}/admin/agents/harness-estates`
   (`admin.agent_registry`): its name, the scanner agent, the cadence in hours
   (1 to 720), and each source kind with its owner. Every owner must be an
   active member of the tenant (owner decision, 2026-10-19), and an estate
   declares at least one source.

## 2. In the estate

| Source | Credential the scanner reads with | Hosts |
|---|---|---|
| `entra-sp` (Entra) | An Entra application holding the Microsoft Graph application permission `Application.Read.All`, with a client secret | `graph.microsoft.com`, and the token from `login.microsoftonline.com` |
| `mcp` (MCP servers) | None, or per server a READ token. For Inflect's own `/api/mcp`, an API key holding `mcp:read` and no other MCP scope | Each server's configured https endpoint, which may be the estate's own host |
| `okta-app` | An SSWS API token for a read-only administrator | `*.okta.com`, `*.oktapreview.com` |
| `vault` (Azure Key Vault) | An Entra application holding `Key Vault Reader` on each vault, with a client secret | `*.vault.azure.net`, and the token from `login.microsoftonline.com` |
| `runtime` (LangSmith) | A LangSmith service key holding the workspace Viewer role | `api.smith.langchain.com` (US) or `eu.api.smith.langchain.com` (EU), or the estate's own self-hosted LangSmith |
| `cicd` (GitHub Actions) | A fine-grained token limited to the listed repositories, holding the repository permissions Contents: read and Secrets: read | `api.github.com` |
| `gcp-sa` (Google Cloud IAM) | The JSON key of a service account holding `roles/iam.serviceAccountViewer` on the listed projects | `iam.googleapis.com`, and the token from `oauth2.googleapis.com` |
| `code` (LangChain and LangGraph) | None: read access to the directories it is given, mounted into the scanner | None: it makes no request |

`Key Vault Reader` reads metadata and cannot read a secret's contents. Every
credential is supplied through an environment variable that the configuration
names; none is ever written in the configuration file.

**Entra.** Configure the directory by its id, a GUID, not by a domain: the scanner
reports an application's service principal when the application is registered in
that directory. It also reports every managed identity. It never reports a
Microsoft first-party application, nor a disabled principal. A third-party
application consented into the directory is reported only when the estate sets
`"includeThirdPartyApplications": true` (owner decision, 2026-10-19).
`Application.Read.All` lists registrations and service principals and cannot
change either; Graph never lists a secret's value, and the scanner drops the
first characters of each secret that Graph does return (`hint`) with the page.

**MCP servers.** List each server by its Streamable HTTP endpoint, and under
`agents` the `discoveredId` of each agent that uses it, as the identity source
reports it (`entra:sp:<objectId>`, `okta:app:<id>`, …). A `code` agent that
fetches a server's tools at run time needs no entry: its placeholder for the
server's URL is replaced by what the server serves. To pin a server, run one
`scan --dry-run`, read the server's `manifestHash` from the `mcp server read`
log line, and set it as `pinnedManifestHash`. From then on, a change to any of
its tools reads as unpinned. The scanner sends `initialize`, the initialized
notification and `tools/list`, and never calls a tool.

**LangSmith.** Name the workspace to read with `workspaceId` (sent as
`X-Tenant-Id`) unless the key is scoped to one workspace. The scanner sends
LangSmith GET requests only, and the Viewer role is what keeps the key read-only
on LangSmith's side; where the workspace cannot assign a key that role, the key
carries the rights of whoever issued it and only the scanner's GET-only wire
keeps the read read-only.

- **Deployments are opt-in.** By default the scanner reads tracing projects only.
  LangSmith's deployments listing carries each deployment's secrets, names and
  values, so the scanner requests it only for an estate whose configuration sets
  `"readDeployments": true`. It then keeps each deployment's id and tracing
  project, and drops the rest with the page. Leave it off for a self-hosted
  LangSmith that runs no deployment control plane.
- **A self-hosted LangSmith** is configured by its origin (`"endpoint":
  { "selfHosted": "https://…" }`) and must be a bare https origin. The scanner
  checks it when the file is read, resolves it again before every request, and
  does not send the key to a private, loopback, link-local or metadata address.
- **A self-hosted LangSmith on the estate's own network** lists the private
  ranges its host may resolve into, beside its origin:
  `"egressPrivateCidrAllowlist": ["10.20.0.0/16"]`. This mirrors the
  application's self-hosted egress allowlist (`EGRESS_PRIVATE_CIDR_ALLOWLIST`).
  Metadata, loopback and link-local (`169.254.0.0/16`, `127.0.0.0/8`,
  `0.0.0.0/8`, `fe80::/10`, `::1`, `::`) stay refused even when listed. Every
  resolved address is still checked before every request, so a name that
  resolves outside the listed ranges sends nothing. With an allowlist, an
  internal name such as `langsmith.corp.internal` is accepted.

The `code` source reads the repositories that define the estate's LangChain and
LangGraph agents. Mount each one read-only into the scanner's container and name
it as a root with a label: the label, never the path, is what reports and
findings carry. The source reads `.py`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.mts`, `.cts` and `.tsx` files that mention the framework; it does not enter
dependency or build directories (`node_modules`, virtual environments, `dist`,
`build`), and it does not follow a symbolic link, which it reports as a location
it could not read. It never imports or runs what it reads.

Two consequences, both kept by the owner on 2026-10-19:

- **A symbolic link leaves the source `INCOMPLETE` (`UNREACHABLE`).** If a
  repository relies on one, mount its target and name it as a root of its own;
  until then the source cannot read in full, so its scans neither close a
  finding on the absence of a tool nor let an `ORPHAN_CREDENTIAL` open.
- **`dist` and `build` are not read.** They hold generated output, and the
  definitions they were built from are what the source reads. An agent that
  exists only as built output is not reported.

A complete read is what closes `UNPINNED_WRITE_TOOL` for the tools an agent
defines in its code: the source reports every tool a definition binds, so a
definition read in full with no unpinned write tool left is evidence that none
remains, with no `mcp` source in the scan (owner answer, 2026-10-19,
`docs/agent-harness-contract.md`, Transport). A tool set the code fetches from
an MCP server at run time is still judged by a complete `mcp` read.

**GitHub Actions.** List each repository as `owner/repo` under `repositories`.
The scanner reads the workflow files on each one's default branch and its
Actions secrets by name; Secrets: read lists names, and GitHub has no read of a
value. A workflow is reported when it references a secret, when a job's token
may write, or when it reaches secrets dynamically. Give every job an explicit
`permissions:` map: a job without one takes the repository's default, which the
scanner does not read and so reports as possibly writing, with
`H2.tools_allowlisted` unmet. A repository secret that no workflow references
is reported unbound and raises `ORPHAN_CREDENTIAL`. Organisation and environment
secrets are not listed: a reference to one is reported with its age unknown.

**Google Cloud.** List each project by its id under `projects`. Create a
service account for the scanner that holds `roles/iam.serviceAccountViewer` on
those projects and nothing else, give it one key, and supply the key file's JSON
through the variable `keyEnv` names. The scanner reports every other enabled
account in the projects with its user-managed keys, and not its own. Each
account is keyed on its numeric id, so a principal's e-mail address never
reaches Inflect; to recognise one on the matrix, look the id up in the project.

## 3. Labelling the estate's principals

The scanner reports what the estate itself records, and nothing it would have to
guess. These are the **documented defaults**. Each can be overridden for one
estate in its scanner configuration, under the key named in the last column.

| What | Default | Where it is read | Override |
|---|---|---|---|
| A service app's owner in Okta | the app's `profile.owner` property | the OAuth service app's `profile` object | `ownerProfileKey` on the `okta-app` source |
| Which principal a vault credential belongs to | the tag `inflect-principal` | each Key Vault secret's or certificate's tags | `principalTag` on the `vault` source |
| A vault credential's owner | the tag `owner` | the same tags | `ownerTag` on the `vault` source |
| An Entra service principal's owner | the first user among the application registration's owners, else among the service principal's | Graph's `owners` of each | None: Entra records owners itself |

The value of `inflect-principal` is the principal's id in the source that finds
it, so the credential lands on the same agent:

| Principal | Id |
|---|---|
| An Okta service app | `okta:app:<appId>` |
| An Okta API token | `okta:api-token:<tokenId>` |
| An Entra service principal | `entra:sp:<objectId>` |
| A LangSmith deployment | `langsmith:deployment:<deploymentId>` |
| A LangSmith tracing project | `langsmith:project:<projectId>` |
| A GitHub Actions workflow | `github:workflow:<owner>/<repo>/<file>` |
| A Google Cloud service account | `gcp:sa:<uniqueId>` |

**LangSmith reads no label.** Its agents are identified by LangSmith's own ids,
and LangSmith records no owner for a project or a deployment, so each is reported
unowned. A tracing project is reported when it recorded a tool call in the
window (`windowDays`, 7 by default, at most 30); one that only called a model is
counted and reported as nothing. With `readDeployments`, every deployment is
reported as well, and its tracing project is reported as the deployment rather
than as a project of its own. Each agent's tools are the tool names its project's calls carry,
summarised over the window, and nothing of any run is read. LangSmith records no
tool definition, pin or read-only hint, and the contract counts an undeclared
hint as a write, so every LangSmith agent that called a tool raises
`UNPINNED_WRITE_TOOL` at the ingest.

What the scanner deliberately does not take from these labels:

- **A link to the register.** A label naming a registered agent is something the
  estate's own administrator can write, so the scanner reports every principal
  unregistered and the register decides.
- **Anything untagged.** A vault item with no `inflect-principal` tag is counted
  and reported as nothing; which of a vault's secrets belong to agents is the
  estate's statement to make.
- **An owner for a service account.** Google records none, so each is reported
  unowned and raises `SHADOW_AGENT` until somebody registers it.
- **An owner for a workflow.** GitHub records none, and the scanner does not read
  CODEOWNERS, so each workflow is reported unowned and raises `SHADOW_AGENT`
  until somebody registers it.
- **An owner for a coded agent.** The `code` source reports each agent
  definition as `code:<label>/<path>#<name>`, where the name is the variable the
  definition is bound to, with no owner: code names no accountable person. It
  raises `SHADOW_AGENT` until somebody registers it.

Every Okta API token is reported as a principal acting for the administrator who
created it, and so raises `SHADOW_AGENT` until it is registered, except the token
the scanner reads with. The scanner identifies that one by its id, from
`GET /api/v1/api-tokens/current`, never by its name.

## 4. The scanner configuration and its schedule

One JSON file per estate, strict and credential-free; the README has a complete
example. Set `schedule.everyHours` to the cadence declared on the estate in
Inflect. Check the report with `scan --dry-run` first, then run `schedule`,
which scans at once and then every `everyHours`, anchored to each run's start,
and carries on after a failed run.

The scanner runs in the estate as a container that the estate builds from a
checkout of this repository (`packages/agent-harness-scanner/Dockerfile`, owner
decision 2026-10-19). Inflect's own estate is the exception. Its scanner runs on
the production VM from a copy published by digest to the repository's private
GHCR package (owner decision 2026-10-20; the README's Container section). Its
default command is `schedule`.
Run it read-only, with every capability dropped, as its own non-root user
(uid 1000); mount the configuration and each `code` root read-only and readable
by that user; and supply the environment variables the configuration names from
the estate's secret store. The signing key is one of them, and the image holds
none. The README's Container section has the commands.

**Before the first estate scans a real LangSmith workspace** (owner decision,
2026-10-19), run one `scan --dry-run` against it and read the `runtime` entry
of `population.sources`. The paths and query parameters the source uses are in
LangSmith's published OpenAPI documents, but the members of one run facet
(`key`, `value`, `n`) are not, and neither is whether the tool-run filter
applies to the facets. The source fails closed on both, so the outcome answers
the question:

- **`COMPLETE`** with the agents and tool names the workspace is known to have:
  the assumption holds, and the estate may be scheduled.
- **`INCOMPLETE` `PAGINATION_TORN`** while the API answered (no `AUTH_FAILED`,
  `UNREACHABLE` or `RATE_LIMITED`): the response did not read as assumed. Do not
  schedule the estate. The shape is corrected in one place,
  `packages/agent-harness-scanner/src/sources/langsmith.ts`.

## 5. Schedule health

The harness tab on `/agents/reports` shows each estate's last complete scan, and
each source's last scan that read it in full, with its owner. An estate is
**FRESH** while its last complete scan is no older than one and a half cadences,
and **STALE** otherwise (owner decision, 2026-10-19). A scan counts for an
estate only when every source it reported was read in full, it found agents,
and it read every source the estate declares with at least one row. A source
read in full that returned nothing is **EMPTY**, not complete. A source the
scanner could not read appears with its reason: `AUTH_FAILED` for a credential
the source refused or that was not set, and `UNREACHABLE`, `RATE_LIMITED`,
`TIME_BOX`, `BYTE_CAP` or `PAGINATION_TORN` for the rest. The `code` source adds
`UNPARSEABLE`: it read a file that does not parse, or an agent definition built
from something it cannot resolve statically — a tool list returned by a
function, a model passed in as a parameter, `**kwargs`. The agent is still
reported with what did resolve, and the source line names the reason. The
`cicd` source adds it for a workflow file that is not one YAML document with a
`jobs` mapping, or that declares a `permissions:` value it does not know; the
repository's other workflows are still reported.

A LangSmith source's rows are the deployments and projects it listed, so a
workspace whose window held no tool call and no deployment is read in full with
rows and reports no agent. A scan that found no agent at all raises
`EMPTY_SCAN` and never counts as the estate's complete scan.

A stale estate also raises a finding (#3741, owner decision 2026-10-19). The
`agent-harness-estate-staleness` job runs daily at 06:47 UTC, judges every
estate with the same rule the card uses, and opens one `HIGH` observation per
stale estate (`sourceKind = AGENT_HARNESS`, `sourceRef = STALE_ESTATE:<estate
id>`). The finding names the estate, its scanner and each declared source that
no scan in the window read in full, and is assigned to the scanner agent's
owner. A second run leaves it as it is; an estate that goes stale again reopens
the same finding. It closes only when a complete scan of every declared source
arrives. Raising the cadence or dropping a source does not close it, even
though the card then reads FRESH, and removing the estate leaves it open for a
person to close.
