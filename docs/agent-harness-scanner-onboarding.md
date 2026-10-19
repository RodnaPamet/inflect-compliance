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
3. **Issue the ingest key**: an API key with the `admin:harness_ingest` scope
   and no other, bound to the scanner agent.
4. **Declare the estate** at `POST /api/t/{slug}/admin/agents/harness-estates`
   (`admin.agent_registry`): its name, the scanner agent, the cadence in hours
   (1 to 720), and each source kind with its owner. Every owner must be an
   active member of the tenant (owner decision, 2026-10-19), and an estate
   declares at least one source.

## 2. In the estate

| Source | Credential the scanner reads with | Hosts |
|---|---|---|
| `okta-app` | An SSWS API token for a read-only administrator | `*.okta.com`, `*.oktapreview.com` |
| `vault` (Azure Key Vault) | An Entra application holding `Key Vault Reader` on each vault, with a client secret | `*.vault.azure.net`, and the token from `login.microsoftonline.com` |
| `runtime` (LangSmith) | A LangSmith service key holding the workspace Viewer role | `api.smith.langchain.com` (US) or `eu.api.smith.langchain.com` (EU), or the estate's own self-hosted LangSmith |

`Key Vault Reader` reads metadata and cannot read a secret's contents. Every
credential is supplied through an environment variable that the configuration
names; none is ever written in the configuration file.

**LangSmith.** Name the workspace to read with `workspaceId` (sent as
`X-Tenant-Id`) unless the key is scoped to one workspace. A self-hosted
LangSmith is configured by its origin (`"endpoint": { "selfHosted":
"https://…" }`) and must be a bare https origin whose name resolves only to
public addresses: the scanner checks it when the file is read, resolves it again
before every request, and does not send the key to a private, loopback,
link-local or metadata address. A self-hosted LangSmith that runs no deployment
control plane is configured with `"readDeployments": false`. The scanner sends
LangSmith GET requests only, and the Viewer role is what keeps the key read-only
on LangSmith's side; where the workspace cannot assign a key that role, the key
carries the rights of whoever issued it and only the scanner's GET-only wire
keeps the read read-only.

## 3. Labelling the estate's principals

The scanner reports what the estate itself records, and nothing it would have to
guess. These are the **documented defaults**. Each can be overridden for one
estate in its scanner configuration, under the key named in the last column.

| What | Default | Where it is read | Override |
|---|---|---|---|
| A service app's owner in Okta | the app's `profile.owner` property | the OAuth service app's `profile` object | `ownerProfileKey` on the `okta-app` source |
| Which principal a vault credential belongs to | the tag `inflect-principal` | each Key Vault secret's or certificate's tags | `principalTag` on the `vault` source |
| A vault credential's owner | the tag `owner` | the same tags | `ownerTag` on the `vault` source |

The value of `inflect-principal` is the principal's id in the source that finds
it, so the credential lands on the same agent:

| Principal | Id |
|---|---|
| An Okta service app | `okta:app:<appId>` |
| An Okta API token | `okta:api-token:<tokenId>` |
| An Entra service principal | `entra:sp:<objectId>` |
| A LangSmith deployment | `langsmith:deployment:<deploymentId>` |
| A LangSmith tracing project | `langsmith:project:<projectId>` |

**LangSmith reads no label.** Its agents are identified by LangSmith's own ids,
and LangSmith records no owner for a project or a deployment, so each is reported
unowned. Every deployment is reported. A tracing project that no deployment
writes to is reported when it recorded a tool call in the window (`windowDays`,
7 by default, at most 30); one that only called a model is counted and reported
as nothing. Each agent's tools are the tool names its project's calls carry,
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
`TIME_BOX`, `BYTE_CAP` or `PAGINATION_TORN` for the rest.

A LangSmith source's rows are the deployments and projects it listed, so a
workspace whose window held no tool call and no deployment is read in full with
rows and reports no agent. A scan that found no agent at all raises
`EMPTY_SCAN` and never counts as the estate's complete scan.
