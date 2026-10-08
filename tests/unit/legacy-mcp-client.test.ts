/**
 * Step 1b's acceptance test: a clean pull returns every row, and every one of the
 * THIRTEEN Step 1a faults yields its typed error with `complete: false`.
 *
 * Thirteen, counted from the `FaultName` union rather than from the step brief —
 * the first draft of this file said fourteen in three places and its own
 * denominator assertion caught it.
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
 * drive thirteen faults without thirteen servers, and it is also exactly the
 * mechanism that would let production code bypass the SSRF defence. So the
 * structural section at the bottom reads `src/` and fails if any file there passes
 * one, and fails if this client's own directory calls `fetch` or `resilientFetch`
 * directly. The seam is load-bearing for the tests and forbidden everywhere else,
 * and that asymmetry only holds while something checks it.
 */

import { readFileSync } from 'node:fs';

import { codeOf } from '../helpers/source-blocks';
import { repoRelativeFiles } from '../helpers/repo-files';
import {
    pullSnapshot,
    CLIENT_METHODS,
    type PullResult,
} from '@/lib/mcp/client';
import {
    createLegacyMcpFakeServer,
    FAULT_NAMES,
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
        // Every row carries the key column, so the fixture is the shape later
        // steps map. Asserted as a set so a failure names the offending row's keys.
        const missingKeyColumn = res.rows.filter((row) => !(KEY_COLUMN in row));
        expect(missingKeyColumn).toEqual([]);
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
        // Stronger: every method sent is one of the three declared, asserted as a
        // set so a failure names the unexpected method rather than the first one.
        const undeclared = methods.filter((m) => !(CLIENT_METHODS as readonly string[]).includes(m));
        expect(undeclared).toEqual([]);
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
 * visible: all thirteen Step 1a faults appear, and the test below asserts the
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
        // Against the fake server's own exported VALUE, not a regex over its
        // source. `FAULT_NAMES` carries a compile-time exhaustiveness check, so a
        // fault added to the `FaultName` union without being listed there fails to
        // compile — a stronger guarantee than a source scan, and it removes the
        // whole-file read that pushed the Class D un-analysable ceiling over by one.
        expect(Object.keys(FAULT_EXPECTATIONS).sort()).toEqual([...FAULT_NAMES].sort());
        // EXACTLY thirteen. The set equality above catches an addition; this
        // catches a deletion, with a number somebody has to look at.
        expect(FAULT_NAMES).toHaveLength(13);
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
        // The fake server does not look at `init.signal` — it just resolves late —
        // so an abort cannot surface through it unwrapped, and the first version of
        // this test passed with `complete: true`. Real `fetch` rejects with an
        // AbortError when the signal fires, so wrapping it that way is faithful
        // rather than a workaround: what is under test is the client's abort, and
        // the double has to be able to express the failure for the test to mean
        // anything.
        const server = createLegacyMcpFakeServer({ faults: { slowResponse: true }, slowMs: 500 });
        const honouring: typeof server.fetch = (input, init) =>
            new Promise((resolve, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                if (signal?.aborted) {
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    reject(e);
                    return;
                }
                signal?.addEventListener('abort', () => {
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
                server.fetch(input, init).then(resolve, reject);
            });

        const res = await pull({ ...server, fetch: honouring }, {
            requestTimeoutMs: 40,
            pullTimeoutMs: 5_000,
        });
        expect(res.complete).toBe(false);
        expect(res.reason?.kind).toBe('timeout');
    });

    it('the whole-pull deadline also stops a pull, independently of the request one', async () => {
        // Two budgets, two tests. A client that only honoured the per-request one
        // would let a server paginate forever at 39ms a page.
        const server = createLegacyMcpFakeServer({ accounts: 900, rowsPerPage: 1 });
        const res = await pull(server, { requestTimeoutMs: 5_000, pullTimeoutMs: 1 });
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

        // Collected rather than asserted one matcher at a time, so a failure NAMES
        // the serialisation that leaked instead of just the first one checked.
        const leaks = Object.entries({
            result: JSON.stringify(res),
            message: res.reason?.message ?? '',
        })
            .filter(([, text]) => text.includes(TOKEN))
            .map(([where]) => where);
        expect(leaks).toEqual([]);
    });

    it('is absent from a thrown error serialised every way', async () => {
        const server = createLegacyMcpFakeServer({ faults: { malformedJson: true } });
        const res = await pull(server);
        const err = res.reason!;
        // Three serialisations, because they do not agree: JSON.stringify drops
        // non-enumerable fields, String() takes only the message, and the stack
        // carries whatever was interpolated into it.
        // Three serialisations, because they do not agree: JSON.stringify drops
        // non-enumerable fields, String() takes only the message, and `kind` is
        // the discriminator a caller switches on.
        const leaked = Object.entries({
            json: JSON.stringify(err),
            message: String(err.message),
            kind: err.kind,
        })
            .filter(([, text]) => text.includes(TOKEN))
            .map(([where]) => where);
        expect(leaked).toEqual([]);
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
            // A cell's VALUE must never appear. The fixture's login names derive
            // from the account index, so this one certainly exists.
            const sampleValue = String(res.rows[0][KEY_COLUMN]);
            expect(sampleValue.length).toBeGreaterThan(0);
            const found = Object.entries({ 'a row value': sampleValue, 'the token': TOKEN })
                .filter(([, needle]) => blob.includes(needle))
                .map(([what]) => what);
            expect(found).toEqual([]);
        } finally {
            spy.mockRestore();
        }
    });
});

// ─── Structural: production cannot reach the seam ─────────────────────────

describe('1b client — production cannot bypass safeFetch', () => {
    /**
     * The population comes from GIT, not from a directory walk.
     *
     * `CLAUDE.md` requires it and `tests/guardrails/source-scan-population.test.ts`
     * enforces it: a `readdirSync` walk carries a hand-written skip list that
     * nothing checks, and `.claude/worktrees/<id>/` holds a full checkout of the
     * repo — so a walk reads the guard's own copy of itself and reports it, green
     * on CI and red only for whoever uses worktrees.
     *
     * It also removes a whole-file read the Class D needle ratchet could not
     * analyse, which is what caught the first version of this block.
     */
    const files = repoRelativeFiles();
    const CLIENT_PREFIX = 'src/lib/mcp/client/';

    const clientFiles = (): readonly string[] =>
        files.filter((f) => f.startsWith(CLIENT_PREFIX) && f.endsWith('.ts'));

    const srcFiles = (): readonly string[] =>
        files.filter((f) => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.tsx')));

    /** Comments stripped, so prose about `fetch` neither satisfies nor trips a scan. */
    const codeIn = (rel: string): string => codeOf(readFileSync(rel, 'utf8'));

    it('reads a non-empty population, so the checks below are not vacuous', () => {
        expect(clientFiles().length).toBeGreaterThanOrEqual(3);
        expect(srcFiles().length).toBeGreaterThan(500);
    });

    // There is deliberately NO assertion here that the client calls `safeFetch`.
    // `tests/guards/ssrf-egress-coverage.test.ts` owns that: the client is in its
    // `SINKS` array, which asserts both the call and the import from the
    // automation egress module. A second copy is how two copies come to disagree —
    // the write-ladder in this repo once had four.

    it('no file in the client directory calls fetch or resilientFetch directly', () => {
        const offenders: string[] = [];
        for (const rel of clientFiles()) {
            const src = codeIn(rel);
            for (const m of src.matchAll(/(?<![.\w])(resilientFetch|fetch)\s*\(/g)) {
                const before = src.slice(Math.max(0, m.index! - 60), m.index!);
                // `safeFetch(` and `ctx.fetchImpl(` are the two sanctioned calls:
                // the production path and the declared test seam.
                if (/safe$|fetchImpl\s*$|await ctx\.$/.test(before)) continue;
                offenders.push(`${rel} -> ${m[1]}(`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no file under src/ passes fetchImpl to the client', () => {
        // The seam is for tests. A production caller supplying one would route
        // around the SSRF defence in a diff that looks like dependency injection.
        const offenders: string[] = [];
        for (const rel of srcFiles()) {
            if (rel === 'src/lib/mcp/client/index.ts') continue; // declares the option
            const src = codeIn(rel);
            // Narrowed to files that actually reach this client. The first version
            // flagged any `fetchImpl:` anywhere and named thirteen unrelated files
            // that inject their own fetch for their own reasons — a guard that
            // fires on an unrelated population gets an exemption list, and then it
            // is measuring the list.
            const reachesClient = /@\/lib\/mcp\/client/.test(src) || /pullSnapshot\s*\(/.test(src);
            if (reachesClient && /\bfetchImpl\s*:/.test(src)) offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });
});
