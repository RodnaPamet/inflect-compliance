/**
 * Mapping Set YAML Schema & Importer
 *
 * Defines the canonical schema for standalone mapping-set YAML files and
 * provides the ingestion pipeline for loading them into the RequirementMapping
 * domain model.
 *
 * Architecture:
 * ─────────────
 *   mapping-set.yaml → StoredMappingSet (Zod-validated)
 *                     → resolve requirement refs against DB
 *                     → upsert RequirementMappingSet + RequirementMapping rows
 *
 * Mapping-set files live in src/data/libraries/mappings/ and are separate
 * from framework library files. They reference framework requirements by
 * (framework_ref_id, requirement_code) pairs — the importer resolves these
 * to database IDs via the FrameworkRequirement table.
 *
 * Design decisions:
 * - Ref-based identifiers (not URNs) for YAML ergonomics and readability.
 * - Importer resolves refs to DB IDs — fail-fast on broken references.
 * - Content hash for deduplication — skip re-import if nothing changed.
 * - Cascading upsert: set-level upsert + mapping-level upsert for idempotency.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { MappingStrengthSchema } from '../libraries/schemas';
import { RequirementMappingRepository } from '../repositories/RequirementMappingRepository';
import { isValidMappingStrength } from '../domain/requirement-mapping.types';
import type { PrismaTx } from '@/lib/db-context';
import type { MappingStrengthValue } from '../domain/requirement-mapping.types';
import { logger } from '@/lib/observability/logger';
import { canonicalJson } from '@/lib/canonical-json';

// ─── YAML Schema ─────────────────────────────────────────────────────

/**
 * Schema for a single mapping entry in a mapping-set YAML file.
 *
 * Uses requirement `code` (e.g., "A.5.1") rather than URNs for readability.
 * The importer resolves these to database FrameworkRequirement IDs.
 */
export const MappingSetEntrySchema = z.object({
    /** Requirement code in the source framework (e.g., "A.5.1") */
    source_ref: z.string().min(1),
    /** Requirement code in the target framework (e.g., "GV.OC-01") */
    target_ref: z.string().min(1),
    /** Mapping strength: EQUAL | SUPERSET | SUBSET | INTERSECT | RELATED */
    strength: MappingStrengthSchema.default('RELATED'),
    /** Human-readable rationale for this mapping */
    rationale: z.string().optional(),
});

export type MappingSetEntry = z.infer<typeof MappingSetEntrySchema>;

/**
 * Schema for a standalone mapping-set YAML file.
 *
 * Each file defines all mappings between exactly one framework pair.
 */
export const StoredMappingSetSchema = z.object({
    /** Globally unique URN for this mapping set */
    urn: z.string().min(1),
    /** Display name */
    name: z.string().min(1),
    /** Description of what this mapping set covers */
    description: z.string().optional(),
    /** Monotonically increasing version integer */
    version: z.number().int().min(1).default(1),
    /** Framework ref_id of the SOURCE framework (must exist in DB) */
    source_framework_ref: z.string().min(1),
    /** Framework ref_id of the TARGET framework (must exist in DB) */
    target_framework_ref: z.string().min(1),
    /** Array of mapping entries */
    mapping_entries: z.array(MappingSetEntrySchema).min(1),
});

export type StoredMappingSet = z.infer<typeof StoredMappingSetSchema>;

// ─── Error Types ─────────────────────────────────────────────────────

export class MappingSetParseError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly details: string,
        public readonly cause?: unknown,
    ) {
        super(`Failed to parse mapping set "${filePath}": ${details}`);
        this.name = 'MappingSetParseError';
    }
}

export class MappingSetValidationError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly issues: Array<{ path: string; message: string }>,
    ) {
        const summary = issues.map(i => `  - ${i.path}: ${i.message}`).join('\n');
        super(`Mapping set validation failed for "${filePath}":\n${summary}`);
        this.name = 'MappingSetValidationError';
    }
}

export class MappingSetReferenceError extends Error {
    constructor(
        public readonly filePath: string,
        public readonly unresolvedRefs: Array<{ field: string; ref: string; frameworkRef: string }>,
    ) {
        const summary = unresolvedRefs.map(r =>
            `  - ${r.field}: "${r.ref}" not found in framework "${r.frameworkRef}"`
        ).join('\n');
        super(`Unresolved requirement references in "${filePath}":\n${summary}`);
        this.name = 'MappingSetReferenceError';
    }
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a mapping-set YAML file from disk.
 *
 * @throws MappingSetParseError if YAML parsing fails
 * @throws MappingSetValidationError if Zod schema validation fails
 */
export function parseMappingSetFile(filePath: string): StoredMappingSet {
    let rawContent: string;
    try {
        rawContent = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        throw new MappingSetParseError(filePath, 'Failed to read file', err);
    }

    return parseMappingSetString(rawContent, filePath);
}

/**
 * Parse a mapping-set YAML string (for testing).
 */
export function parseMappingSetString(content: string, sourceName: string = '<string>'): StoredMappingSet {
    let rawData: unknown;
    try {
        rawData = yaml.load(content);
    } catch (err) {
        throw new MappingSetParseError(sourceName, 'Invalid YAML syntax', err);
    }

    if (!rawData || typeof rawData !== 'object') {
        throw new MappingSetParseError(sourceName, 'YAML content is not an object');
    }

    const result = StoredMappingSetSchema.safeParse(rawData);
    if (!result.success) {
        const issues = result.error.issues.map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
        }));
        throw new MappingSetValidationError(sourceName, issues);
    }

    return result.data;
}

// ─── Content Hash ────────────────────────────────────────────────────

/**
 * Compute a content hash for deduplication: SHA-256 over the canonical JSON
 * of the whole parsed set, the name, the description and every entry's
 * rationale included.
 *
 * It covered only the urn, the version, the framework refs and each entry's
 * source, target and strength until 2026-10-24, so a reworded rationale under
 * the same version was skipped by every database already holding the set.
 * Unlike a library, a mapping set records no version diff and notifies
 * nobody, so there is nothing a version bump would keep straight, and the
 * text belongs in the hash.
 */
export function computeMappingSetHash(stored: StoredMappingSet): string {
    return crypto.createHash('sha256').update(canonicalJson(stored)).digest('hex');
}

// ─── Directory Scanner ───────────────────────────────────────────────

const MAPPINGS_DIR = path.resolve(__dirname, '../../data/libraries/mappings');

/**
 * Scan the mappings directory for .yaml/.yml mapping-set files.
 * Returns parsed StoredMappingSets (validated but not yet imported).
 */
export function scanMappingSetDirectory(dirPath: string = MAPPINGS_DIR): Array<{
    stored: StoredMappingSet;
    filePath: string;
    contentHash: string;
}> {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    const files = fs.readdirSync(dirPath).filter(f => /\.ya?ml$/i.test(f));
    const results: Array<{ stored: StoredMappingSet; filePath: string; contentHash: string }> = [];

    for (const file of files) {
        const fullPath = path.join(dirPath, file);
        try {
            const stored = parseMappingSetFile(fullPath);
            results.push({
                stored,
                filePath: fullPath,
                contentHash: computeMappingSetHash(stored),
            });
        } catch (err) {
            logger.warn('Skipping invalid mapping set file', {
                component: 'mapping-set-importer',
                file,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return results;
}

// ─── Importer ────────────────────────────────────────────────────────

export interface ImportMappingSetResult {
    readonly mappingSetId: string;
    readonly name: string;
    readonly sourceFrameworkRef: string;
    readonly targetFrameworkRef: string;
    readonly created: number;
    readonly updated: number;
    readonly skippedDuplicate: boolean;
    readonly errors: Array<{ entry: number; sourceRef: string; targetRef: string; message: string }>;
}

/**
 * Import a single mapping-set YAML into the database.
 *
 * Flow:
 * 1. Resolve source and target framework by ref_id (key)
 * 2. Check content hash for deduplication
 * 3. Upsert RequirementMappingSet
 * 4. Resolve each entry's source/target requirement refs to DB IDs
 * 5. Bulk upsert RequirementMapping records
 *
 * Returns a detailed result including any entries that failed reference resolution.
 *
 * @throws MappingSetReferenceError if source or target framework not found
 */
export async function importMappingSet(
    db: PrismaTx,
    stored: StoredMappingSet,
    contentHash: string,
    options: { force?: boolean } = {},
): Promise<ImportMappingSetResult> {
    const component = 'mapping-set-importer';

    // 1. Resolve source and target frameworks
    const sourceFramework = await db.framework.findFirst({
        where: { key: stored.source_framework_ref },
        select: { id: true, key: true },
    });
    if (!sourceFramework) {
        throw new MappingSetReferenceError('<import>', [{
            field: 'source_framework_ref',
            ref: stored.source_framework_ref,
            frameworkRef: stored.source_framework_ref,
        }]);
    }

    const targetFramework = await db.framework.findFirst({
        where: { key: stored.target_framework_ref },
        select: { id: true, key: true },
    });
    if (!targetFramework) {
        throw new MappingSetReferenceError('<import>', [{
            field: 'target_framework_ref',
            ref: stored.target_framework_ref,
            frameworkRef: stored.target_framework_ref,
        }]);
    }

    // 2. Check content hash (skip if unchanged, unless forced)
    if (!options.force) {
        const existing = await RequirementMappingRepository.getMappingSetByFrameworkPair(
            db, sourceFramework.id, targetFramework.id,
        );
        if (existing && existing.contentHash === contentHash) {
            logger.info('Mapping set unchanged (hash match), skipping import', {
                component,
                urn: stored.urn,
                hash: contentHash.slice(0, 12),
            });
            return {
                mappingSetId: existing.id,
                name: stored.name,
                sourceFrameworkRef: stored.source_framework_ref,
                targetFrameworkRef: stored.target_framework_ref,
                created: 0,
                updated: 0,
                skippedDuplicate: true,
                errors: [],
            };
        }
    }

    // 3. Upsert the mapping set
    const mappingSet = await RequirementMappingRepository.upsertMappingSet(db, {
        sourceFrameworkId: sourceFramework.id,
        targetFrameworkId: targetFramework.id,
        name: stored.name,
        description: stored.description ?? null,
        version: stored.version,
        sourceUrn: stored.urn,
        contentHash,
    });

    // 4. Build requirement lookup maps for source and target frameworks
    const sourceReqs = await db.frameworkRequirement.findMany({
        where: { frameworkId: sourceFramework.id },
        select: { id: true, code: true },
    });
    const targetReqs = await db.frameworkRequirement.findMany({
        where: { frameworkId: targetFramework.id },
        select: { id: true, code: true },
    });

    const sourceMap = new Map(sourceReqs.map(r => [r.code, r.id]));
    const targetMap = new Map(targetReqs.map(r => [r.code, r.id]));

    // 5. Validate all entries first, then batch upsert
    // This eliminates N+1 queries: instead of (findUnique + upsert) per entry,
    // we do a single bulk query for existing mappings then batch upsert.
    const errors: ImportMappingSetResult['errors'] = [];
    const validEntries: Array<{
        sourceId: string;
        targetId: string;
        strength: MappingStrengthValue;
        rationale: string | null;
    }> = [];

    for (let i = 0; i < stored.mapping_entries.length; i++) {
        const entry = stored.mapping_entries[i];
        const sourceId = sourceMap.get(entry.source_ref);
        const targetId = targetMap.get(entry.target_ref);

        if (!sourceId) {
            errors.push({
                entry: i,
                sourceRef: entry.source_ref,
                targetRef: entry.target_ref,
                message: `Source requirement "${entry.source_ref}" not found in framework "${stored.source_framework_ref}"`,
            });
            continue;
        }

        if (!targetId) {
            errors.push({
                entry: i,
                sourceRef: entry.source_ref,
                targetRef: entry.target_ref,
                message: `Target requirement "${entry.target_ref}" not found in framework "${stored.target_framework_ref}"`,
            });
            continue;
        }

        if (!isValidMappingStrength(entry.strength)) {
            errors.push({
                entry: i,
                sourceRef: entry.source_ref,
                targetRef: entry.target_ref,
                message: `Invalid strength "${entry.strength}"`,
            });
            continue;
        }

        validEntries.push({
            sourceId,
            targetId,
            strength: entry.strength as MappingStrengthValue,
            rationale: entry.rationale ?? null,
        });
    }

    // Bulk-load existing mappings for this set (1 query instead of N)
    const existingMappings = await db.requirementMapping.findMany({
        where: { mappingSetId: mappingSet.id },
        select: { sourceRequirementId: true, targetRequirementId: true },
    });
    const existingKeys = new Set(
        existingMappings.map(m => `${m.sourceRequirementId}::${m.targetRequirementId}`),
    );

    // Batch upsert all valid entries
    let created = 0;
    let updated = 0;

    for (const entry of validEntries) {
        const key = `${entry.sourceId}::${entry.targetId}`;
        await db.requirementMapping.upsert({
            where: {
                mappingSetId_sourceRequirementId_targetRequirementId: {
                    mappingSetId: mappingSet.id,
                    sourceRequirementId: entry.sourceId,
                    targetRequirementId: entry.targetId,
                },
            },
            create: {
                mappingSetId: mappingSet.id,
                sourceRequirementId: entry.sourceId,
                targetRequirementId: entry.targetId,
                strength: entry.strength,
                rationale: entry.rationale,
            },
            update: {
                strength: entry.strength,
                rationale: entry.rationale,
            },
        });

        if (existingKeys.has(key)) {
            updated++;
        } else {
            created++;
        }
    }

    logger.info('Mapping set imported', {
        component,
        urn: stored.urn,
        setId: mappingSet.id,
        created,
        updated,
        errors: errors.length,
        total: stored.mapping_entries.length,
    });

    return {
        mappingSetId: mappingSet.id,
        name: stored.name,
        sourceFrameworkRef: stored.source_framework_ref,
        targetFrameworkRef: stored.target_framework_ref,
        created,
        updated,
        skippedDuplicate: false,
        errors,
    };
}

/**
 * Import all mapping-set YAML files from the mappings directory.
 * Scans, validates, and imports each file.
 */
export async function importAllMappingSets(
    db: PrismaTx,
    dirPath: string = MAPPINGS_DIR,
    options: { force?: boolean } = {},
): Promise<ImportMappingSetResult[]> {
    const scanned = scanMappingSetDirectory(dirPath);
    const results: ImportMappingSetResult[] = [];

    for (const { stored, contentHash } of scanned) {
        try {
            const result = await importMappingSet(db, stored, contentHash, options);
            results.push(result);
        } catch (err) {
            logger.error('Failed to import mapping set', {
                component: 'mapping-set-importer',
                urn: stored.urn,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return results;
}
