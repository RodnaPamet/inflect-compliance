/**
 * The scanner's egress proxy and the proof each scan takes of it (#5004 part C).
 *
 *   1. THE ALLOWLIST is exact hostnames; anything else refuses to start.
 *   2. THE DECISION: a CONNECT to an allowlisted host on 443 and nothing else.
 *   3. A REAL PROXY, over a loopback socket: the tunnel carries bytes for an
 *      allowed host; every other request is refused before any byte leaves.
 *   4. THE PROOF: met only when the scanner's fetch is pointed at the proxy,
 *      the proxy admits the Inflect host, refuses the canary, and there is no
 *      way around it — and the production probe reads the real proxy's answers.
 */
import { createServer as createTcpServer, connect, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import type { Server } from 'node:http';

import {
    createEgressProxy,
    decideConnect,
    parseEgressAllowlist,
} from '../../../packages/agent-harness-scanner/src/egress-proxy';
import { nodeEgressProbe, proveEgress, type EgressProbe } from '../../../packages/agent-harness-scanner/src/egress-proof';
import type { ScannerLog } from '../../../packages/agent-harness-scanner/src/log';

const quiet: ScannerLog = { info: () => {}, warn: () => {}, error: () => {} };
const ALLOW = new Set(['app.inflect.bg', 'graph.microsoft.com']);

describe('1. the allowlist', () => {
    it('is exact, lower-cased hostnames', () => {
        expect([...parseEgressAllowlist(' App.Inflect.bg , graph.microsoft.com,, ')]).toEqual(['app.inflect.bg', 'graph.microsoft.com']);
    });

    it('missing or empty refuses everything rather than failing open', () => {
        expect(parseEgressAllowlist(undefined).size).toBe(0);
        expect(parseEgressAllowlist('').size).toBe(0);
    });

    it.each(['*.inflect.bg', 'https://app.inflect.bg', 'app.inflect.bg:443', '10.0.0.1', 'localhost', 'a b.example'])(
        'refuses to start on %s',
        (entry) => {
            expect(() => parseEgressAllowlist(entry)).toThrow('not a hostname');
        },
    );
});

describe('2. the decision', () => {
    it('admits an allowlisted host on 443, case-insensitively', () => {
        expect(decideConnect('APP.inflect.bg:443', ALLOW)).toEqual({ allowed: true, host: 'app.inflect.bg', port: 443 });
    });

    it.each([
        ['another host', 'example.com:443', 403, 'HOST_NOT_ALLOWED'],
        ['a suffix of an allowed host', 'evil.app.inflect.bg:443', 403, 'HOST_NOT_ALLOWED'],
        ['another port', 'app.inflect.bg:80', 403, 'PORT_NOT_ALLOWED'],
        ['an IP literal', '1.1.1.1:443', 403, 'IP_LITERAL'],
        ['no port', 'app.inflect.bg', 400, 'MALFORMED_TARGET'],
        ['userinfo', 'u@app.inflect.bg:443', 400, 'MALFORMED_TARGET'],
        ['nothing', undefined, 400, 'MALFORMED_TARGET'],
    ])('refuses %s', (_label, target, status, reason) => {
        expect(decideConnect(target, ALLOW)).toMatchObject({ allowed: false, status, reason });
    });
});

/** A loopback "internet": an echo server every allowed dial lands on. */
async function harness(allow: ReadonlySet<string>) {
    const dialled: string[] = [];
    const echo: TcpServer = createTcpServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = (echo.address() as AddressInfo).port;
    const proxy: Server = createEgressProxy({
        allow,
        log: quiet,
        dial: (host, port) => {
            dialled.push(`${host}:${port}`);
            return connect({ host: '127.0.0.1', port: echoPort });
        },
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as AddressInfo).port;
    const close = async () => {
        await new Promise((r) => proxy.close(r));
        await new Promise((r) => echo.close(r));
    };
    return { proxyPort, echoPort, dialled, close };
}

/** Send raw bytes to the proxy and read until it closes or `until` matches. */
function exchange(port: number, bytes: string, until?: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
        const s: Socket = connect({ host: '127.0.0.1', port });
        let got = '';
        s.on('data', (d) => {
            got += d.toString('latin1');
            if (until && until.test(got)) {
                s.destroy();
                resolve(got);
            }
        });
        s.on('end', () => resolve(got));
        s.on('close', () => resolve(got));
        s.on('error', reject);
        s.write(bytes);
    });
}

describe('3. a real proxy', () => {
    let h: Awaited<ReturnType<typeof harness>>;
    beforeEach(async () => {
        h = await harness(ALLOW);
    });
    afterEach(async () => {
        await h.close();
    });

    it('opens a tunnel to an allowed host and carries bytes both ways', async () => {
        const got = await exchange(
            h.proxyPort,
            'CONNECT app.inflect.bg:443 HTTP/1.1\r\nHost: app.inflect.bg:443\r\n\r\nping',
            /ping$/,
        );
        expect(got).toBe('HTTP/1.1 200 Connection Established\r\n\r\nping');
        expect(h.dialled).toEqual(['app.inflect.bg:443']);
    });

    it('refuses another host with 403, and dials nothing', async () => {
        const got = await exchange(h.proxyPort, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
        expect(got).toMatch(/^HTTP\/1\.1 403 /);
        expect(h.dialled).toEqual([]);
    });

    it('refuses plain HTTP with 405 — absolute-form or not — and dials nothing', async () => {
        for (const line of ['GET http://app.inflect.bg/ HTTP/1.1', 'GET / HTTP/1.1']) {
            const got = await exchange(h.proxyPort, `${line}\r\nHost: app.inflect.bg\r\nConnection: close\r\n\r\n`);
            expect(got).toMatch(/^HTTP\/1\.1 405 /);
        }
        expect(h.dialled).toEqual([]);
    });

    it('an empty allowlist refuses even the Inflect host', async () => {
        const closed = await harness(new Set());
        try {
            const got = await exchange(closed.proxyPort, 'CONNECT app.inflect.bg:443 HTTP/1.1\r\nHost: app.inflect.bg:443\r\n\r\n');
            expect(got).toMatch(/^HTTP\/1\.1 403 /);
            expect(closed.dialled).toEqual([]);
        } finally {
            await closed.close();
        }
    });

    it('the production probe reads the real answers: 200 for an allowed host, 403 for the canary', async () => {
        const proxy = new URL(`http://127.0.0.1:${h.proxyPort}`);
        expect(await nodeEgressProbe.connectThrough(proxy, 'app.inflect.bg:443', 2_000)).toBe(200);
        expect(await nodeEgressProbe.connectThrough(proxy, 'example.com:443', 2_000)).toBe(403);
    });

    it('the production probe tells an open port from a closed one', async () => {
        expect(await nodeEgressProbe.dialDirect('127.0.0.1', h.echoPort, 2_000)).toBe(true);
        const free = createTcpServer();
        await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
        const port = (free.address() as AddressInfo).port;
        await new Promise((r) => free.close(r));
        expect(await nodeEgressProbe.dialDirect('127.0.0.1', port, 2_000)).toBe(false);
    });
});

describe('4. the proof', () => {
    const PROXY = 'http://harness-egress:3128';
    const env = { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1' };
    const probe = (over: Partial<{ allowed: number; canary: number; direct: boolean }> = {}): EgressProbe => ({
        connectThrough: async (_p, target) => (target.startsWith('app.inflect.bg') ? (over.allowed ?? 200) : (over.canary ?? 403)),
        dialDirect: async () => over.direct ?? false,
    });
    const prove = (p: EgressProbe, e: Record<string, string> = env) =>
        proveEgress({ proxyUrl: PROXY, allowedHost: 'app.inflect.bg', canaryHost: 'example.com', env: e, probe: p });

    it('is met when all four hold, and says what it observed', async () => {
        expect(await prove(probe())).toEqual({
            met: true,
            failed: null,
            evidence: 'egress:proxy=harness-egress:3128;allowed=app.inflect.bg;canary=example.com:refused;direct=blocked',
        });
    });

    it.each([
        ['the scanner is not pointed at the proxy', probe(), { NODE_USE_ENV_PROXY: '1' }, 'ENV_PROXY_NOT_SET'],
        ['Node is not told to honour it', probe(), { HTTPS_PROXY: PROXY }, 'ENV_PROXY_NOT_SET'],
        ['the proxy refuses the Inflect host', probe({ allowed: 403 }), env, 'ALLOWED_HOST_REFUSED'],
        ['the proxy is unreachable', probe({ allowed: 0 }), env, 'ALLOWED_HOST_REFUSED'],
        ['the proxy admits the canary', probe({ canary: 200 }), env, 'CANARY_NOT_REFUSED'],
        ['the proxy fails rather than refusing the canary', probe({ canary: 502 }), env, 'CANARY_NOT_REFUSED'],
        ['the scanner can go around it', probe({ direct: true }), env, 'DIRECT_EGRESS_OPEN'],
    ])('is not met when %s', async (_label, p, e, failed) => {
        const proof = await prove(p, e);
        expect(proof).toMatchObject({ met: false, failed });
        expect(proof.evidence).toContain(`failed=${failed}`);
    });
});
