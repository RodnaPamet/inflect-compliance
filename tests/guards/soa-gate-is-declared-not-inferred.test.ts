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
 * The framework universe below is SURVEYED, not listed: library `ref_id`s are
 * read through the repo's own parser and the seeded keys out of
 * `seed-catalog.ts`. A new framework therefore fails this test until somebody
 * classifies it, which is the whole point — the old gate's default was to say
 * yes, and this one's is to say no.
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

/** Framework keys from the library-import path (`ref_id` becomes `Framework.key`). */
function libraryFrameworkKeys(): string[] {
    return fs
        .readdirSync(LIB_DIR)
        .filter((f) => /\.ya?ml$/.test(f))
        // Mapping sets (`a-to-b.yaml`) declare relationships, not frameworks.
        .filter((f) => !f.includes('-to-'))
        .map((f) => parseLibraryFile(path.join(LIB_DIR, f)).ref_id);
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
    const allKeys = [...new Set([...libKeys, ...seeded.map((s) => s.key)])].sort();

    it('surveyed a plausible framework universe (positive control)', () => {
        // Guards against an empty survey passing everything below by vacuity.
        expect(libKeys.length).toBeGreaterThanOrEqual(16);
        expect(seeded.length).toBeGreaterThanOrEqual(6);
        expect(allKeys).toEqual(expect.arrayContaining(['ISO27001-2022', 'ISO9001', 'SOC2']));
    });

    it('every framework the repo can create has an explicit decision', () => {
        // The pinned list IS the decision record. A new framework lands here as
        // a failure naming itself, and whoever adds it says yes or no.
        expect(allKeys).toEqual([
            'AISVS-1.0',
            'CIS-CONTROLS-V8',
            'DORA-2022',
            'EU-AI-ACT-2024',
            'GDPR',
            'IMDA-MGF-2026',
            'ISO27001',
            'ISO27001-2022',
            'ISO27701-2019',
            'ISO28000',
            'ISO39001',
            'ISO42001-2023',
            'ISO9001',
            'NIS2',
            'NIS2-2022',
            'NIST-CSF-2.0',
            'NIST-PF-1.0',
            'NIST-SSDF-800-218',
            'OWASP-ASI-TOP10',
            'OWASP-ASVS-4.0.3',
            'SOC2',
            'SOC2-2017',
        ]);
    });

    it('offers an SoA to exactly the four frameworks that mandate one', () => {
        expect(soaFrameworkKeys()).toEqual([
            'ISO27001',
            'ISO27001-2022',
            'ISO27701-2019',
            'ISO42001-2023',
        ]);
        for (const key of soaFrameworkKeys()) {
            expect(frameworkHasStatementOfApplicability(key)).toBe(true);
        }
    });

    it.each(['ISO9001', 'ISO28000', 'ISO39001'])(
        '%s is kind ISO_STANDARD and still gets no SoA — the exact regression',
        (key) => {
            // Both halves matter. The first is what made the old gate fire; the
            // second is the fix. Reverting the gate to `kind` turns this red.
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
