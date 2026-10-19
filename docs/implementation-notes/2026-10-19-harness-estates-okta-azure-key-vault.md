# 2026-10-19 — Client estates, and Okta and Azure Key Vault as scanner sources (4a)

**Commit:** `feat(agentic): the reference scanner with Okta and Azure Key Vault sources, and per-estate scan health (4a)`

## Design

Step 4a of `docs/agentic-iam-roadmap.md` (#3678), under the owner's decisions of
2026-10-18 on that issue: a reference scanner built in this repository, Azure
Key Vault as the only vault product, Okta as an identity source, and client
estates scheduled when step 0e names them — until then, fixture estates.

```
client estate                                            Inflect tenant
─────────────                                            ──────────────
packages/agent-harness-scanner
  config.json (no credentials) + env
  ├─ okta-app  ── GET /api/v1/apps, /api/v1/api-tokens ─▶ Okta
  ├─ vault     ── POST token (login.microsoftonline.com)
  │            ── GET /secrets, /certificates ──────────▶ Key Vault
  ├─ buildReportBody  (merge by discoveredId, caps → BYTE_CAP)
  ├─ signReport       (contract schema + secret scan, then Ed25519)
  └─ POST unchanged ───────────────────────────────────▶ /admin/agents/harness-scans
                                                           ingestHarnessReport (1a)
                                                           AgentHarnessScan
AgentHarnessEstate ─┐                                            │
  scannerAgentId    ├─ getHarnessEstateHealth ─ computeEstateHealth ─▶ harness tab card
  cadenceHours      │       (scans of each estate's scanner)
AgentHarnessEstateSource (kind, ownerUserId) ─┘
```

**What an estate is.** A client environment one scanner deployment covers: a
name, the registered scanner agent whose signed reports describe it, the cadence
a complete scan is expected at, and the sources it reads, each with a named
owner. A report cannot name an estate (the contract is strict; a member is a new
contract id), so a scan is the estate's whose scanner signed it, and one estate
per scanner is a unique key. The estate is a declaration only: nothing here
writes or references a scan.

**Health.** `src/lib/agentic/harness-estate-health.ts` is pure and client-safe.
An estate is FRESH while its last complete scan is no older than one and a half
cadences, and STALE otherwise, including when no complete scan is among those
read. A scan counts for an estate only when the matrix's own rule calls it
COMPLETE and every declared source was read in full with at least one row.
Freshness is measured from `min(asOf, ingestedAt)`.

## Files

| File | Role |
| --- | --- |
| `packages/agent-harness-scanner/` | the scanner: source interface, read-only wire, Okta and Azure Key Vault sources, report builder and signer, config, schedule, CLI |
| `prisma/schema/agentic.prisma`, `auth.prisma` | `AgentHarnessEstate`, `AgentHarnessEstateSource` and their back-relations |
| `prisma/migrations/20261019010000_agent_harness_estates/` | both tables, the cadence and kind CHECKs, RLS triple |
| `src/app-layer/usecases/agent-harness-estates.ts` | the one writer of both tables; the health read |
| `src/lib/agentic/harness-estate-health.ts` | the freshness rules (pure) |
| `src/app/api/t/[tenantSlug]/admin/agents/harness-estates/**` | GET (inventory key), POST, PATCH, DELETE (register key) |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/EstateHealthCard.tsx` | the card on the harness tab |
| `eslint.config.mjs` | the scanner's import boundary |
| `tests/helpers/agent-harness-source-fakes.ts` | HTTP fakes for Okta, the identity platform, Key Vault and the ingest, with request logs |

## Decisions

- **The scanner imports the wire contract rather than copying it.** It checks
  its report with `HarnessReportBodySchema` and `firstSecretShapedMember` and
  signs `harnessSignedMessage` — the ingest's own functions — so a report the
  ingest would refuse is never signed, and `canonical-json.ts` stays the one
  canonical form its header says it must be. The cost is that the package is
  not standalone; `eslint.config.mjs` allows exactly those four modules and
  refuses every other `@/`, `@prisma/*`, `next` and `@inflect/ui` import. The
  container (#3686) bundles them.
- **Read-only is the wire's shape.** A source holds a `ReadOnlyHttp` whose only
  verb is GET; the token exchange is its own interface. `scanner-surface.ts`
  declares every request and its hash is the report's manifest hash, so a wider
  surface changes what the tenant sees on every scan, and the tests hold each
  request log to the declaration.
- **No register link from the estate's own labels.** An Okta profile or a Key
  Vault tag naming a register agent is something the estate administrator can
  write; believing it would let them hide a shadow agent. `registeredAgentId`
  is `null` from both sources; the register source is #3686.
- **Okta API tokens are principals.** An SSWS token acts as the admin who made
  it, so it is reported as delegated, not bound to an agent, owned by its
  `userId`, with an evidenced `H2.credential_bound: false`. A service app's
  client credential is reported by reference with its age unknown, because
  Okta's secrets endpoint returns the secret.
- **Vault credentials attach by tag.** A secret or certificate tagged
  `inflect-principal` with a `discoveredId` lands on that principal's agent;
  untagged items are counted in `rows` and reported as nothing. A tagged
  credential whose principal no other source saw is still reported.
- **Several vaults are one `vault` source**, COMPLETE only when every vault was
  read, because the contract lists each kind once.
- **A missing source credential is `AUTH_FAILED`, not a skipped source.** The
  estate has the source whether or not this run could read it.
- **Staleness is 1.5 cadences.** One late or slow run is tolerated; a missed one
  is not. Not seen is stale, never "unknown".
- **A source that read zero rows is EMPTY, not complete**, as the matrix treats
  a scan that found no agents.
- **The scanner of an estate is fixed.** Moving an estate to another scanner is
  a new estate, so a scan history is never re-attributed.
- **Writes are API-only in this step.** The owner schedules the client estates
  when 0e names them, an operator declares each one, and the harness tab reads
  the health server-side.
