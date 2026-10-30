/**
 * Structural ratchet — merge-queue trigger coverage + the lean gate.
 *
 * THE INVARIANT
 * -------------
 * A job that SKIPS reports `skipped`, and branch protection counts that
 * as a pass. A workflow that never TRIGGERS reports nothing at all, and
 * the required status check stays pending forever — the merge queue
 * hangs and every merge in the repo stalls, with no error message
 * anywhere to explain why.
 *
 * Therefore: EVERY workflow file that could own a required status check
 * — mechanically, every workflow with a `pull_request` trigger, since
 * that is what produces a PR check context — must declare `merge_group:`
 * in its `on:` block. Leanness is achieved INSIDE a triggered workflow
 * by making expensive jobs skip on `github.event_name == 'merge_group'`,
 * NEVER by leaving a workflow untriggered.
 *
 * WHY THE QUEUE EXISTS
 * --------------------
 * Two PRs each pass CI against `main` as it was when their run started.
 * Both merge. Nothing ever tests the combination. Git only objects when
 * the collision is textual, so this class merges clean and lands red on
 * `main` — PR A's tests call an export PR B renamed, or both bump a
 * different structural-ratchet floor so neither count is right after.
 *
 * WHAT THIS GUARD LOCKS
 * ---------------------
 *   1. Trigger coverage — every `pull_request` workflow declares
 *      `merge_group:`, or carries a written exemption below.
 *   2. No stale exemptions — an exemption whose file is gone, no longer
 *      has `pull_request`, or has since GAINED the trigger must be
 *      deleted in the same diff.
 *   3. The lean gate is not hollowed out — the jobs that catch semantic
 *      collisions must NOT acquire a `merge_group` skip, and the jobs
 *      deliberately skipped must keep theirs (with the reason recorded).
 *   4. The `paths-filter` trap — a `merge_group` event carries no
 *      base/head pair, so `dorny/paths-filter` must be skipped and its
 *      output defaulted to the conservative value.
 *   5. Queue-run concurrency — a CANCELLED queue run is reported as a
 *      FAILURE and ejects the PR from the queue, so `ci.yml` must never
 *      cancel in-progress runs.
 *   5b. Per-ref concurrency — a workflow-level `concurrency.group` on a
 *      `pull_request` workflow must be keyed by ref. A repo-wide group
 *      serialises unrelated PRs, and `cancel-in-progress: false` does not
 *      mean "cancel nothing" — GitHub still cancels the previously QUEUED
 *      run when a newer one joins the group. The result is worse than a
 *      skip: a skipped job reports `skipped`, but a cancelled run vanishes
 *      from the check rollup entirely, so "no failures and nothing
 *      pending" reads as green on a PR the suite never ran against.
 *   6. The never-require list — contexts produced by workflows this scan
 *      CANNOT see must stay out of the required set (see SCAN SCOPE).
 *
 * SCAN SCOPE — AND ITS LIMIT
 * --------------------------
 * This guard reads `.github/workflows/*.yml`. That is every workflow
 * whose definition lives in this repository, but it is NOT every
 * workflow that produces a PR check context.
 *
 * GitHub-managed workflows run from synthetic paths under `dynamic/`
 * and have no file here to add `merge_group:` to. Today that is
 * code-scanning's CodeQL (`dynamic/github-code-scanning/codeql`), which
 * emits `Analyze (<language>)` contexts on every PR. Whether a managed
 * workflow answers `merge_group` is GitHub's implementation detail, not
 * ours, and it can change without a commit in this repo.
 *
 * Since the invariant cannot be enforced for those contexts, the safe
 * position is that they are NEVER selected as required status checks —
 * requiring one that does not answer `merge_group` hangs every merge in
 * the repo. `NEVER_REQUIRE` below records them, and a test asserts the
 * `ci.yml` docblock names them, so the operator selecting required
 * checks reads the warning where they are already looking.
 *
 * See docs/implementation-notes/2026-08-01-merge-queue.md, which also
 * carries the enablement runbook (the queue is a repository SETTING and
 * is enabled by the repo owner AFTER this workflow change lands). That
 * note is a historical record and is deliberately not edited; this file
 * and the `ci.yml` docblock are the live, enforced statement.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { mdSection } from '../helpers/markdown-regions';

const ROOT = path.resolve(__dirname, '../..');

const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const CI_YML = path.join(WORKFLOW_DIR, 'ci.yml');

/**
 * Workflows that trigger on `pull_request` but deliberately do NOT
 * declare `merge_group:`. Each entry must carry a written reason
 * establishing that the workflow can never own a required status check —
 * that is the ONLY ground on which the invariant does not apply.
 *
 * Adding an entry here is a design decision, not a formality: get it
 * wrong and every merge in the repo hangs silently.
 */
const MERGE_GROUP_EXEMPT: Readonly<Record<string, string>> = {
    'branch-freshness.yml':
        'Contractually non-blocking — the job emits a ::warning:: nudge and always exits 0, ' +
        'so it must never be selected as a required status check and the hang invariant cannot ' +
        'apply. Its measurement also reads github.event.pull_request.{base,head}.sha, which is ' +
        'undefined under merge_group, and the queue ref is by construction up to date with main ' +
        'so the behind-count would be a meaningless zero. If it ever becomes blocking, add ' +
        'merge_group: in the same diff as deleting this entry.',
};

/**
 * Check contexts that must NEVER be added to the required-status-check
 * set, because they come from a workflow this guard cannot reach (see
 * SCAN SCOPE above) and therefore cannot be held to the trigger
 * invariant. Requiring one that does not answer `merge_group` stalls
 * every merge in the repo with no error message.
 *
 * Keyed by the context name as it appears in the GitHub UI / on the PR.
 * `Analyze (…)` is matched as a prefix — code scanning emits one context
 * per configured language and the language list is not ours to pin.
 */
const NEVER_REQUIRE: Readonly<Record<string, string>> = {
    'Analyze (':
        'GitHub-managed code scanning, run from dynamic/github-code-scanning/codeql. There is ' +
        'no workflow file in this repo to add merge_group: to, and whether the managed workflow ' +
        'answers merge_group can change without a commit here. Our own SAST lives in the ci.yml ' +
        '`codeql` job (context "CodeQL SAST (<language>)"), which is in the lean set as a ' +
        'deliberate SKIP — so neither the managed nor the in-repo CodeQL belongs in the ' +
        'required set.',
};

/**
 * `ci.yml` jobs that MUST run in the queue. These are the ones that
 * catch a semantic merge collision: a collision surfaces as a compile
 * failure, a unit failure, or a structural-ratchet count mismatch. If
 * one of these acquires a `merge_group` skip the queue still runs, still
 * goes green, and no longer tests anything the queue exists to test —
 * the most expensive possible failure mode, because it is invisible.
 */
const QUEUE_ENFORCED_JOBS: readonly string[] = [
    'lint',
    'typecheck',
    'test',
    'test-summary',
    'build',
    'security',
    // ADDED #4623. Both already ran in the queue — neither carries a
    // `merge_group` skip — but neither was in this list, so none of the
    // per-job assertions below were applied to them. `ratchets` is the
    // omission that mattered: the docblock above names "a structural-ratchet
    // count mismatch" as a collision this set exists to catch, and a count
    // ratchet is the most collision-prone gate in the pipeline (two PRs each
    // raising the same floor). `Ratchets` is also a REQUIRED check.
    'ratchets',
    'flue',
];

/**
 * `ci.yml` jobs deliberately skipped in the queue, with the reason. Each
 * must (a) still exist, (b) still carry an explicit
 * `github.event_name != 'merge_group'` in its `if:`, and (c) still have
 * a post-merge run on `main` — skipping a job that has NO post-merge run
 * is a real reduction in coverage, not a deferral of one.
 */
const QUEUE_SKIPPED_JOBS: Readonly<Record<string, string>> = {
    e2e: 'Longest job in the pipeline (~17-25 min serial) and a different failure class — a ' +
        'collision surfaces as a compile/unit failure, not a browser-flow failure. Runs on the ' +
        'PR and again on the push to main, so this declines a third run rather than removing one.',
    docker: 'Container build + scan is the most expensive pair in the pipeline (~40 + ~12 min) ' +
        'and a merge collision cannot produce a container-scan finding — the image CVE surface ' +
        'is a property of the base image and dependency tree. Runs unconditionally on push to main.',
    codeql: 'SAST finds taint/injection patterns, not "PR A renamed what PR B calls". Its analyze ' +
        'step also uploads SARIF, which in a queue run would file a code-scanning analysis against ' +
        'the throwaway gh-readonly-queue ref. Runs on the PR and again on the push to main.',
    // ADDED #4623. These three carry the `!= 'merge_group'` condition and no
    // lean-set banner, so the derived check below — which used to key on the
    // BANNER — could not see them and they were governed by nothing. Each
    // reason is the job's own, read from its comments rather than invented.
    changes: 'A `merge_group` event carries no base/head pair, so `dorny/paths-filter` has nothing to ' +
        'diff and errors out ("requires \'base\' input to be configured"). With the filter step skipped ' +
        'its `container` output is empty and the `|| \'true\'` fallback resolves to the CONSERVATIVE ' +
        'value, erring toward running more rather than less. Runs on push and schedule.',
    'e2e-bundle': 'The same event gate as `e2e`, and for the same reason stated in the job: there is no ' +
        'point compiling a test-mode bundle for a job that is skipped in the queue. It produces an ' +
        'artifact rather than a verdict, so skipping it removes no judgement about the diff — and it ' +
        'runs again on the push to main, so the bundle is still built and exercised post-merge.',
    'scanner-image': 'Skipped with `docker` and `trivy` and, per the job\'s own comment, for the same ' +
        'reason: it already ran on the pull request and runs again on the push to main. The image holds ' +
        'the scanner plus the application modules it imports, and a merge collision cannot produce a ' +
        'container-scan finding — that surface is a property of the base image and dependency tree.',
    // REMOVED 2026-10-14: `laya-image`. The job was deleted with the Laya
    // estate, and a stale entry here is not inert — the sibling "no entry names
    // a job that no longer exists" check reads this map as the authority on
    // which jobs are deliberately queue-exempt.
};

/**
 * Jobs that RUN in a queue candidate but are not collision-catching gates
 * (#4623). The third category the enforced/skipped pair needed to be complete.
 *
 * Without this, `QUEUE_ENFORCED_JOBS` was a list with no derived check behind
 * it, and that is not a hypothetical: removing `ratchets` from it was
 * mutation-tested and the whole suite stayed green, because every assertion
 * iterated the list rather than the file. A job silently dropped from it stops
 * being governed and nothing says so — the same shape as the SKIPPED side's
 * documented gap, in the opposite direction.
 */
const QUEUE_RUNS_BUT_NOT_A_GATE: Readonly<Record<string, string>> = {
    'change-class': 'Runs in the queue and exits 0 there BY DESIGN (#4439): it judges pull-request ' +
        'metadata, which a merge_group event does not carry. It runs rather than skips precisely so ' +
        'the context is PRESENT on a candidate — an absent required check scores as zero failures.',
    'coverage-gate': 'Merges nine shard artefacts and enforces the floors. Its verdict is about ' +
        'aggregate coverage, not about two diffs meeting, and it cannot report until every Jest job ' +
        'has finished — so requiring it would serialise the gate behind the slowest shard.',
    'load-smoke': 'A k6 smoke run, advisory by design: its thresholds measure a throwaway runner as ' +
        'much as the code, so a red is not evidence the diff is slower. Nothing about a merge ' +
        'collision shows up in it.',
    trivy: 'QUEUE-EXEMPT BY DEPENDENCY, not by condition — it carries no `!= merge_group` of its own ' +
        'but `needs: [docker]`, and `docker` skips, so it is skipped with it. Recorded here rather ' +
        'than in QUEUE_SKIPPED_JOBS because that map asserts each entry carries the condition, and ' +
        'this one does not. The distinction is worth keeping: a skip by dependency disappears the ' +
        'moment its parent stops skipping.',
};

/** Jobs whose post-merge (`push` to main) run must remain intact. */
const POST_MERGE_JOBS = Object.keys(QUEUE_SKIPPED_JOBS);

function listWorkflows(): string[] {
    return fs
        .readdirSync(WORKFLOW_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .sort();
}

function readWorkflow(file: string): string {
    return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf-8');
}

/**
 * Return the parsed `on:` block. YAML 1.1 parses a bare `on` key as the
 * boolean `true`, so both spellings have to be probed — reading only
 * `doc.on` silently sees `undefined` for every workflow in this repo.
 */
function triggers(file: string): Record<string, unknown> | null {
    const doc = yaml.load(readWorkflow(file)) as Record<string, unknown>;
    const on = (doc?.[true as unknown as string] ?? doc?.on) as unknown;
    return on && typeof on === 'object' ? (on as Record<string, unknown>) : null;
}

const hasTrigger = (file: string, name: string): boolean =>
    Object.prototype.hasOwnProperty.call(triggers(file) ?? {}, name);

/**
 * Slice out one top-level job block: the `  <name>:` header through the
 * line before the next 2-space-indented key. Same helper shape as
 * tests/guardrails/trivy-no-rebuild.test.ts.
 */
/**
 * Every job id `ci.yml` declares, derived from the file (#4623).
 *
 * The assertions that need this are the ones keyed on what a job DOES rather
 * than on what a hand-kept list says about it — so the list cannot be the
 * population, or the check inherits the list's omissions.
 */
function ciJobIds(): string[] {
    const body = CI.slice(CI.indexOf('\njobs:'));
    return body
        .split('\n')
        .map((l) => /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(l)?.[1])
        .filter((id): id is string => Boolean(id));
}

function jobBlock(yamlSrc: string, jobName: string): string {
    const lines = yamlSrc.split('\n');
    const start = lines.findIndex((l) => l === `  ${jobName}:`);
    if (start === -1) throw new Error(`job "${jobName}" not found in ci.yml`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {2}\S/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}

/**
 * A job block with comment lines removed. Every assertion about job
 * CONDITIONS runs against this: the docblocks in ci.yml quote the very
 * expressions being asserted on, so matching raw source would report
 * prose as if it were configuration.
 */
function withoutComments(block: string): string {
    return block
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
}

const MERGE_GROUP_SKIP = /github\.event_name\s*!=\s*'merge_group'/;

const CI = fs.readFileSync(CI_YML, 'utf-8');

describe('merge queue — trigger coverage (the hang invariant)', () => {
    const workflows = listWorkflows();

    it('finds the workflow directory and a non-trivial set of workflows', () => {
        // Cheap sanity check: if the glob ever breaks, every assertion
        // below would vacuously pass over an empty list.
        expect(workflows.length).toBeGreaterThanOrEqual(10);
    });

    it.each(workflows)(
        '%s — a pull_request trigger implies a merge_group trigger (or a written exemption)',
        (file) => {
            if (!hasTrigger(file, 'pull_request')) return; // cannot own a PR check context

            if (Object.prototype.hasOwnProperty.call(MERGE_GROUP_EXEMPT, file)) {
                expect(hasTrigger(file, 'merge_group')).toBe(false);
                return;
            }

            expect(hasTrigger(file, 'merge_group')).toBe(true);
        },
    );

    it('every workflow parses as YAML (a malformed on: block silently changes triggering)', () => {
        for (const file of workflows) {
            expect(() => yaml.load(readWorkflow(file))).not.toThrow();
            // A workflow with no parseable `on:` at all would trigger on
            // nothing — the exact failure this guard exists to catch.
            expect(triggers(file)).not.toBeNull();
        }
    });

    it('ci.yml declares merge_group and explains the collision class it guards', () => {
        expect(hasTrigger('ci.yml', 'merge_group')).toBe(true);

        // A bare `merge_group:` reads as cargo-cult to the next reader, so the
        // file must carry the explanation — but BOUND TO THE BLOCK that gives
        // it, not matched against the whole file.
        //
        // `merge queue` is ordinary English that any comment in a 2000-line
        // workflow may reasonably use, so a whole-file needle is satisfied by
        // the first one that happens to. It had four satisfying positions and
        // the Class D ratchet counted it; a comment added elsewhere in the
        // file (about build memory, nothing to do with queueing) took it to
        // five and tipped the ceiling — proving the needle was measuring the
        // file's vocabulary rather than this trigger's documentation.
        //
        // `gh-readonly-queue` is the anchor: it is the queue's own branch
        // prefix, appears once, and can only be written by someone describing
        // this mechanism.
        const lines = CI.split('\n');
        const anchor = lines.findIndex((l) => l.includes('gh-readonly-queue'));
        expect(anchor).toBeGreaterThan(-1);
        const block = lines.slice(Math.max(0, anchor - 12), anchor + 12).join('\n');

        expect(block).toMatch(/merge queue/i);
        expect(block).toMatch(/stays pending forever|hangs/i);
    });
});

describe('merge queue — no stale exemptions', () => {
    const exempt = Object.entries(MERGE_GROUP_EXEMPT);

    it('the exemption list is a deliberate, reviewable size', () => {
        // Not a cap for its own sake: every entry is a workflow that can
        // never be made a required check. A growing list means that claim
        // is being made loosely.
        expect(exempt.length).toBeLessThanOrEqual(3);
    });

    it.each(exempt)('%s — the exempted workflow still exists', (file) => {
        expect(fs.existsSync(path.join(WORKFLOW_DIR, file))).toBe(true);
    });

    it.each(exempt)('%s — still triggers on pull_request (else the entry is moot)', (file) => {
        expect(hasTrigger(file, 'pull_request')).toBe(true);
    });

    it.each(exempt)('%s — has NOT since gained merge_group (delete the entry if it has)', (file) => {
        expect(hasTrigger(file, 'merge_group')).toBe(false);
    });

    it.each(exempt)('%s — carries a substantive written reason', (file, reason) => {
        expect(typeof reason).toBe('string');
        expect(reason.trim().length).toBeGreaterThanOrEqual(80);
    });

    it.each(exempt)('%s — the workflow file itself documents the omission', (file) => {
        // The reason has to be visible to someone reading the workflow,
        // not only to someone who happens to open this test.
        expect(readWorkflow(file)).toMatch(/merge_group/);
    });

    it('branch-freshness stays non-blocking — the premise of its exemption', () => {
        // The exemption rests on "this can never be a required check".
        // If the job ever starts failing, that premise is gone and the
        // trigger becomes mandatory.
        const src = readWorkflow('branch-freshness.yml');
        expect(src).toMatch(/Non-blocking BY DESIGN/);
        expect(src).toMatch(/^\s*exit 0\s*$/m);
    });
});

describe('merge queue — the lean gate is not hollowed out', () => {
    it.each(QUEUE_ENFORCED_JOBS)(
        'ci.yml job "%s" runs in the queue (no merge_group skip)',
        (job) => {
            expect(withoutComments(jobBlock(CI, job))).not.toMatch(MERGE_GROUP_SKIP);
        },
    );

    it.each(Object.entries(QUEUE_SKIPPED_JOBS))(
        'ci.yml job "%s" skips in the queue, and the skip carries a written reason',
        (job, reason) => {
            expect(jobBlock(CI, job)).toMatch(MERGE_GROUP_SKIP);
            expect(reason.trim().length).toBeGreaterThanOrEqual(80);
        },
    );

    it.each(POST_MERGE_JOBS)(
        'ci.yml job "%s" still runs post-merge — a skip with no post-merge run loses coverage',
        (job) => {
            // Each skipped job must remain reachable on a `push` to main.
            // These jobs are either unconditional apart from the queue
            // skip, or gate only pull_request runs — neither excludes push.
            const conds = withoutComments(jobBlock(CI, job));
            expect(conds).not.toMatch(/github\.event_name\s*==\s*'pull_request'\s*(?:\}|$)/m);
            expect(conds).not.toMatch(/github\.event_name\s*!=\s*'push'/);
        },
    );

    it('the enforced and skipped sets are disjoint, and each is exactly what the file does', () => {
        // RENAMED #4623. This was "disjoint and complete over the gate", and it
        // checked no completeness: non-overlap plus two memberships, indifferent
        // to the other nine jobs. A test whose NAME carries a claim its body does
        // not make is worse than a missing test, because a reader who greps for
        // completeness finds it and stops looking.
        //
        // It now asserts both halves against the file: every enforced job runs in
        // the queue, every skipped job skips it, and no job is in both. Full
        // completeness over ALL of ci.yml is a different question — whether each
        // job is a REQUIRED check — and lives in
        // `tests/guards/ci-check-requiredness-is-declared.test.ts` (#4552).
        const overlap = QUEUE_ENFORCED_JOBS.filter((j) =>
            Object.prototype.hasOwnProperty.call(QUEUE_SKIPPED_JOBS, j),
        );
        expect(overlap).toEqual([]);

        const skips = (job: string) => MERGE_GROUP_SKIP.test(withoutComments(jobBlock(CI, job)));
        expect(QUEUE_ENFORCED_JOBS.filter(skips)).toEqual([]);
        expect(Object.keys(QUEUE_SKIPPED_JOBS).filter((j) => !skips(j))).toEqual([]);

        // Typecheck + Test are the two that actually catch the observed
        // collision class. Losing either silently is the failure mode.
        expect(QUEUE_ENFORCED_JOBS).toContain('typecheck');
        expect(QUEUE_ENFORCED_JOBS).toContain('test');
    });

    it('the HEADER documents the lean set so a reader need not diff the jobs', () => {
        // NARROWED TO THE HEADER, which is what this test is named for. Against
        // the whole file the needle was satisfied by any job's own inline
        // `── Merge-queue lean set: SKIP ──` banner, so deleting the header
        // summary entirely would have kept it green — and it stood at five
        // satisfying positions, which `assertion-needle-uniqueness-ratchet`
        // calls a text search written as an assertion. It is right: the claim
        // is about ONE place, so the read has to be that place.
        const header = CI.slice(0, CI.indexOf('\njobs:'));
        // The slice must have found the boundary: an empty or whole-file header
        // would make this assertion either always fail or mean nothing.
        expect(header.length).toBeGreaterThan(500);
        expect(header.length).toBeLessThan(CI.length);
        expect(header).toMatch(/Merge-queue lean set/);
    });

    it('every job that SKIPS the queue is in QUEUE_SKIPPED_JOBS — keyed on the CONDITION', () => {
        // THE GAP THIS CLOSES, and it is the second version of this fix.
        //
        // `QUEUE_SKIPPED_JOBS` is hand-maintained, and every assertion above
        // iterates IT rather than the file, so a job it omits is governed by
        // nothing: no written reason required, no post-merge reachability
        // checked.
        //
        // The first fix keyed on the `── Merge-queue lean set: SKIP ──` BANNER.
        // That is the DOCUMENTATION of a skip, not the skip — and measured
        // #4623, three jobs carried the condition with no banner
        // (`changes`, `e2e-bundle`, `scanner-image`), so the check could not
        // see them and reported a clean pass over the three that happened to
        // be documented. A detector keyed on a comment finds the jobs whose
        // authors already thought about it.
        //
        // So this keys on `github.event_name != 'merge_group'` in the job's
        // own non-comment body, which is what actually removes the job from a
        // queue run. The banner convention is checked separately below.
        const skipping = ciJobIds().filter((job) =>
            MERGE_GROUP_SKIP.test(withoutComments(jobBlock(CI, job))),
        );
        // The denominator beside the result: a derivation that found nothing
        // would pass the comparison below over two empty sets.
        expect(skipping.length).toBeGreaterThanOrEqual(3);
        expect(new Set(skipping).size).toBe(skipping.length);
        expect([...skipping].sort()).toEqual(Object.keys(QUEUE_SKIPPED_JOBS).sort());
    });

    it('every job that RUNS in the queue is classified — enforced, or explicitly not a gate', () => {
        // THE MIRROR OF THE SKIPPED-SIDE CHECK, and the thing that keeps
        // `QUEUE_ENFORCED_JOBS` honest. Mutation-tested #4623: with `ratchets`
        // deleted from that list the entire suite stayed green, because every
        // assertion iterated the list rather than the file. So a job dropped
        // from it — or a new job never added — was governed by nothing.
        const running = ciJobIds().filter(
            (job) => !MERGE_GROUP_SKIP.test(withoutComments(jobBlock(CI, job))),
        );
        expect(running.length).toBeGreaterThanOrEqual(8);
        const classified = [...QUEUE_ENFORCED_JOBS, ...Object.keys(QUEUE_RUNS_BUT_NOT_A_GATE)];
        expect(new Set(classified).size).toBe(classified.length);
        expect([...running].sort()).toEqual([...classified].sort());
    });

    it.each(Object.entries(QUEUE_RUNS_BUT_NOT_A_GATE))(
        'ci.yml job "%s" is not a gate, and says why in more than a word',
        (job, reason) => {
            // It must still exist, and the reason must be a reason. `false`
            // with no argument records that somebody typed it.
            expect(() => jobBlock(CI, job)).not.toThrow();
            expect(reason.trim().length).toBeGreaterThanOrEqual(80);
        },
    );

    it('every lean-set BANNER attributes to a job that actually skips', () => {
        // The banner is how a reader finds the skip, so it must not point at a
        // job that does not skip — a banner on an enforced job would document
        // an exemption that is not there, which is worse than no banner.
        // Keyed the same bidirectional way (see the detector proof below).
        const lines = CI.split('\n');
        const isJobId = (line: string): string | null =>
            /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line)?.[1] ?? null;
        const bannered: string[] = [];
        lines.forEach((line, i) => {
            const banner = /^(\s*)#\s*──\s*Merge-queue lean set:\s*SKIP\s*──/.exec(line);
            if (!banner) return;
            const step = (banner[1] ?? '').length >= 4 ? -1 : 1;
            for (let j = i + step; j >= 0 && j < lines.length; j += step) {
                const id = isJobId(lines[j] as string);
                if (id) { bannered.push(id); return; }
            }
        });
        expect(bannered.length).toBeGreaterThanOrEqual(3);
        expect(new Set(bannered).size).toBe(bannered.length);
        // Subset, not equality: a skip may be documented in the job's own prose
        // instead of the banner, which the three added in #4623 are.
        for (const job of bannered) {
            expect(Object.keys(QUEUE_SKIPPED_JOBS)).toContain(job);
        }
    });

    it('the banner-to-job attribution works in BOTH placements (detector proof)', () => {
        // Without this, the test above passes just as happily with a scan that
        // only ever looks one way — it would simply attribute two banners to the
        // wrong jobs, and the map could be edited to match the wrong answer.
        const both = [
            '  alpha:',
            '    name: Alpha',
            '    # ── Merge-queue lean set: SKIP ──',
            '    # reason',
            '',
            '  # ── Merge-queue lean set: SKIP ──',
            '  # reason for beta, written above it',
            '  beta:',
            '    name: Beta',
        ].join('\n');
        const lines = both.split('\n');
        const isJobId = (line: string): string | null =>
            /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line)?.[1] ?? null;
        const found: string[] = [];
        lines.forEach((line, i) => {
            const banner = /^(\s*)#\s*──\s*Merge-queue lean set:\s*SKIP\s*──/.exec(line);
            if (!banner) return;
            const step = (banner[1] ?? '').length >= 4 ? -1 : 1;
            for (let j = i + step; j >= 0 && j < lines.length; j += step) {
                const id = isJobId(lines[j] as string);
                if (id) { found.push(id); return; }
            }
        });
        // alpha from the inside-the-body banner, beta from the one above it.
        expect(found.sort()).toEqual(['alpha', 'beta']);
    });
});

describe('merge queue — contexts that must never be required', () => {
    // The guard cannot enforce the trigger invariant on a workflow with no
    // file (see SCAN SCOPE). The mitigation is that the operator selecting
    // required checks is warned in the place they are already reading, so
    // the list and the docblock are held together here.
    it.each(Object.keys(NEVER_REQUIRE))(
        'ci.yml warns against requiring the %s… context',
        (context) => {
            expect(NEVER_REQUIRE[context].length).toBeGreaterThan(80);
            expect(CI).toContain(context);
        },
    );

    it('ci.yml states the never-require rule, not merely the context names', () => {
        expect(CI).toMatch(/never\s+be\s+(selected|added|required)|do\s+NOT\s+require/i);
    });

    it('our own CodeQL SAST job is a queue skip, so it cannot be required either', () => {
        // If someone flips this to run in the queue, requiring it becomes
        // defensible and this whole section needs revisiting — fail loudly.
        expect(QUEUE_SKIPPED_JOBS).toHaveProperty('codeql');
    });
});

describe('merge queue — the quiet breakages', () => {
    it('the paths-filter step is skipped in the queue (no base/head to diff)', () => {
        const changes = jobBlock(CI, 'changes');
        expect(changes).toMatch(/dorny\/paths-filter/);
        // The step must be gated, or it errors and reds the job.
        //
        // The version is deliberately NOT pinned in this pattern. Dependabot
        // bumps this action on its own cadence (v3 → v4 landed on `main`
        // while this very change was in review), and a guardrail that fails
        // on a routine version bump teaches contributors to edit the
        // guardrail rather than read it. What is being asserted is the
        // `if:` gate, not the version.
        expect(changes).toMatch(
            /dorny\/paths-filter@v\d[\w.]*[\s\S]{0,400}?if:\s*github\.event_name\s*!=\s*'merge_group'/,
        );
    });

    it("EVERY changes output defaults to the conservative 'true' when the filter is skipped", () => {
        // `|| 'true'` errs toward running more, never less. Without it a queue
        // run reads an empty string and silently under-runs.
        //
        // GENERALISED from a hardcoded check on `container` alone. The old
        // version asserted the one output that existed when it was written, so a
        // second output added without the fallback — which is exactly what
        // adding `laya` was — passed it without being looked at. The subject is
        // the RULE, so the test has to range over whatever outputs exist.
        const block = jobBlock(CI, 'changes');
        const outputs = [...block.matchAll(/^\s{6}([a-z][a-z0-9_-]*):\s*\$\{\{/gm)]
            .map((m) => m[1] as string);

        // The denominator beside the result: an extraction that found nothing
        // would pass the loop below over an empty set, which is the failure this
        // whole test is about.
        //
        // LOWERED FROM 2 TO 1 ON 2026-10-14, and this is the awkward case the
        // floor is for, so it gets a reason rather than a quiet edit. The second
        // output was `laya`, removed with the Laya estate, so the `changes` job
        // is back to the single `container` output it had when this test was
        // first written against that one output by name.
        //
        // The generalisation is NOT reverted with it. The defect it fixed was
        // asserting the one output that happened to exist, so that a second one
        // added later — which is exactly what `laya` was — passed unexamined.
        // That is a property of the RULE, and the rule has to range over
        // whatever outputs exist whether there are one or five of them. A floor
        // of 1 plus the named member below is what keeps an empty extraction
        // from passing; it is not a claim that one output is the right number.
        expect(outputs.length).toBeGreaterThanOrEqual(1);
        expect(outputs).toContain('container');

        for (const name of outputs) {
            expect(block).toMatch(
                new RegExp(
                    `${name}:\\s*\\$\\{\\{\\s*steps\\.filter\\.outputs\\.${name}\\s*\\|\\|\\s*'true'\\s*\\}\\}`,
                ),
            );
        }
    });

    it('ci.yml never cancels in-progress runs (a cancelled queue run ejects the PR)', () => {
        expect(CI).toMatch(/^\s*cancel-in-progress:\s*false\s*$/m);
        expect(CI).not.toMatch(/cancel-in-progress:\s*true/);
    });

    /**
     * WORKFLOW-LEVEL groups only — column 0. A JOB-level `concurrency:` is
     * deliberately out of scope: `terraform.yml` serialises its apply job
     * against shared remote state, which is correct and has nothing to do
     * with PR check rollups. The trap being closed here is specifically a
     * top-level group shared across refs on a `pull_request` workflow.
     */
    it('every pull_request workflow keys its workflow-level concurrency group by ref', () => {
        const offenders: string[] = [];
        for (const file of listWorkflows()) {
            if (!hasTrigger(file, 'pull_request')) continue;
            const src = readWorkflow(file);
            const m = /^concurrency:\s*\n(?:\s*#.*\n)*\s*group:\s*(.+)$/m.exec(src);
            if (!m) continue; // no group at all cancels nothing — fine
            const group = m[1].trim();
            if (!/github\.(ref|head_ref)/.test(group)) {
                offenders.push(`${file}: group: ${group}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the detector would catch a repo-wide group (regression proof)', () => {
        const bare = 'on:\n  pull_request:\n\nconcurrency:\n  group: some-suite\n';
        const keyed =
            'on:\n  pull_request:\n\nconcurrency:\n  group: some-suite-${{ github.ref }}\n';
        const detect = (src: string) => {
            const m = /^concurrency:\s*\n(?:\s*#.*\n)*\s*group:\s*(.+)$/m.exec(src);
            return m ? /github\.(ref|head_ref)/.test(m[1].trim()) : true;
        };
        expect(detect(bare)).toBe(false);
        expect(detect(keyed)).toBe(true);
    });

    it('no ci.yml job that runs in the queue reads github.event.pull_request', () => {
        // That context is undefined under merge_group — a consumer either
        // fails outright or silently reads an empty string.
        for (const job of QUEUE_ENFORCED_JOBS) {
            const block = jobBlock(CI, job);
            const lines = block
                .split('\n')
                .filter((l) => !/^\s*#/.test(l))
                .filter((l) => l.includes('github.event.pull_request'));
            for (const line of lines) {
                // Permitted only where the surrounding step is itself
                // gated to the pull_request event.
                expect(block).toMatch(/github\.event_name\s*==\s*'pull_request'/);
                expect(line).toBeDefined();
            }
        }
    });
});

describe('merge queue — regression proof (the detector actually detects)', () => {
    it('a workflow with pull_request but no merge_group is flagged', () => {
        const synthetic = ['on:', '  pull_request:', '    branches: [main]'].join('\n');
        const doc = yaml.load(synthetic) as Record<string, unknown>;
        const on = (doc?.[true as unknown as string] ?? doc?.on) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(on, 'pull_request')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(on, 'merge_group')).toBe(false);
    });

    it('a merge_group skip on an enforced job would be caught', () => {
        const gutted = [
            '  typecheck:',
            '    name: Typecheck',
            "    if: ${{ github.event_name != 'merge_group' }}",
            '    runs-on: ubuntu-latest',
        ].join('\n');
        expect(withoutComments(gutted)).toMatch(MERGE_GROUP_SKIP);
    });
});

describe('merge queue — the operator runbook is written down', () => {
    const NOTE = 'docs/implementation-notes/2026-08-01-merge-queue.md';

    it('the implementation note exists', () => {
        expect(fs.existsSync(path.join(ROOT, NOTE))).toBe(true);
    });

    it('the note carries the enablement runbook and the load-bearing ordering', () => {
        // NARROWED, NOT MASKED (#2246). `mdCodeOf` keeps a document's code
        // and blanks its prose; two of the three needles below ARE prose —
        // `/Enablement runbook/i` is a heading and `/required status check/i`
        // a sentence, and both match zero times through that mask (measured).
        // The test's subject is a SECTION of the note, so the fix is to read
        // the section: `gh-readonly-queue` occurs four times in this document
        // and only one of them is inside the runbook, so the whole-document
        // form let the other three stand in for it.
        const src = mdSection(
            fs.readFileSync(path.join(ROOT, NOTE), 'utf-8'),
            'Enablement runbook',
        );
        // The queue is a repository SETTING. The workflow change must land
        // FIRST; reversed, the queue waits on checks that never fire.
        expect(src).toMatch(/Enablement runbook/i);
        expect(src).toMatch(/required status check/i);
        expect(src).toMatch(/gh-readonly-queue/);
    });
});

/**
 * Structural ratchet — a schedule that cannot fire is not a trigger (#3291).
 *
 * THE MEASUREMENT
 * ---------------
 * `queue-candidate-sweep.yml` shipped a `15`-minute step (`*` `/15` in the minute field), was `state=active`, ran
 * correctly on `workflow_dispatch`, and produced ZERO scheduled runs. #3292
 * read that as step syntax plus quarter-hour contention and moved it to
 * `7,37 * * * *`. Eight further eligible slots produced zero runs.
 *
 * Tabulated across every cron on `main` the signal is unambiguous, and it is
 * not the axis #3292 picked:
 *
 *   DAILY or less   8 crons   8 of 8 have fired
 *   SUB-DAILY       1 cron    0 of 1 has fired
 *
 * WHAT THIS LOCKS, AND WHAT IT DOES NOT CLAIM
 * -------------------------------------------
 * No mechanism is asserted. One cron on the interesting side of a correlation
 * cannot establish why, and reasoning a mechanism out of exactly this data is
 * the error #3292 made. What is locked is the observation: in THIS repository
 * nothing sub-daily has ever fired, so a sub-daily cron is a silent no-op and
 * writing one is a defect — it reads as a trigger in review and delivers
 * nothing, which is the same failure shape as a job that skips.
 *
 * The teeth are in the pairing. Asserting only "no sub-daily cron" would be
 * satisfied by deleting the schedule outright, and asserting only "the sweep
 * has an event-driven trigger" would be satisfied while leaving an inert cron
 * in place to be trusted by the next reader.
 */
describe('schedules — a cron that cannot fire is not a trigger (#3291)', () => {
    /** The hour field is the cadence. A single literal fires once a day. */
    const subDaily = (cron: string): boolean => {
        const hour = cron.trim().split(/\s+/)[1];
        return hour !== undefined && !/^\d+$/.test(hour);
    };

    // POSITIVE CONTROL. These are the two shapes this guard must separate;
    // if the parse ever inverts, every assertion below passes vacuously.
    it('the cadence parse distinguishes the shapes it is asked about', () => {
        expect(subDaily('7,37 * * * *')).toBe(true); // the #3292 version
        expect(subDaily('*/15 * * * *')).toBe(true); // the original
        expect(subDaily('0 */6 * * *')).toBe(true);
        expect(subDaily('0 4 * * *')).toBe(false); // DAST — fires
        expect(subDaily('30 3 * * *')).toBe(false); // Load Test — fires
        expect(subDaily('0 5 * * 1')).toBe(false); // weekly — fires
        expect(subDaily('0 9 1 1,4,7,10 *')).toBe(false); // quarterly — fires
    });

    const crons: ReadonlyArray<readonly [string, string]> = listWorkflows().flatMap((file) => {
        const on = triggers(file);
        const sched = on?.schedule;
        if (!Array.isArray(sched)) return [];
        return sched
            .map((e) => (e as { cron?: unknown })?.cron)
            .filter((c): c is string => typeof c === 'string')
            .map((c) => [file, c] as const);
    });

    it('the schedule population is non-empty (else the next assertion is vacuous)', () => {
        // Eight crons were tabulated on 2026-10-08. A collapse to zero means
        // `triggers()` or the glob broke, not that the repo stopped scheduling.
        expect(crons.length).toBeGreaterThanOrEqual(8);
    });

    it.each(crons)('%s — cron %s fires at most once a day', (_file, cron) => {
        expect(subDaily(cron)).toBe(false);
    });

    /**
     * The other half. The sweep's whole value is latency — an orphaned
     * candidate holds 2-4 job slots until something cancels it, and the
     * incident behind #3282 held them for 2h38m. Demoting its cron to daily
     * is only safe because an event-driven trigger carries that latency, so
     * the demotion and the trigger have to be locked together.
     */
    it('queue-candidate-sweep has a trigger that fires without the schedule', () => {
        // NAMED `SWEEP_FILE`, not `file`, and the reason is worth recording.
        //
        // `file` is the parameter name the `it.each` blocks above bind, and
        // Class D's constant resolution matched this declaration to THOSE
        // identifiers: with a file-scope `const file = '...'` in view, the
        // `readWorkflow(file)` at the exemption test resolved to a constant
        // path it never actually reads, which pulled that read into the
        // analysable set and its `/merge_group/` needle — three occurrences —
        // into the ambiguous one. Measured: ambiguous 1 -> 2 and whole-file
        // reads 7 -> 8 on this file alone, which is the entire +1 that took
        // the repo ratchet from 1167 to 1168.
        //
        // Nothing about the assertions changed; only the name. A distinct name
        // keeps the resolution honest, and the collision is cheap to re-create
        // if anyone reintroduces a bare `file` here.
        const SWEEP_FILE = 'queue-candidate-sweep.yml';
        expect(listWorkflows().filter((f) => f === SWEEP_FILE)).toHaveLength(1);

        // `workflow_dispatch` does not count — it needs a human, and the
        // orphans this sweeps are created by automation at 3am.
        const eventDriven = ['workflow_run', 'pull_request', 'push', 'merge_group'].filter((t) =>
            hasTrigger(SWEEP_FILE, t),
        );
        expect(eventDriven.length).toBeGreaterThan(0);

        // And it must stay off `pull_request`/`merge_group` specifically: the
        // first publishes a check context the queue then waits for forever
        // (the hang invariant above), the second runs the sweep from inside
        // the queue it is sweeping. That leaves `workflow_run` or `push`.
        expect(hasTrigger(SWEEP_FILE, 'pull_request')).toBe(false);
        expect(hasTrigger(SWEEP_FILE, 'merge_group')).toBe(false);
    });
});
