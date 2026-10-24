/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Mapping Set Importer Tests
 *
 * Tests the YAML-based mapping set ingestion pipeline:
 * - YAML parsing and Zod validation
 * - Content hash deduplication
 * - Requirement reference resolution
 * - Import with valid data
 * - Import with invalid/missing references
 * - Import with malformed YAML
 * - Force re-import behavior
 * - Directory scanning
 */

import {
    parseMappingSetString,
    computeMappingSetHash,
    importMappingSet,
    scanMappingSetDirectory,
    MappingSetParseError,
    MappingSetValidationError,
    MappingSetReferenceError,
} from '@/app-layer/services/mapping-set-importer';

// ─── Fixtures ────────────────────────────────────────────────────────

const VALID_YAML = `
urn: urn:inflect:mappingset:test-iso-to-nist
name: "Test ISO → NIST"
description: Test mapping set
version: 1
source_framework_ref: ISO27001-2022
target_framework_ref: NIST-CSF-2.0
mapping_entries:
  - source_ref: A.5.1
    target_ref: GV.OC-01
    strength: EQUAL
    rationale: Both address security governance
  - source_ref: A.5.2
    target_ref: GV.RR-01
    strength: SUBSET
    rationale: Partial coverage of roles
  - source_ref: A.5.15
    target_ref: PR.AA-01
    strength: INTERSECT
`;

const MINIMAL_YAML = `
urn: urn:inflect:mappingset:minimal
name: Minimal
version: 1
source_framework_ref: FW-A
target_framework_ref: FW-B
mapping_entries:
  - source_ref: REQ-1
    target_ref: REQ-2
`;

const MALFORMED_YAML = `
urn: urn:inflect:mappingset:bad
name: 
version: -1
source_framework_ref: ""
target_framework_ref: ""
mapping_entries: []
`;

const INVALID_YAML_SYNTAX = `
urn: test
  name: [broken
  : invalid yaml {{
`;

const MISSING_ENTRIES_YAML = `
urn: urn:inflect:mappingset:no-entries
name: No Entries
version: 1
source_framework_ref: FW-A
target_framework_ref: FW-B
`;

const INVALID_STRENGTH_YAML = `
urn: urn:inflect:mappingset:bad-strength
name: Bad Strength
version: 1
source_framework_ref: FW-A
target_framework_ref: FW-B
mapping_entries:
  - source_ref: REQ-1
    target_ref: REQ-2
    strength: BOGUS
`;

// ─── Mock DB ─────────────────────────────────────────────────────────

function createMockDb(options: {
    sourceFramework?: { id: string; key: string } | null;
    targetFramework?: { id: string; key: string } | null;
    sourceReqs?: Array<{ id: string; code: string }>;
    targetReqs?: Array<{ id: string; code: string }>;
    existingSet?: { id: string; contentHash: string } | null;
} = {}) {
    const {
        sourceFramework = { id: 'fw-iso', key: 'ISO27001-2022' },
        targetFramework = { id: 'fw-nist', key: 'NIST-CSF-2.0' },
        sourceReqs = [
            { id: 'req-a51', code: 'A.5.1' },
            { id: 'req-a52', code: 'A.5.2' },
            { id: 'req-a515', code: 'A.5.15' },
        ],
        targetReqs = [
            { id: 'req-gv-oc01', code: 'GV.OC-01' },
            { id: 'req-gv-rr01', code: 'GV.RR-01' },
            { id: 'req-pr-aa01', code: 'PR.AA-01' },
        ],
        existingSet = null,
    } = options;

    return {
        framework: {
            findFirst: jest.fn().mockImplementation(({ where }: any) => {
                if (where.key === sourceFramework?.key) return Promise.resolve(sourceFramework);
                if (where.key === targetFramework?.key) return Promise.resolve(targetFramework);
                return Promise.resolve(null);
            }),
        },
        frameworkRequirement: {
            findMany: jest.fn().mockImplementation(({ where }: any) => {
                if (where.frameworkId === sourceFramework?.id) return Promise.resolve(sourceReqs);
                if (where.frameworkId === targetFramework?.id) return Promise.resolve(targetReqs);
                return Promise.resolve([]);
            }),
        },
        requirementMappingSet: {
            findUnique: jest.fn().mockResolvedValue(existingSet ? {
                ...existingSet,
                sourceFramework: { id: sourceFramework?.id, key: sourceFramework?.key, name: 'Source' },
                targetFramework: { id: targetFramework?.id, key: targetFramework?.key, name: 'Target' },
                _count: { mappings: 0 },
            } : null),
            upsert: jest.fn().mockResolvedValue({
                id: 'ms-new',
                sourceFrameworkId: sourceFramework?.id,
                targetFrameworkId: targetFramework?.id,
                sourceFramework: { id: sourceFramework?.id, key: sourceFramework?.key, name: 'Source' },
                targetFramework: { id: targetFramework?.id, key: targetFramework?.key, name: 'Target' },
                _count: { mappings: 0 },
            }),
        },
        requirementMapping: {
            findMany: jest.fn().mockResolvedValue([]), // No existing mappings by default
            upsert: jest.fn().mockResolvedValue({ id: 'map-new' }),
        },
    } as any;
}

// ═════════════════════════════════════════════════════════════════════
// Test Suites
// ═════════════════════════════════════════════════════════════════════

describe('MappingSet Importer', () => {
    // ─── YAML Parsing & Validation ───────────────────────────────────
    describe('YAML parsing', () => {
        it('parses valid mapping set YAML', () => {
            const result = parseMappingSetString(VALID_YAML);

            expect(result.urn).toBe('urn:inflect:mappingset:test-iso-to-nist');
            expect(result.name).toBe('Test ISO → NIST');
            expect(result.version).toBe(1);
            expect(result.source_framework_ref).toBe('ISO27001-2022');
            expect(result.target_framework_ref).toBe('NIST-CSF-2.0');
            expect(result.mapping_entries).toHaveLength(3);
        });

        it('parses entry strength and rationale', () => {
            const result = parseMappingSetString(VALID_YAML);

            expect(result.mapping_entries[0].source_ref).toBe('A.5.1');
            expect(result.mapping_entries[0].target_ref).toBe('GV.OC-01');
            expect(result.mapping_entries[0].strength).toBe('EQUAL');
            expect(result.mapping_entries[0].rationale).toBe('Both address security governance');
        });

        it('defaults strength to RELATED when omitted', () => {
            const result = parseMappingSetString(MINIMAL_YAML);

            expect(result.mapping_entries[0].strength).toBe('RELATED');
        });

        it('rejects invalid YAML syntax', () => {
            expect(() => parseMappingSetString(INVALID_YAML_SYNTAX))
                .toThrow(MappingSetParseError);
        });

        it('rejects malformed schema (empty name, negative version, empty arrays)', () => {
            expect(() => parseMappingSetString(MALFORMED_YAML))
                .toThrow(MappingSetValidationError);
        });

        it('rejects missing mapping_entries', () => {
            expect(() => parseMappingSetString(MISSING_ENTRIES_YAML))
                .toThrow(MappingSetValidationError);
        });

        it('rejects invalid strength value', () => {
            expect(() => parseMappingSetString(INVALID_STRENGTH_YAML))
                .toThrow(MappingSetValidationError);
        });

        it('parses non-file content with source name', () => {
            const result = parseMappingSetString(VALID_YAML, 'test-source.yaml');
            expect(result.urn).toBe('urn:inflect:mappingset:test-iso-to-nist');
        });
    });

    // ─── Content Hash ────────────────────────────────────────────────
    describe('Content hash', () => {
        it('produces a consistent hash for same content', () => {
            const stored = parseMappingSetString(VALID_YAML);
            const h1 = computeMappingSetHash(stored);
            const h2 = computeMappingSetHash(stored);

            expect(h1).toBe(h2);
            expect(h1).toMatch(/^[a-f0-9]{64}$/);
        });

        it('produces different hashes for different content', () => {
            const stored1 = parseMappingSetString(VALID_YAML);
            const stored2 = parseMappingSetString(MINIMAL_YAML);

            expect(computeMappingSetHash(stored1)).not.toBe(computeMappingSetHash(stored2));
        });

        it('changes hash when version changes', () => {
            const stored1 = parseMappingSetString(VALID_YAML);
            const stored2 = { ...stored1, version: 2 };

            expect(computeMappingSetHash(stored1)).not.toBe(computeMappingSetHash(stored2));
        });

        it('changes hash when only a rationale, the name or the description changes', () => {
            // The hash once covered refs and strengths only, so a reworded
            // rationale under the same version was skipped by every database
            // already holding the set and never reached it.
            const stored = parseMappingSetString(VALID_YAML);
            const base = computeMappingSetHash(stored);
            const [first, ...rest] = stored.mapping_entries;
            const reworded = { ...stored, mapping_entries: [{ ...first, rationale: 'Reworded.' }, ...rest] };

            expect(computeMappingSetHash(reworded)).not.toBe(base);
            expect(computeMappingSetHash({ ...stored, name: 'Renamed' })).not.toBe(base);
            expect(computeMappingSetHash({ ...stored, description: 'Redescribed' })).not.toBe(base);
        });

        it('does not depend on key order', () => {
            const stored = parseMappingSetString(VALID_YAML);
            const reordered = Object.fromEntries(Object.entries(stored).reverse()) as typeof stored;

            expect(computeMappingSetHash(reordered)).toBe(computeMappingSetHash(stored));
        });
    });

    // ─── Import: Happy Path ──────────────────────────────────────────
    describe('Import (happy path)', () => {
        it('imports valid YAML with all references resolved', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb();

            const result = await importMappingSet(db, stored, hash);

            expect(result.mappingSetId).toBe('ms-new');
            expect(result.name).toBe('Test ISO → NIST');
            expect(result.created).toBe(3);
            expect(result.updated).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(result.skippedDuplicate).toBe(false);
        });

        it('upserts mapping set with correct framework IDs', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb();

            await importMappingSet(db, stored, hash);

            expect(db.requirementMappingSet.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        sourceFrameworkId_targetFrameworkId: {
                            sourceFrameworkId: 'fw-iso',
                            targetFrameworkId: 'fw-nist',
                        },
                    },
                }),
            );
        });

        it('upserts each mapping entry with correct data', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb();

            await importMappingSet(db, stored, hash);

            expect(db.requirementMapping.upsert).toHaveBeenCalledTimes(3);

            // First entry: A.5.1 → GV.OC-01 EQUAL
            const firstCall = db.requirementMapping.upsert.mock.calls[0][0];
            expect(firstCall.create).toEqual(expect.objectContaining({
                mappingSetId: 'ms-new',
                sourceRequirementId: 'req-a51',
                targetRequirementId: 'req-gv-oc01',
                strength: 'EQUAL',
                rationale: 'Both address security governance',
            }));
        });

        it('tracks updated count when mapping already exists', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb();
            // Simulate first mapping already existing via bulk-loaded existing keys
            db.requirementMapping.findMany.mockResolvedValue([
                { sourceRequirementId: 'req-a51', targetRequirementId: 'req-gv-oc01' },
            ]);

            const result = await importMappingSet(db, stored, hash);

            expect(result.created).toBe(2);
            expect(result.updated).toBe(1);
        });
    });

    // ─── Import: Deduplication ───────────────────────────────────────
    describe('Import (deduplication)', () => {
        it('skips import when content hash matches existing set', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb({
                existingSet: { id: 'ms-existing', contentHash: hash },
            });

            const result = await importMappingSet(db, stored, hash);

            expect(result.skippedDuplicate).toBe(true);
            expect(result.created).toBe(0);
            expect(result.updated).toBe(0);
            // Should NOT upsert mapping set or mappings
            expect(db.requirementMappingSet.upsert).not.toHaveBeenCalled();
            expect(db.requirementMapping.upsert).not.toHaveBeenCalled();
        });

        it('re-imports when content hash differs', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb({
                existingSet: { id: 'ms-existing', contentHash: 'old-hash' },
            });

            const result = await importMappingSet(db, stored, hash);

            expect(result.skippedDuplicate).toBe(false);
            expect(result.created).toBe(3);
        });

        it('force re-imports even when hash matches', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb({
                existingSet: { id: 'ms-existing', contentHash: hash },
            });

            const result = await importMappingSet(db, stored, hash, { force: true });

            expect(result.skippedDuplicate).toBe(false);
            expect(result.created).toBe(3);
        });
    });

    // ─── Import: Reference Errors ────────────────────────────────────
    describe('Import (reference errors)', () => {
        it('fails when source framework not found', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb({ sourceFramework: null });

            await expect(importMappingSet(db, stored, hash))
                .rejects.toThrow(MappingSetReferenceError);
        });

        it('fails when target framework not found', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            const db = createMockDb({ targetFramework: null });

            await expect(importMappingSet(db, stored, hash))
                .rejects.toThrow(MappingSetReferenceError);
        });

        it('records errors for unresolved source requirement refs', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            // Only provide A.5.1 and A.5.15, NOT A.5.2
            const db = createMockDb({
                sourceReqs: [
                    { id: 'req-a51', code: 'A.5.1' },
                    { id: 'req-a515', code: 'A.5.15' },
                ],
            });

            const result = await importMappingSet(db, stored, hash);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].sourceRef).toBe('A.5.2');
            expect(result.errors[0].message).toContain('Source requirement "A.5.2" not found');
            expect(result.created).toBe(2); // Only 2 of 3 succeeded
        });

        it('records errors for unresolved target requirement refs', async () => {
            const stored = parseMappingSetString(VALID_YAML);
            const hash = computeMappingSetHash(stored);
            // Only provide GV.OC-01, NOT GV.RR-01 or PR.AA-01
            const db = createMockDb({
                targetReqs: [
                    { id: 'req-gv-oc01', code: 'GV.OC-01' },
                ],
            });

            const result = await importMappingSet(db, stored, hash);

            expect(result.errors).toHaveLength(2);
            expect(result.errors[0].targetRef).toBe('GV.RR-01');
            expect(result.errors[1].targetRef).toBe('PR.AA-01');
            expect(result.created).toBe(1); // Only 1 of 3 succeeded
        });
    });

    // ─── Directory Scanning ──────────────────────────────────────────
    describe('Directory scanning', () => {
        it('returns empty array for non-existent directory', () => {
            const results = scanMappingSetDirectory('/nonexistent/path');
            expect(results).toHaveLength(0);
        });

        it('scans a directory with mapping YAML files', () => {
            // Use the actual mappings directory
            const results = scanMappingSetDirectory(
                require('path').resolve(__dirname, '../../src/data/libraries/mappings'),
            );
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].stored.urn).toBeDefined();
            expect(results[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
        });
    });
});
