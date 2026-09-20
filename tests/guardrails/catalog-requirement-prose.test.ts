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
import { parseLibraryFile } from '../../src/app-layer/libraries/library-loader';

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

    /**
     * WHY 485 IS THE RIGHT NUMBER, AND NOT A BACKLOG.
     *
     * The ceiling above is a bare count, and a bare count invites someone to
     * drive it down — by writing 485 summaries from knowledge of the standards,
     * which is exactly what FROZEN_UNGROUNDED_POPULATIONS refuses to do for ISO
     * 9001 / 39001 / 28000. So the count needs its reason enforced beside it.
     *
     * The reason, measured across every framework that has both a grounding
     * library and matching code spellings: **a summary is present exactly where
     * the library says more than the title already does.** 702 comparable
     * requirements, 702 in agreement, none against.
     *
     *   library text ≠ title  ->  a summary is carried   (iso27701, asvs-l1,
     *                                                     cis-v8, soc2, dora,
     *                                                     eu-ai-act, imda-mgf,
     *                                                     owasp-asi)
     *   library text = title  ->  no summary             (owasp-aisvs 191,
     *                                                     nist-privacy 100,
     *                                                     iso42001 62, ssdf 42)
     *
     * For the second group the library's `description` IS the title, sometimes
     * with a citation appended — "Training data limited to necessary features
     * (AISVS C1.1.1, Level L1)." — and those titles are already whole
     * requirement statements, median 47 characters against 28 for the titles
     * that do carry one. A summary there would be elaboration written from
     * knowledge, not transcription from a source this repo holds.
     *
     * So this is not a gap that copying can close, and the assertion below is
     * what says so in a way that fails if it stops being true — in EITHER
     * direction. A summary appearing where the source adds nothing is authored
     * content of unknown provenance; a summary disappearing where the source
     * does add something is lost transcription.
     */
    /**
     * "Says more" took three attempts, and each failure is worth keeping.
     *
     *   1. Strip only CITATION-SHAPED parentheticals, compare remainders.
     *      Missed "(AISVS C1.1.1, Level L1)" — 191 false disagreements.
     *   2. Strip ANY trailing parenthetical, compare remainders. Ate the
     *      title's own in "Actions to address AI risks and opportunities
     *      (assessment, treatment, impact)" — 1 false disagreement.
     *   3. Prefix test. A label title can be the opening words of the fuller
     *      prose — "Validate All Input" against "Validate all input against
     *      expected type, length, and range on the server" — 5 false ECHOES,
     *      which is the dangerous direction: it hides real content.
     *
     * What works is to strip ONE trailing parenthetical and require EQUALITY.
     * Equality rather than prefix is what stops (3); stripping exactly one is
     * what stops (2), because a title ending in its own parenthetical still
     * matches once the citation alone is removed.
     */
    const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().toLowerCase();
    const echoesTheTitle = (libText: string, title: string) => {
        const lib = flat(libText);
        const t = flat(title);
        if (lib === t) return true;
        return flat(lib.replace(/\s*\([^()]*\)\s*$/, '')) === t;
    };
    const saysMoreThan = (libText: string, title: string) => !echoesTheTitle(libText, title);

    /** Libraries whose codes join the fixture directly, with the spelling fix each needs. */
    const SUMMARY_PAIRS: Array<[string, string, ((c: string) => string)?]> = [
        ['iso27701-2019.yaml', 'iso27701'],
        ['owasp-asvs-4.0.3.yaml', 'asvs-l1'],
        ['cis-controls-v8.yaml', 'cis-v8-ig1'],
        ['soc2-2017.yaml', 'soc2'],
        ['dora-2022.yaml', 'dora'],
        ['eu-ai-act.yaml', 'eu-ai-act'],
        ['imda-mgf-2026.yaml', 'imda-mgf'],
        ['owasp-agentic-top10.yaml', 'owasp-asi'],
        ['owasp-aisvs-1.0.yaml', 'owasp-aisvs'],
        ['nist-privacy-framework-1.0.yaml', 'nist-privacy'],
        ['iso-42001.yaml', 'iso42001'],
        ['nist-ssdf-800-218.yaml', 'ssdf'],
        // nis2 is deliberately absent: its library is keyed thematically
        // (NIS2-RM) and its fixture by article (Art.21(2)(a)), so a code join
        // resolves nothing. prisma/fixtures/nis2-library-map.json is the join,
        // and tests/guardrails/library-obligations-reach-the-catalogue.test.ts
        // is where that declaration lives.
        // iso27001 is absent for the same class of reason: its library carries
        // 29 coarse Annex A headings against the fixture's 93 controls, so most
        // rows have no comparable node at all.
    ];

    it('a summary is present exactly where the library says more than the title', () => {
        const disagreements: string[] = [];
        let compared = 0;

        for (const [libFile, fixtureName] of SUMMARY_PAIRS) {
            const libPath = path.join(REPO_ROOT, 'src/data/libraries', libFile);
            const fixPath = path.join(REPO_ROOT, 'prisma/fixtures', `${fixtureName}-control-templates.json`);
            if (!fs.existsSync(libPath) || !fs.existsSync(fixPath)) {
                disagreements.push(`${fixtureName}: declared pair does not exist`);
                continue;
            }
            const lib = parseLibraryFile(libPath);
            const byCode = new Map(
                lib.objects.framework.requirement_nodes
                    .filter((n) => typeof n.ref_id === 'string')
                    .map((n) => [String(n.ref_id).trim(), (n.description ?? '').replace(/\s+/g, ' ').trim()]),
            );
            const fixture = JSON.parse(fs.readFileSync(fixPath, 'utf-8')) as {
                requirements?: Array<{ code: string; title?: unknown; summary?: unknown }>;
            };

            for (const r of fixture.requirements ?? []) {
                const libText = byCode.get(r.code);
                if (!libText) continue; // no comparable node — not this rule's business
                compared++;
                const saysMore = saysMoreThan(libText, String(r.title));
                const hasSummary = typeof r.summary === 'string' && r.summary.trim() !== '';
                if (saysMore !== hasSummary) {
                    disagreements.push(
                        `${fixtureName}/${r.code}: library ${saysMore ? 'adds text' : 'only echoes the title'} ` +
                            `but summary is ${hasSummary ? 'present' : 'absent'}`,
                    );
                }
            }
        }

        // Positive control. An empty comparison would make the assertion below
        // pass over nothing, which is the defect this whole file exists to catch
        // one level down.
        expect(compared).toBeGreaterThanOrEqual(700);
        expect(disagreements).toEqual([]);
    });

    it('requirements with no summary at all stay at or below the ceiling', () => {
        const absent = all.filter(({ r }) => typeof r.summary !== 'string' || !r.summary.trim());
        // Reported with its denominator: a bare count invites lowering the
        // ceiling without knowing whether the population moved under it.
        expect(`${absent.length} of ${all.length}`).toBe(
            `${REQUIREMENTS_WITHOUT_SUMMARY_CEILING} of ${all.length}`,
        );
    });

    /**
     * WHERE THE MISSING SUMMARIES ARE — pinned per fixture, both directions.
     *
     * ═══ WHAT THE CEILING ABOVE CANNOT SEE (#2615, the half left over) ═══
     *
     * The assertion above interpolates `all.length` into BOTH sides, so the
     * denominator cancels. It is printed on a failure and never compared —
     * which is exactly what its own comment says it is there to stop: "a bare
     * count invites lowering the ceiling without knowing whether the
     * population moved under it."
     *
     * Measured, not argued (2026-09-20). Delete ISO 27001 `8.34` — a shipped
     * requirement WITH an authored summary — from
     * `iso27001-control-templates.json`. The population moves 989 -> 988,
     * `absent.length` stays at 405, all six tests in this file stay GREEN, and
     * so does every other suite that reads the fixture. A customer lost a
     * requirement and its prose, and nothing said so.
     *
     * THE FIRST CANDIDATE WAS WRONG, AND THE CORRECTION IS THE POINT. This
     * paragraph first named SOC 2 `CC9.1`. Deleting that reddens seven
     * assertions in three other suites — four in
     * `tests/guardrails/soc2-starter-pack-coverage.test.ts` (:137 pins
     * `requirements.length` at 10), two in
     * `library-obligations-reach-the-catalogue.test.ts`, one in
     * `tests/unit/framework-representation.test.ts` — so SOC 2 demonstrates
     * nothing. The blind spot is real but SMALLER than a single example
     * suggests, and the table below says exactly how small.
     *
     * This is not a hypothetical shape. #2669 retired ISO 9001 / 39001 / 28000
     * and moved BOTH numbers by 80 — 485 of 1069 became 405 of 989. The
     * docblock above records in prose that the drop was RETIREMENT rather than
     * authoring, and argues that saying which is the whole point; the
     * assertion beneath it could not tell the two apart. A ceiling that falls
     * because the work was done and a ceiling that falls because the
     * population was deleted are opposite events wearing the same number.
     *
     * ═══ WHY PER FIXTURE AND NOT ONE MORE TOTAL ═══
     *
     * A total is also blind to a swap. The "says more than the title" rule
     * above compares 702 requirements across 12 declared pairs, and two
     * populations sit outside it BY DECLARATION: ISO 27001 (93 — its library
     * carries 29 coarse Annex A headings, so most rows have no comparable
     * node) and NIS 2 (20 — joined by `nis2-library-map.json`, not by code).
     * Strip ten ISO 27001 summaries, author ten onto the NIS 2 rows that lack
     * them, and the total is still 405 with no pair rule to object. Per
     * fixture that is two red lines naming both frameworks.
     *
     * ═══ HOW MUCH OF THIS IS A SECOND COPY OF AN EXISTING PIN ═══
     *
     * Most of it, and a reader re-seating fifteen numbers deserves the figure
     * rather than the argument. METHOD (2026-09-20, reproducible): the 59
     * suites that read `prisma/fixtures` — directly or through
     * `tests/helpers/applied-catalogue.ts` — 49 without a database and 10
     * with; nothing in `tests/e2e` or `tests/regression` reads them. Mutate,
     * run, record which suites redden, restore.
     *
     *   DELETE one summary-carrying requirement   13 of 15 fixtures are
     *                                             already caught elsewhere.
     *   ADD one summary-carrying requirement      10 of 15 are.
     *
     * The gaps, measured rather than reasoned:
     *
     *   blind to a DELETION   iso27001 (93), iso27701 (44)
     *   blind to an ADDITION  iso27001 (93), iso27701 (44), dora (24),
     *                         imda-mgf (19), owasp-asi (10)
     *
     * The DELETION row said 14 and named only iso27001 until adversarial
     * review produced the counterexample: delete code `6` from
     * `iso27701-control-templates.json` — a shipped row WITH an authored
     * summary — and the 59-suite sweep reddens only this file's own two new
     * assertions. The cause is the same filter that explains the rest of the
     * table: `library-obligations-reach-the-catalogue.test.ts:130` selects
     * `n.assessable !== false`, and the iso27701 library node for ref_id `6`
     * ("PIMS-specific guidance") carries `assessable: false`. It is not an
     * obligation, so its disappearance answers to no library and passes.
     *
     * Worth stating because the number is the whole argument for these pins:
     * a reader re-seating fifteen constants is owed a count that survives
     * being checked, and this one did not on the first attempt.
     *
     * The asymmetry has one cause. Fourteen of the fifteen fixtures declare a
     * pair in `library-obligations-reach-the-catalogue.test.ts`
     * (internal-controls-catalog has no library), and that suite asks a
     * ONE-WAY question: does every library obligation REACH the catalogue. A
     * row that leaves is a missing obligation and reddens it; a row that
     * arrives answers to no library and passes. That is the whole of the five
     * fixtures blind to an addition.
     *
     * ISO 27001 escapes both halves, and not for want of a declaration — its
     * join is real and `normalised`, stripping the library's `A.` prefix. The
     * library is what is short: `src/data/libraries/iso27001-2022.yaml`
     * selects 29 Annex A controls (`A.5.1` … `A.8.32`) against the fixture's
     * 93, and `A.8.34` is not one of them, so deleting `8.34` removes no
     * obligation and the pair stays green. On main the 93 rows OF THIS
     * FIXTURE are not pinned or floored anywhere, and only 29 of them are
     * joined — the map below is the first reader of the other 64.
     *
     * Both qualifiers are load-bearing against a grep.
     * `framework-coverage.test.ts:47` does assert `toBe(93)`, but on the
     * SIBLING representation `prisma/fixtures/iso27001_2022_annexA.json`,
     * which also carries 8.34 — so it does not protect this file, confirmed
     * by that suite passing under the 8.34 deletion. And "not joined" would
     * contradict the paragraph above, which correctly says the join IS real
     * for the 29 the library selects.
     *
     * Six fixtures do carry a literal count equal to the denominator here —
     * soc2 10 (`soc2-starter-pack-coverage.test.ts:137`), eu-ai-act 16
     * (`eu-ai-act-framework-coverage.test.ts:153`), iso42001 62
     * (`iso-42001-framework-coverage.test.ts:197`, `:273`), ssdf 42
     * (`ssdf-framework-coverage.test.ts:167`), nist-privacy 100
     * (`nist-privacy-framework-coverage.test.ts:223`), owasp-aisvs 191
     * (`aisvs-framework-coverage.test.ts:195`) — and asvs-l1 128 is pinned as
     * a set equality against the library's L1 tier
     * (`asvs-starter-pack-coverage.test.ts:188`). Those seven entries buy a
     * second re-seat point and no new detection. They stay because the value
     * of this map is the WHOLE ROW read together: it is the only place the 989
     * is decomposed, and dropping the covered seven would leave a map that
     * sums to nothing checkable.
     *
     * DELIBERATELY SENSITIVE TO THE DENOMINATOR. Adding or retiring a
     * requirement reddens this, and that is the feature rather than the cost:
     * it is precisely the event the paragraph above wanted recorded. The
     * repair is one line in this map, in the same PR that moves the catalogue,
     * which is also where a reviewer can see what moved.
     *
     * This constant is local to this file. It is NOT one of the shared
     * zero-allowance baselines, so re-seating it grades nothing but the
     * catalogue.
     */
    const SUMMARY_COVERAGE_BY_FIXTURE: Record<string, string> = {
        'asvs-l1-control-templates.json': '0 of 128',
        'cis-v8-ig1-control-templates.json': '0 of 56',
        'dora-control-templates.json': '0 of 24',
        'eu-ai-act-control-templates.json': '0 of 16',
        'imda-mgf-control-templates.json': '0 of 19',
        'internal-controls-catalog.json': '0 of 174',
        'iso27001-control-templates.json': '0 of 93',
        'iso27701-control-templates.json': '0 of 44',
        'iso42001-control-templates.json': '62 of 62',
        'nis2-control-templates.json': '10 of 20',
        'nist-privacy-control-templates.json': '100 of 100',
        'owasp-aisvs-control-templates.json': '191 of 191',
        'owasp-asi-control-templates.json': '0 of 10',
        'soc2-control-templates.json': '0 of 10',
        'ssdf-control-templates.json': '42 of 42',
    };

    const summaryLessIn = (requirements: CatalogRequirement[]) =>
        requirements.filter((r) => typeof r.summary !== 'string' || !r.summary.trim()).length;

    it('each fixture carries its pinned count of summary-less requirements', () => {
        const measured: Record<string, string> = {};
        for (const f of files) {
            measured[f.file] = `${summaryLessIn(f.requirements)} of ${f.requirements.length}`;
        }

        const pinnedKeys = Object.keys(SUMMARY_COVERAGE_BY_FIXTURE);
        const keys = [...new Set([...pinnedKeys, ...Object.keys(measured)])].sort();
        const differences = keys
            .filter((k) => measured[k] !== SUMMARY_COVERAGE_BY_FIXTURE[k])
            .map((k) => {
                const pinned = SUMMARY_COVERAGE_BY_FIXTURE[k] ?? '(not pinned — a new catalogue)';
                const found = measured[k] ?? '(not a CatalogFile any more — retired or reshaped)';
                return `  ${k}\n      pinned  : ${pinned}\n      measured: ${found}`;
            });

        /**
         * ONE assertion, and its failure message is built from `differences`.
         *
         * An earlier draft threw on `differences` and then ran
         * `expect(measured).toEqual(SUMMARY_COVERAGE_BY_FIXTURE)` beneath it,
         * commented as a backstop that "fires if the walk itself ever stops
         * finding a real mismatch". No such input exists. `differences` walks
         * the UNION of both key sets, and a key held by only one map compares
         * a string against `undefined` and is itself a difference — so
         * `differences.length === 0` already means the two objects have the
         * same keys and the same values, which is exactly what `toEqual` then
         * re-checked. It could not fail on any input, and a line that cannot
         * fail is not a backstop; it is a second copy of the assertion's own
         * precondition. Removed rather than demoted.
         *
         * `keys` is the union of fifteen literal keys and whatever
         * `catalogFiles()` found, so it is never empty and this cannot pass
         * over nothing — the vacuity that the denominator case at the top of
         * this file exists to catch.
         */
        const AGREES = 'every fixture matches its pinned "absent of total"';
        const report =
            differences.length === 0
                ? AGREES
                : [
                      'Requirement summary coverage moved.',
                      '',
                      ...differences,
                      '',
                      'Each entry is "requirements with no summary" of "requirements in the',
                      'fixture". BOTH halves are compared, which is the point — the total',
                      'ceiling above cannot tell a summary being authored from a framework',
                      'being retired.',
                      '',
                      'What to do, by which half moved:',
                      '',
                      '  numerator DOWN   summaries were authored or transcribed. Lower the',
                      '                   entry here AND REQUIREMENTS_WITHOUT_SUMMARY_CEILING',
                      '                   by the same amount, in this PR.',
                      '  numerator UP     prose was destroyed. That is the defect #2615 is',
                      '                   about; restore the summaries rather than re-seat.',
                      '  denominator UP   requirements were added. Seat the new pair and say',
                      '                   in the PR whether the new rows carry prose.',
                      '  denominator DOWN requirements were retired (#2669 did this to three',
                      '                   frameworks). Move BOTH numbers and write RETIRED, so',
                      '                   a falling ceiling is not read as work done.',
                      '  key added        a new CatalogFile fixture. Add it here.',
                      '  key removed      the fixture stopped being CatalogFile-shaped. Check',
                      '                   that was deliberate before deleting the line.',
                      '',
                      'WHICH summaries are right is governed by "a summary is present exactly',
                      'where the library says more than the title" above. This only counts.',
                  ].join('\n');

        expect(report).toBe(AGREES);
    });

    it('the per-fixture pins sum to the ceiling and to the whole population', () => {
        // A BACKSTOP, and measured to be one rather than assumed. It ties the
        // two constants into a single arithmetic fact, but it never fires
        // alone: every way to make the map and the ceiling disagree also
        // reddens one of the two assertions above. Proved by mutation — moving
        // the ceiling to 404 with the map untouched turns this red AND
        // 'requirements with no summary at all stay at or below the ceiling'
        // red; no input was found that reddens only this one.
        //
        // It earns its place on the MESSAGE rather than on detection: the two
        // numbers are re-seated together by hand, and this is the assertion
        // that says they have drifted apart instead of leaving a reader to
        // subtract fifteen entries. The detector for the denominator is the
        // per-fixture test above, where each pin carries its own "of N".
        const pinned = Object.values(SUMMARY_COVERAGE_BY_FIXTURE).map((v) => {
            const m = /^(\d+) of (\d+)$/.exec(v);
            if (!m) throw new Error(`SUMMARY_COVERAGE_BY_FIXTURE entry is not "A of N": ${v}`);
            return { absent: Number(m[1]), total: Number(m[2]) };
        });
        const sumAbsent = pinned.reduce((n, p) => n + p.absent, 0);
        const sumTotal = pinned.reduce((n, p) => n + p.total, 0);

        expect(`${sumAbsent} of ${sumTotal}`).toBe(
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
