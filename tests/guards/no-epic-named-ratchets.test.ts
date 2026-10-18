/**
 * An epic ratchet is deleted when its epic ships.
 *
 * WHY
 * ---
 * A ratchet named for one PR or epic — `b7-…`, `item-27-…`, `r14-…`,
 * `epic55-…`, `pr-b-…`, `roadmap-11-…` — does not encode an architectural
 * rule. It encodes the SHAPE OF ONE DIFF. Read the ones that were retired on
 * 2026-08-05 and the pattern is uniform: `readFileSync` the source, then
 * regex it for a literal that happened to be in that PR — a variable name
 * (`handleAssetRowClick`), a Tailwind class order
 * (`font-mono … text-xs … tabular-nums`), the interior spacing of an object
 * literal, a keyframe name in `tailwind.config.js`.
 *
 * Such a test cannot catch a regression the type system would miss: the code
 * it guards is imported and type-checked at its real call sites. What it CAN
 * do is fail when someone renames a variable, sorts classes, extracts a
 * shared helper, or reformats — all of which are refactors, not regressions.
 * So its true-positive rate is structurally zero and its false-positive rate
 * is proportional to how much you improve the code.
 *
 * That is not a neutral cost. 775 of 2,011 test files were ratchets, 29 of
 * them regexing `AssetsClient.tsx` alone. Extracting a shared helper meant
 * fixing dozens of source-string assertions, which made copy-paste the
 * cheaper option every single time. The suite was actively holding the
 * duplication in place.
 *
 * THE RULE
 * --------
 * Name a guard for the INVARIANT it protects, not for the work that
 * introduced it. `no-client-side-filtering`, `rls-coverage`,
 * `encryption-key-enforcement`, `api-permission-coverage` all still make
 * sense years after the PR that added them, and all still fail for a real
 * reason. `b7-asset-risk-tasks-column` never will.
 *
 * If what you want to enforce is structural — a banned import, a required
 * prop, a forbidden identifier, a naming convention — write an ESLint rule
 * instead. An AST rule survives reformatting and renaming; a regex over
 * source text does not.
 *
 * SURVIVORS
 * ---------
 * `ALLOWED` is the set that still carried a load when the retirement ran:
 * either another guard references it by name, or CLAUDE.md documents it as a
 * live platform rule. It is a shrinking list, not a budget to spend — adding
 * a name to it needs the same justification as adding a new guard, and
 * removing one is always welcome.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const GUARD_DIRS = ['tests/guards', 'tests/guardrails'];

/**
 * Filename prefixes that name a PR, batch, epic or roadmap item rather than
 * an invariant. Anchored at the start of the basename so a legitimate name
 * that merely contains one of these substrings is unaffected.
 */
const EPIC_NAME_PATTERNS: RegExp[] = [
    /^b\d+-/, // b1-… b9-…       batch N
    /^item-\d+/, // item-27-…       roadmap item N
    /^r\d+-/, // r13-… r31-…    roadmap N
    /^epic\d+/, // epic52-…        epic N
    /^pr-/, // pr-b-… pr-1-…   a single PR
    /^roadmap-\d+/, // roadmap-11-…    roadmap N
];

/**
 * Epic-named guards that survived the 2026-08-05 retirement, each with the
 * reason it could not simply be deleted. Shrink this list; do not grow it.
 */
const ALLOWED: Record<string, string> = {
    'b4-control-tasks-tab.test.ts': 'referenced by name from single-task-model.test.ts',
    'epic52-datatable-ratchet.test.ts':
        'CLAUDE.md documents it as the DataTable platform rule; referenced by behavioural-coverage-registry + interaction-state-discipline',
    'epic60-ratchet.test.ts':
        'CLAUDE.md documents it as the shared-hooks rule; referenced by no-explicit-any-ratchet',
    'r13-active-band-secondary.test.ts': 'referenced by name from behavioural-coverage-registry.test.ts',
    'r13-press-feedback.test.ts': 'referenced by name from motion-language-discipline.test.ts',
    'r14-mobile-parity-discipline.test.ts': 'referenced by name from mobile-roadmap-integrity.test.ts',
    'r14-no-page-searchbars.test.ts':
        'CLAUDE.md documents it as the search-placeholder rule (searchId + searchPlaceholder presence)',
    'r18-donut-bubble-entrance.test.ts': 'referenced by name from donut-chart-centering.test.ts',
    'r21-prb-sankey-rebuild.test.ts': 'referenced by name from behavioural-coverage-registry.test.ts',
    'r31-document-bar.test.ts': 'referenced by name from inline-subtitle-budget.test.ts',
};

function guardFiles(): string[] {
    const out: string[] = [];
    for (const dir of GUARD_DIRS) {
        const full = path.resolve(__dirname, '../../', dir);
        if (!fs.existsSync(full)) continue;
        for (const name of fs.readdirSync(full)) {
            if (name.endsWith('.test.ts')) out.push(name);
        }
    }
    return out;
}

function isEpicNamed(basename: string): boolean {
    return EPIC_NAME_PATTERNS.some((re) => re.test(basename));
}

describe('epic-named ratchets are not added back', () => {
    it('no new guard is named for a PR, batch, epic or roadmap item', () => {
        const offenders = guardFiles()
            .filter(isEpicNamed)
            .filter((f) => !(f in ALLOWED))
            .sort();

        // The message matters more than the assertion here — whoever trips
        // this is mid-PR and needs to know what to do instead.
        expect({
            offenders,
            hint:
                offenders.length === 0
                    ? 'none'
                    : 'Name the guard for the invariant it protects, not the work that introduced it. ' +
                      'If the rule is structural (banned import, required prop, forbidden identifier, ' +
                      'naming convention), write an ESLint rule instead — an AST rule survives ' +
                      'reformatting and renaming; a regex over source text does not.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('every allowlisted survivor still exists', () => {
        // A stale entry would quietly widen the allowlist for a future file
        // that happens to reuse the name.
        const present = new Set(guardFiles());
        const stale = Object.keys(ALLOWED)
            .filter((f) => !present.has(f))
            .sort();
        expect(stale).toEqual([]);
    });

    it('every allowlisted survivor carries a written reason', () => {
        const unexplained = Object.entries(ALLOWED)
            .filter(([, reason]) => reason.trim().length < 20)
            .map(([f]) => f)
            .sort();
        expect(unexplained).toEqual([]);
    });

    it('the retirement actually happened', () => {
        // Guards against a revert that restores the retired files without
        // anyone noticing this rule went quiet. 777 -> 624 on 2026-08-05.
        //
        // RAISED 700 -> 725 on 2026-09-19, because the ceiling had stopped
        // measuring what it is for. The retirement removed EPIC-NAMED guards;
        // the tree then grew back to 697 with invariant-named ones, which is
        // precisely the growth the comment above says it means to permit. At
        // 697 the headroom was 2 — `toBeLessThan(700)` fails AT 700 — and four
        // legitimate new guards were in flight across two concurrent stacks:
        //
        //     questionnaire-reaches-production      (#2622)
        //     soa-gate-is-declared-not-inferred     (#2617)
        //     section-axis-is-structural            (#2619)
        //     identity-write-ceiling-matches-the-pass (#2638)
        //
        // so the THIRD of them to merge would have turned main red whoever
        // owned it. That is the ceiling catching ordinary work, not a bulk
        // restore.
        //
        // THE COUNT WAS ALWAYS THE BACKSTOP, NOT THE DETECTOR. A bulk restore
        // reintroduces epic-named FILES, and the assertion immediately above
        // names them one by one — it fails with the list, not with a number.
        // 725 still sits 52 below the pre-retirement 777, so a restore of the
        // 153 retired files remains impossible to land quietly.
        //
        // Found by a peer's eight-way union sweep across both stacks; neither
        // a per-branch measurement nor either stack's own union would have
        // seen it, because no single branch crosses the line.
        //
        // RAISED 725 -> 750 on 2026-09-23, for the same cause and with the
        // same reasoning. main stood at 724 — headroom ZERO, because
        // `toBeLessThan(725)` fails AT 725 — so the next guard file anybody
        // added was going to be red whoever owned it. The phase-1 agentic
        // audit contributed six, every one invariant-named:
        //
        //     flue-model-call-writes-art12-row          (#2776)
        //     flue-propose-charges-the-cap              (#2777)
        //     agent-driver-column-has-a-writer          (#2780)
        //     flue-model-output-has-one-destination     (#2782)
        //     agent-autonomy-surface-matches-enforcement (#2784)
        //     flue-guard-outcome-has-arms               (#2781)
        //
        // THE BACKSTOP IS INTACT, which is the only thing that licenses this.
        // The assertion immediately above — the one that names epic-named
        // files individually — is GREEN and unchanged; the count is the
        // backstop, not the detector, and a bulk restore still fails there
        // with a list rather than here with a number. 750 remains 27 below
        // the pre-retirement 777.
        //
        // Caught in the merge queue rather than locally, and the reason is
        // worth recording: the full sweep was green on this branch, then two
        // test-only PRs landed, and the re-check after merging main ran only
        // the two ratchets predicted to move. A shared budget is exactly the
        // thing a predicted subset cannot find. Re-run the WHOLE sweep after
        // a merge, not the part you expect to break.
        // RAISED 750 -> 775 on 2026-10-01, for one file and on the same
        // grounds as the two raises above: the rule retires EPIC-NAMED
        // guards, and `vendored-file-wording.test.ts` is named for the
        // invariant it protects — files a downstream product copies verbatim
        // carry no compliance vocabulary. That is the growth the comment at
        // the top says this ceiling means to permit.
        //
        // Why a new file rather than folding it into an existing one, which
        // would have cost nothing here: nothing in `tests/guards` owns
        // portability. The nearest matches by name (`vendor-surface-*`) are
        // about third-party vendor RECORDS, a different sense of the word.
        // Hanging a portability rule off an unrelated guard would make both
        // harder to find than spending one slot.
        //
        // `.test.tsx` is not counted by `guardFiles()` above. That is not a
        // way round this: the two rendered specs in the same stack are `.tsx`
        // because they render components, and renaming a source-scanning
        // guard to dodge the denominator would be gaming the measure.
        //
        // RAISED 775 -> 776 on 2026-10-15, for one file, on the grounds this
        // ceiling states: `bullmq-job-id-rule.test.ts` is named for the
        // invariant it protects — a custom BullMQ job id is one the library
        // will accept, and no site builds one by hand.
        //
        // Why a new file rather than folding it in, which is the test the two
        // raises above apply: nothing in these directories owns job-id
        // VALIDITY. The nearest match is `fan-out-bucket-matches-schedule`,
        // whose subject is whether the dedupe bucket agrees with the cron
        // period — a different invariant about the same function, and hanging
        // a colon-validity rule off it would make both harder to find, which
        // is the exact argument the 750 -> 775 raise used.
        //
        // What it cost to not have it: #3554. The one enqueue site that did
        // not use the shared factory hand-rolled
        // `ctr:{planId}:{scheduledForIso}`, BullMQ rejected every enqueue, and
        // scheduled control tests did not run in production for 7½ days —
        // ~4,300 failures. The identical defect had already happened at the
        // leaver dispatch (#2175) five weeks earlier, where the lesson was
        // written into a docstring and two call-site tests but never made a
        // property of the tree. One slot is the cheaper half of that trade.
        //
        // Raised to THIS BRANCH'S live count (553 guards + 222 guardrails),
        // not to a round number with headroom: a ceiling with slack admits the
        // next file silently, which is how a ratchet stops ratcheting.
        //
        // RAISED 776 -> 777 on 2026-10-15, for one file, same test applied:
        // `work-overdue-grace-matches-schedule.test.ts` is named for the
        // invariant it protects — the overdue-work reporter's grace periods are
        // three times the cadence of the job that drains each family, derived
        // from `SCHEDULED_JOBS` rather than written twice.
        //
        // Why a new file rather than folding it in: its consumer is a BASH
        // SCRIPT on the production VM with no node available, so the contract
        // is three comment lines in a fixed shape and this test is what makes
        // them binding. `fan-out-bucket-matches-schedule` is the nearest
        // relative and does the same job for the dedupe buckets — a different
        // registry reader for a different consumer, and merging them would
        // couple a TypeScript constant to a shell script's comments.
        //
        // What it cost to not have it: #3558, which exists because #3554 ran
        // 7.5 days with ~4,300 failures while every counter and log line
        // worked. A grace that silently stops matching its cadence turns this
        // alert into noise, then into a muted alert, then back into #3554.
        //
        // RAISED 777 -> 778 on 2026-10-15, for one file, same test applied:
        // `current-state-stays-true.test.ts` is named for the invariant it
        // protects — the design document's "Current state (true today)" section
        // must not describe a retired thing as operating.
        //
        // Why a new file: nothing in these directories compares PROSE against
        // CODE. Every existing guard here reads source, config or schema and
        // asserts about the thing it read; this one reads a document and holds
        // it to the repository. `docs-accuracy` is the nearest relative and
        // governs classification and banners — which file belongs in which
        // bucket — not whether a sentence is still true.
        //
        // What it cost to not have it: #3579. The retirement commit updated the
        // design doc the same day, adding banners at subsection tops, and left
        // TEN body passages describing a deleted container, a deleted provider
        // and a deferred key rotation as current. One read "the Laya service
        // now running on". A banner at the top is the natural minimum effort,
        // it reads as sufficient, and nothing checked the rest.
        //
        // RAISED 778 -> 779 on 2026-10-15, for one file, same test applied:
        // `a-refusal-is-not-a-success.test.ts` is named for the invariant it
        // protects — an executor whose usecase handed back a refusal must
        // report one, rather than reporting success because the argument that
        // carries the verdict is optional.
        //
        // Why a new file: nothing in these directories reads the executor
        // registry's CALL SITES as a population. `runtime-wiring-coverage` is
        // the nearest relative and asks whether each job is dispatched at all;
        // this asks whether each one's result tells the truth. A job can be
        // wired perfectly and still report every refusal as a pass, which is
        // exactly what happened.
        //
        // What it cost to not have it: #3591. `legacy-reconcile` carried
        // `refusal` and `status` into its job details and then omitted the
        // eighth argument to `makeResult`, whose default answer is
        // `success: true`. The first production run of that job refused
        // `NO_FRESH_ROSTER`, wrote `IntegrationExecution: PARTIAL` with the
        // reason, and logged "job processed successfully" in the same breath —
        // for the whole life of the feature, with no type error, no lint
        // warning, and nothing in the diff that looks like a dropped verdict.
        // Its sibling `legacy-access-pull`, registered forty lines earlier,
        // mapped the same refusal correctly and explained why in a comment.
        //
        // RAISED 779 -> 780 on 2026-10-15, for one file, same test applied:
        // `worker-bundle-defines-its-cjs-shims.test.ts` is named for the
        // invariant it protects — a bundle that ships a CJS global must define
        // it, because ESM does not.
        //
        // Why a new file: nothing in these directories reads the BUILD SCRIPT
        // as a contract with the code it bundles. `worker-safe-imports` and
        // `worker-import-graph` ask what may be imported; this asks whether
        // what is imported can RUN once bundled, which is a different question
        // and one no unit test can answer — jest runs from source under CJS,
        // where `require`, `__filename` and `__dirname` are always defined.
        //
        // What it cost to not have it: #3611. The banner defined `require`
        // only while its own comment claimed it defined `__dirname` too.
        // `dist/worker.mjs` used `__dirname` once and defined it zero times,
        // at module scope, so the import threw and took every export in that
        // file with it. The single symptom was `legacy-reconcile` logging
        // "adjudication failed, run stands" on every resolved run, from behind
        // a try/catch that is right to exist — found only by running the job.
        // RAISED 780 -> 781 on 2026-10-16, for one file, same test applied:
        // `cited-test-paths-exist.test.ts` is named for the invariant it
        // protects — a source file that cites a test must cite one that exists.
        //
        // Why a new file: nothing in these directories reads a DOCBLOCK as a
        // claim about the test suite. The nearest neighbours check that a named
        // surface still exists (`quality-coverage-integrity`) or that copy keys
        // resolve (`agents-copy-keys-resolve`); neither looks at what `src/`
        // asserts about `tests/`. It also has to NOT strip comments, which is
        // the opposite of the convention every scanning guard here follows, so
        // folding it into one of them would set a trap for the next author.
        //
        // What it cost to not have it: 12 of 188 cited test paths did not exist
        // (#3355), and four of those claimed in the present tense that a named
        // guard pinned an invariant nothing pinned (#3650) — including the Flue
        // `setProvider` rule, whose own docblock calls the hazard it guards a
        // cross-tenant egress. A dead link tells a reader the citation moved;
        // these told a reader the protection existed, so they stopped looking.
        // RAISED 781 -> 785 on 2026-10-17, for FOUR files, same test applied to
        // each: every one is named for the invariant it protects, and none for
        // the issue that found it. They close #3650, where four docblocks
        // asserted in the present tense that a named guard pinned an invariant —
        // and all four named a file that has never existed in this history.
        //
        //   identity-joiner-pass-stays-pure       the pass reaches nothing, so a
        //                                         dry run provably writes nothing
        //   flue-provider-is-never-set-per-run    no per-run `setProvider`; the
        //                                         race it prevents is a
        //                                         CROSS-TENANT EGRESS by the
        //                                         module's own description
        //   workflow-reads-only-declared-input    a key read but not declared is
        //                                         the one case admission cannot
        //                                         catch, so it died mid-run
        //   one-banner-landmark-in-src            exactly one `role="banner"`,
        //                                         floor as well as ceiling
        //
        // Why four files and not one: the ratchet below forbids an epic-named
        // file, and a file named for a single invariant cannot honestly carry
        // four unrelated ones across four subsystems. Three of the four also
        // need comment MASKING for opposite reasons to each other, which is a
        // trap to leave in one shared file.
        //
        // What it cost to not have them: nothing yet, measurably — all four
        // properties still held when the guards were written. That is the
        // argument FOR them rather than against: each was protected only by a
        // paragraph that told the reader it was protected by a test.
        //
        // RAISED 785 -> 786 on 2026-10-17, for ONE file, the same test applied:
        // `agent-harness-single-write-seam` is named for its invariant. The
        // harness tables' level and register link are claims only the verifying
        // ingest may make, and a second writer would make them indistinguishable
        // from verified ones. It is not folded into
        // `directory-identity-tables-single-write-seam`, whose name and allowlist
        // are about a different subsystem's tables.
        //
        // RAISED 786 -> 787 on 2026-10-17, for ONE file, the same test:
        // `ai-risk-tier-unclassified-writers` is named for its invariant —
        // nothing writes the UNCLASSIFIED AI-system tier in the deploy that
        // only teaches readers the value (#3691). It holds the empty writer
        // allowlist the second deploy (#3669) amends, which no existing guard
        // owns.
        //
        // RAISED 787 -> 788 on 2026-10-18, for ONE file, the same test:
        // `access-review-agent-scope` is named for its invariant — nothing
        // writes the AGENT access-review scope in the deploy that only teaches
        // readers the value (#3674). It holds the empty writer allowlist the
        // second deploy amends, and the type-level proof that the one create
        // seam cannot store the value; no existing guard owns either.
        //
        // RAISED 788 -> 789 on 2026-10-18, for ONE file, the same test:
        // `agent-recertification-single-write-seam` is named for its invariant
        // — the pack, narrowing and sample tables have one writer, and that
        // writer can delete a grant but cannot add authority (#3674, deploy 2).
        // It is not folded into `agent-harness-single-write-seam`, whose
        // tables and allowlist belong to the harness ingest, nor into
        // `access-review-agent-scope`, which is about the scope VALUE.
        expect(guardFiles().length).toBeLessThan(789);
    });

    /**
     * The `rq*` family — the risk-quantification waves — is epic-named by
     * exactly the same logic as `b7-` or `epic55-`, but `^rq` was missing
     * from EPIC_NAME_PATTERNS above, so all 41 files sailed through the
     * 2026-08-05 retirement untouched. Adding the pattern outright would
     * turn CI red on 39 files at once, and several of them still hold the
     * only written record of a contract that has to be re-expressed as a
     * behavioural test before the file can go (see the Box 3 items:
     * bulkDeleteRisk cross-tenant rejection, computeVelocity,
     * getRiskPrivacyLens, the four rendered-test rewrites).
     *
     * So it is a DOWNWARD RATCHET instead — the same shape the repo uses
     * for `as any`. New `rq`-named guards are blocked today; the existing
     * ones come out in tranches, and each tranche lowers the number. It
     * only ever goes down.
     */
    it('the rq* family is on a downward ratchet, not a budget', () => {
        const RQ_CEILING = 35; // 2026-08-06: 41 -> 39 (B3-1) -> 37 (B3-3c, B3-4) -> 36 (B3-4 rendered rewrites). 2026-08-10: -> 35 (B3-5, rq3-ob-f split into a mount guard + the existing rendered test).
        const rqGuards = guardFiles()
            .filter((f) => /^rq\d/.test(f))
            .sort();

        expect({
            count: rqGuards.length,
            ceiling: RQ_CEILING,
            hint:
                rqGuards.length <= RQ_CEILING
                    ? 'ok'
                    : 'Do not add an rq-named guard. Name it for the invariant, ' +
                      'or write the behavioural test the ratchet was standing in for.',
        }).toEqual({ count: rqGuards.length, ceiling: RQ_CEILING, hint: 'ok' });

        // Slack cannot accumulate: retire files and lower the ceiling in the
        // same diff, or the next PR quietly inherits room to add one back.
        expect(rqGuards.length).toBe(RQ_CEILING);
    });
});
