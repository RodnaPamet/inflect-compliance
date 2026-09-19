/**
 * Tests for the Library Importer — Import pipeline logic.
 *
 * These tests verify:
 * - Content hash deduplication (unchanged library is skipped)
 * - Changed library triggers update path
 * - Importer is idempotent (multiple imports produce same result)
 * - Framework metadata is stored correctly
 * - FrameworkKind mapping works
 *
 * Since the importer depends on Prisma, these tests mock the database layer
 * and test the decision-making logic.
 */
import * as path from 'path';
import {
    parseLibraryFile,
    parseLibraryString,
    loadLibrary,
} from '@/app-layer/libraries';

// ─── Paths ───────────────────────────────────────────────────────────

const LIBRARIES_DIR = path.resolve(__dirname, '../../src/data/libraries');

// ─── Fixtures ────────────────────────────────────────────────────────

const MINIMAL_YAML = `
urn: urn:inflect:library:test-import
locale: en
ref_id: TEST-IMPORT
name: Test Import Framework
version: 1
kind: CUSTOM
objects:
  framework:
    urn: urn:inflect:framework:test-import
    ref_id: TEST-IMPORT
    name: Test Import Framework
    requirement_nodes:
      - urn: urn:inflect:req:test-import:r1
        ref_id: R1
        name: Requirement 1
        description: First requirement
        depth: 1
        assessable: true
        category: Cat A
      - urn: urn:inflect:req:test-import:r2
        ref_id: R2
        name: Requirement 2
        description: Second requirement
        depth: 1
        assessable: true
        category: Cat B
      - urn: urn:inflect:req:test-import:group
        ref_id: G1
        name: Grouping Node
        depth: 1
        assessable: false
`;

const MINIMAL_YAML_V2 = `
urn: urn:inflect:library:test-import
locale: en
ref_id: TEST-IMPORT
name: Test Import Framework v2
version: 2
kind: CUSTOM
objects:
  framework:
    urn: urn:inflect:framework:test-import
    ref_id: TEST-IMPORT
    name: Test Import Framework v2
    requirement_nodes:
      - urn: urn:inflect:req:test-import:r1
        ref_id: R1
        name: Requirement 1 (Updated)
        description: Updated first requirement
        depth: 1
        assessable: true
        category: Cat A
      - urn: urn:inflect:req:test-import:r3
        ref_id: R3
        name: Requirement 3 (New)
        description: Brand new requirement
        depth: 1
        assessable: true
        category: Cat C
      - urn: urn:inflect:req:test-import:group
        ref_id: G1
        name: Grouping Node
        depth: 1
        assessable: false
`;

// ─── Content Hash Deduplication Tests ────────────────────────────────

describe('Content Hash Deduplication', () => {
    it('same YAML produces same content hash', () => {
        const stored1 = parseLibraryString(MINIMAL_YAML);
        const loaded1 = loadLibrary(stored1);

        const stored2 = parseLibraryString(MINIMAL_YAML);
        const loaded2 = loadLibrary(stored2);

        expect(loaded1.contentHash).toBe(loaded2.contentHash);
    });

    it('different YAML version produces different content hash', () => {
        const stored1 = parseLibraryString(MINIMAL_YAML);
        const loaded1 = loadLibrary(stored1);

        const stored2 = parseLibraryString(MINIMAL_YAML_V2);
        const loaded2 = loadLibrary(stored2);

        expect(loaded1.contentHash).not.toBe(loaded2.contentHash);
    });

    it('hash is a 64-character hex string (SHA-256)', () => {
        const stored = parseLibraryString(MINIMAL_YAML);
        const loaded = loadLibrary(stored);

        expect(loaded.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
});

// ─── Assessable Node Filtering ───────────────────────────────────────

describe('Assessable Node Filtering', () => {
    it('should only import assessable nodes as requirements', () => {
        const stored = parseLibraryString(MINIMAL_YAML);
        const loaded = loadLibrary(stored);

        const assessableNodes = loaded.framework.nodes.filter(n => n.assessable);

        // 3 nodes total, but only 2 are assessable (R1, R2; G1 is not assessable)
        expect(loaded.framework.nodes).toHaveLength(3);
        expect(assessableNodes).toHaveLength(2);
        expect(assessableNodes.map(n => n.refId)).toEqual(['R1', 'R2']);
    });
});

// ─── Version Diff for Update Detection ───────────────────────────────

describe('Version Change Detection', () => {
    it('should detect version change between v1 and v2', () => {
        const v1 = loadLibrary(parseLibraryString(MINIMAL_YAML));
        const v2 = loadLibrary(parseLibraryString(MINIMAL_YAML_V2));

        expect(v1.version).toBe(1);
        expect(v2.version).toBe(2);
        expect(v1.contentHash).not.toBe(v2.contentHash);
    });

    it('v2 should have different assessable nodes than v1', () => {
        const v1 = loadLibrary(parseLibraryString(MINIMAL_YAML));
        const v2 = loadLibrary(parseLibraryString(MINIMAL_YAML_V2));

        const v1Codes = v1.framework.nodes.filter(n => n.assessable).map(n => n.refId);
        const v2Codes = v2.framework.nodes.filter(n => n.assessable).map(n => n.refId);

        // v1: R1, R2
        // v2: R1, R3 (R2 removed, R3 added)
        expect(v1Codes).toEqual(['R1', 'R2']);
        expect(v2Codes).toEqual(['R1', 'R3']);
    });

    it('v2 should have updated title for R1', () => {
        const v2 = loadLibrary(parseLibraryString(MINIMAL_YAML_V2));
        const r1 = v2.framework.nodesByRefId.get('R1');

        expect(r1).toBeDefined();
        expect(r1!.name).toBe('Requirement 1 (Updated)');
    });
});

// ─── Framework Kind Mapping ──────────────────────────────────────────

describe('Framework Kind Mapping', () => {
    it('should pass through known Prisma kinds', () => {
        const lib = loadLibrary(parseLibraryString(MINIMAL_YAML));
        expect(lib.kind).toBe('CUSTOM');
    });

    it('should detect ISO_STANDARD from YAML', () => {
        const isoPath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const lib = loadLibrary(parseLibraryFile(isoPath), isoPath);
        expect(lib.kind).toBe('ISO_STANDARD');
    });

    it('should detect NIST_FRAMEWORK from YAML', () => {
        const nistPath = path.join(LIBRARIES_DIR, 'nist-csf-2.0.yaml');
        const lib = loadLibrary(parseLibraryFile(nistPath), nistPath);
        expect(lib.kind).toBe('NIST_FRAMEWORK');
    });

    it('should detect SOC_CRITERIA from YAML', () => {
        const socPath = path.join(LIBRARIES_DIR, 'soc2-2017.yaml');
        const lib = loadLibrary(parseLibraryFile(socPath), socPath);
        expect(lib.kind).toBe('SOC_CRITERIA');
    });
});

// ─── Import Metadata Structure ───────────────────────────────────────

describe('Import Metadata Structure', () => {
    it('loaded library has all fields needed for Prisma upsert', () => {
        const lib = loadLibrary(parseLibraryString(MINIMAL_YAML));

        // These fields map to Framework model columns
        expect(lib.refId).toBeDefined(); // → key
        expect(lib.name).toBeDefined(); // → name
        expect(lib.version).toBeDefined(); // → version
        expect(lib.contentHash).toBeDefined(); // → contentHash
        expect(lib.urn).toBeDefined(); // → sourceUrn
        expect(lib.kind).toBeDefined(); // → kind
    });

    it('loaded library has metadata fields for metadataJson', () => {
        const lib = loadLibrary(parseLibraryString(MINIMAL_YAML));

        expect(lib.locale).toBe('en');
        // Optional fields may or may not exist
        expect(typeof lib.provider === 'string' || lib.provider === undefined).toBe(true);
        expect(typeof lib.packager === 'string' || lib.packager === undefined).toBe(true);
    });
});

/**
 * A RELABEL IS NOT A CHANGE OF OBLIGATION (#2619 pre-merge review).
 *
 * `changedCodes` drives `propagateFrameworkDelta`, which sets every linked
 * control to NEEDS_REVIEW (`usecases/framework-delta.ts:163`). Reserving that
 * for title/description keeps a `section` or `category` relabel from demoting
 * a tenant's implemented controls and notifying them about a heading.
 */
describe('changedCodes is substantive-only', () => {
    const { computeRequirementDiff } = jest.requireActual<
        typeof import('@/app-layer/services/library-updater')
    >('@/app-layer/services/library-updater');

    /** Exactly the filter `library-importer.ts` applies before propagating. */
    const substantive = (changed: Array<{ code: string; fields: string[] }>) =>
        changed.filter((c) => c.fields.some((f) => f === 'title' || f === 'description')).map((c) => c.code);

    const base = { code: 'V2.1.1', title: 'Minimum Password Length', description: 'Require twelve characters.' };

    it('a section-only relabel is diffed as changed but does not propagate', () => {
        const diff = computeRequirementDiff(
            [{ ...base, category: 'L1', section: 'L1' }],
            [{ ...base, category: 'L1', section: 'Authentication' }],
        );
        // The row still gets WRITTEN — the diff must see it…
        expect(diff.changed).toHaveLength(1);
        expect(diff.changed[0].fields).toEqual(['section']);
        // …but no control is flagged for re-review over a heading.
        expect(substantive(diff.changed)).toEqual([]);
    });

    it('a reworded requirement still propagates', () => {
        // The positive control. Without it, a filter that returned [] always
        // would pass the test above.
        const diff = computeRequirementDiff(
            [{ ...base, category: 'L1', section: 'Authentication' }],
            [{ ...base, description: 'Require fourteen characters.', category: 'L1', section: 'Authentication' }],
        );
        expect(diff.changed[0].fields).toEqual(['description']);
        expect(substantive(diff.changed)).toEqual(['V2.1.1']);
    });

    it('a rename propagates, and a mixed relabel+rename propagates once', () => {
        const renamed = computeRequirementDiff(
            [{ ...base, category: 'L1', section: 'Authentication' }],
            [{ ...base, title: 'Minimum Passphrase Length', category: 'L1', section: 'Authentication' }],
        );
        expect(substantive(renamed.changed)).toEqual(['V2.1.1']);

        const mixed = computeRequirementDiff(
            [{ ...base, category: 'L1', section: 'L1' }],
            [{ ...base, title: 'Minimum Passphrase Length', category: 'L1', section: 'Authentication' }],
        );
        expect(mixed.changed[0].fields.sort()).toEqual(['section', 'title']);
        expect(substantive(mixed.changed)).toEqual(['V2.1.1']);
    });
});
