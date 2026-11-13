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
    // `db.finding.count` — the findings register's count, so the register's own
    // key (#4574), not `audits.view` (#5384).
    'findings.view': ['stats.openFindings'],
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
    { key: 'findings.view', paths: [...STATS_BY_DOMAIN['findings.view']] },
    { key: 'policies.view', paths: ['policySummary'] },
    { key: 'vendors.view', paths: ['vendorSummary'] },
];

/** The `{ stats, recentActivity }` payload — the stats half. */
export const TENANT_CONTEXT_REDACTION: readonly McpRedactionRule[] = [
    { key: 'risks.view', paths: [...STATS_BY_DOMAIN['risks.view']] },
    { key: 'evidence.view', paths: [...STATS_BY_DOMAIN['evidence.view']] },
    { key: 'tasks.view', paths: [...STATS_BY_DOMAIN['tasks.view']] },
    { key: 'findings.view', paths: [...STATS_BY_DOMAIN['findings.view']] },
];

/**
 * Reads that are a DISJUNCTION of keys, by name (#5384). A group in
 * `ACTIVITY_DOMAIN_ENTITIES` keyed by one of these names keeps its row for a
 * context holding ANY one of the listed keys (`McpRowRedactionRule.keyOf`).
 *
 * Each mirrors the predicate its domain's own read surface uses, and
 * `tests/unit/mcp-activity-entity-domain.test.ts` checks both against
 * those predicates over every combination of their inputs.
 */
export const ACTIVITY_KEY_SETS = {
    /** `mayReadAgentInventory` — the inventory view key, or the register key. */
    agentInventory: ['admin.agent_registry_view', 'admin.agent_registry'],
    /** `mayReadAgentActivity` — runs and proposals: `admin.view`, or the view key. */
    agentActivity: ['admin.view', 'admin.agent_registry_view'],
} as const satisfies Record<string, readonly PermissionKey[]>;

type ActivityKeySetName = keyof typeof ACTIVITY_KEY_SETS;

/** What a recent-activity row requires: one key, or any one of several. */
export type ActivityRowKey = PermissionKey | readonly PermissionKey[];

/**
 * `AuditLog.entity` → the permission key needed to see that row. A group is
 * named by a key, or by an `ACTIVITY_KEY_SETS` name when its domain's read is
 * "any one of" several keys.
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
        // `logEvent` spelling of a readiness report.
        'ReadinessReport',
    ],
    // The findings register's own key (#4574), as `STATS_BY_DOMAIN` counts
    // `openFindings` under it (#5384). `AuditWorkpaperFinding` stays above: it
    // is the workpaper's link row, read with the workpaper.
    'findings.view': ['Finding', 'FindingAsset', 'FindingEvidence', 'FindingRisk'],
    // Access-review campaigns (#5384). Every built-in role holds the key. The
    // campaign, its member decisions and its connected decisions are SHARED by
    // member, connected, legacy and AGENT scopes, and an audit row does not
    // reliably say which (an update's `detailsJson` carries the changed fields
    // only), so they stay here. The models that exist only for AGENT campaigns
    // are register data and sit under `agentInventory` below.
    'access_reviews.view': ['AccessReview', 'AccessReviewDecision', 'AccessReviewConnectedDecision'],
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
    // (`admin/identity-write-journal`). The feed mirrors that gate. Its twin
    // for writes to a customer's third-party systems, and the prior-state
    // pairing that feeds it, sit beside it on the same key as their policy
    // surfaces (`admin/external-write-policy`, `admin/external-prior-state-read`).
    'admin.tenant_lifecycle': ['IdentityWriteJournal', 'ExternalWriteJournal', 'ExternalToolPriorStateRead'],

    // ── The agent register (#5384) ──────────────────────────────────────
    //
    // Every model of `agentic.prisma`, the agent's action receipts, and the
    // AGENT-campaign-only access-review models. The default is the inventory
    // read (`mayReadAgentInventory`), which OWNER, ADMIN, AI_ADMIN and AUDITOR
    // hold and READER and EDITOR do not; a model whose own read surface is a
    // different gate takes that gate instead.
    agentInventory: [
        'RegisteredAgent', 'RegisteredAgentTool',
        'AgentAssessmentDomain', 'AgentAssessmentQuestion', 'AgentRiskAssessment',
        'AgentRiskAssessmentAnswer',
        'AgentPolicyCard', 'AgentPolicyCardVersion', 'AgentProfile', 'AgentProfileVersion',
        'McpToolManifestPin', 'ExternalToolParameterSet', 'ExternalToolParameterSetApproval',
        'AgentKillSwitch', 'PlatformAgentKillSwitch', 'AgentKillSwitchDrill',
        'AgentBehaviourWindow', 'AgentCircuitBreaker', 'AgentBehaviourBaseline',
        'AgentBehaviourAnomaly', 'AgenticEvidenceArtefact', 'AgentActionReceipt',
        'AgentHarnessScannerKey', 'AgentHarnessScan', 'AgentHarnessScanItem',
        'AgentHarnessAcceptance', 'AgentHarnessEstate', 'AgentHarnessEstateSource',
        'DiscoveredAgent', 'DiscoveredAgentAttribution', 'AgentServicePrincipalConfirmation',
        'AgentOwnershipTransfer', 'AgentSpendingAuthority', 'OpenShellSandboxLease',
        'PeerAgent', 'PeerAgentMessage', 'PeerAgentReplyDelivery', 'PeerAgentKillSwitch',
        'PeerAgentInboundCredential', 'PeerInvitation', 'TenantA2aSigningKey',
        'HostConsumer', 'HostConsumerMessage', 'HostConsumerKillSwitch',
        // An AGENT campaign's packs, narrowings and second-human samples: every
        // read of them narrows to the campaign's reviewer or a register reader
        // (CLAUDE.md, "Agent recertification"). The reviewer half depends on
        // the campaign, which a row cannot tell; the register half is applied.
        'AccessReviewAgentPack', 'AccessReviewAgentNarrowing', 'AccessReviewDecisionSampleAudit',
    ],
    // Runs and proposals are read by `mayReadAgentActivity` (`/agent-runs`,
    // `/agent-proposals`), not the inventory predicate.
    // A run's deferred tool calls (Step 2f) are read on the run page, under the same predicate.
    agentActivity: ['WorkflowRun', 'WorkflowStep', 'WorkflowRunDeferral', 'AgentProposal', 'AgentProposalApproval'],
    // The retrospective sample audits of approved proposals: their only read
    // surface is `/agent-proposals/sample-audits`, on the register key alone.
    //
    // Tenant skills are read under either skill key, and those two keys are
    // ADMIN-API-only by decision: no machine surface may name them
    // (`tests/guardrails/admin-membership-only-keys-are-dead-elsewhere.test.ts`),
    // and this rule runs inside a tool call. The register key stands in — every
    // built-in role holding a skill key (OWNER, ADMIN, AI_ADMIN) holds it, and
    // AUDITOR, which holds neither skill key, does not.
    'admin.agent_registry': ['AgentProposalSampleAudit', 'TenantSkill', 'TenantSkillVersion'],
} satisfies Partial<Record<PermissionKey | ActivityKeySetName, readonly string[]>>;

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
};

/** `RISK_TREATMENT_PLAN`, `RiskTreatmentPlan`, `risktreatmentplan` → one key. */
export function normaliseActivityEntity(entity: string): string {
    return entity.replace(/[_\s-]/g, '').toLowerCase();
}

const isKeySetName = (group: string): group is ActivityKeySetName =>
    Object.prototype.hasOwnProperty.call(ACTIVITY_KEY_SETS, group);

const ACTIVITY_ENTITY_DOMAIN: ReadonlyMap<string, ActivityRowKey> = new Map(
    (Object.entries(ACTIVITY_DOMAIN_ENTITIES) as Array<[PermissionKey | ActivityKeySetName, readonly string[]]>)
        .flatMap(([group, entities]) => {
            const key: ActivityRowKey = isKeySetName(group) ? ACTIVITY_KEY_SETS[group] : group;
            return entities.map((e) => [normaliseActivityEntity(e), key] as const);
        }),
);

/**
 * What a recent-activity row of this `entity` requires — one key, or an array
 * meaning any one of them — or `null` (kept).
 */
export function activityEntityKey(entity: string): ActivityRowKey | null {
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
