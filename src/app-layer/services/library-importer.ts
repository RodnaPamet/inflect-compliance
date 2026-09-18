/**
 * Library Importer — Import/update pipeline for YAML framework libraries.
 *
 * Responsibilities:
 * 1. Load and validate YAML libraries from disk
 * 2. Compute content hash for deduplication
 * 3. Compare against stored framework versions/hashes in Prisma
 * 4. Skip unchanged libraries (hash match)
 * 5. Prepare and execute upsert payloads for changed/new libraries
 *
 * This service orchestrates the full Store → Parse → Compare → Upsert flow
 * but delegates update strategy decisions to the library-updater module.
 *
 * Import logic is NEVER placed in route handlers.
 */
import { PrismaClient, FrameworkKind } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import {
    parseLibraryFile,
    loadLibrary,
    type LoadedLibrary,
} from '../libraries';
import { sortLibrariesByDependency } from '../libraries/dependency-graph';
import {
    createHistoryEntry,
    appendHistoryEntry,
    parseHistoryFromMetadata,
    mergeHistoryIntoMetadata,
} from '../libraries/version-history';
import {
    computeRequirementDiff,
    type MigrationStrategy,
    applyMigrationStrategy,
} from './library-updater';
import {
    recordDiffFromVersionHistory,
    propagateFrameworkDelta,
} from '@/app-layer/usecases/framework-delta';

// ─── Types ───────────────────────────────────────────────────────────

/** Result of a single library import operation. */
export interface ImportResult {
    /** Library URN */
    urn: string;
    /** Framework key stored in DB */
    frameworkKey: string;
    /** Library version */
    version: number;
    /** Whether this library was imported/updated or skipped */
    action: 'created' | 'updated' | 'skipped';
    /** Number of requirements created */
    requirementsCreated: number;
    /** Number of requirements updated */
    requirementsUpdated: number;
    /** Number of requirements deprecated */
    requirementsDeprecated: number;
    /** Content hash used for deduplication */
    contentHash: string;
    /** Duration of the import in ms */
    durationMs: number;
    /** Requirement codes added in this import (drives the version-history entry + delta). */
    addedCodes: string[];
    /** Requirement codes whose content changed in this import. */
    changedCodes: string[];
    /** Requirement codes removed (deprecated) in this import. */
    removedCodes: string[];
}

/** Options for the import pipeline. */
export interface ImportOptions {
    /**
     * Migration strategy to use when updating existing frameworks.
     * Only applies when a framework version/hash changes.
     * Default: 'preserve' (keep existing data, add new, deprecate removed)
     */
    strategy?: MigrationStrategy;
    /**
     * If true, requirements no longer in the YAML will be soft-deprecated.
     * Default: true
     */
    deprecateMissing?: boolean;
    /**
     * If true, force reimport even if content hash matches.
     * Useful for repair/rebuild scenarios.
     * Default: false
     */
    force?: boolean;
    /**
     * If true, an UPDATE that changes the requirement set records a
     * FrameworkVersionDiff and fans a per-tenant TenantFrameworkDelta out to
     * every installed tenant (Epic Regwatch 2A). Never fires on first create
     * (no prior version). Propagation failure never fails the import.
     * Default: true.
     */
    propagateDelta?: boolean;
}

const DEFAULT_OPTIONS: Required<ImportOptions> = {
    strategy: 'preserve',
    deprecateMissing: true,
    force: false,
    propagateDelta: true,
};

// ─── Framework Kind Mapping ──────────────────────────────────────────
/**
 * Map YAML framework kinds to Prisma FrameworkKind enum.
 * The YAML schema has a superset of kinds; unknown ones fall back to ISO_STANDARD.
 */
function mapKindToPrisma(yamlKind: string): FrameworkKind {
    const mapping: Record<string, FrameworkKind> = {
        ISO_STANDARD: 'ISO_STANDARD',
        NIST_FRAMEWORK: 'NIST_FRAMEWORK',
        SOC_CRITERIA: 'SOC_CRITERIA',
        EU_DIRECTIVE: 'EU_DIRECTIVE',
        REGULATION: 'REGULATION',
        INDUSTRY_STANDARD: 'INDUSTRY_STANDARD',
        CUSTOM: 'CUSTOM',
    };
    return mapping[yamlKind] ?? 'ISO_STANDARD';
}

// ─── Core Importer ───────────────────────────────────────────────────

/**
 * Import a single library from a LoadedLibrary into Prisma.
 * Idempotent: safe to call multiple times for the same library.
 *
 * Flow:
 * 1. Check if framework exists in DB by key
 * 2. Compare content hash — skip if unchanged
 * 3. If new: create framework + requirements
 * 4. If changed: diff requirements, apply migration strategy, upsert
 */
export async function importLibrary(
    db: PrismaClient,
    library: LoadedLibrary,
    options?: ImportOptions,
): Promise<ImportResult> {
    const start = performance.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const frameworkKey = library.refId;
    const component = 'library-importer';

    logger.info('Import started', { component, urn: library.urn, key: frameworkKey, version: library.version });

    // 1. Check existing framework
    const existing = await db.framework.findFirst({
        where: { key: frameworkKey },
    });

    // 2. Hash comparison — skip if unchanged
    if (existing && !opts.force) {
        if (existing.contentHash === library.contentHash) {
            const durationMs = Math.round(performance.now() - start);
            logger.info('Import skipped (unchanged)', { component, urn: library.urn, key: frameworkKey, durationMs });
            return {
                urn: library.urn,
                frameworkKey,
                version: library.version,
                action: 'skipped',
                requirementsCreated: 0,
                requirementsUpdated: 0,
                requirementsDeprecated: 0,
                contentHash: library.contentHash,
                durationMs,
                addedCodes: [],
                changedCodes: [],
                removedCodes: [],
            };
        }
    }

    // 3. Create or update framework record
    let frameworkId: string;
    let isNew = false;

    if (existing) {
        // Update existing framework
        const updated = await db.framework.update({
            where: { id: existing.id },
            data: {
                name: library.name,
                description: library.description,
                version: library.version.toString(),
                contentHash: library.contentHash,
                sourceUrn: library.urn,
                kind: mapKindToPrisma(library.kind),
                metadataJson: JSON.stringify({
                    locale: library.locale,
                    provider: library.provider,
                    packager: library.packager,
                    publicationDate: library.publicationDate,
                    copyright: library.copyright,
                    dependencies: library.dependencies,
                    importedAt: new Date().toISOString(),
                }),
            },
        });
        frameworkId = updated.id;
    } else {
        // Create new framework
        const created = await db.framework.create({
            data: {
                key: frameworkKey,
                name: library.name,
                description: library.description,
                version: library.version.toString(),
                contentHash: library.contentHash,
                sourceUrn: library.urn,
                kind: mapKindToPrisma(library.kind),
                metadataJson: JSON.stringify({
                    locale: library.locale,
                    provider: library.provider,
                    packager: library.packager,
                    publicationDate: library.publicationDate,
                    copyright: library.copyright,
                    dependencies: library.dependencies,
                    importedAt: new Date().toISOString(),
                }),
            },
        });
        frameworkId = created.id;
        isNew = true;
    }

    // 4. Upsert requirements
    let result: ImportResult;

    if (isNew) {
        result = await createAllRequirements(db, frameworkId, library, start);
    } else {
        // existing is guaranteed non-null when isNew is false
        result = await updateRequirements(db, frameworkId, library, opts, start, existing!.metadataJson);
    }

    // 5. Record version history
    const existingMetadata = isNew ? null : existing!.metadataJson;
    const history = parseHistoryFromMetadata(existingMetadata);
    const assessableNodes = library.framework.nodes.filter(n => n.assessable);
    const allCodes = assessableNodes.map(n => n.refId);

    const historyEntry = createHistoryEntry({
        version: library.version,
        contentHash: library.contentHash,
        requirementCodes: allCodes,
        addedCodes: result.addedCodes,
        removedCodes: result.removedCodes,
        changedCodes: result.changedCodes,
    });

    const updatedHistory = appendHistoryEntry(history, historyEntry);
    const updatedMetadataJson = mergeHistoryIntoMetadata(
        isNew ? null : existing!.metadataJson,
        updatedHistory,
    );

    // Patch the metadataJson with history (preserve existing fields)
    await db.framework.update({
        where: { id: frameworkId },
        data: { metadataJson: updatedMetadataJson },
    });

    logger.info('Import completed', {
        component,
        urn: library.urn,
        key: frameworkKey,
        action: result.action,
        created: result.requirementsCreated,
        updated: result.requirementsUpdated,
        deprecated: result.requirementsDeprecated,
        durationMs: result.durationMs,
        historyEntries: updatedHistory.entries.length,
    });

    // 6. Regwatch 2A — a version UPDATE that changed the requirement set records
    //    a global FrameworkVersionDiff and fans a per-tenant delta out to every
    //    installed tenant. Never on first create (no prior version to diff).
    //    Fail-safe: the import already committed, so propagation errors are
    //    logged, never rethrown.
    const hasRequirementChange =
        result.addedCodes.length > 0 || result.changedCodes.length > 0 || result.removedCodes.length > 0;
    if (opts.propagateDelta && result.action === 'updated' && hasRequirementChange) {
        try {
            const recorded = await recordDiffFromVersionHistory(frameworkKey);
            if (recorded) {
                const { tenantsAffected } = await propagateFrameworkDelta(recorded.diffId);
                logger.info('Framework delta propagated', {
                    component, key: frameworkKey, diffId: recorded.diffId, tenantsAffected,
                });
            }
        } catch (err) {
            logger.error('Framework delta propagation failed (import already committed)', {
                component, key: frameworkKey,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return result;
}

/**
 * Import a library from a YAML file on disk.
 * Convenience wrapper around parseLibraryFile → loadLibrary → importLibrary.
 */
export async function importLibraryFromFile(
    db: PrismaClient,
    filePath: string,
    options?: ImportOptions,
): Promise<ImportResult> {
    const stored = parseLibraryFile(filePath);
    const loaded = loadLibrary(stored, filePath);
    return importLibrary(db, loaded, options);
}

/**
 * Import all libraries from a directory.
 * Returns results for each library, including skipped ones.
 */
export async function importAllFromDirectory(
    db: PrismaClient,
    dirPath: string,
    options?: ImportOptions,
): Promise<ImportResult[]> {
    const { scanLibraryDirectory, parseLibraryFile: parse, loadLibrary: load } = await import('../libraries');
    const entries = scanLibraryDirectory(dirPath);
    const results: ImportResult[] = [];

    // Load all libraries first, then sort by dependency order
    const loadedLibraries: LoadedLibrary[] = [];
    for (const entry of entries) {
        const stored = parse(entry.filePath);
        const loaded = load(stored, entry.filePath);
        loadedLibraries.push(loaded);
    }

    // Resolve dependency order (topological sort)
    const { sorted, resolution } = sortLibrariesByDependency(loadedLibraries);

    if (!resolution.fullyResolved) {
        for (const [urn, missing] of resolution.missingDependencies) {
            logger.warn('Library has unresolved dependencies', {
                component: 'library-importer',
                urn,
                missingDeps: missing,
            });
        }
    }

    // Import in dependency order
    for (const loaded of sorted) {
        const result = await importLibrary(db, loaded, options);
        results.push(result);
    }

    return results;
}

// ─── Internal: Create All Requirements (New Framework) ───────────────

async function createAllRequirements(
    db: PrismaClient,
    frameworkId: string,
    library: LoadedLibrary,
    startTime: number,
): Promise<ImportResult> {
    const assessableNodes = library.framework.nodes.filter(n => n.assessable);
    const addedCodes = assessableNodes.map(n => n.refId);
    let created = 0;

    for (let i = 0; i < assessableNodes.length; i++) {
        const node = assessableNodes[i];
        await db.frameworkRequirement.create({
            data: {
                frameworkId,
                code: node.refId,
                title: node.name ?? node.refId,
                description: node.description,
                category: node.category,
                section: node.section ?? node.category,
                sortOrder: i,
            },
        });
        created++;
    }

    return {
        urn: library.urn,
        frameworkKey: library.refId,
        version: library.version,
        action: 'created',
        requirementsCreated: created,
        requirementsUpdated: 0,
        requirementsDeprecated: 0,
        contentHash: library.contentHash,
        durationMs: Math.round(performance.now() - startTime),
        addedCodes,
        changedCodes: [],
        removedCodes: [],
    };
}

// ─── Internal: Update Requirements (Existing Framework) ──────────────

async function updateRequirements(
    db: PrismaClient,
    frameworkId: string,
    library: LoadedLibrary,
    opts: Required<ImportOptions>,
    startTime: number,
    existingMetadataJson?: string | null,
): Promise<ImportResult> {
    // Fetch current requirements from DB
    const existingReqs = await db.frameworkRequirement.findMany({
        where: { frameworkId, deprecatedAt: null },
    });

    // Get new assessable nodes from the library
    const newNodes = library.framework.nodes.filter(n => n.assessable);

    // Compute diff
    const diff = computeRequirementDiff(
        existingReqs.map(r => ({ code: r.code, title: r.title, description: r.description ?? undefined, category: r.category ?? undefined, section: r.section ?? undefined })),
        newNodes.map(n => ({ code: n.refId, title: n.name ?? n.refId, description: n.description, category: n.category, section: n.section ?? n.category })),
    );

    // Load version history for strategy decisions
    const versionHistory = parseHistoryFromMetadata(existingMetadataJson);

    // Apply migration strategy (may modify the diff)
    const resolvedDiff = applyMigrationStrategy(diff, opts.strategy, versionHistory);

    let created = 0;
    let updated = 0;
    let deprecated = 0;

    // Create new requirements
    for (let i = 0; i < resolvedDiff.added.length; i++) {
        const req = resolvedDiff.added[i];
        await db.frameworkRequirement.create({
            data: {
                frameworkId,
                code: req.code,
                title: req.title,
                description: req.description,
                category: req.category,
                section: req.section ?? req.category,
                sortOrder: existingReqs.length + i,
            },
        });
        created++;
    }

    // Update changed requirements
    for (const change of resolvedDiff.changed) {
        const existing = existingReqs.find(r => r.code === change.code);
        if (!existing) continue;

        await db.frameworkRequirement.update({
            where: { id: existing.id },
            data: {
                title: change.newTitle,
                description: change.newDescription,
                category: change.newCategory,
                section: change.newSection ?? change.newCategory,
                deprecatedAt: null, // Un-deprecate if previously deprecated
            },
        });
        updated++;
    }

    // Deprecate removed requirements (soft delete)
    if (opts.deprecateMissing) {
        for (const removed of resolvedDiff.removed) {
            const existing = existingReqs.find(r => r.code === removed.code);
            if (!existing) continue;

            await db.frameworkRequirement.update({
                where: { id: existing.id },
                data: { deprecatedAt: new Date() },
            });
            deprecated++;
        }
    }

    return {
        urn: library.urn,
        frameworkKey: library.refId,
        version: library.version,
        action: 'updated',
        requirementsCreated: created,
        requirementsUpdated: updated,
        requirementsDeprecated: deprecated,
        contentHash: library.contentHash,
        durationMs: Math.round(performance.now() - startTime),
        addedCodes: resolvedDiff.added.map(r => r.code),
        // SUBSTANTIVE changes only — the ones that alter the obligation.
        //
        // `changedCodes` does not merely report; it DRIVES. A code listed here
        // makes `propagateDelta` fan a per-tenant delta out, and
        // `usecases/framework-delta.ts:163` sets every linked control to
        // NEEDS_REVIEW on the grounds that it "may no longer satisfy the
        // changed obligation". That is right for a reworded requirement and
        // wrong for a relabelled one: `computeRequirementDiff` also flags
        // `category` and `section`, which are GROUPING labels — they change
        // which heading a requirement appears under and nothing about what it
        // asks for.
        //
        // Found by pre-merge review of #2619, which gives 412 library
        // requirement nodes a real `section` (their chapter, instead of the
        // verification tier). Under the old rule the next `syncAllLibraries`
        // would have demoted every mapped, implemented ASVS and CIS v8 control
        // in every tenant to NEEDS_REVIEW, and notified them, for a heading
        // change. The new section is still WRITTEN (see the update above) —
        // it is only the re-review fan-out that a relabel no longer triggers.
        changedCodes: resolvedDiff.changed
            .filter(c => c.fields.some(f => f === 'title' || f === 'description'))
            .map(c => c.code),
        // Only codes actually deprecated (gated by deprecateMissing) count as removed.
        removedCodes: opts.deprecateMissing ? resolvedDiff.removed.map(r => r.code) : [],
    };
}
