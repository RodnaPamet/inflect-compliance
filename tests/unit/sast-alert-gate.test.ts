/**
 * The merge-queue SAST gate, run for real against a fake GitHub API (#4047).
 *
 * `scripts/sast-alert-gate.mjs` decides one thing: may this queue candidate
 * merge, given the PR's `CodeQL` check from GitHub's code-scanning app? The
 * owner's rule (2026-10-25) is fail closed. Only a finished `success` passes,
 * and a missing or unfinished check is waited for and then refused. Every
 * case below runs the script as CI does, in a child process, with its API base
 * pointed at a local server, so what is asserted is the exit code and message
 * a merge would see.
 *
 * The script is spawned ASYNCHRONOUSLY on purpose: the fake API lives in this
 * process, and a synchronous spawn would block the event loop that has to
 * answer it.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const GATE = path.resolve(__dirname, '../../scripts/sast-alert-gate.mjs');
const REPO = 'acme/app';
const PR = 4043;
const HEAD = 'a'.repeat(40);
const QUEUE_REF = `refs/heads/gh-readonly-queue/main/pr-${PR}-${'b'.repeat(40)}`;

type CheckRun = { name: string; status: string; conclusion: string | null; app: { slug: string }; html_url: string };

const codeql = (status: string, conclusion: string | null, slug = 'github-advanced-security'): CheckRun => ({
    name: 'CodeQL',
    status,
    conclusion,
    app: { slug },
    html_url: `https://github.example/${REPO}/runs/1`,
});

/** What the fake API answers for the check-runs read, call by call; the last repeats. */
let checkRunAnswers: Array<CheckRun[] | number> = [];
let checkRunReads = 0;
let server: Server;
let api = '';

beforeAll(async () => {
    server = createServer((req, res) => {
        const url = req.url ?? '';
        if (url === `/repos/${REPO}/pulls/${PR}`) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ number: PR, head: { sha: HEAD } }));
            return;
        }
        if (url.startsWith(`/repos/${REPO}/commits/${HEAD}/check-runs?`) && url.includes('check_name=CodeQL')) {
            const answer = checkRunAnswers[Math.min(checkRunReads, checkRunAnswers.length - 1)];
            checkRunReads++;
            if (typeof answer === 'number') {
                res.writeHead(answer);
                res.end('{}');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ total_count: answer.length, check_runs: answer }));
            return;
        }
        res.writeHead(404);
        res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    checkRunReads = 0;
});

function runGate(answers: Array<CheckRun[] | number>, queueRef = QUEUE_REF) {
    checkRunAnswers = answers;
    return new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
            process.execPath,
            [GATE],
            {
                env: {
                    PATH: process.env.PATH,
                    GITHUB_API_URL: api,
                    GITHUB_REPOSITORY: REPO,
                    GITHUB_TOKEN: 'test-token',
                    MERGE_GROUP_HEAD_REF: queueRef,
                    SAST_GATE_DEADLINE_MS: '600',
                    SAST_GATE_POLL_MS: '40',
                },
            },
            (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
                resolve({ code, out: `${stdout}${stderr}` });
            },
        );
    });
}

describe('the merge-queue SAST gate (#4047)', () => {
    it('passes a PR whose CodeQL check succeeded (positive control)', async () => {
        const { code, out } = await runGate([[codeql('completed', 'success')]]);
        expect(code).toBe(0);
        expect(out).toContain('SAST gate PASSED');
    });

    it('fails a PR whose CodeQL check failed, naming the PR and the check', async () => {
        // #4043's case: the check failed on a new HIGH alert.
        const { code, out } = await runGate([[codeql('completed', 'failure')]]);
        expect(code).toBe(1);
        expect(out).toContain(`PR #${PR}`);
        expect(out).toContain('concluded failure');
        expect(out).toContain(`https://github.example/${REPO}/runs/1`);
    });

    it.each(['neutral', 'skipped', 'cancelled', 'stale', 'timed_out', 'action_required'])(
        'fails closed on a check that concluded %s',
        async (conclusion) => {
            const { code, out } = await runGate([[codeql('completed', conclusion)]]);
            expect(code).toBe(1);
            expect(out).toContain(`concluded ${conclusion}`);
        },
    );

    it('waits for a check that is still running, and passes when it succeeds', async () => {
        const { code } = await runGate([[codeql('in_progress', null)], [codeql('completed', 'success')]]);
        expect(code).toBe(0);
        expect(checkRunReads).toBeGreaterThanOrEqual(2);
    });

    it('fails closed when no CodeQL check ever appears', async () => {
        const { code, out } = await runGate([[]]);
        expect(code).toBe(1);
        expect(out).toContain('no finished CodeQL check');
        // It waited rather than failing on the first read.
        expect(checkRunReads).toBeGreaterThan(1);
    });

    it('does not take a same-named check from another app for the code-scanning one', async () => {
        // A workflow job called `CodeQL` that succeeded says nothing about alerts.
        const { code, out } = await runGate([[codeql('completed', 'success', 'github-actions')]]);
        expect(code).toBe(1);
        expect(out).toContain('no finished CodeQL check');
    });

    it('fails closed when the API cannot be read, saying so', async () => {
        const { code, out } = await runGate([500]);
        expect(code).toBe(1);
        expect(out).toContain('could not read it');
    });

    it('fails when the candidate does not name a pull request', async () => {
        const { code, out } = await runGate([[codeql('completed', 'success')]], 'refs/heads/main');
        expect(code).toBe(1);
        expect(out).toContain('cannot tell which pull request');
        expect(checkRunReads).toBe(0);
    });
});
