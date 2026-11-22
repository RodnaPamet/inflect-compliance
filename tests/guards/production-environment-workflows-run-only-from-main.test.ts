/**
 * A workflow that deploys to the `production` environment runs only from main,
 * and says so in its own file.
 *
 * All four hold root on the production VM: each `gcloud compute scp`s a
 * `remote.sh` out of ITS OWN CHECKOUT and runs it under `sudo`, so the files
 * that execute are the files of the dispatched ref. The boundary against a
 * MODIFIED branch is the `production` environment, whose deployment-branch
 * policy is "protected branches only" and whose sole reviewer reads the run's
 * branch before approving — a branch can edit this `if`, so the in-file guard
 * is not that boundary and must never be cited as it (the same reasoning the
 * VM apply guard states, and `docs/deployment.md`, "Named changes without a
 * key").
 *
 * What the in-file guard DOES close is the accident: the environment admits
 * every PROTECTED branch, not `main` specifically. Protecting a second branch
 * for an ordinary reason — a release branch, a long-lived integration branch —
 * would silently hand it root on production through any of these workflows,
 * and that change leaves no diff in this repository for a reviewer to catch.
 * `vm-apply.yml` has carried the guard since it was written; the other three
 * did not, which is #5300.
 *
 * The population is derived: every workflow git lists that declares the
 * environment. A fifth one lands IN by default and fails here until somebody
 * decides about it — a production workflow triggered by a release TAG, for
 * instance, could not carry this exact condition and needs its own reasoning
 * rather than a copied line.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const MAIN_ONLY = "github.ref == 'refs/heads/main'";

type Job = { if?: string; environment?: string };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

/** Every workflow file git lists, parsed. */
function workflows(): { rel: string; wf: Workflow }[] {
    return repoRelativeFiles()
        .filter((rel) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel))
        .map((rel) => ({
            rel,
            wf: (yaml.load(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) ?? {}) as Workflow,
        }));
}

/** Those with at least one job deploying to `production`. */
function productionWorkflows() {
    return workflows().filter(({ wf }) =>
        Object.values(wf.jobs ?? {}).some((j) => j.environment === 'production'),
    );
}

const ALL = workflows();
const PRODUCTION = productionWorkflows();

/** The four that hold root on the VM today. */
const EXPECTED = [
    '.github/workflows/scanner-vm.yml',
    '.github/workflows/vm-apply.yml',
    '.github/workflows/vm-capacity.yml',
    '.github/workflows/vm-check.yml',
];

describe('the population this guard ranges over', () => {
    it('reads every workflow in the repository, not a subset', () => {
        // The denominator: a guard narrow enough to always pass is no guard.
        expect(ALL.length).toBeGreaterThanOrEqual(20);
        expect(ALL.every(({ wf }) => wf.jobs !== undefined)).toBe(true);
    });

    it('finds the production-environment workflows, and is never empty', () => {
        // Zero would make every assertion below vacuously true.
        expect(PRODUCTION.length).toBeGreaterThan(0);
        expect(PRODUCTION.map((p) => p.rel).sort()).toEqual(EXPECTED);
    });
});

describe('every job that deploys to production runs only from main', () => {
    it.each(EXPECTED)('%s carries the main-only condition on that job', (rel) => {
        const entry = PRODUCTION.find((p) => p.rel === rel);
        if (!entry) throw new Error(`${rel} declares no production environment`);
        const deploying = Object.entries(entry.wf.jobs ?? {}).filter(
            ([, j]) => j.environment === 'production',
        );
        expect(deploying.length).toBeGreaterThan(0);
        for (const [name, job] of deploying) {
            expect({ job: name, if: job.if }).toEqual({ job: name, if: MAIN_ONLY });
        }
    });

    it('each is dispatched by a person, which is what makes that condition the right one', () => {
        // A push- or tag-triggered production workflow would need different
        // reasoning, so assert the trigger rather than assume it.
        for (const { rel, wf } of PRODUCTION) {
            expect({ rel, on: Object.keys(wf.on ?? {}) }).toEqual({
                rel,
                on: ['workflow_dispatch'],
            });
        }
    });
});
