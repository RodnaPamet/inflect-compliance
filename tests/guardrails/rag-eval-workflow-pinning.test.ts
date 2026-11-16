/**
 * The Ragas nightly's invariants (docs/ai-architecture/ragas.md, Phase 1).
 *
 *   1. A non-blocking judge stage carries a DATED `RAG-EVAL-NON-BLOCKING-UNTIL`
 *      marker, compared here with the real clock (the DAST lesson: a marker
 *      nobody parses never turns red). `continue-on-error` stands only on the
 *      judge step, and only while the marker stands.
 *   2. Off unless switched on: a scheduled run does nothing unless
 *      RAG_EVAL_ENABLED is 'true'; every later step reads the first step's
 *      decision. Schedule and dispatch only.
 *   3. The model key reaches ONE process, the metering proxy: it is read in the
 *      first step (presence only) and the judge step (which hands it to the
 *      proxy and unsets it), never job env, and the judge container is given
 *      no environment at all. The dedicated RAGAS_ANTHROPIC_API_KEY is
 *      preferred over the shared key (owner decision 2026-11-16), the
 *      workspace header goes only with the shared one, and the log names
 *      which secret was used, never its value — as garak's and Inspect's do.
 *   4. The embedder is the deployment's: the TEI image digest, model and Hub
 *      revision equal the canonical Compose file's, and the embedding variables
 *      are the ones docs/deployment.md gives the VM (the E5 prefixes, 384).
 *   5. The judge image: the base by digest, ragas and anthropic by exact
 *      version in the Dockerfile, pyproject and the full lock alike, every
 *      requirement of both locks (runtime and test stage) by sha256 hash,
 *      each installed with --no-deps --require-hashes and checked, analytics
 *      off; never the app image.
 *   6. The plan fits the share: the planned night (set cases plus sentinels)
 *      at the cost meter's price for its model, inside the ragas share, and the
 *      judge's per-call output bound inside the proxy's cap.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WORKFLOW_SRC = read('.github/workflows/rag-eval.yml');
type Step = { id?: string; name?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string; 'continue-on-error'?: boolean };
const WORKFLOW = yaml.load(WORKFLOW_SRC) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { 'rag-eval': { env: Record<string, string>; services: Record<string, { image: string }>; steps: Step[] } };
};
const JOB = WORKFLOW.jobs['rag-eval'];
const step = (id: string) => JOB.steps.find((s) => s.id === id || s.name === id);
const MARKER = /RAG-EVAL-NON-BLOCKING-UNTIL:\s*(\d{4}-\d{2}-\d{2})/g;

export function nonBlockingUntil(src: string): string | null {
    const dates = [...src.matchAll(MARKER)].map((m) => m[1]);
    if (dates.length > 1) throw new Error('more than one RAG-EVAL-NON-BLOCKING-UNTIL marker');
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

    it('has not lapsed, and continue-on-error stands only on the judge step beside it', () => {
        const until = nonBlockingUntil(WORKFLOW_SRC);
        const nonBlocking = JOB.steps.filter((s) => s['continue-on-error'] === true).map((s) => s.id);
        if (until === null) {
            expect(nonBlocking).toEqual([]);
            return;
        }
        expect(deferralLapsed(until, new Date())).toBe(false);
        expect(nonBlocking).toEqual(['judge']);
    });
});

describe('off unless switched on', () => {
    it('decides in the first step and conditions every later step on it', () => {
        const first = JOB.steps[0];
        expect(first.id).toBe('key');
        expect(first.env?.ENABLED).toBe('${{ vars.RAG_EVAL_ENABLED }}');
        expect(first.env?.EVENT).toBe('${{ github.event_name }}');
        expect(first.run).toContain('if [ "$EVENT" = "schedule" ] && [ "$ENABLED" != "true" ]; then');
        for (const s of JOB.steps.slice(1)) expect([s.name, s.if ?? '']).toEqual([s.name, expect.stringContaining("steps.key.outputs.present == 'true'")]);
    });

    it('is reachable only by schedule and dispatch', () => {
        expect(Object.keys(WORKFLOW.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    });
});

describe('the model key reaches the metering proxy and nothing else', () => {
    it('is never job env, and only two steps read either key', () => {
        expect(JSON.stringify(JOB.env)).not.toContain('secrets.');
        for (const secret of ['secrets.RAGAS_ANTHROPIC_API_KEY', 'secrets.ANTHROPIC_API_KEY']) {
            const holders = JOB.steps.filter((s) => JSON.stringify(s.env ?? {}).includes(secret)).map((s) => s.id);
            expect(holders).toEqual(['key', 'judge']);
        }
        expect(step('key')?.env?.KEY).toBe('${{ secrets.RAGAS_ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY }}');
        expect(step('judge')?.env?.ANTHROPIC_API_KEY).toBe('${{ secrets.RAGAS_ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY }}');
    });

    it('prefers the dedicated key as garak and Inspect do: the header only with the shared key, the source logged by name', () => {
        const judge = step('judge');
        expect(judge?.env?.ANTHROPIC_WORKSPACE_ID).toBe("${{ secrets.RAGAS_ANTHROPIC_API_KEY == '' && vars.ANTHROPIC_WORKSPACE_ID || '' }}");
        expect(judge?.env?.KEY_SOURCE).toBe("${{ secrets.RAGAS_ANTHROPIC_API_KEY != '' && 'RAGAS_ANTHROPIC_API_KEY' || 'ANTHROPIC_API_KEY' }}");
        expect(judge?.run).toContain('rag-eval: judge key from ${KEY_SOURCE}; anthropic-workspace-id header: $([ -n "${ANTHROPIC_WORKSPACE_ID}" ] && echo sent || echo \'not sent\')');
        expect(judge?.run).not.toMatch(/echo[^\n]*\$\{?ANTHROPIC_WORKSPACE_ID\}?"?\s*$/m);
    });

    it('starts the proxy for the ragas share, unsets the key, and runs the judge container with no environment', () => {
        const run = step('judge')?.run ?? '';
        expect(run).toMatch(/^\s*COST_METER_JOB=ragas COST_METER_PORT=8787 node evals\/cost-meter\/anthropic-proxy\.mjs & proxy=\$!$/m);
        expect(run.indexOf('unset ANTHROPIC_API_KEY')).toBeGreaterThan(run.indexOf('anthropic-proxy.mjs'));
        expect(run.indexOf('unset ANTHROPIC_API_KEY')).toBeLessThan(run.indexOf('docker run'));
        const docker = run.slice(run.indexOf('docker run')).split('\n').slice(0, 5).join('\n');
        expect(docker).not.toMatch(/\s(-e|--env|--env-file)\s/);
        expect(docker).toContain('--proxy http://127.0.0.1:8787');
        expect(run).not.toMatch(/echo[^\n]*\$\{?ANTHROPIC_API_KEY/);
    });

    it('writes no record without an answer target, before anything is started', () => {
        const run = step('judge')?.run ?? '';
        expect(run.indexOf('if [ -z "$RAG_EVAL_ANSWER_URL" ]; then')).toBeLessThan(run.indexOf('anthropic-proxy.mjs'));
        expect(JOB.env).toHaveProperty('RAG_EVAL_ANSWER_URL');
    });
});

describe('the embedder is the deployment’s', () => {
    const compose = yaml.load(read('deploy/docker-compose.prod.yml')) as { services: Record<string, { image: string; command: string[] }> };
    const tei = compose.services['tei-embed'];
    const arg = (name: string) => tei.command[tei.command.indexOf(name) + 1];
    const start = step('Start TEI (the deployment’s embedder)') ?? step('Start TEI (the deployment\'s embedder)');

    it('runs the canonical image, model and Hub revision', () => {
        const run = start?.run ?? '';
        expect(run).toContain(tei.image);
        expect(run).toContain(`--model-id ${arg('--model-id')} --revision ${arg('--revision')}`);
        expect(JOB.env.AI_EMBED_LOCAL_MODEL).toBe(arg('--model-id'));
        expect(run).toContain('-p 127.0.0.1:8080:8080');
    });

    it('configures the embedding route as the VM does (docs/deployment.md: the E5 prefixes)', () => {
        expect(JOB.env.AI_EMBED_LOCAL_QUERY_PREFIX).toBe('query: ');
        expect(JOB.env.AI_EMBED_LOCAL_PASSAGE_PREFIX).toBe('passage: ');
        expect(JOB.env.AI_EMBED_LOCAL_DIMENSIONS).toBe('384');
        expect(JOB.env.VECTOR_STORE_BACKEND).toBe('pgvector');
        expect(JOB.env.AI_EMBED_LOCAL_BASE_URL).toBe('http://127.0.0.1:8080');
    });

    it('states the corpus as positive integers', () => {
        for (const k of ['RAG_EVAL_PROBE_TENANT_CHUNKS', 'RAG_EVAL_SCALE_MULTIPLE']) expect(JOB.env[k]).toMatch(/^[1-9]\d*$/);
    });

    it('runs on the pgvector Postgres image the other evaluation nightlies use', () => {
        const garak = yaml.load(read('.github/workflows/garak.yml')) as { jobs: { garak: { services: { postgres: { image: string } } } } };
        expect(JOB.services.postgres.image).toBe(garak.jobs.garak.services.postgres.image);
    });
});

/**
 * A hash-pinned lock (`pip-compile --generate-hashes`'s format): every
 * requirement is `name==version` followed by at least one `--hash=sha256:`,
 * continued with a backslash. Anything else is refused, so an unhashed or
 * unpinned line cannot slip in beside the hashed ones.
 */
export function parseHashedLock(src: string, file: string): Map<string, { version: string; hashes: string[] }> {
    const out = new Map<string, { version: string; hashes: string[] }>();
    const requirements = src
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n')
        .replace(/ \\\n\s+/g, ' ')
        .split('\n')
        .filter((l) => l.trim() !== '');
    for (const r of requirements) {
        const m = /^([A-Za-z0-9_.-]+)==([^\s]+)((?: --hash=sha256:[0-9a-f]{64})+)$/.exec(r);
        if (!m) throw new Error(`${file}: not name==version with sha256 hashes: ${r.slice(0, 120)}`);
        const name = m[1].toLowerCase();
        if (out.has(name)) throw new Error(`${file}: ${name} is pinned twice`);
        out.set(name, { version: m[2], hashes: m[3].trim().split(' ').map((h) => h.slice('--hash=sha256:'.length)) });
    }
    return out;
}

describe('the judge image', () => {
    const docker = read('evals/rag/Dockerfile');
    const hashed = parseHashedLock(read('evals/rag/requirements.lock'), 'requirements.lock');
    const lock = new Map([...hashed].map(([name, r]) => [name, r.version] as const));
    const testLock = parseHashedLock(read('evals/rag/requirements-test.lock'), 'requirements-test.lock');
    const pyproject = read('evals/rag/pyproject.toml');

    it('the hashed-lock reader refuses an unhashed, unpinned or repeated line', () => {
        const h = `--hash=sha256:${'a'.repeat(64)}`;
        expect(parseHashedLock(`# c\nx==1 \\\n    ${h} \\\n    ${h}\n`, 't').get('x')).toEqual({ version: '1', hashes: ['a'.repeat(64), 'a'.repeat(64)] });
        expect(() => parseHashedLock('x==1\n', 't')).toThrow(/sha256 hashes/);
        expect(() => parseHashedLock(`x>=1 \\\n    ${h}\n`, 't')).toThrow(/sha256 hashes/);
        expect(() => parseHashedLock(`x==1 \\\n    ${h}\nX==2 \\\n    ${h}\n`, 't')).toThrow(/pinned twice/);
    });

    it('pins every requirement of both locks by hash, and installs each by hash alone', () => {
        expect(hashed.size).toBeGreaterThan(50);
        expect([...testLock.keys()].sort()).toEqual(['iniconfig', 'pluggy', 'pytest']);
        // The test stage's pins do not shadow the runtime set's.
        for (const name of testLock.keys()) expect(hashed.has(name)).toBe(false);
        expect(docker).toMatch(/^\s+&& pip install --no-deps --require-hashes -r requirements\.lock \\\n\s+&& pip check$/m);
        expect(docker).toMatch(/^RUN pip install --no-deps --require-hashes -r requirements-test\.lock \\\n\s+&& pip check$/m);
        // Every pip install in the image is one of those two.
        expect([...docker.matchAll(/pip install[^\n]*/g)].map((m) => m[0])).toEqual([
            'pip install --no-deps --require-hashes -r requirements.lock \\',
            'pip install --no-deps --require-hashes -r requirements-test.lock \\',
        ]);
        const testExtra = /^test = (\[.*\])$/m.exec(pyproject)?.[1];
        expect(JSON.parse(testExtra ?? '[]')).toEqual([`pytest==${testLock.get('pytest')?.version}`]);
    });

    it('pins the base by digest and every dependency by exact version', () => {
        expect(docker).toMatch(/^FROM python:3\.12-slim@sha256:[0-9a-f]{64} AS runtime$/m);
        const ragas = /^ARG RAGAS_VERSION=(\d+\.\d+\.\d+)$/m.exec(docker)?.[1];
        expect(ragas).toBeDefined();
        expect(lock.get('ragas')).toBe(ragas);
        const deps = /^dependencies = (\[.*\])$/m.exec(pyproject)?.[1];
        expect(JSON.parse(deps ?? '[]')).toEqual([`ragas==${ragas}`, `anthropic==${lock.get('anthropic')}`]);
        expect(docker).toMatch(/^RUN grep -q "\^ragas==\$\{RAGAS_VERSION\} " requirements\.lock \\$/m);
        expect(docker).toMatch(/RAGAS_DO_NOT_TRACK=true/);
    });

    it('builds its test stage before the image the workflow runs', () => {
        const run = step('Build the Ragas image (its tests are the gate)')?.run ?? '';
        expect(run.indexOf('docker build --target test evals/rag')).toBeGreaterThanOrEqual(0);
        expect(run.indexOf('docker build --target test evals/rag')).toBeLessThan(run.indexOf('docker build -t inflect-ragas:ci evals/rag'));
    });

    it('never enters the app image', () => {
        expect(read('Dockerfile')).not.toMatch(/ragas/i);
    });
});

describe('the plan fits the ragas share of the shared cap (D-EV-2, D-EV-11)', () => {
    const shares = JSON.parse(read('evals/cost-meter/shares.json'));
    const prices = JSON.parse(read('evals/cost-meter/prices.json'));
    const budget = JSON.parse(read('evals/rag/budget.json'));
    const set = JSON.parse(read('evals/rag/sets/seed-policies.json'));

    it('the planned night costs no more than the share', () => {
        const share = shares.shares.ragas;
        const price = prices.models[share.model];
        const p = budget.plannedCase;
        const perCase = (p.inputTokens * price.usdPerMillionInputTokens + p.outputTokens * price.usdPerMillionOutputTokens) / 1e6;
        expect(perCase * (set.cases.length + budget.sentinelCases)).toBeLessThanOrEqual(share.usd);
    });

    it('the judge asks for the output bound the plan prices, inside the proxy’s cap', () => {
        const judge = read('evals/rag/inflect_rag/judge.py');
        expect(Number(/^JUDGE_MAX_TOKENS = (\d+)$/m.exec(judge)?.[1])).toBe(budget.judge.maxTokensPerCall);
        const cap = Number(/export const DEFAULT_MAX_OUTPUT_TOKENS = (\d+);/.exec(read('evals/cost-meter/anthropic-proxy.mjs'))?.[1]);
        expect(budget.judge.maxTokensPerCall).toBeLessThanOrEqual(cap);
        expect(Number(/strictness: int = (\d+)\):$/m.exec(judge)?.[1])).toBe(budget.judge.answerRelevancyStrictness);
    });
});
