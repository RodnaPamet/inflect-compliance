# `@inflect/agent-harness-scanner`

The reference harness scanner (#3678, owner decision of 2026-10-18 on that
issue). It runs inside a client's estate, reads that estate's sources
**read-only**, builds an `inflect-agent-harness/2` report
([`docs/agent-harness-contract.md`](../../docs/agent-harness-contract.md)),
signs it with an Ed25519 key the tenant registered, and posts it unchanged to
the tenant's ingest. The ingest still accepts `/1`, so a scanner built before
#3754 keeps working until it is upgraded.

## Sources

One interface (`src/source.ts`), one adapter per product. A source that cannot
be read is reported `INCOMPLETE` with the contract's reason, never left out.

| Kind | Product | What it reads | Requests |
|---|---|---|---|
| `okta-app` | Okta | Service apps (OAuth clients with `application_type: service`) and API tokens, with their owners: an app's `profile.owner`, a token's `userId`. Every token is reported except the scanner's own, identified by id from `/api-tokens/current` | `GET /api/v1/apps`, `GET /api/v1/api-tokens/current`, `GET /api/v1/api-tokens` |
| `vault` | Azure Key Vault | Secrets and certificates tagged with the principal they belong to (`inflect-principal`), with an `owner` tag | `POST` the client-credentials token exchange to `login.microsoftonline.com`, then `GET /secrets`, `GET /certificates` |

Azure Key Vault is the only vault adapter. The `vault` kind and the `product`
field keep the interface generic for the next one.

**Unbound credentials.** `/2`'s `unboundCredentials[]` lists credential
references a source saw bound to no principal, from which the ingest derives
`ORPHAN_CREDENTIAL`. A source returns them on its read
(`SourceRead.unboundCredentials`), and the report builder drops any reference a
principal in the merged population holds. Both sources above report every
credential against the principal it belongs to, so neither returns one, and
the list is empty from them.

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

Itself; Node's built-ins; `zod`; and the wire contract from the application —
`@/lib/agentic/harness-contract`, `@/lib/agentic/harness-findings`,
`@/lib/agentic/harness-ladder` and `@/lib/canonical-json`. Nothing else:
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
    }
  ]
}
```

- `SCANNER_SIGNING_KEY`: the Ed25519 private key, PKCS#8 PEM. Register its
  public half at `POST /api/t/{slug}/admin/agents/harness-scanner-keys`
  (`public-key` prints it).
- `INFLECT_INGEST_KEY`: an API key with the `admin:harness_ingest` scope and no
  other.
- `OKTA_API_TOKEN`: an SSWS token for a read-only administrator.
- `AZURE_CLIENT_SECRET`: an Entra application holding `Key Vault Reader` on each
  vault, which reads metadata and cannot read a secret's contents.

Okta orgs must be on `*.okta.com` or `*.oktapreview.com`, vaults on
`*.vault.azure.net`, and the ingest on https.

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
