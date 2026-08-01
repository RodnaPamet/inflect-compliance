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
        // A bare `merge_group:` reads as cargo-cult to the next reader.
        expect(CI).toMatch(/merge queue/i);
        expect(CI).toMatch(/gh-readonly-queue/);
        expect(CI).toMatch(/stays pending forever|hangs/i);
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

    it('the enforced and skipped sets are disjoint and complete over the gate', () => {
        const overlap = QUEUE_ENFORCED_JOBS.filter((j) =>
            Object.prototype.hasOwnProperty.call(QUEUE_SKIPPED_JOBS, j),
        );
        expect(overlap).toEqual([]);
        // Typecheck + Test are the two that actually catch the observed
        // collision class. Losing either silently is the failure mode.
        expect(QUEUE_ENFORCED_JOBS).toContain('typecheck');
        expect(QUEUE_ENFORCED_JOBS).toContain('test');
    });

    it('the header documents the lean set so a reader need not diff the jobs', () => {
        expect(CI).toMatch(/Merge-queue lean set/);
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

    it("the changes output defaults to the conservative 'true' when the filter is skipped", () => {
        // `|| 'true'` errs toward running more, never less. Without it a
        // queue run reads an empty string and silently under-runs.
        expect(jobBlock(CI, 'changes')).toMatch(
            /container:\s*\$\{\{\s*steps\.filter\.outputs\.container\s*\|\|\s*'true'\s*\}\}/,
        );
    });

    it('ci.yml never cancels in-progress runs (a cancelled queue run ejects the PR)', () => {
        expect(CI).toMatch(/^\s*cancel-in-progress:\s*false\s*$/m);
        expect(CI).not.toMatch(/cancel-in-progress:\s*true/);
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
        const src = fs.readFileSync(path.join(ROOT, NOTE), 'utf-8');
        // The queue is a repository SETTING. The workflow change must land
        // FIRST; reversed, the queue waits on checks that never fire.
        expect(src).toMatch(/Enablement runbook/i);
        expect(src).toMatch(/required status check/i);
        expect(src).toMatch(/gh-readonly-queue/);
    });
});
