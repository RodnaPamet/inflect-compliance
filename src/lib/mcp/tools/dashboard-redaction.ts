/**
 * Which parts of a cross-domain dashboard payload belong to which domain.
 *
 * `get_compliance_posture` and `get_tenant_context` are the two MCP tools whose
 * result spans domains the tool's own gate does not cover: a `controls.view`
 * check lets the call through, and the payload then carries risk counts, evidence
 * pressure, policy and vendor summaries with it. Gating the CALL would leave an
 * agent reading, out of a controls tool, exactly the rows its principal is
 * forbidden — which is the read half of the confused deputy and the half the
 * data actually leaves through.
 *
 * So the sections are declared here, once, and the funnel removes the ones the
 * acting context cannot see. Shared by both tools because both read the same
 * `DashboardRepository.getStats` shape; keeping one list means a new stat cannot
 * be classified in one tool and forgotten in the other.
 */
import type { PermissionKey } from '@/lib/security/permission-key';

import type { McpRedactionRule, McpRowRedactionRule } from './types';

/** `getStats` fields, by the domain each counts. */
const STATS_BY_DOMAIN = {
    'risks.view': ['stats.risks', 'stats.highRisks'],
    'evidence.view': ['stats.evidence', 'stats.pendingEvidence', 'stats.overdueEvidence'],
    'tasks.view': ['stats.openTasks'],
    'audits.view': ['stats.openFindings'],
} as const;

/**
 * The executive payload: the stats above plus the per-domain aggregate blocks.
 *
 * `controlCoverage` and `stats.controls` are deliberately absent — `controls.view`
 * is the tool's own gate, so a context that reaches the payload at all holds it,
 * and a rule that can never fire is a rule that misleads its next reader.
 */
export const EXECUTIVE_DASHBOARD_REDACTION: readonly McpRedactionRule[] = [
    { key: 'risks.view', paths: [...STATS_BY_DOMAIN['risks.view'], 'riskBySeverity', 'riskByStatus'] },
    { key: 'evidence.view', paths: [...STATS_BY_DOMAIN['evidence.view'], 'evidenceExpiry'] },
    { key: 'tasks.view', paths: [...STATS_BY_DOMAIN['tasks.view'], 'taskSummary'] },
    { key: 'audits.view', paths: [...STATS_BY_DOMAIN['audits.view']] },
    { key: 'policies.view', paths: ['policySummary'] },
    { key: 'vendors.view', paths: ['vendorSummary'] },
];

/** The `{ stats, recentActivity }` payload — the stats half. */
export const TENANT_CONTEXT_REDACTION: readonly McpRedactionRule[] = [
    { key: 'risks.view', paths: [...STATS_BY_DOMAIN['risks.view']] },
    { key: 'evidence.view', paths: [...STATS_BY_DOMAIN['evidence.view']] },
    { key: 'tasks.view', paths: [...STATS_BY_DOMAIN['tasks.view']] },
    { key: 'audits.view', paths: [...STATS_BY_DOMAIN['audits.view']] },
];

/**
 * `AuditLog.entity` → the permission key needed to see that row.
 *
 * The recent-activity feed is one array carrying every domain, so a section-level
 * rule cannot express it: it has to be filtered per row. An entity NOT listed
 * here keeps its row — see `McpRowRedactionRule.keyOf`. That direction is a
 * decision: the feed also carries memberships, settings and audit-trail
 * housekeeping, none of which has a domain key, and dropping the unrecognised
 * would empty the feed rather than filter it.
 *
 * And because unlisted means VISIBLE, this list has to be the whole of each
 * governed domain, not its root model. The Prisma audit extension
 * (`src/lib/prisma.ts`) writes the MODEL name as `entity` for every write in a
 * tenant context, so a `RiskTreatmentPlan`, `TaskComment` or `ControlTestRun`
 * row — with its `after` state in `detailsJson` — is as much the risk, task or
 * control domain as the root is. Until #5371 only the roots were listed, and
 * every child model's rows passed unredacted to a principal forbidden the
 * domain. So each group below is every model of its domain (by name prefix and
 * by the domain's schema file), plus the non-model spellings `logEvent`
 * callers write for it (`RISK_TREATMENT_PLAN`, `TREATMENT_MILESTONE`,
 * `TEST_RUN`, `File`, ...).
 *
 * Lookup is by `normaliseActivityEntity` — case- and underscore-insensitive —
 * so `RiskTreatmentPlan`, `RISK_TREATMENT_PLAN` and `risk` all resolve here
 * and one entry covers every spelling.
 *
 * `tests/unit/mcp-activity-entity-domain.test.ts` derives the population from
 * the schema: a model added to a governed domain fails CI until it is listed
 * here or in `ACTIVITY_ENTITY_UNGOVERNED` with a reason.
 */
export const ACTIVITY_DOMAIN_ENTITIES = {
    'risks.view': [
        'Risk', 'RiskAppetiteBreach', 'RiskAppetiteConfig', 'RiskControl', 'RiskCorrelation',
        'RiskHierarchyLink', 'RiskHierarchyNode', 'RiskKeySequence', 'RiskMatrixConfig',
        'RiskScenario', 'RiskScoreEvent', 'RiskSimulationRun', 'RiskSnapshot',
        'RiskSuggestionItem', 'RiskSuggestionSession', 'RiskTemplate', 'RiskTreatmentPlan',
        'KeyRiskIndicator', 'KriReading', 'LossEvent', 'PortfolioSnapshot', 'TreatmentMilestone',
        // `logEvent` spelling of a risk treatment plan (deadline / calendar rows).
        'TreatmentPlan',
    ],
    'reports.view': ['ReportTemplate', 'ReportRun', 'ReportSchedule'],
    'controls.view': [
        'Control', 'ControlAsset', 'ControlContributor', 'ControlEvidenceLink', 'ControlException',
        'ControlKeySequence', 'ControlRequirementLink', 'ControlTemplate',
        'ControlTemplateRequirementLink', 'ControlTemplateTask', 'ControlTestEvidenceLink',
        'ControlTestPlan', 'ControlTestRun', 'ControlTestStep',
        // `logEvent` spellings of a control test plan / run.
        'TestPlan', 'TestRun',
    ],
    'evidence.view': [
        'Evidence', 'EvidenceAssetLink', 'EvidenceControlLink', 'EvidenceReview',
        'EvidenceRiskLink', 'EvidenceTag', 'FileRecord',
        // `logEvent` spelling of a file download (`usecases/file.ts`).
        'File',
    ],
    'policies.view': [
        'Policy', 'PolicyAcknowledgement', 'PolicyAcknowledgementAssignment', 'PolicyApproval',
        'PolicyControlLink', 'PolicyEvidenceItem', 'PolicyTemplate', 'PolicyVersion',
    ],
    'tasks.view': ['Task', 'TaskComment', 'TaskKeySequence', 'TaskLink', 'TaskWatcher', 'Issue'],
    'audits.view': [
        'Audit', 'AuditChecklistItem', 'AuditCycle', 'AuditPack', 'AuditPackItem',
        'AuditPackShare', 'AuditPackShareComment', 'AuditWorkpaper', 'AuditWorkpaperFinding',
        'AuditWorkpaperNarrative', 'AuditWorkpaperSampleReview', 'AuditorAccount',
        'AuditorPackAccess', 'ReadinessSnapshot',
        // Findings sit under `audits.view` here as they do in `STATS_BY_DOMAIN`.
        'Finding', 'FindingAsset', 'FindingEvidence', 'FindingRisk',
        // `logEvent` spelling of a readiness report.
        'ReadinessReport',
    ],
    'vendors.view': [
        'Vendor', 'VendorAnswerProposal', 'VendorAssessment', 'VendorAssessmentAnswer',
        'VendorAssessmentTemplate', 'VendorAssessmentTemplateQuestion',
        'VendorAssessmentTemplateSection', 'VendorContact', 'VendorDocExtraction',
        'VendorDocument', 'VendorEvidenceBundle', 'VendorEvidenceBundleItem', 'VendorLink',
        'VendorMonitor', 'VendorPostureEvent', 'VendorRelationship',
        'QuestionnaireTemplate', 'QuestionnaireQuestion',
    ],
    'assets.view': [
        'Asset', 'AssetKeySequence', 'AssetRiskLink', 'AssetVulnerability',
        'ScannerRun', 'ScannerFinding',
    ],
    'incidents.view': [
        'Incident', 'IncidentEvidence', 'IncidentNotification', 'IncidentTimelineEntry',
    ],
    'personnel.view': [
        'Employee', 'TrainingCourse', 'TrainingAssignment', 'BackgroundCheck', 'Device',
        'PreHire', 'ConnectedIdentityAccount', 'IdentityAccountLink',
    ],
    // A journal row names a change made to one of a customer's people's
    // directory accounts, and its only read surface is OWNER-only
    // (`admin/identity-write-journal`). The feed mirrors that gate.
    'admin.tenant_lifecycle': ['IdentityWriteJournal'],
} satisfies Partial<Record<PermissionKey, readonly string[]>>;

/**
 * Models of a governed domain's schema file, or named like one, that are
 * deliberately NOT mapped above — so their rows stay in the feed — each with
 * the reason. An entry here is a decision; a model that is in neither list
 * fails `tests/unit/mcp-activity-entity-domain.test.ts`.
 */
export const ACTIVITY_ENTITY_UNGOVERNED: Readonly<Record<string, string>> = {
    AuditLog:
        'The audit trail itself, not an audit engagement. The extension never writes it '
        + '(EXCLUDED_MODELS), and the feed it would describe is already gated on canAudit.',
    AuditOutbox:
        'Audit-trail delivery plumbing, not an audit engagement; it carries no domain content.',
    Cve:
        'The global NVD catalogue: public CVE data with no tenant, not a tenant asset.',
    BusinessImpactAnalysis:
        'Business continuity has no view key by decision (`continuity` in permissions.ts: '
        + 'every member reads it), so there is no key to require.',
    BiaDependency:
        'A BusinessImpactAnalysis child; continuity has no view key (see BusinessImpactAnalysis).',
    AccessReviewAgentPack:
        'Declared in audit-workflow.prisma but of the access-review domain, which this map '
        + 'does not cover; not an audit-engagement row.',
    AccessReviewAgentNarrowing:
        'Of the access-review domain, not audits (see AccessReviewAgentPack).',
    AccessReviewDecisionSampleAudit:
        'Of the access-review domain, not audits (see AccessReviewAgentPack).',
};

/** `RISK_TREATMENT_PLAN`, `RiskTreatmentPlan`, `risktreatmentplan` → one key. */
export function normaliseActivityEntity(entity: string): string {
    return entity.replace(/[_\s-]/g, '').toLowerCase();
}

const ACTIVITY_ENTITY_DOMAIN: ReadonlyMap<string, PermissionKey> = new Map(
    (Object.entries(ACTIVITY_DOMAIN_ENTITIES) as Array<[PermissionKey, readonly string[]]>).flatMap(
        ([key, entities]) => entities.map((e) => [normaliseActivityEntity(e), key] as const),
    ),
);

/** The key a recent-activity row of this `entity` requires, or `null` (kept). */
export function activityEntityKey(entity: string): PermissionKey | null {
    return ACTIVITY_ENTITY_DOMAIN.get(normaliseActivityEntity(entity)) ?? null;
}

export const TENANT_CONTEXT_ROW_REDACTION: readonly McpRowRedactionRule[] = [
    {
        path: 'recentActivity',
        keyOf: (row) => {
            const entity = (row as { entity?: unknown } | null)?.entity;
            if (typeof entity !== 'string') return null;
            return activityEntityKey(entity);
        },
    },
];
