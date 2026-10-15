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
