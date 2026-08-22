/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Requirement Mapping Domain Tests
 *
 * Tests the RequirementMapping domain model and repository layer:
 * - Mapping strength enum semantics and validation
 * - Mapping set CRUD (create, upsert, list, get by framework pair)
 * - Individual mapping persistence (create, read, delete)
 * - Mapping lookup by source requirement
 * - Mapping lookup by framework pair
 * - Strength threshold filtering
 * - Bulk upsert idempotency
 * - Resolved edge projection
 * - Clearance and cascade
 */

import { RequirementMappingRepository } from '@/app-layer/repositories/RequirementMappingRepository';
import {
    MAPPING_STRENGTHS,
    MAPPING_STRENGTH_RANK,
    isValidMappingStrength,
    type MappingStrengthValue,
    type CreateMappingSetInput,
    type CreateMappingInput,
    type MappingsBySourceQuery,
    type MappingsByFrameworkPairQuery,
    type BulkUpsertMappingInput,
} from '@/app-layer/domain/requirement-mapping.types';

// ─── Mock Setup ──────────────────────────────────────────────────────

// We mock the PrismaTx methods at the repository boundary.
// This validates repository logic without requiring a running database.

function createMockDb() {
    return {
        requirementMappingSet: {
            create: jest.fn(),
            upsert: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            delete: jest.fn(),
        },
        requirementMapping: {
            create: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            upsert: jest.fn(),
            count: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn(),
        },
    } as any;
}

// ─── Fixtures ────────────────────────────────────────────────────────

const FRAMEWORK_ISO = { id: 'fw-iso', key: 'ISO27001', name: 'ISO 27001:2022' };
const FRAMEWORK_NIST = { id: 'fw-nist', key: 'NIST-CSF', name: 'NIST CSF 2.0' };

const REQ_ISO_A5_1 = {
    id: 'req-iso-a51',
    code: 'A.5.1',
    title: 'Policies for information security',
    frameworkId: FRAMEWORK_ISO.id,
    framework: { key: FRAMEWORK_ISO.key, name: FRAMEWORK_ISO.name },
};

const REQ_ISO_A5_2 = {
    id: 'req-iso-a52',
    code: 'A.5.2',
    title: 'Information security roles and responsibilities',
    frameworkId: FRAMEWORK_ISO.id,
    framework: { key: FRAMEWORK_ISO.key, name: FRAMEWORK_ISO.name },
};

const REQ_NIST_GV_OC_01 = {
    id: 'req-nist-gv01',
    code: 'GV.OC-01',
    title: 'Organizational Context',
    frameworkId: FRAMEWORK_NIST.id,
    framework: { key: FRAMEWORK_NIST.key, name: FRAMEWORK_NIST.name },
};

const REQ_NIST_GV_OC_02 = {
    id: 'req-nist-gv02',
    code: 'GV.OC-02',
    title: 'Internal Stakeholders',
    frameworkId: FRAMEWORK_NIST.id,
    framework: { key: FRAMEWORK_NIST.key, name: FRAMEWORK_NIST.name },
};

const MAPPING_SET_FIXTURE = {
    id: 'ms-iso-nist',
    sourceFrameworkId: FRAMEWORK_ISO.id,
    targetFrameworkId: FRAMEWORK_NIST.id,
    name: 'ISO 27001 → NIST CSF',
    description: 'Cross-walk between ISO 27001:2022 and NIST CSF 2.0',
    version: 1,
    sourceUrn: 'urn:inflect:mapping:iso27001-to-nist-csf',
    contentHash: 'abc123',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    sourceFramework: { id: FRAMEWORK_ISO.id, key: FRAMEWORK_ISO.key, name: FRAMEWORK_ISO.name },
    targetFramework: { id: FRAMEWORK_NIST.id, key: FRAMEWORK_NIST.key, name: FRAMEWORK_NIST.name },
    _count: { mappings: 2 },
};

const MAPPING_FIXTURE_EQUAL = {
    id: 'map-1',
    mappingSetId: 'ms-iso-nist',
    sourceRequirementId: REQ_ISO_A5_1.id,
    targetRequirementId: REQ_NIST_GV_OC_01.id,
    strength: 'EQUAL' as MappingStrengthValue,
    rationale: 'Both address organizational security policy governance',
    metadataJson: null,
    createdAt: new Date('2026-01-01'),
    sourceRequirement: REQ_ISO_A5_1,
    targetRequirement: REQ_NIST_GV_OC_01,
};

const MAPPING_FIXTURE_SUBSET = {
    id: 'map-2',
    mappingSetId: 'ms-iso-nist',
    sourceRequirementId: REQ_ISO_A5_2.id,
    targetRequirementId: REQ_NIST_GV_OC_02.id,
    strength: 'SUBSET' as MappingStrengthValue,
    rationale: 'ISO A.5.2 partially covers NIST GV.OC-02 stakeholder requirements',
    metadataJson: JSON.stringify({ source: 'yaml-import', importedAt: '2026-01-01' }),
    createdAt: new Date('2026-01-01'),
    sourceRequirement: REQ_ISO_A5_2,
    targetRequirement: REQ_NIST_GV_OC_02,
};

// ═════════════════════════════════════════════════════════════════════
// Test Suites
// ═════════════════════════════════════════════════════════════════════

describe('RequirementMapping Domain', () => {
    // ─── Mapping Strength Semantics ──────────────────────────────────
    describe('MappingStrength enum', () => {
        it('defines exactly 5 strength values', () => {
            // LITERAL ON PURPOSE — do not derive. MappingStrength is a closed
            // set-relation vocabulary (the ranks below assume exactly these
            // five, strictly ordered); a sixth strength is a modelling
            // decision, not an array append.
            expect(MAPPING_STRENGTHS).toHaveLength(5);
            expect(MAPPING_STRENGTHS).toEqual(['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED']);
        });

        it('assigns monotonically decreasing rank from EQUAL to RELATED', () => {
            expect(MAPPING_STRENGTH_RANK.EQUAL).toBe(5);
            expect(MAPPING_STRENGTH_RANK.SUPERSET).toBe(4);
            expect(MAPPING_STRENGTH_RANK.SUBSET).toBe(3);
            expect(MAPPING_STRENGTH_RANK.INTERSECT).toBe(2);
            expect(MAPPING_STRENGTH_RANK.RELATED).toBe(1);

            // Verify monotonicity
            for (let i = 1; i < MAPPING_STRENGTHS.length; i++) {
                const prev = MAPPING_STRENGTH_RANK[MAPPING_STRENGTHS[i - 1]];
                const curr = MAPPING_STRENGTH_RANK[MAPPING_STRENGTHS[i]];
                expect(prev).toBeGreaterThan(curr);
            }
        });

        it('validates known strength values as valid', () => {
            for (const s of MAPPING_STRENGTHS) {
                expect(isValidMappingStrength(s)).toBe(true);
            }
        });

        it('rejects unknown strength values', () => {
            expect(isValidMappingStrength('UNKNOWN')).toBe(false);
            expect(isValidMappingStrength('')).toBe(false);
            expect(isValidMappingStrength('equal')).toBe(false); // case-sensitive
            expect(isValidMappingStrength('PARTIAL')).toBe(false);
        });
    });

    // ─── Mapping Set CRUD ────────────────────────────────────────────
    describe('MappingSet operations', () => {
        let db: ReturnType<typeof createMockDb>;

        beforeEach(() => {
            db = createMockDb();
        });

        it('creates a mapping set with framework pair', async () => {
            db.requirementMappingSet.create.mockResolvedValue(MAPPING_SET_FIXTURE);

            const input: CreateMappingSetInput = {
                sourceFrameworkId: FRAMEWORK_ISO.id,
                targetFrameworkId: FRAMEWORK_NIST.id,
                name: 'ISO 27001 → NIST CSF',
                description: 'Cross-walk between ISO 27001:2022 and NIST CSF 2.0',
                sourceUrn: 'urn:inflect:mapping:iso27001-to-nist-csf',
                contentHash: 'abc123',
            };

            const result = await RequirementMappingRepository.createMappingSet(db, input);

            expect(result.id).toBe('ms-iso-nist');
            expect(result.sourceFramework?.key).toBe('ISO27001');
            expect(result.targetFramework?.key).toBe('NIST-CSF');
            expect(db.requirementMappingSet.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        sourceFrameworkId: FRAMEWORK_ISO.id,
                        targetFrameworkId: FRAMEWORK_NIST.id,
                        name: 'ISO 27001 → NIST CSF',
                    }),
                }),
            );
        });

        it('upserts a mapping set (create path)', async () => {
            db.requirementMappingSet.upsert.mockResolvedValue(MAPPING_SET_FIXTURE);

            const input: CreateMappingSetInput = {
                sourceFrameworkId: FRAMEWORK_ISO.id,
                targetFrameworkId: FRAMEWORK_NIST.id,
                name: 'ISO 27001 → NIST CSF',
            };

            const result = await RequirementMappingRepository.upsertMappingSet(db, input);

            expect(result.id).toBe('ms-iso-nist');
            expect(db.requirementMappingSet.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        sourceFrameworkId_targetFrameworkId: {
                            sourceFrameworkId: FRAMEWORK_ISO.id,
                            targetFrameworkId: FRAMEWORK_NIST.id,
                        },
                    },
                }),
            );
        });

        it('lists all mapping sets with framework info', async () => {
            db.requirementMappingSet.findMany.mockResolvedValue([MAPPING_SET_FIXTURE]);

            const result = await RequirementMappingRepository.listMappingSets(db);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('ISO 27001 → NIST CSF');
            expect(result[0]._count?.mappings).toBe(2);
        });

        it('gets mapping set by framework pair', async () => {
            db.requirementMappingSet.findUnique.mockResolvedValue(MAPPING_SET_FIXTURE);

            const result = await RequirementMappingRepository.getMappingSetByFrameworkPair(
                db, FRAMEWORK_ISO.id, FRAMEWORK_NIST.id,
            );

            expect(result).not.toBeNull();
            expect(result?.sourceFramework?.key).toBe('ISO27001');
        });

        it('returns null for non-existent framework pair', async () => {
            db.requirementMappingSet.findUnique.mockResolvedValue(null);

            const result = await RequirementMappingRepository.getMappingSetByFrameworkPair(
                db, 'nonexistent', 'also-nonexistent',
            );

            expect(result).toBeNull();
        });

        it('deletes a mapping set', async () => {
            db.requirementMappingSet.delete.mockResolvedValue(MAPPING_SET_FIXTURE);

            await RequirementMappingRepository.deleteMappingSet(db, 'ms-iso-nist');

            expect(db.requirementMappingSet.delete).toHaveBeenCalledWith({ where: { id: 'ms-iso-nist' } });
        });
    });

    // ─── Individual Mapping Persistence ──────────────────────────────
    describe('Mapping persistence', () => {
        let db: ReturnType<typeof createMockDb>;

        beforeEach(() => {
            db = createMockDb();
        });

        it('creates a mapping with EQUAL strength', async () => {
            db.requirementMapping.create.mockResolvedValue(MAPPING_FIXTURE_EQUAL);

            const input: CreateMappingInput = {
                mappingSetId: 'ms-iso-nist',
                sourceRequirementId: REQ_ISO_A5_1.id,
                targetRequirementId: REQ_NIST_GV_OC_01.id,
                strength: 'EQUAL',
                rationale: 'Both address organizational security policy governance',
            };

            const result = await RequirementMappingRepository.createMapping(db, input);

            expect(result.strength).toBe('EQUAL');
            expect(result.rationale).toContain('organizational security policy');
            expect(result.sourceRequirement.code).toBe('A.5.1');
            expect(result.targetRequirement.code).toBe('GV.OC-01');
        });

        it('creates a mapping with SUBSET strength and provenance metadata', async () => {
            db.requirementMapping.create.mockResolvedValue(MAPPING_FIXTURE_SUBSET);

            const input: CreateMappingInput = {
                mappingSetId: 'ms-iso-nist',
                sourceRequirementId: REQ_ISO_A5_2.id,
                targetRequirementId: REQ_NIST_GV_OC_02.id,
                strength: 'SUBSET',
                rationale: 'ISO A.5.2 partially covers NIST GV.OC-02 stakeholder requirements',
                metadataJson: JSON.stringify({ source: 'yaml-import', importedAt: '2026-01-01' }),
            };

            const result = await RequirementMappingRepository.createMapping(db, input);

            expect(result.strength).toBe('SUBSET');
            expect(result.metadataJson).not.toBeNull();
            const meta = JSON.parse(result.metadataJson!);
            expect(meta.source).toBe('yaml-import');
        });

        it('rejects invalid mapping strength', async () => {
            const input: CreateMappingInput = {
                mappingSetId: 'ms-iso-nist',
                sourceRequirementId: REQ_ISO_A5_1.id,
                targetRequirementId: REQ_NIST_GV_OC_01.id,
                strength: 'BOGUS' as any,
            };

            await expect(RequirementMappingRepository.createMapping(db, input))
                .rejects.toThrow('Invalid mapping strength: "BOGUS"');
        });

        it('gets a mapping by ID', async () => {
            db.requirementMapping.findUnique.mockResolvedValue(MAPPING_FIXTURE_EQUAL);

            const result = await RequirementMappingRepository.getMappingById(db, 'map-1');

            expect(result).not.toBeNull();
            expect(result?.id).toBe('map-1');
        });

        it('deletes a mapping', async () => {
            db.requirementMapping.delete.mockResolvedValue(MAPPING_FIXTURE_EQUAL);

            await RequirementMappingRepository.deleteMapping(db, 'map-1');

            expect(db.requirementMapping.delete).toHaveBeenCalledWith({ where: { id: 'map-1' } });
        });
    });

    // ─── Lookup by Source Requirement ─────────────────────────────────
    describe('Lookup by source requirement', () => {
        let db: ReturnType<typeof createMockDb>;

        beforeEach(() => {
            db = createMockDb();
        });

        it('finds all mappings from a source requirement', async () => {
            db.requirementMapping.findMany.mockResolvedValue([MAPPING_FIXTURE_EQUAL]);

            const query: MappingsBySourceQuery = {
                sourceRequirementId: REQ_ISO_A5_1.id,
            };

            const result = await RequirementMappingRepository.findBySourceRequirement(db, query);

            expect(result).toHaveLength(1);
            expect(result[0].sourceRequirement.code).toBe('A.5.1');
            expect(result[0].targetRequirement.code).toBe('GV.OC-01');
        });

        it('filters by target framework', async () => {
            db.requirementMapping.findMany.mockResolvedValue([MAPPING_FIXTURE_EQUAL]);

            const query: MappingsBySourceQuery = {
                sourceRequirementId: REQ_ISO_A5_1.id,
                targetFrameworkId: FRAMEWORK_NIST.id,
            };

            await RequirementMappingRepository.findBySourceRequirement(db, query);

            expect(db.requirementMapping.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        sourceRequirementId: REQ_ISO_A5_1.id,
                        targetRequirement: { frameworkId: FRAMEWORK_NIST.id },
                    }),
                }),
            );
        });

        it('filters by minimum strength threshold', async () => {
            db.requirementMapping.findMany.mockResolvedValue([MAPPING_FIXTURE_EQUAL]);

            const query: MappingsBySourceQuery = {
                sourceRequirementId: REQ_ISO_A5_1.id,
                minStrength: 'SUBSET',
            };

            await RequirementMappingRepository.findBySourceRequirement(db, query);

            // SUBSET has rank 3, so EQUAL (5), SUPERSET (4), SUBSET (3) should be in the filter
            expect(db.requirementMapping.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        strength: { in: expect.arrayContaining(['EQUAL', 'SUPERSET', 'SUBSET']) },
                    }),
                }),
            );
            // INTERSECT (2) and RELATED (1) should NOT be included
            const calledWhere = db.requirementMapping.findMany.mock.calls[0][0].where;
            expect(calledWhere.strength.in).not.toContain('INTERSECT');
            expect(calledWhere.strength.in).not.toContain('RELATED');
        });
    });

    // ─── Lookup by Framework Pair ────────────────────────────────────
    describe('Lookup by framework pair', () => {
        let db: ReturnType<typeof createMockDb>;

        beforeEach(() => {
            db = createMockDb();
        });

        it('finds all mappings between two frameworks', async () => {
            db.requirementMapping.findMany.mockResolvedValue([
                MAPPING_FIXTURE_EQUAL,
                MAPPING_FIXTURE_SUBSET,
            ]);

            const query: MappingsByFrameworkPairQuery = {
                sourceFrameworkId: FRAMEWORK_ISO.id,
                targetFrameworkId: FRAMEWORK_NIST.id,
            };

            const result = await RequirementMappingRepository.findByFrameworkPair(db, query);

            expect(result).toHaveLength(2);
            expect(db.requirementMapping.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        mappingSet: {
                            sourceFrameworkId: FRAMEWORK_ISO.id,
                            targetFrameworkId: FRAMEWORK_NIST.id,
                        },
                    }),
                }),
            );
        });

        it('filters framework pair by minimum strength', async () => {
            db.requirementMapping.findMany.mockResolvedValue([MAPPING_FIXTURE_EQUAL]);

            const query: MappingsByFrameworkPairQuery = {
                sourceFrameworkId: FRAMEWORK_ISO.id,
                targetFrameworkId: FRAMEWORK_NIST.id,
                minStrength: 'SUPERSET',
            };

            await RequirementMappingRepository.findByFrameworkPair(db, query);

            // SUPERSET has rank 4, so only EQUAL (5) and SUPERSET (4)
            const calledWhere = db.requirementMapping.findMany.mock.calls[0][0].where;
            expect(calledWhere.strength.in).toContain('EQUAL');
            expect(calledWhere.strength.in).toContain('SUPERSET');
            expect(calledWhere.strength.in).not.toContain('SUBSET');
        });

        it('returns empty array for unmapped framework pair', async () => {
            db.requirementMapping.findMany.mockResolvedValue([]);

            const query: MappingsByFrameworkPairQuery = {
                sourceFrameworkId: 'nonexistent',
                targetFrameworkId: 'also-nonexistent',
            };

            const result = await RequirementMappingRepository.findByFrameworkPair(db, query);

            expect(result).toHaveLength(0);
        });
    });

    // ─── Resolved Edge Projection ────────────────────────────────────
    describe('resolveEdge', () => {
        it('projects a raw mapping into a ResolvedMappingEdge', () => {
            const edge = RequirementMappingRepository.resolveEdge(MAPPING_FIXTURE_EQUAL);

            expect(edge.id).toBe('map-1');
            expect(edge.strength).toBe('EQUAL');
            expect(edge.rationale).toContain('organizational security policy');

            // Source
            expect(edge.source.requirementId).toBe(REQ_ISO_A5_1.id);
            expect(edge.source.requirementCode).toBe('A.5.1');
            expect(edge.source.frameworkKey).toBe('ISO27001');

            // Target
            expect(edge.target.requirementId).toBe(REQ_NIST_GV_OC_01.id);
            expect(edge.target.requirementCode).toBe('GV.OC-01');
            expect(edge.target.frameworkKey).toBe('NIST-CSF');
        });

        it('handles null rationale', () => {
            const raw = { ...MAPPING_FIXTURE_EQUAL, rationale: null };
            const edge = RequirementMappingRepository.resolveEdge(raw);
            expect(edge.rationale).toBeNull();
        });
    });

    // ─── Bulk Upsert ─────────────────────────────────────────────────
    describe('Bulk upsert', () => {
        let db: ReturnType<typeof createMockDb>;

        beforeEach(() => {
            db = createMockDb();
        });

        it('upserts multiple mappings idempotently', async () => {
            db.requirementMapping.upsert
                .mockResolvedValueOnce(MAPPING_FIXTURE_EQUAL)
                .mockResolvedValueOnce(MAPPING_FIXTURE_SUBSET);

            const inputs: BulkUpsertMappingInput[] = [
                {
                    sourceRequirementId: REQ_ISO_A5_1.id,
                    targetRequirementId: REQ_NIST_GV_OC_01.id,
                    strength: 'EQUAL',
                    rationale: 'Equivalent',
                },
                {
                    sourceRequirementId: REQ_ISO_A5_2.id,
                    targetRequirementId: REQ_NIST_GV_OC_02.id,
                    strength: 'SUBSET',
                    rationale: 'Partial coverage',
                },
            ];

            const results = await RequirementMappingRepository.bulkUpsertMappings(db, 'ms-iso-nist', inputs);

            expect(results).toHaveLength(2);
            expect(db.requirementMapping.upsert).toHaveBeenCalledTimes(2);

            // Verify the compound unique key is used
            const firstCall = db.requirementMapping.upsert.mock.calls[0][0];
            expect(firstCall.where.mappingSetId_sourceRequirementId_targetRequirementId).toEqual({
                mappingSetId: 'ms-iso-nist',
                sourceRequirementId: REQ_ISO_A5_1.id,
                targetRequirementId: REQ_NIST_GV_OC_01.id,
            });
        });

        it('rejects invalid strength in bulk upsert', async () => {
            const inputs: BulkUpsertMappingInput[] = [
                {
                    sourceRequirementId: REQ_ISO_A5_1.id,
                    targetRequirementId: REQ_NIST_GV_OC_01.id,
                    strength: 'INVALID' as any,
                },
            ];

            await expect(RequirementMappingRepository.bulkUpsertMappings(db, 'ms-iso-nist', inputs))
                .rejects.toThrow('Invalid mapping strength');
        });
    });

    // ─── Count and Clear ─────────────────────────────────────────────
    describe('Count and clear', () => {
        let db: ReturnType<typeof createMockDb>;

        beforeEach(() => {
            db = createMockDb();
        });

        it('counts mappings in a set', async () => {
            db.requirementMapping.count.mockResolvedValue(42);

            const count = await RequirementMappingRepository.countMappings(db, 'ms-iso-nist');

            expect(count).toBe(42);
        });

        it('clears all mappings in a set', async () => {
            db.requirementMapping.deleteMany.mockResolvedValue({ count: 42 });

            await RequirementMappingRepository.clearMappings(db, 'ms-iso-nist');

            expect(db.requirementMapping.deleteMany).toHaveBeenCalledWith({
                where: { mappingSetId: 'ms-iso-nist' },
            });
        });
    });
});
