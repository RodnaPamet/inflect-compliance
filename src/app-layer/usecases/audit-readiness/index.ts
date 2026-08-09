/**
 * Audit Readiness usecase barrel export.
 *
 * All public functions are re-exported here so existing imports
 * from '@/app-layer/usecases/audit-readiness' resolve to this index.
 */

// Cycles
export {
    createAuditCycle,
    listAuditCycles,
    getAuditCycle,
    updateAuditCycle,
} from './cycles';

// Packs (CRUD, items, freeze, export, preview)
export {
    createAuditPack,
    listAuditPacks,
    getAuditPack,
    updateAuditPack,
    addAuditPackItems,
    freezeAuditPack,
    exportAuditPack,
    previewDefaultPack,
} from './packs';

// Sharing & auditor access
export {
    hashToken,
    generateShareToken,
    generateShareLink,
    revokeShare,
    getPackByShareToken,
    addShareComment,
    listShareComments,
    resolveShareComment,
    materializeShareCommentFinding,
    inviteAuditor,
    grantAuditorAccess,
    revokeAuditorAccess,
    revokeAuditorAccount,
    listAuditors,
    listPackShares,
} from './sharing';
export type {
    AddShareCommentInput, ShareCommentRow, AuditShareCommentKind,
    AuditorSummary, AuditorPackAccessRef, PackShareRow,
} from './sharing';

// Page-data orchestration (collapses 1+N waterfall on the overview page)
export { getReadinessOverview, type ReadinessOverviewPayload } from './overview';

// Scoring engine + its exports.
//
// `scoring.ts` used to sit outside this directory as
// `usecases/audit-readiness-scoring.ts` — the same domain, one level up, and
// absent from this barrel, so every consumer imported the deep path and the
// barrel's curated surface was a half-truth. (Second confirmed instance of the
// pattern; `control/health.ts` → `../control-test` was the first.)
//
// Curated named re-exports, deliberately not `export *` — the barrel says what
// the module offers rather than whatever it happens to export today.
export {
    scoreReadiness,
    computeReadiness,
    getReadinessHistory,
    exportReadinessJson,
    exportUnmappedCsv,
    exportControlGapsCsv,
    addReadinessToPack,
    ISO_WEIGHTS,
    NIS2_WEIGHTS,
    readinessBand,
    readinessVariant,
    readinessTone,
    READINESS_BAND_MIN,
    READINESS_BAND_VARIANT,
    READINESS_BAND_TONE,
    READINESS_BAND_COLOR_VAR,
} from './scoring';
export type {
    ReadinessBreakdown,
    ReadinessGap,
    ReadinessResult,
    ReadinessSnapshotRow,
    ReadinessBand,
} from './scoring';
