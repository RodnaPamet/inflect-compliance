# 2026-11-12 — Recent-activity redaction covers every model of a governed domain (#5371)

**Commit:** `fix(mcp): redact every governed domain's audit rows from get_tenant_context, not just the root model's (#5371)`

## Design

`get_tenant_context` returns the tenant's latest audit-log rows
(`recentActivity`) to a context holding `canAudit`, and
`TENANT_CONTEXT_ROW_REDACTION` then drops each row whose domain the acting
principal may not view. The rule maps `AuditLog.entity` to a view key and KEEPS
a row it does not recognise — deliberately, because the feed also carries
memberships and settings that have no domain key.

Its comment said "every entity that names a GOVERNED domain is listed". It
listed fourteen root names. The Prisma audit extension (`src/lib/prisma.ts`)
writes the MODEL name as `entity` for every write in a tenant context, with the
written state in `detailsJson.after`, so `RiskTreatmentPlan`, `TaskComment`,
`ControlException`, `ControlTestRun`, `EvidenceReview`, every `Vendor*`,
`Policy*`, `Finding*` and `Incident*` child reached a principal forbidden the
domain. So did the non-model strings `logEvent` callers write
(`RISK_TREATMENT_PLAN`, `CONTROL_EXCEPTION`, `TREATMENT_MILESTONE`, `File`, ...),
which did not match the PascalCase keys either.

```
entity ──normaliseActivityEntity (case- and _-insensitive)──▶ lookup
          ACTIVITY_DOMAIN_ENTITIES: key → every model of the domain + its logEvent spellings
          not found ──▶ null ──▶ row kept (unchanged direction)
ACTIVITY_ENTITY_UNGOVERNED: domain-adjacent models deliberately kept, each with a reason
```

The population test derives the domain's models from the schema —
`parseSchemaModels()` names starting with a governed root model, plus every
model declared in a governed domain's schema file — and fails on any that is in
neither list. It also scans every `entityType:` literal in `src/` and fails on
one that names a governed root and resolves to nothing.

## Files

| File | Role |
| --- | --- |
| `src/lib/mcp/tools/dashboard-redaction.ts` | Map grouped by key over every model of each domain; normalised lookup; `ACTIVITY_ENTITY_UNGOVERNED` with reasons; comment corrected |
| `tests/unit/mcp-activity-entity-domain.test.ts` | Schema-derived population, no stale or doubled entries, logEvent literal scan, and the filter applied to a risk-blind principal |
| `tests/integration/mcp-tool-authz-per-invocation.test.ts` | The real `/api/mcp` feed for a risk-blind principal now also withholds `RiskTreatmentPlan` and `RISK_TREATMENT_PLAN` rows |

## Decisions

- **Unrecognised stays visible.** The fix widens the list rather than flipping
  the default, which would empty the feed of every ungoverned row (the
  comment's own reasoning, kept).
- **One normalised lookup instead of one entry per spelling.** The same entity
  is written as `RiskTreatmentPlan` (extension), `RISK_TREATMENT_PLAN` and
  `risk` (`logEvent` callers); folding case and underscores makes one entry
  cover all of them and cannot collide with an ungoverned name (the test fails
  if a name is both mapped and ungoverned, or mapped twice).
- **A model named for a root takes that root's key.** A link model belongs to
  two domains and a row has one key, so the name decides: `RiskControl` is
  `risks.view`, `ControlEvidenceLink` `controls.view`, `EvidenceControlLink`
  `evidence.view`. Either answer narrows relative to before.
- **Findings stay under `audits.view`**, as `Finding` already was and as
  `STATS_BY_DOMAIN` counts `openFindings`. `findings.view` exists and is what
  the findings register's routes require; moving both the rows and the stat to
  it is a separate change.
- **`IdentityWriteJournal` takes `admin.tenant_lifecycle`**, the key of its
  only read surface (`admin/identity-write-journal`, OWNER-only), rather than
  `personnel.view`: a row names a change made to a person's directory account.
  The other identity and personnel models take `personnel.view`.
- **`ReportTemplate` / `ReportRun` / `ReportSchedule` take `reports.view`**,
  the reporting key, although they live in `risk.prisma`.
- **Deliberately ungoverned, each with its reason in the source:** `AuditLog`
  and `AuditOutbox` (audit-trail plumbing, not audit engagements), `Cve` (the
  global NVD catalogue), `BusinessImpactAnalysis` and `BiaDependency`
  (continuity has no view key by decision), and the three `AccessReview*`
  models declared in `audit-workflow.prisma` (the access-review domain, not
  audits). The access-review and agent-register domains have view keys
  (`access_reviews.view`, `admin.agent_registry_view`) that this map does not
  apply yet; their rows behave as they did before this change.
