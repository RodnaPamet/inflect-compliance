/**
 * CIS Critical Security Controls v8 — library + starter-pack coverage ratchet.
 *
 * Locks the end-to-end CIS v8 framework offering:
 *   - the library parses under the framework-library schema, carrying the full
 *     18-control / 153-safeguard structure with IG1/IG2/IG3 tiers;
 *   - LICENSING DISCIPLINE: the yaml declares it is a structural outline (not
 *     verbatim CIS text) and every safeguard description is short/original;
 *   - the IG1 Starter Pack fixture ships curated control templates, each fully
 *     specified and linked to real IG1 safeguard requirement codes;
 *   - seed.ts wires the CIS framework (key CIS-V8), the IG1 pack
 *     (CIS_V8_IG1_PACK), and the cyber-hygiene risk templates;
 *   - the two mapping sets resolve on BOTH sides (source refs exist in the CIS
 *     library, target refs exist in the ISO 27001 / NIST CSF libraries) and
 *     together cover every IG1 safeguard.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';
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

describe('CIS v8 — IG1 Starter Pack fixture', () => {
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
     * path through `applyCatalogFile`. Only the reader moved; every assertion
     * below is unchanged, because they were always about RESOLUTION, not shape.
     */
    const controlsFixture = (JSON.parse(
        read('prisma/fixtures/cis-v8-ig1-control-templates.json'),
    ) as { templates: StarterControl[] }).templates;
    const IG1_REFS = new Set(safeguards.filter((s) => s.category === 'IG1').map((s) => s.refId));
    const SAFEGUARD_REFS = new Set(safeguards.map((s) => s.refId));

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
});

describe('CIS v8 — seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the CIS requirement + IG1 control fixtures', () => {
        expect(seed).toContain('cis-v8-requirements.json');
        expect(seed).toContain('cis-v8-ig1-control-templates.json');
    });

    it('seeds the CIS-V8 framework and the CIS_V8_IG1_PACK (idempotent upsert)', () => {
        expect(seed).toContain("'CIS-V8'");
        expect(seed).toContain("'CIS_V8_IG1_PACK'");
        expect(seed).toMatch(/startsWith:\s*'CIS-'/);
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });

    it('seeds CIS cyber-hygiene risk templates on the shared RiskTemplate path', () => {
        const block = seed.slice(seed.indexOf('cisRiskTemplates'));
        expect(block).toMatch(/frameworkTag:\s*'CIS'/);
        const ids = [...block.matchAll(/id:\s*'(cis-[a-z-]+)'/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBeGreaterThanOrEqual(7);
        expect(seed).toMatch(/for \(const t of cisRiskTemplates\)[\s\S]{0,120}riskTemplate\.upsert/);
    });

    it('is registered in the framework starter-pack completeness ratchet', () => {
        const completeness = read('tests/guardrails/framework-starter-pack-completeness.test.ts');
        expect(completeness).toMatch(/'CIS-CONTROLS-V8':\s*\{\s*frameworkKey:\s*'CIS-V8',\s*packKey:\s*'CIS_V8_IG1_PACK'\s*\}/);
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
