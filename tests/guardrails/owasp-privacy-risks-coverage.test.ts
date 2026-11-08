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
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';
import { LINDDUN_CODES } from '@/lib/privacy/linddun';
import { deliveredRiskTemplates, riskTemplateDeliveryGap } from '../helpers/risk-template-delivery';

const ROOT = path.resolve(__dirname, '../..');

// The OWASP entries share the `owasp-priv-` id prefix within the privacy set
// production receives (prisma/fixtures/risk-templates-privacy.json, written by
// the entrypoint's risk-template seeder). They were parsed out of
// prisma/seed.ts until 2026-11-08, which no deploy runs.
function owaspEntries(): Array<{ id: string; title: string; description: string; frameworkTag: string; linddun: string[] }> {
    return deliveredRiskTemplates('privacy')
        .filter((t) => t.id.startsWith('owasp-priv-'))
        .map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            frameworkTag: t.frameworkTag ?? '',
            linddun: t.linddunCategories ?? [],
        }));
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
        // The license guard is the DATA above: each delivered entry carries the
        // marker and is short. Whole-file greps (/OWASP/, /CC-BY-SA/i) once sat
        // here and were satisfied by an unrelated framework's metadata.
    });

    it('each carries a valid LINDDUN tag', () => {
        const valid = new Set<string>(LINDDUN_CODES);
        for (const e of entries) {
            const codes = e.linddun;
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

describe('OWASP privacy risks reach production on the shared RiskTemplate path', () => {
    it('the risk-template seeder the entrypoint runs delivers them', () => {
        expect(riskTemplateDeliveryGap()).toBeNull();
        expect(entries.length).toBe(10);
    });
});
