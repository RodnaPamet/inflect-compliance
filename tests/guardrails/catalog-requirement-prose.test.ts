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
     * Pinned rather than driven to zero. 485 requirements still carry no
     * summary, and most of them cannot be fixed by copying: the remaining
     * populations are frameworks whose prose is licensed and not in this repo,
     * or whose `title` already carries the full sentence (SSDF, NIST Privacy).
     * A ceiling records where the work stands and guarantees it does not go
     * backwards; a `toEqual([])` here would be a red build with no available
     * repair.
     */
    const REQUIREMENTS_WITHOUT_SUMMARY_CEILING = 485;

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
