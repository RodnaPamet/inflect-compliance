/**
 * OWASP Top 10 Privacy Risks coverage ratchet (P3).
 *
 * The OWASP Top 10 Privacy Risks (© OWASP, CC-BY-SA) seed IC's risk-template
 * library with a recognized privacy-risk set. Pure CONTENT — no new machinery.
 * This guard locks:
 *   - the 10 OWASP privacy risk templates seed, attributed + paraphrased
 *     (LICENSE guard — no verbatim OWASP prose);
 *   - each maps to a NIST Privacy Framework subcategory (frameworkTag) that
 *     actually exists in the library;
 *   - they ride the existing RiskTemplate path + carry a LINDDUN tag.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { LINDDUN_CODES } from '@/lib/privacy/linddun';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const seed = read('prisma/seed.ts');

// The OWASP entries in the seed share the `owasp-priv-` id prefix; parse their
// inline object literals out of the seed source.
function owaspEntries(): Array<{ id: string; title: string; description: string; frameworkTag: string; linddun: string }> {
    const out: Array<{ id: string; title: string; description: string; frameworkTag: string; linddun: string }> = [];
    const re = /\{\s*id:\s*'(owasp-priv-[^']+)',\s*title:\s*'([^']+)',\s*description:\s*'((?:[^'\\]|\\.)*)',[\s\S]*?frameworkTag:\s*'([^']+)',\s*linddunCategories:\s*\[([^\]]*)\]\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seed)) !== null) {
        out.push({ id: m[1], title: m[2], description: m[3], frameworkTag: m[4], linddun: m[5] });
    }
    return out;
}

const entries = owaspEntries();

describe('OWASP Top 10 Privacy Risks — seeded templates', () => {
    it('seeds exactly the 10 OWASP privacy risk templates', () => {
        expect(entries.length).toBe(10);
        expect(new Set(entries.map((e) => e.id)).size).toBe(10);
    });

    it('attributes OWASP + paraphrases (license guard — no verbatim prose)', () => {
        for (const e of entries) {
            // Every entry carries the OWASP attribution marker.
            expect(e.description).toMatch(/\[OWASP Top 10 Privacy Risks\]/);
            // Paraphrased: the risk text (minus the marker) is short, not a
            // pasted paragraph of OWASP prose.
            const prose = e.description.replace(/\[OWASP Top 10 Privacy Risks\]/, '').trim();
            expect(prose.length).toBeLessThanOrEqual(200);
            expect(prose.split(/\s+/).length).toBeLessThanOrEqual(30);
        }
        // The seed block documents the OWASP CC-BY-SA license + paraphrase.
        expect(seed).toMatch(/OWASP/);
        expect(seed).toMatch(/CC-BY-SA/i);
        expect(seed).toMatch(/PARAPHRASED|paraphrased/);
    });

    it('each carries a valid LINDDUN tag', () => {
        const valid = new Set<string>(LINDDUN_CODES);
        for (const e of entries) {
            const codes = e.linddun.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
            expect(codes.length).toBeGreaterThan(0);
            for (const c of codes) expect(valid.has(c)).toBe(true);
        }
    });
});

describe('OWASP privacy risks map to NIST Privacy Framework subcategories', () => {
    const pf = loadLibrary(
        parseLibraryFile(path.join(ROOT, 'src/data/libraries/nist-privacy-framework-1.0.yaml')),
        'nist-privacy',
    );
    const pfRefs = new Set(pf.framework.nodes.map((n) => n.refId));

    it("every frameworkTag is 'NIST-PF:<subcategory>' and the subcategory exists", () => {
        for (const e of entries) {
            const m = e.frameworkTag.match(/^NIST-PF:(.+)$/);
            expect(m).not.toBeNull();
            expect(pfRefs.has(m![1])).toBe(true);
        }
    });
});

describe('OWASP privacy risks ride the existing RiskTemplate path', () => {
    it('seed via prisma.riskTemplate.upsert (no new machinery)', () => {
        expect(seed).toMatch(/privacyRiskTemplates[\s\S]{0,2400}prisma\.riskTemplate\.upsert/);
    });
});
