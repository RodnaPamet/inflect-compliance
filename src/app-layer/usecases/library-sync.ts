/**
 * Library Sync Usecase — Controlled execution paths for library import/update.
 *
 * Provides high-level orchestration functions that can be called by:
 * - Scripts/CLI commands
 * - Admin API routes
 * - Seed processes
 *
 * All paths use the library-importer under the hood and follow
 * the project's job-runner pattern for structured observability.
 *
 * Lifecycle order (critical for referential integrity):
 * 1. Framework libraries imported first (creates Framework + FrameworkRequirement rows)
 * 2. Mapping sets imported second (references FrameworkRequirement rows by code)
 *
 * Mapping-set import failures are isolated — they don't block framework sync
 * but are reported clearly in the sync result.
 */
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { notFound } from '@/lib/errors/types';
import {
    importLibrary,
    importAllFromDirectory,
    type ImportResult,
    type ImportOptions,
} from '../services/library-importer';
import {
    importAllMappingSets,
    type ImportMappingSetResult,
} from '../services/mapping-set-importer';
import {
    scanLibraryDirectory,
    parseLibraryFile,
    loadLibrary,
    loadAllFromDirectory,
} from '../libraries';

// ─── Path Constants ──────────────────────────────────────────────────

/** Default path to the YAML library directory. */
export const LIBRARIES_DIR = path.resolve(__dirname, '../../data/libraries');

// ─── Sync Results ────────────────────────────────────────────────────

export interface SyncResult {
    /** Total libraries found on disk */
    totalFound: number;
    /** Results per library */
    results: ImportResult[];
    /** Summary counts */
    summary: {
        created: number;
        updated: number;
        skipped: number;
        failed: number;
    };
    /** Mapping set import results (runs after framework import) */
    mappingSets: {
        /** Per-set results */
        results: ImportMappingSetResult[];
        /** Summary */
        summary: {
            imported: number;
            skipped: number;
            failed: number;
            totalEntries: number;
            /** Active mappings retired because their entry left its file. */
            retired: number;
        };
    };
    /** Total duration in ms */
    totalDurationMs: number;
}

// ─── Sync All Libraries ──────────────────────────────────────────────

export type SyncOptions = ImportOptions & {
    skipMappings?: boolean;
    /** Defaults to `LIBRARIES_DIR`. A bundled caller must pass it: see `syncLibrariesAtStartup`. */
    librariesDir?: string;
    /** Defaults to the mapping importer's `MAPPINGS_DIR`. */
    mappingsDir?: string;
    /** Framework keys whose row another writer owns; their libraries are not imported. */
    skipFrameworkKeys?: ReadonlySet<string>;
};

/**
 * Synchronize all YAML libraries from the default directory into Prisma,
 * then import cross-framework mapping sets.
 *
 * This is the primary entry point for library management. It:
 * 1. Scans the libraries directory for YAML files
 * 2. Parses and validates each file
 * 3. Compares against DB state (hash-based deduplication)
 * 4. Upserts changed/new libraries
 * 5. Skips unchanged libraries
 * 6. Imports mapping sets (after frameworks exist, for referential integrity)
 *
 * Mapping-set import failures are isolated: they are logged and reported
 * but do not block or roll back framework import.
 *
 * Wrapped in `runJob` for structured observability.
 */
export async function syncAllLibraries(
    db: PrismaClient,
    options?: SyncOptions,
): Promise<SyncResult> {
    return runJob('library-sync-all', async () => {
        const start = performance.now();
        const component = 'library-sync';
        const librariesDir = options?.librariesDir ?? LIBRARIES_DIR;

        // ── Phase 1: Framework Libraries ──────────────────────────
        // Must complete before mapping sets — mappings reference
        // FrameworkRequirement rows created by framework import.
        logger.info('Sync started — phase 1: frameworks', { component, dir: librariesDir });

        const results = await importAllFromDirectory(db, librariesDir, options, options?.skipFrameworkKeys);

        const summary = {
            created: results.filter(r => r.action === 'created').length,
            updated: results.filter(r => r.action === 'updated').length,
            skipped: results.filter(r => r.action === 'skipped').length,
            failed: 0, // Failures throw, so this is 0 if we reach here
        };

        logger.info('Phase 1 complete — frameworks synced', {
            component,
            totalFound: results.length,
            ...summary,
        });

        // ── Phase 2: Mapping Sets ─────────────────────────────────
        // Isolated: failures are caught, logged, and reported but do
        // not roll back framework changes.
        let mappingSetResults: ImportMappingSetResult[] = [];
        const mappingSummary = { imported: 0, skipped: 0, failed: 0, totalEntries: 0, retired: 0 };

        if (!options?.skipMappings) {
            logger.info('Sync phase 2: mapping sets', { component });

            try {
                mappingSetResults = await importAllMappingSets(
                    db,
                    options?.mappingsDir, // undefined: the importer's default MAPPINGS_DIR
                    { force: options?.force },
                );

                for (const r of mappingSetResults) {
                    if (r.skippedDuplicate) {
                        mappingSummary.skipped++;
                    } else {
                        mappingSummary.imported++;
                    }
                    mappingSummary.totalEntries += r.created + r.updated;
                    mappingSummary.retired += r.retired;
                    if (r.errors.length > 0) {
                        mappingSummary.failed += r.errors.length;
                    }
                }

                logger.info('Phase 2 complete — mapping sets synced', {
                    component,
                    sets: mappingSetResults.length,
                    ...mappingSummary,
                });
            } catch (err) {
                // Mapping failure is isolated — log and continue
                logger.error('Phase 2 failed — mapping set import error', {
                    component,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        } else {
            logger.info('Phase 2 skipped — skipMappings=true', { component });
        }

        const totalDurationMs = Math.round(performance.now() - start);

        logger.info('Sync completed', {
            component,
            totalFound: results.length,
            ...summary,
            mappingSets: mappingSetResults.length,
            totalDurationMs,
        });

        return {
            totalFound: results.length,
            results,
            summary,
            mappingSets: {
                results: mappingSetResults,
                summary: mappingSummary,
            },
            totalDurationMs,
        };
    });
}

// ─── Container Start ─────────────────────────────────────────────────

/**
 * What `scripts/sync-framework-libraries.ts` runs at every container start,
 * after the catalogue seeder.
 *
 * Until this existed nothing in a deployed environment called
 * `syncAllLibraries`, so no library row and no mapping set reached one. The
 * crosswalks, and every surface that reads them (inherited coverage, gap
 * analysis, traceability), worked in tests and on databases somebody had
 * synced by hand.
 *
 * A ROW WITH A PACK IS THE CATALOGUE'S, AND THIS LEAVES IT ALONE. Two
 * libraries (`AIUC-1`, `COSO-ICF-2013`) declare the same framework key as
 * their catalogue fixture, so both writers would write one row. They do not
 * agree on it: COSO's 17 library descriptions are long-form and its fixture
 * summaries are short, and the two write different `version` and
 * `metadataJson` values. Importing over the catalogue's row rewrites all of
 * that until the next start puts the catalogue's back. Worse comes later.
 * COSO's fixture carries no metadata, so the version history the importer
 * keeps in `metadataJson` survives there. On the next COSO library version,
 * the importer would diff against the catalogue's summaries, record all 17 as
 * changed, and mark every linked control NEEDS_REVIEW in every tenant holding
 * one. The library importer never creates a pack, so "has a pack" separates
 * the two writers without a list, and a library that later gains a catalogue
 * fixture drops out of this sync by itself.
 *
 * The directories are passed explicitly because `LIBRARIES_DIR` and the
 * mapping importer's `MAPPINGS_DIR` resolve from `__dirname`, which in a
 * bundled script is `dist/`. They resolve from the working directory instead,
 * which is `/app` in the image (the Dockerfile copies `src/data/libraries`
 * there) and the repo root in a checkout.
 */
export async function syncLibrariesAtStartup(
    db: PrismaClient,
    dirs: { librariesDir: string; mappingsDir: string },
): Promise<SyncResult & { catalogueOwnedKeys: string[] }> {
    // Unbounded on purpose: a truncated read would hand an owned row to the
    // library importer. The global catalogue is a few dozen rows.
    const owned = await db.framework.findMany({
        where: { packs: { some: {} } },
        select: { key: true },
    });
    const catalogueOwnedKeys = owned.map((f) => f.key).sort();
    const result = await syncAllLibraries(db, {
        ...dirs,
        skipFrameworkKeys: new Set(catalogueOwnedKeys),
    });
    return { ...result, catalogueOwnedKeys };
}

/**
 * Synchronize a single library by its file path.
 *
 * Use this when you want to import/update a specific framework
 * without scanning the entire directory.
 */
export async function syncLibraryByFile(
    db: PrismaClient,
    filePath: string,
    options?: ImportOptions,
): Promise<ImportResult> {
    return runJob('library-sync-one', async () => {
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);
        return importLibrary(db, loaded, options);
    });
}

/**
 * Synchronize a single library by its URN.
 * Scans the library directory to find the file matching the URN.
 */
export async function syncLibraryByUrn(
    db: PrismaClient,
    urn: string,
    options?: ImportOptions,
): Promise<ImportResult> {
    return runJob('library-sync-urn', async () => {
        const entries = scanLibraryDirectory(LIBRARIES_DIR);
        const entry = entries.find(e => e.urn === urn);
        if (!entry) {
            throw notFound(`Library with URN "${urn}" not found in ${LIBRARIES_DIR}`);
        }
        const stored = parseLibraryFile(entry.filePath);
        const loaded = loadLibrary(stored, entry.filePath);
        return importLibrary(db, loaded, options);
    });
}

// ─── Preview/Dry-Run ─────────────────────────────────────────────────

/**
 * Preview what would happen if libraries were synced.
 * Returns diff information without performing any writes.
 */
export async function previewSync(
    db: PrismaClient,
): Promise<Array<{
    urn: string;
    name: string;
    key: string;
    version: number;
    action: 'would-create' | 'would-update' | 'up-to-date';
    currentHash?: string;
    newHash: string;
}>> {
    const loaded = loadAllFromDirectory(LIBRARIES_DIR);
    const previews: Array<{
        urn: string;
        name: string;
        key: string;
        version: number;
        action: 'would-create' | 'would-update' | 'up-to-date';
        currentHash?: string;
        newHash: string;
    }> = [];

    for (const [, lib] of loaded) {
        const existing = await db.framework.findFirst({
            where: { key: lib.refId },
        });

        let action: 'would-create' | 'would-update' | 'up-to-date';
        if (!existing) {
            action = 'would-create';
        } else if (existing.contentHash !== lib.contentHash) {
            action = 'would-update';
        } else {
            action = 'up-to-date';
        }

        previews.push({
            urn: lib.urn,
            name: lib.name,
            key: lib.refId,
            version: lib.version,
            action,
            currentHash: existing?.contentHash ?? undefined,
            newHash: lib.contentHash,
        });
    }

    return previews;
}
