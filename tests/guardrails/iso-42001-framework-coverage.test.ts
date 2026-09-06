/**
 * ISO/IEC 42001:2023 framework-content coverage ratchet.
 *
 * ISO 42001 (AI Management System) ships as framework CONTENT on IC's existing
 * data-driven library machinery (no new code paths). This guard locks:
 *   - iso-42001.yaml exists + validates against the library schema (ISO_STANDARD);
 *   - the management clauses (4-10) AND the Annex A objectives (A.2-A.10) are
 *     represented; assessable ref_ids follow the clause/control numbering;
 *   - LICENSE: ISO 42001 is COPYRIGHTED — the yaml stores clause/control numbers
 *     + SHORT PARAPHRASED titles only (no verbatim ISO text; a length ceiling +
 *     a "(Paraphrase" marker enforce it), and the copyright points at ISO;
 *   - the seed fixture codes match the library assessable ref_ids (in sync);
 *   - the ISO 42001 clause references that DO reach production — the
 *     AI-governance self-assessment's `mappings.iso42001` — resolve in the
 *     library, and that fixture carries the clause-references-only attribution;
 *   - ISO 42001 rides the GENERIC framework-install machinery (no special-casing).
 *
 * ═══ DELIVERY: what this guard may and may not claim ═══
 *
 * ISO 42001 has NO CatalogFile. `CATALOG_FIXTURES` in
 * `scripts/seed-framework-catalogs.ts` holds seven frameworks and ISO 42001 is
 * not one of them, so no seeder `scripts/entrypoint.sh` runs writes the
 * framework, its requirements or its pack. The only writer is
 * `prisma/seed.ts`, which is applied by `npm run db:seed` in dev and on no
 * production deploy.
 *
 * That is why the seed-wiring block below still reads `prisma/seed.ts` and is
 * now NAMED for what it is. It is NOT evidence that ISO 42001 is installable
 * for a customer, and the `ISO42001_BASELINE` pack literal it asserts names a
 * row no production database has. The delivery block states that gap in an
 * assertion rather than in prose, and carries the strong catalogue checks
 * pre-wired so that shipping a CatalogFile makes this guard stronger instead
 * of turning it red — the failure mode that took five guards in this suite.
 *
 * Two things about ISO 42001 DO reach production and are asserted as such:
 * `src/data/libraries/iso-42001.yaml`, which the app process loads at runtime
 * via `framework-provider.ts` (`loadAllFromDirectory(src/data/libraries)`),
 * and the ISO clause references inside
 * `prisma/fixtures/ai-governance-self-assessment.json`, applied on every
 * container start by `scripts/seed-self-assessments.ts`.
 *
 * AISVS/EU-AI-Act crosswalks are locked separately by the bundle ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    appliedCatalogFor,
    appliedSources,
    declaringSources,
    productionDeclaringSources,
} from '../helpers/applied-catalogue';
import { codeOf, declarationOf } from '../helpers/source-blocks';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

const ROOT = path.resolve(__dirname, '../..');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const LIB = 'src/data/libraries';

const iso = loadLibrary(parseLibraryFile(path.join(ROOT, LIB, 'iso-42001.yaml')), 'iso42001');

describe('ISO 42001 library — iso-42001.yaml', () => {
    it('validates against the library schema as an ISO_STANDARD', () => {
        expect(iso.refId).toBe('ISO42001-2023');
        expect(iso.kind).toBe('ISO_STANDARD');
        expect(iso.version).toBeGreaterThanOrEqual(1);
    });

    it('represents management clauses 4-10 as grouping nodes', () => {
        for (const c of ['4', '5', '6', '7', '8', '9', '10']) {
            const node = iso.framework.nodesByRefId.get(c);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('represents Annex A objectives A.2-A.10 as grouping nodes', () => {
        for (const o of ['A.2', 'A.3', 'A.4', 'A.5', 'A.6', 'A.7', 'A.8', 'A.9', 'A.10']) {
            const node = iso.framework.nodesByRefId.get(o);
            expect(node).toBeDefined();
            expect(node!.assessable).toBe(false);
            expect(node!.childUrns.length).toBeGreaterThan(0);
        }
    });

    it('assessable ref_ids follow the clause / Annex-control numbering', () => {
        const assessable = iso.framework.nodes.filter((n) => n.assessable);
        expect(assessable.length).toBeGreaterThanOrEqual(50);
        for (const n of assessable) {
            // Clause sub-requirements (e.g. 4.1, 6.2) OR Annex controls (A.6.2.4).
            expect(n.refId).toMatch(/^(\d+\.\d+|A\.\d+(\.\d+){1,2})$/);
            expect(n.parentUrn).toBeDefined();
        }
        // Spot-check anchors across the standard.
        for (const ref of ['4.1', '6.2', '8.2', '10.2', 'A.2.2', 'A.6.2.4', 'A.10.4']) {
            expect(iso.framework.nodesByRefId.get(ref)).toBeDefined();
        }
    });

    // ── LICENSE SAFETY: paraphrase, not verbatim ISO text ──
    it('stores SHORT paraphrased titles + (Paraphrase) markers, not ISO prose', () => {
        const offenders: string[] = [];
        for (const n of iso.framework.nodes.filter((x) => x.assessable)) {
            const title = n.name ?? '';
            if (title.trim().split(/\s+/).length > 14 || title.length > 100) {
                offenders.push(`${n.refId}: "${title}"`);
            }
            if (!/\(Paraphrase/i.test(n.description ?? '')) {
                offenders.push(`${n.refId}: description missing (Paraphrase) marker`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the copyright points at ISO and disclaims verbatim reproduction', () => {
        const yaml = readRaw(`${LIB}/iso-42001.yaml`);
        const copyrightBlock = yaml.slice(yaml.indexOf('copyright:'));
        expect(copyrightBlock.toLowerCase()).toContain('iso.org');
        expect(copyrightBlock).toMatch(/NOT a reproduction|structural outline/i);
    });
});

describe('ISO 42001 seed fixture', () => {
    const fixture = JSON.parse(readRaw('prisma/fixtures/iso_42001_requirements.json')) as Array<{
        key: string; section: string; sortOrder: number; title: string;
    }>;

    it('every fixture entry has the required shape + clause/control key', () => {
        expect(fixture.length).toBeGreaterThanOrEqual(50);
        for (const r of fixture) {
            expect(r.key).toMatch(/^(\d+\.\d+|A\.\d+(\.\d+){1,2})$/);
            expect(r.section).toBeTruthy();
            expect(r.title).toBeTruthy();
        }
        expect(new Set(fixture.map((r) => r.key)).size).toBe(fixture.length);
    });

    it('fixture codes match the library assessable ref_ids (two representations in sync)', () => {
        const fixtureKeys = new Set(fixture.map((r) => r.key));
        const libAssessable = new Set(
            iso.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
        );
        expect(fixtureKeys).toEqual(libAssessable);
    });
});

describe('ISO 42001 delivery', () => {
    /**
     * The question this block asks used to be "does prisma/seed.ts contain the
     * string ISO42001_BASELINE?", which is a claim about a file production
     * never runs — green whether or not a customer can install ISO 42001, and
     * red the day somebody makes them able to, because the declaration would
     * move into a CatalogFile.
     *
     * ISO 42001 has no CatalogFile today, so there is no production catalogue
     * to repoint onto and inventing one would be worse than the weak
     * assertion. What is asserted instead is the delivery STATE: either a
     * production seeder applies an ISO 42001 catalogue — in which case the
     * catalogue is the authority and is checked as one — or the only
     * declaration is the dev seeder, in which case that is said out loud.
     */
    const catalog = appliedCatalogFor('ISO42001');

    it('either production applies an ISO 42001 catalogue, or only the dev seeder declares it', () => {
        // DENOMINATOR. Both arms assert; neither is vacuous. If the applied
        // corpus stops seeing prisma/seed.ts at all, the else arm fails —
        // a broken scan reads as a broken scan, not as an absent declaration.
        if (catalog !== null) {
            expect(catalog.framework.key).toBe('ISO42001');
            expect(catalog.framework.kind).toBe('ISO_STANDARD');
            expect(catalog.requirements.length).toBeGreaterThanOrEqual(50);
        } else {
            expect(declaringSources('ISO42001_BASELINE')).toContain('prisma/seed.ts');
            // The pack seed.ts builds reaches no production database. Stated
            // here so the gap is a fact this file knows, not one it hides.
            expect(productionDeclaringSources('ISO42001_BASELINE')).toEqual([]);
        }
    });
});

describe('ISO 42001 references that DO reach production', () => {
    /**
     * `prisma/fixtures/ai-governance-self-assessment.json` is applied on every
     * container start by `scripts/seed-self-assessments.ts`, and its questions
     * carry `mappings.iso42001` clause references. That is the only ISO 42001
     * content a customer actually has, so the license posture (clause
     * references only, paraphrased, © ISO/IEC) and the resolvability of those
     * references are asserted against THAT file rather than against the dev
     * seeder alone.
     */
    const AIG = 'prisma/fixtures/ai-governance-self-assessment.json';
    const source = appliedSources().find((s) => s.file === AIG);
    const doc = source
        ? (JSON.parse(source.text) as {
              attribution: string;
              questions: Array<{ id: string; mappings: { iso42001: string[] } }>;
          })
        : null;
    const isoRefs = (doc?.questions ?? []).flatMap((q) => q.mappings?.iso42001 ?? []);

    it('a production seeder applies the AI-governance question set at all', () => {
        // DENOMINATOR. Every case below is vacuous on a missing source or an
        // empty ref list.
        expect(source).toBeDefined();
        expect(source?.reachesProduction).toBe(true);
        expect(isoRefs.length).toBeGreaterThanOrEqual(20);
    });

    it('every ISO 42001 clause reference resolves in the library', () => {
        const known = new Set(iso.framework.nodes.map((n) => n.refId));
        const dangling: string[] = [];
        for (const ref of new Set(isoRefs)) {
            // The question set cites sub-clauses (6.1.2) the library models at
            // clause granularity (6.1), so a reference resolves exactly or at
            // its parent clause. Anything else names a clause IC does not have.
            const parent = ref.split('.').slice(0, 2).join('.');
            if (!known.has(ref) && !known.has(parent)) dangling.push(ref);
        }
        expect(dangling).toEqual([]);
    });

    it('attributes ISO 42001 as clause references only, © ISO/IEC', () => {
        expect(doc?.attribution).toContain('ISO/IEC 42001:2023');
        expect(doc?.attribution).toContain('clause references only');
        expect(doc?.attribution).toContain('© ISO/IEC');
        expect(doc?.attribution).toMatch(/paraphrased references, not verbatim/i);
    });
});

describe('ISO 42001 dev-only seed wiring (prisma/seed.ts — reaches no deploy)', () => {
    /**
     * Kept, and renamed to stop it reading as a delivery claim. The
     * attribution assertions here are load-bearing — ISO 42001 is a
     * copyrighted standard and the metadata IC writes is what records that IC
     * stores a reference index rather than the text — but seed.ts is the only
     * place that metadata exists today, so this is where they have to live
     * until an ISO 42001 CatalogFile does. When one lands, they move to
     * `catalog.framework.metadata` the way SSDF's did.
     *
     * Each read is bounded to the declaration it names (`declarationOf`)
     * rather than matched across the whole file: the old kind check spanned
     * 200 arbitrary characters between `key:` and `kind:`, which re-forms
     * across a sibling framework block and is the Class C shape this repo
     * ratchets down.
     */
    const seed = read('prisma/seed.ts');

    it('reads the ISO 42001 fixture', () => {
        const data = declarationOf(seed, 'iso42001Data');
        expect(data).toContain('iso_42001_requirements.json');
    });

    it('upserts the framework as ISO42001 2023, kind ISO_STANDARD', () => {
        const framework = declarationOf(seed, 'iso42001');
        expect(framework).toContain("key: 'ISO42001'");
        expect(framework).toContain("version: '2023'");
        expect(framework).toContain("kind: 'ISO_STANDARD'");
    });

    it('persists ISO provider + copyright disclaimer in framework metadata', () => {
        const meta = declarationOf(seed, 'iso42001Meta');
        expect(meta).toContain("provider: 'ISO/IEC'");
        expect(meta).toContain("license: 'ISO-copyright'");
        expect(meta).toMatch(/referenceIndexOnly:\s*true/);
        expect(meta).toMatch(/NOT a reproduction of the/i);
    });

    it('builds the dev-only ISO42001_BASELINE pack', () => {
        // Named for what it is: production has no ISO 42001 pack under this
        // key or any other — see the delivery block above.
        const pack = declarationOf(seed, 'iso42001Pack');
        expect(pack).toMatch(/where:\s*\{\s*key:\s*'ISO42001_BASELINE'\s*\}/);
    });
});

describe('ISO 42001 rides the generic framework machinery (no special-casing)', () => {
    it('install + catalog usecases contain no ISO42001-specific branching', () => {
        for (const rel of [
            'src/app-layer/usecases/framework/install.ts',
            'src/app-layer/usecases/framework/catalog.ts',
        ]) {
            expect(read(rel)).not.toMatch(/42001/);
        }
    });
});
