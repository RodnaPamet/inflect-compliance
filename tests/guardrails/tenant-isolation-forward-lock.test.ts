/**
 * Tenant-model isolation FORWARD-LOCK (extends H5 / GAP-1).
 *
 * \`rls-coverage.test.ts\` DB-verifies that every tenant-scoped model carries
 * the canonical RLS policy triple + FORCE — a STRUCTURAL proof (shape). This
 * ratchet adds the BEHAVIOURAL axis (conduct): every tenant-scoped model must
 * be CLASSIFIED as either
 *   • ISOLATION_TESTED — it has a dedicated two-tenant behavioural test that
 *     drives the real usecases/repos under two tenant contexts and proves a
 *     tenant-B caller cannot read/mutate tenant-A rows (file must exist); or
 *   • ISOLATION_BASELINE — a snapshot of the models that pre-date this lock,
 *     currently proven only structurally by rls-coverage. A dedicated
 *     behavioural test is a tracked follow-up.
 *
 * The forward-lock: a NEWLY-ADDED tenant model appears in neither set, so CI
 * FAILS until it is triaged — pushing new subsystems toward a real two-tenant
 * behavioural test by construction. See docs/new-subsystem-checklist.md.
 *
 * Structural certifies shape; behavioural certifies conduct. This platform
 * now enforces both.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSchemaModels } from "../helpers/prisma-schema-models";

const ROOT = path.resolve(__dirname, "../..");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/** Models with a dedicated two-tenant BEHAVIOURAL isolation test. */
const ISOLATION_TESTED: Readonly<Record<string, string>> = {
    IdentityAccountLink: "tests/integration/identity-account-link-rls.test.ts",
    IdentityWriteJournal: "tests/integration/identity-write-journal-rls.test.ts",
    EvidenceControlLink: "tests/integration/evidence-control-link-rls.test.ts",
    EvidenceRiskLink: "tests/integration/evidence-risk-asset-link-rls.test.ts",
    EvidenceAssetLink: "tests/integration/evidence-risk-asset-link-rls.test.ts",
    EvidenceTag: "tests/integration/evidence-risk-asset-link-rls.test.ts",
    AccessReviewConnectedDecision: "tests/integration/access-review-rls.test.ts",
    ControlException: "tests/integration/control-exception-rls.test.ts",
    InboundQuestionnaire: "tests/integration/wave-features-rls.test.ts",
    Device: "tests/integration/wave-features-rls.test.ts",
    Employee: "tests/integration/wave-features-rls.test.ts",
    RegisteredAgent: "tests/integration/agent-registry-isolation.test.ts",
    RegisteredAgentTool: "tests/integration/mcp-tool-authz-per-invocation.test.ts",
    AgentRiskAssessment: "tests/integration/agent-assessment-isolation.test.ts",
    AgentRiskAssessmentAnswer: "tests/integration/agent-assessment-isolation.test.ts",
    AgentPolicyCard: "tests/integration/policy-card-isolation.test.ts",
    AgentPolicyCardVersion: "tests/integration/policy-card-isolation.test.ts",
    AgentProposalApproval: "tests/integration/proposal-review-tiering.test.ts",
    AgentProposalSampleAudit: "tests/integration/proposal-sample-audit.test.ts",
    McpToolManifestPin: "tests/integration/tool-manifest-pin-isolation.test.ts",
};

/**
 * Baseline snapshot (captured 2026-07-10) of tenant models proven structurally
 * by rls-coverage, pending a dedicated behavioural test. NOTHING new belongs
 * here silently — a new model must be a deliberate addition WITH the intent to
 * add a behavioural test, or (preferably) go straight into ISOLATION_TESTED.
 */
const ISOLATION_BASELINE: readonly string[] = [
    "AccessReview",
    "AccessReviewDecision",
    "AgentActionReceipt",
    "AgentProposal",
    "AiDecisionLog",
    "AiGovSelfAssessment",
    "AiGovSelfAssessmentAnswer",
    "AiSystem",
    "AiSystemRequirementLink",
    "Asset",
    "AssetKeySequence",
    "AssetRiskLink",
    "AssetVulnerability",
    "Audit",
    "AuditChecklistItem",
    "AuditCycle",
    "AuditLog",
    "AuditPack",
    "AuditPackItem",
    "AuditPackShare",
    "AuditPackShareComment",
    "AuditorAccount",
    "AuditorPackAccess",
    "AutomationExecution",
    "AutomationRule",
    "BackgroundCheck",
    "BiaDependency",
    "BillingAccount",
    "BillingEvent",
    "BusinessImpactAnalysis",
    "ClauseProgress",
    "CompliancePostureSummary",
    "ComplianceSnapshot",
    "ConnectedIdentityAccount",
    "Control",
    "ControlAsset",
    "ControlContributor",
    "ControlEvidenceLink",
    "ControlKeySequence",
    "ControlRequirementLink",
    "ControlTestEvidenceLink",
    "ControlTestPlan",
    "ControlTestRun",
    "ControlTestStep",
    "Evidence",
    "EvidenceReview",
    "FileRecord",
    "Finding",
    "FindingAsset",
    "FindingEvidence",
    "FindingRisk",
    "FrameworkRequirementOrder",
    "InboundQuestionnaireItem",
    "Incident",
    "IncidentEvidence",
    "IncidentNotification",
    "IncidentTimelineEntry",
    "IntegrationConnection",
    "IntegrationExecution",
    "IntegrationSyncMapping",
    "IntegrationWebhookEvent",
    "KeyRiskIndicator",
    "KriReading",
    "LossEvent",
    "Nis2GapAssignment",
    "Nis2SelfAssessment",
    "Nis2SelfAssessmentAnswer",
    "Notification",
    "NotificationOutbox",
    "Policy",
    "PolicyApproval",
    "PolicyControlLink",
    "PolicyEvidenceItem",
    "PolicyVersion",
    "PortfolioSnapshot",
    "ProcessEdge",
    "ProcessEdgeControl",
    "ProcessMap",
    "ProcessMapSnapshot",
    "ProcessNode",
    "QuestionnaireAnswerLibrary",
    "ReadinessSnapshot",
    "ReminderHistory",
    "ReportRun",
    "ReportSchedule",
    "ReportTemplate",
    "Risk",
    "RiskAppetiteBreach",
    "RiskAppetiteConfig",
    "RiskControl",
    "RiskCorrelation",
    "RiskHierarchyLink",
    "RiskHierarchyNode",
    "RiskKeySequence",
    "RiskMatrixConfig",
    "RiskScenario",
    "RiskScoreEvent",
    "RiskSimulationRun",
    "RiskSnapshot",
    "RiskSuggestionItem",
    "RiskSuggestionSession",
    "RiskTreatmentPlan",
    "ScannerFinding",
    "ScannerRun",
    "ScimGroup",
    "Task",
    "TaskComment",
    "TaskKeySequence",
    "TaskLink",
    "TaskWatcher",
    "TenantApiKey",
    "TenantCustomRole",
    "TenantDeviceToken",
    "TenantEntraGroupMapping",
    "TenantFrameworkDelta",
    "TenantIdentityProvider",
    "TenantInvite",
    "TenantMembership",
    "TenantNotificationSettings",
    "TenantOnboarding",
    "TenantScimToken",
    "TenantSecuritySettings",
    "TrainingAssignment",
    "TrainingCourse",
    "TreatmentMilestone",
    "TrustCenter",
    "TrustCenterAccessRequest",
    "TrustCenterDocument",
    "UserIdentityLink",
    "UserMfaEnrollment",
    "TenantCalendarConsent",
    "UserCalendarConnection",
    "UserCalendarEventMapping",
    "UserNotificationPreference",
    "UserSession",
    "Vendor",
    "VendorAnswerProposal",
    "VendorAssessment",
    "VendorAssessmentAnswer",
    "VendorAssessmentTemplate",
    "VendorAssessmentTemplateQuestion",
    "VendorAssessmentTemplateSection",
    "VendorContact",
    "VendorDocExtraction",
    "VendorDocument",
    "VendorEvidenceBundle",
    "VendorEvidenceBundleItem",
    "VendorLink",
    "VendorMonitor",
    "VendorPostureEvent",
    "VendorRelationship",
    "WorkflowRun",
    "WorkflowStep",
];

describe("Tenant-model isolation forward-lock", () => {
    const tenantModels = parseSchemaModels()
        .filter((m) => m.fields.some((f) => f.name === "tenantId"))
        .map((m) => m.name);
    const classified = new Set([...Object.keys(ISOLATION_TESTED), ...ISOLATION_BASELINE]);

    it("every tenant-scoped model is classified (TESTED or BASELINE) — new models fail here", () => {
        const unclassified = tenantModels.filter((m) => !classified.has(m));
        // A new tenant model trips this. Fix: add a two-tenant behavioural test
        // and list it in ISOLATION_TESTED, or add the model to ISOLATION_BASELINE
        // (rls-coverage is the interim structural proof) with the intent to follow up.
        expect(unclassified).toEqual([]);
    });

    it("no model is in BOTH sets (TESTED xor BASELINE)", () => {
        const both = Object.keys(ISOLATION_TESTED).filter((m) => ISOLATION_BASELINE.includes(m));
        expect(both).toEqual([]);
    });

    it("every dedicated isolation-test file exists", () => {
        const missing = Object.entries(ISOLATION_TESTED).filter(([, f]) => !exists(f)).map(([m]) => m);
        expect(missing).toEqual([]);
    });

    it("no stale classifications — every classified model still exists + is tenant-scoped", () => {
        const live = new Set(tenantModels);
        const stale = [...classified].filter((m) => !live.has(m));
        expect(stale).toEqual([]);
    });
});
