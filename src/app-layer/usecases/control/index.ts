/**
 * Control usecase barrel export.
 *
 * All public functions are re-exported here so existing imports
 * from '@/app-layer/usecases/control' continue to work unchanged.
 */
export {
    listControls,
    listControlKpiCounts,
    listControlsPaginated,
    getControl,
    getControlHeader,
    getControlActivity,
    listControlsWithDeleted,
} from './queries';

export {
    createControl,
    updateControl,
    setControlStatus,
    setControlApplicability,
    setControlOwner,
    setRequirementLinkApplicability,
    deleteControl,
    restoreControl,
    purgeControl,
    bulkSetControlStatus,
    bulkAssignControl,
    bulkDeleteControl,
} from './mutations';

export {
    listEvidenceLinks,
    getControlEvidenceTab,
    linkEvidence,
    unlinkEvidence,
} from './evidence';

export { linkAssetToControl, unlinkAssetFromControl } from './asset-links';

export { listContributors, addContributor, removeContributor } from './contributors';

// `templates.ts` renamed to `mappings.ts` (roadmap P3.3): only two of its
// seven exports are about templates; the rest are framework/requirement
// mapping, and the old name sent people looking for mapping code in the
// wrong file.
export {
    listControlTemplates,
    installControlsFromTemplate,
    listFrameworks,
    listFrameworkRequirements,
    mapRequirementToControl,
    unmapRequirementFromControl,
    listControlMappings,
} from './mappings';

// Whole-tenant admin aggregates — split out of ./queries, which was answering
// two different questions (per-request list/detail vs tenant-wide scan).
export { getControlDashboard, runConsistencyCheck } from './dashboard';

// ─── The rest of the Control domain (roadmap P3.3) ────────────────────
//
// These three lived at `usecases/control-{test,exception,roi}.ts` — 1,801
// lines of the Control domain sitting NEXT TO the directory that claims to
// be the Control domain, so `usecases/control/` held barely half of it and
// the barrel below was not the import surface it looked like. Moved in
// 2026-08-08; every call site now imports from this barrel.
export {
    listControlTestPlans,
    getTestPlan,
    getTestRun,
    listRunEvidence,
    computeControlEffectivenessMap,
    isAttestingVerdict,
    attestControlTested,
    createTestPlan,
    updateTestPlan,
    createTestRun,
    startTestRun,
    completeTestRun,
    retestFromRun,
    linkEvidenceToRun,
    unlinkEvidenceFromRun,
    createAutomatedTestRun,
    bulkSetTestPlanStatus,
    bulkDeleteTestPlan,
    bulkRestoreTestPlan,
    bulkAssignTestPlan,
    type ControlEffectiveness,
} from './test-plans';

export {
    listControlExceptions,
    getControlException,
    requestException,
    approveException,
    rejectException,
    renewException,
    getExpiringExceptions,
    type RequestExceptionResult,
    type ApproveExceptionResult,
    type RejectExceptionResult,
    type RenewExceptionResult,
    type ExpiringException,
} from './exceptions';

export {
    getControlRoi,
    getBestValueControls,
    type EffectivenessSource,
    type ControlRoiPayload,
    type BestValueRow,
} from './roi';

// Page-data orchestration (collapses control + sync waterfall on detail page)
export { getControlPageData, type ControlPageDataPayload, type SyncStatusPayload } from './page-data';

// Control health synthesis (R2-P2 — one "is it implemented and operating?" payload)
export {
    getControlHealth,
    getControlHealthVerdicts,
    type ControlHealthDTO,
    type ControlHealthSummary,
    type ControlHealthVerdictRow,
} from './health';
