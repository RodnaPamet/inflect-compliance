/**
 * The garak nightly's three scripts, driven through their real CLIs (spawn +
 * exit code + files), because that is what the workflow consumes:
 *
 *   .garak/target-proxy.mjs  the WIRE CAP: no more than N requests reach the
 *                            app whatever garak asks for; a 429 (no model call)
 *                            is not charged; a guard refusal becomes a scored
 *                            "no hit" instead of a lost attempt; the session
 *                            cookie goes upstream and never back to garak.
 *   .garak/summarise.mjs     the RECORD: hit rates recomputed from raw rows,
 *                            zero evaluations is never complete, a capped run is
 *                            incomplete, an allowlisted hit is reported, not
 *                            subtracted.
 *   .garak/spend.mjs         the measured breaker between roles.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PROXY = path.join(ROOT, '.garak/target-proxy.mjs');
const SUMMARISE = path.join(ROOT, '.garak/summarise.mjs');
const SPEND = path.join(ROOT, '.garak/spend.mjs');
const COOKIE = 'next-auth.session-token=test-cookie-value';

let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garak-'));
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('target proxy', () => {
    let upstream: http.Server;
    let upstreamHits: Array<{ question: string; cookie: string | undefined }>;
    let proxy: ChildProcess | undefined;
    let proxyPort: number;
    let ledgerPath: string;

    async function startProxy(maxRequests: number): Promise<void> {
        ledgerPath = path.join(tmp, `ledger-${Date.now()}.json`);
        proxyPort = 32000 + Math.floor(Math.random() * 20000);
        const { port } = upstream.address() as AddressInfo;
        const child = spawn(process.execPath, [PROXY], {
            env: {
                ...process.env,
                GARAK_TARGET_URL: `http://127.0.0.1:${port}/api/t/acme-corp/assistant/ask`,
                GARAK_SESSION_COOKIE: COOKIE,
                GARAK_MAX_REQUESTS: String(maxRequests),
                GARAK_PROXY_PORT: String(proxyPort),
                GARAK_LEDGER: ledgerPath,
            },
        });
        proxy = child;
        await new Promise<void>((resolve, reject) => {
            child.stdout?.on('data', (d: Buffer) => d.toString().includes('listening') && resolve());
            child.stderr?.on('data', (d: Buffer) => reject(new Error(`proxy: ${d.toString()}`)));
            child.on('exit', (code) => reject(new Error(`proxy exited ${code}`)));
        });
    }

    async function ask(question: string): Promise<{ status: number; body: string }> {
        const res = await fetch(`http://127.0.0.1:${proxyPort}/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
        });
        return { status: res.status, body: await res.text() };
    }

    const ledger = () => JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));

    beforeEach(async () => {
        upstreamHits = [];
        upstream = http.createServer((req, res) => {
            let data = '';
            req.on('data', (c) => (data += c));
            req.on('end', () => {
                const { question } = JSON.parse(data);
                upstreamHits.push({ question, cookie: req.headers.cookie });
                const send = (status: number, obj: unknown) => {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(obj));
                };
                if (question === 'rate') return send(429, { error: { message: 'rate limited' } });
                if (question === 'in')
                    return send(403, { error: { message: 'ai_guard_review_required: input malicious [inj-1]' } });
                if (question === 'out')
                    return send(403, { error: { message: 'ai_guard_blocked: egress secret [eg-2]' } });
                return send(200, { kind: 'answer', message: `answer to ${question}` });
            });
        });
        await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    });

    afterEach(async () => {
        const child = proxy;
        proxy = undefined;
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>((r) => child.once('exit', () => r()));
            child.kill();
            await exited;
        }
        await new Promise<void>((r) => upstream.close(() => r()));
    });

    it('forwards at most the cap; past it nothing reaches the app and the ledger counts it', async () => {
        await startProxy(3);
        for (const q of ['a', 'b', 'c', 'd', 'e']) await ask(q);
        expect(upstreamHits.map((h) => h.question)).toEqual(['a', 'b', 'c']);
        const capped = await ask('f');
        expect(JSON.parse(capped.body).message).toMatch(/request cap reached, not forwarded/);
        expect(ledger()).toMatchObject({ maxRequests: 3, forwarded: 3, answers: 3, overCap: 3 });
    });

    it('a 429 made no model call, so it is passed back and NOT charged against the cap', async () => {
        await startProxy(2);
        const rl = await ask('rate');
        expect(rl.status).toBe(429);
        await ask('a');
        await ask('b');
        expect(upstreamHits.map((h) => h.question)).toEqual(['rate', 'a', 'b']);
        expect(ledger()).toMatchObject({ forwarded: 2, rateLimited: 1, overCap: 0 });
    });

    it('a guard refusal is an answer garak can score, counted by direction', async () => {
        await startProxy(5);
        const input = await ask('in');
        const egress = await ask('out');
        expect(input.status).toBe(200);
        expect(JSON.parse(input.body).message).toBe('[refused by the content guard: input]');
        expect(JSON.parse(egress.body).message).toBe('[refused by the content guard: output]');
        expect(ledger()).toMatchObject({ forwarded: 2, guardRefusedInput: 1, guardRefusedOutput: 1 });
    });

    it('the session cookie goes upstream and never back to garak', async () => {
        await startProxy(1);
        const res = await ask('a');
        expect(upstreamHits[0].cookie).toBe(COOKIE);
        expect(res.body).not.toContain('test-cookie-value');
        expect(JSON.stringify(ledger()).includes('test-cookie-value')).toBe(false);
    });

    it('refuses to start without a positive cap', () => {
        const r = spawnSync(process.execPath, [PROXY], {
            env: { ...process.env, GARAK_TARGET_URL: 'http://127.0.0.1:1/', GARAK_SESSION_COOKIE: COOKIE, GARAK_MAX_REQUESTS: '0' },
            encoding: 'utf-8',
        });
        expect(r.status).toBe(2);
    });
});

describe('night record', () => {
    const fullLedger = {
        maxRequests: 50, forwarded: 10, answers: 8, guardRefusedInput: 1,
        guardRefusedOutput: 1, rateLimited: 0, upstreamErrors: 0, overCap: 0,
    };
    const report = [
        JSON.stringify({ entry_type: 'init', garak_version: '0.17.1' }),
        JSON.stringify({ entry_type: 'attempt', status: 2, prompt: 'ignored' }),
        JSON.stringify({ entry_type: 'eval', probe: 'dan.DanInTheWild', detector: 'dan.DAN', passed: 4, total: 5 }),
        JSON.stringify({ entry_type: 'eval', probe: 'dan.DanInTheWild', detector: 'mitigation.MitigationBypass', passed: 5, total: 5 }),
        JSON.stringify({ entry_type: 'eval', probe: 'xss.MarkdownImageExfil', detector: 'xss.MarkdownExfilBasic', passed: 3, total_evaluated: 5 }),
    ].join('\n');

    function summarise(reportText: string | null, ledgerObj: object, allowlist = '') {
        const reportPath = path.join(tmp, `r-${Math.random()}.jsonl`);
        if (reportText !== null) fs.writeFileSync(reportPath, reportText);
        const ledgerPath = path.join(tmp, `l-${Math.random()}.json`);
        fs.writeFileSync(ledgerPath, JSON.stringify(ledgerObj));
        const allowPath = path.join(tmp, `a-${Math.random()}.tsv`);
        fs.writeFileSync(allowPath, allowlist);
        const r = spawnSync(process.execPath, [SUMMARISE, reportPath, ledgerPath, allowPath, 'owner'], { encoding: 'utf-8' });
        expect(r.status).toBe(0);
        return JSON.parse(r.stdout);
    }

    it('family hit rates are recomputed from the raw rows', () => {
        const rec = summarise(report, fullLedger);
        expect(rec).toMatchObject({ schema: 'inflect-garak-night/1', garakVersion: '0.17.1', complete: true });
        expect(rec.raw).toHaveLength(3);
        expect(rec.families.dan).toEqual({ evaluated: 10, hits: 1, hitRate: 0.1 });
        expect(rec.families.xss).toEqual({ evaluated: 5, hits: 2, hitRate: 0.4 });
    });

    it('zero evaluations is never a complete night, even with a missing report', () => {
        const rec = summarise(null, fullLedger);
        expect(rec.complete).toBe(false);
        expect(rec.incompleteReasons).toContain('NO_EVALUATIONS');
        expect(rec.families).toEqual({});
    });

    it('a run the wire cap truncated is incomplete', () => {
        const rec = summarise(report, { ...fullLedger, overCap: 4 });
        expect(rec).toMatchObject({ complete: false, incompleteReasons: ['REQUEST_CAP_REACHED'] });
    });

    it('an allowlisted probe is reported with its hits, never subtracted from its family', () => {
        const rec = summarise(report, fullLedger, '# header\nxss.MarkdownImageExfil\tIGNORE\taccepted for the test\n');
        expect(rec.allowlisted).toEqual([
            { probe: 'xss.MarkdownImageExfil', action: 'IGNORE', reason: 'accepted for the test', hits: 2 },
        ]);
        expect(rec.families.xss.hits).toBe(2);
    });
});

describe('measured spend breaker', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [SPEND, ...args], { encoding: 'utf-8' });

    it('prices tokens at the budgeted model rate', () => {
        expect(run('usd', '1000000', '200000').stdout.trim()).toBe('2.0000');
    });

    it('lets a role start only while spent plus a full planned role stays within the cap', () => {
        expect(run('may-continue', '0', '0').status).toBe(0);
        expect(run('may-continue', '3000000', '0').status).toBe(0);
        expect(run('may-continue', '3600000', '0').status).toBe(1);
        // A withheld (egress-refused) turn is charged at the planned cost.
        expect(run('may-continue', '3000000', '0', '20').status).toBe(1);
    });
});
