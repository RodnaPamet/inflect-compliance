/**
 * CIS Critical Security Controls v8 — library + starter-pack coverage ratchet.
 *
 * Locks the end-to-end CIS v8 framework offering:
 *   - the library parses under the framework-library schema, carrying the full
 *     18-control / 153-safeguard structure with IG1/IG2/IG3 tiers;
 *   - LICENSING DISCIPLINE: the yaml declares it is a structural outline (not
 *     verbatim CIS text) and every safeguard description is short/original;
 *   - the IG1 Starter Pack catalogue a PRODUCTION seeder applies ships curated
 *     control templates, each fully specified and linked to real IG1 safeguard
 *     requirement codes;
 *   - that catalogue declares the framework (key CIS-V8) and the pack
 *     production actually has (CIS_V8_IG1);
 *   - prisma/seed.ts — dev only — additionally seeds the cyber-hygiene risk
 *     templates, which have no production writer at all;
 *   - the two mapping sets resolve on BOTH sides (source refs exist in the CIS
 *     library, target refs exist in the ISO 27001 / NIST CSF libraries) and
 *     together cover every IG1 safeguard.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
import { appliedCatalogFor, productionDeclaringSources } from '../helpers/applied-catalogue';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const LIB = path.join(ROOT, 'src/data/libraries');
const MAP = path.join(LIB, 'mappings');
// SOURCE reads are comment-masked at the seam (`codeOf`), so a comment
// naming a symbol can never satisfy an assertion meant to be about code.
// YAML / JSON / markdown are read raw — there `//` is content, not a comment.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};

function lib(file: string) {
    return loadLibrary(parseLibraryFile(path.join(LIB, file)), file);
}
function refIdSet(file: string): Set<string> {
    return new Set(lib(file).framework.nodes.map((n) => n.refId));
}

const CIS = 'cis-controls-v8.yaml';
const cis = lib(CIS);
const controls = cis.framework.nodes.filter((n) => !n.assessable);
const safeguards = cis.framework.nodes.filter((n) => n.assessable);

describe('CIS v8 — library structure', () => {
    it('parses with ref_id CIS-CONTROLS-V8 and kind INDUSTRY_STANDARD', () => {
        expect(cis.refId).toBe('CIS-CONTROLS-V8');
        expect(cis.kind).toBe('INDUSTRY_STANDARD');
    });

    it('carries exactly 18 controls and 153 safeguards', () => {
        expect(controls.length).toBe(18);
        expect(safeguards.length).toBe(153);
    });

    it('numbers the 18 controls 1..18', () => {
        const ids = new Set(controls.map((c) => c.refId));
        for (let i = 1; i <= 18; i++) expect(ids.has(String(i))).toBe(true);
    });

    it('every safeguard carries an IG1/IG2/IG3 tier in category, all three present', () => {
        const tiers = new Set(safeguards.map((s) => s.category));
        expect([...tiers].sort()).toEqual(['IG1', 'IG2', 'IG3']);
        const untiered = safeguards.filter((s) => !['IG1', 'IG2', 'IG3'].includes(s.category ?? ''));
        expect(untiered.map((s) => s.refId)).toEqual([]);
    });

    it('every safeguard has an original description (present, non-trivial length)', () => {
        const bad = safeguards.filter((s) => (s.description ?? '').trim().length < 20);
        expect(bad.map((s) => s.refId)).toEqual([]);
    });
});

describe('CIS v8 — licensing discipline (no verbatim CIS text)', () => {
    const src = read(`src/data/libraries/${CIS}`);

    it('declares the structural-outline / CC BY-NC-SA posture and links CIS', () => {
        expect(src).toMatch(/NOT verbatim CIS text/i);
        expect(src).toMatch(/CC BY-NC-SA/);
        expect(src).toContain('cisecurity.org/controls');
    });

    it('no absurdly long single line (a pasted CIS passage would blow past this)', () => {
        const longest = Math.max(...src.split('\n').map((l) => l.length));
        expect(longest).toBeLessThanOrEqual(320);
    });
});

/**
 * The CatalogFile a production seeder applies for CIS-V8, resolved ONCE and
 * shared by the two describes below.
 *
 * It is discovered — `appliedCatalogFor` walks the seeders `scripts/entrypoint.sh`
 * runs and the fixtures each names — rather than read from a hardcoded path, so
 * a fixture dropped out of `CATALOG_FIXTURES` (i.e. no longer applied anywhere)
 * turns this red instead of leaving every assertion below passing against a
 * file nothing installs.
 */
const catalog = appliedCatalogFor('CIS-V8');

describe('CIS v8 — IG1 Starter Pack, as production applies it', () => {
    interface StarterControl {
        code: string;
        title: string;
        description: string;
        defaultFrequency: string;
        defaultOwnerHint: string;
        requirementCodes: string[];
        tasks: Array<{ title: { en: string }; description: { en: string } }>;
    }
    const FREQUENCIES = new Set(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']);
    /**
     * The fixture is a CatalogFile — `{ framework, requirements, templates,
     * pack }` — since its templates gained authored task sets and a delivery
     * path through `applyCatalogFile`. The templates now come from the APPLIED
     * catalogue rather than a hardcoded fixture path; every assertion below is
     * unchanged, because they were always about RESOLUTION, not shape.
     */
    const controlsFixture = (catalog?.templates ?? []) as unknown as StarterControl[];
    const IG1_REFS = new Set(safeguards.filter((s) => s.category === 'IG1').map((s) => s.refId));
    const SAFEGUARD_REFS = new Set(safeguards.map((s) => s.refId));

    it('a production seeder applies a CIS v8 catalogue at all', () => {
        // DENOMINATOR. Every case below iterates `catalog.templates`, so all of
        // them pass vacuously when the lookup returns null.
        expect(catalog).not.toBeNull();
        expect(catalog?.file).toBe('prisma/fixtures/cis-v8-ig1-control-templates.json');
        expect(catalog?.requirements.length).toBeGreaterThanOrEqual(50);
        expect(controlsFixture.length).toBeGreaterThanOrEqual(10);
    });

    it('ships a curated set of controls with unique CIS- codes', () => {
        expect(controlsFixture.length).toBeGreaterThanOrEqual(10);
        const codes = controlsFixture.map((c) => c.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const c of controlsFixture) expect(c.code).toMatch(/^CIS-/);
    });

    it('every control is fully specified (title, description, frequency, owner, tasks)', () => {
        for (const c of controlsFixture) {
            expect(c.title).toBeTruthy();
            expect(c.description.length).toBeGreaterThan(20);
            expect(FREQUENCIES.has(c.defaultFrequency)).toBe(true);
            expect(c.defaultOwnerHint).toBeTruthy();
            expect(c.tasks.length).toBeGreaterThanOrEqual(1);
            for (const t of c.tasks) {
                expect(t.title.en).toBeTruthy();
                expect(t.description.en).toBeTruthy();
            }
        }
    });

    it('every requirement link resolves to a real CIS safeguard (no dangling refs)', () => {
        const dangling: string[] = [];
        for (const c of controlsFixture) {
            expect(c.requirementCodes.length).toBeGreaterThanOrEqual(1);
            for (const r of c.requirementCodes) {
                if (!SAFEGUARD_REFS.has(r)) dangling.push(`${c.code} → ${r}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('the pack covers every IG1 safeguard', () => {
        const covered = new Set(controlsFixture.flatMap((c) => c.requirementCodes));
        const missing = [...IG1_REFS].filter((r) => !covered.has(r));
        expect(missing).toEqual([]);
    });

    it('the requirements it installs are all real CIS IG1 safeguards', () => {
        // The catalogue carries its own requirement rows now, so what a customer
        // gets is these — not `cis-v8-requirements.json`, which only seed.ts reads.
        const codes = (catalog?.requirements ?? []).map((r) => String(r.code));
        expect(codes.length).toBeGreaterThanOrEqual(50);
        expect(codes.filter((c) => !IG1_REFS.has(c))).toEqual([]);
    });
});

/**
 * WHAT WAS WRONG HERE
 *
 * This block asked whether `prisma/seed.ts` CONTAINED the strings 'CIS-V8' and
 * 'CIS_V8_IG1_PACK'. seed.ts is not run on a production deploy, so that pair of
 * assertions could not fail while the CIS offering was undeliverable — and one
 * of the two strings names a pack row no customer has ever had: production's
 * key is CIS_V8_IG1, from the catalogue, and CIS_V8_IG1_PACK exists only in the
 * dev seeder. The assertion was named for the outcome ("the framework and its
 * pack are seeded") and bound to an implementation that reaches nobody.
 *
 * It now reads the CatalogFile a production seeder applies, by field.
 */
describe('CIS v8 — framework + pack delivery', () => {
    it('declares the framework as CIS-V8 v8, kind INDUSTRY_STANDARD', () => {
        expect(catalog?.framework.key).toBe('CIS-V8');
        expect(catalog?.framework.version).toBe('8');
        expect(catalog?.framework.kind).toBe('INDUSTRY_STANDARD');
    });

    it('carries the CIS provider, CC BY-NC-SA licence and source urn', () => {
        // Framework metadata travels in the CatalogFile now — not grepped out of seed.ts.
        const meta = (catalog?.framework.metadata ?? {}) as Record<string, unknown>;
        expect(meta.provider).toBe('Center for Internet Security');
        expect(meta.license).toBe('CC-BY-NC-SA-4.0');
        expect(String(meta.copyright ?? '')).toContain('Center for Internet Security');
        expect(catalog?.framework.sourceUrn).toBe('urn:inflect:library:cis-controls-v8');
    });

    it('declares the pack production actually has, over template codes it ships', () => {
        // CIS_V8_IG1 — NOT seed.ts's CIS_V8_IG1_PACK, which names no production row.
        expect(catalog?.pack?.key).toBe('CIS_V8_IG1');
        expect(productionDeclaringSources('CIS_V8_IG1').length).toBeGreaterThan(0);
        expect(productionDeclaringSources('CIS_V8_IG1_PACK')).toEqual([]);

        const shipped = new Set((catalog?.templates ?? []).map((t) => String(t.code)));
        const packCodes = ((catalog?.pack?.templateCodes ?? []) as unknown[]).map(String);
        expect(packCodes.length).toBeGreaterThanOrEqual(10);
        expect(packCodes.filter((c) => !shipped.has(c))).toEqual([]);
        for (const c of packCodes) expect(c).toMatch(/^CIS-/);
    });

    it('is registered in the framework starter-pack completeness ratchet', () => {
        // Pinned on the framework key only: the pack key spelling in that
        // registry is the sibling guard's business, and this file must not go
        // red on the diff that corrects it there.
        const completeness = read('tests/guardrails/framework-starter-pack-completeness.test.ts');
        expect(completeness).toMatch(/'CIS-CONTROLS-V8':\s*\{\s*frameworkKey:\s*'CIS-V8',/);
    });
});

describe('CIS v8 — cyber-hygiene risk templates (dev seeder only)', () => {
    // RiskTemplate has NO production writer: `prisma/seed.ts` is the only file
    // in the repo that touches `riskTemplate.upsert`, and no seeder
    // `scripts/entrypoint.sh` runs applies one. These assertions are therefore
    // left exactly as they were — repointing them at a delivery path would
    // assert something false. The describe was renamed to say so out loud.
    const seed = read('prisma/seed.ts');

    // 'reads the CIS requirement fixture (dev path)' was DELETED rather than
    // repointed. It asserted that prisma/seed.ts contains
    // 'cis-v8-requirements.json', which was true while seed.ts built CIS v8 a
    // second time. That block is gone — the CatalogFile carries the 56
    // requirements and a production seeder applies them — so the assertion had
    // no subject left. The requirements are covered by the delivery describe
    // above, against the file production actually reads.

    it('seeds CIS cyber-hygiene risk templates on the shared RiskTemplate path', () => {
        const block = seed.slice(seed.indexOf('cisRiskTemplates'));
        expect(block).toMatch(/frameworkTag:\s*'CIS'/);
        const ids = [...block.matchAll(/id:\s*'(cis-[a-z-]+)'/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBeGreaterThanOrEqual(7);
        expect(seed).toMatch(/for \(const t of cisRiskTemplates\)[\s\S]{0,120}riskTemplate\.upsert/);
    });
});

describe('CIS v8 — cross-framework mapping validity', () => {
    const cases = [
        { file: 'cis-v8-to-iso27001.yaml', tgt: 'iso27001-2022.yaml', tgtRef: 'ISO27001-2022' },
        { file: 'cis-v8-to-nist-csf.yaml', tgt: 'nist-csf-2.0.yaml', tgtRef: 'NIST-CSF-2.0' },
    ];
    const cisRefs = refIdSet(CIS);

    it.each(cases)('$file — framework refs + every entry resolves on both sides', ({ file, tgt, tgtRef }) => {
        const ms = parseMappingSetFile(path.join(MAP, file));
        expect(ms.source_framework_ref).toBe('CIS-CONTROLS-V8');
        expect(ms.target_framework_ref).toBe(tgtRef);
        expect(ms.mapping_entries.length).toBeGreaterThan(0);

        const tgtIds = refIdSet(tgt);
        const dangling: string[] = [];
        for (const e of ms.mapping_entries) {
            if (!cisRefs.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
            if (!tgtIds.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
        }
        expect(dangling).toEqual([]);
    });

    it('the two mapping sets together cover every IG1 safeguard as a source', () => {
        const covered = new Set<string>();
        for (const file of ['cis-v8-to-iso27001.yaml', 'cis-v8-to-nist-csf.yaml']) {
            for (const e of parseMappingSetFile(path.join(MAP, file)).mapping_entries) {
                covered.add(e.source_ref);
            }
        }
        const ig1 = safeguards.filter((s) => s.category === 'IG1').map((s) => s.refId);
        const missing = ig1.filter((r) => !covered.has(r));
        expect(missing).toEqual([]);
    });
});
