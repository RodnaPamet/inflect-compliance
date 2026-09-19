/**
 * A CatalogFile requirement carries prose, not its own code and not machine
 * metadata.
 *
 * ═══ WHAT THIS CAUGHT ═══
 *
 * Both halves were live in production on 2026-09-06, and both were being
 * REWRITTEN on every deploy — `applyCatalogFile` updates `title` and
 * `description` unconditionally (prisma/catalog-applier.ts:243-244) and
 * `scripts/entrypoint.sh` runs the catalog seeder on every container start. So
 * neither could heal on its own, and neither would have shown up as a failure.
 *
 *   • NIST SSDF: all 42 requirement titles were the requirement's own code.
 *     A customer opening the framework saw a list reading "PO.1.1, PO.1.2,
 *     PO.2.1" where the practice names belong. The prose existed the whole
 *     time in `nist_ssdf_requirements.json`, matching 42/42 on code.
 *
 *   • 236 of 748 production requirement descriptions ended in the pipeline's
 *     own bookkeeping — `parent_urn: urn:inflect:req:… depth: 3 assessable:
 *     true` — across NIST SSDF (42), OWASP ASVS (128), CIS v8 (56) and SOC 2
 *     (10). Machine metadata rendered to customers as the description.
 *
 * Neither is a wiring bug. The content arrived exactly as designed; it was
 * wrong in the fixture, and every gate over these files checked shape,
 * delivery or coverage — never whether the words were words.
 *
 * ═══ WHY title === code IS THE TEST ═══
 *
 * It is not a heuristic. A requirement's code is its identifier and its title
 * is its name; a row where they are equal has no name, and the equality is
 * exactly what an import that forgot to map the title column produces. The
 * other four shipped CatalogFiles had zero such rows, so the rule cost nothing
 * to adopt and would have caught SSDF on the day it landed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

/**
 * The pipeline bookkeeping that must never reach a description.
 *
 * `parent_urn` / `depth` / `assessable` are emitted by the library-import
 * tooling. `category` and `artifacts` also appear, but only ever AFTER one of
 * these three, so anchoring on the leaders is enough and avoids firing on
 * prose that happens to contain the word "category:".
 */
const MACHINE_METADATA = /\b(?:parent_urn|assessable):|\bdepth:\s*\d/;

interface CatalogRequirement {
    readonly code?: unknown;
    readonly title?: unknown;
    readonly summary?: unknown;
}

/** Every CatalogFile-shaped fixture, with its requirements. */
function catalogFiles(): Array<{ file: string; requirements: CatalogRequirement[] }> {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .flatMap((file) => {
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
            } catch {
                return [];
            }
            const obj = (raw ?? {}) as { framework?: unknown; requirements?: unknown };
            if (!obj.framework || !Array.isArray(obj.requirements)) return [];
            return [{ file, requirements: obj.requirements as CatalogRequirement[] }];
        });
}

describe('catalogue requirements carry prose', () => {
    const files = catalogFiles();
    const all = files.flatMap((f) => f.requirements.map((r) => ({ file: f.file, r })));

    it('the scan finds the CatalogFiles and their requirements (denominator)', () => {
        // Both assertions below are satisfied by an empty list. A fixture
        // rename or a shape change that blinds this scan would otherwise read
        // as a clean bill of health — the failure mode this whole area keeps
        // producing.
        expect(files.length).toBeGreaterThanOrEqual(5);
        expect(all.length).toBeGreaterThan(200);
    });

    it('no requirement title is just its own code', () => {
        const nameless = all
            .filter(({ r }) => typeof r.title === 'string' && r.title === r.code)
            .map(({ file, r }) => `${file}: ${String(r.code)}`);
        expect(nameless).toEqual([]);
    });

    it('no requirement summary carries pipeline metadata', () => {
        const leaking = all
            .filter(({ r }) => typeof r.summary === 'string' && MACHINE_METADATA.test(r.summary))
            .map(({ file, r }) => `${file}: ${String(r.code)}`);
        expect(leaking).toEqual([]);
    });

    /**
     * HOW MANY REQUIREMENTS HAVE NO SUMMARY AT ALL — a downward ratchet.
     *
     * ═══ WHY THIS WAS MISSING (#2615) ═══
     *
     * Every assertion in this file filters `typeof r.summary === 'string'`
     * BEFORE it checks anything, so a requirement with no summary is removed
     * from the population before any rule is applied. The guard could not fail
     * for an ABSENT summary — only for a bad one. That is the same shape as a
     * coverage floor that cannot fail for a library going short (#2626): a
     * check whose population excludes the defect it is named for.
     *
     * The file's fourth assertion states the intent — "stripping it down to
     * nothing ... would satisfy the rule above while destroying the content it
     * exists to protect" — but deleting the key outright is a destruction path
     * that assertion does not cover, because a deleted key is filtered out
     * rather than found hollow. Nothing would have reddened if the 93 authored
     * ISO 27001 summaries were removed tomorrow.
     *
     * Pinned rather than driven to zero. 405 requirements carry no summary, and
     * none of them can be fixed by copying: their `title` already carries the
     * full sentence, so the grounding library's own text adds nothing (SSDF,
     * NIST Privacy, OWASP AISVS, ISO 42001). A ceiling records where the work
     * stands and guarantees it does not go backwards; a `toEqual([])` here would
     * be a red build with no available repair.
     *
     * It was 485. The 80 that left belonged to ISO 9001, ISO 39001 and ISO
     * 28000, and they left by RETIREMENT rather than authoring — no library
     * grounds those three, so the product stopped offering them. A ceiling
     * falling because a population was removed is a different event from one
     * falling because work was done, and saying which is the point of writing
     * it down.
     */
    const REQUIREMENTS_WITHOUT_SUMMARY_CEILING = 405;

    it('requirements with no summary at all stay at or below the ceiling', () => {
        const absent = all.filter(({ r }) => typeof r.summary !== 'string' || !r.summary.trim());
        // Reported with its denominator: a bare count invites lowering the
        // ceiling without knowing whether the population moved under it.
        expect(`${absent.length} of ${all.length}`).toBe(
            `${REQUIREMENTS_WITHOUT_SUMMARY_CEILING} of ${all.length}`,
        );
    });

    it('summaries are prose, not empty and not a bare restatement of the title', () => {
        // The repair strips a suffix. Stripping it down to nothing, or leaving
        // a summary that only repeats the title, would satisfy the rule above
        // while destroying the content it exists to protect.
        const hollow = all
            .filter(({ r }) => typeof r.summary === 'string')
            .filter(({ r }) => {
                const s = (r.summary as string).trim();
                return s.length < 12 || s === String(r.title).trim();
            })
            .map(({ file, r }) => `${file}: ${String(r.code)}`);
        expect(hollow).toEqual([]);
    });
});
