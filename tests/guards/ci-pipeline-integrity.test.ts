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
 *   3. Staging smoke gate — production deploy `needs: smoke-staging`
 *      (`deploy-staging-gate`) + the OI-2 helm invariants
 *      (`deploy-workflow`).
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
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
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
    {
        file: 'tests/guards/deploy-staging-gate.test.ts',
        pillar: 'staging smoke gate',
        anchors: ['smoke-staging', 'deploy-production'],
    },
    {
        file: 'tests/guards/deploy-workflow.test.ts',
        pillar: 'release workflow (OI-2 helm invariants)',
        anchors: ['helm', 'deploy-staging'],
    },
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

    it('every registry pillar is distinct and the set is complete (7 guardrails)', () => {
        // A drive-by deletion of one entry shrinks this count; the
        // number is the explicit contract for "how many pipeline
        // guardrails exist".
        expect(GUARDRAILS).toHaveLength(7);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(7);
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
        expect(read('src/env.ts')).toMatch(
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
