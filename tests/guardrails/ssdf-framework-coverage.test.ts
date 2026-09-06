/**
 * NIST SSDF (SP 800-218) framework-content coverage ratchet.
 *
 * The NIST Secure Software Development Framework ships as framework CONTENT on
 * IC's existing data-driven library machinery (no new code paths), cloned from
 * the nist-csf-2.0.yaml three-level structure. This guard locks:
 *   - nist-ssdf-800-218.yaml validates against the library schema
 *     (NIST_FRAMEWORK);
 *   - all four practice groups (PO/PS/PW/RV) and their practices are
 *     represented as grouping nodes;
 *   - assessable ref_ids follow the SSDF task numbering (e.g. PO.1.1);
 *   - PUBLIC DOMAIN (NIST): the copyright line is the NIST public-information
 *     notice (no license friction);
 *   - the seed fixture codes match the library assessable ref_ids (in sync) and
 *     the seed upserts the framework + NIST_SSDF_BASELINE pack;
 *   - the CSF + ISO 27001 + SOC 2 crosswalks exist, declare the right
 *     frameworks, and have no dangling refs;
 *   - the framework rides the GENERIC framework-install machinery (no
 *     special-casing).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
import { codeOf, declarationOf } from '../helpers/source-blocks';
import { appliedCatalogFor } from '../helpers/applied-catalogue';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/**
 * Source read with COMMENTS MASKED (#2246) — the seam for the .ts assertions
 * below. Deliberately NOT used for the YAML/JSON reads: `codeOf` blanks `//`
 * to end-of-line, which in a library YAML eats the `https://…` provenance
 * URLs the copyright assertions match on.
 */
const readCode = (rel: string) => codeOf(read(rel));
const LIB = 'src/data/libraries';

const ssdf = loadLibrary(
    parseLibraryFile(path.join(ROOT, LIB, 'nist-ssdf-800-218.yaml')),
    'nist-ssdf',
);

const GROUPS = ['PO', 'PS', 'PW', 'RV'];
const PRACTICES = [
    'PO.1', 'PO.2', 'PO.3', 'PO.4', 'PO.5',
    'PS.1', 'PS.2', 'PS.3',
    'PW.1', 'PW.2', 'PW.4', 'PW.5', 'PW.6', 'PW.7', 'PW.8', 'PW.9',
    'RV.1', 'RV.2', 'RV.3',
];

describe('NIST SSDF library — nist-ssdf-800-218.yaml', () => {
    it('validates against the library schema as a NIST_FRAMEWORK', () => {
        expect(ssdf.refId).toBe('NIST-SSDF-800-218');
        expect(ssdf.kind).toBe('NIST_FRAMEWORK');
        expect(ssdf.version).toBeGreaterThanOrEqual(1);
    });

    it('represents all four practice groups as grouping nodes', () => {
        for (const g of GROUPS) {
            const node = ssdf.framework.nodesByRefId.get(g);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('represents all 19 practices as grouping nodes', () => {
        for (const p of PRACTICES) {
            const node = ssdf.framework.nodesByRefId.get(p);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('assessable ref_ids follow the SSDF task numbering', () => {
        const assessable = ssdf.framework.nodes.filter((n) => n.assessable);
        expect(assessable.length).toBeGreaterThanOrEqual(40);
        for (const n of assessable) {
            // e.g. PO.1.1, PS.3.2, PW.8.2, RV.3.4
            expect(n.refId).toMatch(/^(PO|PS|PW|RV)\.\d+\.\d+$/);
            expect(n.parentUrn).toBeDefined();
        }
        // Spot-check anchors across the four groups.
        for (const ref of ['PO.1.1', 'PS.1.1', 'PW.1.1', 'PW.8.2', 'RV.1.1', 'RV.3.4']) {
            expect(ssdf.framework.nodesByRefId.get(ref)).toBeDefined();
        }
    });

    it('carries the NIST public-domain copyright (not a copyrighted standard)', () => {
        const yaml = read(`${LIB}/nist-ssdf-800-218.yaml`);
        const copyrightBlock = yaml.slice(yaml.indexOf('copyright:'));
        expect(copyrightBlock).toMatch(/public information/i);
        expect(copyrightBlock).toMatch(/distributed or copied/i);
    });
});

describe('NIST SSDF seed fixture', () => {
    const fixture = JSON.parse(read('prisma/fixtures/nist_ssdf_requirements.json')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

    it('every fixture entry has the required shape + task key', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(40);
        for (const r of fixture) {
            expect(r.key).toMatch(/^(PO|PS|PW|RV)\.\d+\.\d+$/);
            expect(r.section).toBeTruthy();
            expect(r.title).toBeTruthy();
        }
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            ssdf.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });
});

describe('NIST SSDF delivery', () => {
    /**
     * This block asked whether `prisma/seed.ts` CONTAINED the SSDF wiring —
     * the fixture filename, a key/version pair, the literal
     * 'NIST_SSDF_BASELINE'. Every one of those was a claim about a file that
     * is not run on production deploys, so all of them were green while the
     * framework's reachability was never in question here at all.
     *
     * Two of them were worse than weak. `'NIST_SSDF_BASELINE'` is the pack
     * seed.ts builds; production has SSDF_CORE, so the assertion named a row
     * no customer has. And the kind check carried a 260-character interior
     * span, which re-forms across a sibling block — the Class C shape this
     * repo ratchets down.
     *
     * It now asks the catalogue what it declares. The attribution assertions
     * moved with it and got stronger: the licensing statements are in the
     * fixture production actually applies, not only in the dev seeder.
     */
    const catalog = appliedCatalogFor('NIST-SSDF');

    it('a production seeder applies a NIST SSDF catalogue at all', () => {
        // Every case below is vacuous on null. This is the denominator: if
        // SSDF ever leaves CATALOG_FIXTURES, that is a delivery regression and
        // must fail here rather than quietly skip.
        expect(catalog).not.toBeNull();
        expect(catalog?.requirements.length).toBeGreaterThanOrEqual(40);
        expect(catalog?.templates.length).toBeGreaterThanOrEqual(15);
    });

    it('declares the framework as NIST-SSDF 1.1, kind NIST_FRAMEWORK', () => {
        expect(catalog?.framework.key).toBe('NIST-SSDF');
        expect(catalog?.framework.version).toBe('1.1');
        expect(catalog?.framework.kind).toBe('NIST_FRAMEWORK');
    });

    it('carries the NIST provider and public-domain notice', () => {
        // Field reads rather than a regex over a source file: the metadata is
        // structured data in the fixture, so there is nothing to pattern-match
        // and no span to reach out of the block it names.
        const meta = (catalog?.framework.metadata ?? {}) as Record<string, unknown>;
        expect(meta.provider).toBe('NIST');
        expect(meta.license).toBe('public-domain');
        expect(String(meta.copyright)).toContain('considered public information');
    });

    it('notes the SSDF federal self-attestation context (EO 14028 / OMB M-22-18)', () => {
        // Read the field that holds it rather than stringifying the whole
        // object: `JSON.stringify(meta)` is satisfied by the string appearing
        // under ANY key, so the assertion would survive the attestation note
        // moving into an unrelated field — and it is a subject the
        // assertion-reach analyser cannot resolve, which makes it a blind spot
        // in the Class D denominator besides.
        const meta = (catalog?.framework.metadata ?? {}) as Record<string, unknown>;
        expect(String(meta.selfAttestation)).toContain('EO 14028');
        expect(String(meta.selfAttestation)).toContain('M-22-18');
    });

    it('declares the pack production actually has', () => {
        // SSDF_CORE, not seed.ts's NIST_SSDF_BASELINE. pack-key-agreement
        // records that divergence and shrinks when the seed.ts block goes.
        expect(catalog?.pack?.key).toBe('SSDF_CORE');
    });
});

describe('NIST SSDF cross-framework mappings', () => {
    const csf = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'nist-csf-2.0.yaml')), 'csf');
    const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso27001-2022.yaml')), 'iso');
    const soc2 = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'soc2-2017.yaml')), 'soc2');
    const ssdfRefs = new Set(ssdf.framework.nodes.map((n) => n.refId));

    const cases: Array<{ file: string; targetLib: Set<string>; targetRef: string }> = [
        { file: 'ssdf-to-nist-csf.yaml', targetLib: new Set(csf.framework.nodes.map((n) => n.refId)), targetRef: 'NIST-CSF-2.0' },
        { file: 'ssdf-to-iso27001.yaml', targetLib: new Set(iso.framework.nodes.map((n) => n.refId)), targetRef: 'ISO27001-2022' },
        { file: 'ssdf-to-soc2.yaml', targetLib: new Set(soc2.framework.nodes.map((n) => n.refId)), targetRef: 'SOC2-2017' },
    ];

    for (const c of cases) {
        describe(c.file, () => {
            const set = parseMappingSetFile(path.join(ROOT, LIB, 'mappings', c.file));

            it('declares the NIST SSDF as source + the expected target', () => {
                expect(set.source_framework_ref).toBe('NIST-SSDF-800-218');
                expect(set.target_framework_ref).toBe(c.targetRef);
                expect(set.mapping_entries.length).toBeGreaterThanOrEqual(10);
            });

            it('every mapped requirement resolves against the libraries (no dangling refs)', () => {
                const dangling: string[] = [];
                for (const e of set.mapping_entries) {
                    if (!ssdfRefs.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
                    if (!c.targetLib.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
                }
                expect(dangling).toEqual([]);
            });

            it('marks provenance on every mapping ([NIST-crosswalk] or [curated])', () => {
                for (const e of set.mapping_entries) {
                    expect(e.rationale ?? '').toMatch(/\[(NIST-crosswalk|curated)\]/);
                }
            });
        });
    }
});

describe('NIST SSDF rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no SSDF-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            const src = readCode(rel);
            expect(src).not.toMatch(/NIST-SSDF/);
            expect(src).not.toMatch(/NIST_SSDF/);
        }
    });
});
