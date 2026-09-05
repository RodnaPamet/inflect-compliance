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
| `AccessReview` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `AccessReviewDecision` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Account` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
| `AgentActionReceipt` | Regulatory artefact | No | None today — immutable-ish evidence; cascade on tenant delete only. `scannedSummary` is scrubbed/bounded (no raw payloads/PII) | Mediator-signed AI-agent action evidence; verified rows link to the hash-chained `AuditLog`. Retention tracks the audit trail — **needs legal/auditor input** |
| `AiDecisionLog` | Regulatory artefact | No | Append-only (immutability trigger); digest + sanitised summary only; cascade on tenant delete | EU AI Act Art 12 record — retention **needs legal input** |
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
| `AuditPack` | Business record | No | Soft-delete (`deletedAt`); 90-day purge via `data-lifecycle` | Active: indefinite. Soft-deleted: 90-day purge |
| `AuditPackItem` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `AuditPackShare` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `AuditPackShareComment` | Business record | Yes (`body`) | Cascade on pack/share/tenant delete; item set-null; status lifecycle (OPEN→RESOLVED) | Indefinite while tenant active — the auditor return-channel record (comments / evidence requests / findings) is part of the audit artefact |
| `AuditorAccount` | PII subject | Yes | None today — cascade on parent/tenant delete only | UNDEFINED — GDPR erasure question |
| `AuditorPackAccess` | Security ephemeral | No | None today — cascade on parent/tenant delete only | DEFINED — expiry-driven |
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
| `ControlTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `ControlTemplateRequirementLink` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `ControlTemplateTask` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
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
| `Framework` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `FrameworkMapping` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `FrameworkPack` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `FrameworkRequirement` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `FrameworkRequirementOrder` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `Incident` | Regulatory artefact | maybe | None today — indefinite while tenant active; `description` encrypted | NIS2 Article 23 record — retention is a **legal** decision (incident records often have multi-year statutory retention); **needs legal input** |
| `IncidentNotification` | Regulatory artefact | maybe | None today — cascade on parent incident delete only; `submissionNote` encrypted | The filed Article 23 report + authority case ref — retention tracks the parent incident; **needs legal input** |
| `IncidentTimelineEntry` | Regulatory artefact | maybe | None today — cascade on parent incident delete only; `entry` encrypted | Forensic incident narrative — retention tracks the parent incident; **needs legal input** |
| `IncidentEvidence` | Regulatory artefact | No | None today — cascade on parent incident/evidence delete only | Junction linking forensic Evidence to an incident; retention tracks the parent incident + the Evidence record's own retention |
| `IntegrationConnection` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `IntegrationExecution` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `IntegrationSyncMapping` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ConnectedIdentityAccount` | Operational | No | Re-synced each run; vanished accounts reconciled to DEPROVISIONED; cascade on tenant delete | Directory mirror (Okta / Google Workspace) — no TTL; row lifecycle tracks the live directory, purged on tenant deletion |
| `IdentityWriteJournal` | Regulatory artefact | No | Append-only; `SET NULL` on link delete so it OUTLIVES the link and the employee row; cascade on tenant delete | Evidence that an automated system changed a named person's directory access, and the captured prior state that makes the change reversible. No TTL, and deliberately NOT cascaded from `IdentityAccountLink`: deleting an employee for privacy must not erase the record that their access was revoked, which is frequently the artefact an auditor asks for. `priorStateJson` holds provider-shaped directory attributes, not free text. **DSAR-relevant: references a person via `externalUserId`.** |
| `IdentityAccountLink` | PII subject | No | Re-observed and re-stamped on every healthy identity sync; CASCADE from both `Employee` and `ConnectedIdentityAccount`; cascade on tenant delete | Asserts that a named worker owns a named directory account — a link between two identified people-records, so it is PII in its own right. No TTL: the pairing must outlive quiet periods to be readable at termination, which is the whole reason it is stored rather than computed. Dies automatically with either side it describes, so it cannot outlive the subject. **DSAR-relevant PII.** |
| `Employee` | PII subject | No | Re-synced from HRIS (idempotent by workEmail) or manual; cascade on tenant delete | Personnel record (name + work email + employment status). No TTL today — tracks the live roster; purged on tenant deletion. **DSAR-relevant PII.** |
| `Device` | Operational | No | Re-reported by agent/MDM (upsert by serial) or manual; cascade on tenant delete | Endpoint posture inventory (serial/hostname + encryption/lock/AV flags). No TTL; tracks the live fleet, purged on tenant deletion |
| `TenantDeviceToken` | Security ephemeral | No (SHA-256 hash at rest) | Revocable (`revokedAt`); cascade on tenant delete | Per-tenant device-agent credential (like `TenantApiKey`) — hash-only at rest, single-use lookup; purged on tenant deletion |
| `TrainingCourse` | Configuration | No | Cascade on tenant delete | Course catalogue; lives with tenant |
| `TrainingAssignment` | Business record | No | Cascade on employee/tenant delete | Training-completion record — compliance evidence of annual security-awareness training; retained while tenant active |
| `BackgroundCheck` | PII subject | Yes (`resultSummary`) | Cascade on employee/tenant delete; result encrypted | Pre-employment screening record — sensitive PII (adverse-action detail encrypted at rest). **DSAR-relevant; needs a retention commitment.** |
| `AccessReviewConnectedDecision` | Regulatory artefact | No | Cascade on review/tenant delete; account SetNull | Frozen access-review evidence for a connected identity account (SOC 2 UAR); retained with the parent review |
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
| `OrgDashboardWidget` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `OrgInitiativeLink` | Operational | No | None today — cascade on initiative/org delete only | Append-only cross-tenant work links; pruned with the initiative |
| `OrgInvite` | Security ephemeral | maybe | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `OrgMembership` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `OrgMaturityRating` | Operational | No | None today — cascade on org delete only | Append-only maturity-rating history (human-judgment); no TTL today — candidate for time-boxed prune |
| `OrgSecurityInitiative` | Operational | No | None today — cascade on org delete only | Portfolio programme records; no TTL today — review w/ compliance |
| `OrgThreatLevel` | Operational | No | None today — cascade on org delete only | Append-only posture history (human-curated); no TTL today — candidate for time-boxed prune |
| `Organization` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `PackTemplateLink` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `PasswordResetToken` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `Policy` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `PolicyAcknowledgement` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyAcknowledgementAssignment` | Business record | maybe | None today — cascade on parent policy-version/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyApproval` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyControlLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PolicyEvidenceItem` | Business record | No | None today — cascade on parent policy/tenant delete; evidence link SetNull on evidence delete | Indefinite while tenant active — review w/ compliance |
| `PolicyTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `PolicyVersion` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `PortfolioSnapshot` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ProcessEdge` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ProcessEdgeControl` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `ProcessMap` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `ProcessMapSnapshot` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ProcessNode` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `QuestionnaireQuestion` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `QuestionnaireTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `ReadinessSnapshot` | Regulatory artefact | ind. | Immutable + hash-chained (never deleted) | Regulatory min/max — **needs legal/auditor input** |
| `ReminderHistory` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ReportRun` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `ReportSchedule` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `ReportTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `RequirementMapping` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `RequirementMappingSet` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
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
| `RegisteredAgent` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged; `RESTRICT` from `AgentProposal`/`WorkflowRun` so an agent with attributed work cannot be hard-deleted; `description` encrypted (Epic B) | The register of which autonomous agents held what authority, and who was accountable. Deliberately long-lived: an incident review months later asks exactly this. `RETIRED`/`SUSPENDED` are lifecycle states, not deletions. Soft-deleted rows **not auto-purged** — same gap as `AiSystem`. Names an accountable person via `ownerUserId` |
| `RegisteredAgentTool` | Configuration | No | Hard-delete on revoke; `CASCADE` from `RegisteredAgent` and from the tenant | The deny-by-default allowlist of MCP tools one registered agent may reach. Deliberately NOT soft-deleted: a grant is authority, not history, and a revoked-but-retained row is one `WHERE` clause away from granting again. The history lives in the hash-chained `AGENT_TOOL_GRANTED` / `AGENT_TOOL_REVOKED` audit entries |
| `AgentAssessmentDomain` | Configuration | No | Global seed reference — reseeded, never tenant-purged | Lives with the deployment; refreshed from the agent-risk-assessment fixture. The four IMDA agentic dimensions; no tenant content |
| `AgentAssessmentQuestion` | Configuration | No | Global seed reference (IMDA dimension names + OWASP ASI class ids, paraphrased) — reseeded, never tenant-purged | Lives with the deployment; refreshed from the agent-risk-assessment fixture. Ids are stable external keys, so the seed is an upsert and never a reload |
| `AgentRiskAssessment` | Business record | No | None today — `CASCADE` from `RegisteredAgent` and from the tenant | The record of how an agent's operational risk tier was arrived at, and the state it was true of. Deliberately long-lived: the tier CAPS the agent's authority, so an incident review asks what was assessed and when. Indefinite while tenant active — review w/ compliance |
| `AgentRiskAssessmentAnswer` | Business record | No | None today — `CASCADE` from the assessment and from the tenant | Per-question answers behind an agent's risk tier; `note` encrypted at rest (Epic B) + sanitised on write (Epic D). Indefinite while tenant active — review w/ compliance |
| `AgentProposal` | Operational | No | None today — cascade on tenant delete only | No TTL today — pending/rejected proposals are candidates for time-boxed prune |
| `WorkflowRun` | Operational | maybe | None today — cascade on tenant delete only | No TTL today — completed/failed runs are candidates for time-boxed prune |
| `WorkflowStep` | Operational | maybe | None today — cascade on run/tenant delete only | No TTL today — the run's append-only step narrative |
| `FrameworkVersionDiff` | Configuration | No | Global reference (no tenantId) — never per-tenant deleted | Lives with the framework library; a version-diff record |
| `TenantFrameworkDelta` | Operational | No | Cascade on tenant/diff delete | No TTL today — reviewed/dismissed deltas are candidates for time-boxed prune |
| `RiskTemplate` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `RiskTreatmentPlan` | Business record | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Soft-deleted rows **not auto-purged** — gap |
| `ScimGroup` | Configuration | maybe | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `Task` | Business record | No | Soft-delete purge only (90-day `data-lifecycle` sweep) | Indefinite while tenant active. The `retentionUntil` column exists but has NO writer anywhere in the product — no schema field, no DTO, no API field, no UI, no job — so it was removed from `RETENTION_MODELS` on 2026-08-12 rather than left as a sweep that could never match. |
| `TaskComment` | Business record | maybe | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `TaskKeySequence` | Operational | No | None today — cascade on parent/tenant delete only | No TTL today — candidate for time-boxed prune |
| `TaskLink` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `TaskWatcher` | Business record | No | None today — cascade on parent/tenant delete only | Indefinite while tenant active — review w/ compliance |
| `Tenant` | Configuration | No | Soft-delete (`deletedAt`) — **NOT** auto-purged | Lives with tenant; purged on tenant deletion |
| `TenantApiKey` | Security ephemeral | No | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `TenantCustomRole` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantEntraGroupMapping` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantIdentityProvider` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
| `TenantInvite` | Security ephemeral | maybe | `expiresAt` expiry (security) | DEFINED — expiry-driven |
| `TenantMembership` | Configuration | No | None today — cascade on parent/tenant delete only | Lives with tenant; purged on tenant deletion |
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
  they are excluded.
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
- **Mechanism:** FK cascade on tenant deletion. Note `Tenant` itself soft-deletes
  (`deletedAt`) and is **not** in the purge set — a deleted tenant's data is
  retained for compliance/restore until a deliberate hard purge.
- **Owner:** Engineering + Product (tenant-deletion grace period).
- **Customer override:** n/a (this *is* the customer's configuration).

## Cleanup-job inventory

| Job (schedule) | Function | What it does | Coverage |
|----------------|----------|--------------|----------|
| `retention-sweep` (daily 04:00 UTC) | `runEvidenceRetentionSweep` (`jobs/retention.ts`) | Archives `Evidence` where `retentionUntil < now`, not already archived, not soft-deleted. Idempotent. | Evidence only |
| `daily-evidence-expiry` (daily 06:00 UTC) | `runDailyEvidenceExpiryNotifications` (`jobs/dailyEvidenceExpiry.ts`); reminder generation also in `runEvidenceRetentionNotifications` (`jobs/retention-notifications.ts`) | N-day-before (30/7/1) reminder tasks for expiring evidence, gated by `Tenant.reminderDaysBefore` (default 14). | Evidence only |
| `data-lifecycle` (daily 03:00 UTC) | `purgeSoftDeletedOlderThan` (90-day grace, 12 `SOFT_DELETE_MODELS`) · `purgeExpiredEvidenceOlderThan` (hard-delete archived evidence > 365 days) · `runRetentionSweep` (cross-model `retentionUntil` sweep over the 2 `RETENTION_MODELS` that have a writer — `Asset`; `Evidence` is skipped by that loop and handled by the separate `retention-sweep` cron) — all in `jobs/data-lifecycle.ts` | The actual purge engine: hard-deletes aged soft-deletes + aged archived evidence; sweeps `retentionUntil` across the retention models. | 12 soft-delete + 2 retention models |

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

## Cross-references

- [`docs/encryption-data-protection.md`](encryption-data-protection.md) — the
  confidentiality-at-rest half of the data-protection story.
- [`docs/incident-response.md`](incident-response.md) — data-breach response
  references retained data scope.
- [`docs/billing.md`](billing.md) — the tenant-cancellation flow has retention
  implications (open question 3).
- `CLAUDE.md` → Architecture → **Data Retention**.
