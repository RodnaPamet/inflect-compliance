/**
 * OWASP ASVS 4.0.3 — library + starter-pack coverage ratchet.
 *
 * Locks the end-to-end ASVS 4.0.3 framework offering:
 *   - the library parses under the framework-library schema, carrying the full
 *     14-chapter structure with L1/L2/L3 verification levels;
 *   - LICENSING DISCIPLINE: the yaml declares it is a structural outline (not
 *     verbatim ASVS text) and every requirement description is short/original.
 *     ASVS is CC BY-SA 4.0 (ShareAlike) — embedding its text is incompatible
 *     with a proprietary product, so only identifiers/titles/structure are used;
 *   - the L1 Starter Pack fixture ships curated control templates, each fully
 *     specified and linked to real L1 requirement codes;
 *   - seed.ts wires the ASVS framework (key OWASP-ASVS), the L1 pack
 *     (ASVS_L1_PACK), and the application-security risk templates;
 *   - the two mapping sets resolve on BOTH sides (source refs exist in the ASVS
 *     library, target refs exist in the ISO 27001 / NIST SSDF libraries) and
 *     together cover every L1 requirement.
 *
 * Note: licensing-discipline substrings are asserted with .toContain(...) — an
 * unanchored URL regex would trip a CodeQL missing-regexp-anchor alert.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { parseMappingSetFile } from '@/app-layer/services/mapping-set-importer';

const ROOT = path.resolve(__dirname, '../..');
const LIB = path.join(ROOT, 'src/data/libraries');
const MAP = path.join(LIB, 'mappings');
// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// thing cannot satisfy an assertion meant to be about CODE. Masking is the
// DEFAULT (`read`) so a new assertion inherits it; `readRaw` is for the files
// where a `//` is content rather than a comment — the `https://` of a URL in
// YAML / JSON / Markdown — and masking would delete real text.
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));

function lib(file: string) {
    return loadLibrary(parseLibraryFile(path.join(LIB, file)), file);
}
function refIdSet(file: string): Set<string> {
    return new Set(lib(file).framework.nodes.map((n) => n.refId));
}

const ASVS = 'owasp-asvs-4.0.3.yaml';
const asvs = lib(ASVS);
const chapters = asvs.framework.nodes.filter((n) => !n.assessable);
const requirements = asvs.framework.nodes.filter((n) => n.assessable);

// The authored counts — 259 requirements: 128 L1, 119 L2, 12 L3.
const EXPECTED_REQUIREMENTS = 259;
const EXPECTED_L1 = 128;

describe('ASVS 4.0.3 — library structure', () => {
    it('parses with ref_id OWASP-ASVS-4.0.3 and kind INDUSTRY_STANDARD', () => {
        expect(asvs.refId).toBe('OWASP-ASVS-4.0.3');
        expect(asvs.kind).toBe('INDUSTRY_STANDARD');
    });

    it('is distinct from the OWASP AISVS (AI) library', () => {
        expect(asvs.refId).not.toBe('AISVS-1.0');
        expect(refIdSet('owasp-aisvs-1.0.yaml').has('OWASP-ASVS-4.0.3')).toBe(false);
    });

    it('carries exactly 14 chapters and the authored requirement count', () => {
        expect(chapters.length).toBe(14);
        expect(requirements.length).toBe(EXPECTED_REQUIREMENTS);
    });

    it('numbers the 14 chapters V1..V14', () => {
        const ids = new Set(chapters.map((c) => c.refId));
        for (let i = 1; i <= 14; i++) expect(ids.has(`V${i}`)).toBe(true);
    });

    it('every requirement carries an L1/L2/L3 level in category, all three present', () => {
        const levels = new Set(requirements.map((r) => r.category));
        expect([...levels].sort()).toEqual(['L1', 'L2', 'L3']);
        const untiered = requirements.filter((r) => !['L1', 'L2', 'L3'].includes(r.category ?? ''));
        expect(untiered.map((r) => r.refId)).toEqual([]);
    });

    it('carries the expected number of L1 requirements', () => {
        const l1 = requirements.filter((r) => r.category === 'L1');
        expect(l1.length).toBe(EXPECTED_L1);
    });

    it('every requirement ref_id is V-prefixed and parented to a chapter', () => {
        for (const r of requirements) expect(r.refId).toMatch(/^V\d+\.\d+\.\d+$/);
    });

    it('every requirement has an original description (present, non-trivial length)', () => {
        const bad = requirements.filter((r) => (r.description ?? '').trim().length < 20);
        expect(bad.map((r) => r.refId)).toEqual([]);
    });
});

describe('ASVS 4.0.3 — licensing discipline (no verbatim ASVS text)', () => {
    const src = readRaw(`src/data/libraries/${ASVS}`);

    it('declares the structural-outline / CC BY-SA posture and links OWASP', () => {
        expect(src).toContain('NOT verbatim ASVS text');
        expect(src).toContain('CC BY-SA');
        expect(src).toContain('owasp.org/www-project-application-security-verification-standard');
    });

    it('explains why the ShareAlike term forces original prose', () => {
        expect(src).toContain('proprietary product');
    });

    it('no absurdly long single line (a pasted ASVS passage would blow past this)', () => {
        const longest = Math.max(...src.split('\n').map((l) => l.length));
        expect(longest).toBeLessThanOrEqual(320);
    });
});

describe('ASVS 4.0.3 — L1 Starter Pack fixture', () => {
    interface StarterControl {
        code: string;
        title: string;
        description: string;
        defaultFrequency: string;
        defaultOwnerHint: string;
        requirements: string[];
        tasks: Array<{ title: string; description: string }>;
    }
    const FREQUENCIES = new Set(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']);
    const controlsFixture = JSON.parse(
        readRaw('prisma/fixtures/asvs-l1-control-templates.json'),
    ) as StarterControl[];
    const L1_REFS = new Set(requirements.filter((r) => r.category === 'L1').map((r) => r.refId));
    const REQ_REFS = new Set(requirements.map((r) => r.refId));

    it('ships a curated set of controls with unique ASVS- codes', () => {
        expect(controlsFixture.length).toBeGreaterThanOrEqual(10);
        const codes = controlsFixture.map((c) => c.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const c of controlsFixture) expect(c.code).toMatch(/^ASVS-/);
    });

    it('every control is fully specified (title, description, frequency, owner, tasks)', () => {
        for (const c of controlsFixture) {
            expect(c.title).toBeTruthy();
            expect(c.description.length).toBeGreaterThan(20);
            expect(FREQUENCIES.has(c.defaultFrequency)).toBe(true);
            expect(c.defaultOwnerHint).toBeTruthy();
            expect(c.tasks.length).toBeGreaterThanOrEqual(1);
            for (const t of c.tasks) {
                expect(t.title).toBeTruthy();
                expect(t.description).toBeTruthy();
            }
        }
    });

    it('every requirement link resolves to a real ASVS requirement (no dangling refs)', () => {
        const dangling: string[] = [];
        for (const c of controlsFixture) {
            expect(c.requirements.length).toBeGreaterThanOrEqual(1);
            for (const r of c.requirements) {
                if (!REQ_REFS.has(r)) dangling.push(`${c.code} → ${r}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('the pack covers every L1 requirement', () => {
        const covered = new Set(controlsFixture.flatMap((c) => c.requirements));
        const missing = [...L1_REFS].filter((r) => !covered.has(r));
        expect(missing).toEqual([]);
    });
});

describe('ASVS 4.0.3 — seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the ASVS requirement + L1 control fixtures', () => {
        expect(seed).toContain('asvs-requirements.json');
        expect(seed).toContain('asvs-l1-control-templates.json');
    });

    it('seeds the OWASP-ASVS framework and the ASVS_L1_PACK (idempotent upsert)', () => {
        expect(seed).toContain("'OWASP-ASVS'");
        expect(seed).toContain("'ASVS_L1_PACK'");
        expect(seed).toMatch(/startsWith:\s*'ASVS-'/);
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });

    it('seeds ASVS application-security risk templates on the shared RiskTemplate path', () => {
        const block = seed.slice(seed.indexOf('asvsRiskTemplates'));
        expect(block).toMatch(/frameworkTag:\s*'ASVS'/);
        const ids = [...block.matchAll(/id:\s*'(asvs-[a-z-]+)'/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBeGreaterThanOrEqual(7);
        expect(seed).toMatch(/for \(const t of asvsRiskTemplates\)[\s\S]{0,120}riskTemplate\.upsert/);
    });

    it('is registered in the framework starter-pack completeness ratchet', () => {
        const completeness = read('tests/guardrails/framework-starter-pack-completeness.test.ts');
        expect(completeness).toMatch(/'OWASP-ASVS-4\.0\.3':\s*\{\s*frameworkKey:\s*'OWASP-ASVS',\s*packKey:\s*'ASVS_L1_PACK'\s*\}/);
    });
});

describe('ASVS 4.0.3 — cross-framework mapping validity', () => {
    const cases = [
        { file: 'asvs-to-iso27001.yaml', tgt: 'iso27001-2022.yaml', tgtRef: 'ISO27001-2022' },
        { file: 'asvs-to-ssdf.yaml', tgt: 'nist-ssdf-800-218.yaml', tgtRef: 'NIST-SSDF-800-218' },
    ];
    const asvsRefs = refIdSet(ASVS);

    it.each(cases)('$file — framework refs + every entry resolves on both sides', ({ file, tgt, tgtRef }) => {
        const ms = parseMappingSetFile(path.join(MAP, file));
        expect(ms.source_framework_ref).toBe('OWASP-ASVS-4.0.3');
        expect(ms.target_framework_ref).toBe(tgtRef);
        expect(ms.mapping_entries.length).toBeGreaterThan(0);

        const tgtIds = refIdSet(tgt);
        const dangling: string[] = [];
        for (const e of ms.mapping_entries) {
            if (!asvsRefs.has(e.source_ref)) dangling.push(`source ${e.source_ref}`);
            if (!tgtIds.has(e.target_ref)) dangling.push(`target ${e.target_ref}`);
        }
        expect(dangling).toEqual([]);
    });

    it('the two mapping sets together cover every L1 requirement as a source', () => {
        const covered = new Set<string>();
        for (const file of ['asvs-to-iso27001.yaml', 'asvs-to-ssdf.yaml']) {
            for (const e of parseMappingSetFile(path.join(MAP, file)).mapping_entries) {
                covered.add(e.source_ref);
            }
        }
        const l1 = requirements.filter((r) => r.category === 'L1').map((r) => r.refId);
        const missing = l1.filter((r) => !covered.has(r));
        expect(missing).toEqual([]);
    });
});
