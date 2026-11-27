/**
 * THE EVALUATIONS CARD SAYS WHAT THE WORKFLOWS DO, AND THE WORKFLOWS ASK THE
 * PRODUCT WHETHER THEY ARE ON (owner decisions 2026-11-12 and 2026-11-27).
 *
 *   1. Every fact the card shows is read back from its source: the workflow's
 *      cron, the dedicated key secret, and the budget files. A moved schedule
 *      or a renamed key fails here, not on the page.
 *   2. Each workflow's gate asks the switch endpoint for ITS OWN key, through
 *      the CI token, and no longer reads a repository variable. The gate is
 *      RUN (bash, with a stand-in `curl` on PATH): on, off, and every failure
 *      class, which all fail closed with a warning that never prints the token
 *      or the response body. A dispatch runs once and asks nothing.
 *   3. The card is shown to an org admin-tier viewer of every organization by
 *      default, except one the operator opts out in
 *      EVALS_CARD_HIDDEN_ORG_SLUGS; unset or empty hides it nowhere.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

import {
    EVAL_NIGHTLIES,
    EVAL_NIGHTLY_KEYS,
    EVAL_SHARED_KEY_SECRET,
    EVALS_REPOSITORY_URL,
    evalWorkflowRunsUrl,
    formatEvalUsd,
    isEvalNightlyKey,
} from '@/lib/evals/evaluation-nightlies';
import { evalsCardVisible, parseEvalsCardOrgSlugs } from '@/lib/evals/evals-card-visibility';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

interface Step {
    id?: string;
    env?: Record<string, string>;
    run?: string;
}
function gateStep(workflowFile: string): Step {
    const wf = yaml.load(read(`.github/workflows/${workflowFile}`)) as { jobs: Record<string, { steps: Step[] }> };
    const jobs = Object.values(wf.jobs);
    expect(jobs).toHaveLength(1);
    return jobs[0].steps[0];
}

describe('1. the typed content matches the workflows it describes', () => {
    it('lists the three nightlies, once each, in the order they run', () => {
        expect(EVAL_NIGHTLIES.map((n) => n.key)).toEqual([...EVAL_NIGHTLY_KEYS]);
        expect(EVAL_NIGHTLY_KEYS).toEqual(['ragas', 'garak', 'inspect']);
        const times = EVAL_NIGHTLIES.map((n) => n.scheduleUtc);
        expect([...times].sort()).toEqual(times);
    });

    it.each(EVAL_NIGHTLIES.map((n) => [n.key, n] as const))('%s', (_key, n) => {
        const wf = read(`.github/workflows/${n.workflowFile}`);
        const cron = /cron:\s*'(\d+) (\d+) \* \* \*'/.exec(wf);
        expect(cron).not.toBeNull();
        const [, minute, hour] = cron!;
        expect(n.scheduleUtc).toBe(`${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`);
        // The repository variables the workflow reads: the switch endpoint's
        // URL, and the workspace the shared (organisation-level) key needs,
        // which is read only where the dedicated key is absent. No switch
        // variable of its own any more.
        const vars = [...new Set([...wf.matchAll(/\bvars\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
        expect(vars).toEqual(['ANTHROPIC_WORKSPACE_ID', 'EVALS_SWITCH_URL']);
        for (const [line] of wf.matchAll(/^.*\bvars\.ANTHROPIC_WORKSPACE_ID\b.*$/gm)) {
            expect(line).toContain(`\${{ secrets.${n.dedicatedKeySecret} == '' && vars.ANTHROPIC_WORKSPACE_ID || '' }}`);
        }
        // The key: every place the workflow picks one names the dedicated
        // secret first and the shared one otherwise.
        const keyPairs = new Set([...wf.matchAll(/secrets\.(\w+) \|\| secrets\.(\w+)/g)].map((m) => `${m[1]}|${m[2]}`));
        expect([...keyPairs]).toEqual([`${n.dedicatedKeySecret}|${EVAL_SHARED_KEY_SECRET}`]);
        // A manual dispatch always runs.
        expect(/^on:\n\s+workflow_dispatch:/m.test(wf)).toBe(true);
        expect(fs.existsSync(path.join(ROOT, n.roadmapDoc))).toBe(true);
    });

    it('garak and Ragas spend their shares of the shared nightly cap', () => {
        const shares = JSON.parse(read('evals/cost-meter/shares.json')) as {
            nightlyCapUsd: number;
            shares: Record<string, { usd: number }>;
        };
        // The card says the cap is shared between the two.
        expect(Object.keys(shares.shares).sort()).toEqual(['garak', 'ragas']);
        for (const key of ['garak', 'ragas'] as const) {
            const n = EVAL_NIGHTLIES.find((x) => x.key === key)!;
            expect(shares.shares[key].usd).toBe(n.budgetUsd);
            expect(shares.nightlyCapUsd).toBe(n.sharedCapUsd);
            expect(n.budgetDecision).toBe('D-EV-11');
        }
    });

    it('Inspect spends the nightly cap of its budget file', () => {
        const inspect = EVAL_NIGHTLIES.find((n) => n.key === 'inspect')!;
        const budget = JSON.parse(read('evals/inspect/budget.json')) as { nightlyCapUsd: number };
        expect(budget.nightlyCapUsd).toBe(inspect.budgetUsd);
        expect(inspect.sharedCapUsd).toBeNull();
    });

    it('derives every link from the one repository URL', () => {
        expect(evalWorkflowRunsUrl('garak.yml')).toBe(`${EVALS_REPOSITORY_URL}/actions/workflows/garak.yml`);
    });

    it('formats whole dollars whole and cents with two digits', () => {
        expect(formatEvalUsd(10)).toBe('10');
        expect(formatEvalUsd(2.5)).toBe('2.50');
        expect(formatEvalUsd(4)).toBe('4');
    });

    it('knows its own keys and nothing else', () => {
        for (const k of EVAL_NIGHTLY_KEYS) expect(isEvalNightlyKey(k)).toBe(true);
        for (const k of ['GARAK', 'rag-eval', '', null, 1]) expect(isEvalNightlyKey(k)).toBe(false);
    });

    it('the switch table admits exactly these keys', () => {
        const sql = read('prisma/migrations/20261127120000_eval_nightly_switches/migration.sql');
        const check = /CHECK \("nightly" IN \(([^)]*)\)\)/.exec(sql);
        expect(check).not.toBeNull();
        const admitted = [...check![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
        expect(admitted).toEqual([...EVAL_NIGHTLY_KEYS].sort());
    });
});

describe('2. each workflow asks the product for its own switch, and fails closed', () => {
    it.each(EVAL_NIGHTLIES.map((n) => [n.workflowFile, n.key] as const))(
        '%s reads the switch for %s, through the CI token, and no repository variable',
        (file, key) => {
            const step = gateStep(file);
            expect(step.id).toBe('key');
            expect(step.env?.NIGHTLY).toBe(key);
            expect(step.env?.SWITCH_URL).toBe('${{ vars.EVALS_SWITCH_URL }}');
            expect(step.env?.SWITCH_TOKEN).toBe('${{ secrets.EVALS_SWITCH_READ_TOKEN }}');
            expect(step.env?.ENABLED).toBeUndefined();
            // The secret is passed through env, never spelled inside `run:`.
            expect(step.run).not.toMatch(/\$\{\{/);
            // The retired variables are gone: section 1 holds the file's
            // whole `vars.` population to the switch URL and the workspace.
            // Only the gate step holds the token.
            const wf = yaml.load(read(`.github/workflows/${file}`)) as { jobs: Record<string, { steps: Step[]; env?: unknown }> };
            const job = Object.values(wf.jobs)[0];
            expect(JSON.stringify(job.env ?? {})).not.toContain('EVALS_SWITCH_READ_TOKEN');
            const holders = job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes('EVALS_SWITCH_READ_TOKEN')).map((s) => s.id);
            expect(holders).toEqual(['key']);
        },
    );

    it('the three gates are the same script but for the label', () => {
        const scripts = EVAL_NIGHTLIES.map((n) => {
            const run = gateStep(n.workflowFile).run!;
            // Up to the decision that follows it: the part each workflow shares.
            const shared = run.slice(0, run.indexOf('if [ "$EVENT" = "schedule" ] && [ "$ENABLED" != "true" ]; then'));
            return shared.replace(/\b(garak|ragas|RAG eval|inspect|agent-evals)\b/g, '<n>');
        });
        expect(new Set(scripts).size).toBe(1);
    });

    // ── The gate, run ───────────────────────────────────────────────
    const HAVE_TOOLS = ['bash', 'jq'].every((bin) => spawnSync(bin, ['--version']).status === 0);
    if (process.env.CI) {
        // On CI the runner has both; a skipped behavioural suite there would
        // read as a pass.
        it('has bash and jq to run the gate with', () => expect(HAVE_TOOLS).toBe(true));
    }
    const run = HAVE_TOOLS ? describe : describe.skip;

    const TOKEN = 'tok-' + 'x'.repeat(40);
    const BODY_MARKER = 'BODY-MARKER-7f3a';

    interface Outcome {
        present: string | undefined;
        stdout: string;
        curlArgs: string[] | null;
    }

    function runGate(
        file: string,
        opts: {
            event: 'schedule' | 'workflow_dispatch';
            url?: string;
            token?: string;
            status?: string;
            body?: string;
            exit?: number;
        },
    ): Outcome {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-'));
        try {
            const bin = path.join(dir, 'bin');
            fs.mkdirSync(bin);
            const log = path.join(dir, 'curl.log');
            // A stand-in curl: records its arguments, writes the body to -o,
            // prints the status for -w, exits as told.
            fs.writeFileSync(
                path.join(bin, 'curl'),
                [
                    '#!/usr/bin/env bash',
                    'printf "%s\\n" "$@" > "$FAKE_LOG"',
                    'out=""',
                    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
                    '[ -n "$out" ] && printf "%s" "$FAKE_BODY" > "$out"',
                    'printf "%s" "$FAKE_STATUS"',
                    'exit "${FAKE_EXIT:-0}"',
                ].join('\n'),
                { mode: 0o755 },
            );
            const script = path.join(dir, 'gate.sh');
            fs.writeFileSync(script, gateStep(file).run!);
            const output = path.join(dir, 'output');
            fs.writeFileSync(output, '');
            const step = gateStep(file);
            const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
                encoding: 'utf8',
                env: {
                    NODE_ENV: 'test',
                    PATH: `${bin}:${process.env.PATH}`,
                    GITHUB_OUTPUT: output,
                    EVENT: opts.event,
                    KEY: 'a-model-key',
                    NIGHTLY: step.env!.NIGHTLY,
                    SWITCH_URL: opts.url ?? '',
                    SWITCH_TOKEN: opts.token ?? '',
                    FAKE_LOG: log,
                    FAKE_STATUS: opts.status ?? '200',
                    FAKE_BODY: opts.body ?? '',
                    FAKE_EXIT: String(opts.exit ?? 0),
                },
            });
            expect(res.status).toBe(0);
            const outputs = Object.fromEntries(
                fs.readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=') as [string, string]),
            );
            const stdout = `${res.stdout}${res.stderr}`;
            // Never the token, never the body, whatever happened.
            expect(stdout).not.toContain(TOKEN);
            expect(stdout).not.toContain(BODY_MARKER);
            return {
                present: outputs.present,
                stdout,
                curlArgs: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : null,
            };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    const URL_ = 'https://app.example.test/api/evals/nightly-switches';
    const answer = (own: unknown, key: string) => {
        const all: Record<string, unknown> = { garak: true, ragas: true, inspect: true, note: BODY_MARKER };
        all[key] = own;
        return JSON.stringify(all);
    };

    run.each(EVAL_NIGHTLIES.map((n) => [n.workflowFile, n.key] as const))('%s (%s)', (file, key) => {
        it('runs on a schedule when the product answers true, asking with the token over https only', () => {
            const out = runGate(file, { event: 'schedule', url: URL_, token: TOKEN, body: answer(true, key) });
            expect(out.present).toBe('true');
            expect(out.stdout).not.toContain('::warning::');
            expect(out.curlArgs).toEqual(
                expect.arrayContaining(['--fail', '--proto', '=https', '--max-time', '15', `Authorization: Bearer ${TOKEN}`, URL_]),
            );
        });

        it('stays off when the product answers false, without a warning', () => {
            const out = runGate(file, { event: 'schedule', url: URL_, token: TOKEN, body: answer(false, key) });
            expect(out.present).toBe('false');
            expect(out.stdout).toContain('::notice::');
            expect(out.stdout).not.toContain('::warning::');
        });

        it('a dispatch runs once and asks nothing', () => {
            const out = runGate(file, { event: 'workflow_dispatch', body: answer(false, key) });
            expect(out.present).toBe('true');
            expect(out.curlArgs).toBeNull();
        });

        const failures: Array<[string, Parameters<typeof runGate>[1], string]> = [
            ['the URL is unset', { event: 'schedule', token: TOKEN, body: answer(true, key) }, 'is not set'],
            ['the token is unset', { event: 'schedule', url: URL_, body: answer(true, key) }, 'is not set'],
            ['the request fails', { event: 'schedule', url: URL_, token: TOKEN, status: '000', exit: 7 }, 'failed or timed out'],
            ['the endpoint refuses the token', { event: 'schedule', url: URL_, token: TOKEN, status: '401', exit: 22, body: answer(true, key) }, 'answered HTTP 401'],
            ['the endpoint is not configured', { event: 'schedule', url: URL_, token: TOKEN, status: '503', exit: 22, body: answer(true, key) }, 'answered HTTP 503'],
            ['the status is a 2xx other than 200', { event: 'schedule', url: URL_, token: TOKEN, status: '204', body: answer(true, key) }, 'answered HTTP 204'],
            ['the answer is not JSON', { event: 'schedule', url: URL_, token: TOKEN, body: `<html>${BODY_MARKER}</html>` }, 'no boolean'],
            ['its own key is a string', { event: 'schedule', url: URL_, token: TOKEN, body: answer('true', key) }, 'no boolean'],
            ['its own key is missing while the others are on', { event: 'schedule', url: URL_, token: TOKEN, body: answer(undefined, key) }, 'no boolean'],
            ['the answer is an array', { event: 'schedule', url: URL_, token: TOKEN, body: `[true, "${BODY_MARKER}"]` }, 'no boolean'],
        ];
        it.each(failures)('stays off with a warning when %s', (_why, opts, reason) => {
            const out = runGate(file, opts);
            expect(out.present).toBe('false');
            const warnings = out.stdout.split('\n').filter((l) => l.startsWith('::warning::'));
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain(reason);
        });
    });
});

describe('3. who sees the card', () => {
    it('parses the operator list, ignoring blanks and whitespace', () => {
        expect([...parseEvalsCardOrgSlugs(' acme , ,beta,')]).toEqual(['acme', 'beta']);
        expect(parseEvalsCardOrgSlugs(undefined).size).toBe(0);
        expect(parseEvalsCardOrgSlugs('').size).toBe(0);
    });

    it('is shown to an owner or admin of an organization that has not opted out', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_ADMIN', hiddenIn: 'beta' })).toBe(true);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: 'acme-group' })).toBe(true);
    });

    it('is shown everywhere when the opt-out list is unset or empty', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: undefined })).toBe(true);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: '' })).toBe(true);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: ' , ' })).toBe(true);
    });

    it('is hidden in an organization that opted out', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_ADMIN', hiddenIn: 'beta, acme' })).toBe(false);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_OWNER', hiddenIn: 'acme' })).toBe(false);
    });

    it('is hidden from a reader, whatever the list says', () => {
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: 'ORG_READER', hiddenIn: undefined })).toBe(false);
        expect(evalsCardVisible({ orgSlug: 'acme', orgRole: null, hiddenIn: 'beta' })).toBe(false);
    });
});
