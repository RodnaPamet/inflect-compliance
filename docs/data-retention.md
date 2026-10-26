# Data Retention Policy

**Status:** DRAFT — engineering inventory complete; retention *numbers*
await legal / compliance / finance sign-off (see [Open questions](#open-questions)).
**Owners:** Engineering (mechanism + inventory) · Compliance/Legal (regulatory
periods + GDPR) · Finance (financial-record periods) · Product (tenant tiers).

This document categorizes **every one of the 150 Prisma models**, declares the
retention behaviour that exists *today*, names who owns each undecided number,
and enumerates the cleanup machinery. It is the companion to
[`docs/encryption-data-protection.md`](encryption-data-protection.md) — that doc
covers confidentiality *at rest*; this one covers *lifecycle*.

## What this document is NOT

- **Not a regulatory commitment.** Retention periods driven by SOC 2 / ISO 27001 /
  customer contracts ride on this doc *once legal signs off*. Engineering does not
  pick those numbers in a vacuum — where a number is a legal decision, this doc
  says so and leaves it open.
- **Not a privacy notice.** The customer-facing privacy notice is a separate,
  marketing-site document. This is an internal engineering + compliance artefact.
- **Not a complete erasure plan.** GDPR Article 17 right-to-erasure is a real
  engineering effort (cascading FK deletes across tenant data while preserving
  `AuditLog` immutability is non-trivial). This doc states whether erasure is
  supported today (**it is not**, beyond `User.deletedAt` soft-delete) and what
  landing it would require — it does not implement it.

## Category breakdown (149 models)

| Category | Count | One-line posture |
|----------|-------|------------------|
| Business record | 66 | Compliance domain (Risk/Control/Policy/Audit/Vendor/…). Retained indefinitely while the tenant is active; soft-delete + 90-day purge on the 12 `SOFT_DELETE_MODELS`; `retentionUntil` sweep on 2 (`Asset`, `Evidence`) — the only two with a writer. |
| Configuration | 40 | Tenant/org structure, templates, framework reference data, integration + security settings. Lives with the tenant; purged on tenant deletion. |
| Operational | 24 | Notifications, executions, snapshots, key-sequences, onboarding. No TTL today — prime candidates for time-boxed pruning. |
| Security ephemeral | 13 | Tokens / sessions / credentials. `expiresAt`-driven; security lifetime, **not** a data-retention conversation. |
| Regulatory artefact | 7 | `AuditLog`, `OrgAuditLog`, `ReadinessSnapshot` — immutable + hash-chained. Plus the NIS2 Article 23 incident triad (`Incident`, `IncidentNotification`, `IncidentTimelineEntry`) — incident + regulatory-notification records. Plus `AgentActionReceipt` — externally-verifiable, mediator-signed AI-agent action evidence. Retention is a **legal** decision; we do not delete by default. |
| PII subject | 2 | `User`, `AuditorAccount` — the GDPR right-to-erasure surface. **Undefined** beyond soft-delete. |
| Financial | 2 | `BillingAccount`, `BillingEvent` — typically a 7-year regulatory floor; **needs finance input**. |

## Entity inventory

`PII?` legend: `Yes` = stores personal data directly · `maybe` = may contain
user-entered free text / references · `No` = none · `ind.` = indirect (references
a `userId` but stores no contact PII).

| Entity | Category | PII? | Current retention mechanism | Policy gap |
|--------|----------|------|------------------------------|------------|
| `AccessReview` | Regulatory artefact | No | Soft-delete (`deletedAt`), never auto-purged. RETAINED by the tenant purge (`TENANT_PURGE_RETAINED`, owner decision 2026-10-18); its `FileRecord` evidence pointer is `SET NULL` when the purge removes the file row. No product path hard-deletes a campaign | The campaign root of every access review — scope, period, reviewer, creator, closer — and the parent every decision, pack, narrowing and sample row cascades from, so it is kept for as long as they are: retaining a child whose cascade parent is purged keeps nothing (#3716). Reviewer, creator and closer are global `User` rows the purge never deletes. Indefinite — review w/ compliance |
| `AccessReviewDecision` | Regulatory artefact | maybe | RETAINED by the tenant purge with its campaign (owner decision 2026-10-18); cascade only on a direct campaign delete, which no product path performs; `membershipId` is `SET NULL` when the purge removes the membership, and the frozen `subjectUserId` + `snapshot*` columns stay. `notes` is reviewer free text | One person's access decision in a MEMBER campaign — the SOC 2 CC6 / ISO A.5.18 evidence an auditor asks for. References people by global `User` id (`subjectUserId`, `decidedByUserId`, `executedByUserId`), as `AuditLog` does. **DSAR-relevant.** Indefinite — review w/ compliance |
| `Account` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
| `AgentActionReceipt` | Regulatory artefact | No | None today — immutable-ish evidence; cascade on tenant delete only. `scannedSummary` is scrubbed/bounded (no raw payloads/PII) | Mediator-signed AI-agent action evidence; verified rows link to the hash-chained `AuditLog`. Retention tracks the audit trail — **needs legal/auditor input** |
| `AiDecisionLog` | Regulatory artefact | maybe | Append-only (immutability trigger); digest + sanitised summary only; cascade on tenant delete | EU AI Act Art 12 record — retention **needs legal input**. For the feature `agentic-run:discovered-agent-review` (#3710) the sanitised `outputSummary` is the model's answer about one discovered agent, and an owner-attribution answer names the owner reference its source records (`DiscoveredAgent.ownerRef`). **DSAR-relevant for that feature: `outputSummary` can name a person.** The same applies to the feature `assistant` (#3809): one row per TURN of the in-product assistant, and its `outputSummary` is an answer composed from the tenant's own records. The read tools behind it return their usecase's rows verbatim (`list_tasks` hands back `listTasks(...)` with no tool-level redaction), and tasks and controls carry assignee and owner references, so an answer can quote one. **DSAR-relevant for `assistant` on the same basis.** The turn is the unit because the immutability trigger forbids any other: a conversation-level row could not accumulate turns, so it would have to be written once at the end and would leave NO record for an abandoned conversation. Conversation grouping is `sessionRef` across turn rows, not a coarser row. Token cost is recorded per turn (`tokensIn`/`tokensOut`) and is deliberately NOT gated by `agentMonthlyTokenBudget`, which is agent-scoped — see the note on `ProducedBy` in `usecases/assistant.ts`. |
| `AiSystem` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged; purpose/useContext encrypted (Epic B) | Soft-deleted rows **not auto-purged** — gap |
| `AiSystemRequirementLink` | Business record | No | None today — cascade on AI-system/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Asset` | Business record | No | retentionUntil sweep (data-lifecycle `runRetentionSweep`) + soft-delete | DEFINED (retentionUntil) where set; else indefinite |
| `AssetKeySequence` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `AssetRiskLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `AssetVulnerability` | Business record | No | Cascade on asset/CVE/tenant delete; status lifecycle (OPEN→MITIGATED/…) | Indefinite while tenant active — vuln-remediation record |
| `ScannerRun` | Business record | No | Cascade on tenant delete | Indefinite while tenant active — the run is the provenance for any control evidence it produced |
| `ScannerFinding` | Business record | Yes (`description`) | Cascade on run/tenant delete; deduped + status lifecycle (OPEN→FIXED/FALSE_POSITIVE/ACCEPTED) | Indefinite while tenant active — security-testing remediation record |
| `BusinessImpactAnalysis` | Business record | Yes (`notes`) | Cascade on tenant delete; processNode/owner set-null on delete | Indefinite while tenant active — the operational-continuity artifact satisfying NIS2 Art.21(2)(c) |
| `BiaDependency` | Business record | No | Cascade on BIA/tenant delete | Indefinite while tenant active — part of the BIA record |
| `VendorDocExtraction` | Business record | No | Cascade on vendor/document/tenant delete | Indefinite while tenant active — the AI extraction + provenance for a vendor doc's pre-filled answers |
| `VendorAnswerProposal` | Business record | No | Cascade on extraction/tenant delete; status lifecycle (PENDING→ACCEPTED/REJECTED) | Indefinite while tenant active — the propose-not-commit review record |
| `VendorMonitor` | Configuration | No | Cascade on vendor/tenant delete | Indefinite while tenant active — the per-vendor continuous-monitoring config + rolling posture state (last run, breach date, TLS grade, attestation expiry) |
| `VendorPostureEvent` | Business record | No | Cascade on vendor/tenant delete | Indefinite while tenant active — the append-only continuous-assurance timeline (breaches, cert expiries, TLS grades, triggered reassessments) |
| `Audit` | Business record | No | Soft-delete (`deletedAt`); 90-day purge via `data-lifecycle` | Active: indefinite. Soft-deleted: 90-day purge |
| `AuditChecklistItem` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `AuditCycle` | Business record | No | Soft-delete (`deletedAt`); 90-day purge via `data-lifecycle` | Active: indefinite. Soft-deleted: 90-day purge |
| `AuditLog` | Regulatory artefact | ind. | Immutable + hash-chained (never deleted) | Regulatory min/max — **needs legal/auditor input** |
| `AuditOutbox` | Operational queue | No | Drained by `audit-outbox-flush`; APPLIED rows are the durable record's receipt, FAILED rows are kept for a human | Transient by design — a row exists only until its entry reaches the hash chain. FAILED rows are **never** auto-deleted (#2657): the terminal bad state must stay queryable, because an absence is the defect this table exists to remove. |
| `AuditPack` | Business record | No | Soft-delete (`deletedAt`); 90-day purge via `data-lifecycle` | Active: indefinite. Soft-deleted: 90-day purge |
| `AuditPackItem` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `AuditPackShare` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `AuditPackShareComment` | Business record | Yes (`body`) | Cascade on pack/share/tenant delete; item set-null; status lifecycle (OPEN→RESOLVED) | Indefinite while tenant active — the auditor return-channel record (comments / evidence requests / findings) is part of the audit artefact |
| `AuditorAccount` | PII subject | Yes | None today — cascade on parent/tenant delete only | UNDEFINED — GDPR erasure question |
| `AuditorPackAccess` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
| `AuditWorkpaper` | Regulatory artefact | ind. — `reviewedByUserId` names the reviewer; unit ids identify rows that may describe a person, never by name or address | ONE-WAY: every column fixed at insert apart from a review stamp set once (CHECK + trigger `audit_workpaper_one_way`, which refuses every role); `app_user` holds no DELETE; hard-delete only by `CASCADE` from the tenant, and kept by the tenant purge (`TENANT_PURGE_RETAINED`). The auditor agent, control-test run, evidence and proposal references are plain ids with no foreign key, as `AgentKillSwitch.agentId` is, so the workpaper outlives those rows and the purge of the register; the insert trigger checks the agent id names an auditor of the same tenant | The auditor agent's re-performance of one audit procedure for one period (#3675): the population's definition, count and digest, the binding sample, each sampled unit's outcome code, the exceptions, the conclusion with its basis code, and the review stamp. Codes, identifiers and counts only — no free text, so nothing to encrypt. An audit relies on it and step 3d samples it, so it is not pruned by age (decision of step 0e). Retention period is a **legal** decision — **needs legal/auditor input**. **DSAR-relevant: references a person via `reviewedByUserId` and, indirectly, via unit ids.** |
| `AuditWorkpaperFinding` | Regulatory artefact | No | INSERT-ONLY: `app_user` holds neither UPDATE nor DELETE, and a trigger refuses an UPDATE from any role. Kept by the tenant purge (`TENANT_PURGE_RETAINED`). Its only foreign keys are to the tenant and to its workpaper, both retained; `findingId` is a plain id, bound by an insert trigger, so a finding hard-purged after its soft delete or by the tenant purge leaves the link naming it | One finding a workpaper links (#3675). Kept as long as the workpaper. A link is a reference: nothing that writes it writes the finding, so a workpaper never closes one, and it outlives the finding it names |
| `AuditWorkpaperNarrative` | Regulatory artefact | ind. — unit ids identify rows that may describe a person; the narrative contract refuses an e-mail address, and the skill cites units by id, never by name | WRITE-ONCE: `app_user` holds neither UPDATE nor DELETE, and a trigger (`audit_workpaper_narrative_write_once`) refuses an UPDATE from every role; one per workpaper; hard-delete only by `CASCADE` from its workpaper or the tenant, both kept by the tenant purge (`TENANT_PURGE_RETAINED`). The drafting run is a plain id with no foreign key, so the narrative outlives the run | The auditor agent's narrative of one workpaper (#3749): the run that drafted it, the exception codes it discusses, and at most 400 characters of model text, encrypted at rest. Stored only after the narrative contract held it to the workpaper's own conclusion and codes, and the insert trigger re-checks the codes. Kept as long as the workpaper it describes. Retention period is a **legal** decision — **needs legal/auditor input**. **DSAR-relevant: indirectly, via unit ids.** |
| `AuditWorkpaperSampleReview` | Regulatory artefact | ind. — `assignedToUserId` and `reviewedByUserId` name the internal auditor asked and the one who answered | ONE-WAY: what the draw fixed never changes; only three named moves exist — a re-draw of an UNANSWERED row's reviewer by the sweep, the assigned reviewer's answer set once, and a dissent's proposal link set once (CHECKs + trigger `audit_workpaper_sample_review_one_way`, which refuses every role); `app_user` holds no DELETE; hard-delete only by `CASCADE` from its workpaper or the tenant, both kept by the tenant purge (`TENANT_PURGE_RETAINED`). The finding proposal, the assignee and the reviewer are plain ids with no foreign key, so nothing it references being purged takes it | Internal audit's re-performance of one sampled auditor workpaper (#3677): the draw's epoch, seed fingerprint and rate, who was asked (or why nobody could be) and the pool they were drawn from, and the answer — CONCURRED, DISSENTED or INDETERMINATE with stable dissent CODES and no free text, so nothing to encrypt. Kept as long as the workpaper it judges, because an agreement rate whose history can be pruned cannot be trended (decision of step 0e). Retention period is a **legal** decision — **needs legal/auditor input**. **DSAR-relevant: references people via `assignedToUserId` and `reviewedByUserId`.** |
| `AuthSession` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `AutomationExecution` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `AutomationRule` | Configuration | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Lives with tenant; purged on tenant deletion |
| `BillingAccount` | Financial | No | None today — cascade on parent/tenant delete only | Regulatory min (typ. 7y) — **needs finance input** |
| `BillingEvent` | Financial | No | None today — cascade on parent/tenant delete only | Regulatory min (typ. 7y) — **needs finance input** |
| `Clause` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ClauseProgress` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `CompliancePostureSummary` | Operational | No | Cascade on tenant delete; overwritten daily (upsert, one row/tenant) | Derived — regenerated daily by the `compliance-posture-summary` cron; no historical retention |
| `ComplianceSnapshot` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `Control` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — it was removed from `RETENTION_MODELS` on 2026-08-06 rather than left as a sweep that could never match. |
| `ControlAsset` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlContributor` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlEvidenceLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlException` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `ControlKeySequence` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ControlRequirementLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlTemplate` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `ControlTemplateRequirementLink` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `ControlTemplateTask` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `ControlTestEvidenceLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlTestPlan` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlTestRun` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ControlTestStep` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Cve` | Configuration | No | Global reference catalog — upserted daily by `nvd-cve-sync`; never tenant-deleted (no tenantId) | Indefinite global reference data (refreshed, not retained per-tenant) |
| `DataSubjectRequest` | Regulatory artefact | ind. | None — retained indefinitely (DSAR compliance record) | DEFINED — retained as Art. 17 compliance evidence (see docs/dsar.md) |
| `Evidence` | Business record | No | retentionUntil sweep (`runEvidenceRetentionSweep`, the dedicated 04:00 `retention-sweep` cron — the cross-model sweep SKIPS Evidence rather than calling it) + archive → 365-day hard purge + soft-delete | DEFINED — template for the rest |
| `EvidenceControlLink` | Business record | No | None today — cascade on parent/tenant delete only (Evidence or Control delete) | Indefinite while tenant active — review w/ compliance |
| `EvidenceRiskLink` | Business record | No | None today — cascade on parent/tenant delete only (Evidence or Risk delete) | Indefinite while tenant active — review w/ compliance |
| `EvidenceAssetLink` | Business record | No | None today — cascade on parent/tenant delete only (Evidence or Asset delete) | Indefinite while tenant active — review w/ compliance |
| `EvidenceTag` | Business record | No | None today — cascade on parent/tenant delete only (Evidence delete) | Indefinite while tenant active — review w/ compliance |
| `EvidenceReview` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `FileRecord` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `Finding` | Business record | No | Soft-delete (`deletedAt`); 90-day purge via `data-lifecycle` | Active: indefinite. Soft-deleted: 90-day purge |
| `FindingAsset` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `FindingEvidence` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `FindingRisk` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Framework` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `FrameworkMapping` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `FrameworkPack` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `FrameworkRequirement` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `FrameworkRequirementOrder` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `IdentityDepartmentGroupRule` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion. One row per department→security-group rule for the JML joiner (#2713); holds no personal data — a department string and a directory group id. |
| `Incident` | Regulatory artefact | maybe | None today — indefinite while tenant active; `description` encrypted | NIS2 Article 23 record — retention is a **legal** decision (incident records often have multi-year statutory retention); **needs legal input** |
| `IncidentNotification` | Regulatory artefact | maybe | None today — cascade on parent incident delete only; `submissionNote` encrypted | The filed Article 23 report + authority case ref — retention tracks the parent incident; **needs legal input** |
| `IncidentTimelineEntry` | Regulatory artefact | maybe | None today — cascade on parent incident delete only; `entry` encrypted | Forensic incident narrative — retention tracks the parent incident; **needs legal input** |
| `IncidentEvidence` | Business record | No | Cascade on parent incident/evidence delete; purged on tenant deletion, directly and by `CASCADE` from its `Evidence` (owner decision 2026-10-18) | Junction linking forensic Evidence to an incident; it lives and dies with the `Evidence` row it points at. The incident and its notifications and timeline are the retained regulatory record |
| `IntegrationConnection` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion. `ownerUserId` (the integration passport's accountable owner, an external agent connection only) is `SET NULL` when the user is deleted, so erasing a person leaves the connection unowned — which the weekly passport sweep then raises as `CONNECTION_OWNER_MISSING` — rather than blocking the erasure or deleting the connection |
| `IntegrationExecution` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `IntegrationSyncMapping` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ConnectedIdentityAccount` | PII subject | No (`protectionReason` only) | Re-synced each run; vanished accounts reconciled to DEPROVISIONED; cascade on tenant delete | Directory mirror across all four supported providers (Okta / Google Workspace / Microsoft Entra ID / Active Directory) — no TTL; row lifecycle tracks the live directory, purged on tenant deletion. Holds a named person's work identity: `email`, `displayName`, and as of Step 0b the login names the directory issues them — `samAccountName` (AD), `userPrincipalName` (AD + Entra) and `mailNickname` (Entra). Those three are **PII**: a login name identifies an individual as directly as an email address, and that is exactly why they are stored — the directory bridge matches a legacy application's access table on them. All three are nullable and never backfilled, so a row carries one only after a sync observed it; Okta and Google Workspace leave all three null permanently because their account identifier IS the email. Plaintext at rest alongside `email` and `displayName`, which the encryption manifest polices by shape and treats as identifiers rather than free text; `protectionReason` is the one encrypted column because it is operator prose. **DSAR-relevant PII: names a person via `email` and the login names.** |
| `IdentityWriteJournal` | Regulatory artefact | No | Append-only; `SET NULL` on link delete so it OUTLIVES the link and the employee row; cascade on tenant delete | Evidence that an automated system changed a named person's directory access, and the captured prior state that makes the change reversible. No TTL, and deliberately NOT cascaded from `IdentityAccountLink`: deleting an employee for privacy must not erase the record that their access was revoked, which is frequently the artefact an auditor asks for. `priorStateJson` holds provider-shaped directory attributes, not free text. **DSAR-relevant: references a person via `externalUserId`.** |
| `ExternalWriteJournal` | Regulatory artefact | No | Append-only; `SET NULL` on connection delete so it OUTLIVES the connection; cascade on tenant delete | The Art 12 / Art 14 record that an agent changed a configuration in a customer's own third-party system, plus the captured prior state that lets a human re-apply it. No TTL, and deliberately NOT cascaded from `IntegrationConnection`: deleting an integration must not erase the record that we changed somebody's system through it, which is usually the artefact being asked for — the denormalised `connectionName` and `endpointUrl` are what keep the row readable afterwards. Rollback is CAPTURE, not auto-revert, so nothing here re-sends anything. `detail`, `argumentsJson` and `priorStateJson` are ENCRYPTED at rest (`ENCRYPTED_FIELDS`), unlike the identity journal's prior state: that column holds directory flags, this one holds whatever an arbitrary third-party system returned for the object being changed, which for an HRIS is a person's work email, personal email and phone numbers. **DSAR-relevant: the payloads can name a person.** |
| `ExternalToolPriorStateRead` | Configuration | No | Deleted with the tenant | Which READ tool is called to capture prior state before a given external WRITE (#2861). Tenant configuration, not a record of anything that happened: removing a row makes the write undispatchable again, which is a narrowing. Holds two tool names and the OWNER who nominated them — no business content and nothing about a person, so it carries no encrypted columns and is not DSAR-relevant. |
| `IdentityAccountLink` | PII subject | No | Re-observed and re-stamped on every healthy identity sync; CASCADE from both `Employee` and `ConnectedIdentityAccount`; cascade on tenant delete | Asserts that a named worker owns a named directory account — a link between two identified people-records, so it is PII in its own right. No TTL: the pairing must outlive quiet periods to be readable at termination, which is the whole reason it is stored rather than computed. Dies automatically with either side it describes, so it cannot outlive the subject. **DSAR-relevant PII.** |
| `LegacyAccessSnapshot` | Operational | No (`refusalDetail` justified plaintext) | `purgeLegacyAccessSnapshotsOlderThan` — deleted `legacySnapshotRetentionDays` (default 90) after the run that CONSUMED it, or `legacySnapshotUnconsumedRetentionDays` (default 30) after `pulledAt` if nothing ever did; cascade on connection/tenant delete | The integrity evidence for one pull of a legacy application's access table: the mapping version and column-set fingerprint it was read under, the SHA-256 payload hash and its algorithm version, the row counts, and a named refusal reason when the read was not whole. An auditor recomputes the hash from the stored `LegacyAccount` rows and compares, which is why the row is an artefact rather than a log line. Carries **no personal data**: every column is schema metadata, a count, a hash or a system-generated sentence — `refusalDetail` is held to that by `LegacyIngestError`, which permits column names, counts and account keys and forbids cell values. **The TTL landed 2026-10-11 (#3317)**, closing what was a growing gap: a connection pulled daily kept every snapshot, and each retained its accounts (below). The clock is the CONSUMING RUN, not `pulledAt` — a snapshot pulled in March and first reconciled in September has a dispute window that opens in September, so keying off the pull date would delete it the week it became relevant. A snapshot nothing ever consumed ages out on its own shorter clock, because that is the case the issue was filed about and nothing cites such a snapshot, so deleting it costs a re-pull rather than evidence. **Operational rather than regulatory, deliberately.** It is integrity evidence FOR a pull, not a regulatory record in its own right — the regulatory artefact is the access review, which carries its own classification. Classing it regulatory would make the tenant purge retain it while still purging its `LegacyAccount` children, which are PII: that leaves a snapshot whose payload hash can never be recomputed, i.e. the appearance of integrity evidence with the thing that verifies it destroyed. If a completed review needs durable substantiation after a purge, that belongs on the review artefact, not here. |
| `LegacyAccount` | PII subject | No | CASCADE from `LegacyAccessSnapshot`, so rows die with the snapshot — which `purgeLegacyAccessSnapshotsOlderThan` now bounds; cascade on tenant delete | One account from one legacy application, in the canonical schema only — whatever else the source table carried was dropped at the boundary by `lib/legacy-access/ingest.ts`, so a column nobody mapped is a column nobody stored. Holds a named person's work identity in that application: `email`, `displayName`, `givenName`, `familyName`, `username`, `employeeNumber`, `department`, `title`, `managerRef`, plus `entitlements`. Plaintext at rest, the same decision as `ConnectedIdentityAccount` and for the same reason — the encryption manifest treats these as identifiers rather than free text, and reconciliation joins on them. **Immutable**: a snapshot is a point-in-time observation, so a changed account is a new row in a new snapshot, never an update here. That is what makes the payload hash recomputable months later — and it is also why the TTL was needed, because the history was an unbounded store of identified people's access. The accounts are never purged WITHOUT their snapshot: that was the third option considered in #3317 and the worst of the three, because `verifySnapshotPayloadHash` would then report every stripped snapshot as unverifiable, preserving the appearance of integrity evidence while destroying the thing that could verify it. They go together, by CASCADE, or neither goes. **DSAR-relevant PII: names a person via `email`, `displayName` and the name parts.** |
| `LegacyAccountResolution` | PII subject | No (`note` justified plaintext) | None today — IMMUTABLE, one row per account per run, accumulating; CASCADE from both `IntegrationExecution` and `LegacyAccessSnapshot`; cascade on tenant delete | What the reconciliation engine concluded about one legacy account on one run, and why: the outcome, the method, and the signals, candidates and vetoes it weighed. **PII in its own right**, on the same reasoning as `IdentityAccountLink` — a resolution asserts that a named worker owns a named account, which is a link between two identified people-records — and the evidence itself carries emails, employee numbers and account keys, because those ARE the evidence for the four strong signals. Plaintext for the same reason `ConnectedIdentityAccount.email` is: the surface that exists to show a reviewer WHY an account was suggested cannot show them an opaque blob. **Deliberately immutable** — a second run writes a new set and never updates the old, because "why was this suggested in March?" is a question about what the engine saw in March, and the roster has since moved. That is also why the absent TTL matters: the history is a growing store of assertions about identified people. **DSAR-relevant PII: names a person via `employeeId` and via the evidence.** |
| `LegacyIdentityAlias` | PII subject | No | None today — one row per (connection, accountKey), SUSPENDED rather than deleted; CASCADE from `IntegrationConnection`; cascade on tenant delete | The durable crosswalk: this legacy account belongs to this employee, **because a person said so**. Written only by Step 4b and read by every later run, where it resolves as `CONFIRMED_ALIAS` — the one signal that can produce a `LINKED` with no other evidence, which is why a human has to put it there. Records the method, who confirmed it, when, and the signals they were SHOWN (not what is true now, so "was this reasonable to confirm?" stays answerable after the roster moves). `confirmedByUserId` is nullable because a user row can be deleted while the decision it recorded stands — the alias outlives the account that made it, as `IdentityWriteJournal` outlives the link it describes. Suspension rather than deletion for the same reason: deleting it would make "who linked this account, and when?" unanswerable. **DSAR-relevant PII.** |
| `LegacyMatchVerdict` | PII subject | No | None today — IMMUTABLE, one row per `(resolution, model revision)`, accumulating; CASCADE from `LegacyAccountResolution`, so rows die with the resolution they judge; cascade on tenant delete | What a model revision said about one reconciliation result, and under which thresholds: the verdict class or a named non-verdict reason, the per-option probabilities, P(person), the top probability and its margin, the latency and the input tokens. **Carries no identifier of its own.** The probabilities are keyed by the SHUFFLED LETTER the model was shown, and the letter-to-employee mapping is deliberately not stored — a verdict row naming employees would be a second, weaker copy of the resolution's own evidence. **Classed PII subject regardless**, because via `resolutionId` it is a model opinion about a named person's account, and "a model said this about your access" is a thing a data subject is entitled to see. Classing it operational would be arguing from the absence of a column rather than from what the row means. **Immutable, and one answer per question**: the revision is in the unique key, so a re-run under the same revision cannot produce a second answer and a model change is an addition — "what did revision X say?" stays answerable afterwards. No TTL today, and the gap is bounded differently from its siblings': the CASCADE means it cannot outlive the resolution, so retention for this table is settled by whatever is decided for `LegacyAccountResolution` in the open question below. **DSAR-relevant PII: reachable from a person via the resolution.** |
| `Employee` | PII subject | No | Re-synced from HRIS (idempotent by workEmail) or manual; cascade on tenant delete | Personnel record (name + work email + employment status). **Step 0c added seven more PII columns**, all nullable and never backfilled: `hrisRecordId` (the HR system's own row id — BambooHR populates it, Workday leaves it null), and the structured name parts `givenName`, `familyName`, `middleName`, `preferredName`, `legalName` plus `employeeNumber`. Each names an individual as directly as `fullName` does, and `employeeNumber` is a LINK-strength match signal, so a stale one would auto-link a legacy account to a person the HR system no longer says it belongs to — which is why all seven are last-write-wins and clear to null when the HRIS stops asserting them. Capped and control-stripped on the way in (`normaliseHrisText`); `fullName` and `externalId` are deliberately NOT, because the joiner pass builds mailbox addresses from `fullName` byte for byte. No TTL today — tracks the live roster; purged on tenant deletion. **DSAR-relevant PII.** |
| `Device` | Operational | No | Re-reported by agent/MDM (upsert by serial) or manual; cascade on tenant delete | Endpoint posture inventory (serial/hostname + encryption/lock/AV flags). No TTL; tracks the live fleet, purged on tenant deletion |
| `TenantDeviceToken` | Security ephemeral | No (SHA-256 hash at rest) | Revocable (`revokedAt`); cascade on tenant delete | Per-tenant device-agent credential (like `TenantApiKey`) — hash-only at rest, single-use lookup; purged on tenant deletion |
| `TrainingCourse` | Configuration | No | Cascade on tenant delete | Course catalogue; lives with tenant |
| `TrainingAssignment` | Business record | No | Cascade on employee/tenant delete | Training-completion record — compliance evidence of annual security-awareness training; retained while tenant active |
| `BackgroundCheck` | PII subject | Yes (`resultSummary`) | Cascade on employee/tenant delete; result encrypted | Pre-employment screening record — sensitive PII (adverse-action detail encrypted at rest). **DSAR-relevant; needs a retention commitment.** |
| `AccessReviewConnectedDecision` | Regulatory artefact | No | RETAINED by the tenant purge with its campaign; cascade only on a direct campaign delete, which no product path performs; `connectedAccountId` is `SET NULL` when the purge removes the directory account, and the frozen `snapshotJson` stays | Frozen access-review evidence for a connected identity account, a legacy application account (`subjectRef` = `connectionId:accountKey`) or a registered agent (SOC 2 UAR); retained with the parent review |
| `AccessReviewAgentPack` | Regulatory artefact | No | RETAINED by the tenant purge with its campaign and decision (both retained, so the cascade never fires in a purge); append-only (a trigger refuses every UPDATE, `app_user` has no DELETE); the agent is a plain id, not a foreign key, so nothing in the register's lifecycle deletes it (#3674) | The reviewer pack one AGENT campaign prepared for one registered agent: grants and observed use in the 90-day window, proposals, card history, time-bounded grants, incidents, harness level — each section read from stored rows by the read-only pack workflow, with a `sha256:` content hash, the run that read it and the registered agent whose run it was (never the agent the pack describes) — or, for the preparing agent's own pack when no second agent is named, `PERSON_STATIC_SELF_PACK` and no agent. It is what the reviewer decided on, so it is kept with the campaign it evidences. Indefinite while tenant active — review w/ compliance |
| `AccessReviewAgentNarrowing` | Regulatory artefact | No | RETAINED by the tenant purge with its campaign, decision and pack (all retained); one-way stamps (decision and execution) enforced by trigger, `app_user` has no DELETE; plain agent and grant ids (#3674) | One proposed narrowing of an agent's authority — delete a grant not used in the window — and the person's ACCEPT/REJECT on it. An accepted row records that the grant was deleted (`GRANT_DELETED`) or already gone. The record that a recertification changed an agent's authority, and who decided it; the grant itself is gone, so this row and the `AGENT_TOOL_REVOKED` audit entry are the history. Indefinite while tenant active — review w/ compliance |
| `AccessReviewDecisionSampleAudit` | Regulatory artefact | No | RETAINED by the tenant purge with its campaign and decision (both retained); one-way stamp enforced by trigger, `app_user` has no DELETE (#3674) | A decision of an AGENT campaign drawn at close by the keyed sampler for a second human, and that human's verdict with stable dissent CODES — no free text. The measure of whether the first reviewer's decisions hold up, kept for as long as the campaign it judges, for the reason `AgentProposalSampleAudit` gives. Indefinite while tenant active — review w/ compliance |
| `TrustCenterDocument` | Configuration | No | Cascade on trust-center/tenant delete | Published document pointer (label + fileRecordId); lives with the trust center |
| `TrustCenterAccessRequest` | Business record | No (token hashed) | Cascade on document/tenant delete; download token hashed + single-use + expiring | Gated-document access-request audit (who requested/downloaded); retained as access evidence |
| `QuestionnaireAnswerLibrary` | Business record | No | Cascade on tenant delete | Reusable Q&A knowledge base; improves over time; retained while tenant active |
| `InboundQuestionnaire` | Operational | No | Cascade on tenant delete | Uploaded inbound questionnaire; no TTL today |
| `InboundQuestionnaireItem` | Operational | No | Cascade on questionnaire/tenant delete | AI-drafted / accepted answers; no TTL today |
| `IntegrationWebhookEvent` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `KeyRiskIndicator` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `KriReading` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `LossEvent` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `Nis2GapDomain` | Configuration | No | Global seed reference (CC BY 4.0 import) — reseeded, never tenant-purged | Lives with the deployment; refreshed via `sync-nis2-gap-assessment` |
| `Nis2GapQuestion` | Configuration | No | Global seed reference (CC BY 4.0 import) — reseeded, never tenant-purged | Lives with the deployment; refreshed via `sync-nis2-gap-assessment` |
| `Nis2SelfAssessment` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Nis2SelfAssessmentAnswer` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active; `note` encrypted at rest |
| `Nis2GapAssignment` | Operational | No | Cascade on assessment/tenant delete | No TTL — delegation partition for a run; lives with the assessment |
| `AiGovDomain` | Configuration | No | Global seed reference — reseeded, never tenant-purged | Lives with the deployment; refreshed from the AI-governance fixture |
| `AiGovQuestion` | Configuration | No | Global seed reference (AISVS CC-BY-SA-4.0 / ISO 42001 clause refs / EU AI Act public domain) — reseeded, never tenant-purged | Lives with the deployment; refreshed from the AI-governance fixture |
| `AiGovSelfAssessment` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `AiGovSelfAssessmentAnswer` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active; `note` encrypted at rest |
| `Notification` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `NotificationOutbox` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `OrgAuditLog` | Regulatory artefact | ind. | Immutable + hash-chained (never deleted) | Regulatory min/max — **needs legal/auditor input** |
| `OrgDashboardWidget` | Configuration | No | Removed by its own org-plane flow (member removal / widget removal) | Lives with the ORGANIZATION, not the tenant. A tenant deletion does not touch it. |
| `OrgInitiativeLink` | Operational | No | None today — cascade on initiative/org delete only | Append-only cross-tenant work links; pruned with the initiative |
| `OrgInvite` | Security ephemeral | maybe | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `OrgMembership` | Configuration | No | Removed by its own org-plane flow (member removal / widget removal) | Lives with the ORGANIZATION, not the tenant. A tenant deletion does not touch it. |
| `OrgMaturityRating` | Operational | No | None today — cascade on org delete only | Append-only maturity-rating history (human-judgment); no TTL today — candidate for time-boxed prune |
| `OrgSecurityInitiative` | Operational | No | None today — cascade on org delete only | Portfolio programme records; no TTL today — review w/ compliance |
| `OrgThreatLevel` | Operational | No | None today — cascade on org delete only | Append-only posture history (human-curated); no TTL today — candidate for time-boxed prune |
| `Organization` | Configuration | No | None — no organization delete path exists | Org-plane root. Outlives every tenant beneath it; a tenant deletion does not touch it. |
| `PackTemplateLink` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `PasswordResetToken` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `PreHire` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion. The JML joiner's pre-hire surface (#2715): a person the HRIS has hired who has no mailbox yet. Holds a name, department and start date — personal data, but the same fields the `Employee` row will carry once reconciled, and for a strictly shorter window. |
| `Policy` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `PolicyAcknowledgement` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyAcknowledgementAssignment` | Business record | maybe | None today — cascade on parent policy-version/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyApproval` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyControlLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyEvidenceItem` | Business record | No | None today — cascade on parent policy/tenant delete; evidence link SetNull on evidence delete | Indefinite while tenant active — review w/ compliance |
| `PolicyTemplate` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `PolicyVersion` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PortfolioSnapshot` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ProcessEdge` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ProcessEdgeControl` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ProcessMap` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `ProcessMapSnapshot` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ProcessNode` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `QuestionnaireQuestion` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `QuestionnaireTemplate` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `ReadinessSnapshot` | Regulatory artefact | ind. | Immutable + hash-chained (never deleted) | Regulatory min/max — **needs legal/auditor input** |
| `ReminderHistory` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ReportRun` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ReportSchedule` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `ReportTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `RequirementMapping` | Configuration | No | None — global reference data, upserted by the deploy-time library sync; a mapping whose entry leaves its file is retired (`validTo` set), not deleted | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `RequirementMappingSet` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `Risk` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `RiskAppetiteBreach` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskAppetiteConfig` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `RiskControl` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskCorrelation` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskHierarchyLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskHierarchyNode` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskKeySequence` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `RiskMatrixConfig` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `RiskScenario` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskScoreEvent` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `RiskSimulationRun` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `RiskSnapshot` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `RiskSuggestionItem` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `RiskSuggestionSession` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `RegisteredAgent` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged; `RESTRICT` from `AgentProposal`/`WorkflowRun` so an agent with attributed work cannot be hard-deleted; `description` encrypted (Epic B) | The register of which autonomous agents held what authority, and who was accountable. Deliberately long-lived: an incident review months later asks exactly this. `RETIRED`/`SUSPENDED` are lifecycle states, not deletions. `RETIRED` is terminal (app predicate plus trigger), and retiring an agent revokes its keys, deletes its tool grants, expires its pending proposals and freezes its policy card while the agent row itself is kept (#3698). Soft-deleted rows **not auto-purged** — same gap as `AiSystem`. Names an accountable person via `ownerUserId`, which after registration changes only through a completed `AgentOwnershipTransfer` (#3698) |
| `RegisteredAgentTool` | Configuration | No | Hard-delete on revoke, and of every grant the agent holds when it is retired (#3698); `CASCADE` from `RegisteredAgent` and from the tenant | The deny-by-default allowlist of MCP tools one registered agent may reach. Deliberately NOT soft-deleted: a grant is authority, not history, and a revoked-but-retained row is one `WHERE` clause away from granting again. The history lives in the hash-chained `AGENT_TOOL_GRANTED` / `AGENT_TOOL_REVOKED` audit entries, and `AGENT_RETIREMENT_TOOLS_DROPPED` (naming the tools) for a retirement |
| `AgentAssessmentDomain` | Configuration | No | Global seed reference — reseeded, never tenant-purged | Lives with the deployment; refreshed from the agent-risk-assessment fixture. The four IMDA agentic dimensions; no tenant content |
| `AgentAssessmentQuestion` | Configuration | No | Global seed reference (IMDA dimension names + OWASP ASI class ids, paraphrased) — reseeded, never tenant-purged | Lives with the deployment; refreshed from the agent-risk-assessment fixture. Ids are stable external keys, so the seed is an upsert and never a reload |
| `AgentRiskAssessment` | Business record | No | None today — `CASCADE` from `RegisteredAgent` and from the tenant | The record of how an agent's operational risk tier was arrived at, and the state it was true of. Deliberately long-lived: the tier CAPS the agent's authority, so an incident review asks what was assessed and when. Indefinite while tenant active — review w/ compliance |
| `AgentRiskAssessmentAnswer` | Business record | No | None today — `CASCADE` from the assessment and from the tenant | Per-question answers behind an agent's risk tier; `note` encrypted at rest (Epic B) + sanitised on write (Epic D). Indefinite while tenant active — review w/ compliance |
| `AgentPolicyCard` | Configuration | No | Hard-delete by `CASCADE` from `RegisteredAgent` and from the tenant | The mutable head of one agent's policy card: which version is in force, plus the rolling per-UTC-day action counter. The counter is head state, not policy — it resets inside the reservation statement whenever the stored date is not today, so there is no sweep to run and nothing to fail to run |
| `AgentPolicyCardVersion` | Configuration | No | APPEND-ONLY — no UPDATE (no `app_user` privilege plus a DB trigger); no new version for a `RETIRED` agent (usecase plus trigger, #3698), so a retired agent's card is frozen at the version in force and its history kept; hard-delete only by `CASCADE` from the card, the agent or the tenant; purged on tenant deletion with its card (owner decision 2026-10-18) | One immutable version of an agent's machine-readable runtime policy. Deliberately long-lived and never edited: `WorkflowRun` and `AgentProposal` pin the version in force at execution, and a pinned version that could still be edited would reconstruct today's rules wearing an old version number. Indefinite while tenant active — review w/ compliance |
| `AgentProposalApproval` | Business record | No | APPEND-ONLY apart from one one-way `outcome` stamp — no `app_user` UPDATE or DELETE privilege plus a DB trigger; hard-delete only by `CASCADE` from the proposal or the tenant; purged on tenant deletion with its proposal (owner decision 2026-10-18) | One human's signature on one agent proposal, and the record that a second, distinct, non-owner human signed too. The four-eyes rule is enforced ON this table (a unique index over `(tenantId, proposalId, approverUserId)` and a trigger excluding the agent's registered owner), so a deleted or edited row is not lost history — it is a retired control. Deliberately long-lived: EU AI Act Art 14 asks who exercised human oversight, and an approval that can be revised afterwards does not answer it. Indefinite while tenant active — review w/ compliance |
| `ExternalToolParameterSet` | Configuration | No | Hard-delete by `CASCADE` from the tenant | One row per (tenant, external tool, label): the arguments a tenant has saved for a tool on an external MCP server — a Grafana query, an Entra filter — plus the digest of those arguments, who approved the current revision, and any edit still awaiting approval. Tenant CONFIGURATION rather than tenant data: it holds what the agent asks, never anything it read back. Long-lived on purpose — it is what a run's recorded revision refers to, so pruning it would strand the `TOOL_CALL` steps that name a revision no longer on file |
| `ExternalToolParameterSetApproval` | Configuration | No | Hard-delete by `CASCADE` from the parameter set it signs, and from the tenant | One human's signature on one proposed edit to a bounded template (#3051): who signed, which revision, and the digest of the exact edit they read. APPEND-ONLY while it exists — `app_user` holds neither UPDATE nor DELETE — and the four-eyes rule is enforced ON this table (a unique index over `(tenantId, parameterSetId, revision, approverUserId, pendingHash)`, plus a trigger on the parameter set that refuses to promote an edit until the signatures are there). Classed CONFIGURATION rather than regulatory artefact, deliberately: the composite FK is `ON DELETE CASCADE` from `ExternalToolParameterSet`, which IS configuration and IS purged, so a retained claim here would be one the database contradicts — the reason `AgentProposalApproval` was reclassified with its proposal on 2026-10-18. The durable record of who approved what survives in `AuditLog` (`EXTERNAL_TOOL_PARAMETERS_SIGNED` / `_APPROVED`), which is hash-chained and never purged |
| `McpToolManifestPin` | Configuration | No | Hard-delete by `CASCADE` from the tenant | One row per (tenant, MCP tool): the SHA-256 digests of the tool definition — name, description and parameter schema — that this tenant has on file, plus who approved it, how many times the definition has moved under them, and, for an external tool a person accepted, whether that definition declares a write (`declaresWrite`). Digests and a flag only, never the text, and no tenant data of any kind. Long-lived on purpose: it is the baseline every drift is measured against, so pruning it would silently re-arm trust-on-first-use for a tool somebody had already refused |
| `AgentKillSwitch` | Regulatory artefact | No | Hard-delete by `CASCADE` from the tenant only. Never deleted by lifting — lifting is an UPDATE that stamps `liftedAt` | One kill in force, or one that was. The row IS the evidence that a tenant's agents (or one agent) were stopped between two timestamps, by whom, and why — the two questions an incident review asks first. A `DELETE` on lift would make a control that destroys its own audit trail by being used, so there is no delete path at all. Indefinite while tenant active — review w/ compliance |
| `PlatformAgentKillSwitch` | Regulatory artefact | No | Global (no tenantId) — never per-tenant deleted, and no sweep | The platform-wide stop, one row per incident, ever. Not tenant-scoped and therefore outside every tenant retention lever by construction: it records a PLATFORM operator's action, carries no tenant data, and its whole content is a reason string, an operator reference and two timestamps. Indefinite |
| `AgentKillSwitchDrill` | Regulatory artefact | No | Hard-delete by `CASCADE` from the tenant only | One run of the scheduled kill-switch drill: which scopes were exercised, which were honoured, how many tool calls got through after the kill, and the Evidence + Finding it produced. It is the evidence that an assumption was CHECKED rather than assumed, so its value is a time series — pruning it would leave a control whose last proof of life is however far back the retention window happens to sit. Indefinite while tenant active — review w/ compliance |
| `AgenticEvidenceArtefact` | Business record | No | Hard-delete by `CASCADE` from the tenant, from its `Control`, from its `Evidence` and, for a per-agent artefact, from its `RegisteredAgent` (no usecase hard-deletes an agent); purged on tenant deletion with them (owner decision 2026-10-18) | The identity of one emitted evidence artefact — `(tenant, control, kind, period)`, and for the two per-agent kinds the agent as well (#3700) — plus the digest of the population it counted and, when its basis stopped holding, a dated withdrawal reason. It is the record that a control's evidence was GENERATED rather than assembled, and the row is deliberately never deleted when a receipt turns out to be unverifiable, a control is uninstalled or the agent a per-agent artefact is about is retired: it is withdrawn, so that "this stopped being re-emitted, here is why" stays distinguishable from "the emitter died". Retention tracks the `Evidence` it points at — **needs legal/auditor input**. Its periods are UTC months for the receipt and decision kinds and ISO weeks for `INTEGRATION_PASSPORTS`, whose `Evidence` body also carries the week's canonical passport bundle that the next week's sweep reads back as its prior: a soft-deleted `Evidence` makes the next comparison report that prior as unverifiable (`EVIDENCE_MISSING`) rather than skip it, and a hard delete cascades the artefact away, so the next comparison falls back to the newest emission that remains |
| `AgentBehaviourWindow` | Operational | No | Hard-delete by `CASCADE` from the tenant. The `CASCADE` from `RegisteredAgent` is declared but unreachable in practice — agent removal is a SOFT delete, `RegisteredAgent` is absent from `SOFT_DELETE_MODELS` so nothing promotes it to a hard one, and `AgentProposal.agent` / `WorkflowRun.agent` are `onDelete: Restrict`. No sweep | One hour of one agent's observed behaviour: call counts by capability class, the distinct tool NAMES it reached for, and the verdict its circuit breaker recorded. Counts and identifiers only — never a prompt, a proposal payload or any tool output. It is the baseline an anomaly is measured against, so a sweep that pruned it would silently return every agent to `NO_BASELINE` and stand the breaker down. **Growth is rate-bounded but UNSWEPT** — not "unbounded", and the distinction is the whole decision: `@@unique([tenantId, agentId, windowStart])` plus an `INSERT … ON CONFLICT` write caps it at ONE row per agent per ACTIVE hour whatever the traffic (an hour with 100,000 calls is one row), so ≤ 24 rows/agent/day and ≤ 8,760/agent/year, flat and non-accelerating. Every reader is row-capped at `BASELINE_WINDOW_LIMIT + 1` (169) or `WINDOW_PAGE` (48) on a prefix of the unique index, so read cost is independent of table size and growth costs STORAGE only — never correctness, never latency. The 168-window look-back is also not seven days: a row exists only for an ACTIVE hour, so it is seven days for an hourly agent and roughly 84 days for one active two hours a day — which is why `BASELINE_MAX_AGE_HOURS` (90 days, #2612) caps the look-back's AGE, and `baselineEpoch` bounds it only when a human acts. **No retention sweep, deliberately** — decided on a 2026-09-19 production measurement of ZERO rows (no governed agent has ever invoked a tool) and recorded in [`docs/adr/0002-agent-behaviour-window-retention.md`](adr/0002-agent-behaviour-window-retention.md), which names the EVENT that reopens it (this table becoming non-empty, or the first `MCP_TOOL_INVOKED` with a non-null `agentId`) rather than a date. The reader bound the decision rests on is pinned by `tests/guards/agent-behaviour-window-reads-are-bounded.test.ts` — see #2539 |
| `AgentCircuitBreaker` | Configuration | No | Hard-delete by `CASCADE` from `RegisteredAgent` and from the tenant | One row per agent: whether its behavioural breaker is latched OPEN, the signals that tripped it, the streak in progress, and the named human who last closed it and why. Head state plus the accountability record for an un-trip — the close is the one moment a person overrides an automatic stop, so the row is as long-lived as the agent. The hash-chained `AuditLog` entry written alongside each close is the immutable copy |
| `AgentHarnessScannerKey` | Configuration | No | Hard-delete by `CASCADE` from the tenant only. Revoking stamps `revokedAt` — by hand, or for every key of a scanner agent when that agent is retired (#3698); the row is never deleted while a scan it verified exists (`NO ACTION` from `AgentHarnessScan`), and `NO ACTION` from `RegisteredAgent` because agent removal is a soft delete | One public key this tenant trusts to sign harness reports, bound to one registered scanner agent (#3665). Public material only — no secret is stored. Kept as long as the scans it verified, because a scan's signature is only checkable against the key that verified it. **DSAR-relevant: references a person via `createdByUserId` and `revokedByUserId`.** |
| `AgentHarnessScan` | Business record | No | Hard-delete by the tenant purge (children first, so before its scanner agent and key, which it references `NO ACTION`). Never updated after insert | One verified harness scan: who signed it, the digest of the signed body, the signature, and the per-source completeness the report stated. Deliberately NOT a regulatory artefact: it is an inventory of the customer's own agents, which a tenant deletion asks us to remove, and retaining it would break the purge on those `NO ACTION` references. The hash-chained `AGENT_HARNESS_SCAN_INGESTED` audit row, carrying the report digest and the signer, is the immutable copy that survives. Indefinite while tenant active |
| `DiscoveredAgent` | Business record | Yes — `ownerRef` names a person when `ownerKind` is `user` | Hard-delete by `CASCADE` from the tenant only. `NO ACTION` from `RegisteredAgent`, so a soft-deleted register row leaves the link in place; its scan items and acceptances reference it `NO ACTION`, so nothing kept with it is deleted by deleting it | One agent a harness scanner has seen, keyed by the scanner's stable id, with its latest level and reach. Rows are updated in place by each scan and never deleted by age: an agent that stops appearing is still an agent somebody once found, and absence from a scan closes nothing (`docs/agent-harness-contract.md`). **DSAR-relevant: references a person via `ownerRef`.** |
| `DiscoveredAgentAttribution` | Operational | Yes — `proposedOwnerRef` names the person a SUGGESTED answer proposed, in the source's namespace (often an e-mail address) | Hard-delete by `CASCADE` from its review run (`WorkflowRun`), its discovered agent and the tenant, and by the tenant purge. `app_user` holds no DELETE. A later review run's answer replaces the row in place (one row per discovered agent); nothing deletes a row by age | The newest parsed owner suggestion of a `discovered-agent-review` run for one discovered agent (#3728): status, grade, person-free signals and the run it came from, shown in the harness tab's Register dialog. Derived: the run's Art 12 row (`AiDecisionLog`, feature `agentic-run:discovered-agent-review`) is the record of the answer, and this row is a projection of it for one screen, so it is Operational rather than a Business record. The intake records what it uses of it in the agent's hash-chained `AGENT_REGISTERED` audit row, and that is the copy that survives. `signalsJson` and `proposedOwnerRef` encrypted (Epic B). **DSAR-relevant: `proposedOwnerRef` can name a person.** |
| `AgentHarnessScanItem` | Business record | No | Hard-delete by `CASCADE` from its scan and the tenant, and by the tenant purge. `NO ACTION` from its discovered agent, so deleting the agent cannot silently take its scan history. Never updated after insert | One agent's derived level, reach, criterion verdicts and declared tools in one scan. The per-agent half of the scan record; the `toolsJson` column holds tool names and manifest digests only, never a credential value (the contract refuses one); `modelsJson` (#3759) holds the model endpoints a `/2` report named, as references with a model id, under the same refusal |
| `AgentHarnessAcceptance` | Business record | Yes — names the accepting person (`acceptedByUserId`) | Hard-delete by `CASCADE` from the tenant, and by the tenant purge. `NO ACTION` from its discovered agent, so deleting the agent cannot silently take a risk acceptance with it. Revocation stamps `revokedAt`; expiry is processed by stamping `expiryProcessedAt`; nothing deletes a row by age; `justification` encrypted (Epic B) | One owner's time-limited acceptance of a harness shortfall: who accepted what level, why, and until when; a renewal points at the acceptance it replaced. Classed with `ControlException`, its model, as a Business record. The hash-chained `AGENT_HARNESS_SHORTFALL_ACCEPTED` and `AGENT_HARNESS_ACCEPTANCE_EXPIRED` audit rows are the copies that survive a purge. Indefinite while tenant active — review w/ compliance. **DSAR-relevant: references a person via `acceptedByUserId` and `revokedByUserId`.** |
| `AgentHarnessEstate` | Configuration | No | Hard-delete by `CASCADE` from the tenant, and by the tenant purge. Removing an estate is a hard delete by the one write seam (`usecases/agent-harness-estates.ts`), audited as `AGENT_HARNESS_ESTATE_REMOVED`; its scans are not touched — they reference the scanner, never the estate. `NO ACTION` from `RegisteredAgent`, whose removal is a soft delete | One client estate a harness scanner covers (#3678): a label, the registered scanner agent whose reports describe it, and the cadence a complete scan is expected at. A declaration of what should be scanned, read against the scans for the per-estate schedule health; nothing here is evidence of a scan. Kept while it is declared. The hash-chained `AGENT_HARNESS_ESTATE_DECLARED` / `_UPDATED` / `_REMOVED` audit rows are the history. |
| `AgentHarnessEstateSource` | Configuration | Yes — names the source's accountable owner (`ownerUserId`) | Hard-delete by `CASCADE` from its estate and from the tenant, and by the tenant purge; replaced as a set when the estate's sources are changed. `RESTRICT` from its owner, so a user cannot be deleted while they own an estate's source | One source kind an estate's scanner reads (`okta-app`, `vault`, …, CHECKed to the contract's seven) and the person accountable for it. No credential and no free text: the scanner's credentials live in the client's environment and never reach Inflect. **DSAR-relevant: references a person via `ownerUserId`.** |
| `AgentOwnershipTransfer` | Business record | Yes — names people by user id (`fromOwnerUserId`, `toOwnerUserId`, `initiatedByUserId`, `completedByUserId`, `cancelledByUserId`) | Hard-delete by `CASCADE` from the tenant, and by the tenant purge (children first). `NO ACTION` from `RegisteredAgent`, whose removal is a soft delete, so a transfer cannot vanish with the agent it describes. `app_user` holds no DELETE. A row leaves `PENDING` once — `COMPLETED`, `CANCELLED` (by a person, or by the agent's retirement) or `EXPIRED` (stamped lazily once its 7-day window has passed) — and is then immutable (trigger); nothing deletes a row by age | One two-step handover of an agent's accountability (#3698): who proposed it, from whom, to whom, and whether the person named accepted it. Classed with `RegisteredAgent`, and kept as long as it, for the same incident-review question — who was accountable for this agent, and since when. A `COMPLETED` row is also the precondition step 2b's planned `OWNER_DEPARTED` lift checks, which is why it is immutable. The hash-chained `AGENT_OWNERSHIP_TRANSFER_PROPOSED` / `AGENT_OWNERSHIP_TRANSFERRED` / `AGENT_OWNERSHIP_TRANSFER_CANCELLED` audit rows survive a purge. Indefinite while tenant active — review w/ compliance. **DSAR-relevant: references people via the five user-id columns.** |
| `AgentServicePrincipalConfirmation` | Business record | Yes — names the confirming person by user id (`confirmedByUserId`) | Hard-delete by `CASCADE` from the tenant, and by the tenant purge (children first). `NO ACTION` from `DiscoveredAgent` and `RegisteredAgent`, so neither can vanish with the confirmation that names it. `app_user` holds no DELETE. One-way (trigger): the confirmed triple, the confirmer and the time are never rewritten, and the one move is `invalidatedAt` set once, with its reason code, when a harness scan re-links the principal or the agent; nothing deletes a row by age | One person's confirmation that a discovered Entra service principal is a registered agent's own (#3671), the condition for an unattended disable of that principal. Classed with `RegisteredAgent`, and kept as long as it, for the same incident-review question: who said this directory identity was this agent, and when. The hash-chained `AGENT_SERVICE_PRINCIPAL_LINK_CONFIRMED` / `AGENT_SERVICE_PRINCIPAL_LINK_INVALIDATED` audit rows survive a purge. Indefinite while tenant active — review w/ compliance. **DSAR-relevant: references a person via `confirmedByUserId`.** |
| `HostConsumer` | Security ephemeral | Yes — names the people who created and revoked it (`createdByUserId`, `revokedByUserId`) | Revocable (`revokedAt`) and retirable (`status` RETIRED); the client secret is SHA-256 at rest and shown once, as `PeerAgentInboundCredential` and `TenantApiKey` are. `app_user` holds no `DELETE`; hard-delete by `CASCADE` from the tenant only, `RESTRICT` from its receiving agent. NOT retained by the tenant purge | One host that calls Inflect as a CLIENT rather than as a peer agent (#3861) — SAP Joule is the first: a display name, an OAuth2 client id, the hashed secret, exactly ONE receiving registered agent and an allowlist of workflow keys that admits nothing when empty. The principal, not the evidence: what it SENT is `HostConsumerMessage`, which outlives it. Kept after revocation as the record of what a host could reach and when; purged with the tenant. **DSAR-relevant: references a person via `createdByUserId` and `revokedByUserId`.** |
| `HostConsumerKillSwitch` | Regulatory artefact | No | RETAINED by the tenant purge (`TENANT_PURGE_RETAINED`), as `PeerAgentKillSwitch` and `AgentKillSwitch` are. Never deleted by lifting — lifting is an UPDATE stamping `liftedAt`, which a CHECK requires to carry a person and a reason; `app_user` holds no `DELETE`. `hostConsumerId` carries no FK, so the row outlives a revoked consumer | One kill on one host consumer (#3861): the evidence that traffic with a third-party host was stopped between two timestamps, by whom, and why. A partial unique index allows at most one kill in force per consumer, so lifting cannot leave a consumer stopped with no visible reason. `reason` / `liftReason` are encrypted at rest (`ENCRYPTED_FIELDS`). Indefinite while tenant active — review w/ compliance. **DSAR-relevant: references a person via `engagedByUserId` and `liftedByUserId`.** |
| `HostConsumerMessage` | Regulatory artefact | maybe | RETAINED by the tenant purge (`TENANT_PURGE_RETAINED`). Write-once: no `UPDATE` grant for `app_user` and a trigger refusing any update but a key-rotation sweep's re-wrap of the encrypted body; no `DELETE` for `app_user`. `hostConsumerId` and `runId` carry NO FK — deliberately, as `PeerAgentMessage.peerId` does — so the record outlives the consumer, the run, and the tenant purge that deletes the consumer. A `RESTRICT` relation here would make these retained rows block that purge instead | One inbound request from a host consumer (#3861): the exact body bytes, the client id presented and the access token's `jti`. **It is NOT the peer equivalent and must not be read as one.** A `PeerAgentMessage` carries an Ed25519 signature by a key its holder cannot repudiate; this carries what arrived and under which token. Non-repudiation here is WEAKER with nothing restoring it — threat-model R12 stays closed for peers and is open on this path, by owner decision (#3860, ADR 0003). `body` is encrypted at rest (`ENCRYPTED_FIELDS`) and may carry a customer's own business data a host passed in. Indefinite — review w/ compliance. **DSAR-relevant: the body can name a person.** |
| `PeerAgent` | Business record | Yes — names the accountable owner (`ownerUserId`) | Hard-delete by `CASCADE` from the tenant only. `app_user` holds no `DELETE` on the table, so a peer is retired (`status` RETIRED, one-way, a trigger) and never deleted by the app. `RESTRICT` from its owner and vendor | One A2A peer agent in another organisation that this tenant may exchange tasks with (#3673): a display name, the card URL, the supplier, a risk tier, the peer's public signing key, and the approved card pin with who approved it and the hash it replaced. Hashes only, never the card's text. Kept while the tenant is active, because the pin history is what answers which card a person accepted. **DSAR-relevant: references a person via `ownerUserId`, `pinnedByUserId` and `createdByUserId`.** |
| `TenantSkill` | Configuration | Yes — names its creator by user id (`createdByUserId`) | Hard-delete by `CASCADE` from the tenant only. Append-only: a trigger refuses every UPDATE, and `app_user` holds no `UPDATE` or `DELETE` on the table | The identity of a skill a tenant authored (#3680): its name, unique in the tenant and never a repository skill's, and who created it. Its text lives on its versions. Kept while the tenant is active, because a run's pin names it. **DSAR-relevant: references a person via `createdByUserId`.** |
| `TenantSkillVersion` | Business record | Yes — names people by user id (`authorUserId`, `evaluationAttachedByUserId`, `submittedByUserId`, `approvedByUserId`, `retiredByUserId`) | Hard-delete by `CASCADE` from its skill or the tenant, and by the tenant purge. `app_user` holds no `DELETE`; a version is RETIRED (one-way, a trigger), never deleted by the app. Its text and metadata are frozen after insert (trigger); `instructions` and `evaluationRecordJson` encrypted (Epic B) | One immutable version of a tenant-authored skill: the text a model was taught, its content hash, its evaluation record and who authored, submitted, approved and retired it. Kept while the tenant is active, because a run's pin names a version by id and hash. Purged with the tenant rather than retained as a regulatory artefact: the text is the tenant's, often a third party's licensed methodology that the product holds only under the tenant's licence, and the runs that pin it are purged with the tenant too. The hash-chained `TENANT_SKILL_*` audit rows, which carry each version's content hash, are what survive. **DSAR-relevant: references people via the five user-id columns.** |
| `AgentProfile` | Configuration | Yes — names its creator by user id (`createdByUserId`) | Hard-delete by `CASCADE` from its agent or the tenant, and by the tenant purge. `app_user` holds no `DELETE`; its identity is frozen (trigger) and only the pointer to the version in force moves | What one registered agent should do, as its tenant wrote it (#4143): one row per agent and the version in force. Its text lives on its versions. Kept while the agent exists. **DSAR-relevant: references a person via `createdByUserId`.** |
| `AgentProfileVersion` | Business record | Yes — names people by user id (`authoredByUserId`, `submittedByUserId`, `decidedByUserId`, `retiredByUserId`) | Hard-delete by `CASCADE` from its profile or the tenant, and by the tenant purge. `app_user` holds no `DELETE`; a version is RETIRED (one-way, a trigger), never deleted by the app. Its text and settings are frozen after insert (trigger); `instructions` encrypted (Epic B) | One immutable version of an agent profile: the instructions an agent is given, their hash, its tools, skills, model tier and triggers, and who authored, submitted, decided and retired it. Kept while the agent exists, because a run's pin names a version by id and hash. Purged with the tenant rather than retained as a regulatory artefact: the instructions are the tenant's own text, and the runs that pin them are purged with the tenant too. The hash-chained `AGENT_PROFILE_*` audit rows, which carry each version's hash, are what survive. **DSAR-relevant: references people via the four user-id columns.** |
| `PeerAgentInboundCredential` | Security ephemeral | No | Revocable (`revokedAt`, final by a trigger, at most one live per peer), and revoked by the retirement cascade when its receiving agent is retired; SHA-256 hash at rest, the token shown once; `app_user` holds no `DELETE`; hard-delete by `CASCADE` from the tenant only, `RESTRICT` from its peer and its receiving agent | The bearer one A2A peer presents inbound (#3679), bound to ONE receiving registered agent and an allowlist of workflow keys. A credential like `TenantApiKey` and `TenantDeviceToken`, hash-only at rest. Kept after revocation as the record of what a peer could reach and when; purged with the tenant. **DSAR-relevant: references a person via `createdByUserId` and `revokedByUserId`.** |
| `PeerAgentKillSwitch` | Regulatory artefact | No | RETAINED by the tenant purge (`TENANT_PURGE_RETAINED`), as `AgentKillSwitch` is. Never deleted by lifting — lifting is an UPDATE stamping `liftedAt`, which a CHECK requires to carry a person and a reason and a trigger makes final; `app_user` holds no `DELETE`. `peerId` carries no FK, so the row outlives a retired peer | One kill on one A2A peer (#3679): the evidence that traffic with a peer was stopped between two timestamps, by whom, and why. `reason` / `liftReason` are encrypted at rest (`ENCRYPTED_FIELDS`). Indefinite while tenant active — review w/ compliance. **DSAR-relevant: references a person via `engagedByUserId` and `liftedByUserId`.** |
| `PeerAgentMessage` | Regulatory artefact | maybe | RETAINED by the tenant purge (`TENANT_PURGE_RETAINED`). Write-once: no `UPDATE` grant for `app_user` and a trigger refusing any update but a key-rotation sweep's re-wrap of the encrypted body; no `DELETE` for `app_user`. `peerId`, `runId` and `journalId` carry no FK, so a receipt outlives the peer, the run and the journal row it was about | One signed A2A message, sent or received (#3679): the receipt both sides keep — the signed statement, the Ed25519 signature, the exact body its digest covers, and the public key it verifies under (bound by the key id it names), so it re-verifies from the row alone. Signed evidence of an agent action, the class `AgentActionReceipt` has ([the agentic IAM retention classes](agentic-iam-roadmap.md#retention-classes), step `4b`). `body` is encrypted at rest (`ENCRYPTED_FIELDS`) and may carry task text another organisation wrote or tenant data sent to one. Indefinite — review w/ compliance. **DSAR-relevant: the body can name a person.** |
| `TenantA2aSigningKey` | Configuration | No | Purged with the tenant (FK cascade from `Tenant`), the class `AgentHarnessScannerKey` has. Never deleted by the app (`app_user` holds no `DELETE`): a rotation RETIRES the key in force — stamps `retiredAt`/`retiredByUserId` and NULLs its seed, final by a trigger — and keeps its public key and fingerprint, so receipts signed before the rotation stay verifiable by the key id they name. The retained `PeerAgentMessage` rows carry their own copy of the public key, so a receipt stays checkable after this table is purged | The tenant's own A2A signing key (#3679, owner decision 2026-10-19), one in force per tenant. `privateKeySeed` is encrypted under the tenant DEK (`ENCRYPTED_FIELDS`) and is NULL on every retired row; the public key and fingerprint are not secret. Kept as long as the tenant. **DSAR-relevant: names the people who created and retired a key (`createdByUserId`, `retiredByUserId`).** |
| `AgentProposal` | Operational | No | None today — cascade on tenant delete only | No TTL today — pending/rejected proposals are candidates for time-boxed prune |
| `AgentProposal` | Business record | No | Hard-delete by `CASCADE` from the tenant only. The `agent-proposal-expiry` sweep TRANSITIONS a `PENDING` row past its `expiresAt` to the terminal `EXPIRED` status, and retiring the agent transitions every `PENDING` row of that agent the same way (#3698); neither deletes anything or erases a column | The propose-not-commit queue. Deliberately never pruned by age: an unapproved proposal is the record of something an agent asked for and no human agreed to, which is the evidence an ASI09 review reads. Expiry bounds what is APPROVABLE, not what is retained. Indefinite while tenant active — review w/ compliance |
| `AgentProposalSampleAudit` | Business record | No | Hard-delete by `CASCADE` from the proposal or the tenant; purged on tenant deletion with its proposal (owner decision 2026-10-18) | The retrospective sample audit of an already-approved proposal (OWASP ASI09) — the only measurement of whether the human approval gate is doing anything. One row per sampled proposal, carrying a verdict and stable dissent CODES; no free text, so it holds none of the agent-authored content it is about. Kept for as long as the proposal it judges, because a disagreement rate whose history can be pruned is one nobody can trend. Indefinite while tenant active — review w/ compliance |
| `WorkflowRun` | Operational | maybe | None today — cascade on tenant delete only | No TTL today — completed/failed runs are candidates for time-boxed prune |
| `WorkflowStep` | Operational | maybe | None today — cascade on run/tenant delete only | No TTL today — the run's append-only step narrative |
| `FrameworkVersionDiff` | Configuration | No | Global reference (no tenantId) — never per-tenant deleted | Lives with the framework library; a version-diff record |
| `TenantFrameworkDelta` | Operational | No | Cascade on tenant/diff delete | No TTL today — reviewed/dismissed deltas are candidates for time-boxed prune |
| `RiskTemplate` | Configuration | No | None — global reference data, upserted by the deploy-time catalogue seed | Global catalogue, NOT tenant data. Unaffected by tenant deletion; no delete path exists. |
| `RiskTreatmentPlan` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `ScimGroup` | Configuration | maybe | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `Task` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `TaskComment` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `TaskKeySequence` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `TaskLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `TaskWatcher` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Tenant` | Configuration | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | RETAINED as a tombstone — the purge empties the tenant and keeps this row, because `AuditLog`/`Incident`/`ReadinessSnapshot`/`AccessReview` carry a NOT-NULL non-cascading FK to it (`TENANT_PURGE_RETAINED`) |
| `TenantApiKey` | Security ephemeral | No | `expiresAt` expiry (security); every key bound to an agent is revoked (`revokedAt`, row kept) when the agent is retired (#3698) | DEFINED — expiry-driven |
| `TenantCustomRole` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantEntraGroupMapping` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantIdentityProvider` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantInvite` | Security ephemeral | maybe | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `TenantMembership` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion. Its `lineOfDefence` column (#3675) takes the model's class; every change to it writes a hash-chained `MEMBER_LINE_OF_DEFENCE_CHANGED` audit row, which survives the membership |
| `TenantNotificationSettings` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantOnboarding` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `TenantScimToken` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
| `TenantSecuritySettings` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TreatmentMilestone` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `TrustCenter` | Configuration | No | Cascade on tenant delete; `enabled=false` by default (no public page until published) | Lives with tenant; purged on tenant deletion. Public projection only — no PII unless the tenant types it |
| `User` | PII subject | Yes | None today — cascade on parent/tenant delete only | UNDEFINED — GDPR erasure question |
| `UserIdentityLink` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
| `UserMfaEnrollment` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
| `UserCalendarConnection` | Security ephemeral | No | Cascade on User delete; row RETAINED after revoke (token destroyed) so already-pushed events remain attributable for cleanup | DEFINED — revoke destroys the credential, the row survives |
| `TenantCalendarConsent` | Regulatory artefact | No | RETAINED indefinitely, including after withdrawal — it records WHO authorised a third party to reach every user in the tenant, and the grantedBy FK is RESTRICT so offboarding the admin cannot erase it | DEFINED — kept as an access-review record |
| `UserCalendarEventMapping` | Operational | No | Cascade on User delete; a row is deleted only once its remote calendar event is confirmed removed — a failed delete keeps the row in PENDING_DELETE so the orphan stays nameable | DEFINED — lifetime is the pushed event's |
| `UserNotificationPreference` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `UserSession` | Security ephemeral | maybe | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `Vendor` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `VendorAssessment` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorAssessmentAnswer` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorAssessmentTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `VendorAssessmentTemplateQuestion` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `VendorAssessmentTemplateSection` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `VendorContact` | Business record | Yes | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorDocument` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorEvidenceBundle` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorEvidenceBundleItem` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VendorRelationship` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `VerificationToken` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |

## Per-category policy

Each subsection: **Default** (what we recommend) · **Floor/ceiling** (what
regulation may force) · **Mechanism** · **Owner** · **Cleanup wiring** ·
**Customer override**.

### Business record (63)

> Risk · Control · Policy · Asset · Vendor · Audit · Task · Evidence · Finding · Process · …

- **Default:** retain indefinitely while the tenant is active. There is **no
  per-record TTL** on most of these — a `Risk` created in 2026 is still present
  in 2036 unless a user deletes it or the tenant is deleted. **This is the
  intended posture today** (compliance records are evidence of work and are
  expected to persist for the audit trail), but it should be confirmed with
  compliance rather than assumed.
- **Floor/ceiling:** none engineering-imposed. SOC 2 / ISO 27001 evidence is
  typically expected to be retained for the duration of the certification cycle
  plus a margin — a compliance decision.
- **Mechanism:** soft-delete (`deletedAt`) on 12 models in `SOFT_DELETE_MODELS`
  (`Asset, Risk, Control, Evidence, Policy, Vendor, FileRecord, Task, Finding,
  Audit, AuditCycle, AuditPack`). Soft-deleted rows on **those** models are
  hard-purged after a 90-day grace by `data-lifecycle`. 8 models carry a
  `retentionUntil` column (`Asset, Risk, Control, Evidence, Policy, Vendor,
  FileRecord, Task`) but only **2** are swept by `runRetentionSweep` —
  `Asset` and `Evidence`, the only two anything in `src/` can actually write.
  The other 6 were removed from `RETENTION_MODELS` (`Control` 2026-08-06;
  `Risk, Policy, Vendor, FileRecord, Task` 2026-08-12) because a swept column
  with no writer is a guaranteed-empty query that reads as a control the
  product does not provide. **Evidence is the only one with an end-to-end,
  exercised retention flow** (set date → reminder → archive → hard purge) and
  is the template for extending the rest: to sweep a model, expose
  `retentionUntil` on its update schema + edit UI in the same change that
  adds it back to `RETENTION_MODELS`.
- **Gap — soft-deleted rows that are never purged:** 7 models carry `deletedAt`
  but are **not** in `SOFT_DELETE_MODELS`, so their soft-deletes live forever:
  `AccessReview, AutomationRule, ControlException, LossEvent, ProcessMap,
  RiskTreatmentPlan, Tenant`. Either add them to the purge set or document why
  they are excluded. (`AccessReview` is a regulatory artefact since 2026-10-18,
  so for it the answer is the exclusion: a soft-deleted campaign is still
  evidence that a review happened.)
- **Owner:** Compliance (retention period) + Engineering (mechanism).
- **Customer override:** none today. A per-tenant / per-category retention knob is
  an open question (see below).

### Regulatory artefact (3)

> `AuditLog` · `OrgAuditLog` · `ReadinessSnapshot`

- **Engineering position (firm):** `AuditLog` and `OrgAuditLog` are **immutable
  and hash-chained** (Epic C — `src/lib/audit/audit-writer.ts` + the
  `IMMUTABLE_AUDIT_LOG` DB trigger). **We do not delete audit-log entries by
  default.** Deleting them would require a coordinated schema-change PR *plus* a
  data-protection-impact-assessment, and would break the hash chain unless done
  with a documented re-chaining procedure.
- **Default / Floor / ceiling:** **deferred to legal.** The retention period under
  our SOC 2 commitments is a regulatory decision, not an engineering one.
- **Mechanism:** append-only; never soft-deleted.
- **On tenant deletion:** every tenant-scoped regulatory artefact is in
  `TENANT_PURGE_RETAINED` and the purge skips it — including access-review
  campaigns, whole, since 2026-10-18. Skipping is not sufficient where a
  cascade reaches the row from a purged parent, so no model is classed here
  whose `ON DELETE CASCADE` runs from a purged one; see "Tenant purge" below.
- **Owner:** Legal / Compliance (period) — Engineering only executes a signed-off
  procedure.
- **Customer override:** none, and likely should remain none (tamper-evidence is
  the point).

### Operational (20)

> Notification · NotificationOutbox · ReminderHistory · `*Execution` · snapshots ·
> `*KeySequence` · TenantOnboarding · RiskSuggestion*/Simulation

- **Default:** time-boxed. These are transient/regenerable. Recommended starting
  point: **90-day hard-delete** for notifications/executions/webhook events;
  snapshots retained as long as their trend window needs (e.g. 13 months).
- **Mechanism:** **none today** — this is the largest gap. No job prunes
  `Notification`, `IntegrationExecution`, `AutomationExecution`,
  `NotificationOutbox`, etc.
- **Owner:** Engineering (these are not regulated).
- **Cleanup wiring:** to be added — see the candidate jobs in the cleanup
  inventory.
- **Customer override:** not needed (operational data is not customer-meaningful).

### Security ephemeral (13)

> PasswordResetToken · VerificationToken · TenantInvite · OrgInvite · UserSession ·
> AuthSession · Account · TenantApiKey · TenantScimToken · AuditPackShare ·
> AuditorPackAccess · UserMfaEnrollment · UserIdentityLink

- **Default:** governed by **security**, not data-retention. Lifetimes are short
  and intentional (e.g. `PasswordResetToken` 1h single-use; `UserSession` capped
  by `TenantSecuritySettings.sessionMaxAgeMinutes` + revocation, Epic C.3).
- **Mechanism:** `expiresAt` / revocation. Expired rows are inert; a periodic
  hard-delete of expired tokens is a hygiene nicety, not a compliance need.
- **Owner:** Engineering / Security.
- **Note:** a retention policy for an invite token is **not** the same
  conversation as a retention policy for a `Risk` — kept deliberately separate.

### PII subject (2)

> `User` · `AuditorAccount`

- **This is the GDPR Article 17 right-to-erasure surface.** The erasure +
  export workflow is being built as the DSAR sequence — see
  [`docs/dsar.md`](dsar.md) (Stage 1 foundation shipped; execution sequenced).
- **Supported today?** **No** — beyond `User.deletedAt` soft-delete, there is no
  erasure execution yet. Soft-deleting a `User` does not scrub their PII from the
  row, nor cascade-scrub their authored content, nor reconcile with the immutable
  `AuditLog` (which references `userId`). The DSAR foundation (`docs/dsar.md`)
  lands the model + workflow; Stage 3 lands the irreversible cascade.
- **What landing real erasure requires:** (a) a documented cascade across all
  tenant data referencing the user; (b) a decision on how to treat `AuditLog`
  references (pseudonymise the `userId`? retain under legal-basis exemption?);
  (c) an admin/self-service request flow + audit of the erasure itself; (d) a
  DPIA. Non-trivial — a dedicated follow-up effort (see Open questions).
- **Owner:** Legal (obligation + lawful-basis carve-outs) + Engineering (flow).

### Financial (2)

> `BillingAccount` · `BillingEvent`

- **Default:** retain for the regulatory financial-records period — **typically 7
  years** in most jurisdictions. **Verify with finance.**
- **Mechanism:** **none today.**
- **Owner:** Finance (period) + Engineering (mechanism).
- **Customer override:** none (regulatory floor overrides customer preference).

### Configuration (36)

> Tenant/Org structure · memberships · templates · framework reference data ·
> integration + security + notification settings

- **Default:** lives with the tenant; **purged on tenant deletion** (cascade from
  `Tenant`). No independent TTL.
- **Mechanism:** the tenant purge, 90 days after the tenant is soft-deleted
  (`deletedAt`) — see "Tenant purge" under the cleanup-job inventory. `Tenant`
  itself is retained as the tombstone the regulatory artefacts point at.
- **Owner:** Engineering + Product (tenant-deletion grace period).
- **Customer override:** n/a (this *is* the customer's configuration).

## Cleanup-job inventory

| Job (schedule) | Function | What it does | Coverage |
|----------------|----------|--------------|----------|
| `retention-sweep` (daily 04:00 UTC) | `runEvidenceRetentionSweep` (`jobs/retention.ts`) | Archives `Evidence` where `retentionUntil < now`, not already archived, not soft-deleted. Idempotent. | Evidence only |
| `daily-evidence-expiry` (daily 06:00 UTC) | `runDailyEvidenceExpiryNotifications` (`jobs/dailyEvidenceExpiry.ts`); reminder generation also in `runEvidenceRetentionNotifications` (`jobs/retention-notifications.ts`) | N-day-before (30/7/1) reminder tasks for expiring evidence, gated by `Tenant.reminderDaysBefore` (default 14). | Evidence only |
| `data-lifecycle` (daily 03:00 UTC) | `purgeSoftDeletedOlderThan` (90-day grace, 12 `SOFT_DELETE_MODELS`) · `purgeExpiredEvidenceOlderThan` (hard-delete archived evidence > 365 days) · `runRetentionSweep` (cross-model `retentionUntil` sweep over the 2 `RETENTION_MODELS` that have a writer — `Asset`; `Evidence` is skipped by that loop and handled by the separate `retention-sweep` cron) — all in `jobs/data-lifecycle.ts` | The actual purge engine: hard-deletes aged soft-deletes + aged archived evidence; sweeps `retentionUntil` across the retention models. | 12 soft-delete + 2 retention models |

### Legacy access snapshots — a tenant setting, 90 days by default

`data-lifecycle` also runs `purgeLegacyAccessSnapshotsOlderThan`
(`jobs/data-lifecycle.ts`), which deletes `LegacyAccessSnapshot` rows — and
their `LegacyAccount` children by CASCADE — on one of two clocks:

| | setting | default | measured on |
|---|---|---|---|
| Consumed | `legacySnapshotRetentionDays` | 90 | the LAST `LegacyAccountResolution` written against it |
| Never consumed | `legacySnapshotUnconsumedRetentionDays` | 30 | `pulledAt` |

**Why the consuming run and not `pulledAt`.** A snapshot pulled in March and
first reconciled in September has a dispute window that opens in September.
Keying off the pull date would delete it the week it became relevant. The window
exists so a reviewer disputing a link can see the account as it was when the
suggestion was made — the same reason `legacyUsernameConvention` keeps
`previousTemplate`. It is the LAST consuming run, not the first: a snapshot
reconciled twice has its window reopened, because the suggestions a reviewer
might dispute belong to the second run.

**Why an unconsumed snapshot still ages out, faster.** A connection that pulls
and never reconciles — a mapping left half-configured, a campaign never launched
— would otherwise accumulate named people's access indefinitely, which is the
case #3317 was filed about. Nothing cites a snapshot with no resolutions, so
deleting it costs a re-pull rather than evidence.

**30 is a chosen default.** The #3317 decision fixed 90 for the consumed window
and said only "probably shorter" for the other. Both are tenant settings, so
revising either is configuration.

**A coupling to know about.** `LegacyAccountResolution` CASCADEs from
`IntegrationExecution`, which the 730-day purge above deletes. The consumption
signal is therefore perishable: shortening that window below the legacy-snapshot
window would silently reclassify a CONSUMED snapshot as unconsumed and destroy
it on the shorter clock, inside its own dispute window. 730 against 90 leaves
eight times the headroom; the invariant is asserted in
`tests/integration/legacy-snapshot-retention.test.ts` rather than left as prose,
because the failure is silent and the two numbers live in different files.

### Tenant purge — what a deleted tenant keeps

`data-lifecycle` runs `purgeSoftDeletedTenants` (`usecases/tenant-purge.ts`)
last, over every tenant soft-deleted more than 90 days ago. In one transaction
per tenant it issues `DELETE … WHERE "tenantId" = $1` against every
tenant-scoped table, children first in an order derived from the live
foreign-key graph, EXCEPT the tables in `TENANT_PURGE_RETAINED`: every
tenant-scoped model this document classes as a **Regulatory artefact**, plus
the `Tenant` row as the tombstone they point at.

Skipping a table is not, on its own, keeping its rows: a retained child with
an `ON DELETE CASCADE` foreign key to a purged parent is deleted by Postgres
when the parent is. A retained model is therefore kept only when every
cascade path into it starts at another retained model.

**Access-review campaigns are retained whole** (owner decision, 2026-10-18,
#3716 / #3724). `AccessReview`, `AccessReviewDecision`,
`AccessReviewConnectedDecision`, `AccessReviewAgentPack`,
`AccessReviewAgentNarrowing` and `AccessReviewDecisionSampleAudit` all
survive, for every scope (member, connected, legacy, agent). Before that
decision the four evidence tables were in the retained set while their
campaign root was not, so the purge's `DELETE FROM "AccessReview"` removed
them by cascade. What a campaign references that the purge DOES remove is
detached by a column-scoped `SET NULL`, never cascaded: the membership
(`AccessReviewDecision.membershipId`), the directory account
(`AccessReviewConnectedDecision.connectedAccountId`) and the evidence PDF's
`FileRecord` row (`AccessReview.evidenceFileRecordId`; the purge deletes rows,
not stored objects). The frozen snapshot columns carry what those pointed at.
The retained rows name people by global `User` id — reviewer, decider,
subject — exactly as `AuditLog` does; the purge deletes no `User`, and erasing
a person is the DSAR path's job (`docs/dsar.md`), not the purge's.

**Five models that cascade from a purged parent are removed with it**
(owner decision 2026-10-18, open question 10). A purged tenant keeps none of
them. Each has an `ON DELETE CASCADE` foreign key to a table the purge
deletes, so each is classed with that parent and purged with it. They were
once classed as regulatory artefacts and listed in `TENANT_PURGE_RETAINED`,
and the database removed them anyway:

| Model | Lives and dies with | Class |
| --- | --- | --- |
| `AgentPolicyCardVersion` | `AgentPolicyCard` | Configuration |
| `AgentProposalApproval` | `AgentProposal` | Business record |
| `AgentProposalSampleAudit` | `AgentProposal` | Business record |
| `AgenticEvidenceArtefact` | `Control`, `Evidence`, `RegisteredAgent` | Business record |
| `IncidentEvidence` | `Evidence` | Business record |

Retaining the parents instead would have kept the business data the purge
exists to remove; detaching the foreign keys would have needed a migration
and, for the append-only tables, a trigger change.

`tests/guardrails/tenant-purge-retained-never-cascades.test.ts` holds the rule
for every retained model: it closes the purge's deleted set over every cascade
relation in the schema and fails, with no allowlist, if a retained table is
reachable.

### Identity write artefacts — 730 days

`data-lifecycle` also runs `purgeIdentityArtefactsOlderThan`
(`jobs/data-lifecycle.ts`), which deletes `IdentityWriteJournal` rows older
than 730 days measured on `attemptedAt`, and `IntegrationExecution` rows older
than 730 days measured on `executedAt`.

**Why 730.** It matches `risk-snapshot-jobs.ts`, so the product has one
retention answer for compliance artefacts rather than two, and it is two annual
audit cycles: an auditor sampling a 12-month period in early 2026 needs
early-2025 rows present. Before this, the answer was *forever*.

**Why by AGE and not `retentionUntil`.** These are not in `RETENTION_MODELS`.
That list is the per-row mechanism and a model joins it only when
`retentionUntil` is on its update schema and its edit UI — see the warning
above this section about six models that sat in that list as guaranteed-empty
queries. Nobody sets a retention date on an individual directory write.

**Why `attemptedAt` and not `settledAt`.** `settledAt` is NULL on a row that
never settled. Pruning on a nullable column would keep the unsettled rows
forever, and those are the ones an operator most wants bounded.

**What the attestation carries.** One `DATA_PURGED` audit row per tenant per
model, holding COUNTS and never identifiers. The sibling evidence purge names
each record it destroys; doing that here would copy `externalUserId` into a row
that outlives the journal, retaining exactly the personal data the purge
exists to remove. `AuditLog.tenantId` is required, which is why the purge is
grouped by tenant rather than swept globally.

There is ONE purge implementation. `src/lib/retention-purge.ts` used to hold a
second, manual/CLI variant of the same sweep; it was deleted (2026-08-14)
because nothing imported it but its own test, and the two had drifted in both
directions — the dead copy carried a global-row guard the live path lacked,
while the live path gained storage-blob reclamation the dead copy never had.
The guard moved across (`NULLABLE_TENANT_MODELS` in `jobs/data-lifecycle.ts`);
the rest went.

### Candidate cleanup jobs the policy implies (NOT built here — follow-up PRs)

- **`operational-prune`** — hard-delete `Notification`, `NotificationOutbox`,
  `ReminderHistory`, `AutomationExecution`, `IntegrationExecution`,
  `IntegrationWebhookEvent` older than 90 days (per-table TTL).
- **`soft-delete-purge-completeness`** — extend `SOFT_DELETE_MODELS` (or a parallel
  set) to cover the 7 `deletedAt` models currently never purged.
- **`pii-erasure`** — the GDPR Article 17 flow (PII subject section).
- **`financial-retention`** — enforce the 7-year (TBD) floor on `BillingEvent` and a
  matching ceiling/expiry once finance confirms.
- **`tenant-hard-purge`** — after a tenant-deletion grace period, hard-purge a
  soft-deleted `Tenant` and its cascade.

## Open questions

Each blocks a customer/compliance sign-off. Format: **decision owner** ·
*engineering implication of each plausible answer* · **default until decided**.

1. **`AuditLog` retention under SOC 2.** Owner: **Legal/Compliance.** *Implication:*
   "retain forever" = status quo (no work); "retain N years then archive/delete" =
   a coordinated schema-change + re-chaining procedure + DPIA. **Default: retain
   indefinitely, never delete.**
2. **GDPR Article 17 right-to-erasure — supported today?** Owner: **Legal +
   Engineering.** *Implication:* it is **not** supported beyond soft-delete; landing
   it is a multi-PR effort (cascade scrub + `AuditLog` reconciliation + request
   flow + DPIA). **Default: documented follow-up effort; soft-delete only.**
3. **Evidence retention after tenant cancellation.** Owner: **Product +
   Compliance.** *Implication:* today a cancelled tenant's evidence is retained
   exactly like an active tenant's; arguably should be "retain N days, then
   hard-delete." **Default: same as active (no special cancel handling).**
4. **`BillingEvent` / `BillingAccount` retention.** Owner: **Finance.**
   *Implication:* most jurisdictions require ~7 years for financial records; pick
   the floor, then add `financial-retention`. **Default: indefinite (no job).**
5. **No-TTL business records (Risk/Control/Policy/…).** Owner: **Compliance.**
   *Implication:* "retain indefinitely while active, purge on tenant deletion" =
   status quo; "per-record TTL" = a new sweep + a per-category knob. **Default:
   indefinite while tenant active.**
6. **Operational-data TTL (Notification/execution/webhook tables).** Owner:
   **Engineering.** *Implication:* unbounded growth until addressed; a 90-day
   `operational-prune` is low-risk. **Default: no TTL (grows unbounded).**
7. **Per-category retention knobs.** Owner: **Product + Engineering.** *Implication:*
   `Tenant.reminderDaysBefore` is the *only* per-tenant retention knob today.
   Per-category knobs (`evidence_retention_days`, `audit_log_retention_years`,
   `notification_retention_days`) would be a tier-gated feature. **Default: single
   global behaviour, no per-tenant retention configuration.**
8. **The 7 `deletedAt`-but-never-purged models.** Owner: **Engineering.**
   *Implication:* `AccessReview, AutomationRule, ControlException, LossEvent,
   ProcessMap, RiskTreatmentPlan, Tenant` accumulate soft-deleted rows forever;
   either add to the purge set or document the exclusion. **Default: never purged.**

9. ~~**Legacy access snapshot retention.**~~ **DECIDED 2026-10-11 — see
   "Legacy access snapshots" above.** A TTL sweep on two clocks: 90 days after the
   run that consumed a snapshot, 30 days after `pulledAt` for one nothing ever
   consumed, both tenant settings. The third option considered — keep the snapshot
   row and purge the accounts — was rejected as the worst of the three: it would
   preserve the appearance of integrity evidence while destroying the thing that
   verifies it. Kept here, struck through rather than deleted, because an open
   question that vanishes leaves no trace of what was weighed; the answer and its
   reasoning are one scroll up. One residual choice is recorded as the implementer's
   rather than the decision's: 30 for the unconsumed clock, where #3317 said only
   "probably shorter".

10. ~~**Retained models a tenant purge still removes by cascade.**~~ **DECIDED
    2026-10-18 — see "Tenant purge" above.** `AgentPolicyCardVersion`,
    `AgentProposalApproval`, `AgentProposalSampleAudit`,
    `AgenticEvidenceArtefact` and `IncidentEvidence` were classed as regulatory
    artefacts while each cascades from a table the purge deletes. Three answers
    were weighed: retain the parent (business data the purge exists to remove),
    detach the foreign key (a migration, and a trigger change for the
    append-only tables, because a `SET NULL` is an UPDATE), or class the model
    with its parent. The owner chose the third: they leave `TENANT_PURGE_RETAINED`
    and are removed with their parent. Access-review campaigns, decided the same
    day, went the first way because their parent IS the evidence. Kept here,
    struck through, for the reason item 9 gives.

## Cross-references

- [`docs/encryption-data-protection.md`](encryption-data-protection.md) — the
  confidentiality-at-rest half of the data-protection story.
- [`docs/incident-response.md`](incident-response.md) — data-breach response
  references retained data scope.
- [`docs/billing.md`](billing.md) — the tenant-cancellation flow has retention
  implications (open question 3).
- `CLAUDE.md` → Architecture → **Data Retention**.
