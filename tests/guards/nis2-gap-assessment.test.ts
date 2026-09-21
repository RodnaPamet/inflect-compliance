/**
 * NIS2 gap-assessment lifecycle ratchet (Prompt 1).
 *
 * Adapted to the ACTUAL architecture: the NISD2 question bank is NOT a static TS
 * module — it is DB-backed, seeded from the single fixture
 * `prisma/fixtures/nis2-gap-assessment.json` (© NISD2 / CC BY 4.0), read via
 * `Nis2GapAssessmentRepository`. The lifecycle reuses the existing
 * `Nis2SelfAssessment` run store (extended with a `source` column) — NO second
 * bank, NO second assessment model. These invariants lock that in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

// Recursively collect *.ts/*.tsx under src, minus generated dirs.
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (['node_modules', '.next', 'dist'].includes(e.name)) continue;
            out.push(...walk(full));
        } else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
}

describe('NIS2 gap bank — single source of truth', () => {
    it('has NO static TS question bank (the fixture + DB tables are the sole source)', () => {
        expect(exists('src/data/gap-assessments/nis2.ts')).toBe(false);
        expect(exists('src/data/gap-assessments')).toBe(false);
    });

    it('no source file re-declares the gap-<n>-<nn> question id set', () => {
        // The `gap-0-01` id pattern must appear only in the fixture, never
        // transcribed into src/ (which would fork the bank).
        const offenders: string[] = [];
        for (const file of walk(path.join(ROOT, 'src'))) {
            const text = fs.readFileSync(file, 'utf8');
            const ids = text.match(/["'`]gap-\d+-\d+["'`]/g) ?? [];
            if (ids.length >= 5) offenders.push(path.relative(ROOT, file));
        }
        expect(offenders).toEqual([]);
    });

    it('the fixture is the bank: 15 domains, 116 questions, legalBasis present + short', () => {
        const bank = JSON.parse(read('prisma/fixtures/nis2-gap-assessment.json')) as {
            domains: unknown[];
            questions: Array<{ legalBasis?: string; day?: number; domain?: number }>;
        };
        expect(bank.domains.length).toBe(15);
        expect(bank.questions.length).toBe(116);
        for (const q of bank.questions) {
            expect(typeof q.legalBasis).toBe('string');
            expect((q.legalBasis ?? '').length).toBeGreaterThan(0);
            expect((q.legalBasis ?? '').length).toBeLessThanOrEqual(60);
        }
    });

    it('retains the © NISD2 / CC BY 4.0 attribution somewhere in the tree', () => {
        const client = read('src/app/t/[tenantSlug]/(app)/audits/nis2-gap/Nis2GapLifecycleClient.tsx');
        expect(client).toMatch(/NISD2/);
        expect(client).toMatch(/CC BY 4\.0/);
    });
});

describe('NIS2 gap — Audits-page conditional home', () => {
    const page = read('src/app/t/[tenantSlug]/(app)/audits/page.tsx');
    const client = read('src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx');

    it('audits/page.tsx derives hasNis2 and passes it to AuditsClient', () => {
        expect(page).toMatch(/tenantHasNis2\(/);
        expect(page).toMatch(/hasNis2=\{hasNis2\}/);
    });

    it('AuditsClient renders the button ONLY inside the hasNis2 conditional', () => {
        expect(client).toMatch(/hasNis2 && \(/);
        // The button + its route must sit within that conditional block, not
        // as an unconditional element.
        const condIdx = client.indexOf('hasNis2 && (');
        const linkIdx = client.indexOf('audits-nis2-gap-link');
        expect(condIdx).toBeGreaterThan(0);
        expect(linkIdx).toBeGreaterThan(condIdx);
        // No Plus glyph on this navigational entry.
        const block = client.slice(condIdx, condIdx + 400);
        // Label migrated to next-intl — assert the key + its en value.
        expect(block).toMatch(/tx\('nav\.nis2Gap'\)/);
        const en = JSON.parse(read('messages/en.json')) as {
            audits: { nav: Record<string, string> };
        };
        expect(en.audits.nav.nis2Gap).toBe('NIS2 Gap Assessment');
        expect(block).not.toMatch(/<Plus/);
    });

    it('adds NO new sidebar nav entry for nis2-gap', () => {
        const nav = read('src/components/layout/SidebarNav.tsx');
        expect(nav).not.toMatch(/nis2-gap/);
    });
});

describe('NIS2 gap — run store + provenance', () => {
    const schema = readPrismaSchema();
    const block = schema.slice(schema.indexOf('model Nis2SelfAssessment'), schema.indexOf('model Nis2SelfAssessmentAnswer'));

    it('Nis2SelfAssessment carries a source column + tenantId-leading index', () => {
        expect(block).toMatch(/source\s+String/);
        expect(block).toMatch(/@@index\(\[tenantId, createdAt\]\)/);
    });

    it('the migration adds the source column', () => {
        const mig = readSql('prisma/migrations/20260702090000_nis2_assessment_source/migration.sql');
        expect(mig).toMatch(/ADD COLUMN[^;]*"source"/);
    });

    it('the wizard baseline run is stamped WIZARD_BASELINE (not a second model)', () => {
        const onboarding = read('src/app-layer/usecases/onboarding-nis2.ts');
        expect(onboarding).toMatch(/source: 'WIZARD_BASELINE'/);
        // No parallel Nis2GapAssessment model was introduced.
        expect(schema).not.toMatch(/model Nis2GapAssessment\b/);
    });
});

describe('NIS2 gap — propose-not-commit', () => {
    const lifecycle = read('src/app-layer/usecases/nis2-gap-lifecycle.ts');
    // The proposal half (pure scorer) must not call any create-usecase; only the
    // apply half may. Slice each half and assert.
    const proposeStart = lifecycle.indexOf('export async function proposeNis2Remediations');
    const applyStart = lifecycle.indexOf('export async function applyNis2Remediations');
    const proposeBody = lifecycle.slice(proposeStart, applyStart);
    const applyBody = lifecycle.slice(applyStart);

    it('proposeNis2Remediations makes NO direct create-usecase call', () => {
        expect(proposeStart).toBeGreaterThan(0);
        expect(proposeBody).not.toMatch(/createRisk\(/);
        expect(proposeBody).not.toMatch(/createControl\(/);
        expect(proposeBody).not.toMatch(/createTask\(/);
    });

    it('applyNis2Remediations is the only site that creates', () => {
        expect(applyBody).toMatch(/createRisk\(|createControl\(|createTask\(/);
    });

    it('control-linkage prefers linking an existing NIS2 control over a duplicate', () => {
        // classify() returns CONTROL_LINK when the tenant already has NIS2
        // controls, CONTROL_CREATE only when it has none.
        expect(lifecycle).toMatch(/hasNis2Controls \? 'CONTROL_LINK' : 'CONTROL_CREATE'/);
    });
});
