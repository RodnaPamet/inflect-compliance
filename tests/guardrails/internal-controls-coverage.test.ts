/**
 * Internal Controls library import ratchet.
 *
 * A deduped set of internal controls imported from a customer GRC export, seeded
 * as plain global ControlTemplates (NOT a dedicated pack/framework). Each control
 * carries an objective, success criteria, testing/audit methodology (surfaced on
 * the control-detail Overview + Tests tabs post-install) and its related-policy
 * names. Framework mapping is policy-mediated: a curated policy→ISO27001/NIS2 map
 * (`internal-controls-policy-framework-map.json`) drives ControlTemplateRequirementLink
 * seeding, and installing ANY framework pack also populates the internal controls
 * mapped to that framework + resolves their related policies to PolicyControlLinks.
 * This guard locks:
 *   - the fixture parses, is deduped (unique codes + titles), and every control
 *     has an objective + testing methodology;
 *   - the Control + ControlTemplate models carry the new fields (migration);
 *   - the seed loads the controls + policy-framework map and creates requirement
 *     links (and is NOT wired as a pack/framework);
 *   - install copies the new fields, populates framework-mapped internal controls,
 *     and resolves related policies to PolicyControlLinks;
 *   - the policy→framework map has no dangling codes and covers the control set;
 *   - the detail DTO exposes the new fields so the UI can render them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam, so a comment naming a fixture
// or a DTO field cannot satisfy an assertion about code. JSON fixtures and
// migration SQL stay raw (`//` there is content, and `--` is not a JS comment).
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};
const readJson = (rel: string) => JSON.parse(read(rel));

interface Ctrl {
    code: string; title: string; objective: string; successCriteria: string;
    testingMethodology: string; relatedPolicies: string[]; category: string;
}
const fixture = readJson('prisma/fixtures/internal-controls.json') as { controls: Ctrl[] };

describe('Internal Controls fixture', () => {
    it('imports a substantial, deduped control set (>= 150)', () => {
        expect(fixture.controls.length).toBeGreaterThanOrEqual(150);
    });

    it('codes and titles are unique (deduped)', () => {
        const codes = fixture.controls.map((c) => c.code);
        const titles = fixture.controls.map((c) => c.title.trim().toLowerCase());
        expect(new Set(codes).size).toBe(codes.length);
        expect(new Set(titles).size).toBe(titles.length);
    });

    it('every control has a code, title, objective, and testing methodology', () => {
        for (const c of fixture.controls) {
            expect(c.code).toMatch(/^ICN-\d{3}$/);
            expect(c.title.trim().length).toBeGreaterThan(0);
            expect((c.objective ?? '').trim().length).toBeGreaterThan(0);
            expect((c.testingMethodology ?? '').trim().length).toBeGreaterThan(0);
        }
    });

    it('most controls carry success criteria + a related policy (source coverage)', () => {
        const withSc = fixture.controls.filter((c) => (c.successCriteria ?? '').trim()).length;
        const withPol = fixture.controls.filter((c) => (c.relatedPolicies ?? []).length).length;
        expect(withSc).toBeGreaterThanOrEqual(fixture.controls.length - 5);
        expect(withPol).toBeGreaterThanOrEqual(Math.floor(fixture.controls.length * 0.8));
    });
});

describe('Internal Controls wiring', () => {
    const schema = readPrismaSchema();
    const seed = read('prisma/seed.ts');
    const install = read('src/app-layer/usecases/framework/install.ts');
    const dto = read('src/lib/dto/control.dto.ts');

    it('Control + ControlTemplate models carry the new fields', () => {
        for (const model of ['objective', 'successCriteria', 'testingMethodology']) {
            // present at least twice (Control + ControlTemplate)
            expect((schema.match(new RegExp(`\\b${model}\\b`, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
        }
        expect(schema).toContain('relatedPolicies');
    });

    it('a migration adds the columns', () => {
        const migs = fs.readdirSync(path.join(ROOT, 'prisma/migrations'));
        const dir = migs.find((m) => m.includes('internal_controls'));
        expect(dir).toBeTruthy();
        const sql = read(`prisma/migrations/${dir}/migration.sql`);
        expect(sql).toMatch(/ADD COLUMN.+"objective"/);
        expect(sql).toMatch(/ADD COLUMN.+"testingMethodology"/);
    });

    it('seed loads the controls + policy-framework map and creates requirement links (NOT a pack)', () => {
        expect(seed).toContain('internal-controls.json');
        expect(seed).toContain('internal-controls-policy-framework-map.json');
        expect(seed).toContain('controlTemplateRequirementLink');
        // The standalone Internal Controls framework/pack was removed — mapping
        // is policy-mediated, not a dedicated pack.
        expect(seed).not.toContain("'INTERNAL_CONTROLS'");
        expect(seed).not.toContain("'INTERNAL-CONTROLS'");
    });

    it('install copies the new fields + populates framework-mapped internal controls + policy links', () => {
        // These used to assert the literals `objective: tmpl.objective` and
        // `testingMethodology: tmpl.testingMethodology` inline in install.ts.
        // On 2026-08-06 that projection moved into
        // usecases/control/template-projection.ts, so BOTH install endpoints
        // build the Control the same way — POST /controls/templates/install
        // had been writing code/name/category/frequency only, silently
        // dropping the objective, success criteria, testing methodology and
        // policy links that controls.prisma documents as install behaviour.
        //
        // Asserting the literals here would have made that fix look like a
        // regression, so this now checks the DELEGATION. The fields
        // themselves are covered behaviourally, per field, in
        // tests/unit/control-template-projection.test.ts.
        expect(install).toContain('controlDataFromTemplate');
        // Installing a framework pack pulls in internal controls mapped to it.
        expect(install).toContain('mappedInternalTemplates');
        expect(install).toMatch(/requirement:\s*\{\s*frameworkId:\s*pack\.frameworkId\s*\}/);
        // …and resolves their related policies to PolicyControlLinks.
        expect(install).toContain('policyControlLink.createMany');
        expect(install).toContain('linkPolicies');
    });

    it('the detail DTO exposes the new fields', () => {
        for (const f of ['objective', 'successCriteria', 'testingMethodology']) {
            expect(dto).toContain(f);
        }
    });
});

describe('Internal Controls policy→framework map', () => {
    const map = (readJson('prisma/fixtures/internal-controls-policy-framework-map.json') as {
        policies: Record<string, { iso27001?: string[]; nis2?: string[] }>;
    }).policies;
    const isoCodes = new Set((readJson('prisma/fixtures/iso27001_2022_annexA.json') as { key: string }[]).map((r) => r.key));
    const nis2Codes = new Set((readJson('prisma/fixtures/nis2_requirements.json') as { key: string }[]).map((r) => r.key));

    it('every related policy in the control set is mapped', () => {
        const used = new Set<string>();
        for (const c of fixture.controls) for (const p of c.relatedPolicies ?? []) used.add(p);
        const missing = [...used].filter((p) => !map[p]);
        expect(missing).toEqual([]);
    });

    it('every mapped requirement code resolves to a real seeded requirement (no dangling)', () => {
        const dangling: string[] = [];
        for (const [p, m] of Object.entries(map)) {
            for (const code of m.iso27001 ?? []) if (!isoCodes.has(code)) dangling.push(`${p} iso:${code}`);
            for (const code of m.nis2 ?? []) if (!nis2Codes.has(code)) dangling.push(`${p} nis2:${code}`);
        }
        expect(dangling).toEqual([]);
    });

    it('most controls resolve to >= 1 framework requirement via their policies', () => {
        const covered = fixture.controls.filter((c) =>
            (c.relatedPolicies ?? []).some((p) => (map[p]?.iso27001?.length ?? 0) + (map[p]?.nis2?.length ?? 0) > 0),
        ).length;
        expect(covered).toBeGreaterThanOrEqual(Math.floor(fixture.controls.length * 0.85));
    });
});
