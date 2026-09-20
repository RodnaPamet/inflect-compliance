/**
 * The Statement of Applicability gate must be DECLARED per framework, and every
 * framework this repo can create must have a decision.
 *
 * The defect this pins (#2617): the gate was `Framework.kind === 'ISO_STANDARD'`,
 * so installing ISO 9001, ISO 28000 or ISO 39001 — all three genuinely
 * `ISO_STANDARD`, none of which has a control annex — offered the tenant an
 * Annex A Statement of Applicability, with "Annex A" wording in the
 * audit-readiness and gap-analysis PDFs and an `AnnexAKey` CSV column.
 *
 * The framework universe below is SURVEYED, not listed, across ALL THREE
 * authoring paths. A new framework therefore fails this test until somebody
 * classifies it, which is the whole point — the old gate's default was to say
 * yes, and this one's is to say no.
 *
 * THE FIRST VERSION OF THIS GUARD SURVEYED TWO OF THE THREE, and the one it
 * omitted was the only one that reaches production: the CatalogFile fixtures
 * in `prisma/fixtures/`, applied by `scripts/seed-framework-catalogs.ts` which
 * `scripts/entrypoint.sh:95` runs on every container start. Those declare
 * `ISO27701` and `ISO42001` — bare, unversioned — while the allowlist had only
 * the library spellings `ISO27701-2019` and `ISO42001-2023`. So the gate
 * REMOVED an SoA from two frameworks that had one, and this guard was green
 * throughout, because the keys it compared against never included the ones
 * production creates.
 *
 * That is the same failure the guard is meant to prevent, committed by the
 * guard itself: a survey is only as good as its population, and a population
 * assembled from the files that are easy to grep is not a survey. Both
 * representations are live — `usecases/framework/coverage.ts:18-22` documents
 * that one framework can exist TWICE in `Framework` with different keys, and a
 * tenant's links hang off whichever its database got — so every spelling that
 * reaches a database has to be classified, not just the tidy one.
 */
import fs from 'fs';
import path from 'path';
import { parseLibraryFile } from '@/app-layer/libraries/library-loader';
import {
    frameworkHasStatementOfApplicability,
    soaFrameworkKeys,
} from '@/lib/compliance/statement-of-applicability';

/** Drop line and block comments so a prose mention is not read as a gate. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const LIB_DIR = path.join(process.cwd(), 'src/data/libraries');
const SEED_CATALOG = path.join(process.cwd(), 'prisma/seed-catalog.ts');
const SEED_CATALOGS = 'scripts/seed-framework-catalogs.ts';

/** Framework keys from the library-import path (`ref_id` becomes `Framework.key`). */
function libraryFrameworkKeys(): string[] {
    return fs
        .readdirSync(LIB_DIR)
        .filter((f) => /\.ya?ml$/.test(f))
        // Mapping sets (`a-to-b.yaml`) declare relationships, not frameworks.
        .filter((f) => !f.includes('-to-'))
        .map((f) => parseLibraryFile(path.join(LIB_DIR, f)).ref_id);
}

/**
 * Framework keys from the CatalogFile fixtures — the path production runs.
 *
 * Read from `scripts/seed-framework-catalogs.ts`'s own CATALOG_FIXTURES list
 * rather than globbing `prisma/fixtures/`, so a fixture that exists but is not
 * wired into the seeder is correctly absent, and one that is wired in cannot
 * be missed.
 */
function appliedCatalogFrameworks(): Array<{ key: string; kind: string }> {
    const seeder = fs.readFileSync(path.join(process.cwd(), SEED_CATALOGS), 'utf-8');
    const listed = [...seeder.matchAll(/'(prisma\/fixtures\/[^']+\.json)'/g)].map((m) => m[1]);
    const out: Array<{ key: string; kind: string }> = [];
    for (const rel of listed) {
        const full = path.join(process.cwd(), rel);
        if (!fs.existsSync(full)) continue;
        const fw = JSON.parse(fs.readFileSync(full, 'utf-8')).framework;
        if (fw?.key) out.push({ key: fw.key, kind: fw.kind ?? 'ISO_STANDARD' });
    }
    return out;
}

/** Framework keys from the seed-catalog path, with the `kind` each is created as. */
function seededFrameworks(): Array<{ key: string; kind: string }> {
    const src = fs.readFileSync(SEED_CATALOG, 'utf-8');
    const out: Array<{ key: string; kind: string }> = [];
    // Only `create:` blocks on a framework upsert carry both fields.
    for (const m of src.matchAll(/create:\s*\{\s*key:\s*'([A-Z0-9-]+)'[^}]*?\}/g)) {
        const body = m[0];
        if (!/name:/.test(body)) continue; // task/other upserts, not frameworks
        const kind = body.match(/kind:\s*'([A-Z_]+)'/)?.[1] ?? 'ISO_STANDARD'; // schema default
        out.push({ key: m[1], kind });
    }
    return out;
}

describe('SoA gate is declared, not inferred (#2617)', () => {
    const libKeys = libraryFrameworkKeys();
    const seeded = seededFrameworks();
    const applied = appliedCatalogFrameworks();
    const allKeys = [
        ...new Set([...libKeys, ...seeded.map((s) => s.key), ...applied.map((a) => a.key)]),
    ].sort();
    // Every ISO_STANDARD row from either non-library path, which is the
    // population the old `kind` gate would have offered an SoA to.
    const isoKindKeys = [...seeded, ...applied].filter((f) => f.kind === 'ISO_STANDARD');

    it('surveyed a plausible framework universe (positive control)', () => {
        // Guards against an empty survey passing everything below by vacuity.
        expect(libKeys.length).toBeGreaterThanOrEqual(16);
        // Three: ISO 27001, SOC 2 and NIS2. It was six until ISO 9001, ISO
        // 39001 and ISO 28000 were retired and removed from seed-catalog.ts.
        // Three is still enough for the survey to mean something, because SOC 2
        // — the ISO_STANDARD-by-default witness this guard turns on — is one of
        // them.
        expect(seeded.length).toBeGreaterThanOrEqual(3);
        // The path that reaches production. Asserted separately and by NAME,
        // because its absence is what made the first version of this guard
        // green while the gate was wrong.
        // 15, and that is the measured figure rather than a margin below it.
        // It was 18 with a floor of 17; deleting the ISO 9001 / 39001 / 28000
        // fixtures on retirement took three away. Set to the population itself
        // so a fixture silently dropping out of the production seeder reddens
        // here instead of being absorbed by slack.
        expect(applied.length).toBeGreaterThanOrEqual(15);
        expect(applied.map((a) => a.key)).toEqual(
            expect.arrayContaining(['ISO27701', 'ISO42001', 'ISO27001', 'SOC2']),
        );
        expect(allKeys).toEqual(expect.arrayContaining(['ISO27001-2022', 'NIS2', 'SOC2']));
    });

    it('every ISO_STANDARD framework production creates is classified either way', () => {
        // The old gate said yes to all of these. Each one now has an explicit
        // answer, and the answers are asserted together so a new ISO_STANDARD
        // fixture cannot land without someone deciding.
        const decided = Object.fromEntries(
            isoKindKeys.map((f) => [f.key, frameworkHasStatementOfApplicability(f.key)]),
        );
        expect(decided).toEqual({
            ISO27001: true,
            ISO27701: true,
            ISO42001: true,
            // NOT a typo. `prisma/seed-catalog.ts` creates SOC2 with no `kind`
            // at all, so it took the schema default — which is ISO_STANDARD.
            // The old gate therefore offered SOC 2, a Trust Services Criteria
            // framework with no Annex A whatsoever, a Statement of
            // Applicability. That is the schema-default half of #2617 showing
            // up in real data rather than in theory.
            SOC2: false,
        });
    });

    it('every framework the repo can create has an explicit decision', () => {
        // The pinned list IS the decision record. A new framework lands here as
        // a failure naming itself, and whoever adds it says yes or no.
        //
        // 35 keys, not the 22 this guard first pinned. The 12 it missed were
        // every key from the CatalogFile path — the one production runs — which
        // is why it stayed green while `ISO27701` and `ISO42001` were losing
        // their SoA. The duplicate-looking pairs (ISO27701 / ISO27701-2019,
        // OWASP-ASVS / OWASP-ASVS-4.0.3, ...) are NOT duplicates: a framework
        // can exist twice in `Framework` under different keys, one row per
        // authoring path, and a tenant's links hang off whichever its database
        // got (usecases/framework/coverage.ts:18-22).
        expect(allKeys).toEqual([
            'AISVS-1.0',
            'CIS-CONTROLS-V8',
            'CIS-V8',
            // COSO gets NO Statement of Applicability, and the reason is the
            // same one that shapes its whole implementation: an SoA lists which
            // Annex A controls apply and why, and COSO has no Annex A. It stops
            // at 17 principles and leaves control design to the organization,
            // so there is no fixed list for a tenant to accept or exclude.
            'COSO-ICF-2013',
            'DORA',
            'DORA-2022',
            'EU-AI-ACT',
            'EU-AI-ACT-2024',
            'GDPR',
            'IMDA-MGF',
            'IMDA-MGF-2026',
            'INTERNAL_CONTROLS',
            'ISO27001',
            'ISO27001-2022',
            'ISO27701',
            'ISO27701-2019',
            'ISO42001',
            'ISO42001-2023',
            'NIS2',
            'NIS2-2022',
            'NIST-CSF-2.0',
            'NIST-PF-1.0',
            'NIST-PRIVACY',
            'NIST-SSDF',
            'NIST-SSDF-800-218',
            'OWASP-AISVS',
            'OWASP-ASI',
            'OWASP-ASI-TOP10',
            'OWASP-ASVS',
            'OWASP-ASVS-4.0.3',
            'SOC2',
            'SOC2-2017',
        ]);
    });

    it('offers an SoA to exactly the three standards that mandate one, under every spelling', () => {
        expect(soaFrameworkKeys()).toEqual([
            'ISO27001',
            'ISO27001-2022',
            'ISO27701',
            'ISO27701-2019',
            'ISO42001',
            'ISO42001-2023',
        ]);
        for (const key of soaFrameworkKeys()) {
            expect(frameworkHasStatementOfApplicability(key)).toBe(true);
        }
    });

    it.each(['SOC2'])(
        '%s is kind ISO_STANDARD and still gets no SoA — the exact regression',
        (key) => {
            // Both halves matter. The first is what made the old gate fire; the
            // second is the fix. Reverting the gate to `kind` turns this red.
            //
            // This used to name ISO 9001 / 39001 / 28000 as well. Those three
            // were retired, and SOC 2 is the better witness anyway: it is a
            // Trust Services framework with no Annex A that takes the
            // ISO_STANDARD schema default because `prisma/seed-catalog.ts`
            // creates it with no `kind` at all. The regression this guard exists
            // for is exactly that — a gate inferring an SoA from `kind`.
            const row = seeded.find((s) => s.key === key);
            expect(row?.kind).toBe('ISO_STANDARD');
            expect(frameworkHasStatementOfApplicability(key)).toBe(false);
        },
    );

    it('fails closed on a framework nobody classified', () => {
        // `Framework.kind` defaults to ISO_STANDARD in the schema AND in the
        // importer's unknown-kind fallback, so this is the realistic new
        // framework, not a synthetic one.
        expect(frameworkHasStatementOfApplicability('SOME-NEW-PACK-2027')).toBe(false);
        expect(frameworkHasStatementOfApplicability('')).toBe(false);
    });

    it('no SoA consumer re-derives the gate from `kind`', () => {
        // The name `isIsoFamily` is what invited `kind === 'ISO_STANDARD'` in
        // the first place; the field is now `hasStatementOfApplicability`.
        //
        // Comments are STRIPPED before matching. The first run of this test
        // failed on two prose mentions — this file's own docblock and a stale
        // `coverage.ts` comment still citing the old derivation — which is a
        // guard reporting the wrong thing, not a gate.
        const roots = ['src/app-layer/usecases/soa.ts', 'src/app-layer/usecases/framework/coverage.ts'];
        for (const rel of roots) {
            const code = stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf-8'));
            expect({ file: rel, gate: code.match(/kind === 'ISO_STANDARD'/)?.[0] ?? null }).toEqual({
                file: rel,
                gate: null,
            });
        }
    });

    it('strips comments without eating code (positive control)', () => {
        // Without this, an over-eager stripper would make the test above pass
        // by deleting everything.
        expect(stripComments("a; // kind === 'ISO_STANDARD'\nb;")).toBe('a; \nb;');
        expect(stripComments("/* kind === 'ISO_STANDARD' */ keep;")).toBe(' keep;');
        expect(stripComments("x = kind === 'ISO_STANDARD';")).toBe("x = kind === 'ISO_STANDARD';");
    });
});
