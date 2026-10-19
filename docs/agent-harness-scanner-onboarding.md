# Onboarding a client estate to the harness scanner

How a tenant puts one client estate under the reference harness scanner,
`packages/agent-harness-scanner` (#3678): what to register in Inflect, what to
prepare in the estate, how to label the estate's principals so the scanner can
attribute them, and how the estate's schedule health is judged. The report the
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
| `code` (LangChain and LangGraph) | None: read access to the directories it is given, mounted into the scanner | None: it makes no request |

`Key Vault Reader` reads metadata and cannot read a secret's contents. Every
credential is supplied through an environment variable that the configuration
names; none is ever written in the configuration file.

The `code` source reads the repositories that define the estate's LangChain and
LangGraph agents. Mount each one read-only into the scanner's container and name
it as a root with a label: the label, never the path, is what reports and
findings carry. The source reads `.py`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.mts`, `.cts` and `.tsx` files that mention the framework; it does not enter
dependency or build directories (`node_modules`, virtual environments, `dist`,
`build`), and it does not follow a symbolic link, which it reports as a location
it could not read. It never imports or runs what it reads.

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

What the scanner deliberately does not take from these labels:

- **A link to the register.** A label naming a registered agent is something the
  estate's own administrator can write, so the scanner reports every principal
  unregistered and the register decides.
- **Anything untagged.** A vault item with no `inflect-principal` tag is counted
  and reported as nothing; which of a vault's secrets belong to agents is the
  estate's statement to make.
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
reported with what did resolve, and the source line names the reason.
