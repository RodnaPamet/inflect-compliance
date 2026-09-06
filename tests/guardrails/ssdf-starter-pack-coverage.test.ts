/**
 * SSDF Starter Pack coverage ratchet.
 *
 * The SSDF Starter Pack is the CURATED control content that turns the bare NIST
 * SSDF framework (ssdf-framework-coverage.test.ts) into a usable day-one
 * baseline: ~15–20 `SDLC-` controls, one per SSDF practice, each with authored
 * tasks and requirement links, distinct from the auto-generated `SSDF-NN`
 * practice templates.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * Two of the questions below were asked of `prisma/seed.ts`:
 *
 *     expect(seed).toContain("'SSDF_STARTER_PACK'");
 *
 * `prisma/seed.ts` is not run on a production deploy, so that assertion could
 * not fail while the pack was undeliverable — and the key it named is one no
 * customer has. Production applies `prisma/fixtures/ssdf-control-templates.json`
 * through `scripts/seed-framework-catalogs.ts` (run from `entrypoint.sh`), and
 * the pack in that CatalogFile is keyed **SSDF_CORE**. The two keys had drifted
 * apart with nothing to notice, because the only guard was reading the arm that
 * ships to nobody.
 *
 * The curated-control cases had the milder version of the same problem: they
 * read the fixture by a hard-coded path, so they were correct only by
 * coincidence — nothing tied that path to the file a seeder actually applies.
 * They now come from `appliedCatalogFor('NIST-SSDF')`, which discovers it.
 *
 * The secure-development RiskTemplates are the exception and are deliberately
 * still asserted against `seed.ts`: they have no production writer at all, so
 * repointing them would assert a delivery path that does not exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

import { appliedCatalogFor, productionDeclaringSources } from '../helpers/applied-catalogue';
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
    category: string;
    defaultFrequency: string;
    defaultOwnerHint: string;
    requirementCodes: string[];
    tasks: Array<{ title: { en: string }; description: { en: string } }>;
}

/** The CatalogFile a production seeder applies for NIST SSDF — not a path we chose. */
const catalog = appliedCatalogFor('NIST-SSDF');
const controls = (catalog?.templates ?? []) as unknown as StarterControl[];
const packTemplateCodes = (catalog?.pack?.templateCodes ?? []) as string[];

describe('SSDF Starter Pack — delivery', () => {
    it('a production seeder applies an SSDF catalogue at all', () => {
        // DENOMINATOR. Every case below reads `controls` / `packTemplateCodes`,
        // and both are empty — so every case is vacuous — when this is null.
        expect(catalog).not.toBeNull();
        expect(catalog?.file).toBe('prisma/fixtures/ssdf-control-templates.json');
        expect(catalog?.requirements.length).toBeGreaterThanOrEqual(40);
        expect(controls.length).toBeGreaterThanOrEqual(15);
    });

    it('declares the pack production actually has', () => {
        // SSDF_CORE, not seed.ts's SSDF_STARTER_PACK — that key names a
        // FrameworkPack row no customer database contains.
        expect(catalog?.pack?.key).toBe('SSDF_CORE');
        expect(catalog?.pack?.version).toBe('1.1');
        expect(productionDeclaringSources('SSDF_CORE').length).toBeGreaterThanOrEqual(1);
        expect(productionDeclaringSources('SSDF_STARTER_PACK')).toEqual([]);
    });

    it('the pack ships exactly the curated SDLC- controls (no dangling membership)', () => {
        expect(packTemplateCodes.length).toBeGreaterThanOrEqual(15);
        for (const code of packTemplateCodes) {
            // Distinct prefix so curated controls never merge into the
            // auto-generated 'SSDF-NN' baseline pack.
            expect(code).toMatch(/^SDLC-/);
            expect(code).not.toMatch(/^SSDF-\d/);
        }
        const codes = controls.map((c) => c.code);
        expect([...packTemplateCodes].sort()).toEqual([...codes].sort());
    });
});

describe('SSDF Starter Pack — curated control templates', () => {
    it('ships 15–20 curated controls with unique SDLC- codes', () => {
        expect(controls.length).toBeGreaterThanOrEqual(15);
        expect(controls.length).toBeLessThanOrEqual(20);
        const codes = controls.map((c) => c.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const c of controls) {
            expect(c.code).toMatch(/^SDLC-/);
            expect(c.code).not.toMatch(/^SSDF-\d/);
        }
    });

    it('every control is fully specified (title, description, category, frequency, owner, tasks)', () => {
        for (const c of controls) {
            expect(c.title).toBeTruthy();
            expect(c.description.length).toBeGreaterThan(20);
            // The category production writes. `prisma/seed.ts` writes
            // 'Secure Development' for these same rows; the applied value is
            // the one a customer sees.
            expect(c.category).toBe('Security');
            expect(FREQUENCIES.has(c.defaultFrequency)).toBe(true);
            expect(c.defaultOwnerHint).toBeTruthy();
            expect(c.tasks.length).toBeGreaterThanOrEqual(1);
            for (const t of c.tasks) {
                expect(t.title.en).toBeTruthy();
                expect(t.description.en).toBeTruthy();
            }
        }
    });

    it('every requirement link resolves to a real SSDF assessable task (no dangling refs)', () => {
        const dangling: string[] = [];
        for (const c of controls) {
            expect(c.requirementCodes.length).toBeGreaterThanOrEqual(1);
            for (const r of c.requirementCodes) {
                if (!SSDF_TASK_REFS.has(r)) dangling.push(`${c.code} → ${r}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('every requirement link resolves to a requirement the same catalogue upserts', () => {
        // The library check above proves the ref is real SSDF; this one proves
        // production has a row to link it to, which is what turns an installed
        // pack into mapped coverage instead of 0%.
        const shipped = new Set(
            (catalog?.requirements ?? []).map((r) => (r as { code?: string }).code),
        );
        const dangling = controls.flatMap((c) =>
            c.requirementCodes.filter((r) => !shipped.has(r)).map((r) => `${c.code} → ${r}`),
        );
        expect(dangling).toEqual([]);
    });

    it('covers every SSDF practice group (PO/PS/PW/RV) with at least one control', () => {
        const groupsCovered = new Set(
            controls.flatMap((c) => c.requirementCodes.map((r) => r.split('.')[0])),
        );
        for (const g of GROUPS) expect(groupsCovered.has(g)).toBe(true);
    });
});

describe('SSDF Starter Pack — secure-development risk templates', () => {
    // Deliberately still read from `prisma/seed.ts`: these seven RiskTemplates
    // have NO production writer — no CatalogFile carries risk templates and no
    // seeder in entrypoint.sh applies them. Repointing these at the applied
    // catalogue would assert a delivery path that does not exist. The weak
    // assertion is the honest one until a production writer exists.
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
