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
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * This guard used to certify delivery by reading `prisma/seed.ts`:
 *
 *     expect(seed).toContain('internal-controls.json');
 *     expect(seed).toContain('internal-controls-policy-framework-map.json');
 *
 * `prisma/seed.ts` is not run on production deploys, so that assertion could
 * not fail while the 151 ICN-* controls were undeliverable — and they WERE:
 * production carried zero `ICN-` ControlTemplate rows, and the 865 authored
 * tasks on these same controls shipped green through 24 CI checks into a
 * database that received none of them, because every gate read the fixture and
 * no gate crossed the delivery boundary. The two fixtures it named were also
 * read straight off disk here, so the content assertions below were about bytes
 * whose delivery nothing checked.
 *
 * Both are now taken from the APPLIED corpus — the fixture as named by the
 * seeder `scripts/entrypoint.sh` actually runs — so a fixture that stops being
 * delivered fails this file instead of quietly passing it. The requirement-link
 * and framework-key claims are pinned on `prisma/control-template-seed.ts`, the
 * shared writer that production seeder calls, not on the dev seed.
 *
 * This guard locks:
 *   - a production seeder really applies both fixtures, and hands both to the
 *     shared writer (the denominator: every content case below is vacuous
 *     without it);
 *   - the delivered control set parses, is deduped (unique codes + titles), and
 *     every control has an objective + testing methodology;
 *   - the Control + ControlTemplate models carry the new fields (migration);
 *   - the writer creates policy-mediated requirement links, and internal
 *     controls are still NOT wired as a pack/framework anywhere applied;
 *   - install copies the new fields, populates framework-mapped internal controls,
 *     and resolves related policies to PolicyControlLinks;
 *   - the policy→framework map has no dangling codes and covers the control set;
 *   - the detail DTO exposes the new fields so the UI can render them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { callExpressionOf, codeOf, declarationOf, functionBodyOf } from '../helpers/source-blocks';
import { appliedCatalogFor, appliedSources, declaringSources } from '../helpers/applied-catalogue';

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
type PolicyMap = Record<string, { iso27001?: string[]; nis2?: string[] }>;

const CONTROLS_FIXTURE = 'prisma/fixtures/internal-controls.json';
const MAP_FIXTURE = 'prisma/fixtures/internal-controls-policy-framework-map.json';
/** The seeder `scripts/entrypoint.sh` runs. `prisma/seed.ts` is the dev arm. */
const PROD_SEEDER = 'scripts/seed-control-template-tasks.ts';
/** The one module both seeders call; production reaches it only through PROD_SEEDER. */
const WRITER = 'prisma/control-template-seed.ts';

/** The fixture as some seeder actually applies it, or null if none does. */
const appliedProd = (rel: string) =>
    appliedSources().find((s) => s.file === rel && s.reachesProduction) ?? null;

const controlsSource = appliedProd(CONTROLS_FIXTURE);
const mapSource = appliedProd(MAP_FIXTURE);

const controls: Ctrl[] = controlsSource
    ? ((JSON.parse(controlsSource.text) as { controls?: Ctrl[] }).controls ?? [])
    : [];
const policyMap: PolicyMap = mapSource
    ? ((JSON.parse(mapSource.text) as { policies?: PolicyMap }).policies ?? {})
    : {};

describe('Internal Controls delivery', () => {
    it('a production seeder applies both internal-controls fixtures at all', () => {
        // DENOMINATOR. Every content case below is vacuous on an empty parse,
        // and this is the exact failure the file was blind to: the fixtures
        // were present, parsed and asserted about while reaching no database.
        expect(controlsSource).not.toBeNull();
        expect(controlsSource?.appliedBy).toBe(PROD_SEEDER);
        expect(mapSource).not.toBeNull();
        expect(mapSource?.appliedBy).toBe(PROD_SEEDER);
        expect(controls.length).toBeGreaterThanOrEqual(150);
        expect(Object.keys(policyMap).length).toBeGreaterThanOrEqual(15);
    });

    it('the seeder hands BOTH the fixture and the policy map to the shared writer', () => {
        // Bound to the call and to the declarations, not to the whole file:
        // these extractors THROW when their target is renamed away, so the
        // seeder losing an argument fails loudly instead of leaving a
        // `toContain` for some unrelated mention to satisfy.
        const src = read(PROD_SEEDER);
        const call = callExpressionOf(src, 'seedInternalControls');
        expect(call).toContain('FIXTURE');
        expect(call).toContain('POLICY_MAP');
        expect(declarationOf(src, 'FIXTURE')).toContain('fixtures/internal-controls.json');
        expect(declarationOf(src, 'POLICY_MAP')).toContain(
            'fixtures/internal-controls-policy-framework-map',
        );
    });

    it('the shared writer creates policy-mediated requirement links', () => {
        const body = functionBodyOf(read(WRITER), 'seedInternalControls');
        expect(body).toContain('controlTemplateRequirementLink');
        // The link is mediated by the policy map — not derived from the control.
        expect(body).toContain('policyMap[policy]');
    });

    it('is still NOT wired as a pack or framework of its own, anywhere applied', () => {
        // Widened from `prisma/seed.ts` to the whole applied corpus (dev seeder
        // + every fixture a production seeder names), so a standalone Internal
        // Controls pack cannot reappear via the catalogue route either.
        expect(declaringSources('INTERNAL_CONTROLS')).toEqual([]);
        expect(declaringSources('INTERNAL-CONTROLS')).toEqual([]);
    });
});

describe('Internal Controls fixture (as delivered)', () => {
    it('delivers a substantial, deduped control set (>= 150)', () => {
        expect(controls.length).toBeGreaterThanOrEqual(150);
    });

    it('codes and titles are unique (deduped)', () => {
        const codes = controls.map((c) => c.code);
        const titles = controls.map((c) => c.title.trim().toLowerCase());
        expect(new Set(codes).size).toBe(codes.length);
        expect(new Set(titles).size).toBe(titles.length);
    });

    it('every control has a code, title, objective, and testing methodology', () => {
        for (const c of controls) {
            expect(c.code).toMatch(/^ICN-\d{3}$/);
            expect(c.title.trim().length).toBeGreaterThan(0);
            expect((c.objective ?? '').trim().length).toBeGreaterThan(0);
            expect((c.testingMethodology ?? '').trim().length).toBeGreaterThan(0);
        }
    });

    it('most controls carry success criteria + a related policy (source coverage)', () => {
        const withSc = controls.filter((c) => (c.successCriteria ?? '').trim()).length;
        const withPol = controls.filter((c) => (c.relatedPolicies ?? []).length).length;
        expect(withSc).toBeGreaterThanOrEqual(controls.length - 5);
        expect(withPol).toBeGreaterThanOrEqual(Math.floor(controls.length * 0.8));
    });
});

describe('Internal Controls wiring', () => {
    const schema = readPrismaSchema();
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
    const map = policyMap;
    // NIS2 requirement codes come from the CatalogFile a production seeder
    // applies (`scripts/seed-framework-catalogs.ts`), which is what a customer
    // database actually holds — not from the dev-only nis2_requirements.json
    // this used to read.
    const nis2Catalog = appliedCatalogFor('NIS2');
    const nis2Codes = new Set((nis2Catalog?.requirements ?? []).map((r) => String(r.code)));
    // ISO 27001 has NO production seeder: its requirements reach a database
    // only via `scripts/framework-import.ts`, a manual operator CLI reading
    // `src/data/libraries/iso27001-2022.yaml` — which is both a SUBSET of Annex
    // A and spells its codes `A.5.1` where this map says `5.1`. So the dev
    // fixture stays the only honest denominator for the ISO arm; repointing it
    // at the library would assert something false. Fix the delivery, then the
    // denominator.
    const isoCodes = new Set((readJson('prisma/fixtures/iso27001_2022_annexA.json') as { key: string }[]).map((r) => r.key));

    it('both requirement denominators are non-empty', () => {
        // DENOMINATOR. An empty code set makes the dangling check below pass
        // for every code in the map, which is the shape that let a broken
        // fixture read look like a clean bill of health.
        expect(nis2Catalog).not.toBeNull();
        expect(nis2Codes.size).toBeGreaterThanOrEqual(20);
        expect(isoCodes.size).toBeGreaterThanOrEqual(90);
        expect(Object.keys(map).length).toBeGreaterThanOrEqual(15);
    });

    it('the writer looks up the framework keys the applied catalogue declares', () => {
        // A link is only created when `reqMap(<key>)` finds a Framework row, so
        // the key in the writer and the key in the delivered catalogue must be
        // the same string or every NIS2 link silently resolves to zero.
        const body = functionBodyOf(read(WRITER), 'seedInternalControls');
        expect(nis2Catalog?.framework.key).toBe('NIS2');
        expect(body).toContain("reqMap('NIS2')");
        expect(body).toContain("reqMap('ISO27001')");
    });

    it('every related policy in the control set is mapped', () => {
        const used = new Set<string>();
        for (const c of controls) for (const p of c.relatedPolicies ?? []) used.add(p);
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
        const covered = controls.filter((c) =>
            (c.relatedPolicies ?? []).some((p) => (map[p]?.iso27001?.length ?? 0) + (map[p]?.nis2?.length ?? 0) > 0),
        ).length;
        expect(covered).toBeGreaterThanOrEqual(Math.floor(controls.length * 0.85));
    });
});
