/**
 * The release waits for the merge queue — `scripts/release-queue-gate.mjs`.
 *
 * A release commit pushed while the queue is building invalidates every
 * candidate in flight. The gate holds a push's release while any other entry
 * is waiting, and must never hold one it cannot justify: a scheduled or manual
 * run, an unreadable queue, or a gate that breaks all release.
 *
 * The entry script runs here as a real Node process against a local stand-in
 * for the GraphQL endpoint, the way the workflow runs it, and the workflow is
 * read for the wiring that makes its answer count.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const { decideRelease, prNumberOfCommit } = require('../../scripts/lib/release-queue-gate.js');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/release-queue-gate.mjs');

describe('prNumberOfCommit', () => {
    it('reads the PR from the end of a squash subject', () => {
        expect(prNumberOfCommit('fix(test): derive the window (#4207)')).toBe(4207);
    });

    it('takes the LAST reference, which is the squash, not one quoted in the title', () => {
        expect(prNumberOfCommit('docs(recert): a snapshot is a claim (#3325) (#4188)')).toBe(4188);
    });

    it('reads the subject only, never a reference in the body', () => {
        expect(prNumberOfCommit('chore: tidy\n\nFollows up (#4100)')).toBeNull();
    });

    it('names nothing for a commit with no reference', () => {
        expect(prNumberOfCommit('chore(release): 3.319.6 [skip ci]')).toBeNull();
        expect(prNumberOfCommit('')).toBeNull();
    });
});

describe('decideRelease', () => {
    const push = (prNumbers: number[], total = prNumbers.length, pushed: string[] = []) =>
        decideRelease({ eventName: 'push', queue: { prNumbers, total }, pushedCommitMessages: pushed });

    it('releases a push when the queue is empty', () => {
        expect(push([])).toMatchObject({ release: true, waitingOn: [] });
    });

    it('holds a push while another entry is waiting, and names it', () => {
        const d = push([4214, 4217]);
        expect(d).toMatchObject({ release: false, waitingOn: [4214, 4217], unlisted: 0 });
        expect(d.reason).toContain('#4214, #4217');
    });

    it('does not wait on the entries this push is merging', () => {
        const pushed = ['fix(a): one (#4207)', 'docs(b): two (#3325) (#4203)'];
        expect(push([4207, 4203], 2, pushed)).toMatchObject({ release: true, waitingOn: [] });
        expect(push([4207, 4203, 4212], 3, pushed)).toMatchObject({ release: false, waitingOn: [4212] });
    });

    it('counts entries past the page as waiting', () => {
        const d = push([], 3);
        expect(d).toMatchObject({ release: false, waitingOn: [], unlisted: 3 });
        expect(d.reason).toContain('3 more');
    });

    it('releases a push whose queue could not be read', () => {
        expect(
            decideRelease({ eventName: 'push', queue: null, pushedCommitMessages: [] }),
        ).toMatchObject({ release: true });
    });

    it.each(['schedule', 'workflow_dispatch'])('releases a %s run whatever the queue holds', (eventName) => {
        expect(
            decideRelease({ eventName, queue: { prNumbers: [4214], total: 1 }, pushedCommitMessages: [] }),
        ).toMatchObject({ release: true });
    });
});

describe('the entry script', () => {
    let dir: string;
    let server: http.Server;
    let respond: (res: http.ServerResponse) => void;
    let requests: number;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-queue-gate-'));
        requests = 0;
        server = http.createServer((req, res) => {
            requests += 1;
            req.resume();
            req.on('end', () => respond(res));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const queueOf = (numbers: Array<number | null>, total = numbers.length) => (res: http.ServerResponse) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            data: { repository: { mergeQueue: { entries: {
                totalCount: total,
                nodes: numbers.map((n) => ({ pullRequest: n === null ? null : { number: n } })),
            } } } },
        }));
    };

    function run(eventName: string, commits: string[] = []) {
        const out = path.join(dir, 'output');
        const event = path.join(dir, 'event.json');
        fs.writeFileSync(out, '');
        fs.writeFileSync(event, JSON.stringify({ commits: commits.map((message) => ({ message })) }));
        const port = (server.address() as AddressInfo).port;
        // A clean environment: no proxy settings, nothing from the developer's
        // shell, only what Actions would supply.
        const env = {
            PATH: process.env.PATH ?? '',
            NODE_ENV: 'test' as const,
            GITHUB_EVENT_NAME: eventName,
            GITHUB_EVENT_PATH: event,
            GITHUB_REPOSITORY: 'RodnaPamet/inflect-compliance',
            GITHUB_REF_NAME: 'main',
            GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
            GITHUB_OUTPUT: out,
            GH_TOKEN: 'test-token',
        };
        return new Promise<{ code: number | null; stdout: string; output: string }>((resolve) => {
            const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env });
            let stdout = '';
            child.stdout.on('data', (c) => { stdout += c; });
            child.on('close', (code) => resolve({ code, stdout, output: fs.readFileSync(out, 'utf8') }));
        });
    }

    it('holds a push while the queue is building another entry', async () => {
        respond = queueOf([4207, 4214]);
        const r = await run('push', ['fix(a): one (#4207)']);
        expect(r.code).toBe(0);
        expect(r.output).toBe('release=false\n');
        expect(r.stdout).toContain('#4214');
    });

    it('releases the push that empties the queue', async () => {
        respond = queueOf([4207]);
        const r = await run('push', ['fix(a): one (#4207)']);
        expect(r.output).toBe('release=true\n');
    });

    it('releases, and warns, when the queue read fails', async () => {
        respond = (res) => { res.statusCode = 502; res.end('bad gateway'); };
        const r = await run('push');
        expect(r.code).toBe(0);
        expect(r.output).toBe('release=true\n');
        expect(r.stdout).toContain('::warning title=Merge queue unreadable::');
    });

    it('reads an entry it cannot name as unreadable, never as absent', async () => {
        respond = queueOf([null]);
        const r = await run('push');
        expect(r.output).toBe('release=true\n');
        expect(r.stdout).toContain('::warning');
    });

    it('releases a scheduled run without reading the queue', async () => {
        respond = queueOf([4214]);
        const r = await run('schedule');
        expect(r.output).toBe('release=true\n');
        expect(requests).toBe(0);
    });
});

describe('the release workflow', () => {
    interface Step { name?: string; id?: string; if?: string; run?: string }
    const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')) as {
        on: Record<string, unknown>;
        jobs: { release: { steps: Step[] } };
    };
    const steps = wf.jobs.release.steps;
    const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);
    const gate = at((s) => s.id === 'queue-gate');
    const release = at((s) => (s.run ?? '').includes('npx semantic-release'));

    it('runs the gate script immediately before semantic-release', () => {
        expect(gate).toBeGreaterThanOrEqual(0);
        expect(steps[gate].run).toBe('node scripts/release-queue-gate.mjs');
        expect(release).toBe(gate + 1);
    });

    it('skips semantic-release only on an explicit hold', () => {
        expect(steps[release].if).toBe("steps.queue-gate.outputs.release != 'false'");
    });

    it('keeps a daily scheduled run and a manual trigger as the backstop', () => {
        const schedule = wf.on.schedule as Array<{ cron: string }>;
        expect(schedule).toHaveLength(1);
        // minute hour * * * — once a day, every day.
        expect(schedule[0].cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
        expect(wf.on).toHaveProperty('workflow_dispatch');
    });
});
