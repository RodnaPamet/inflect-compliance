# 2026-10-17 — Agent harness ingest (#3665, step 1a core)

**Commit:** _(this PR)_ `feat(agentic): ingest signed harness reports, derive levels, raise findings (1a core)`

Step `1a` of the agentic AI for IAM roadmap (#3654), its receiving half. The
scanner package and the matrix tab are separate follow-ups.

## Design

```
scanner (client env)                       Inflect
──────────────────────                     ──────────────────────────────────────────────
signs inflect-agent-harness/1  ──POST──▶  harness-scans route  (admin.agent_harness_ingest,
with its Ed25519 key                        body capped at 5 MiB before parsing)
                                              │
                                              ▼
                                      ingestHarnessReport
                                        1. read the tenant's unrevoked scanner keys
                                        2. verifyAndParseHarnessReport (size, JSON,
                                           signature by one of those keys, schema)
                                        3. key → registered scanner agent; refuse
                                           SCANNER_MISMATCH / SUBMITTER_MISMATCH / REPLAY
                                        4. planHarnessScan (pure) → agents + findings
                                        5. one transaction: scan, discovered agents,
                                           items, findings (open / reopen / resolve)
```

Three admin surfaces sit beside it, all `admin.agent_registry`: scanner keys
(register, list, revoke) and shortfall acceptances (record, list). The expiry
half of an acceptance runs in the existing exception expiry monitor.

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, migration `20261017210000_agent_harness_scans` | Five tenant tables with the RLS triple, CHECKs on owner pairing, agent count and expiry |
| `src/lib/agentic/harness-findings.ts` | The pure planner: derived level and reach, the six finding codes, positive-evidence closing |
| `src/lib/agentic/harness-contract.ts` | `harnessKeyFingerprint` — SHA-256 over SPKI, so two spellings are one key |
| `src/app-layer/usecases/agent-harness-scans.ts` | The ingest, the only writer of the scan tables |
| `src/app-layer/usecases/agent-harness-scanner-keys.ts` | Which keys a tenant trusts |
| `src/app-layer/usecases/agent-harness-acceptance.ts` | Owner's time-limited acceptance, and the batch that reopens lapsed ones |
| `src/app-layer/jobs/exception-expiry-monitor.ts` | Calls the acceptance sweep after the control-exception transition |
| `src/lib/permissions.ts`, `src/lib/auth/api-key-auth.ts`, `src/lib/security/route-permissions.ts` | `admin.agent_harness_ingest`, the `admin:harness_ingest` scope, and the route rule above the agents subtree rule |
| `src/app/api/t/[tenantSlug]/admin/agents/harness-*` | Four routes |

## Decisions

- **A new permission rather than `agent_registry`.** The scanner is a machine
  holding a key, and the register's authority includes admitting agents and
  trusting keys. A scanner with that authority could register its own key. The
  ingest permission does one thing, and the scope that carries it grants nothing
  else.
- **The key belongs to an agent, and the report must name that agent.** A
  signature proves which key signed; binding the key to one registered scanner
  makes the signature prove which scanner reported. An API key bound to an agent
  may submit only that agent's reports.
- **Findings through `FindingRepository`, inside the ingest transaction.**
  `createFinding` asks for general write authority the scanner must not have, and
  a finding opened outside the transaction could outlive a scan that rolled back.
- **The report's `findings` member is not acted on.** The planner derives every
  finding from verdicts, tools and sources, so a scanner cannot close one by
  leaving it out or raise one the ingest cannot explain. `ORPHAN_CREDENTIAL` is
  consequently not raised: deriving it needs an inventory the contract does not
  carry.
- **The acceptance is a sibling model, not a `ControlException` row** (owner
  decision). Its shape and expiry follow `ControlException`'s, and its sweep runs
  in the same nightly monitor, so there is one expiry rhythm to operate.
- **The expiry sweep reads in two batches, not per row.** Renewals and findings
  are fetched once for the whole batch and the finding map is updated as the loop
  writes, so two lapsed acceptances for one agent cannot both create a finding.
- **The acceptance expiry is not on the compliance calendar yet.** A calendar
  event needs an href and no page renders an acceptance; the reopened finding is
  the visible signal until the matrix tab lands, and the calendar exclusion says
  so.
- **Audit and log fields are spelled out, never passed as locals.** The
  prompt-logging rule cannot resolve a local identifier at a sink, and each one
  is a counted hole; every field here is a literal or a member of a row the
  usecase just wrote.
