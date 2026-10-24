/**
 * Framework Library System — Public API
 *
 * This module provides the core abstractions for the YAML-based framework
 * library system. It exposes:
 *
 * 1. Zod schemas for YAML validation (schemas.ts)
 * 2. Runtime types for loaded libraries (types.ts)
 * 3. Parser/loader services (library-loader.ts)
 *
 * Usage:
 *   import { parseLibraryFile, loadLibrary, type LoadedLibrary } from '@/app-layer/libraries';
 */

// ─── Schemas (StoredLibrary = raw YAML shape) ────────────────────────
export {
    StoredLibrarySchema,
    FrameworkObjectSchema,
    RequirementNodeSchema,
    MappingEntrySchema,
    ScoreDefinitionSchema,
    FrameworkKindSchema,
    MappingStrengthSchema,
    type StoredLibrary,
    type FrameworkObject,
    type RequirementNode,
    type MappingEntry,
    type ScoreDefinition,
    type FrameworkKind,
    type MappingStrength,
} from './schemas';

// ─── Types (LoadedLibrary = runtime-normalized) ──────────────────────
export type {
    LoadedLibrary,
    LoadedFramework,
    LoadedRequirementNode,
    LoadedMapping,
    LibraryRegistryEntry,
} from './types';

// ─── Loader Services ────────────────────────────────────────────────
export {
    parseLibraryFile,
    parseLibraryString,
    loadLibrary,
    validateUrnUniqueness,
    validateParentReferences,
    scanLibraryDirectory,
    loadAllFromDirectory,
    computeLibraryTextHash,
    LibraryParseError,
    LibraryValidationError,
    LibraryUrnCollisionError,
} from './library-loader';

// ─── Runtime Provider (legacy-compatible + YAML-backed) ─────────────
export {
    getLibraryByRefId,
    getLibraryByUrn,
    getAllLibraries,
    findNodeByUrn,
    findNodeByRefId,
    getSOC2Requirements,
    getNIS2Requirements,
    getISO27001Clauses,
    getFrameworkMappings,
    getAssessableNodes,
    getFrameworkTree,
    listAvailableFrameworks,
    reloadLibraries,
    isYamlBackedAvailable,
    type FrameworkInfo,
    type ClauseInfo,
    type GuidanceMapping,
} from './framework-provider';

// ─── Dependency Graph ───────────────────────────────────────────────
export {
    topologicalSort,
    resolveDependencies,
    sortLibrariesByDependency,
    DependencyCycleError,
    type DependencyNode,
    type DependencyResolution,
} from './dependency-graph';

// ─── Version History ────────────────────────────────────────────────
export {
    createHistoryEntry,
    appendHistoryEntry,
    emptyHistory,
    getRecentEntries,
    getEntryByVersion,
    getLatestEntry,
    getStablyRemovedCodes,
    getStablyAddedCodes,
    getStablyChangedCodes,
    parseHistoryFromMetadata,
    mergeHistoryIntoMetadata,
    type VersionHistoryEntry,
    type FrameworkVersionHistory,
} from './version-history';
