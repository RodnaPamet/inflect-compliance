/**
 * CI/CD pipeline-integrity capstone — the meta-ratchet.
 *
 * Four remediations hardened the build / test / release pipeline:
 *
 *   1. Dependency-install integrity — strict peer resolution
 *      (`no-legacy-peer-deps`) + deterministic `npm ci` installs
 *      (`deterministic-install`).
 *   2. E2E test isolation — fixture-scoped tenants, no cross-test
 *      `let` cascade (`e2e-isolation`).
 *   3. (retired 2026-09-02 — the staging smoke gate and OI-2 helm
 *      invariants guarded a deploy pipeline that never deployed; see the
 *      note in GUARDRAILS below.)
 *   4. Build / env-validation discipline — the CI build skips
 *      compile-time env validation deliberately; runtime is the
 *      real gate.
 *   5. Merge-queue trigger coverage — every workflow that could own a
 *      required status check answers `merge_group`, and the lean queue
 *      gate keeps the jobs that catch semantic merge collisions
 *      (`merge-queue-trigger-coverage`).
 *   6. Release-bot push identity — semantic-release pushes the
 *      `chore(release)` commit to `main` under a dedicated GitHub App,
 *      because `GITHUB_TOKEN` is declined (GH006) once `main` has
 *      required status checks and cannot be a ruleset bypass actor
 *      (`release-bot-identity`).
 *
 * Each of 1–3, 5 and 6 shipped its OWN structural guardrail. THIS test
 * guards the guards: it fails CI if any of those guardrail files is
 * deleted or gutted to a no-op, so a future "simplify the tests"
 * change cannot quietly dismantle the protection. It also locks the
 * build/env-validation posture (item 4).
 *
 * Make the safe path the default path: a contributor who removes a
 * pipeline guardrail must reckon with a red meta-ratchet, not a
 * silently weakened pipeline.
 *
 * See docs/ci-cd-pipeline-integrity.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
import { codeOf } from '../helpers/source-blocks';

// #2246 Class A — the mask goes at the READ SEAM, and WHICH masker depends on
// the language. `read` stays RAW because this file also reads Markdown, SQL and YAML, none of
// which `codeOf` lexes — handing it YAML once blanked a bare-scalar URL from
// `//` to end of line. TypeScript reads go through `readSrc`, which masks.
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readSrc = (rel: string) => codeOf(read(rel));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The pipeline guardrail registry. Each entry must (a) exist,
 * (b) still contain its subject anchors — proof it was not gutted
 * into a no-op — and (c) carry a real assertion surface. Removing
 * a remediation means deleting its guardrail AND its registry
 * entry here in the same diff, which is the design conversation.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guards/no-legacy-peer-deps.test.ts',
        pillar: 'dependency-install integrity (strict peers)',
        anchors: ['legacy-peer-deps', 'overrides'],
    },
    {
        file: 'tests/guards/deterministic-install.test.ts',
        pillar: 'dependency-install integrity (deterministic npm ci)',
        anchors: ['npm ci', 'engines', 'install path'],
    },
    {
        file: 'tests/guards/e2e-isolation.test.ts',
        pillar: 'E2E test isolation',
        anchors: ['cascade', 'isolatedTenant'],
    },
    // REMOVED 2026-09-02 (#2226): 'staging smoke gate' and 'release workflow
    // (OI-2 helm invariants)'. Both guarded `.github/workflows/deploy.yml` —
    // an EKS/helm pipeline that was `workflow_dispatch`-only, whose
    // auto-trigger was commented out pending a staging environment that was
    // never provisioned, and which never ran successfully. It was deleted with
    // the rest of the unapplied AWS estate.
    //
    // Worth stating plainly, because this file is the meta-layer: those two
    // entries meant this guard asserted the EXISTENCE of guards that asserted
    // the SHAPE of a deploy pipeline that had never deployed anything. Three
    // levels of green, none of them touching conduct. The real deploy path is
    // `ghcr-publish.yml` + Watchtower on the production VM.
    {
        file: 'tests/guardrails/merge-queue-trigger-coverage.test.ts',
        pillar: 'merge-queue trigger coverage + lean gate',
        anchors: ['merge_group', 'QUEUE_ENFORCED_JOBS', 'MERGE_GROUP_EXEMPT'],
    },
    {
        file: 'tests/guardrails/release-bot-identity.test.ts',
        pillar: 'release-bot push identity (GH006 freeze)',
        anchors: ['create-github-app-token', 'RELEASE_APP_ID', 'skip ci'],
    },
    {
        // ADDED 2026-09-11 (#2367). The enforcement half of the
        // migrations-reproduce-the-schema property is ONE ci.yml step, so
        // deleting that step is a green pass. An adversarial review proved
        // it: the step removed, 12 ci.yml-reading suites and 148 tests all
        // stayed green while the residue file stopped being enforced.
        file: 'tests/guardrails/schema-drift-gate-runs-in-ci.test.ts',
        pillar: 'fresh-DB schema-drift gate presence (#2367)',
        anchors: [
            'db:check-schema-drift',
            'continue-on-error',
            'prisma/fresh-db-schema-drift.expected.sql',
        ],
    },
];

/** Count `it(` / `it.each(` assertion blocks in a test file. */
function itCount(src: string): number {
    return (src.match(/\bit(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('CI/CD pipeline-integrity — guard the guards', () => {
    describe.each(GUARDRAILS)('$pillar — $file', ({ file, anchors }) => {
        it('the guardrail file exists', () => {
            expect(exists(file)).toBe(true);
        });

        it('the guardrail still references its subject (not gutted)', () => {
            const src = read(file);
            for (const anchor of anchors) {
                expect(src).toContain(anchor);
            }
        });

        it('the guardrail carries a real assertion surface (>= 3 it-blocks)', () => {
            expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
        });
    });

    it('every registry pillar is distinct and the set is complete (6 guardrails)', () => {
        // A drive-by deletion of one entry shrinks this count; the number is
        // the explicit contract for "how many pipeline guardrails exist", and
        // it is meant to make a removal deliberate rather than incidental.
        //
        // 7 -> 5 on 2026-09-02 (#2226), deliberately: `deploy-staging-gate`
        // and `deploy-workflow` both guarded `.github/workflows/deploy.yml`,
        // deleted with the unapplied AWS estate. This is the count doing its
        // job — the deletion could not be silent.
        // 5 -> 6 on 2026-09-11 (#2367): the fresh-DB schema-drift gate.
        // The number was read off this assertion's own failure message
        // ("Received length: 6"), not computed.
        expect(GUARDRAILS).toHaveLength(6);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(6);
    });
});

describe('CI/CD pipeline-integrity — build / env-validation discipline', () => {
    const ci = () => read('.github/workflows/ci.yml');

    it('the CI workflow skips env validation at build time deliberately', () => {
        // SKIP_ENV_VALIDATION at workflow level — CI has only dummy
        // secrets, so compile-time validation is intentionally off.
        expect(ci()).toMatch(/SKIP_ENV_VALIDATION:\s*"1"/);
    });

    it('the build step documents WHY env validation is skipped + names the runtime gate', () => {
        const src = ci();
        // The explanatory comment must survive — it is the thing
        // that keeps the skip "intentional" rather than a latent
        // mystery for the next engineer.
        expect(src).toMatch(/Env validation is INTENTIONALLY skipped at build time/);
        expect(src).toMatch(/REAL env gate is RUNTIME/);
        expect(src).toMatch(/instrumentation\.ts/);
    });

    it('src/env.ts actually honours SKIP_ENV_VALIDATION (the skip mechanism is real)', () => {
        // If this wiring is removed, the build-time skip silently
        // becomes a no-op AND production loses its runtime check.
        expect(readSrc('src/env.ts')).toMatch(
            /skipValidation:\s*!!process\.env\.SKIP_ENV_VALIDATION/,
        );
    });

    it('the unified pipeline-integrity doc exists', () => {
        expect(exists('docs/ci-cd-pipeline-integrity.md')).toBe(true);
    });

    // ── Regression proof — the meta-ratchet catches a removed guard ──
    it('detects a guardrail registry entry whose file is missing', () => {
        const missing = { file: 'tests/guards/__deleted__.test.ts' };
        expect(exists(missing.file)).toBe(false);
    });
});

describe('CI/CD pipeline-integrity — the E2E build does not share a box with its services', () => {
    /**
     * The `e2e` job's Next build used to run in the same job that hosts
     * postgres:16-alpine + redis:7-alpine. That combination periodically
     * exceeded the runner and the KERNEL killed it — no V8 message, just
     * "received a shutdown signal", once a bare "Killed". Six times across
     * three branches on 2026-08-16, interleaved with successes, while the
     * `build` job compiled the same app on the same commits every time.
     * Its advantage was never a memory ceiling; it was having the box to
     * itself.
     *
     * Lowering the ceiling is not available as a fix: 6144 produces a
     * deterministic V8 OOM (verified, "Reached heap limit" at Mark-Compact
     * 6133.6 MB against a 6144 cap). Demand cannot go below ~6.1 GB and
     * supply cannot reach 8192-plus-two-containers, so the only move is to
     * remove the competition.
     *
     * These assert the INTENT rather than the prose that explains it: a
     * comment can be edited to say anything, and the reason this was hard
     * to see the first time is that nothing checked the shape.
     */
    const ci = yaml.load(read('.github/workflows/ci.yml')) as {
        jobs: Record<string, Record<string, unknown>>;
    };

    it('the bundle is built in its own job', () => {
        expect(Object.keys(ci.jobs)).toContain('e2e-bundle');
    });

    it('that job runs NO service containers', () => {
        // The whole point. A `services:` block here puts postgres back on
        // the build's runner and restores the failure.
        expect(ci.jobs['e2e-bundle'].services).toBeUndefined();
    });

    it('and declares no job-level env that would need one', () => {
        // Copying the `e2e` env block across would import a DATABASE_URL
        // pointing at a postgres this job deliberately does not have —
        // which reads as "the build needs a DB" and invites someone to add
        // the service back. `next build` needs no database: the `build`
        // job has none and compiles this app green every run.
        expect(ci.jobs['e2e-bundle'].env).toBeUndefined();
    });

    it('the e2e job downloads the bundle instead of building it', () => {
        const steps = ci.jobs.e2e.steps as Array<Record<string, unknown>>;
        const builds = steps.filter((s) => String(s.run ?? '').includes('next build'));
        expect(builds).toEqual([]);
        expect(steps.some((s) => String(s.uses ?? '').includes('download-artifact'))).toBe(true);
    });

    it('e2e waits for the bundle job', () => {
        expect(ci.jobs.e2e.needs).toContain('e2e-bundle');
    });

    it('the missing-artifact path reaches its own diagnostic', () => {
        // `download-artifact` fails the step when the artifact is absent,
        // and a failed step skips every later step without an `if:`. So the
        // verify step below it can only ever run if the download is marked
        // continue-on-error — otherwise the operator gets GitHub's generic
        // "Artifact not found" and none of the retention/re-run guidance.
        const steps = ci.jobs.e2e.steps as Array<Record<string, unknown>>;
        const dl = steps.findIndex((s) => String(s.uses ?? '').includes('download-artifact'));
        const verify = steps.findIndex((s) => String(s.run ?? '').includes('BUILD_ID'));
        expect(dl).toBeGreaterThanOrEqual(0);
        expect(verify).toBeGreaterThan(dl);
        expect(steps[dl]['continue-on-error']).toBe(true);
    });

    it('but never falls back to rebuilding in-job', () => {
        // A rebuild fallback would reintroduce the exact failure, silently,
        // under the conditions hardest to notice.
        const steps = ci.jobs.e2e.steps as Array<Record<string, unknown>>;
        expect(steps.some((s) => String(s.run ?? '').includes('next build'))).toBe(false);
    });
});

/**
 * A FAILED `main` RUN REACHES SOMEBODY (#3505).
 *
 * The gap this closes is not that `main` broke — it is that nothing said so.
 * Twice on 2026-10-14 a red `main` was discovered only because a human asked:
 * E2E sat red for four consecutive runs in the morning, was fixed, and went red
 * again hours later.
 *
 * Both of those merges followed the rules. The standing instruction is to merge
 * when every REQUIRED check is green, `E2E` is deliberately not required, and a
 * pull request with a failing optional job reads `UNSTABLE` — which is also what
 * a healthy one with a skipped optional job reads. The signal that something is
 * wrong was indistinguishable from the signal that nothing is.
 *
 * `main-ci-failure-notice.yml` makes it visible rather than blocking: one issue,
 * updated in place, naming the failed jobs. These assertions hold the two
 * properties that decide whether it works at all.
 */
describe('a failed main run is reported (#3505)', () => {
    const NOTICE = '.github/workflows/main-ci-failure-notice.yml';

    const notice = yaml.load(read(NOTICE)) as {
        name?: string;
        on?: Record<string, { workflows?: string[]; branches?: string[] }>;
        true?: Record<string, { workflows?: string[]; branches?: string[] }>;
        permissions?: Record<string, string>;
        concurrency?: { 'cancel-in-progress'?: boolean };
        jobs: Record<string, { steps: { uses?: string; with?: { script?: string } }[] }>;
    };
    // `on:` is YAML 1.1's `true`. js-yaml resolves the bare key to a boolean, so
    // reading `.on` alone returns undefined and every assertion below would pass
    // over nothing.
    const triggers = notice.on ?? notice.true ?? {};

    it('triggers on the workflow NAME that ci.yml actually declares', () => {
        // THE ASSERTION THAT CANNOT GO STALE. A `workflow_run` filter matches a
        // workflow's `name`, not its filename, so renaming `ci.yml`'s `name:`
        // silently stops this notifier — it would simply never fire again, which
        // is the exact failure it exists to prevent and the hardest kind to
        // notice. Derived from `ci.yml` rather than written as a literal in two
        // places.
        const ciName = (yaml.load(read('.github/workflows/ci.yml')) as { name?: string }).name;
        expect(typeof ciName).toBe('string');
        expect(triggers.workflow_run?.workflows).toEqual([ciName]);
    });

    it('watches main, and only main', () => {
        expect(triggers.workflow_run?.branches).toEqual(['main']);
    });

    it('can write an issue and read the run it is reporting on', () => {
        // `issues: write` to file it; `actions: read` to list the jobs. Without
        // the second it could only say "CI failed", which is the unactionable
        // version of this notice.
        expect(notice.permissions?.issues).toBe('write');
        expect(notice.permissions?.actions).toBe('read');
    });

    it('does not cancel a run in progress, so no conclusion is dropped', () => {
        // Each run carries a different conclusion to record. Cancelling the
        // loser would drop either the failure that opens the issue or the
        // success that closes it.
        expect(notice.concurrency?.['cancel-in-progress']).toBe(false);
    });

    // The step body — JavaScript inside a YAML block scalar.
    //
    // EVERY NEEDLE BELOW NAMES ONE CALL'S OWN ARGUMENT rather than the API
    // method, and that is not stylistic. The obvious spellings are ambiguous
    // against this very script, which is the Class D defect the
    // needle-uniqueness ratchet exists to find, and the first cut of this
    // describe block had it twice:
    //
    //   · `issues.update` occurs TWICE — once to close on green, once to
    //     re-body the open issue — so a bare needle is satisfied by whichever
    //     one survives, and deleting the close left the test green.
    //   · `issues.create` is a PREFIX of `issues.createComment`, which occurs
    //     twice more, so that needle had three satisfying positions and
    //     deleting the only real `create` left two standing.
    //
    // `state: 'closed'`, `issue_number: existing.number, body,` and
    // `title: TITLE` each occur exactly once, in the call they describe.
    // Bounding the read to the branch was the other option and was tried:
    // `braceBlockAfter` cannot lex the nested template literal on the "Still
    // failing" line, so the anchor search runs off. A needle that only the
    // named call satisfies gets there without a lexer.
    const script = notice.jobs.notice.steps.map((st) => st.with?.script ?? '').join('\n');

    it('CLOSES the issue on green, not just opens it on red', () => {
        // The half that keeps this from becoming noise. An automated issue that
        // only ever opens is one people learn to scroll past, and a stale "main
        // is failing" issue sitting over a green main is worse than none —
        // it teaches the reader that the notice means nothing.
        expect(script).toMatch(/conclusion === 'success'/);
        expect(script).toMatch(/state: 'closed'/);
    });

    it('names the failed JOBS rather than only the run', () => {
        expect(script).toMatch(/listJobsForWorkflowRun/);
    });

    it('updates one issue in place rather than opening one per failure', () => {
        // A notifier that opens a duplicate per red run trains people to ignore
        // it. Both halves are asserted: the update carries the existing issue's
        // number, and there is exactly one path that opens a new one.
        expect(script).toMatch(/issue_number: existing\.number, body,/);
        expect(script).toMatch(/title: TITLE/);
    });

    it('pins its action to a major version, like every other workflow here', () => {
        const uses = notice.jobs.notice.steps.map((st) => st.uses).filter(Boolean);
        expect(uses.length).toBeGreaterThan(0);
        // Filtered rather than asserted in a loop, so the failure NAMES the
        // unpinned action instead of stopping at the first one — and so the
        // subject is not a for-of binding, which the Class D analyser cannot
        // resolve and therefore counts as a blind spot.
        expect(uses.filter((u) => !/@v\d+$/.test(u ?? ''))).toEqual([]);
    });
});
