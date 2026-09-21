/**
 * NIS2 gap-assessment data-layer coverage + LICENSING ratchet.
 *
 * The 116-question / 15-domain NIS2 self-assessment question set is
 * imported open data from NISD2/nis2-gap-assessment-schema. Its content is
 * licensed **CC BY 4.0** — permissive, BUT attribution is mandatory. This
 * guard makes the attribution load-bearing: a future edit that strips the
 * credit (from the fixture or the sidecar) fails CI. For a compliance
 * product, silently shipping CC-BY content without credit is not an option.
 *
 * It also locks the data-layer invariants: the fixture validates against
 * the Zod schema, the German-law citations are preserved (not dropped),
 * the four Prisma models exist, the two tenant-scoped ones carry RLS in
 * the migration, and the answer note is in the encryption manifest.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Nis2GapAssessmentSchema } from '@/lib/schemas/nis2-gap-assessment';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
import { sqlCodeOf } from '../helpers/source-blocks';

// #2246 Class A / #2679 LANGUAGE SPLIT. `read` deliberately stays RAW here and
// has exactly two callers, neither of them code: the fixture read is handed to
// JSON.parse, where JSON is DATA and masking has no meaning, and the LICENCE
// read is markdown, which `codeOf` does not lex. The ONE code read in this file
// is the migration, and it is SQL — so it goes through `readSql`, which lexes
// `--` and `/* */`. Handing a `.sql` file to `codeOf` would leave every `--`
// comment intact while the call site READS as masked.
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readSql = (rel: string) => sqlCodeOf(read(rel));

const FIXTURE_PATH = 'prisma/fixtures/nis2-gap-assessment.json';
const LICENSE_PATH = 'prisma/fixtures/nis2-gap-assessment.LICENSE.md';
const MIGRATION_PATH =
    'prisma/migrations/20260626140000_add_nis2_gap_assessment/migration.sql';

const fixture = JSON.parse(read(FIXTURE_PATH));

describe('NIS2 gap-assessment — licensing (CC BY 4.0, attribution mandatory)', () => {
    it('the fixture carries the source, license, and attribution', () => {
        expect(fixture.source).toContain('NISD2/nis2-gap-assessment-schema');
        expect(fixture.license).toMatch(/CC BY 4\.0/);
        expect(fixture.attribution).toMatch(/CC BY 4\.0/);
        expect(fixture.attribution).toMatch(/Kardashev Catalyst|nisd2\.eu/);
    });

    it('a LICENSE sidecar exists and names CC BY 4.0 + the required credit', () => {
        const lic = read(LICENSE_PATH);
        expect(lic).toMatch(/CC BY 4\.0|Creative Commons Attribution 4\.0/);
        expect(lic).toMatch(/Based on the NIS2 Gap Assessment/);
        expect(lic).toContain('https://github.com/NISD2/nis2-gap-assessment-schema');
    });
});

describe('NIS2 gap-assessment — data integrity', () => {
    it('the fixture validates against the Zod schema', () => {
        expect(() => Nis2GapAssessmentSchema.parse(fixture)).not.toThrow();
    });

    it('imports the full set (>=15 domains, >=100 questions)', () => {
        expect(fixture.domains.length).toBeGreaterThanOrEqual(15);
        expect(fixture.questions.length).toBeGreaterThanOrEqual(100);
    });

    it('translated string enums only — no leaked upstream integer codes', () => {
        const CRIT = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
        for (const q of fixture.questions) {
            expect(CRIT.has(q.criticality)).toBe(true);
            expect(typeof q.respondent).toBe('string');
        }
    });

    it('preserves + tags German-law citations (BSIG/§) — none dropped', () => {
        const german = fixture.questions.filter((q: { legalBasis: string }) =>
            /BSIG|BSI|§/.test(q.legalBasis),
        );
        expect(german.length).toBeGreaterThan(0);
        // every question has a non-empty legalBasis tag
        const untagged = fixture.questions.filter(
            (q: { legalBasis: string }) => !q.legalBasis,
        );
        expect(untagged).toEqual([]);
    });
});

describe('NIS2 gap-assessment — schema + RLS + encryption wiring', () => {
    const compliance = readPrismaSchema();
    const migration = readSql(MIGRATION_PATH);

    it('defines the four models (2 global reference, 2 tenant-scoped)', () => {
        for (const m of [
            'model Nis2GapDomain',
            'model Nis2GapQuestion',
            'model Nis2SelfAssessment',
            'model Nis2SelfAssessmentAnswer',
        ]) {
            expect(compliance).toContain(m);
        }
    });

    it('keeps the gap-assessment SEPARATE from the NIS2 Framework (distinct tables)', () => {
        // The framework requirements seed into Framework/FrameworkRequirement;
        // the gap-assessment questions live in their own reference tables.
        expect(compliance).not.toMatch(/model Nis2GapQuestion[\s\S]*frameworkId/);
    });

    it('the two tenant tables carry full RLS in the migration', () => {
        for (const t of ['Nis2SelfAssessment', 'Nis2SelfAssessmentAnswer']) {
            expect(migration).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(
                new RegExp(`CREATE POLICY tenant_isolation ON "${t}"`),
            );
            expect(migration).toMatch(
                new RegExp(`CREATE POLICY tenant_isolation_insert ON "${t}"`),
            );
            expect(migration).toMatch(
                new RegExp(`CREATE POLICY superuser_bypass ON "${t}"`),
            );
        }
    });

    it('the global reference tables get NO tenant RLS (shared library content)', () => {
        for (const t of ['Nis2GapDomain', 'Nis2GapQuestion']) {
            expect(migration).not.toMatch(
                new RegExp(`CREATE POLICY tenant_isolation ON "${t}"`),
            );
        }
    });

    it('encrypts the answer note at rest', () => {
        expect(ENCRYPTED_FIELDS.Nis2SelfAssessmentAnswer).toContain('note');
    });
});
