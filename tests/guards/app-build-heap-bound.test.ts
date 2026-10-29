/**
 * Every workflow step that builds the app gives `next build` an explicit heap,
 * at least the one the production image builds with.
 *
 * The production image (`Dockerfile`) and `ci.yml`'s builds set
 * `--max-old-space-size=8192`. The nightly load test and both DAST workflows
 * set nothing, so their builds ran on Node's default heap of about 4 GB. In
 * late October 2026 the build outgrew it: those nightlies died at "Build app"
 * with "JavaScript heap out of memory", and the DAST matrix lost a different
 * role each night, so a blocking security scan reported red for a reason that
 * had nothing to do with security.
 *
 * Every assertion reads a parsed field: the step's `run`, its
 * `working-directory`, and `env.NODE_OPTIONS` resolved the way Actions resolves
 * it (step over job over workflow). A YAML comment cannot satisfy any of them.
 *
 * The floor is read from the Dockerfile rather than written here, so raising
 * the image's heap raises what every CI build must give, and the two cannot
 * drift apart in silence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

type Env = Record<string, unknown> | undefined;
interface Step {
    name?: string;
    run?: unknown;
    env?: Env;
    'working-directory'?: unknown;
}
interface Job {
    env?: Env;
    steps?: Step[];
}
interface Workflow {
    env?: Env;
    jobs?: Record<string, Job>;
}

/**
 * Whether a step builds THIS app: `next build`, `npm run build` or
 * `npm run analyze` (which runs the build), from the repository root. A
 * `build:<something>` script is another artefact, and a step in another
 * working directory builds another package (the docs site in `site/`).
 */
function buildsTheApp(step: Step): boolean {
    if (typeof step.run !== 'string') return false;
    const wd = step['working-directory'];
    if (wd !== undefined && wd !== '.' && wd !== './') return false;
    return /\bnext\s+build\b/.test(step.run) || /\bnpm\s+run\s+(?:build|analyze)(?![\w:-])/.test(step.run);
}

/** NODE_OPTIONS as the step sees it: its own env, else the job's, else the workflow's. */
function effectiveNodeOptions(wf: Workflow, job: Job, step: Step): string {
    for (const env of [step.env, job.env, wf.env]) {
        const v = env?.NODE_OPTIONS;
        if (v !== undefined) return String(v);
    }
    return '';
}

function heapCap(nodeOptions: string): number | null {
    const m = /--max-old-space-size=(\d+)/.exec(nodeOptions);
    return m ? Number(m[1]) : null;
}

/** The heap the production image builds with: `ENV NODE_OPTIONS=…` in the Dockerfile. */
function dockerfileHeap(): number {
    const lines = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').split('\n');
    const env = lines
        .map((l) => /^ENV\s+NODE_OPTIONS=("?)(.*)\1\s*$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null);
    expect(env).toHaveLength(1);
    const cap = heapCap(env[0][2]);
    if (cap === null) throw new Error('The Dockerfile sets NODE_OPTIONS without --max-old-space-size.');
    return cap;
}

interface BuildStep {
    where: string;
    cap: number | null;
}

function appBuildSteps(): BuildStep[] {
    const workflows = repoRelativeFiles().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
    const out: BuildStep[] = [];
    for (const file of workflows) {
        const wf = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8')) as Workflow;
        for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
            for (const step of job.steps ?? []) {
                if (!buildsTheApp(step)) continue;
                out.push({
                    where: `${file} › ${jobName} › ${step.name ?? '(unnamed step)'}`,
                    cap: heapCap(effectiveNodeOptions(wf, job, step)),
                });
            }
        }
    }
    return out;
}

describe('buildsTheApp', () => {
    it.each([
        ['npm run build', true],
        ['npx next build --webpack', true],
        ['npm run analyze', true],
        ['npm ci\nnpm run build\n', true],
        ['npm run build:worker', false],
        ['npm run build-storybook', false],
        ['npm run typecheck', false],
    ])('%j → %s', (run, expected) => {
        expect(buildsTheApp({ run })).toBe(expected);
    });

    it('ignores a build in another package', () => {
        expect(buildsTheApp({ run: 'npm run build', 'working-directory': 'site' })).toBe(false);
        expect(buildsTheApp({ run: 'npm run build', 'working-directory': '.' })).toBe(true);
    });
});

describe('every app build in CI has an explicit heap of at least the production image\'s', () => {
    const floor = dockerfileHeap();
    const steps = appBuildSteps();

    it('finds the builds (positive control: ci.yml\'s own build is among them)', () => {
        // An empty population would pass the next test while checking nothing.
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.some((s) => s.where.startsWith('.github/workflows/ci.yml › build ›'))).toBe(true);
    });

    it(`each sets --max-old-space-size >= ${floor} (the Dockerfile's)`, () => {
        const short = steps
            .filter((s) => s.cap === null || s.cap < floor)
            .map((s) => `${s.where}: ${s.cap === null ? 'no --max-old-space-size' : s.cap}`);
        if (short.length > 0) {
            throw new Error(
                `These steps build the app without the heap the production image builds with ` +
                    `(--max-old-space-size=${floor}, Dockerfile). On Node's default heap the build ` +
                    `dies with "JavaScript heap out of memory":\n  ${short.join('\n  ')}\n\n` +
                    `Set NODE_OPTIONS: "--max-old-space-size=${floor}" (or more) on the step.`,
            );
        }
    });
});
