/**
 * Structural index-coverage guardrail — the four-layer framework.
 *
 * ─── Why this file exists ───────────────────────────────────────────
 *
 * This REPLACES two ad-hoc tests (`list-query-indexes.test.ts` and
 * `task-list-query-indexes.test.ts`). Those tests pinned a hand-listed
 * set of composite indexes to specific migration files. They had two
 * structural weaknesses:
 *
 *   1. They were coupled to migration filenames. A schema cleanup that
 *      reshaped a migration could false-fail or false-pass.
 *   2. They covered ONLY the indexes a human remembered to list. A new
 *      tenant-scoped model, or a new foreign key, was invisible to
 *      them — the guardrail did not grow with the schema.
 *
 * This framework fixes both. It reads the LIVE schema (via the
 * structured parser in `tests/helpers/prisma-schema-models.ts`),
 * never a migration file, and it has two AUTOMATIC layers that derive
 * their coverage from the schema itself — every current AND future
 * tenant model / foreign key is checked with zero maintenance.
 *
 * ─── The four layers ────────────────────────────────────────────────
 *
 *   Layer A — tenant-scoped models must be tenant-indexed.   [AUTO]
 *     Every model with a `tenantId` scalar field must have `tenantId`
 *     as the FIRST element of some `@@index` / `@@unique` / `@@id`.
 *     Postgres uses the leftmost prefix of a composite index, so a
 *     tenantId-leading index makes every per-tenant query efficient.
 *
 *   Layer B — foreign-key scalar fields must be indexed.     [AUTO]
 *     Every scalar FK column (the `fields: [...]` side of a
 *     `@relation`) must LEAD some index/uniqueness construct, so the
 *     reverse lookup ("rows pointing at parent X") is not a seq scan.
 *     `tenantId` is skipped here — Layer A owns it.
 *
 *   Layer C — curated composite-index registry.            [CURATED]
 *     A reviewed list of multi-column indexes that back specific list
 *     filter + sort shapes. Each entry is asserted to exist EXACTLY
 *     (order-sensitive) in the live schema. This is the home for the
 *     indexes the two retired tests guarded.
 *
 *   Layer C-completeness — the forcing function.            [AUTO]
 *     Scans `src/app-layer` for `.findMany(` calls, maps the accessor
 *     to a model, and asserts every tenant-scoped model that is
 *     `findMany`'d somewhere is EITHER in the Layer C registry OR in
 *     an explicit "tenant-index is sufficient" map. A NEW list query
 *     on a NEW model that is in neither map fails the test — the
 *     author is forced to triage that model's indexes.
 *
 * ─── How the baselines ratchet ──────────────────────────────────────
 *
 * Layers A and B carry exempt maps (`TENANT_INDEX_EXEMPT`,
 * `FK_INDEX_EXEMPT`). Every entry has a written reason. The exempt
 * maps encode TODAY's reality — they are a baseline, not a target.
 * The direction of travel is toward zero: when a real index lands for
 * an `R_TODO_INDEX` entry, that entry is deleted in the same diff.
 * A NEW violation that is not in the exempt map fails the test.
 *
 * ─── Registry integrity ─────────────────────────────────────────────
 *
 * Every model name mentioned in any map MUST resolve to a real parsed
 * model. A typo or a model rename trips the integrity test loudly,
 * rather than silently making an exemption a no-op.
 */
import {
    parseSchemaModels,
    leadingIndexedFields,
    type SchemaModel,
} from '../helpers/prisma-schema-models';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_LAYER_DIR = path.join(REPO_ROOT, 'src/app-layer');

const MODELS = parseSchemaModels();
const MODEL_BY_NAME = new Map<string, SchemaModel>(
    MODELS.map((m) => [m.name, m]),
);

// ─────────────────────────────────────────────────────────────────────
// LAYER A — tenant-scoped models must be tenant-indexed.
// ─────────────────────────────────────────────────────────────────────
//
// Every model with a `tenantId` scalar field must have `tenantId` as a
// LEADING indexed column. `leadingIndexedFields()` (the shared parser
// helper) recognises ALL the ways that happens:
//   - `tenantId` is the first element of an `@@index` / `@@unique` /
//     `@@id`, OR
//   - `tenantId` itself carries a field-level `@id` / `@unique` (a
//     singleton config row that is 1:1 with its tenant — e.g.
//     BillingAccount, TenantSecuritySettings, TaskKeySequence).
// All of those create a tenantId-leading index Postgres uses for every
// per-tenant query.
//
// This map is the escape hatch for a GENUINE exception — a tenant
// model that deliberately has no tenant-leading index. It is empty:
// every tenant-scoped model today is correctly tenant-indexed. A new
// entry here is a real design decision and must carry a written reason
// (a missing index is a bug — add `@@index([tenantId, ...])` instead).

const TENANT_INDEX_EXEMPT: Record<string, string> = {};

// ─────────────────────────────────────────────────────────────────────
// LAYER B — foreign-key scalar fields must be adequately indexed.
// ─────────────────────────────────────────────────────────────────────
//
// `fkAdequatelyIndexed()` (see the helper above) treats a FK as
// covered if EITHER it LEADS an index/uniqueness construct, OR — on a
// tenant-scoped model — it is the second column of a
// `[tenantId, fk, ...]` composite. The schema's deliberate convention
// is the latter: every repository query carries `tenantId`, so a
// `[tenantId, fk]` composite serves the universal
// `WHERE tenantId = ? AND fk = ?` reverse lookup. Layer B does NOT
// flag those — flagging a correctly-indexed FK would be a guardrail
// that cries wolf.
//
// The baseline below records the FKs that are genuinely NOT indexed
// (neither leading, nor in a tenant composite). Every entry is honest,
// one of five reason classes:
//
//   R_ACTOR        — audit-trail actor FK (createdBy / approvedBy /
//                    deletedBy / …). Never list-queried "by actor";
//                    the rare admin lookup tolerates a seq scan.
//   R_LIBRARY_TABLE— low-cardinality template / framework library
//                    table; children fetched via the parent include.
//   R_ONE_TO_ONE   — 1:1 pointer; the FK is never reverse-queried.
//   R_REVERSE_RARE — reverse lookup exists but is low-frequency;
//                    a sequential scan is acceptable for now.
//   R_CHILD_VIA_PARENT — child rows always loaded via a parent
//                    include, never by a bare FK scan.
//
// Ratchet direction: toward zero. An exemption is deleted the moment
// the FK gets a real index — the "no stale entries" test enforces it.
// (The 8 genuine index gaps this layer first surfaced were closed by
// migration 20260521120000_perf_fk_reverse_lookup_indexes.)

const R_ACTOR =
    'audit-trail actor FK (who created / changed / approved the row) — never list-queried in the "by actor" direction; the rare admin lookup tolerates a sequential scan. Ratchet target: index only if an actor-scoped list view ships.';
const R_LIBRARY_TABLE =
    'low-cardinality template / framework library table — child rows are always fetched via the parent include, not a bare FK scan; a sequential scan is acceptable.';
const R_ONE_TO_ONE =
    '1:1 pointer column — the FK is never reverse-queried (there is no "rows for parent X" list view for this relation).';
const R_REVERSE_RARE =
    'reverse lookup exists but is a low-frequency admin / background query — a sequential scan is acceptable today. Ratchet target: add an index if the reverse direction becomes a hot UI path.';
const R_CHILD_VIA_PARENT =
    'child rows are always loaded through the parent record\'s include (the parent FK is already indexed), never by a bare scan on this FK.';

const FK_INDEX_EXEMPT: Record<string, string> = {
    'AuditLog.userId': R_ACTOR,
    'OrgAuditLog.actorUserId': R_ACTOR,
    'OrgAuditLog.targetUserId': R_ACTOR,
    'AuditCycle.createdByUserId': R_ACTOR,
    'AuditPack.frozenByUserId': R_ACTOR,
    'AuditPackShare.createdByUserId': R_ACTOR,
    'OrgInvite.invitedById': R_ACTOR,
    'TenantApiKey.createdById': R_ACTOR,
    'TenantDeviceToken.createdById': R_ACTOR,
    'TenantMembership.invitedByUserId': R_ACTOR,
    // Accountable staff member on a DSAR. The register is queried by status +
    // by the subject, never "every DSAR handled by admin X" — and the table is
    // small by nature (one row per rights request). No tenantId exists on this
    // model, so the [tenantId, fk] composite escape is unavailable regardless.
    'DataSubjectRequest.handledById': R_ACTOR,
    'AccessReview.createdByUserId': R_ACTOR,
    'AccessReview.closedByUserId': R_ACTOR,
    'AccessReview.deletedByUserId': R_ACTOR,
    'AccessReview.evidenceFileRecordId': R_ONE_TO_ONE,
    'AccessReviewDecision.decidedByUserId': R_ACTOR,
    'AccessReviewDecision.executedByUserId': R_ACTOR,
    'AccessReviewConnectedDecision.decidedByUserId': R_ACTOR,
    'AccessReviewConnectedDecision.connectedAccountId': R_REVERSE_RARE,
    'Account.userId': R_ACTOR,
    'AuthSession.userId': R_ACTOR,
    'TenantInvite.invitedById': R_ACTOR,
    'ReminderHistory.evidenceId': R_REVERSE_RARE,
    'IntegrationExecution.connectionId': R_REVERSE_RARE,
    'Task.createdByUserId': R_ACTOR,
    'Task.reviewerUserId': R_ACTOR,
    'TaskComment.createdByUserId': R_ACTOR,
    'TaskWatcher.userId': R_ACTOR,
    'Asset.ownerUserId': R_ACTOR,
    'RiskSuggestionSession.createdByUserId': R_ACTOR,
    'VendorDocExtraction.createdByUserId': R_ACTOR,
    'RiskSuggestionItem.assetId': R_ONE_TO_ONE,
    'Control.applicabilityDecidedByUserId': R_ACTOR,
    'Control.createdByUserId': R_ACTOR,
    'RiskControl.createdByUserId': R_ACTOR,
    'ControlAsset.createdByUserId': R_ACTOR,
    'AssetRiskLink.createdByUserId': R_ACTOR,
    'FindingAsset.createdByUserId': R_ACTOR,
    'AuditPackShareComment.resolvedByUserId': R_ACTOR,
    'ControlContributor.userId': R_ACTOR,
    'ControlEvidenceLink.createdByUserId': R_ACTOR,
    'EvidenceControlLink.createdByUserId': R_ACTOR,
    // Same shape as the control join above — an actor stamp, never a
    // query dimension (nothing lists links "created by user X").
    'EvidenceRiskLink.createdByUserId': R_ACTOR,
    'EvidenceAssetLink.createdByUserId': R_ACTOR,
    'ControlTemplateRequirementLink.requirementId': R_LIBRARY_TABLE,
    'Evidence.fileRecordId': R_ONE_TO_ONE,
    'FileRecord.uploadedByUserId': R_ACTOR,
    'EvidenceReview.reviewerId': R_ACTOR,
    'Policy.ownerUserId': R_ACTOR,
    'PolicyVersion.createdById': R_ACTOR,
    'PolicyApproval.approvedByUserId': R_ACTOR,
    'PolicyApproval.requestedByUserId': R_ACTOR,
    'PolicyAcknowledgement.userId': R_ACTOR,
    'FrameworkPack.frameworkId': R_LIBRARY_TABLE,
    'PackTemplateLink.templateId': R_LIBRARY_TABLE,
    'FrameworkMapping.toControlId': R_REVERSE_RARE,
    'FrameworkMapping.toRequirementId': R_REVERSE_RARE,
    'ControlTestPlan.createdByUserId': R_ACTOR,
    'ControlTestPlan.ownerUserId': R_ACTOR,
    'ControlTestRun.createdByUserId': R_ACTOR,
    'ControlTestRun.executedByUserId': R_ACTOR,
    'ControlTestEvidenceLink.createdByUserId': R_ACTOR,
    'ControlTestEvidenceLink.evidenceId': R_REVERSE_RARE,
    'ControlException.compensatingControlId': R_ONE_TO_ONE,
    'ControlException.createdByUserId': R_ACTOR,
    'ControlException.riskAcceptedByUserId': R_ACTOR,
    'ControlException.approvedByUserId': R_ACTOR,
    'ControlException.rejectedByUserId': R_ACTOR,
    'ControlException.deletedByUserId': R_ACTOR,
    'RiskTreatmentPlan.createdByUserId': R_ACTOR,
    'RiskTreatmentPlan.completedByUserId': R_ACTOR,
    'RiskTreatmentPlan.deletedByUserId': R_ACTOR,
    'TreatmentMilestone.completedByUserId': R_ACTOR,
    'ProcessMap.createdByUserId': R_ACTOR,
    'ProcessMap.deletedByUserId': R_ACTOR,
    'ProcessMapSnapshot.createdByUserId': R_ACTOR,
    'Vendor.ownerUserId': R_ACTOR,
    'VendorDocument.uploadedByUserId': R_ACTOR,
    'VendorAssessmentTemplate.createdByUserId': R_ACTOR,
    'VendorAssessment.decidedByUserId': R_ACTOR,
    'VendorAssessment.requestedByUserId': R_ACTOR,
    'VendorAssessment.sentByUserId': R_ACTOR,
    'VendorAssessment.reviewedByUserId': R_ACTOR,
    'VendorAssessment.closedByUserId': R_ACTOR,
    'VendorAssessment.templateId': R_LIBRARY_TABLE,
    'VendorAssessment.templateVersionId': R_ONE_TO_ONE,
    'VendorAssessmentAnswer.questionId': R_CHILD_VIA_PARENT,
    'VendorAssessmentAnswer.evidenceId': R_ONE_TO_ONE,
    'VendorEvidenceBundle.createdByUserId': R_ACTOR,
};

// ─────────────────────────────────────────────────────────────────────
// LAYER C — curated composite-index registry.
// ─────────────────────────────────────────────────────────────────────
//
// Multi-column indexes that back specific list-page filter + sort
// shapes. Every entry is asserted to exist EXACTLY (order-sensitive)
// in the live schema.
//
// This is the MERGE of the two retired tests
// (`list-query-indexes.test.ts` + `task-list-query-indexes.test.ts`).
// Their exact fields + justifications are preserved verbatim. Unlike
// the retired tests, this checks the LIVE schema only — it is
// decoupled from migration filenames.
//
// Adding an index here: it must reflect a real filter/sort path in a
// list usecase. Removing one: do it only alongside removing the
// corresponding filter, and explain the replacement in the PR.

interface CompositeIndex {
    /** PascalCase model name. */
    model: string;
    /** Field list in declaration order — matches the @@index([...]) line. */
    fields: string[];
    /** The filter / sort path that justifies this index. */
    justification: string;
}

const LIST_QUERY_INDEXES: readonly CompositeIndex[] = [
    // ── Risk (from list-query-indexes.test.ts) ──────────────────────
    {
        model: 'Risk',
        fields: ['tenantId', 'ownerUserId'],
        justification: 'RiskFilters.ownerUserId',
    },
    {
        model: 'Risk',
        fields: ['tenantId', 'score'],
        justification: 'RiskFilters.scoreMin/scoreMax range',
    },
    {
        model: 'Risk',
        fields: ['tenantId', 'inherentScore'],
        justification:
            "listRisks default sort: orderBy: { inherentScore: 'desc' }",
    },
    // ── Control (from list-query-indexes.test.ts) ───────────────────
    {
        model: 'Control',
        fields: ['tenantId', 'ownerUserId'],
        justification:
            'ControlListFilters.ownerUserId (existing [ownerUserId] is not tenant-prefixed)',
    },
    // ── Evidence (from list-query-indexes.test.ts) ──────────────────
    {
        model: 'Evidence',
        fields: ['tenantId', 'status'],
        justification: 'EvidenceListFilters.status',
    },
    {
        model: 'Evidence',
        fields: ['tenantId', 'type'],
        justification: 'EvidenceListFilters.type',
    },
    // EP-3 — the control-detail evidence pull now filters through the
    // EvidenceControlLink join (@@index([tenantId, controlId]) on that
    // model), so the old Evidence.[tenantId, controlId] index is gone.
    {
        model: 'EvidenceControlLink',
        fields: ['tenantId', 'controlId'],
        justification:
            'getControlEvidenceTab / getEvidenceMetrics pull evidence-for-control through the join (evidenceControlLinks.some.controlId + groupBy controlId).',
    },
    // ── Task (from task-list-query-indexes.test.ts) ─────────────────
    {
        model: 'Task',
        fields: ['tenantId', 'priority', 'createdAt'],
        justification:
            "TaskRepository.list() default sort: [{ priority: 'asc' }, { createdAt: 'desc' }]",
    },
    {
        model: 'Task',
        fields: ['tenantId', 'dueAt', 'status'],
        justification:
            "due='overdue' / due='next7d' filter: dueAt range AND status NOT IN (TERMINAL_*)",
    },
    // ── TaskLink (from task-list-query-indexes.test.ts) ─────────────
    {
        model: 'TaskLink',
        fields: ['tenantId', 'entityType', 'entityId'],
        justification:
            'TaskRepository.list() linkedEntityType+linkedEntityId reverse-lookup',
    },
    // ── NIS2 gap-assessment (Nis2GapAssessmentRepository) ───────────
    {
        model: 'Nis2SelfAssessment',
        fields: ['tenantId', 'updatedAt'],
        justification:
            "Nis2GapAssessmentRepository.listAssessments default sort: orderBy { updatedAt: 'desc' }",
    },
    {
        model: 'Nis2SelfAssessmentAnswer',
        fields: ['tenantId', 'assessmentId'],
        justification:
            'Nis2GapAssessmentRepository.listAnswers filters by [tenantId, assessmentId]',
    },
    // ── AI-governance self-assessment (ai-gov-self-assessment usecase) ──
    {
        model: 'AiGovSelfAssessment',
        fields: ['tenantId', 'updatedAt'],
        justification:
            "ai-gov-self-assessment.activeAssessment: findFirst by [tenantId, status] orderBy { updatedAt: 'desc' }",
    },
    {
        model: 'AiGovSelfAssessmentAnswer',
        fields: ['tenantId', 'assessmentId'],
        justification:
            'ai-gov-self-assessment getState/raiseFindings filter answers by [tenantId, assessmentId]',
    },
    // ── Agent risk assessment (AgentRiskAssessmentRepository) ───────
    {
        model: 'AgentRiskAssessment',
        fields: ['tenantId', 'agentId'],
        justification:
            'AgentRiskAssessmentRepository.findOpen/findLatestCompleted/listForAgent all filter by [tenantId, agentId]; @@index([tenantId, updatedAt]) covers the findOpen ordering and @@index([tenantId, status]) the status predicate',
    },
    {
        model: 'AgentRiskAssessmentAnswer',
        fields: ['tenantId', 'assessmentId'],
        justification:
            'AgentRiskAssessmentRepository.listAnswers filters by [tenantId, assessmentId]',
    },
];

// ─────────────────────────────────────────────────────────────────────
// LAYER C-completeness — "tenant-index is sufficient" map.
// ─────────────────────────────────────────────────────────────────────
//
// Every tenant-scoped model that is `findMany`'d somewhere in
// `src/app-layer` MUST appear EITHER in `LIST_QUERY_INDEXES` above
// OR in this map. A new `findMany` on a model in neither map fails
// the Layer C-completeness test — the author is forced to triage
// whether that model's list query needs a composite index.
//
// An entry here is the explicit assertion "this model's list query
// is fully covered by Layers A + B — its `findMany`s filter only by
// `tenantId` plus a leading-indexed FK / status column, so no
// curated composite index is needed."

const LIST_MODELS_TENANT_INDEX_SUFFICIENT: Record<string, string> = {
    AuditChecklistItem: 'updateAudit prefetches the touched checklist rows by (id IN […], tenantId) for FAIL-transition detection — a PK IN lookup + RLS-bound tenantId; @@index([tenantId, auditId]) is more than sufficient; bounded by the request payload size.',
    AuditPackItem: 'getPackByShareToken reads a pack\'s items by (tenantId, auditPackId) for the public share-page projection — covered by @@index([tenantId, auditPackId]); bounded take ≤2000.',
    AuditPackShareComment: 'listShareComments filters by (tenantId, auditPackId), orders by createdAt desc — covered by @@index([tenantId, auditPackId]); bounded take ≤500.',
    AuditPackShare: 'listPackShares filters by (tenantId, auditPackId), orders by createdAt desc — covered by @@index([tenantId, auditPackId]); bounded take ≤200.',
    AuditorAccount: 'listAuditors filters by tenantId, orders by createdAt desc — covered by @@unique([tenantId, emailHash]) tenantId-leading composite; bounded take ≤500.',
    IdentityWriteJournal: 'listUnsettledWrites filters (tenantId, outcome PENDING, attemptedAt < cutoff) and orders by attemptedAt asc \u2014 covered by @@index([tenantId, outcome]) with @@index([tenantId, attemptedAt]) for the ordering; findRestorableState reads (tenantId, provider, externalUserId) via its own composite; bounded take \u2264 200.',
    IdentityAccountLink: 'reconcileIdentityAccountLinks reads existing links by (tenantId, connectedAccountId IN [...]) to tell a re-verify from a new link — served by the field-level @unique on connectedAccountId, with @@index([tenantId, employeeId]) covering the leaver-path lookup by worker; bounded take \u2264 10000 (MAX_EMPLOYEES).',
    TenantCalendarConsent: 'getConsentStates filters by tenantId alone and is bounded by the provider count (1) — covered by the tenantId-leading @@unique([tenantId, provider]).',
    UserCalendarConnection: 'listCalendarConnections filters by (tenantId, userId) and orders by provider — covered by the tenantId-leading @@unique([tenantId, userId, provider]); bounded take = the provider count (2). The push fan-out\'s (tenantId, provider, revokedAt) scan has its own composite.',
    Employee: 'listEmployees filters by tenantId (+status) — covered by @@index([tenantId, status]); bounded take ≤500.',
    EvidenceReview: 'getLatestSubmitters (evidence review-gate SoD) filters by (tenantId, evidenceId IN […]) + action equality, orders by createdAt desc — covered by @@index([tenantId, evidenceId]); action is a small in-page equality filter; bounded by the evidenceId set (bulk cap ≤100).',
    EvidenceControlLink: 'listControlLinks filters by (tenantId, evidenceId) — covered by @@index([tenantId, evidenceId]); bounded by the single evidence row it lists links for.',
    EvidenceRiskLink: 'Risk evidence tab filters by (tenantId, riskId) — covered by @@index([tenantId, riskId]); bounded by take: 500.',
    EvidenceAssetLink: 'Asset evidence tab filters by (tenantId, assetId) — covered by @@index([tenantId, assetId]); bounded by take: 500.',
    EvidenceTag: 'Tag filter + option list read (tenantId, tag) — covered by @@index([tenantId, tag]); the distinct read is bounded by take: 500.',
    ConnectedIdentityAccount: 'personnel provider reads all accounts for a tenant (offboarded-access join) — covered by @@index([tenantId, status]); bounded take ≤10000.',
    Device: 'listDevices + device provider read by tenantId (+platform) — covered by @@index([tenantId, platform]); bounded take ≤10000.',
    TenantDeviceToken: 'listDeviceTokens by tenantId — covered by @@index([tenantId]) / @@index([tenantId, revokedAt]); bounded take ≤200.',
    TrainingAssignment: 'listTrainingAssignments + training provider by tenantId (+status) — covered by @@index([tenantId, status]) / @@index([tenantId, employeeId]); bounded take ≤10000.',
    BackgroundCheck: 'listBackgroundChecks + training provider by tenantId (+status) — covered by @@index([tenantId, status]) / @@index([tenantId, employeeId]); bounded take ≤10000.',
    AccessReviewConnectedDecision: 'listConnectedDecisions + close by (tenantId, accessReviewId) — covered by @@index([tenantId, accessReviewId]); bounded take ≤5000.',
    TrustCenterDocument: 'listTrustCenterDocuments by tenantId — covered by @@index([tenantId]) / @@index([tenantId, trustCenterId]); bounded take ≤200.',
    TrustCenterAccessRequest: 'listTrustCenterAccessRequests by tenantId (+status) — covered by @@index([tenantId, status]); bounded take ≤500.',
    InboundQuestionnaire: 'listQuestionnaires by tenantId (+status) — covered by @@index([tenantId, status]); bounded take ≤200.',
    InboundQuestionnaireItem: 'getQuestionnaireItems + autofill by (tenantId, questionnaireId/status) — covered by @@index([tenantId, questionnaireId]) / @@index([tenantId, status]); bounded.',
    QuestionnaireAnswerLibrary: 'library retrieval by tenantId — covered by @@index([tenantId]); bounded take ≤1000.',
    // EU AI Act registry — listAiSystems filters by tenantId (+ optional
    // riskTier / status), orders by riskTier then createdAt; covered by
    // @@index([tenantId, riskTier]) + @@index([tenantId, status]). Bounded
    // take ≤200.
    AiSystem:
        'listAiSystems filters by tenantId (+riskTier/status) — covered by @@index([tenantId, riskTier]) + @@index([tenantId, status]); bounded take ≤200.',
    // Agent register — listRegisteredAgents filters by tenantId (+ optional
    // status), soft-delete rail on deletedAt, orders by createdAt desc.
    RegisteredAgent:
        'listRegisteredAgents filters by (tenantId, deletedAt IS NULL, +status) and orders by createdAt desc — covered by @@index([tenantId, status]) + @@index([tenantId, deletedAt]) + @@index([tenantId, createdAt]); bounded take ≤200.',
    // Tool exposure — read per (tenantId, agentId) on every MCP invocation and
    // by the admin surface; there is no other shape.
    RegisteredAgentTool:
        'listGrantedToolNames and listAgentTools both filter by (tenantId, agentId) and nothing else — covered by @@index([tenantId, agentId]) with the tenantId-leading @@unique([tenantId, agentId, toolName]) behind it; bounded take ≤200.',
    // MCP agent proposals — listAgentProposals filters by tenantId (+ optional
    // status), orders by createdAt desc; fully covered by
    // @@index([tenantId, status, createdAt]). Bounded take ≤100.
    AgentProposal:
        'listAgentProposals filters by tenantId (+status), orders by createdAt — covered by @@index([tenantId, status, createdAt]); bounded take ≤100.',
    // Agent-action receipts — listReceipts filters by tenantId (+ optional
    // verified / toolName), orders by occurredAt desc; covered by
    // @@index([tenantId, occurredAt]) (tenantId is RLS-bound; verified/toolName
    // are small in-page filters). Bounded take ≤200 (default 100).
    AgentActionReceipt:
        'listReceipts filters by tenantId (+verified/toolName), orders by occurredAt — covered by @@index([tenantId, occurredAt]); bounded take ≤200.',
    WorkflowRun:
        'listWorkflowRuns filters by tenantId (+status), orders by startedAt — covered by @@index([tenantId, status, startedAt]); bounded take ≤50.',
    TenantFrameworkDelta:
        'listTenantFrameworkDeltas filters by tenantId (+status), orders by createdAt — covered by @@index([tenantId, status, createdAt]); bounded take ≤50.',
    Nis2GapAssignment:
        'listAssignments filters by tenantId + assessmentId — covered by @@index([tenantId, assessmentId]); at most 5 rows per run (one per respondent role).',
    // Vuln integration — listVulnerabilities filters by tenantId (+ optional
    // status / assetId), ordered by the related Cve.cvssScore. Covered by
    // @@index([tenantId, status]) + @@index([tenantId, assetId]) (status /
    // assetId are the leading filters under the RLS-bound tenantId); the
    // cross-table cvssScore sort is a small in-page sort. Bounded take ≤500.
    AssetVulnerability:
        'listVulnerabilities filters by tenantId (+status/assetId) — covered by @@index([tenantId, status]) / @@index([tenantId, assetId]); cvssScore sort is cross-table, bounded take ≤500.',
    // Scanner ingestion — listScannerRuns filters by tenantId (+optional
    // source), orders by ranAt; covered by @@index([tenantId, source, ranAt])
    // (+ [tenantId, scanType, ranAt]); the unfiltered case is a small in-page
    // sort on a per-tenant-bounded table. Bounded take ≤200.
    ScannerRun:
        'listScannerRuns filters by tenantId (+source), orders by ranAt — covered by @@index([tenantId, source, ranAt]) / @@index([tenantId, scanType, ranAt]); bounded take ≤200.',
    // Scanner ingestion — listScannerFindings filters by tenantId (+status/
    // severity), and the reconcile read filters by (tenantId, scannerRunId,
    // status); covered by @@index([tenantId, status, severity]) +
    // @@index([tenantId, scannerRunId, status]). Bounded take ≤500.
    ScannerFinding:
        'listScannerFindings filters by tenantId (+status/severity) — covered by @@index([tenantId, status, severity]) + @@index([tenantId, scannerRunId, status]); bounded take ≤500.',
    // BIA register — listBias filters by tenantId (+optional criticality/
    // processNodeId), ordered by criticality/MTPD for the recovery-priority
    // view; covered by @@index([tenantId, criticality]) +
    // @@index([tenantId, processNodeId]). Bounded take ≤500.
    BusinessImpactAnalysis:
        'listBias filters by tenantId (+criticality/processNodeId) — covered by @@index([tenantId, criticality]) + @@index([tenantId, processNodeId]); recovery-priority sort is in-page on a bounded per-tenant set (take ≤500).',
    // Vendor-doc extraction — listVendorDocExtractions filters by tenantId
    // (+vendorId/status), ordered by createdAt; covered by
    // @@index([tenantId, vendorId]) + @@index([tenantId, status]). Bounded take.
    VendorDocExtraction:
        'listVendorDocExtractions filters by tenantId (+vendorId/status) — covered by @@index([tenantId, vendorId]) + @@index([tenantId, status]); bounded take.',
    // Vendor answer proposals — listProposals filters by (tenantId, extractionId)
    // (+status); covered by @@index([tenantId, extractionId]) + @@index([tenantId, status]).
    VendorAnswerProposal:
        'listProposals filters by (tenantId, extractionId) (+status) — covered by @@index([tenantId, extractionId]) + @@index([tenantId, status]); bounded by one extraction.',
    // Vendor monitor — the sweep + getVendorMetrics filter by (tenantId, enabled)
    // / (tenantId, vendorId); covered by @@unique([tenantId, vendorId]) +
    // @@index([tenantId, enabled]). Bounded take.
    VendorMonitor:
        'vendor-monitoring sweep filters by (tenantId, enabled); getVendorPosture by (tenantId, vendorId) — covered by @@unique([tenantId, vendorId]) + @@index([tenantId, enabled]); bounded take.',
    // Vendor posture events — the timeline reads by (tenantId, vendorId) ordered
    // by occurredAt; getVendorMetrics filters by (tenantId, eventType, occurredAt).
    // Covered by @@index([tenantId, vendorId, occurredAt]) + @@index([tenantId, eventType]).
    VendorPostureEvent:
        'getVendorPosture filters by (tenantId, vendorId) ordered occurredAt; metrics by (tenantId, eventType, occurredAt) — covered by @@index([tenantId, vendorId, occurredAt]) + @@index([tenantId, eventType]); bounded take.',
    // Policy-template mapping — linkPolicyControls reads existing links by
    // policyId (+ controlId in-filter) to dedupe before createMany; covered
    // by @@index([tenantId, policyId]) (policyId is the leading filter under
    // the RLS-bound tenantId) and @@unique([policyId, controlId]). Bounded
    // by the supplied controlIds (max 200), never a full per-tenant list.
    PolicyControlLink:
        'linkPolicyControls reads existing links by policyId (+ controlId in-filter) to dedupe — covered by @@index([tenantId, policyId]) + @@unique([policyId, controlId]); bounded by controlIds input.',
    // Policy review workflow — evidence-to-retain checklist listed by
    // tenantId + policyId, ordered by sortOrder; covered by
    // @@index([tenantId, policyId]). Bounded take:200.
    PolicyEvidenceItem:
        'listPolicyEvidenceItems filters by tenantId + policyId, orders by sortOrder — covered by @@index([tenantId, policyId]); bounded take:200.',
    // Business-KPI — dau-mau-aggregator builds a tenantId→plan map with a
    // full BillingAccount scan (cross-tenant, no filter). One row per
    // paying tenant (tenantId @unique) → table bounded by tenant count;
    // a 5-min full scan of a small table is cheap, not a per-tenant list.
    BillingAccount:
        'Business-KPI dau-mau-aggregator scans all BillingAccount rows to build the tenantId→plan map; tenantId @unique means one row per paying tenant (bounded by tenant count) — cheap full scan, no per-tenant list query.',
    // Business-KPI — onboarding-abandonment-sweep findMany filters by
    // updatedAt window + completedAt/startedAt (cross-tenant, no tenantId
    // filter). TenantOnboarding has tenantId @unique → exactly one row per
    // tenant, so the table is bounded by tenant count; a daily full scan
    // over a narrow window is cheap and is not a per-tenant list query.
    TenantOnboarding:
        'Business-KPI onboarding-abandonment-sweep scans by updatedAt window across all tenants; tenantId @unique means one row per tenant (table bounded by tenant count) — full scan is cheap, no per-tenant list query.',
    // EI-3 — SCIM Groups listed/looked-up by tenantId (+ unique externalId);
    // covered by @@index([tenantId]) + @@unique([tenantId, externalId]); bounded take:200.
    ScimGroup:
        'EI-3 scimListGroups filters by tenantId (take:200); reconcile looks up by [tenantId, memberIds has] — @@index([tenantId]) + @@unique([tenantId, externalId]) suffice.',
    // RQ-2 — breach history lists by tenantId ordered by detectedAt;
    // covered by @@index([tenantId, detectedAt]).
    RiskAppetiteBreach:
        'RQ-2 listBreaches filters by tenantId, orders by detectedAt DESC — covered by @@index([tenantId, detectedAt]); bounded take:200.',
    // RQ-2 — one config row per tenant, fetched by tenantId (unique).
    RiskAppetiteConfig:
        'RQ-2 single per-tenant config fetched by tenantId — covered by the @@unique([tenantId]) / @@index([tenantId]); never a multi-row list.',
    // RQ-4 — scenarios listed by tenantId (+ optional status) ordered by createdAt.
    RiskScenario:
        'RQ-4 listScenarios filters by tenantId (+ optional status), orders by createdAt DESC — covered by @@index([tenantId, createdAt]) + @@index([tenantId, status]); bounded take:200.',
    // RQ-5 — hierarchy nodes fetched by tenantId+type for tree/treemap.
    RiskHierarchyNode:
        'RQ-5 getTree/loadTree filters by tenantId + type — covered by @@index([tenantId, type]); bounded take:5000.',
    // RQ-5 — links fetched by tenantId+nodeId (roll-up) and tenantId+riskId (risk form).
    RiskHierarchyLink:
        'RQ-5 loadTree filters by tenantId + nodeId, getRiskNodes by tenantId + riskId — covered by @@index([tenantId, nodeId]) + @@index([tenantId, riskId]); bounded take.',
    // RQ-6 — KRIs listed by tenantId (+ optional riskId/isActive) ordered by createdAt.
    KeyRiskIndicator:
        'RQ-6 listKris filters by tenantId (+ optional riskId/isActive) — covered by @@index([tenantId]) + @@index([tenantId, riskId]) + @@index([tenantId, isActive]); bounded take:500.',
    // RQ-6 — readings fetched by kriId+recordedAt (history/sparkline).
    KriReading:
        'RQ-6 getReadings/listKris filter by tenantId + kriId, order by recordedAt — covered by @@index([kriId, recordedAt]) + @@index([tenantId, kriId]); bounded take.',
    // RQ3-6 — loss events listed by tenantId (+ optional riskId) ordered by occurredAt;
    // aggregate scans by tenantId. Covered by @@index([tenantId, occurredAt]) +
    // @@index([tenantId, riskId, occurredAt]); cursor-paginated take:500.
    LossEvent:
        'RQ3-6 listLossEvents filters by tenantId (+ optional riskId), orders by occurredAt DESC; getLossEventAggregate scans by tenantId ordered by occurredAt — covered by @@index([tenantId, occurredAt]) + @@index([tenantId, riskId, occurredAt]); bounded take:500.',
    // RQ-8 — all correlation pairs for a tenant (matrix build / suggestions).
    RiskCorrelation:
        'RQ-8 getCorrelationMatrix/suggestCorrelations fetch all pairs by tenantId — covered by @@index([tenantId]); bounded take.',
    // RQ-9 — per-risk history + velocity fetched by tenantId+riskId+snapshotAt.
    RiskSnapshot:
        'RQ-9 getRiskHistory/computeVelocity filter by tenantId + riskId, order by snapshotAt — covered by @@index([tenantId, riskId, snapshotAt]); bounded take.',
    // RQ2-1 — provenance trail fetched by tenantId+riskId ordered by createdAt.
    RiskScoreEvent:
        'RQ2-1 listScoreEvents filters by tenantId + riskId, orders by createdAt — covered by @@index([tenantId, riskId, createdAt]); take clamped to 200.',
    // RQ-9 — portfolio trend fetched by tenantId ordered by snapshotAt.
    PortfolioSnapshot:
        'RQ-9 getPortfolioTrend filters by tenantId, orders by snapshotAt — covered by @@index([tenantId, snapshotAt]); bounded take.',
    // RQ-10 — report templates listed by tenantId.
    ReportTemplate:
        'RQ-10 listTemplates filters by tenantId — covered by @@index([tenantId]); bounded take:200.',
    // RQ-10 — report runs listed by tenantId ordered by createdAt.
    ReportRun:
        'RQ-10 listReports filters by tenantId, orders by createdAt DESC — covered by @@index([tenantId, createdAt]); bounded take.',
    // RQ-10 — schedules listed by tenantId + due-scan by (nextRunAt, isActive).
    ReportSchedule:
        'RQ-10 listSchedules filters by tenantId; the delivery cron scans (nextRunAt, isActive) — covered by @@index([tenantId]) + @@index([nextRunAt, isActive]); bounded take.',
    // SP-3 — delta sync lists mappings by [tenantId, provider, connectionId];
    // covered by @@index([tenantId, provider]) + @@index([connectionId]).
    IntegrationSyncMapping:
        'SP-3 delta sync filters by tenantId + provider + connectionId — covered by @@index([tenantId, provider]) + @@index([connectionId]); no curated composite index needed today.',
    // VR-3 — the canvas-rule sync findMany's a single map's nodes/edges,
    // bounded by processMapId. The `@@index([tenantId, processMapId])`
    // covers the (tenantId, processMapId) prefix; the nodeType/edgeKind
    // refinement is an in-memory-small filter over one map's bounded graph.
    ProcessNode:
        'filtered by tenantId + processMapId (one map\'s bounded node set) — covered by @@index([tenantId, processMapId]); nodeType is a small refinement.',
    ProcessEdge:
        'filtered by tenantId + processMapId (one map\'s bounded edge set) — covered by @@index([tenantId, processMapId]); edgeKind is a small refinement.',
    AccessReview:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AccessReviewDecision:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    Asset:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AssetRiskLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    Audit:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AuditCycle:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AuditLog:
        'append-only audit trail — read tenant-scoped and time-ordered via [tenantId, createdAt]; Layers A/B cover it; no curated composite index needed.',
    AuditPack:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AutomationExecution:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    AutomationRule:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    ClauseProgress:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ComplianceSnapshot:
        'time-series snapshot rows — read tenant-scoped and time-ordered; Layers A/B cover it; no curated composite index needed today.',
    ControlAsset:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlContributor:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlEvidenceLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlException:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    ControlRequirementLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlTestEvidenceLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    ControlTestPlan:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    ControlTestRun:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    FileRecord:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    Finding:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    FrameworkRequirementOrder:
        'ordering side-table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover it; no curated composite index needed.',
    IntegrationConnection:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    IntegrationExecution:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    IntegrationWebhookEvent:
        'append-only webhook log — read tenant-scoped; Layers A/B cover it; no curated composite index needed today.',
    Notification:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    NotificationOutbox:
        'outbox queue — drained tenant-scoped by status; Layers A/B cover it; no curated composite index needed today.',
    Policy:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    PolicyApproval:
        'listPending filters by tenantId + status only (the [tenantId, policyId] / [tenantId, policyVersionId] composites are FK reverse-lookup indexes) — Layers A/B cover its query shapes; no curated composite index needed today.',
    PolicyVersion:
        'fetched per policy via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    ProcessEdgeControl:
        'Epic P2-PR-C reverse-lookup: filtered by (tenantId, controlId) which is the model\'s leading `@@index([tenantId, controlId])`. Result set bounded by the number of edges referencing one control (typically <10) — Layer A already covers it.',
    ProcessMap:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    ProcessMapSnapshot:
        'Epic P5-PR-A version-history list: filtered by (tenantId, processMapId) which is covered by the model\'s leading `@@index([tenantId, processMapId, version])`. Capped at 200 rows in the repo (`take: 200`); no curated composite index needed.',
    ReadinessSnapshot:
        'time-series readiness chart query (Audit S5, 2026-05-24); the model carries [tenantId, frameworkKey, computedAt] composite index for the trend lookup, covered structurally by its own index — no separate LIST_QUERY_INDEXES entry needed.',
    RiskControl:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    RiskTreatmentPlan:
        'fetched per risk via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    TaskComment:
        'fetched per task via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    TaskWatcher:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    TenantApiKey:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantCustomRole:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantEntraGroupMapping:
        'listed by tenantId only (ordered by priority/createdAt, take 500); @@index([tenantId]) + @@unique([tenantId, aadGroupId]) — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantIdentityProvider:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantInvite:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TenantMembership:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    TreatmentMilestone:
        'fetched per treatment plan via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    UserIdentityLink:
        'fetched per tenant / user via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    Vendor:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessment:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessmentAnswer:
        'fetched per assessment via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessmentTemplate:
        'filtered only by tenantId plus leading-indexed FK / status columns — Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorAssessmentTemplateQuestion:
        'fetched per template via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorDocument:
        'fetched per vendor via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorEvidenceBundle:
        'fetched per vendor via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    VendorLink:
        'join table — fetched by tenantId plus a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed.',
    VendorRelationship:
        'fetched per vendor via a leading-indexed FK; Layers A/B cover its query shapes; no curated composite index needed today.',
    // NIS2 incident response — listIncidents filters by tenantId (+ optional
    // phase / severity), orders by detectedAt DESC; covered by
    // @@index([tenantId, phase]) + @@index([tenantId, severity, detectedAt]);
    // bounded take:200.
    Incident:
        'listIncidents filters by tenantId (+ optional phase / severity), orders by detectedAt DESC — covered by @@index([tenantId, phase]) + @@index([tenantId, severity, detectedAt]); bounded take:200.',
    // Notification deadlines fetched per incident (detail page) and scanned
    // by [tenantId, status, dueAt] (the deadline-clock job); covered by
    // @@index([tenantId, incidentId]) + @@index([tenantId, status, dueAt]).
    IncidentNotification:
        'listed per incident (detail) and scanned by status+dueAt (deadline-clock job) — covered by @@index([tenantId, incidentId]) + @@index([tenantId, status, dueAt]); bounded take.',
    // Timeline fetched per incident ordered by `at`; covered by
    // @@index([tenantId, incidentId, at]); bounded take:500.
    IncidentTimelineEntry:
        'listIncidentTimeline filters by tenantId + incidentId, orders by at DESC — covered by @@index([tenantId, incidentId, at]); bounded take:500.',
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** All `.ts` files under `src/app-layer`, recursively. */
function listAppLayerFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                out.push(full);
            }
        }
    };
    walk(APP_LAYER_DIR);
    return out;
}

/** True if a `blockIndexes` entry on `model` exactly equals `fields`. */
function hasExactBlockIndex(
    model: SchemaModel,
    fields: readonly string[],
): boolean {
    return model.blockIndexes.some(
        (idx) =>
            idx.length === fields.length &&
            idx.every((f, i) => f === fields[i]),
    );
}

/**
 * Is a foreign-key field adequately indexed for this codebase's query
 * patterns?
 *
 *   - `true` if the FK LEADS some index/uniqueness construct (a bare
 *     `WHERE fk = ?` reverse lookup is then an index scan), OR
 *   - on a tenant-scoped model, `true` if a `[tenantId, fk, ...]`
 *     composite exists: every repository query carries `tenantId`, so
 *     the universal `WHERE tenantId = ? AND fk = ?` lookup is served by
 *     that composite's leftmost prefix.
 *
 * The second clause is essential: the schema's deliberate convention
 * is to index FK columns via tenant-scoped composites, not bare
 * single-column indexes. Without this clause Layer B would flag a
 * correctly-indexed FK as a violation — a guardrail that cries wolf.
 */
function fkAdequatelyIndexed(model: SchemaModel, fk: string): boolean {
    if (leadingIndexedFields(model).has(fk)) return true;
    if (model.scalarFieldNames.includes('tenantId')) {
        const inTenantComposite = (groups: string[][]): boolean =>
            groups.some((g) => g[0] === 'tenantId' && g[1] === fk);
        if (
            inTenantComposite(model.blockIndexes) ||
            inTenantComposite(model.blockUniques)
        ) {
            return true;
        }
    }
    return false;
}

/** Map a Prisma accessor (camelCase) to its PascalCase model name. */
function accessorToModelName(accessor: string): string {
    return accessor.charAt(0).toUpperCase() + accessor.slice(1);
}

/**
 * Scan `src/app-layer` for `.findMany(` calls and return the set of
 * tenant-scoped model names that are list-queried somewhere.
 *
 * `db.task.findMany(...)` → accessor `task` → model `Task`. Accessors
 * that do not resolve to a parsed model (dynamic delegates like
 * `delegate.findMany` / `model.findMany` / `dbAny.findMany`) are
 * dropped — they are generic helpers, not a concrete model.
 */
function scanListQueryModels(): Set<string> {
    const found = new Set<string>();
    const re = /([A-Za-z_][A-Za-z0-9_]*)\.findMany\s*\(/g;
    for (const file of listAppLayerFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const modelName = accessorToModelName(m[1]);
            const model = MODEL_BY_NAME.get(modelName);
            if (!model) continue;
            if (!model.scalarFieldNames.includes('tenantId')) continue;
            found.add(modelName);
        }
    }
    return found;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('schema-index-coverage — parser sanity', () => {
    // Pins the structured parser (`prisma-schema-models.ts`) against
    // known schema facts. If the parser silently breaks, every layer
    // below would pass vacuously — this catches that first.
    it('parses a meaningful number of models', () => {
        expect(MODELS.length).toBeGreaterThan(80);
    });

    it('finds the Task and TaskLink models', () => {
        expect(MODEL_BY_NAME.has('Task')).toBe(true);
        expect(MODEL_BY_NAME.has('TaskLink')).toBe(true);
    });

    it('TaskLink carries @@index([tenantId, entityType, entityId])', () => {
        const taskLink = MODEL_BY_NAME.get('TaskLink');
        expect(taskLink).toBeDefined();
        expect(taskLink?.blockIndexes).toContainEqual([
            'tenantId',
            'entityType',
            'entityId',
        ]);
    });

    it('parses field-level @id and relation FK groups', () => {
        const risk = MODEL_BY_NAME.get('Risk');
        expect(risk?.fieldIdName).toBe('id');
        // Risk has a `tenant Tenant @relation(fields: [tenantId], ...)`.
        expect(risk?.relationFkFieldGroups).toContainEqual(['tenantId']);
    });
});

describe('schema-index-coverage — Layer A: tenant-scoped models are tenant-indexed', () => {
    const tenantModels = MODELS.filter((m) =>
        m.scalarFieldNames.includes('tenantId'),
    );

    it('finds a meaningful number of tenant-scoped models (parser sanity)', () => {
        // If the parser broke, this collapses to ~0 and every other
        // assertion below would vacuously pass.
        expect(tenantModels.length).toBeGreaterThan(40);
    });

    for (const model of tenantModels) {
        const exemptReason = TENANT_INDEX_EXEMPT[model.name];
        const title = exemptReason
            ? `${model.name} — tenantId-index exempt (${exemptReason.slice(0, 60)}…)`
            : `${model.name} — tenantId leads an index/unique/id`;

        it(title, () => {
            if (exemptReason) {
                // Exempt: just record that the entry is intentional.
                expect(exemptReason.length).toBeGreaterThan(20);
                return;
            }
            // `leadingIndexedFields` recognises a tenantId-leading
            // `@@index`/`@@unique`/`@@id` AND a field-level `@id` /
            // `@unique` declared on `tenantId` itself.
            const ok = leadingIndexedFields(model).has('tenantId');
            if (!ok) {
                throw new Error(
                    `Model ${model.name} has a tenantId field but no ` +
                        `@@index / @@unique / @@id with tenantId as the FIRST ` +
                        `element. Every per-tenant query on this model is a ` +
                        `sequential scan.\n\n` +
                        `Fix: add  @@index([tenantId])  (or a composite that ` +
                        `LEADS with tenantId) to model ${model.name}.\n` +
                        `If this is a genuine exception, add it to ` +
                        `TENANT_INDEX_EXEMPT with a written reason.`,
                );
            }
            expect(ok).toBe(true);
        });
    }
});

describe('schema-index-coverage — Layer B: foreign-key fields are leading-indexed', () => {
    interface FkViolation {
        key: string;
        model: string;
        field: string;
        group: string[];
    }

    const violations: FkViolation[] = [];
    for (const model of MODELS) {
        for (const group of model.relationFkFieldGroups) {
            const first = group[0];
            if (first === 'tenantId') continue; // Layer A owns tenantId.
            if (fkAdequatelyIndexed(model, first)) continue;
            violations.push({
                key: `${model.name}.${first}`,
                model: model.name,
                field: first,
                group,
            });
        }
    }

    it('finds foreign-key relations to check (parser sanity)', () => {
        // FK groups should number well into the hundreds across the
        // schema. A near-zero count means the relation parser broke.
        const totalFkGroups = MODELS.reduce(
            (n, m) => n + m.relationFkFieldGroups.length,
            0,
        );
        expect(totalFkGroups).toBeGreaterThan(100);
    });

    it('every foreign-key field leads an index OR is in FK_INDEX_EXEMPT', () => {
        const novel = violations.filter((v) => !(v.key in FK_INDEX_EXEMPT));
        if (novel.length > 0) {
            const lines = [
                `Found ${novel.length} foreign-key field(s) that do not LEAD ` +
                    `any index/uniqueness construct and are not in ` +
                    `FK_INDEX_EXEMPT:`,
                '',
                ...novel.map(
                    (v) =>
                        `  ${v.key}  (relation fields: [${v.group.join(', ')}])`,
                ),
                '',
                'Each such FK makes the reverse lookup ("rows pointing at ',
                'parent X") a sequential scan.',
                '',
                'Fix one of:',
                `  1. Add  @@index([${'<fkField>'}])  — or a composite that`,
                '     LEADS with the FK field — to the model.',
                '  2. If the reverse lookup is genuinely never a hot path,',
                '     add an FK_INDEX_EXEMPT entry keyed "Model.field" with',
                '     a concise, honest reason (see the reason constants).',
            ];
            throw new Error(lines.join('\n'));
        }
        expect(novel.length).toBe(0);
    });

    it('FK_INDEX_EXEMPT has no stale entries (every exemption still applies)', () => {
        // If an FK gets a real index, its violation disappears — its
        // exempt entry then quietly weakens nothing, but it IS dead
        // weight that hides the win. Flag it so the entry is removed.
        const liveKeys = new Set(violations.map((v) => v.key));
        const stale = Object.keys(FK_INDEX_EXEMPT).filter(
            (k) => !liveKeys.has(k),
        );
        if (stale.length > 0) {
            throw new Error(
                `FK_INDEX_EXEMPT has ${stale.length} stale entr(y/ies) — the ` +
                    `FK now leads an index (or the field/relation was ` +
                    `renamed). Remove:\n` +
                    stale.map((k) => `  ${k}`).join('\n'),
            );
        }
        expect(stale.length).toBe(0);
    });
});

describe('schema-index-coverage — Layer C: curated composite-index registry', () => {
    for (const idx of LIST_QUERY_INDEXES) {
        it(`${idx.model} has @@index([${idx.fields.join(', ')}]) — ${idx.justification}`, () => {
            const model = MODEL_BY_NAME.get(idx.model);
            expect(model).toBeDefined();
            if (!model) return;
            const ok = hasExactBlockIndex(model, idx.fields);
            if (!ok) {
                throw new Error(
                    `Model ${idx.model} is missing the curated composite ` +
                        `index @@index([${idx.fields.join(', ')}]).\n` +
                        `Justification: ${idx.justification}\n\n` +
                        `This index backs a real list filter/sort path. ` +
                        `Removing it regresses list latency. If the ` +
                        `corresponding filter was removed, drop this ` +
                        `LIST_QUERY_INDEXES entry in the same diff.`,
                );
            }
            expect(ok).toBe(true);
        });
    }
});

describe('schema-index-coverage — Layer C-completeness: every list-queried model is triaged', () => {
    const listQueryModels = scanListQueryModels();

    it('finds tenant-scoped models that are findMany-queried (scan sanity)', () => {
        // A near-zero count means the findMany scan broke.
        expect(listQueryModels.size).toBeGreaterThan(20);
    });

    it('every list-queried tenant model is in LIST_QUERY_INDEXES or LIST_MODELS_TENANT_INDEX_SUFFICIENT', () => {
        const curated = new Set(LIST_QUERY_INDEXES.map((i) => i.model));
        const untriaged = [...listQueryModels].filter(
            (m) =>
                !curated.has(m) &&
                !(m in LIST_MODELS_TENANT_INDEX_SUFFICIENT),
        );
        if (untriaged.length > 0) {
            throw new Error(
                `Found ${untriaged.length} tenant-scoped model(s) that are ` +
                    `findMany-queried in src/app-layer but are in NEITHER ` +
                    `LIST_QUERY_INDEXES nor ` +
                    `LIST_MODELS_TENANT_INDEX_SUFFICIENT:\n\n` +
                    untriaged.map((m) => `  ${m}`).join('\n') +
                    `\n\nTriage each:\n` +
                    `  - If its list query filters/sorts on a non-leading ` +
                    `column, add an @@index AND a LIST_QUERY_INDEXES entry.\n` +
                    `  - If it filters only by tenantId + a leading-indexed ` +
                    `FK/status column, add a ` +
                    `LIST_MODELS_TENANT_INDEX_SUFFICIENT entry with a reason.`,
            );
        }
        expect(untriaged.length).toBe(0);
    });

    it('LIST_MODELS_TENANT_INDEX_SUFFICIENT has no stale entries', () => {
        // An entry whose model is no longer findMany'd anywhere is
        // dead weight — remove it.
        const stale = Object.keys(LIST_MODELS_TENANT_INDEX_SUFFICIENT).filter(
            (m) => !listQueryModels.has(m),
        );
        if (stale.length > 0) {
            throw new Error(
                `LIST_MODELS_TENANT_INDEX_SUFFICIENT has ${stale.length} ` +
                    `stale entr(y/ies) — the model is no longer ` +
                    `findMany-queried in src/app-layer (removed or renamed). ` +
                    `Remove:\n` +
                    stale.map((m) => `  ${m}`).join('\n'),
            );
        }
        expect(stale.length).toBe(0);
    });
});

describe('schema-index-coverage — registry integrity', () => {
    it('every model named in any map resolves to a real parsed model', () => {
        const referenced = new Set<string>([
            ...Object.keys(TENANT_INDEX_EXEMPT),
            ...Object.keys(FK_INDEX_EXEMPT).map((k) => k.split('.')[0]),
            ...LIST_QUERY_INDEXES.map((i) => i.model),
            ...Object.keys(LIST_MODELS_TENANT_INDEX_SUFFICIENT),
        ]);
        const unknown = [...referenced].filter((m) => !MODEL_BY_NAME.has(m));
        if (unknown.length > 0) {
            throw new Error(
                `These model names appear in a registry/exempt map but do ` +
                    `NOT resolve to a real model in the Prisma schema ` +
                    `(typo or stale after a rename):\n` +
                    unknown.map((m) => `  ${m}`).join('\n'),
            );
        }
        expect(unknown.length).toBe(0);
    });

    it('every FK_INDEX_EXEMPT entry names a real field on its model', () => {
        const bad: string[] = [];
        for (const key of Object.keys(FK_INDEX_EXEMPT)) {
            const [modelName, fieldName] = key.split('.');
            const model = MODEL_BY_NAME.get(modelName);
            if (!model) continue; // caught by the previous test.
            if (!model.hasField(fieldName)) bad.push(key);
        }
        if (bad.length > 0) {
            throw new Error(
                `These FK_INDEX_EXEMPT keys name a field that does not ` +
                    `exist on the model (renamed or removed):\n` +
                    bad.map((k) => `  ${k}`).join('\n'),
            );
        }
        expect(bad.length).toBe(0);
    });

    it('every exempt-map reason is a non-trivial string', () => {
        const allReasons = [
            ...Object.values(TENANT_INDEX_EXEMPT),
            ...Object.values(FK_INDEX_EXEMPT),
            ...Object.values(LIST_MODELS_TENANT_INDEX_SUFFICIENT),
            ...LIST_QUERY_INDEXES.map((i) => i.justification),
        ];
        for (const reason of allReasons) {
            expect(typeof reason).toBe('string');
            expect(reason.trim().length).toBeGreaterThan(10);
        }
    });
});
