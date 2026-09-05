/**
 * SSDF Starter Pack coverage ratchet.
 *
 * The SSDF Starter Pack is the CURATED control + risk content that turns the
 * bare NIST SSDF framework (ssdf-framework-coverage.test.ts) into a usable
 * day-one baseline. This guard locks:
 *   - ~15–20 curated control templates (one per SSDF practice), each with a
 *     description, owner hint, default frequency, default tasks, and at least
 *     one requirement link;
 *   - every requirement link resolves to a real SSDF assessable task ref_id
 *     (no dangling), so installing the pack produces mapped coverage — not 0%;
 *   - every practice group (PO/PS/PW/RV) has at least one control;
 *   - the curated codes use the distinct 'SDLC-' prefix (no collision with the
 *     auto-generated 'SSDF-NN' baseline templates);
 *   - seed.ts wires the fixture + the SSDF_STARTER_PACK pack;
 *   - the SSDF risk templates seed (frameworkTag 'SSDF', category
 *     'Secure Development') and ride the shared RiskTemplate path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const ssdf = loadLibrary(
    parseLibraryFile(path.join(ROOT, 'src/data/libraries/nist-ssdf-800-218.yaml')),
    'nist-ssdf',
);
const SSDF_TASK_REFS = new Set(
    ssdf.framework.nodes.filter((n) => n.assessable).map((n) => n.refId),
);
const GROUPS = ['PO', 'PS', 'PW', 'RV'] as const;
const FREQUENCIES = new Set(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']);

interface StarterControl {
    code: string;
    title: string;
    description: string;
    defaultFrequency: string;
    defaultOwnerHint: string;
    requirementCodes: string[];
    tasks: Array<{ title: { en: string }; description: { en: string } }>;
}
/**
 * The fixture is a CatalogFile — `{ framework, requirements, templates, pack }`
 * — since its templates gained authored task sets and a delivery path through
 * `applyCatalogFile` (scripts/seed-framework-catalogs.ts). Only the reader
 * moved; every assertion below is unchanged, because they were always about
 * RESOLUTION rather than shape.
 */
const controls = (JSON.parse(
    read('prisma/fixtures/ssdf-control-templates.json'),
) as { templates: StarterControl[] }).templates;

describe('SSDF Starter Pack — curated control templates', () => {
    it('ships 15–20 curated controls with unique SDLC- codes', () => {
        expect(controls.length).toBeGreaterThanOrEqual(15);
        expect(controls.length).toBeLessThanOrEqual(20);
        const codes = controls.map((c) => c.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const c of controls) {
            // Distinct prefix so curated controls never merge into the
            // auto-generated 'SSDF-NN' baseline pack.
            expect(c.code).toMatch(/^SDLC-/);
            expect(c.code).not.toMatch(/^SSDF-\d/);
        }
    });

    it('every control is fully specified (title, description, frequency, owner, tasks)', () => {
        for (const c of controls) {
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

    it('every requirement link resolves to a real SSDF task (no dangling refs)', () => {
        const dangling: string[] = [];
        for (const c of controls) {
            expect(c.requirementCodes.length).toBeGreaterThanOrEqual(1);
            for (const r of c.requirementCodes) {
                if (!SSDF_TASK_REFS.has(r)) dangling.push(`${c.code} → ${r}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('covers every SSDF practice group (PO/PS/PW/RV) with at least one control', () => {
        const groupsCovered = new Set(
            controls.flatMap((c) => c.requirementCodes.map((r) => r.split('.')[0])),
        );
        for (const g of GROUPS) expect(groupsCovered.has(g)).toBe(true);
    });
});

describe('SSDF Starter Pack — seed wiring (seed.ts)', () => {
    const seed = read('prisma/seed.ts');

    it('reads the curated control fixture', () => {
        expect(seed).toContain('ssdf-control-templates.json');
        expect(seed).toMatch(/category:\s*'Secure Development'/);
    });

    it('packages the controls as the SSDF_STARTER_PACK (idempotent upsert)', () => {
        expect(seed).toContain("'SSDF_STARTER_PACK'");
        expect(seed).toMatch(/startsWith:\s*'SDLC-'/);
        expect(seed).toMatch(/frameworkPack\.upsert/);
    });
});

describe('SSDF Starter Pack — secure-development risk templates', () => {
    const seed = read('prisma/seed.ts');

    it('seeds SSDF risk templates tagged frameworkTag SSDF + category Secure Development', () => {
        const block = seed.slice(seed.indexOf('ssdfRiskTemplates'));
        expect(block).toMatch(/frameworkTag:\s*'SSDF'/);
        // At least seven secure-development failure modes.
        const ids = [...block.matchAll(/id:\s*'(ssdf-[a-z-]+)'/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBeGreaterThanOrEqual(7);
    });

    it('rides the shared RiskTemplate upsert path (no bespoke machinery)', () => {
        expect(seed).toMatch(/for \(const t of ssdfRiskTemplates\)[\s\S]{0,120}riskTemplate\.upsert/);
    });
});
