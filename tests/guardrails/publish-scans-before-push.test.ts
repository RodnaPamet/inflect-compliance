/**
 * Every image push must be GATED by a vulnerability scan that ran first.
 *
 * THE BUG THIS COMES FROM
 * ───────────────────────
 * `.github/workflows/ghcr-publish.yml` is the only deploy path this product
 * has: it pushes `:latest` to GHCR on every push to `main`, and the
 * production VM runs Watchtower unpinned on that tag. Until 2026-09-13 it
 * contained ZERO references to Trivy. The scan lived only in `ci.yml`, in a
 * job declared `needs: [docker]`, running in a DIFFERENT workflow on a
 * different clock.
 *
 * On 2026-09-12 that arrangement failed in the only way that matters:
 *
 *   · the publish workflow pushed `:latest` at 22:15;
 *   · Watchtower rolled the production containers at 22:37, ~20 minutes
 *     later, with no scan verdict in existence for that image;
 *   · CI's `Docker Build` was killed at its timeout, so the dependent
 *     `trivy` job SKIPPED — and a skipped dependent is not a failure, so
 *     the run never went red.
 *
 * An unscanned image reached production and nothing anywhere was red. The
 * fix was structural: the workflow that publishes the image is now the
 * workflow that scans it, and it scans BEFORE it pushes.
 *
 * WHY THE ORDER IS THE WHOLE ASSERTION
 * ────────────────────────────────────
 * A scan bolted on AFTER the push gates nothing. By the time it runs the
 * bytes are on `:latest` and Watchtower may already have pulled them; the
 * scan's only remaining power is to turn a workflow red while the vulnerable
 * image serves traffic. "The publish workflow mentions Trivy" is therefore
 * not the property worth guarding, and a grep for `trivy` in the file would
 * have been satisfied by exactly the arrangement that fails. So this file
 * parses the YAML that GitHub executes and asserts a relationship between
 * two step INDICES inside one job.
 *
 * WHAT COUNTS AS A PUSH, AND WHY BOTH SHAPES
 * ──────────────────────────────────────────
 * `docker/build-push-action` with `push: true` is the obvious one. A bare
 * `docker push` in a `run:` block is the other, and it is the shape this
 * repo now uses deliberately — the build loads the image into the local
 * daemon and the registry is only reached by an explicit push step placed
 * downstream of the gate. A detector that knew only about the action would
 * be blind to the very workflow it exists to police.
 *
 * WHAT COUNTS AS A GATE
 * ─────────────────────
 * A `aquasecurity/trivy-action` step with `exit-code: "1"` (it can fail the
 * job) and a severity list containing both CRITICAL and HIGH (it matches
 * ci.yml's strictness, pinned separately by
 * `tests/guardrails/security-gate-strictness.test.ts`). A scan with
 * `exit-code: "0"`, or one that only reports SARIF, blocks nothing — it
 * would satisfy a naive "is there a trivy step before the push" check while
 * letting every CVE through.
 *
 * POPULATION
 * ──────────
 * `repoRelativeFiles()` — what git says is in the repo — filtered to
 * `.github/workflows/*.yml`. Not an `fs.readdirSync` walk: a worktree under
 * `.claude/` holds a full second copy of every workflow in this repo, and a
 * directory walk reads it (see
 * `tests/guardrails/source-scan-population.test.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const WORKFLOW_DIR = '.github/workflows';

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    if?: unknown;
}
interface Job {
    steps?: Step[];
}
interface Workflow {
    jobs?: Record<string, Job>;
}

interface WorkflowDoc {
    /** Repo-relative path, e.g. `.github/workflows/ghcr-publish.yml`. */
    file: string;
    wf: Workflow;
}

interface StepRef {
    index: number;
    name: string;
}

interface Site {
    /** Basename, so the identifiers in failure messages stay short. */
    workflow: string;
    jobId: string;
    pushes: StepRef[];
    /** Trivy steps that can actually fail the job at CRITICAL,HIGH. */
    blockingScans: StepRef[];
    /** Every Trivy step, blocking or not — used to tell the two cases apart. */
    allScans: StepRef[];
}

/** The workflow files git considers part of this repo, parsed. */
function workflowDocs(): WorkflowDoc[] {
    return repoRelativeFiles()
        .filter((rel) => rel.startsWith(`${WORKFLOW_DIR}/`) && /\.ya?ml$/.test(rel))
        .map((rel) => ({
            file: rel,
            wf: yaml.load(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as Workflow,
        }));
}

function stepName(step: Step, index: number): string {
    return step.name ?? step.uses ?? `step ${index}`;
}

/** A step that puts image bytes into a registry. */
function isPushStep(step: Step): boolean {
    if ((step.uses ?? '').includes('docker/build-push-action')) {
        // The action's `push` input is YAML-parsed, so it may arrive as a
        // boolean or as the string 'true'. Both mean push.
        const raw = String((step.with ?? {}).push ?? '');
        if (raw.toLowerCase() === 'true') return true;
        // FAIL CLOSED on a value this cannot read. `push: ${{ … }}` is
        // decided by GitHub at run time, so a static check that treats it as
        // "not a push" would let `push: ${{ github.event_name != 'pull_request' }}`
        // publish from above the gate while this guard stayed green — the
        // detector would be reporting on the subset of syntax it happens to
        // understand. An expression here is counted as a push, which is the
        // conservative direction: a genuinely conditional push sitting above
        // the scan IS the hazard, so the red is correct rather than noise.
        if (raw.includes('${{')) return true;
    }
    // A bare `docker push` in a run block. `docker buildx imagetools create`
    // also writes a tag to the registry, so it counts too.
    const run = step.run ?? '';
    return /\bdocker\s+push\b/.test(run) || /\bimagetools\s+create\b/.test(run);
}

function isTrivyStep(step: Step): boolean {
    return (step.uses ?? '').includes('aquasecurity/trivy-action');
}

/** A Trivy step that can FAIL the job on CRITICAL or HIGH findings. */
function isBlockingTrivyStep(step: Step): boolean {
    if (!isTrivyStep(step)) return false;
    const w = step.with ?? {};
    if (String(w['exit-code'] ?? '').trim() !== '1') return false;
    const severities = String(w.severity ?? '')
        .toUpperCase()
        .split(',')
        .map((s) => s.trim());
    return severities.includes('CRITICAL') && severities.includes('HIGH');
}

/**
 * Every job that pushes an image, with the scan steps it contains.
 *
 * Parameterised on the document list rather than reading the tree itself, so
 * the detector can be driven by synthetic workflows below — including the
 * empty list, which is the control that proves this guard cannot pass by
 * having found nothing.
 */
function auditPushSites(docs: WorkflowDoc[]): Site[] {
    const sites: Site[] = [];
    for (const { file, wf } of docs) {
        for (const [jobId, job] of Object.entries(wf?.jobs ?? {})) {
            const steps = job.steps ?? [];
            const pushes: StepRef[] = [];
            const blockingScans: StepRef[] = [];
            const allScans: StepRef[] = [];
            steps.forEach((step, index) => {
                const ref = { index, name: stepName(step, index) };
                if (isPushStep(step)) pushes.push(ref);
                if (isTrivyStep(step)) allScans.push(ref);
                if (isBlockingTrivyStep(step)) blockingScans.push(ref);
            });
            if (pushes.length > 0) {
                sites.push({ workflow: path.basename(file), jobId, pushes, blockingScans, allScans });
            }
        }
    }
    return sites;
}

/** Human-readable violations: a push that is not preceded by a blocking scan. */
function offendersOf(sites: Site[]): string[] {
    const offenders: string[] = [];
    for (const site of sites) {
        const where = `${site.workflow}:${site.jobId}`;
        const firstGate = site.blockingScans.length > 0 ? site.blockingScans[0].index : -1;
        for (const push of site.pushes) {
            if (firstGate === -1) {
                offenders.push(
                    site.allScans.length === 0
                        ? `${where} pushes at step ${push.index} ("${push.name}") with no Trivy scan in the job`
                        : `${where} pushes at step ${push.index} ("${push.name}"); its Trivy step is not blocking (needs exit-code "1" + CRITICAL,HIGH)`,
                );
            } else if (firstGate > push.index) {
                offenders.push(
                    `${where} pushes at step ${push.index} ("${push.name}") BEFORE its blocking scan at step ${firstGate} ("${site.blockingScans[0].name}")`,
                );
            }
        }
    }
    return offenders;
}

/**
 * The vacuity guard, as a throwing function so the empty-selection control
 * can assert it goes RED rather than quietly reporting zero violations.
 */
function assertPopulation(sites: Site[]): void {
    if (sites.length === 0) {
        throw new Error(
            'no image-push site found in any workflow. Either the publish path was deleted, ' +
                'or the detector stopped recognising a push — both of which would make every ' +
                'ordering assertion in this file pass by emptiness.',
        );
    }
}

/** Build a one-job synthetic workflow document for the detector controls. */
function synthetic(file: string, steps: Step[]): WorkflowDoc {
    return { file, wf: { jobs: { publish: { steps } } } };
}

const BUILD_AND_PUSH: Step = {
    name: 'Build and push',
    uses: 'docker/build-push-action@v7',
    with: { push: true, tags: 'ghcr.io/x/y:latest' },
};
const BUILD_NO_PUSH: Step = {
    name: 'Build image (load locally, NO push)',
    uses: 'docker/build-push-action@v7',
    with: { push: false, load: true, tags: 'ghcr.io/x/y:latest' },
};
const BLOCKING_SCAN: Step = {
    name: 'Gate: Trivy vulnerability scan (critical+high)',
    uses: 'aquasecurity/trivy-action@v0.36.0',
    with: { 'image-ref': 'x:y', 'exit-code': '1', severity: 'CRITICAL,HIGH' },
};
const REPORTING_SCAN: Step = {
    name: 'Trivy SARIF report',
    uses: 'aquasecurity/trivy-action@v0.36.0',
    with: { 'image-ref': 'x:y', 'exit-code': '0', severity: 'CRITICAL,HIGH', format: 'sarif' },
};
const RUN_PUSH: Step = { name: 'Push scanned image to GHCR', run: 'docker push "$tag"' };

describe('an image push is gated by a scan that ran before it', () => {
    const docs = workflowDocs();
    const sites = auditPushSites(docs);

    it('parses every workflow git lists, and the list is not empty', () => {
        // The denominator, printed. A collapsed population is the failure
        // mode that makes every other assertion here vacuous, so it is
        // asserted before anything is concluded from a zero.
        const names = docs.map((d) => path.basename(d.file)).sort();
        expect(names).toContain('ghcr-publish.yml');
        expect(names).toContain('ci.yml');
        expect(names.length).toBeGreaterThanOrEqual(11);
        // …and each one really parsed into a job map, rather than yielding
        // `undefined` that the audit would skip in silence.
        const jobless = docs.filter((d) => Object.keys(d.wf?.jobs ?? {}).length === 0);
        expect(jobless.map((d) => d.file)).toEqual([]);
    });

    it('finds the image-push sites in this repo, by name', () => {
        // The exact list. A publish job that stops being recognised as one —
        // renamed step, new push mechanism — shows up here as a shrinking
        // list rather than as a silently-green ordering check below.
        expect(sites.map((s) => `${s.workflow}:${s.jobId}`).sort()).toEqual(['ghcr-publish.yml:build-push']);
        expect(() => assertPopulation(sites)).not.toThrow();
    });

    it('every push is preceded by a BLOCKING Trivy scan in the same job', () => {
        assertPopulation(sites);
        expect(offendersOf(sites)).toEqual([]);
    });

    it('the publish job scans at a lower step index than it pushes', () => {
        // The same property as the test above, stated as the two numbers, so
        // a failure reports WHERE rather than only THAT.
        const publish = sites.find((s) => s.workflow === 'ghcr-publish.yml');
        expect(publish).toBeDefined();
        const gate = publish!.blockingScans[0];
        const push = publish!.pushes[0];
        expect(gate).toBeDefined();
        expect(push).toBeDefined();
        expect(gate.index).toBeLessThan(push.index);
    });

    it('the publish job builds without pushing, so the registry is unreachable before the gate', () => {
        // The teeth. If a future edit flips the build step back to
        // `push: true`, the build BECOMES a push site sitting above the
        // scan, and the ordering assertions go red — which is why the
        // detector treats the action and the run-block as one class.
        const doc = docs.find((d) => d.file.endsWith('ghcr-publish.yml'));
        expect(doc).toBeDefined();
        const steps = doc!.wf.jobs!['build-push'].steps ?? [];
        const builds = steps.filter((s) => (s.uses ?? '').includes('docker/build-push-action'));
        expect(builds.length).toBeGreaterThan(0);
        const pushing = builds.filter((s) => String((s.with ?? {}).push ?? '').toLowerCase() === 'true');
        expect(pushing.map((s) => s.name)).toEqual([]);
        // …and each build loads locally, which is what makes a later
        // `docker push` of the SCANNED bytes possible at all.
        const notLoading = builds.filter((s) => String((s.with ?? {}).load ?? '').toLowerCase() !== 'true');
        expect(notLoading.map((s) => s.name)).toEqual([]);
    });
});

describe('the detector itself — driven by synthetic workflows', () => {
    // A guard whose detector is never shown a violation is a guard that has
    // never been proved to have one. Each control below produces the failing
    // input directly.

    it('flags a push that happens before the scan', () => {
        const sites = auditPushSites([synthetic('a.yml', [BUILD_AND_PUSH, BLOCKING_SCAN])]);
        expect(sites).toHaveLength(1);
        expect(offendersOf(sites)).toEqual([
            'a.yml:publish pushes at step 0 ("Build and push") BEFORE its blocking scan at step 1 ("Gate: Trivy vulnerability scan (critical+high)")',
        ]);
    });

    it('flags a push with no scan at all — the shape this repo shipped until 2026-09-13', () => {
        const sites = auditPushSites([synthetic('b.yml', [BUILD_AND_PUSH])]);
        expect(offendersOf(sites)).toEqual([
            'b.yml:publish pushes at step 0 ("Build and push") with no Trivy scan in the job',
        ]);
    });

    it('flags a push preceded only by a NON-blocking scan', () => {
        const sites = auditPushSites([synthetic('c.yml', [BUILD_NO_PUSH, REPORTING_SCAN, RUN_PUSH])]);
        expect(offendersOf(sites)).toEqual([
            'c.yml:publish pushes at step 2 ("Push scanned image to GHCR"); its Trivy step is not blocking (needs exit-code "1" + CRITICAL,HIGH)',
        ]);
    });

    it('accepts build → blocking scan → push, the shape this repo now has', () => {
        const sites = auditPushSites([synthetic('d.yml', [BUILD_NO_PUSH, BLOCKING_SCAN, RUN_PUSH])]);
        expect(sites).toHaveLength(1);
        expect(offendersOf(sites)).toEqual([]);
    });

    it('FAILS CLOSED on an expression-valued push: it cannot evaluate', () => {
        // The evasion this closes: `push: ${{ … }}` is resolved by GitHub at
        // run time, so a detector that string-compares against 'true' reads
        // it as "not a push" and goes green on a workflow that publishes
        // from above the gate on every push to main.
        const conditionalPush: Step = {
            name: 'Build and push (conditionally)',
            uses: 'docker/build-push-action@v7',
            with: { push: "${{ github.event_name != 'pull_request' }}", tags: 'ghcr.io/x/y:latest' },
        };
        const sites = auditPushSites([synthetic('g.yml', [conditionalPush, BLOCKING_SCAN])]);
        expect(sites).toHaveLength(1);
        expect(offendersOf(sites)).toEqual([
            'g.yml:publish pushes at step 0 ("Build and push (conditionally)") BEFORE its blocking scan at step 1 ("Gate: Trivy vulnerability scan (critical+high)")',
        ]);
        // …and the same expression BELOW a blocking scan is accepted, so the
        // rule above is "fail closed", not "reject every expression".
        const after = auditPushSites([synthetic('h.yml', [BUILD_NO_PUSH, BLOCKING_SCAN, conditionalPush])]);
        expect(offendersOf(after)).toEqual([]);
    });

    it('a CRITICAL-only gate does not count as blocking', () => {
        const criticalOnly: Step = {
            name: 'Gate: Trivy (critical only)',
            uses: 'aquasecurity/trivy-action@v0.36.0',
            with: { 'image-ref': 'x:y', 'exit-code': '1', severity: 'CRITICAL' },
        };
        const sites = auditPushSites([synthetic('e.yml', [BUILD_NO_PUSH, criticalOnly, RUN_PUSH])]);
        expect(offendersOf(sites)).toHaveLength(1);
        expect(offendersOf(sites)[0]).toContain('not blocking');
    });

    it('EMPTY-SELECTION CONTROL: a collapsed population reports zero violations, so the guard fails on the population instead', () => {
        // An empty scan is a PASS. Point the audit at nothing and it agrees
        // that nothing is wrong — which is exactly how a guard whose
        // population quietly collapsed goes on reporting success forever.
        const collapsed = auditPushSites([]);
        expect(collapsed).toEqual([]);
        expect(offendersOf(collapsed)).toEqual([]);

        // So the population is asserted separately, and THAT is what goes red.
        expect(() => assertPopulation(collapsed)).toThrow(/no image-push site/i);

        // Positive control: against the real tree it does not throw, so the
        // assertion above is testing emptiness rather than a broken helper.
        expect(() => assertPopulation(auditPushSites(workflowDocs()))).not.toThrow();

        // And a workflow set that parses but contains no pushes collapses the
        // same way — the file list being non-empty is not enough on its own.
        const noPushes = auditPushSites([synthetic('f.yml', [BUILD_NO_PUSH, BLOCKING_SCAN])]);
        expect(noPushes).toEqual([]);
        expect(() => assertPopulation(noPushes)).toThrow(/no image-push site/i);
    });
});
