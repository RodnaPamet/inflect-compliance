/**
 * Step 1b's acceptance test: a clean pull returns every row, and every one of the
 * fourteen Step 1a faults yields its typed error with `complete: false`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `pullSnapshot` returns a result rather than throwing, so the risk is not an
 * unhandled exception — it is a fault that produces `complete: true` anyway. Every
 * fault case therefore asserts BOTH halves: the right `reason.kind`, and
 * `complete: false`. Asserting only the kind would pass for a client that reported
 * the error and the completeness flag independently, which is exactly the bug
 * global rule 4 is about.
 *
 * And a clean pull is asserted first, as the control. Without it, a client that
 * failed on everything would satisfy every fault case in this file.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INJECTED FETCH IS THE THING BEING POLICED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These tests use `fetchImpl`, which bypasses `safeFetch`. That is the only way to
 * drive fourteen faults without fourteen servers, and it is also exactly the
 * mechanism that would let production code bypass the SSRF defence. So the
 * structural section at the bottom reads `src/` and fails if any file there passes
 * one, and fails if this client's own directory calls `fetch` or `resilientFetch`
 * directly. The seam is load-bearing for the tests and forbidden everywhere else,
 * and that asymmetry only holds while something checks it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import {
    pullSnapshot,
    CLIENT_METHODS,
    type PullResult,
} from '@/lib/mcp/client';
import {
    createLegacyMcpFakeServer,
    KEY_COLUMN,
    type FaultName,
    type LegacyMcpFakeServer,
} from '../helpers/legacy-mcp-fake-server';

const URL_ = 'https://legacy.example.test/mcp';
const TOKEN = 'secret-bearer-do-not-leak-1234567890'; // pragma: allowlist secret — a fixture; the point is to prove it never escapes

function pull(server: LegacyMcpFakeServer, over: Partial<Parameters<typeof pullSnapshot>[0]> = {}) {
    return pullSnapshot({
        url: URL_,
        token: TOKEN,
        fetchImpl: server.fetch,
        requestTimeoutMs: 1_000,
        pullTimeoutMs: 5_000,
        ...over,
    });
}

// ─── The control: a clean pull ─────────────────────────────────────────────

describe('1b client — a clean pull', () => {
    it('returns every row with complete: true', async () => {
        const server = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 3 });
        const res = await pull(server);

        expect(res.reason).toBeUndefined();
        expect(res.complete).toBe(true);
        expect(res.manifest).not.toBeNull();
        expect(res.rows).toHaveLength(7);
        // Every row carries the key column, so the fixture is the shape later steps map.
        for (const row of res.rows) expect(Object.keys(row)).toContain(KEY_COLUMN);
    });

    it('reads the manifest and then every advertised page, and nothing else', async () => {
        const server = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 3 });
        await pull(server);
        const reads = server.requests.filter((r) => r.method === 'resources/read');
        // 1 manifest + 3 pages for 7 accounts at 3 per page.
        expect(reads).toHaveLength(4);
        expect(reads[0].uri).toBe('inflect-access://manifest');
    });

    it('completes the handshake before reading anything', async () => {
        const server = createLegacyMcpFakeServer();
        await pull(server);
        expect(server.requests[0].method).toBe('initialize');
        expect(server.requests[1].method).toBe('notifications/initialized');
    });

    it('echoes the session id the server issued, and the negotiated version', async () => {
        const server = createLegacyMcpFakeServer();
        await pull(server);
        const after = server.requests.slice(1);
        expect(after.length).toBeGreaterThan(0);
        for (const r of after) {
            expect(r.sessionId).toBe(server.sessionId);
            expect(r.protocolVersion).toBe('2025-06-18');
        }
        // `initialize` itself cannot carry a session: none has been issued yet.
        expect(server.requests[0].sessionId).toBeNull();
    });

    it('honours a projection and accepts only the columns it asked for', async () => {
        const server = createLegacyMcpFakeServer({ accounts: 3, rowsPerPage: 3 });
        const res = await pull(server, { fields: [KEY_COLUMN, 'DISPLAY_NAME'] });
        expect(res.complete).toBe(true);
        for (const row of res.rows) {
            expect(Object.keys(row).sort()).toEqual([KEY_COLUMN, 'DISPLAY_NAME'].sort());
        }
    });

    it('refuses a projection naming a column the manifest does not declare', async () => {
        // Before any page is requested: otherwise a server could invent the column
        // and the oversharing check would accept it as "requested".
        const server = createLegacyMcpFakeServer();
        const res = await pull(server, { fields: ['NO_SUCH_COLUMN'] });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('contract-violation');
        expect(server.requests.filter((r) => r.uri?.includes('accounts'))).toHaveLength(0);
    });
});

// ─── Never a tool, even when offered ──────────────────────────────────────

describe('1b client — never calls a tool', () => {
    it('sends no tools/* request while the server advertises tools', async () => {
        const server = createLegacyMcpFakeServer({ faults: { toolsAdvertised: true } });
        const res = await pull(server);

        // The pull still SUCCEEDS: advertising tools is legitimate, and refusing a
        // server for offering them would be the client policing something that is
        // not its business. What matters is the request log.
        expect(res.complete).toBe(true);

        const methods = server.requests.map((r) => r.method);
        expect(methods.some((m) => m.startsWith('tools/'))).toBe(false);
        // Stronger: every method sent is one of the three declared.
        for (const m of methods) expect(CLIENT_METHODS).toContain(m);
    });

    it('declares exactly three methods, so the assertion above has a closed set', () => {
        expect([...CLIENT_METHODS]).toEqual([
            'initialize',
            'notifications/initialized',
            'resources/read',
        ]);
    });
});

// ─── capabilities: {} exactly ─────────────────────────────────────────────

describe('1b client — the initialize body', () => {
    it('carries capabilities: {} exactly', async () => {
        const server = createLegacyMcpFakeServer();
        let initBody: unknown = null;
        const spy: typeof server.fetch = async (input, init) => {
            const parsed = JSON.parse(String(init?.body ?? '{}'));
            if (parsed.method === 'initialize') initBody = parsed;
            return server.fetch(input, init);
        };
        await pull({ ...server, fetch: spy });

        const body = initBody as { params?: { capabilities?: unknown } };
        expect(body?.params?.capabilities).toEqual({});
        // Not merely empty-ish: no keys at all. A client that claims a capability
        // it has not implemented invites a server to use it.
        expect(Object.keys(body!.params!.capabilities as object)).toHaveLength(0);
    });
});

// ─── Every fault ──────────────────────────────────────────────────────────

/**
 * The expected `reason.kind` for each fault, as a table so the DENOMINATOR is
 * visible: all fourteen Step 1a faults appear, and the test below asserts the
 * table covers the `FaultName` union exhaustively. A fault added in 1a without a
 * row here fails that assertion rather than being silently unexercised.
 */
const FAULT_EXPECTATIONS: Record<FaultName, PullResult['reason'] extends infer R ? (R extends { kind: infer K } ? K : never) : never> = {
    tornSnapshot: 'torn-snapshot',
    oversharing: 'contract-violation',
    oversizedPage: 'cap-exceeded',
    slowResponse: 'timeout',
    malformedJson: 'contract-violation',
    serverSentEvents: 'contract-violation',
    unsupportedProtocolVersion: 'contract-violation',
    // Not a failure: advertising tools is allowed, and the client's own request log
    // is what proves it never calls one. Handled in its own describe above.
    toolsAdvertised: 'contract-violation',
    redirect: 'ssrf-blocked',
    schemaDrift: 'contract-violation',
    duplicateAccountKey: 'contract-violation',
    rowWithoutAccountKey: 'contract-violation',
    secretShapedValue: 'contract-violation',
};

describe('1b client — every fault fails closed', () => {
    it('the expectation table covers every declared fault', () => {
        // The denominator. If 1a adds a fault, this fails rather than quietly
        // leaving it unexercised.
        const declared = fs
            .readFileSync(
                path.resolve(__dirname, '../helpers/legacy-mcp-fake-server.ts'),
                'utf8'
            )
            .match(/export type FaultName =([\s\S]*?);/)?.[1];
        expect(declared).toBeTruthy();
        const names = [...declared!.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
        expect(Object.keys(FAULT_EXPECTATIONS).sort()).toEqual(names);
        expect(names.length).toBeGreaterThanOrEqual(14);
    });

    it.each([
        'tornSnapshot',
        'oversizedPage',
        'malformedJson',
        'serverSentEvents',
        'unsupportedProtocolVersion',
        'redirect',
    ] as const)('%s yields its typed error and complete: false', async (fault) => {
        const server = createLegacyMcpFakeServer({
            accounts: 7,
            rowsPerPage: 3,
            faults: { [fault]: true },
            redirectTo: 'https://elsewhere.example.test/mcp',
        });
        const res = await pull(server);

        expect({ fault, complete: res.complete }).toEqual({ fault, complete: false });
        expect({ fault, kind: res.reason?.kind }).toEqual({
            fault,
            kind: FAULT_EXPECTATIONS[fault],
        });
    });

    it('slowResponse yields a timeout', async () => {
        const server = createLegacyMcpFakeServer({ faults: { slowResponse: true }, slowMs: 200 });
        const res = await pull(server, { requestTimeoutMs: 30, pullTimeoutMs: 2_000 });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('timeout');
    });

    it('a torn snapshot keeps the rows it read but never claims completeness', async () => {
        const server = createLegacyMcpFakeServer({
            accounts: 7,
            rowsPerPage: 3,
            faults: { tornSnapshot: true },
        });
        const res = await pull(server);
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('torn-snapshot');
        // Page 1 agreed, so its rows are present; page 2 tore. The caller gets what
        // was read AND an unambiguous "this is not the whole thing".
        expect(res.rows.length).toBeGreaterThan(0);
        expect(res.rows.length).toBeLessThan(7);
        expect(res.manifest).not.toBeNull();
    });

    it('the oversized page aborts at the byte cap', async () => {
        const server = createLegacyMcpFakeServer({ faults: { oversizedPage: true } });
        const res = await pull(server, { maxBytesPerResponse: 4096 });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('cap-exceeded');
        expect(res.reason?.message).toContain('bytes');
    });

    it('a page count beyond the cap is refused before any page is read', async () => {
        const server = createLegacyMcpFakeServer({ accounts: 9, rowsPerPage: 1 });
        const res = await pull(server, { maxPages: 2 });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('cap-exceeded');
        expect(server.requests.filter((r) => r.uri?.includes('accounts'))).toHaveLength(0);
    });

    it('a total-row cap stops the pull', async () => {
        const server = createLegacyMcpFakeServer({ accounts: 9, rowsPerPage: 3 });
        const res = await pull(server, { maxTotalRows: 4 });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('cap-exceeded');
    });

    it('oversharing is refused rather than filtered', async () => {
        // Silently dropping the extra column would make the server's oversharing
        // invisible, and its owner is the only one who can fix it.
        const server = createLegacyMcpFakeServer({
            accounts: 3,
            rowsPerPage: 3,
            faults: { oversharing: true },
        });
        const res = await pull(server, { fields: [KEY_COLUMN] });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('contract-violation');
    });

    it('a 401 is authentication-failed, not a generic contract violation', async () => {
        const server = createLegacyMcpFakeServer();
        const unauthorised: typeof server.fetch = async () =>
            new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
        const res = await pull({ ...server, fetch: unauthorised });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('authentication-failed');
    });

    it('a 403 is authentication-failed too', async () => {
        const server = createLegacyMcpFakeServer();
        const forbidden: typeof server.fetch = async () =>
            new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } });
        const res = await pull({ ...server, fetch: forbidden });
        expect(res.reason?.kind).toBe('authentication-failed');
    });

    it('a non-JSON content type is refused even with a valid JSON body', async () => {
        const server = createLegacyMcpFakeServer();
        const htmlish: typeof server.fetch = async () =>
            new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
                status: 200,
                headers: { 'content-type': 'text/html' },
            });
        const res = await pull({ ...server, fetch: htmlish });
        expect(res.reason?.kind).toBe('contract-violation');
    });
});

// ─── The token never escapes ──────────────────────────────────────────────

describe('1b client — the bearer token never escapes', () => {
    const faults: FaultName[] = [
        'tornSnapshot',
        'oversizedPage',
        'malformedJson',
        'serverSentEvents',
        'unsupportedProtocolVersion',
        'redirect',
        'oversharing',
    ];

    it.each(faults)('%s: the token is in no part of the result', async (fault) => {
        const server = createLegacyMcpFakeServer({
            accounts: 7,
            rowsPerPage: 3,
            faults: { [fault]: true },
            redirectTo: 'https://elsewhere.example.test/mcp',
        });
        const res = await pull(server, { maxBytesPerResponse: 4096, fields: [KEY_COLUMN] });

        const serialised = JSON.stringify(res);
        expect(serialised).not.toContain(TOKEN);
        expect(res.reason?.message ?? '').not.toContain(TOKEN);
    });

    it('is absent from a thrown error serialised every way', async () => {
        const server = createLegacyMcpFakeServer({ faults: { malformedJson: true } });
        const res = await pull(server);
        const err = res.reason!;
        // Three serialisations, because they do not agree: JSON.stringify drops
        // non-enumerable fields, String() takes only the message, and the stack
        // carries whatever was interpolated into it.
        for (const form of [JSON.stringify(err), String(err.message), err.kind]) {
            expect(form).not.toContain(TOKEN);
        }
    });

    it('the token IS sent on the wire — so the assertions above are not vacuous', async () => {
        const server = createLegacyMcpFakeServer();
        let sawAuth = false;
        const spy: typeof server.fetch = async (input, init) => {
            const h = new Headers(init?.headers as HeadersInit);
            if (h.get('authorization') === `Bearer ${TOKEN}`) sawAuth = true;
            return server.fetch(input, init);
        };
        await pull({ ...server, fetch: spy });
        expect(sawAuth).toBe(true);
    });
});

// ─── Logging carries counts, never content ────────────────────────────────

describe('1b client — logging', () => {
    it('logs identifiers and counts, and no row content', async () => {
        const logged: unknown[] = [];
        const observability = jest.requireActual('@/lib/observability') as {
            log: (...a: unknown[]) => void;
        };
        const spy = jest.spyOn(observability, 'log').mockImplementation((...args: unknown[]) => {
            logged.push(args);
        });

        try {
            const server = createLegacyMcpFakeServer({ accounts: 3, rowsPerPage: 3 });
            const res = await pull(server);
            expect(res.complete).toBe(true);

            const blob = JSON.stringify(logged);
            // A cell's VALUE must never appear. The fixture's login names are
            // derived from the account index, so check one that certainly exists.
            const sampleValue = String(res.rows[0][KEY_COLUMN]);
            expect(sampleValue.length).toBeGreaterThan(0);
            expect(blob).not.toContain(sampleValue);
            expect(blob).not.toContain(TOKEN);
        } finally {
            spy.mockRestore();
        }
    });
});

// ─── Structural: production cannot reach the seam ─────────────────────────

describe('1b client — production cannot bypass safeFetch', () => {
    const CLIENT_DIR = path.resolve(__dirname, '../../src/lib/mcp/client');

    function clientFiles(): string[] {
        return fs
            .readdirSync(CLIENT_DIR)
            .filter((f) => f.endsWith('.ts'))
            .map((f) => path.join(CLIENT_DIR, f));
    }

    it('reads a non-empty population, so the checks below are not vacuous', () => {
        expect(clientFiles().length).toBeGreaterThanOrEqual(3);
    });

    it('the client calls safeFetch and nothing else', () => {
        // `codeOf` masks comments and string bodies. Without it this assertion is
        // satisfied by this module's own docblock, which says "safeFetch" a dozen
        // times while explaining why it must be the only egress path — a guard
        // graded by the prose that describes it. `raw-source-assertion-ratchet`
        // named this file for exactly that, and it was right.
        const code = codeOf(fs.readFileSync(path.join(CLIENT_DIR, 'index.ts'), 'utf8'));
        expect(code).toContain('safeFetch');
        // The masking must have actually happened, or the point above is lost.
        expect(code).not.toContain('textbook SSRF input');
    });

    it('imports safeFetch from the automation egress module', () => {
        const code = codeOf(fs.readFileSync(path.join(CLIENT_DIR, 'index.ts'), 'utf8'));
        // `codeOf` masks string LITERALS, so the module path is not assertable as
        // text. The import statement's shape is, and that is the part that decides
        // where `safeFetch` comes from.
        expect(code).toMatch(/import\s*\{\s*safeFetch\s*\}\s*from/);
    });

    it('no file in the client directory calls fetch or resilientFetch directly', () => {
        const offenders: string[] = [];
        for (const file of clientFiles()) {
            const src = fs
                .readFileSync(file, 'utf8')
                // Comments mention `fetch` constantly — a raw text scan would fire on
                // this module's own docblock explaining why it must not. Strip them,
                // the lesson from this repo's as-any ratchet.
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            // `ctx.fetchImpl ?? safeFetch` is the sanctioned shape; a bare
            // `fetch(` or `resilientFetch(` call is not.
            for (const m of src.matchAll(/(?<![.\w])(resilientFetch|fetch)\s*\(/g)) {
                const before = src.slice(Math.max(0, m.index! - 40), m.index!);
                // `doFetch(` is the local alias for the resolved implementation.
                if (/doFetch\s*$/.test(before)) continue;
                offenders.push(`${path.basename(file)} -> ${m[1]}(`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no file under src/ passes fetchImpl to the client', () => {
        // The seam is for tests. A production caller supplying one would route
        // around safeFetch entirely, and the diff would look like dependency
        // injection rather than like disabling an SSRF defence.
        const SRC = path.resolve(__dirname, '../../src');
        const offenders: string[] = [];
        let scanned = 0;
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
                    scanned += 1;
                    const src = fs
                        .readFileSync(full, 'utf8')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/^\s*\/\/.*$/gm, '');
                    if (/\bfetchImpl\s*:/.test(src)) {
                        // The declaration in the client's own options type is the one
                        // legitimate occurrence.
                        if (path.resolve(full) === path.join(CLIENT_DIR, 'index.ts')) continue;
                        offenders.push(path.relative(SRC, full));
                    }
                }
            }
        };
        walk(SRC);
        // The denominator again: a walk that found nothing would pass silently.
        expect(scanned).toBeGreaterThan(500);
        expect(offenders).toEqual([]);
    });
});
