/**
 * IC ORIGINAL gap-fill policy-template ratchet.
 *
 * The bulk of the policy-template library is the ciso-toolkit (MIT) + imported
 * sets (guarded elsewhere). This locks the small set of ORIGINAL, IC-authored
 * templates that fill the topics genuinely absent from those sets — threat &
 * vulnerability management, corporate governance, data classification &
 * handling, MDM/BYOD, physical & environmental security, and a NIS2
 * Art 21(2)(a) master policy — and their framework mapping.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * The availability case read `prisma/seed.ts` and looked for a filename:
 *
 *     const seed = read('prisma/seed.ts');
 *     expect(seed).toContain('policy-templates-original-gaps.json');
 *     expect(seed).toContain('policyTemplate');
 *
 * `prisma/seed.ts` is not run on production deploys — the entrypoint runs
 * `prisma migrate deploy` plus targeted seeders. So that pair could not fail
 * while these six templates were undeliverable to every real tenant, and it
 * would fail the day somebody moved the load into the seeder that actually
 * ships them. The claim in the test's own name — "reaches tenants" — was never
 * the claim being checked. The second half was worse than weak: `policyTemplate`
 * is satisfied dozens of times over in seed.ts by unrelated code, so it was a
 * tautology dressed as a delivery check.
 *
 * It now asks the applied-catalogue helper which sources REACH PRODUCTION, and
 * follows the fixture to the seeder that writes it.
 *
 * The framework map keeps its direct fixture reads: it is imported at runtime by
 * `usecases/policy-template-mapping.ts`, not seeded, so a fixture read is the
 * honest question there. Its NIS2 half now resolves against the requirement set
 * production INSTALLS (`nis2-control-templates.json`) rather than the dev-only
 * `nis2_requirements.json`; the ISO 27001 half cannot follow, because no
 * production seeder ships an ISO 27001 Annex A catalogue at all — see the
 * comment at that assertion.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    appliedCatalogFor,
    appliedCatalogueStats,
    productionDeclaringSources,
} from '../helpers/applied-catalogue';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel: string) => JSON.parse(read(rel));

const GAPS = 'prisma/fixtures/policy-templates-original-gaps.json';
const MAP = 'prisma/fixtures/policy-template-framework-map.json';

/**
 * The label the seeder passes to `fixtureObject(...)` for this fixture. Asking
 * which PRODUCTION-reaching source declares it recovers the writer without
 * hard-coding its path — a renamed seeder reddens the denominator case instead
 * of silently taking every later case with it.
 */
const FIXTURE_LABEL = 'fixtures/policy-templates-original-gaps';

const EXPECTED_REFS = [
    'ORIG-VULN-MGMT',
    'ORIG-GOVERNANCE',
    'ORIG-DATA-CLASSIFICATION',
    'ORIG-MDM-BYOD',
    'ORIG-PHYSICAL-SEC',
    'ORIG-NIS2-MASTER',
] as const;

const CANONICAL_SECTIONS = [
    '## 1. Purpose',
    '## 2. Scope',
    '## 3. Policy Statements',
    '## 4. Responsibilities',
    '## 5. Review',
];

interface Template { externalRef: string; title: string; category: string; language: string; contentType: string; contentText: string; tags: string; source: string }
const fixture = readJson(GAPS) as { _meta: { note?: string }; templates: Template[] };

describe('IC original gap-fill policy templates', () => {
    it('a production seeder applies the gap-fill fixture at all', () => {
        // DENOMINATOR. Every delivery case below is vacuous on an empty scan.
        const { fixtures } = appliedCatalogueStats();
        expect(fixtures.length).toBeGreaterThan(0);
        expect(fixtures).toContain(GAPS);
        expect(productionDeclaringSources(FIXTURE_LABEL).length).toBeGreaterThan(0);
        expect(fixture.templates.length).toBe(EXPECTED_REFS.length);
    });

    it('every gap template is declared by a source that reaches production', () => {
        // The old form of this case only proved prisma/seed.ts mentioned the
        // filename, which no deploy reads.
        const undeliverable = EXPECTED_REFS.filter(
            (ref) => !productionDeclaringSources(ref).includes(GAPS),
        );
        expect(undeliverable).toEqual([]);
    });

    it('the production writer upserts them into the global PolicyTemplate library', () => {
        const writers = productionDeclaringSources(FIXTURE_LABEL);
        expect(writers.length).toBeGreaterThan(0);
        for (const writer of writers) {
            const src = read(writer);
            expect(src).toContain('prisma.policyTemplate.create(');
            expect(src).toContain('prisma.policyTemplate.update(');
            expect(src).toContain('isGlobal: true');
        }
    });

    it('vendors exactly the six original gap templates with required fields', () => {
        const refs = fixture.templates.map((t) => t.externalRef).sort();
        expect(refs).toEqual([...EXPECTED_REFS].sort());
        for (const t of fixture.templates) {
            // `language` is in this list because the production writer puts it
            // in the create/update payload unconditionally; a template missing
            // it fails the seeder, and the entrypoint swallows that failure.
            for (const f of ['title', 'category', 'language', 'contentText', 'tags', 'source'] as const) {
                expect(t[f]).toBeTruthy();
            }
            expect(t.contentType).toBe('MARKDOWN');
            expect(t.source).toBe('IC Original');
        }
    });

    it('every template has all five canonical house-style sections + real content', () => {
        for (const t of fixture.templates) {
            for (const s of CANONICAL_SECTIONS) {
                expect(t.contentText.includes(s)).toBe(true);
            }
            // Substantive, not a stub.
            expect(t.contentText.length).toBeGreaterThan(600);
            expect(t.contentText.startsWith('# ')).toBe(true);
        }
    });

    it('retains ORIGINAL-content discipline: no CC-BY-SA source, no {{tmpl}} tokens', () => {
        expect(fixture._meta.note ?? '').toMatch(/ORIGINAL content/i);
        for (const t of fixture.templates) {
            // A cheap tripwire against an accidental verbatim toolkit paste.
            expect(t.contentText).not.toMatch(/\{\{/);
            expect(t.contentText.toLowerCase()).not.toContain('cc-by-sa');
        }
    });

    it('every gap template is mapped, and every mapped code resolves to a real requirement', () => {
        const map = readJson(MAP) as { mappings: Record<string, { iso27001?: { code: string }[]; nis2?: { code: string }[] }> };

        // NIS2 resolves against the catalogue production installs.
        const nis2Catalog = appliedCatalogFor('NIS2');
        expect(nis2Catalog).not.toBeNull();
        const nis2Codes = new Set(
            (nis2Catalog?.requirements ?? []).map((r) => r.code as string).filter(Boolean),
        );
        expect(nis2Codes.size).toBeGreaterThanOrEqual(20);

        // ISO 27001 has NO production catalogue — no seeder the entrypoint runs
        // ships an Annex A requirement set — so this half stays an
        // internal-consistency check against the vendored fixture. Repointing it
        // would mean naming a delivery path that does not exist.
        const isoCodes = new Set((readJson('prisma/fixtures/iso27001_2022_annexA.json') as { key: string }[]).map((r) => r.key));
        expect(isoCodes.size).toBeGreaterThan(0);

        const dangling: string[] = [];
        for (const ref of EXPECTED_REFS) {
            const m = map.mappings[ref];
            expect(m).toBeTruthy();
            const total = (m.iso27001?.length ?? 0) + (m.nis2?.length ?? 0);
            expect(total).toBeGreaterThan(0);
            for (const e of m.iso27001 ?? []) if (!isoCodes.has(e.code)) dangling.push(`${ref} iso:${e.code}`);
            for (const e of m.nis2 ?? []) if (!nis2Codes.has(e.code)) dangling.push(`${ref} nis2:${e.code}`);
        }
        expect(dangling).toEqual([]);
    });

    it('the dev NIS2 requirement fixture still names the same universe production ships', () => {
        // `nis2_requirements.json` is dev-only (prisma/seed.ts reads it; no
        // production seeder does). Pinning it against the applied catalogue is
        // what keeps an edit to one of the two from drifting unnoticed.
        const devKeys = (readJson('prisma/fixtures/nis2_requirements.json') as { key: string }[])
            .map((r) => r.key)
            .sort();
        const appliedCodes = (appliedCatalogFor('NIS2')?.requirements ?? [])
            .map((r) => r.code as string)
            .sort();
        expect(appliedCodes.length).toBeGreaterThan(0);
        expect(appliedCodes).toEqual(devKeys);
    });
});
