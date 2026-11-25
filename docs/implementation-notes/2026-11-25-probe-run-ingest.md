# 2026-11-25 — Probe-run ingest (`scanent-probes/1`), step 8a of the active flavour

**Commit:** `feat(agents): ingest scanent-probes/1, a prober's signed report (step 8a)`

## Design

scanent 0.18.0 ships the contract for a probe report: what a run of fixed
attacker probes (`scanent-probe`, the active flavour) made agents in an
authorised engagement do. This step is Inflect's ingest of it, modelled file
for file on the agent-surface rules ingest (#5798).

```
prober ──POST raw report──▶ /admin/agents/probe-runs   (admin.agent_probes_ingest)
                             │
                             ├─ prober keys (AgentProberKey, admin.agent_registry)
                             │    verifyAndParseProbesReport(raw, liveProberKeys)
                             ├─ secret-shape walk
                             ├─ prober = the key's registered agent (report names none)
                             ├─ approver (ProbeApproverKey, admin.tenant_lifecycle):
                             │    engagement.scopeSignerFingerprint must be LIVE here
                             ├─ replay: (tenantId, reportDigest) unique
                             └─ one transaction: ProbeRun + ProbeRunTarget (endpoint
                                encrypted) + ProbeRunOutcome (excerpt encrypted),
                                findings reconciled, PROBE_RUN_INGESTED audited
```

A finding is one per (target, probe, tool) per prober, referenced
`probe:<probeId>@<endpointDigest>[#<tool>]@<proberAgentId>`. ACTED or DISCLOSED
opens (or reopens) it; only the same prober's later RESISTED for the same
reference closes it; INCONCLUSIVE and absence close nothing.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma`, `auth.prisma` | Five models and their relations |
| `prisma/migrations/20261125120000_probe_runs/` | Tables, RLS triple, the retired-agent trigger on prober keys, the register-disjointness trigger |
| `prisma/migrations/20261125120100_agent_probes_ingest_off_for_non_admin_custom_roles/` | The new key off for custom roles only non-Admins carry, as for `agent_rules_ingest` |
| `src/app-layer/usecases/probe-runs.ts` | The ingest, the pure finding planner, the inventory list |
| `src/app-layer/usecases/agent-prober-keys.ts` | Prober-key register, and the revoke-in-transaction retirement uses |
| `src/app-layer/usecases/probe-approver-keys.ts` | Approver-key register, OWNER-only, a person in person |
| `src/app/api/t/[tenantSlug]/admin/agents/probe-runs/`, `…/prober-keys/`, `…/admin/probe-approver-keys/` | Routes |
| `src/lib/permissions.ts`, `roles.ts`, `auth/api-key-auth.ts`, `custom-role-admin-base-rule.ts`, `auth/guard.ts`, `security/route-permissions.ts` | The key, its scope, its classification, the edge and the route rules |
| `src/app-layer/usecases/agent-retirement-cascade.ts`, `src/lib/agentic/agent-retirement.ts` | Retiring a prober revokes its keys |
| `src/lib/security/encrypted-fields.ts` | `ProbeRunTarget.endpoint`, `ProbeRunOutcome.excerpt` |

## Decisions

- **Owner decisions of 2026-11-25** (asked before the step):
  - **Separate registers:** prober keys in their own register, each bound to a registered agent; approver keys OWNER-only; a key live in one register is refused in the other.
  - **Approver revoked:** a report is refused unless its approver key is live at ingest.
  - **Excerpts:** encrypted, read only by register-key holders, never in a finding, an audit row or evidence.
  - **Findings:** close only on the same prober's RESISTED; HIGH for ACTED and a credential's shape, MEDIUM for planted context.
  - **Targets:** no link to a registered agent.
  - **Retention:** the run tables are Operational.
  - **Later steps:** the tab and the key cards (8b) and `PROBE_RUNS` evidence (8c).
- **Disjointness has a database backstop.** Both inserts take one per-tenant advisory lock before reading the other register, so two concurrent registrations of one key — one in each register — cannot both pass. The usecases check first, for a readable 409.
- **The endpoint's digest is keyed with the lookup-hash key** (`keyedChangeDigest`), which a KEK rotation does not move, so finding references survive a rotation. A plain SHA-256 of a URL would be guessable from the URL.
- **Plain column names avoid the manifest's field names.** `reason` is an encrypted field name elsewhere, and a nested write to an unknown model encrypts every manifest-named key, so the columns are `verdictReason`, `targetReason` and `stopReason`.
- **Findings are OBSERVATIONs**, as every scanner-ingest finding is: the agent's reply is in the run for a person to judge, and the finding carries none of it.
- **API-only in 8a.** The prober-key and approver-key routes have no page yet; the census guards record that, and 8b adds the cards beside the scanner keys.
