/**
 * Requirement Mapping Repository
 *
 * Persistence layer for cross-framework requirement mappings.
 * Operates on RequirementMappingSet (framework pair groups) and
 * RequirementMapping (individual edges with strength semantics).
 *
 * Design decisions:
 * - No tenant scoping: mappings are global reference data (like frameworks).
 * - Upsert semantics on bulk operations: idempotent for YAML re-import.
 * - Includes denormalized framework/requirement info on reads to minimize N+1.
 * - Framework pair uniqueness on MappingSet: one canonical set per direction.
 */
import { PrismaTx } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { badRequest } from '@/lib/errors/types';
import type {
    CreateMappingSetInput,
    CreateMappingInput,
    MappingsBySourceQuery,
    MappingsByFrameworkPairQuery,
    MappingsByTargetQuery,
    BulkUpsertMappingInput,
    MappingStrengthValue,
    ResolvedMappingEdge,
} from '../domain/requirement-mapping.types';
import { MAPPING_STRENGTH_RANK, isValidMappingStrength } from '../domain/requirement-mapping.types';

// ─── Shared Includes ─────────────────────────────────────────────────

const MAPPING_INCLUDE = {
    sourceRequirement: {
        select: { id: true, code: true, title: true, frameworkId: true, framework: { select: { key: true, name: true } } },
    },
    targetRequirement: {
        select: { id: true, code: true, title: true, frameworkId: true, framework: { select: { key: true, name: true } } },
    },
} as const;

/**
 * Audit Coherence S9 (2026-05-24) — "currently active" temporal
 * predicate for RequirementMapping rows. A mapping is active at
 * `now` when `validFrom <= now AND (validTo IS NULL OR validTo > now)`.
 *
 * Applied to every traceability + gap-analysis read so historical /
 * superseded mappings don't pollute current reports. Auditors can
 * still query historical rows by passing `includeExpired: true`
 * on the relevant queries.
 */
export function activeMappingWindow(now: Date = new Date()) {
    return {
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
    };
}

/**
 * A mapping set with its frameworks and the count of its ACTIVE mappings.
 * Counted through `activeMappingWindow` like every other read, so a mapping the
 * importer retired is not advertised as available. A function, not a constant,
 * so `now` is the moment of the read rather than of module load.
 */
function mappingSetInclude() {
    return {
        sourceFramework: { select: { id: true, key: true, name: true } },
        targetFramework: { select: { id: true, key: true, name: true } },
        _count: { select: { mappings: { where: activeMappingWindow() } } },
    } as const;
}

// ─── Repository ──────────────────────────────────────────────────────

export class RequirementMappingRepository {
    // ═══════════════════════════════════════════════════════════════════
    // Mapping Sets
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Create a new mapping set for a framework pair.
     * Throws on duplicate (sourceFrameworkId, targetFrameworkId).
     */
    static async createMappingSet(db: PrismaTx, input: CreateMappingSetInput) {
        return db.requirementMappingSet.create({
            data: {
                sourceFrameworkId: input.sourceFrameworkId,
                targetFrameworkId: input.targetFrameworkId,
                name: input.name,
                description: input.description ?? null,
                version: input.version ?? 1,
                sourceUrn: input.sourceUrn ?? null,
                contentHash: input.contentHash ?? null,
            },
            include: mappingSetInclude(),
        });
    }

    /**
     * Upsert a mapping set: create if absent, update metadata if present.
     * Keyed on the unique (sourceFrameworkId, targetFrameworkId) pair.
     */
    static async upsertMappingSet(db: PrismaTx, input: CreateMappingSetInput) {
        return db.requirementMappingSet.upsert({
            where: {
                sourceFrameworkId_targetFrameworkId: {
                    sourceFrameworkId: input.sourceFrameworkId,
                    targetFrameworkId: input.targetFrameworkId,
                },
            },
            create: {
                sourceFrameworkId: input.sourceFrameworkId,
                targetFrameworkId: input.targetFrameworkId,
                name: input.name,
                description: input.description ?? null,
                version: input.version ?? 1,
                sourceUrn: input.sourceUrn ?? null,
                contentHash: input.contentHash ?? null,
            },
            update: {
                name: input.name,
                description: input.description ?? null,
                version: input.version ?? 1,
                sourceUrn: input.sourceUrn ?? null,
                contentHash: input.contentHash ?? null,
            },
            include: mappingSetInclude(),
        });
    }

    /** List all mapping sets with framework info and counts. */
    static async listMappingSets(db: PrismaTx) {
        return db.requirementMappingSet.findMany({
            orderBy: { createdAt: 'asc' },
            include: mappingSetInclude(),
        });
    }

    /** Get a mapping set by ID. */
    static async getMappingSetById(db: PrismaTx, id: string) {
        return db.requirementMappingSet.findUnique({
            where: { id },
            include: mappingSetInclude(),
        });
    }

    /** Get a mapping set by framework pair. */
    static async getMappingSetByFrameworkPair(
        db: PrismaTx,
        sourceFrameworkId: string,
        targetFrameworkId: string,
    ) {
        return db.requirementMappingSet.findUnique({
            where: {
                sourceFrameworkId_targetFrameworkId: {
                    sourceFrameworkId,
                    targetFrameworkId,
                },
            },
            include: mappingSetInclude(),
        });
    }

    /** Delete a mapping set and all its mappings (cascaded). */
    static async deleteMappingSet(db: PrismaTx, id: string) {
        return db.requirementMappingSet.delete({ where: { id } });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Individual Mappings
    // ═══════════════════════════════════════════════════════════════════

    /** Create a single mapping edge. */
    static async createMapping(db: PrismaTx, input: CreateMappingInput) {
        if (!isValidMappingStrength(input.strength)) {
            throw badRequest(`Invalid mapping strength: "${input.strength}". Must be one of: EQUAL, SUPERSET, SUBSET, INTERSECT, RELATED`);
        }
        return db.requirementMapping.create({
            data: {
                mappingSetId: input.mappingSetId,
                sourceRequirementId: input.sourceRequirementId,
                targetRequirementId: input.targetRequirementId,
                strength: input.strength,
                rationale: input.rationale ?? null,
                metadataJson: input.metadataJson ?? null,
            },
            include: MAPPING_INCLUDE,
        });
    }

    /** Get a mapping by ID. */
    static async getMappingById(db: PrismaTx, id: string) {
        return db.requirementMapping.findUnique({
            where: { id },
            include: MAPPING_INCLUDE,
        });
    }

    /**
     * Find all mappings originating from a specific source requirement.
     * Optionally filter by target framework and minimum strength.
     */
    static async findBySourceRequirement(
        db: PrismaTx,
        query: MappingsBySourceQuery,
    ) {
        const where: Prisma.RequirementMappingWhereInput = {
            sourceRequirementId: query.sourceRequirementId,
            // Audit Coherence S9 — exclude historical / superseded
            // mappings. Auditors querying the row directly still see
            // them.
            ...activeMappingWindow(),
        };

        if (query.targetFrameworkId) {
            where.targetRequirement = { frameworkId: query.targetFrameworkId };
        }

        if (query.minStrength) {
            const minRank = MAPPING_STRENGTH_RANK[query.minStrength];
            const validStrengths = Object.entries(MAPPING_STRENGTH_RANK)
                .filter(([, rank]) => rank >= minRank)
                .map(([strength]) => strength as MappingStrengthValue);
            where.strength = { in: validStrengths };
        }

        return db.requirementMapping.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            include: MAPPING_INCLUDE,
        });
    }

    /**
     * Find all mappings between two specific frameworks.
     * Optionally filter by minimum strength.
     */
    static async findByFrameworkPair(
        db: PrismaTx,
        query: MappingsByFrameworkPairQuery,
    ) {
        const where: Prisma.RequirementMappingWhereInput = {
            mappingSet: {
                sourceFrameworkId: query.sourceFrameworkId,
                targetFrameworkId: query.targetFrameworkId,
            },
            // Audit Coherence S9 — currently-active window.
            ...activeMappingWindow(),
        };

        if (query.minStrength) {
            const minRank = MAPPING_STRENGTH_RANK[query.minStrength];
            const validStrengths = Object.entries(MAPPING_STRENGTH_RANK)
                .filter(([, rank]) => rank >= minRank)
                .map(([strength]) => strength as MappingStrengthValue);
            where.strength = { in: validStrengths };
        }

        return db.requirementMapping.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            include: MAPPING_INCLUDE,
        });
    }

    /**
     * Find all mappings targeting a specific requirement (reverse direction).
     * Returns edges where the given requirement is the TARGET, enabling
     * reverse-direction traversal for gap analysis (target → source).
     *
     * Optionally filter by source framework and minimum strength.
     */
    static async findByTargetRequirement(
        db: PrismaTx,
        query: MappingsByTargetQuery,
    ) {
        const where: Prisma.RequirementMappingWhereInput = {
            targetRequirementId: query.targetRequirementId,
            // Audit Coherence S9 — currently-active window.
            ...activeMappingWindow(),
        };

        if (query.sourceFrameworkId) {
            where.sourceRequirement = { frameworkId: query.sourceFrameworkId };
        }

        if (query.minStrength) {
            const minRank = MAPPING_STRENGTH_RANK[query.minStrength];
            const validStrengths = Object.entries(MAPPING_STRENGTH_RANK)
                .filter(([, rank]) => rank >= minRank)
                .map(([strength]) => strength as MappingStrengthValue);
            where.strength = { in: validStrengths };
        }

        return db.requirementMapping.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            include: MAPPING_INCLUDE,
        });
    }

    /**
     * Resolve a mapping into a denormalized ResolvedMappingEdge.
     * Convenience method for converting raw Prisma results to domain DTOs.
     */
    static resolveEdge(
        raw: {
            id: string;
            strength: string;
            rationale: string | null;
            sourceRequirement: { id: string; code: string; title: string; frameworkId: string; framework: { key: string; name: string } };
            targetRequirement: { id: string; code: string; title: string; frameworkId: string; framework: { key: string; name: string } };
        },
    ): ResolvedMappingEdge {
        return {
            id: raw.id,
            strength: raw.strength as MappingStrengthValue,
            rationale: raw.rationale ?? null,
            source: {
                requirementId: raw.sourceRequirement.id,
                requirementCode: raw.sourceRequirement.code,
                requirementTitle: raw.sourceRequirement.title,
                frameworkId: raw.sourceRequirement.frameworkId,
                frameworkKey: raw.sourceRequirement.framework.key,
                frameworkName: raw.sourceRequirement.framework.name,
            },
            target: {
                requirementId: raw.targetRequirement.id,
                requirementCode: raw.targetRequirement.code,
                requirementTitle: raw.targetRequirement.title,
                frameworkId: raw.targetRequirement.frameworkId,
                frameworkKey: raw.targetRequirement.framework.key,
                frameworkName: raw.targetRequirement.framework.name,
            },
        };
    }

    /**
     * Bulk upsert mappings into an existing mapping set.
     * Uses upsert on the unique (mappingSetId, sourceRequirementId, targetRequirementId)
     * constraint for idempotent re-import from YAML.
     */
    static async bulkUpsertMappings(
        db: PrismaTx,
        mappingSetId: string,
        inputs: BulkUpsertMappingInput[],
    ) {
        const results = [];
        for (const input of inputs) {
            if (!isValidMappingStrength(input.strength)) {
                throw badRequest(`Invalid mapping strength: "${input.strength}"`);
            }
            const result = await db.requirementMapping.upsert({
                where: {
                    mappingSetId_sourceRequirementId_targetRequirementId: {
                        mappingSetId,
                        sourceRequirementId: input.sourceRequirementId,
                        targetRequirementId: input.targetRequirementId,
                    },
                },
                create: {
                    mappingSetId,
                    sourceRequirementId: input.sourceRequirementId,
                    targetRequirementId: input.targetRequirementId,
                    strength: input.strength,
                    rationale: input.rationale ?? null,
                    metadataJson: input.metadataJson ?? null,
                },
                update: {
                    strength: input.strength,
                    rationale: input.rationale ?? null,
                    metadataJson: input.metadataJson ?? null,
                },
            });
            results.push(result);
        }
        return results;
    }

    /** Count mappings in a given set. */
    static async countMappings(db: PrismaTx, mappingSetId: string) {
        return db.requirementMapping.count({ where: { mappingSetId } });
    }

    /** Delete a single mapping by ID. */
    static async deleteMapping(db: PrismaTx, id: string) {
        return db.requirementMapping.delete({ where: { id } });
    }

    /** Delete all mappings in a set (without deleting the set). */
    static async clearMappings(db: PrismaTx, mappingSetId: string) {
        return db.requirementMapping.deleteMany({ where: { mappingSetId } });
    }
}
