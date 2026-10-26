/**
 * Tests for the Framework Library System
 *
 * Covers:
 * - YAML parsing success and failure
 * - Zod schema validation
 * - URN uniqueness enforcement
 * - Parent reference validation
 * - LoadedLibrary structure correctness
 * - Directory scanning
 * - Content hash stability
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
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
} from '@/app-layer/libraries';

// ─── Paths ───────────────────────────────────────────────────────────

const LIBRARIES_DIR = path.resolve(__dirname, '../../src/data/libraries');

// ─── Helpers ─────────────────────────────────────────────────────────

/** Minimal valid YAML library for testing */
const MINIMAL_LIBRARY_YAML = `
urn: urn:inflect:library:test-framework
locale: en
ref_id: TEST-FW
name: Test Framework
version: 1
kind: CUSTOM
objects:
  framework:
    urn: urn:inflect:framework:test-fw
    ref_id: TEST-FW
    name: Test Framework
    requirement_nodes:
      - urn: urn:inflect:req:test-fw:r1
        ref_id: R1
        name: Requirement 1
        description: First requirement
        depth: 1
        assessable: true
      - urn: urn:inflect:req:test-fw:r2
        ref_id: R2
        name: Requirement 2
        description: Second requirement
        depth: 1
        assessable: false
      - urn: urn:inflect:req:test-fw:r2.1
        ref_id: R2.1
        name: Sub-requirement 2.1
        description: Child of R2
        parent_urn: urn:inflect:req:test-fw:r2
        depth: 2
        assessable: true
`;

// ─── YAML Parsing Tests ──────────────────────────────────────────────

describe('Library YAML Parsing', () => {
    it('should parse a minimal valid YAML library', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        expect(stored.urn).toBe('urn:inflect:library:test-framework');
        expect(stored.ref_id).toBe('TEST-FW');
        expect(stored.name).toBe('Test Framework');
        expect(stored.version).toBe(1);
        expect(stored.locale).toBe('en');
        expect(stored.kind).toBe('CUSTOM');
        expect(stored.objects.framework.requirement_nodes).toHaveLength(3);
    });

    it('should parse ISO 27001 YAML file from disk', () => {
        const filePath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const stored = parseLibraryFile(filePath);
        expect(stored.urn).toBe('urn:inflect:library:iso27001-2022');
        expect(stored.ref_id).toBe('ISO27001-2022');
        expect(stored.name).toContain('ISO/IEC 27001');
        expect(stored.version).toBeGreaterThanOrEqual(1);
        expect(stored.objects.framework.requirement_nodes.length).toBeGreaterThan(10);
    });

    it('should parse NIST CSF 2.0 YAML file from disk', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nist-csf-2.0.yaml');
        const stored = parseLibraryFile(filePath);
        expect(stored.urn).toBe('urn:inflect:library:nist-csf-2.0');
        expect(stored.ref_id).toBe('NIST-CSF-2.0');
        expect(stored.kind).toBe('NIST_FRAMEWORK');
    });

    it('should parse SOC 2 YAML file from disk', () => {
        const filePath = path.join(LIBRARIES_DIR, 'soc2-2017.yaml');
        const stored = parseLibraryFile(filePath);
        expect(stored.urn).toBe('urn:inflect:library:soc2-2017');
        expect(stored.ref_id).toBe('SOC2-2017');
        expect(stored.kind).toBe('SOC_CRITERIA');
    });

    it('should throw LibraryParseError for invalid YAML syntax', () => {
        const badYaml = '{ invalid yaml: [missing bracket';
        expect(() => parseLibraryString(badYaml, 'bad.yaml')).toThrow(LibraryParseError);
    });

    it('should throw LibraryParseError for non-object YAML', () => {
        expect(() => parseLibraryString('just a string', 'scalar.yaml')).toThrow(LibraryParseError);
    });

    it('should throw LibraryValidationError for missing required fields', () => {
        const missingFields = `
urn: urn:inflect:library:bad
locale: en
# missing ref_id, name, version, objects
`;
        expect(() => parseLibraryString(missingFields, 'incomplete.yaml')).toThrow(LibraryValidationError);
    });

    it('should throw LibraryValidationError for invalid URN format', () => {
        const badUrn = `
urn: not-a-valid-urn
locale: en
ref_id: BAD
name: Bad Library
version: 1
objects:
  framework:
    urn: also-bad
    ref_id: BAD
    name: Bad
    requirement_nodes:
      - urn: nope
        ref_id: R1
        depth: 1
`;
        expect(() => parseLibraryString(badUrn, 'bad-urn.yaml')).toThrow(LibraryValidationError);
    });

    it('should throw LibraryValidationError for empty requirement_nodes', () => {
        const emptyNodes = `
urn: urn:inflect:library:empty
locale: en
ref_id: EMPTY
name: Empty
version: 1
objects:
  framework:
    urn: urn:inflect:framework:empty
    ref_id: EMPTY
    name: Empty
    requirement_nodes: []
`;
        expect(() => parseLibraryString(emptyNodes, 'empty.yaml')).toThrow(LibraryValidationError);
    });
});

// ─── URN Uniqueness Tests ────────────────────────────────────────────

describe('URN Uniqueness Validation', () => {
    it('should pass for unique URNs', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        expect(() => validateUrnUniqueness(stored)).not.toThrow();
    });

    it('should throw LibraryUrnCollisionError for duplicate URNs', () => {
        const duplicateUrns = `
urn: urn:inflect:library:dup
locale: en
ref_id: DUP
name: Duplicate
version: 1
objects:
  framework:
    urn: urn:inflect:framework:dup
    ref_id: DUP
    name: Duplicate
    requirement_nodes:
      - urn: urn:inflect:req:dup:r1
        ref_id: R1
        depth: 1
      - urn: urn:inflect:req:dup:r1
        ref_id: R1-DUPE
        depth: 1
`;
        const stored = parseLibraryString(duplicateUrns);
        expect(() => validateUrnUniqueness(stored, 'dup.yaml')).toThrow(LibraryUrnCollisionError);
    });
});

// ─── Parent Reference Tests ──────────────────────────────────────────

describe('Parent Reference Validation', () => {
    it('should pass for valid parent references', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        expect(() => validateParentReferences(stored)).not.toThrow();
    });

    it('should throw LibraryValidationError for broken parent references', () => {
        const brokenParent = `
urn: urn:inflect:library:broken
locale: en
ref_id: BROKEN
name: Broken
version: 1
objects:
  framework:
    urn: urn:inflect:framework:broken
    ref_id: BROKEN
    name: Broken
    requirement_nodes:
      - urn: urn:inflect:req:broken:r1
        ref_id: R1
        depth: 1
      - urn: urn:inflect:req:broken:r2
        ref_id: R2
        parent_urn: urn:inflect:req:broken:nonexistent
        depth: 2
`;
        const stored = parseLibraryString(brokenParent);
        expect(() => validateParentReferences(stored, 'broken.yaml')).toThrow(LibraryValidationError);
    });
});

// ─── LoadedLibrary Structure Tests ───────────────────────────────────

describe('Library Loading (StoredLibrary → LoadedLibrary)', () => {
    it('should produce a LoadedLibrary with correct metadata', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored, 'test.yaml');

        expect(loaded.urn).toBe('urn:inflect:library:test-framework');
        expect(loaded.refId).toBe('TEST-FW');
        expect(loaded.name).toBe('Test Framework');
        expect(loaded.version).toBe(1);
        expect(loaded.locale).toBe('en');
        expect(loaded.kind).toBe('CUSTOM');
    });

    it('should index nodes by URN for O(1) lookups', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);

        const r1 = loaded.framework.nodesByUrn.get('urn:inflect:req:test-fw:r1');
        expect(r1).toBeDefined();
        expect(r1!.refId).toBe('R1');
        expect(r1!.assessable).toBe(true);

        const r2 = loaded.framework.nodesByUrn.get('urn:inflect:req:test-fw:r2');
        expect(r2).toBeDefined();
        expect(r2!.assessable).toBe(false);
    });

    it('should index nodes by ref_id for O(1) lookups', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);

        const r1 = loaded.framework.nodesByRefId.get('R1');
        expect(r1).toBeDefined();
        expect(r1!.urn).toBe('urn:inflect:req:test-fw:r1');
    });

    it('should resolve parent/child relationships', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);

        // R2 should have R2.1 as a child
        const r2 = loaded.framework.nodesByUrn.get('urn:inflect:req:test-fw:r2');
        expect(r2).toBeDefined();
        expect(r2!.childUrns).toContain('urn:inflect:req:test-fw:r2.1');

        // R2.1 should reference R2 as parent
        const r21 = loaded.framework.nodesByUrn.get('urn:inflect:req:test-fw:r2.1');
        expect(r21).toBeDefined();
        expect(r21!.parentUrn).toBe('urn:inflect:req:test-fw:r2');
    });

    it('should identify root nodes correctly', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);

        // Root nodes = depth 1, no parent
        expect(loaded.framework.rootNodes).toHaveLength(2);
        const rootRefIds = loaded.framework.rootNodes.map(n => n.refId);
        expect(rootRefIds).toContain('R1');
        expect(rootRefIds).toContain('R2');
    });

    it('should produce a stable content hash', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded1 = loadLibrary(stored);
        const loaded2 = loadLibrary(stored);

        expect(loaded1.contentHash).toBe(loaded2.contentHash);
        expect(loaded1.contentHash).toHaveLength(64); // SHA-256 hex
    });

    it('should produce different hashes for different content', () => {
        const stored1 = parseLibraryString(MINIMAL_LIBRARY_YAML);

        const altYaml = MINIMAL_LIBRARY_YAML.replace('version: 1', 'version: 2');
        const stored2 = parseLibraryString(altYaml);

        const loaded1 = loadLibrary(stored1);
        const loaded2 = loadLibrary(stored2);

        expect(loaded1.contentHash).not.toBe(loaded2.contentHash);
    });

    it('should load ISO 27001 from disk with correct structure', () => {
        const filePath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        // Verify framework metadata
        expect(loaded.framework.name).toContain('ISO/IEC 27001');

        // Verify URN lookup works
        const a51 = loaded.framework.nodesByRefId.get('A.5.1');
        expect(a51).toBeDefined();
        expect(a51!.name).toBe('Information Security Policies');
        expect(a51!.assessable).toBe(true);
        expect(a51!.category).toBe('Organizational');

        // Verify parent/child structure
        const a5 = loaded.framework.nodesByRefId.get('A.5');
        expect(a5).toBeDefined();
        expect(a5!.childUrns.length).toBeGreaterThan(0);
        expect(a5!.assessable).toBe(false);
    });

    it('should load NIST CSF 2.0 with scoring definitions', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nist-csf-2.0.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        // Verify scoring
        expect(loaded.framework.scoring).toBeDefined();
        expect(loaded.framework.scoring!.min).toBe(1);
        expect(loaded.framework.scoring!.max).toBe(4);
        expect(loaded.framework.scoring!.definitions).toHaveLength(4);

        // Verify 6 root functions
        const rootNames = loaded.framework.rootNodes.map(n => n.refId);
        expect(rootNames).toContain('GV');
        expect(rootNames).toContain('ID');
        expect(rootNames).toContain('PR');
        expect(rootNames).toContain('DE');
        expect(rootNames).toContain('RS');
        expect(rootNames).toContain('RC');
    });
});

// ─── Directory Scanning Tests ────────────────────────────────────────

describe('Library Directory Scanning', () => {
    it('should scan the libraries directory and find all YAML files', () => {
        const entries = scanLibraryDirectory(LIBRARIES_DIR);
        expect(entries.length).toBeGreaterThanOrEqual(4);

        const urns = entries.map(e => e.urn);
        expect(urns).toContain('urn:inflect:library:iso27001-2022');
        expect(urns).toContain('urn:inflect:library:nist-csf-2.0');
        expect(urns).toContain('urn:inflect:library:soc2-2017');
        expect(urns).toContain('urn:inflect:library:nis2-2022');
    });

    it('should return empty array for non-existent directory', () => {
        const entries = scanLibraryDirectory('/non/existent/path');
        expect(entries).toEqual([]);
    });

    it('should load all libraries from directory', () => {
        const loaded = loadAllFromDirectory(LIBRARIES_DIR);
        expect(loaded.size).toBeGreaterThanOrEqual(4);
        expect(loaded.has('urn:inflect:library:iso27001-2022')).toBe(true);
        expect(loaded.has('urn:inflect:library:nist-csf-2.0')).toBe(true);
        expect(loaded.has('urn:inflect:library:soc2-2017')).toBe(true);
        expect(loaded.has('urn:inflect:library:nis2-2022')).toBe(true);
    });
});

// ─── Cross-Framework Mapping Tests ───────────────────────────────────

describe('Cross-Framework Mappings', () => {
    it('should handle libraries without mappings', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);
        expect(loaded.mappings).toEqual([]);
    });

    it('should parse and normalize mapping entries', () => {
        const withMappings = `
urn: urn:inflect:library:mapped
locale: en
ref_id: MAPPED
name: Mapped Framework
version: 1
objects:
  framework:
    urn: urn:inflect:framework:mapped
    ref_id: MAPPED
    name: Mapped
    requirement_nodes:
      - urn: urn:inflect:req:mapped:r1
        ref_id: R1
        depth: 1
  mappings:
    - source_urn: urn:inflect:req:mapped:r1
      target_urn: urn:inflect:req:other:x1
      strength: EQUAL
      rationale: Semantically equivalent requirements
`;
        const stored = parseLibraryString(withMappings);
        const loaded = loadLibrary(stored);

        expect(loaded.mappings).toHaveLength(1);
        expect(loaded.mappings[0].sourceUrn).toBe('urn:inflect:req:mapped:r1');
        expect(loaded.mappings[0].targetUrn).toBe('urn:inflect:req:other:x1');
        expect(loaded.mappings[0].strength).toBe('EQUAL');
        expect(loaded.mappings[0].rationale).toBe('Semantically equivalent requirements');
    });

    it('should load ISO 27001 mappings from disk', () => {
        const filePath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        // ISO library should have populated mappings
        expect(loaded.mappings.length).toBeGreaterThanOrEqual(60);
    });

    it('ISO mappings should reference valid URN formats', () => {
        const filePath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        for (const m of loaded.mappings) {
            expect(m.sourceUrn).toMatch(/^urn:inflect:req:iso27001-2022:/);
            expect(m.targetUrn).toMatch(/^urn:inflect:req:(soc2-2017|nis2-2022):/);
            expect(['EQUAL', 'SUPERSET', 'SUBSET', 'INTERSECT', 'RELATED']).toContain(m.strength);
        }
    });

    it('ISO mappings should have RELATED and INTERSECT strength distribution', () => {
        const filePath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        const strengths = loaded.mappings.map(m => m.strength);
        expect(strengths.filter(s => s === 'RELATED').length).toBeGreaterThan(0);
        expect(strengths.filter(s => s === 'INTERSECT').length).toBeGreaterThan(0);
    });
});

// ─── Schema Defaults Tests ──────────────────────────────────────────

describe('Schema Defaults', () => {
    it('should apply default kind=ISO_STANDARD when not specified', () => {
        const noKind = `
urn: urn:inflect:library:defaults
locale: en
ref_id: DEFAULTS
name: Defaults Test
version: 1
objects:
  framework:
    urn: urn:inflect:framework:defaults
    ref_id: DEFAULTS
    name: Defaults
    requirement_nodes:
      - urn: urn:inflect:req:defaults:r1
        ref_id: R1
        depth: 1
`;
        const stored = parseLibraryString(noKind);
        expect(stored.kind).toBe('ISO_STANDARD');
    });

    it('should apply default assessable=true when not specified', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);
        const r1 = loaded.framework.nodesByRefId.get('R1');
        expect(r1!.assessable).toBe(true);
    });

    it('should apply default depth=1 when not specified', () => {
        const noDepth = `
urn: urn:inflect:library:nodepth
locale: en
ref_id: NODEPTH
name: No Depth
version: 1
objects:
  framework:
    urn: urn:inflect:framework:nodepth
    ref_id: NODEPTH
    name: No Depth
    requirement_nodes:
      - urn: urn:inflect:req:nodepth:r1
        ref_id: R1
`;
        const stored = parseLibraryString(noDepth);
        expect(stored.objects.framework.requirement_nodes[0].depth).toBe(1);
    });
});

// ─── NIS2 Library Loading Tests ──────────────────────────────────────

describe('NIS2 Library Loading', () => {
    it('should parse NIS2 YAML file from disk', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nis2-2022.yaml');
        const stored = parseLibraryFile(filePath);
        expect(stored.urn).toBe('urn:inflect:library:nis2-2022');
        expect(stored.ref_id).toBe('NIS2-2022');
        expect(stored.kind).toBe('EU_DIRECTIVE');
    });

    it('should load NIS2 with correct structure', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nis2-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        expect(loaded.framework.name).toContain('NIS2');
        expect(loaded.kind).toBe('EU_DIRECTIVE');
        expect(loaded.provider).toBe('European Union');
    });

    it('should have 12 assessable requirement areas', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nis2-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        const assessable = loaded.framework.nodes.filter(n => n.assessable);
        expect(assessable.length).toBe(12);
    });

    it('should have parent/child structure for articles', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nis2-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        // Article 21 should be a parent with children
        const art21 = loaded.framework.nodesByRefId.get('Art21');
        expect(art21).toBeDefined();
        expect(art21!.assessable).toBe(false);
        expect(art21!.childUrns.length).toBeGreaterThan(0);
    });

    it('should have all known NIS2 requirement codes', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nis2-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        const codes = loaded.framework.nodes.filter(n => n.assessable).map(n => n.refId);
        expect(codes).toContain('NIS2-RM');
        expect(codes).toContain('NIS2-IR');
        expect(codes).toContain('NIS2-BC');
        expect(codes).toContain('NIS2-SC');
        expect(codes).toContain('NIS2-SD');
        expect(codes).toContain('NIS2-AS');
        expect(codes).toContain('NIS2-CH');
        expect(codes).toContain('NIS2-CR');
        expect(codes).toContain('NIS2-HR');
        expect(codes).toContain('NIS2-AM');
        expect(codes).toContain('NIS2-RE');
        expect(codes).toContain('NIS2-GOV');
    });

    it('NIS2 nodes should have artifacts and checklists', () => {
        const filePath = path.join(LIBRARIES_DIR, 'nis2-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        const assessable = loaded.framework.nodes.filter(n => n.assessable);
        for (const node of assessable) {
            expect(node.artifacts).toBeDefined();
            expect(node.artifacts!.length).toBeGreaterThan(0);
            expect(node.checklist).toBeDefined();
            expect(node.checklist!.length).toBeGreaterThan(0);
        }
    });
});

// ─── Artifacts & Checklist Schema Tests ──────────────────────────────

describe('Artifacts & Checklist Fields', () => {
    it('should parse YAML with artifacts and checklist', () => {
        const withArtifacts = `
urn: urn:inflect:library:artifacts-test
locale: en
ref_id: ARTIFACTS-TEST
name: Artifacts Test
version: 1
objects:
  framework:
    urn: urn:inflect:framework:artifacts-test
    ref_id: ARTIFACTS-TEST
    name: Artifacts Test
    requirement_nodes:
      - urn: urn:inflect:req:artifacts-test:r1
        ref_id: R1
        name: Test Requirement
        depth: 1
        artifacts: "Policy document, Procedure document"
        checklist:
          - Review existing policies
          - Draft new policies
          - Approve policies
`;
        const stored = parseLibraryString(withArtifacts);
        const node = stored.objects.framework.requirement_nodes[0];
        expect(node.artifacts).toBe('Policy document, Procedure document');
        expect(node.checklist).toEqual([
            'Review existing policies',
            'Draft new policies',
            'Approve policies',
        ]);
    });

    it('should pass artifacts and checklist through to LoadedRequirementNode', () => {
        const withArtifacts = `
urn: urn:inflect:library:artifacts-load
locale: en
ref_id: ARTIFACTS-LOAD
name: Artifacts Load
version: 1
objects:
  framework:
    urn: urn:inflect:framework:artifacts-load
    ref_id: ARTIFACTS-LOAD
    name: Artifacts Load
    requirement_nodes:
      - urn: urn:inflect:req:artifacts-load:r1
        ref_id: R1
        depth: 1
        artifacts: "Risk register, Security plan"
        checklist:
          - Step 1
          - Step 2
`;
        const stored = parseLibraryString(withArtifacts);
        const loaded = loadLibrary(stored);
        const node = loaded.framework.nodesByRefId.get('R1');
        expect(node!.artifacts).toBe('Risk register, Security plan');
        expect(node!.checklist).toEqual(['Step 1', 'Step 2']);
    });

    it('should allow nodes without artifacts or checklist (backward compatible)', () => {
        const stored = parseLibraryString(MINIMAL_LIBRARY_YAML);
        const loaded = loadLibrary(stored);
        const r1 = loaded.framework.nodesByRefId.get('R1');
        expect(r1!.artifacts).toBeUndefined();
        expect(r1!.checklist).toBeUndefined();
    });

    it('ISO 27001 clause nodes should have artifacts and checklists', () => {
        const filePath = path.join(LIBRARIES_DIR, 'iso27001-2022.yaml');
        const stored = parseLibraryFile(filePath);
        const loaded = loadLibrary(stored, filePath);

        // Clauses 4-10 should have artifacts
        for (const refId of ['4', '5', '6', '7', '8', '9', '10']) {
            const node = loaded.framework.nodesByRefId.get(refId);
            expect(node).toBeDefined();
            expect(node!.artifacts).toBeDefined();
            expect(node!.artifacts!.length).toBeGreaterThan(0);
            expect(node!.checklist).toBeDefined();
            expect(node!.checklist!.length).toBeGreaterThan(0);
        }
    });
});

// ─── parseLibraryFile error branches (fs-backed) ─────────────────────
// Exercises the read-failure / malformed-file / schema-invalid-file throws
// that the disk-fixture happy-path tests above do not reach, plus the
// scanLibraryDirectory skip-invalid catch.

describe('parseLibraryFile + scan error branches', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-loader-errs-'));
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws LibraryParseError (read failure) for a non-existent path', () => {
        const missing = path.join(tmpDir, 'does-not-exist.yaml');
        expect(() => parseLibraryFile(missing)).toThrow(LibraryParseError);
        try {
            parseLibraryFile(missing);
        } catch (err) {
            expect(err).toBeInstanceOf(LibraryParseError);
            expect((err as LibraryParseError).details).toBe('Failed to read file');
            expect((err as LibraryParseError).filePath).toBe(missing);
            expect((err as LibraryParseError).cause).toBeDefined();
        }
    });

    it('throws LibraryParseError (invalid YAML syntax) for a malformed file', () => {
        const p = path.join(tmpDir, 'malformed.yaml');
        fs.writeFileSync(p, 'foo: [1, 2', 'utf-8');
        try {
            parseLibraryFile(p);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(LibraryParseError);
            expect((err as LibraryParseError).details).toBe('Invalid YAML syntax');
        }
    });

    it('throws LibraryParseError (not an object) when the file is a bare scalar', () => {
        const p = path.join(tmpDir, 'scalar.yaml');
        fs.writeFileSync(p, '42', 'utf-8');
        try {
            parseLibraryFile(p);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(LibraryParseError);
            expect((err as LibraryParseError).details).toBe('YAML content is not an object');
        }
    });

    it('throws LibraryValidationError for a schema-invalid file', () => {
        const p = path.join(tmpDir, 'invalid.yaml');
        // Valid YAML object, but missing every required field.
        fs.writeFileSync(p, 'urn: urn:inflect:library:x\nlocale: en\n', 'utf-8');
        try {
            parseLibraryFile(p);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(LibraryValidationError);
            expect((err as LibraryValidationError).filePath).toBe(p);
            expect((err as LibraryValidationError).issues.length).toBeGreaterThan(0);
        }
    });

    it('scanLibraryDirectory skips files that fail to parse', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-scan-'));
        try {
            // One valid library, one malformed — only the valid one should surface.
            fs.writeFileSync(path.join(dir, 'good.yaml'), MINIMAL_LIBRARY_YAML, 'utf-8');
            fs.writeFileSync(path.join(dir, 'bad.yaml'), 'foo: [1, 2', 'utf-8');
            fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not yaml', 'utf-8');

            const entries = scanLibraryDirectory(dir);
            expect(entries).toHaveLength(1);
            expect(entries[0].urn).toBe('urn:inflect:library:test-framework');
            expect(entries[0].loaded).toBe(false);
            expect(entries[0].kind).toBe('CUSTOM');
            expect(entries[0].filePath).toContain('good.yaml');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('computeLibraryTextHash', () => {
    const base = parseLibraryString(MINIMAL_LIBRARY_YAML);
    const hash = computeLibraryTextHash(base);

    it('is a sha256 hex digest', () => {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('moves when a requirement is reworded, which the import hash does not see', () => {
        const nodes = base.objects.framework.requirement_nodes.map((n, i) =>
            i === 0 ? { ...n, description: 'Reworded first requirement' } : n,
        );
        const reworded = { ...base, objects: { ...base.objects, framework: { ...base.objects.framework, requirement_nodes: nodes } } };
        expect(computeLibraryTextHash(reworded)).not.toBe(hash);
        // The import's skip hash covers urns and the version only, so it
        // cannot tell the two apart. That blind spot is what the text hash is for.
        expect(loadLibrary(reworded).contentHash).toBe(loadLibrary(base).contentHash);
    });

    it('moves when framework metadata changes', () => {
        expect(computeLibraryTextHash({ ...base, copyright: 'Corrected attribution' })).not.toBe(hash);
    });

    it('ignores the version and the recorded hash itself', () => {
        expect(computeLibraryTextHash({ ...base, version: 7 })).toBe(hash);
        expect(computeLibraryTextHash({ ...base, text_hash: 'f'.repeat(64) })).toBe(hash);
    });

    it('ignores comments and formatting, since it reads the parsed library', () => {
        const commented = `# a comment\n${MINIMAL_LIBRARY_YAML.replace('name: Test Framework\n', 'name:   "Test Framework"   # same value\n')}`;
        expect(computeLibraryTextHash(parseLibraryString(commented))).toBe(hash);
    });
});
