/**
 * The Inspect nightly's invariants (docs/ai-architecture/inspect.md, Phase 1).
 *
 *   1. A non-blocking pass carries a DATED `AGENT-EVAL-NON-BLOCKING-UNTIL`
 *      marker, compared here with the real clock, so the deferral cannot
 *      outlive its date (the DAST lesson: a marker nobody parses never turns
 *      red). `continue-on-error` appears only while the marker stands.
 *   2. Without the CI key the job SKIPS cleanly: the first step reads the
 *      secret, every later step is conditioned on its output, and the key
 *      reaches only the app's process, never job-level env.
 *   3. D-EV-6 is held in config: USD 10 a night for both engines, and one
 *      planned engine pass fits the per-engine share.
 *   4. The harness image is pinned by digest and inspect-ai by exact version,
 *      in the Dockerfile and pyproject alike; the app image never installs it.
 *   5. One sample in flight on the deployment (`--max-samples 1`), Inspect's
 *      own model slot unused (`mockllm/model`), schedule + dispatch only.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WORKFLOW_SRC = read('.github/workflows/agent-evals.yml');
const WORKFLOW = yaml.load(WORKFLOW_SRC) as {
    on: Record<string, unknown>;
    jobs: { inspect: { env: Record<string, string>; steps: Array<{ id?: string; name?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: boolean }> } };
};
const BUDGET = JSON.parse(read('evals/inspect/budget.json'));
const MARKER = /AGENT-EVAL-NON-BLOCKING-UNTIL:\s*(\d{4}-\d{2}-\d{2})/g;

/** The marker's date, or null; throws on two markers (one deferral, one date). */
export function nonBlockingUntil(src: string): string | null {
    const dates = [...src.matchAll(MARKER)].map((m) => m[1]);
    if (dates.length > 1) throw new Error('more than one AGENT-EVAL-NON-BLOCKING-UNTIL marker');
    return dates[0] ?? null;
}

export function deferralLapsed(until: string, today: Date): boolean {
    return today.toISOString().slice(0, 10) > until;
}

describe('the dated deferral', () => {
    it('compares the date with a clock (pinned against fixed days)', () => {
        expect(deferralLapsed('2027-02-28', new Date('2027-02-28T23:00:00Z'))).toBe(false);
        expect(deferralLapsed('2027-02-28', new Date('2027-03-01T00:00:00Z'))).toBe(true);
    });

    it('has not lapsed, and continue-on-error stands only beside it', () => {
        const until = nonBlockingUntil(WORKFLOW_SRC);
        const nonBlocking = WORKFLOW.jobs.inspect.steps.filter((s) => s['continue-on-error'] === true);
        if (until === null) {
            expect(nonBlocking).toEqual([]);
            return;
        }
        expect(deferralLapsed(until, new Date())).toBe(false);
        expect(nonBlocking.map((s) => s.id)).toEqual(['evals']);
    });
});

describe('skip without the CI key', () => {
    const steps = WORKFLOW.jobs.inspect.steps;

    it('decides in the first step and conditions every later step on it', () => {
        expect(steps[0].id).toBe('key');
        expect(steps[0].env?.KEY).toBe('${{ secrets.INSPECT_CI_ANTHROPIC_KEY || secrets.ANTHROPIC_API_KEY }}');
        // Owner decision 2026-11-12: a scheduled run is skipped unless the
        // repository variable AGENT_EVALS_ENABLED is 'true'; a dispatch always runs.
        expect(steps[0].env?.ENABLED).toBe('${{ vars.AGENT_EVALS_ENABLED }}');
        expect(steps[0].env?.EVENT).toBe('${{ github.event_name }}');
        expect(steps[0].run).toContain('if [ "$EVENT" = "schedule" ] && [ "$ENABLED" != "true" ]; then');
        for (const s of steps.slice(1)) expect([s.name, s.if ?? '']).toEqual([s.name, expect.stringContaining("steps.key.outputs.present == 'true'")]);
    });

    it('hands the key to the app process only, never to job env', () => {
        expect(JSON.stringify(WORKFLOW.jobs.inspect.env)).not.toContain('INSPECT_CI_ANTHROPIC_KEY');
        const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('secrets.INSPECT_CI_ANTHROPIC_KEY')).map((s) => s.id ?? s.name);
        expect(holders).toEqual(['key', 'Start app + worker (background)']);
    });
});

describe('D-EV-6 budget', () => {
    it('is USD 10 a night for both engines, split evenly', () => {
        expect(BUDGET.nightlyCapUsd).toBe(10);
        expect(BUDGET.engines).toEqual(['flue', 'tool-runner']);
        expect(BUDGET.perEngineCapUsd * BUDGET.engines.length).toBe(BUDGET.nightlyCapUsd);
    });

    it('fits one planned engine pass in the per-engine share', () => {
        const p = BUDGET.plannedEnginePass;
        const usd = (p.inputTokens / 1e6) * BUDGET.usdPerMillionInputTokens + (p.outputTokens / 1e6) * BUDGET.usdPerMillionOutputTokens;
        expect(usd).toBeLessThanOrEqual(BUDGET.perEngineCapUsd);
    });

    // Every variable an agent engine reads its model from, derived from the
    // server env module rather than listed: the Tool Runner's two tiers were
    // missed once, and with them unset that engine ran Sonnet and Opus under a
    // budget priced at Haiku. A new engine model variable joins this set and
    // fails here until the workflow pins it.
    const ENGINE_MODEL_VARS = [...new Set([...read('src/env.ts').matchAll(/^\s+(AGENT_[A-Z_]*MODEL[A-Z_]*):\s*z\./gm)].map((m) => m[1]))].sort();

    it('pins every engine model variable to the model the budget is priced for', () => {
        expect(ENGINE_MODEL_VARS).toEqual(expect.arrayContaining(['AGENT_FLUE_MODEL', 'AGENT_TOOL_RUNNER_MODEL_BALANCED', 'AGENT_TOOL_RUNNER_MODEL_DEEP']));
        const env = WORKFLOW.jobs.inspect.env;
        expect(Object.fromEntries(ENGINE_MODEL_VARS.map((v) => [v, env[v]]))).toEqual(Object.fromEntries(ENGINE_MODEL_VARS.map((v) => [v, BUDGET.model])));
    });

    it('records the budget’s model as the revision, never a literal', () => {
        const run = WORKFLOW.jobs.inspect.steps.find((s) => s.id === 'evals')?.run ?? '';
        const revisions = [...run.matchAll(/--model-revision (\S+ \S+ \S+)/g)].map((m) => m[1]);
        expect(revisions).toEqual([`"$(node -p 'require("./evals/inspect/budget.json").model')"`]);
    });
});

describe('the harness image', () => {
    it('pins the base by digest and inspect-ai by exact version, in both places', () => {
        const docker = read('evals/inspect/Dockerfile');
        expect(docker).toMatch(/^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/m);
        const version = /^ARG INSPECT_AI_VERSION=(\d+\.\d+\.\d+)$/m.exec(docker)?.[1];
        expect(version).toBeDefined();
        const pinned = /"inspect-ai==(\d+\.\d+\.\d+)"/.exec(read('evals/inspect/pyproject.toml'))?.[1];
        expect(pinned).toBe(version);
    });

    it('never enters the app image', () => {
        expect(read('Dockerfile')).not.toMatch(/inspect[-_]ai/);
    });
});

describe('the run shape', () => {
    const run = WORKFLOW.jobs.inspect.steps.find((s) => s.id === 'evals')?.run ?? '';

    it('keeps one sample in flight and leaves Inspect’s own model slot unused', () => {
        expect(run).toMatch(/--max-samples 1\b/);
        expect(run).toMatch(/--model mockllm\/model\b/);
    });

    it('is reachable only by schedule and dispatch', () => {
        expect(Object.keys(WORKFLOW.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    });
});
