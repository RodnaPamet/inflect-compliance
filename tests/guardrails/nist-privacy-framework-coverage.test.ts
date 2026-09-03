/**
 * NIST Privacy Framework v1.0 framework-content coverage ratchet.
 *
 * The NIST Privacy Framework ships as framework CONTENT on IC's existing
 * data-driven library machinery (no new code paths) — the privacy companion to
 * NIST CSF 2.0, cloned from nist-csf-2.0.yaml. This guard locks:
 *   - nist-privacy-framework-1.0.yaml validates against the library schema
 *     (NIST_FRAMEWORK);
 *   - all 5 privacy Functions (IDENTIFY-P/GOVERN-P/CONTROL-P/COMMUNICATE-P/
 *     PROTECT-P) and their Categories are represented as grouping nodes;
 *   - assessable ref_ids follow the Subcategory numbering (e.g. ID.IM-P1);
 *   - PUBLIC DOMAIN (NIST): the copyright line is the NIST public-information
 *     notice (no license friction, unlike the copyrighted ISO standards);
 *   - the seed fixture codes match the library assessable ref_ids (in sync) and
 *     the seed upserts the framework + NIST_PRIVACY_BASELINE pack;
 *   - the CSF + ISO 27001 crosswalks exist, declare the right frameworks, and
 *     have no dangling refs;
 *   - the framework rides the GENERIC framework-install machinery (no
 *     special-casing).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, declarationOf } from '../helpers/source-blocks';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const LIB = 'src/data/libraries';

const pf = loadLibrary(
    parseLibraryFile(path.join(ROOT, LIB, 'nist-privacy-framework-1.0.yaml')),
    'nist-privacy',
);

const PRIVACY_FUNCTIONS = ['ID-P', 'GV-P', 'CT-P', 'CM-P', 'PR-P'];
const PRIVACY_CATEGORIES = [
    'ID.IM-P', 'ID.BE-P', 'ID.RA-P', 'ID.DE-P',
    'GV.PO-P', 'GV.RM-P', 'GV.AT-P', 'GV.MT-P',
    'CT.PO-P', 'CT.DM-P', 'CT.DP-P',
    'CM.PO-P', 'CM.AW-P',
    'PR.PO-P', 'PR.AC-P', 'PR.DS-P', 'PR.MA-P', 'PR.PT-P',
];

describe('NIST Privacy Framework library — nist-privacy-framework-1.0.yaml', () => {
    it('validates against the library schema as a NIST_FRAMEWORK', () => {
        expect(pf.refId).toBe('NIST-PF-1.0');
        expect(pf.kind).toBe('NIST_FRAMEWORK');
        expect(pf.version).toBeGreaterThanOrEqual(1);
    });

    it('represents all 5 privacy Functions as grouping nodes', () => {
        for (const f of PRIVACY_FUNCTIONS) {
            const node = pf.framework.nodesByRefId.get(f);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('represents all 18 privacy Categories as grouping nodes', () => {
        for (const c of PRIVACY_CATEGORIES) {
            const node = pf.framework.nodesByRefId.get(c);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('assessable ref_ids follow the Subcategory numbering', () => {
        const assessable = pf.framework.nodes.filter((n) => n.assessable);
        expect(assessable.length).toBeGreaterThanOrEqual(90);
        for (const n of assessable) {
            // e.g. ID.IM-P1, GV.PO-P6, CT.DM-P10, PR.PT-P4
            expect(n.refId).toMatch(/^[A-Z]{2}\.[A-Z]{2}-P\d+$/);
            expect(n.parentUrn).toBeDefined();
        }
        // Spot-check anchors across the 5 Functions.
        for (const ref of ['ID.IM-P1', 'GV.PO-P1', 'CT.DM-P10', 'CM.AW-P7', 'PR.DS-P1', 'PR.PT-P4']) {
            expect(pf.framework.nodesByRefId.get(ref)).toBeDefined();
        }
    });

    it('carries the NIST public-domain copyright (not a copyrighted standard)', () => {
        const yaml = readRaw(`${LIB}/nist-privacy-framework-1.0.yaml`);
        const copyrightBlock = yaml.slice(yaml.indexOf('copyright:'));
        expect(copyrightBlock).toMatch(/public information/i);
        expect(copyrightBlock).toMatch(/distributed or copied/i);
    });
});

describe('NIST Privacy Framework seed fixture', () => {
    const fixture = JSON.parse(readRaw('prisma/fixtures/nist_privacy_framework_requirements.json')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

    it('every fixture entry has the required shape + Subcategory key', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(90);
        for (const r of fixture) {
            expect(r.key).toMatch(/^[A-Z]{2}\.[A-Z]{2}-P\d+$/);
            expect(r.section).toBeTruthy();
            expect(r.title).toBeTruthy();
        }
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            pf.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });
});

describe('NIST Privacy Framework seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the fixture + upserts the framework', () => {
        expect(seed).toContain('nist_privacy_framework_requirements.json');
        expect(seed).toMatch(/key:\s*'NIST-PRIVACY',\s*version:\s*'1\.0'/);
        expect(seed).toMatch(/key:\s*'NIST-PRIVACY'[\s\S]{0,200}kind:\s*'NIST_FRAMEWORK'/);
    });

    it('persists NIST provider + public-domain notice in framework metadata', () => {
        // #2246 Class A — this read the WHOLE seed file and matched
        // /public[\s-]*information/i, which in `prisma/seed.ts` is satisfied
        // only by the `// PUBLIC DOMAIN (NIST): …` banner comment above the
        // block. In CODE the same sentence is split across two adjacent
        // string literals (`'… considered public ' + 'information …'`), which
        // no character class can cross. Bind to the metadata declaration
        // itself and name both halves.
        const meta = declarationOf(seed, 'nistPrivacyMeta');
        expect(meta).toMatch(/provider:\s*'NIST'/);
        expect(meta).toMatch(/license:\s*'public-domain'/);
        expect(meta).toMatch(
            /'Information presented on NIST sites is considered public '\s*\+\s*'information and may be distributed or copied\.'/,
        );
    });

    it('seeds a NIST Privacy Framework pack (idempotent upsert)', () => {
        expect(seed).toContain("'NIST_PRIVACY_BASELINE'");
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });
});

describe('NIST Privacy Framework cross-framework mappings', () => {
    const nist = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'nist-csf-2.0.yaml')), 'nist');
    const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso27001-2022.yaml')), 'iso');
    const pfRefs = new Set(pf.framework.nodes.map((n) => n.refId));

    const cases: Array<{ file: string; targetLib: Set<string>; targetRef: string }> = [
        { file: 'nist-privacy-framework-to-nist-csf.yaml', targetLib: new Set(nist.framework.nodes.map((n) => n.refId)), targetRef: 'NIST-CSF-2.0' },
        { file: 'nist-privacy-framework-to-iso27001.yaml', targetLib: new Set(iso.framework.nodes.map((n) => n.refId)), targetRef: 'ISO27001-2022' },
    ];

    for (const c of cases) {
        describe(c.file, () => {
            const set = parseMappingSetFile(path.join(ROOT, LIB, 'mappings', c.file));

            it('declares the NIST Privacy Framework as source + the expected target', () => {
                expect(set.source_framework_ref).toBe('NIST-PF-1.0');
                expect(set.target_framework_ref).toBe(c.targetRef);
                expect(set.mapping_entries.length).toBeGreaterThanOrEqual(10);
            });

            it('every mapped requirement resolves against the libraries (no dangling refs)', () => {
                const dangling: string[] = [];
                for (const e of set.mapping_entries) {
                    if (!pfRefs.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
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

describe('NIST Privacy Framework rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no NIST-Privacy-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            const src = read(rel);
            expect(src).not.toMatch(/NIST-PRIVACY/);
            expect(src).not.toMatch(/NIST_PRIVACY/);
        }
    });
});
