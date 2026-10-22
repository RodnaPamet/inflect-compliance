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
    profileFirstPage,
    CLIENT_METHODS,
    mapEgressError,
    ContractViolationError,
    SsrfBlockedError,
    TimeoutError,
    CapExceededError,
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
type FaultKind = PullResult['reason'] extends infer R ? (R extends { kind: infer K } ? K : never) : never;

/**
 * `null` means the fault does NOT fail the pull.
 *
 * Widened from a bare kind when oversharing stopped being a refusal (#3319): the
 * transport now strips unrequested columns and names them in
 * `PullResult.overshared`, leaving fatality to the caller, which is the only
 * party that knows the never-request denylist. The table keeps the entry so the
 * exhaustiveness check below still covers the whole `FaultName` union — a fault
 * that becomes non-fatal must stay visible here, not quietly leave the list.
 */
const FAULT_EXPECTATIONS: Record<FaultName, FaultKind | null> = {
    tornSnapshot: 'torn-snapshot',
    // NOT a failure since #3319 — stripped and reported instead. See the
    // dedicated test below, which asserts the strip and the report.
    oversharing: null,
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
    // ── ADDED WITH THE FAULTS THEMSELVES (#3617) ──────────────────────────
    //
    // Five malformations the fake server could not previously produce, each
    // reaching a branch of the manifest/page validation chain that no test
    // could drive. Measured on both entry points before being written here.
    unsupportedContract: 'contract-violation',
    unparseablePageUri: 'contract-violation',
    nonSequentialPages: 'contract-violation',
    pageNumberMismatch: 'contract-violation',
    // The one that is NOT a contract violation: a page whose snapshot id
    // disagrees with the manifest is a TEAR, and it is reported as one.
    pageOneSnapshotMismatch: 'torn-snapshot',
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
        expect(FAULT_NAMES).toHaveLength(18);
    });

    it.each([
        'tornSnapshot',
        'oversizedPage',
        'malformedJson',
        'serverSentEvents',
        'unsupportedProtocolVersion',
        'redirect',
        // The five added with the faults themselves (#3617). Each one drives a
        // branch of the manifest/page validation chain that nothing could reach
        // before: a contract version this client does not implement, a page URI
        // it cannot parse, a page list that does not start at 1, a page body
        // reporting the wrong number, and a page 1 whose snapshot id disagrees
        // with the manifest it came from.
        'unsupportedContract',
        'unparseablePageUri',
        'nonSequentialPages',
        'pageNumberMismatch',
        'pageOneSnapshotMismatch',
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

    /**
     * THE PRODUCTION PATH, with no `fetchImpl` — which is the point.
     *
     * Every other test in this file injects the fake server through the declared
     * test seam, so none of them exercises `safeFetch`. The criterion is that the
     * CLIENT surfaces a refused destination as a typed error, and the only
     * destination case above is `redirect`, which reaches the rule from the
     * opposite direction — an allowed host answering with a hostile `Location`.
     * The scheme and the address families were proven in
     * `tests/guards/egress-allowlist.test.ts`, about `safeFetch` rather than about
     * this client, so nothing proved the composition.
     *
     * THE KIND ALONE PROVES NOTHING, and that is why the control below exists.
     * `mapEgressError` ends in a catch-all that maps ANY unrecognised egress
     * failure to `ssrf-blocked`, so a sandbox with no network satisfies a
     * kind-only assertion even with the address rules deleted. The discriminating
     * signal is the REASON: a policy refusal says `address is not public`, and a
     * mere failure says `egress failed`. The address cases assert the former,
     * which the control does not satisfy.
     *
     * NO SOCKET IS OPENED for the address cases — each is refused on inspection
     * before connect, measured at 0-2 ms. A hostname that only RESOLVES to a
     * private address is a different check and lives in
     * `legacy-mcp-provider.test.ts`.
     *
     * THE CONTROL IS THE ONE CASE HERE THAT USES THE SEAM (#3549), and the
     * timing comparison this paragraph used to draw — 0-2 ms against the
     * control's 66 ms — is what gave it away: those 66 ms were a real DNS
     * lookup racing the control's own 1000 ms deadline, and on a slow runner
     * the deadline won. The control's claim is about the MAPPING of a plain
     * socket failure, so the failure is now injected. The six address cases
     * keep the production path, because the composition with `safeFetch` is
     * exactly what they are for.
     */
    it.each([
        ['IPv4 loopback', 'https://127.0.0.1/mcp'],
        ['IPv6 loopback', 'https://[::1]/mcp'],
        ['private 10/8', 'https://10.0.0.5/mcp'],
        ['private 192.168/16', 'https://192.168.1.10/mcp'],
        ['private 172.16/12', 'https://172.16.0.1/mcp'],
        ['link-local metadata', 'https://169.254.169.254/mcp'],
    ])('%s is refused as a POLICY decision, not merely a failure', async (label, url) => {
        const res = await pullSnapshot({
            url,
            token: TOKEN,
            requestTimeoutMs: 1_000,
            pullTimeoutMs: 5_000,
        });

        // Labelled so a failure names WHICH family regressed, not just the first.
        expect({
            label,
            complete: res.complete,
            kind: res.reason?.kind,
            // The half the control cannot satisfy.
            message: res.reason?.message,
        }).toEqual({
            label,
            complete: false,
            kind: 'ssrf-blocked',
            message: 'egress refused: address is not public',
        });
        // A blocked pull carries no rows, so it cannot be read as an empty
        // application.
        expect({ label, rows: res.rows.length }).toEqual({ label, rows: 0 });
    });

    it('CONTROL: a plain egress failure is indistinguishable by kind, so the kind alone is not the proof', async () => {
        /*
            ═══ THE SOCKET FAILURE IS INJECTED, NOT PROVOKED (#3549) ═══

            This case used to call the real client against
            `https://nonexistent-host-xyz-9281.example/mcp` and rely on DNS
            failing inside its own 1000 ms deadline. It raced two clocks and
            owned neither: on a loaded CI runner resolution took longer, the
            deadline won, and the client returned `kind: 'timeout'` — which is
            the correct answer to what actually happened.

            A FLAKY CONTROL IS WORSE THAN A FLAKY ORDINARY CASE, which is why
            this was worth fixing rather than re-running. Its own warning,
            below, instructs a reader whose run goes red to go and WEAKEN the
            sibling assertions. Firing because a timer won sends somebody
            looking for a behaviour change in the egress layer that never
            happened, and the remedy it recommends is the opposite of correct.

            Nothing about the claim is about how fast DNS is. The claim is
            about the MAPPING: a fault that is neither a policy refusal nor a
            scheme refusal must come out as `egress failed`. So the fault is
            handed in through the declared seam, as the exact error Node's
            fetch throws for a name that does not resolve — `TypeError: fetch
            failed` wrapping an `ENOTFOUND` cause. `wirePost` wraps it in
            `WireEgressError` and `asLegacyError` reads the CAUSE, so
            `mapEgressError` sees precisely what it would have seen from the
            live call, and takes the arm it would have taken.

            What the seam gives up is nothing this case ever had: a `.example`
            name does not resolve, so `safeFetch`'s address policy was never
            reached by it either. The composition WITH `safeFetch` stays proven
            by the six address cases above, which are the ones that must not
            use the seam.
        */
        let calls = 0;
        const res = await pullSnapshot({
            url: 'https://nonexistent-host-xyz-9281.example/mcp',
            token: TOKEN,
            requestTimeoutMs: 1_000,
            pullTimeoutMs: 5_000,
            fetchImpl: () => {
                calls += 1;
                // Node's own shape for an unresolvable name: a bare
                // `TypeError` whose message says nothing about addresses, with
                // the resolver's error as the cause. Neither string matches
                // the private-address arm's pattern, which is the whole reason
                // this reaches the catch-all.
                throw Object.assign(new TypeError('fetch failed'), {
                    cause: new Error(
                        'getaddrinfo ENOTFOUND nonexistent-host-xyz-9281.example',
                    ),
                });
            },
        });

        // POSITIVE CONTROL. Without it, "the client reported `egress failed`"
        // is also satisfied by a client that never called out at all and
        // failed somewhere earlier — the catch-all maps ANY unrecognised
        // failure, so a refusal before the request would read identically.
        expect(calls).toBe(1);

        // ASSERTED POSITIVELY since #3492, where it was two `not.toBe`s. A
        // negated assertion is satisfied by an empty or absent value as readily as
        // by the right one, so it cannot distinguish "the catch-all produced
        // `egress failed`" from "`message` is undefined because the shape
        // changed". Naming the exact sentence is what makes this a control for
        // BOTH discriminations the cases around it rely on — the address cases
        // above say `address is not public`, the scheme case below says
        // `scheme not allowed`, and this one, which is neither a policy refusal
        // nor a scheme refusal, says `egress failed`.
        //
        // If this control ever stops returning `ssrf-blocked`, the assertions
        // above became stronger than they claim and should be revisited — and
        // since #3549 that sentence means what it says, because the only thing
        // that can change the answer now is the mapping.
        expect({ complete: res.complete, kind: res.reason?.kind, message: res.reason?.message })
            .toEqual({
                complete: false,
                kind: 'ssrf-blocked',
                message: 'egress refused: egress failed',
            });
    });

    it('http: is refused AND says so — the reason names the scheme, not a generic egress failure', async () => {
        // FIXED in #3492. This test used to pin the opposite, as a record of a
        // defect: `mapEgressError`'s `scheme not allowed` arm required the word
        // `scheme` or `protocol` in safeFetch's message, which carries neither, so
        // an `http:` endpoint reported `egress refused: egress failed` — the same
        // sentence an unresolvable hostname produces. The scheme is now decided in
        // `wirePost` from the URL it was handed, before any call.
        const res = await pullSnapshot({
            url: 'http://legacy.example.com/mcp',
            token: TOKEN,
            requestTimeoutMs: 1_000,
            pullTimeoutMs: 5_000,
        });
        expect({ complete: res.complete, kind: res.reason?.kind, message: res.reason?.message })
            .toEqual({
                complete: false,
                kind: 'ssrf-blocked',
                message: 'egress refused: scheme not allowed',
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

    it('oversharing is STRIPPED and REPORTED, not refused (#3319)', async () => {
        // The split: the transport removes the column at the socket, so nothing
        // downstream can store, render or log what it never receives — and names
        // it, so the server owner's bug stays visible. Whether it is FATAL is the
        // caller's call, because that depends on the never-request denylist, which
        // is product policy this module does not know.
        //
        // The previous behaviour refused every such pull. That argument was sound
        // and its scope was wrong: it settled a product question inside the
        // transport, so a customer whose server ignores `?fields=` had their
        // recertification stopped rather than flagged.
        const server = createLegacyMcpFakeServer({
            accounts: 3,
            rowsPerPage: 3,
            faults: { oversharing: true },
        });
        const res = await pull(server, { fields: [KEY_COLUMN] });

        expect(res.complete).toBe(true);
        expect(res.reason).toBeUndefined();
        // Named, so the caller can judge severity.
        expect(res.overshared.length).toBeGreaterThan(0);
        // And GONE from the rows. This is the half only the transport can do.
        for (const row of res.rows) {
            expect(Object.keys(row)).toEqual([KEY_COLUMN]);
        }
    });

    it('a conforming server reports no oversharing', async () => {
        // The denominator. Without this, a bug that reported every column as
        // overshared would pass the test above.
        const server = createLegacyMcpFakeServer({ accounts: 3, rowsPerPage: 3 });
        const res = await pull(server, { fields: [KEY_COLUMN] });
        expect(res.complete).toBe(true);
        expect(res.overshared).toEqual([]);
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

    /**
     * THE SEAM'S CARRIERS, DERIVED RATHER THAN NAMED (#3983).
     *
     * `fetchImpl` is declared on `wire-transport`, and the previous version of
     * this scope named ONE way to reach it —
     * `/@\/lib\/mcp\/client/ || /pullSnapshot\s*\(/`. `wire-transport` has four
     * consumers under `src/` and that predicate matched one:
     *
     *   src/lib/mcp/client/index.ts                 matched
     *   src/app-layer/integrations/mcp/client.ts    not matched (declares no seam)
     *   src/lib/agentic/a2a/client.ts               NOT MATCHED, forwards the seam
     *   src/app-layer/usecases/a2a-outbound.ts      NOT MATCHED, forwards the seam
     *
     * So this walks the import graph to a fixed point instead: a file is a
     * carrier if it imports a carrier AND mentions the option. Deriving means a
     * fifth consumer is in scope the day it is written, which a named predicate
     * cannot be.
     */
    const ROOT = 'src/lib/mcp/wire-transport.ts';

    /**
     * Carriers of the seam, to a FIXED POINT. Pure, and separated from the file
     * read, so its transitivity can be tested on a graph that actually has
     * depth — see the test below and the two failed attempts recorded in it.
     *
     * Every real carrier today imports `wire-transport` DIRECTLY, so the loop is
     * currently unexercised by the repository. It is kept for the fifth consumer
     * reached through another module, which will arrive without anyone
     * remembering this exists.
     */
    const deriveCarriers = (sources: ReadonlyMap<string, string>): readonly string[] => {
        const carriers = new Set([ROOT]);
        for (let pass = 0; pass < 12; pass += 1) {
            const before = carriers.size;
            for (const [rel, src] of sources) {
                if (carriers.has(rel) || !/\bfetchImpl\b/.test(src)) continue;
                const importsCarrier = [...carriers].some((c) => {
                    const spec = c.replace(/^src\//, '@/').replace(/(\/index)?\.ts$/, '');
                    return src.includes(`'${spec}'`) || src.includes(`"${spec}"`);
                });
                if (importsCarrier) carriers.add(rel);
            }
            if (carriers.size === before) break;
        }
        return [...carriers].filter((c) => c !== ROOT);
    };

    const seamCarriers = (): readonly string[] =>
        deriveCarriers(new Map(srcFiles().map((f) => [f, codeIn(f)])));

    it('finds every DIRECT importer of the seam that mentions it', () => {
        // The denominator beside the result: an offender list is only as good as
        // the population it ranged over, and an empty list over an empty
        // population is exactly the failure this block replaced. All three are
        // ONE hop — the transitivity claim is tested separately and synthetically,
        // because nothing real is multi-hop.
        const carriers = seamCarriers();
        expect(carriers).toContain('src/lib/mcp/client/index.ts');
        expect(carriers).toContain('src/lib/agentic/a2a/client.ts');
        expect(carriers).toContain('src/app-layer/usecases/a2a-outbound.ts');
        expect(carriers.length).toBeLessThan(12);
    });

    it('follows the graph TRANSITIVELY, proved on a graph that has depth', () => {
        /**
         * WHY SYNTHETIC, AND WHY TWO OBVIOUS VERSIONS PROVED NOTHING.
         *
         * First attempt: assert transitivity by naming `a2a-outbound` as "two
         * hops out". It is not — it imports `WireFetch` from `wire-transport`
         * DIRECTLY, as do both other carriers. Every real carrier today is one
         * hop, so limiting the walker to a single pass changed nothing and the
         * assertion passed either way.
         *
         * Second attempt: a synthetic three-level graph, inserted root-first.
         * That passed under a single pass too, because the inner loop visits
         * every file per pass — in dependency order one pass reaches the whole
         * chain. The ORDER was doing the work the loop was being credited for.
         *
         * So the entries below are in REVERSE dependency order, which is what
         * makes a single pass insufficient: `three` is visited before `two` is a
         * carrier, and `two` before `one` is. Mutating the bound to 1 now fails
         * here, which is the only reason the loop is worth keeping while no real
         * carrier is multi-hop.
         */
        const synthetic = new Map([
            ['src/c/three.ts', "import { y } from '@/b/two';\nconst o = { fetchImpl: y.fetchImpl };"],
            ['src/b/two.ts', "import { x } from '@/a/one';\nconst o = { fetchImpl: x.fetchImpl };"],
            ['src/a/one.ts', "import type { W } from '@/lib/mcp/wire-transport';\nlet fetchImpl;"],
            // Imports a carrier but never mentions the option: out of scope. Its
            // absence is what keeps this from flagging the thirteen unrelated
            // files that inject their own fetch for their own reasons.
            ['src/d/four.ts', "import { z } from '@/c/three';\nconst o = { timeoutMs: 1 };"],
            [ROOT, 'export interface W { readonly fetchImpl?: WireFetch }'],
        ]);
        const found = deriveCarriers(synthetic);

        expect(found).toContain('src/a/one.ts');
        expect(found).toContain('src/b/two.ts');
        expect(found).toContain('src/c/three.ts');
        expect(found).not.toContain('src/d/four.ts');
    });

    it('no file under src/ ORIGINATES a fetchImpl, though it may forward one', () => {
        // THE PROPERTY, stated precisely. "No file mentions it" is too strong —
        // a layered test seam works by forwarding, and every real instance here
        // is a forward (`fetchImpl: net.fetchImpl`). What must never appear is a
        // file ORIGINATING one: a function literal, an imported fetch,
        // `globalThis.fetch`. That is the diff which routes around `safeFetch`
        // while looking like dependency injection, and it is what the seam's own
        // docstring is afraid of.
        //
        // Stated this way the guard needs no exemption list. Widening the old
        // predicate to all four consumers would have flagged two files that only
        // forward, and the fix for that would have been an allowlist — which is
        // the trap this block's own history names: a guard with an exemption list
        // is measuring the list.
        const offenders: string[] = [];
        for (const rel of seamCarriers()) {
            const src = codeIn(rel);
            // `fetchImpl?:` is a DECLARATION and is not matched: `\s*` does not
            // cross the `?`. A non-optional declaration is matched and excluded
            // by its value being a bare type name.
            for (const m of src.matchAll(/\bfetchImpl\s*:\s*([^,;)}\n]+)/g)) {
                const value = m[1].trim();
                if (/\.fetchImpl$/.test(value)) continue; // forwarded from a caller
                if (/^(WireFetch|FetchImpl|typeof fetch)\b/.test(value)) continue; // a declaration
                offenders.push(`${rel} -> fetchImpl: ${value}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

/**
 * THE PROFILE FAILS CLOSED ON THE SAME SERVER, AND THROWS WHERE A PULL REPORTS
 * (#3617).
 *
 * Every fault above is driven against `pullSnapshot`. None was driven against
 * `profileFirstPage`, which is the thirteen-path gap in `client/index.ts` — and
 * the profile is the entry point an admin reaches FIRST, before any mapping
 * exists, which makes it the one most likely to meet a hostile server.
 *
 * ── THE TWO ENTRY POINTS ANSWER DIFFERENTLY, ON PURPOSE ────────────────────
 *
 * A pull RETURNS `{ complete: false, reason }` — a partial snapshot is still
 * worth something, and the caller decides. A profile THROWS, because there is
 * no partial profile worth returning: the whole output is "here is what this
 * server offers", and a server that broke its contract has not told you.
 *
 * Both are asserted, because collapsing either into the other's shape would be
 * silent — a profile that returned a result would hand a caller a column list
 * assembled from a response nobody validated.
 */
describe('1b client — the PROFILE fails closed on the same faults', () => {
    const profile = (server: LegacyMcpFakeServer, over: Record<string, unknown> = {}) =>
        profileFirstPage({
            url: URL_,
            token: TOKEN,
            fetchImpl: server.fetch,
            requestTimeoutMs: 1_000,
            fields: [KEY_COLUMN],
            ...over,
        });

    /** Measured, not assumed — each fault's typed error on the profile path. */
    const PROFILE_FAULTS = [
        ['oversizedPage', 'cap-exceeded'],
        ['malformedJson', 'contract-violation'],
        ['serverSentEvents', 'contract-violation'],
        ['unsupportedProtocolVersion', 'contract-violation'],
        ['redirect', 'ssrf-blocked'],
        // The five new ones. A profile reads a manifest and ONE page, so every
        // malformation in that chain is one it can meet — including the page-1
        // tear, which the multi-page `tornSnapshot` hides from it.
        ['unsupportedContract', 'contract-violation'],
        ['unparseablePageUri', 'contract-violation'],
        ['nonSequentialPages', 'contract-violation'],
        ['pageNumberMismatch', 'contract-violation'],
        ['pageOneSnapshotMismatch', 'torn-snapshot'],
    ] as const;

    it('profiles a conforming server — the control', async () => {
        // Without this the refusals below are satisfied by a profiler that
        // throws on everything.
        const server = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 3 });
        await expect(profile(server)).resolves.toBeDefined();
    });

    it.each(PROFILE_FAULTS)('%s REJECTS with a typed %s error', async (fault, kind) => {
        const server = createLegacyMcpFakeServer({
            accounts: 7,
            rowsPerPage: 3,
            faults: { [fault]: true },
            redirectTo: 'https://elsewhere.example.test/mcp',
        });

        const err = await profile(server).then(
            () => null,
            (e: unknown) => e as Error & { kind?: string },
        );

        // THROWN, not returned — the asymmetry with `pullSnapshot` above.
        expect({ fault, threw: err !== null }).toEqual({ fault, threw: true });
        expect({ fault, kind: err?.kind }).toEqual({ fault, kind });
    });

    it('profiles EVERY declared column when no field list is given', async () => {
        // The default mode, and the one the header describes: "a profile requests
        // every column that is not denylisted, because you cannot map a column
        // you were never shown". Every earlier case passes an explicit list, so
        // the no-list arm — which falls back to the manifest's own column set —
        // was never taken.
        const server = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 3 });
        const res = await profileFirstPage({
            url: URL_,
            token: TOKEN,
            fetchImpl: server.fetch,
            requestTimeoutMs: 1_000,
        });
        expect(res).toBeDefined();
        // Nothing was stripped, because nothing was excluded.
        expect(res.rows.length).toBeGreaterThan(0);
    });

    it('refuses a page with more rows than the cap allows', async () => {
        // The row cap, reached by lowering it rather than by the `oversizedPage`
        // fault — that one trips a BYTE cap in the transport first, so it never
        // exercises this check. A server returning more rows than asked for is
        // not a transport problem; it is a contract one.
        const server = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 5 });
        const err = await profileFirstPage({
            url: URL_,
            token: TOKEN,
            fetchImpl: server.fetch,
            requestTimeoutMs: 1_000,
            fields: [KEY_COLUMN],
            maxRowsPerPage: 2,
        }).then(
            () => null,
            (e: unknown) => e as Error & { kind?: string },
        );
        expect(err?.kind).toBe('cap-exceeded');
    });

    it('STRIPS a column it did not ask for rather than passing it through', async () => {
        // The projection is enforced on the way back as well as on the way out:
        // a server that returns extra columns has them removed, which is what
        // keeps "we never requested it" and "we never received it" the same
        // fact. Without the strip, a denylisted column could arrive unasked.
        const server = createLegacyMcpFakeServer({
            accounts: 7,
            rowsPerPage: 3,
            faults: { oversharing: true },
        });
        const res = await profileFirstPage({
            url: URL_,
            token: TOKEN,
            fetchImpl: server.fetch,
            requestTimeoutMs: 1_000,
            fields: [KEY_COLUMN],
        });
        // Only the asked-for column survives on every row.
        for (const row of res.rows) {
            expect(Object.keys(row)).toEqual([KEY_COLUMN]);
        }
    });

    it('refuses to request a column the manifest never declared', async () => {
        // The projection check. You cannot map a column you were never shown, so
        // a profile asks for every non-denylisted column the server DECLARED —
        // and asking for one it did not is a request this client will not make,
        // whoever assembled the list.
        const server = createLegacyMcpFakeServer({ accounts: 7, rowsPerPage: 3 });

        const err = await profile(server, { fields: [KEY_COLUMN, 'COLUMN_THE_SERVER_NEVER_DECLARED'] }).then(
            () => null,
            (e: unknown) => e as Error & { kind?: string },
        );

        expect(err?.kind).toBe('contract-violation');
        // And it never went on the wire: the refusal is before the page read.
        expect(server.requests.some((r) => (r.uri ?? '').includes('COLUMN_THE_SERVER_NEVER_DECLARED')))
            .toBe(false);
    });
});

/**
 * AND THE FAULTS A PROFILE DELIBERATELY DOES NOT REFUSE (#3617).
 *
 * Measured rather than assumed, and pinned so that nobody "fixes" the profiler
 * into rejecting them. Each has a reason, and the reasons are different:
 *
 *   • `tornSnapshot` — a tear is a snapshot changing BETWEEN pages, and a
 *     profile reads exactly one. There is nothing to tear between. The
 *     snapshot-id check in `profileFirstPage` is defensive against a server
 *     whose page 1 disagrees with its own manifest, which this fake cannot
 *     produce.
 *   • `duplicateAccountKey`, `rowWithoutAccountKey`, `secretShapedValue` — row
 *     level concerns belonging to INGEST. The profiler's own header says rows
 *     "are returned so the caller can compute statistics and DISCARD them", and
 *     `lib/legacy-access/profile.ts` is its only intended caller. Refusing a
 *     whole profile because one row lacks a key would stop an admin ever seeing
 *     the table they are trying to map.
 *   • `schemaDrift`, `toolsAdvertised`, `oversharing` — already covered against
 *     the pull, and not contract breaches at the profile's own boundary.
 */
describe('1b client — what a profile tolerates, and why', () => {
    const profile = (server: LegacyMcpFakeServer) =>
        profileFirstPage({
            url: URL_,
            token: TOKEN,
            fetchImpl: server.fetch,
            requestTimeoutMs: 1_000,
            fields: [KEY_COLUMN],
        });

    it.each([
        'tornSnapshot',
        'duplicateAccountKey',
        'rowWithoutAccountKey',
        'secretShapedValue',
        'toolsAdvertised',
        'schemaDrift',
    ] as const)('%s does not fail the profile', async (fault) => {
        const server = createLegacyMcpFakeServer({
            accounts: 7,
            rowsPerPage: 3,
            faults: { [fault]: true },
        });
        await expect(profile(server)).resolves.toBeDefined();
    });

    it('every declared fault is accounted for — refused or tolerated, none unexamined', async () => {
        // The denominator. `slowResponse` is excluded because it is a timing
        // fault whose outcome depends on the budget, and it is covered against
        // the pull where the budget is the point.
        const refused = PROFILE_REFUSED;
        const tolerated = PROFILE_TOLERATED;
        const examined = new Set<string>([...refused, ...tolerated, 'slowResponse']);
        expect([...examined].sort()).toEqual([...FAULT_NAMES].sort());
    });
});

/** The faults the profile rejects, named once so the denominator can use them. */
const PROFILE_REFUSED = [
    'oversizedPage',
    'malformedJson',
    'serverSentEvents',
    'unsupportedProtocolVersion',
    'redirect',
    'unsupportedContract',
    'unparseablePageUri',
    'nonSequentialPages',
    'pageNumberMismatch',
    'pageOneSnapshotMismatch',
] as const;

/** The faults the profile tolerates, with reasons in the describe above. */
const PROFILE_TOLERATED = [
    'tornSnapshot',
    'duplicateAccountKey',
    'rowWithoutAccountKey',
    'secretShapedValue',
    'toolsAdvertised',
    'schemaDrift',
    'oversharing',
] as const;

// ───────────── the mapper that decides WHICH of the six it is ─────────────

/**
 * `mapEgressError` directly, rather than through a pull.
 *
 * The module's premise is that six error types exist because an operator does
 * six DIFFERENT things with them — "collapsing those into 'pull failed' is how
 * a misconfigured URL and a wrong password become the same support ticket".
 * This function is what picks which one, and three of its arms had never run:
 * the passthrough, the abort, and the redirect. The tests above reach it only
 * through `pullSnapshot`, which cannot produce an `AbortError` or a
 * `RedirectNotAllowedError` from an injected `fetchImpl`.
 *
 * Driven directly because the arms are matched on NAME, deliberately, so that
 * this module does not import the automation layer's error classes. A test
 * that constructed real `safeFetch` errors would couple itself to the taxonomy
 * the source went out of its way not to depend on.
 */
describe('mapEgressError picks the type the operator acts on', () => {
    it('returns one of our own errors UNCHANGED — the same instance, not a copy', async () => {
        // Idempotence. `asLegacyError` can route an error through here that is
        // already typed (it calls `mapEgressError(e.cause)` on a wire wrapper),
        // and re-wrapping a `CapExceededError` as `ssrf-blocked` would send the
        // operator to fix a URL that is fine.
        const original = new CapExceededError('total-rows', 10, 11);
        const mapped = mapEgressError(original);
        expect(mapped).toBe(original);
        expect(mapped.kind).toBe('cap-exceeded');
    });

    it('maps an AbortError to a TIMEOUT, not to a blocked address', async () => {
        // The operator action differs: a timeout means raise the deadline or
        // the server is unwell, while ssrf-blocked means fix the configured
        // URL. An abort reported as blocked sends someone to edit a correct
        // URL while the slow server stays slow.
        const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        const mapped = mapEgressError(abort);
        expect(mapped.kind).toBe('timeout');
        expect(mapped).toBeInstanceOf(TimeoutError);
        // Scope `request`, budget 0: this arm does not KNOW the budget — the
        // abort carries none — and 0 says so rather than inventing one.
        expect((mapped as TimeoutError).scope).toBe('request');
        expect((mapped as TimeoutError).budgetMs).toBe(0);
    });

    it('maps a redirect refusal named on the ERROR to ssrf-blocked, with the redirect reason', async () => {
        const e = Object.assign(new Error('nope'), { name: 'RedirectNotAllowedError' });
        const mapped = mapEgressError(e);
        expect(mapped.kind).toBe('ssrf-blocked');
        // The REASON, not just the kind. The catch-all also yields
        // `ssrf-blocked`, so a kind-only assertion here is satisfied by the
        // arm being deleted — the same control this file's address cases use.
        expect((mapped as SsrfBlockedError).reason).toBe('redirect refused');
        expect((mapped as SsrfBlockedError).reason).not.toBe('egress failed');
    });

    it('and one named only in the MESSAGE, which is the other half of that ||', async () => {
        const mapped = mapEgressError(new Error('redirect to another host is not allowed'));
        expect((mapped as SsrfBlockedError).reason).toBe('redirect refused');
    });

    it('keeps the address arm distinct from the catch-all', async () => {
        // The discriminator the file's docblock names: a policy refusal says
        // `address is not public`, a mere failure says `egress failed`.
        expect((mapEgressError(new Error('loopback address')) as SsrfBlockedError).reason).toBe(
            'address is not public',
        );
        expect((mapEgressError(new Error('connect ECONNREFUSED')) as SsrfBlockedError).reason).toBe(
            'egress failed',
        );
    });

    it('fails CLOSED on a throw that is not an Error at all', async () => {
        // `e instanceof Error ? ... : ''` / `String(e)`. A thrown string or
        // object has no `.name`/`.message`, and the default arm is a typed
        // refusal rather than a rethrow precisely so an unrecognised egress
        // failure cannot escape as an untyped error.
        for (const thrown of ['something odd', {}, null, 42]) {
            const mapped = mapEgressError(thrown);
            expect(mapped).toBeInstanceOf(SsrfBlockedError);
            expect(mapped.kind).toBe('ssrf-blocked');
        }
    });

    it('does not quote the thrown message into the mapped error', async () => {
        // The module's second rule: the body is ATTACKER-SHAPED, and an error
        // message that quotes it has moved untrusted content into
        // `AuditLog.detailsJson`, "which is plaintext, hash-chained and never
        // deleted". The reasons are a closed set of fixed phrases.
        const mapped = mapEgressError(new Error('ssn=123-45-6789 loopback'));
        expect(mapped.message).not.toMatch(/123-45-6789/);
        expect((mapped as SsrfBlockedError).reason).toBe('address is not public');
    });
});

describe('ContractViolationError omits the colon when there is no detail', () => {
    it('reads as a bare phrase, not a dangling separator', async () => {
        // `${where}${detail ? `: ${detail}` : ''}`. The false arm had never
        // run, and "contract violation at manifest:" in a log reads as a
        // truncated message — which is how a complete error gets investigated
        // as a logging bug.
        expect(new ContractViolationError('manifest').message).toBe('contract violation at manifest');
        expect(new ContractViolationError('manifest').message).not.toMatch(/:$/);
        expect(new ContractViolationError('manifest', 'no snapshotId').message).toBe(
            'contract violation at manifest: no snapshotId',
        );
    });
});
