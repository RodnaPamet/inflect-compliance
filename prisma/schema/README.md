# Prisma multi-file schema (GAP-09)

The schema lives in this directory, not in a single `prisma/schema.prisma`.
Prisma reads every `.prisma` file in this folder and concatenates them
into one logical model graph at generate / migrate time.

This requires the `prismaSchemaFolder` preview feature, which is
enabled in `base.prisma`. The feature is GA in Prisma 6.0+; on our
current Prisma 5.22.0 it is opt-in.

## Layout

| File | What lives here |
|---|---|
| `base.prisma` | `generator client` + `datasource db` (the only ones — Prisma rejects duplicates across the folder) |
| `enums.prisma` | All shared enum declarations |
| `auth.prisma` | Tenant, Organization, User, Account, Session, UserSession, TenantMembership, OrgMembership, TenantCustomRole, TenantInviteToken, TenantSecuritySettings, SsoConnection, ScimToken |
| `vendor.prisma` | Vendor, VendorAssessment + template/section/question/response models |
| `audit-trail.prisma` | AuditLog, OrgAuditLog — the platform's hash-chained immutable event log |
| `audit-workflow.prisma` | Audit, AuditChecklistItem, AuditCycle, AuditPack(+Item/Share/Comment), AuditorAccount, AuditorPackAccess, ReadinessSnapshot — the compliance-audit domain |
| `automation.prisma` | AutomationRule/Execution/Event, IntegrationConnection/Credential, SyncMapping, Webhook, Notification |
| `processes.prisma` | Business-process canvas graph |
| **compliance domain split** (2026-07-10) | `compliance.prisma` held ~111 models and was split into the domain files below — see `docs/implementation-notes/2026-07-10-compliance-schema-split.md`. Keep each ≤~30 models. |
| `controls.prisma` | Control + coverage joins (RiskControl/ControlAsset), tasks, evidence link, templates, test plans/runs/steps, exceptions, requirement links |
| `evidence.prisma` | Evidence, FileRecord, EvidenceReview |
| `risk.prisma` | Risk + quant/analytics (KRI, simulation, appetite, correlation, snapshots), reporting, suggestions, treatment |
| `frameworks.prisma` | Framework, FrameworkRequirement, mapping sets, per-tenant overlays, ISO Clause/ClauseProgress |
| `policy.prisma` | Policy + versions/approvals/acknowledgements + control/evidence junctions + template |
| `tasks.prisma` | Task (work-item) + TaskLink/Comment/Watcher + key sequence |
| `assets.prisma` | Asset + Cve/AssetVulnerability/Scanner chain + AssetRiskLink |
| `personnel.prisma` | Employee, Device, Training, BackgroundCheck, ConnectedIdentityAccount |
| `findings.prisma` | Finding + FindingRisk/FindingEvidence |
| `incidents.prisma` | Incident (NIS2 Art.23) + BusinessImpactAnalysis/BiaDependency |
| `questionnaire.prisma` | Inbound questionnaires + answer library |
| `nis2.prisma` | NIS2 gap self-assessment (domains/questions/assessments/answers/assignments) |
| `ai-governance.prisma` | AI-gov self-assessment + EU AI Act AiSystem registry |
| `trust-center.prisma` | TrustCenter + TrustCenterDocument + access requests |
| `agentic.prisma` | AgentProposal + WorkflowRun/WorkflowStep |
| `analytics.prisma` | ComplianceSnapshot + CompliancePostureSummary |
| `compliance.prisma` | **Empty stub.** Kept so path references resolve; do NOT add models here — use the matching domain file above. |
| `schema.prisma` | **Transitional**. Holds models not yet relocated to a domain file. Shrinks toward empty as splits land in follow-up PRs. |

## Conventions

### One owner per declaration

A model or enum lives in exactly one file. Cross-domain references
(`tenant Tenant @relation(...)`) are declared on the OWNING side —
i.e. the model's own domain file. The reverse-relation field on the
referenced model is declared in the referenced model's home file.

### Generator and datasource

Exactly one generator and one datasource block, both in `base.prisma`.
Prisma rejects duplicates across the folder, so adding a new domain
file MUST NOT redeclare these.

### Enum policy

All shared enums live in `enums.prisma`, even when only one domain
references them today. Reasons:

* Enums tend to grow new consumers across domains over time
  (e.g. `Severity` started on `Risk`, now used by `Finding`, `Issue`,
  and several Task variants).
* A single home avoids accidental duplicate declarations during
  refactors.
* Schema diffs for enum changes are localised to one file.

### Migration discipline

The split is **purely organisational** — no field, relation, index,
default, or `@@map` should change as part of moving a model between
files. Each file-relocation PR must include a clean
`prisma migrate diff` that reports zero drift between the resulting
schema and the prior committed state.

The CI guardrail in `tests/guardrails/...prisma...` enforces this.

## Running Prisma

The standard commands are unchanged — Prisma auto-detects the folder
when `prismaSchemaFolder` is enabled in the generator block:

```
npx prisma generate         # codegen for @prisma/client
npx prisma migrate dev      # local migration
npx prisma migrate deploy   # production / CI migration
npx prisma format           # format every .prisma file in the folder
```

Tooling that explicitly passed `--schema=./prisma/schema.prisma` has
been updated to point at the folder (`./prisma/schema`) — see
`scripts/entrypoint.sh`.

## Why split

The monolithic schema reached ~2,900 lines and 96 models. Splitting
by domain:

* Localises change diffs (a vendor-only change touches one file, not
  the same monolith every other PR also touches).
* Reduces merge-conflict surface — adjacent unrelated changes across
  domains stop conflicting on the same file.
* Makes ownership readable at a glance — a contributor opening
  `compliance.prisma` immediately sees the domain boundary.
* Aligns the schema layout with the `src/app-layer/` and
  `src/app/api/` layouts, both of which already split by domain.

## What this PR does

This is the **foundation** PR. It enables the preview feature, sets
up the folder layout, and pre-creates header-commented placeholder
files documenting where models WILL live. It does NOT relocate any
model — every model + enum still lives in `schema.prisma`. The
relocation lands in follow-up PRs, one domain at a time.
