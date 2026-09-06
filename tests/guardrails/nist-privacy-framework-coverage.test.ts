/**
 * NIST Privacy Framework v1.0 framework-content coverage ratchet.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * This guard decided the framework was AVAILABLE by grepping `prisma/seed.ts`
 * for `'NIST_PRIVACY_BASELINE'`. `prisma/seed.ts` is not run on production
 * deploys, so an assertion of that shape cannot fail while the thing it names
 * is undeliverable — and it DOES fail the day somebody fixes the delivery,
 * because the declaration moves into a CatalogFile. Five guards in this suite
 * have already gone red exactly that way, each on the change that made its
 * framework reachable for the first time.
 *
 * ═══ AND HERE THE ANSWER IS THAT THERE IS NO DELIVERY ═══
 *
 * NIST-PRIVACY has no CatalogFile and no production writer of ANY kind.
 * `scripts/seed-framework-catalogs.ts` applies seven fixtures (soc2, ssdf,
 * cis-v8-ig1, asvs-l1, iso27701, dora, nis2) and this is not one of them; the
 * runtime library provider reads `nist-privacy-framework-1.0.yaml` for lookup
 * shapes but writes no `Framework` and no `FrameworkPack` row, and pack
 * install reads `frameworkPack` from the database. Production therefore has no
 * NIST Privacy framework, and `NIST_PRIVACY_BASELINE` names a pack row no
 * customer has.
 *
 * So the seed cases below are deliberately NOT repointed at a delivery path.
 * Inventing one would make this guard assert something false, which is a worse
 * outcome than a weak assertion. Instead:
 *   - the availability question is asked SOURCE-AGNOSTICALLY, through
 *     `declaringSources`, so the day a CatalogFile lands and the declaration
 *     leaves `seed.ts` this guard stays green rather than reddening on the fix;
 *   - the remaining `seed.ts` cases are relabelled for what they actually check
 *     — the content of a DEV-ONLY seeder — and rebound to the declarations they
 *     name instead of scanning the whole file;
 *   - the gap itself is NOT asserted. A case pinning "nothing production-side
 *     declares this" would be the same defect mirrored: red on the fix.
 *
 * ═══ WHAT THIS LOCKS ═══
 *   - nist-privacy-framework-1.0.yaml validates against the library schema
 *     (NIST_FRAMEWORK);
 *   - all 5 privacy Functions (IDENTIFY-P/GOVERN-P/CONTROL-P/COMMUNICATE-P/
 *     PROTECT-P) and their Categories are represented as grouping nodes;
 *   - assessable ref_ids follow the Subcategory numbering (e.g. ID.IM-P1);
 *   - PUBLIC DOMAIN (NIST): the copyright is the NIST public-information
 *     notice (no license friction, unlike the copyrighted ISO standards), and
 *     the library and the dev seed agree on it;
 *   - the seed fixture codes match the library assessable ref_ids (in sync);
 *   - the CSF + ISO 27001 crosswalks exist, declare the right frameworks, and
 *     have no dangling refs;
 *   - the framework rides the GENERIC framework-install machinery (no
 *     special-casing).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appliedCatalogueStats, declaringSources } from '../helpers/applied-catalogue';
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
        // Was a raw-YAML tail slice — `yaml.slice(yaml.indexOf('copyright:'))`
        // runs to EOF, so ANY later line in the file could satisfy these two
        // patterns while `copyright:` itself said something else. The parser
        // already exposes the field; read it.
        expect(pf.provider).toBe('NIST');
        expect(pf.copyright ?? '').toMatch(/public information/i);
        expect(pf.copyright ?? '').toMatch(/distributed or copied/i);
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

describe('NIST Privacy Framework declaration (source-agnostic)', () => {
    /**
     * The availability question, asked of the APPLIED corpus rather than of one
     * file. `declaringSources` spans `prisma/seed.ts` AND every fixture a
     * production seeder names, so this case is satisfied today by the dev
     * seeder and would still be satisfied by a CatalogFile that replaced it —
     * which is the whole point, since the previous `expect(seed).toContain(…)`
     * would have gone red on precisely that improvement.
     *
     * It is not a claim that the framework reaches production. It does not; see
     * the file docblock. Asserting the gap is deliberately omitted.
     */
    it('the applied-catalogue scan has a real corpus to answer from', () => {
        // DENOMINATOR. Without it, a missing declaration and a broken scan are
        // the same observation: both return an empty array, and the case below
        // would then be reporting on a corpus it never actually read.
        const stats = appliedCatalogueStats();
        expect(stats.seeders.length).toBeGreaterThan(0);
        expect(stats.fixtures.length).toBeGreaterThan(0);
        expect(stats.bytes).toBeGreaterThan(0);
    });

    it('something applied declares the NIST-PRIVACY framework and its baseline pack', () => {
        expect(declaringSources('NIST-PRIVACY').length).toBeGreaterThan(0);
        expect(declaringSources('NIST_PRIVACY_BASELINE').length).toBeGreaterThan(0);
    });
});

describe('NIST Privacy Framework dev seed content (prisma/seed.ts — reaches no production database)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the fixture + upserts the framework', () => {
        // Bound to the declarations rather than scanned across the whole file.
        // The framework case previously carried an interior any-char span,
        // `/key: 'NIST-PRIVACY'[\s\S]{0,200}kind: 'NIST_FRAMEWORK'/`, which
        // re-forms across a SIBLING upsert — the file holds dozens — so the
        // NIST-PRIVACY block could lose its `kind` and a neighbour's would
        // satisfy the match. Two field-shaped assertions inside one bounded
        // declaration cannot do that.
        expect(declarationOf(seed, 'nistPrivacyData')).toContain(
            'nist_privacy_framework_requirements.json',
        );
        const fw = declarationOf(seed, 'nistPrivacy');
        expect(fw).toMatch(/key:\s*'NIST-PRIVACY',\s*version:\s*'1\.0'/);
        expect(fw).toMatch(/kind:\s*'NIST_FRAMEWORK'/);
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

    it('the dev pack row names the framework and the 1.0 version', () => {
        // `expect(seed).toContain("'NIST_PRIVACY_BASELINE'")` moved up to the
        // source-agnostic describe. `expect(seed).toMatch(/frameworkPack\.upsert/)`
        // was DELETED rather than repointed: 16 positions in `prisma/seed.ts`
        // satisfy it, so it was already a tautology — the whole NIST Privacy
        // block could be deleted and it would still pass.
        const pack = declarationOf(seed, 'nistPrivacyPack');
        expect(pack).toMatch(/key:\s*'NIST_PRIVACY_BASELINE'/);
        expect(pack).toMatch(/frameworkId:\s*nistPrivacy\.id/);
        expect(pack).toMatch(/version:\s*'1\.0'/);
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
