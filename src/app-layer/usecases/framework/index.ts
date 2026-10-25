/**
 * Framework usecase barrel export.
 *
 * All public functions are re-exported here so existing imports
 * from '@/app-layer/usecases/framework' resolve to this index.
 */

// Catalog (read-only framework queries)
export {
    listFrameworks,
    listInstallableFrameworks,
    resolveFrameworkPackKeys,
    getFramework,
    getFrameworkRequirements,
    listFrameworkPacks,
} from './catalog';

// Hierarchical tree view (Epic 46)
export { getFrameworkTree, reorderFrameworkRequirements } from './tree';

// Install operations (pack, template, bulk)
export {
    previewPackInstall,
    installPack,
    installSingleTemplate,
    bulkInstallTemplates,
    bulkMapControls,
} from './install';

// Coverage, templates, & readiness
export {
    computeCoverage,
    isFrameworkInUse,
    listFrameworksInUse,
    listTemplates,
    exportCoverageData,
    generateReadinessReport,
    exportReadinessReport,
} from './coverage';

// Coverage inherited from the tenant's other frameworks through mappings
export { computeInheritedCoverage } from './inherited-coverage';
export type {
    InheritedCoverageReport,
    InheritedRequirementEntry,
    InheritedRequirementStatus,
} from './inherited-coverage';

// Fixture upsert & diff
export {
    upsertRequirements,
    computeRequirementsDiff,
} from './fixtures';

export type { RequirementFixture } from './fixtures';
