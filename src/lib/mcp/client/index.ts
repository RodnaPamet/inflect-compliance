/**
 * The legacy-access MCP client: pull a snapshot from a conforming server, refuse
 * everything else.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE TRANSPORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No Prisma, no `RequestContext`, no tenant. It takes a URL, a token and some
 * bounds, and returns rows or a typed failure. Step 1c wires it to a provider and
 * Step 2a persists what it returns; neither concern belongs here, and keeping them
 * out is what lets this module be tested against thirteen faults without a
 * database.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY REQUEST GOES THROUGH safeFetch
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The URL is operator-supplied: somebody types a hostname for a server we do not
 * run. That is textbook SSRF input, so the DNS-pinned, redirect-refusing,
 * private-address-refusing `safeFetch` is the only egress path, and
 * `tests/guards/ssrf-egress-coverage.test.ts` lists this module as a sink.
 *
 * `fetchImpl` is a TEST SEAM and nothing else. Production callers pass no options
 * object at all, or one without it; a structural rule in the client's own test
 * fails if any file under `src/` supplies one, and fails if this directory calls
 * `fetch` or `resilientFetch` directly. The seam exists because the thirteen
 * faults are easier to express as a function than as a server, and it is the kind
 * of convenience that quietly becomes a bypass if nothing watches it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BODY IS NEVER READ UNCAPPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not `await res.json()`, not `await res.text()` followed by a length check. Both
 * of those have already allocated the whole body by the time you could measure it,
 * which makes the byte cap a report rather than a defence — a server that wants to
 * exhaust us just sends a gigabyte.
 *
 * {@link readCapped} pulls from the byte stream, counts as it goes, and ABORTS the
 * request the moment the count passes the cap. The `oversizedPage` fault proves it:
 * the assertion is that the cap error arrives, and the fake server's body is far
 * larger than any buffer we would have been willing to hold.
 *
 * `Content-Length` is deliberately NOT trusted as the check. It is a claim by the
 * same party we are defending against, absent on a chunked response, and a server
 * that lies low gets through. It is used only as an early refusal when it happens
 * to be present and already over.
 *
 * @module lib/mcp/client
 */

import { safeFetch } from '@/app-layer/automation/webhook-safety';
import { log } from '@/lib/observability';
import {
    SUPPORTED_PROTOCOL_VERSIONS,
    LATEST_PROTOCOL_VERSION,
    type JsonRpcResponse,
} from '../protocol';
import {
    CONTRACT_VERSION,
    LIMITS,
    MANIFEST_URI,
    ManifestSchema,
    PageSchema,
    accountsUri,
    parseAccountsUri,
    isSupportedContract,
    type LegacyManifest,
    type LegacyRow,
} from './contract';
import {
    AuthenticationFailedError,
    CapExceededError,
    ContractViolationError,
    LegacyMcpClientError,
    SsrfBlockedError,
    TimeoutError,
    TornSnapshotError,
    mapEgressError,
} from './errors';

export * from './errors';
export * from './contract';

/** A test-only `fetch`. Production passes none; a guard enforces that. */
export type FetchImpl = (input: Request | string, init?: RequestInit) => Promise<Response>;

export interface PullOptions {
    readonly url: string;
    readonly token: string;
    /** Columns to request. Empty means the server's full set. */
    readonly fields?: readonly string[];
    /** Per-REQUEST budget. */
    readonly requestTimeoutMs?: number;
    /** Whole-PULL budget, across every page. */
    readonly pullTimeoutMs?: number;
    readonly maxBytesPerResponse?: number;
    readonly maxRowsPerPage?: number;
    readonly maxPages?: number;
    readonly maxTotalRows?: number;
    /**
     * TEST SEAM ONLY. Never supplied by code under `src/`.
     * @internal
     */
    readonly fetchImpl?: FetchImpl;
}

export interface PullResult {
    readonly manifest: LegacyManifest | null;
    readonly rows: readonly LegacyRow[];
    /**
     * True only when the manifest parsed, every advertised page was read, every
     * page agreed with the manifest's snapshot, and no cap was hit.
     *
     * Never true alongside a `reason`. The two fields are not independent, and a
     * caller that reads only `rows` must not be able to mistake a partial pull for
     * a whole one — an account missing from a snapshot is an account nobody
     * reviews.
     */
    readonly complete: boolean;
    /** The typed failure's `kind`, plus its message. Absent when complete. */
    readonly reason?: { readonly kind: LegacyMcpClientError['kind']; readonly message: string };
    /**
     * Column names that arrived in rows but were NOT requested -- stripped from
     * `rows` here, reported for the caller to judge.
     *
     * This used to be a refusal -- every unrequested column threw
     * `ContractViolationError` and the pull died. The argument for that was sound
     * -- silently dropping it would make a server's oversharing invisible, and its
     * owner is the only one who can fix it -- but it settled a PRODUCT question
     * inside the transport, and settled it the strict way for every case. A
     * customer whose server ignores `?fields=` is misconfigured, not hostile, and
     * refusing every pull stopped their recertification outright.
     *
     * The split: the transport does what only it can -- strip at the boundary, so
     * nothing downstream can mishandle what it never receives -- and names what it
     * stripped. Fatality is the caller's, because it depends on the never-request
     * denylist, which is product policy this module does not know. See
     * `usecases/legacy-access-pull.ts`.
     *
     * Empty on a conforming server, and empty on every failure path. Names only.
     */
    readonly overshared: readonly string[];
}

export interface ProfileReadResult {
    readonly manifest: LegacyManifest;
    /**
     * The FIRST page's rows. Returned so the caller can compute statistics and
     * throw them away; nothing persists them and nothing renders them.
     */
    readonly rows: readonly LegacyRow[];
    /** Columns the server returned outside the projection. Stripped from `rows`. */
    readonly overshared: readonly string[];
    /**
     * More pages exist and were deliberately not read.
     *
     * NOT a fault and NOT a cap breach — see `profileFirstPage`'s docblock. It is
     * here so a caller cannot mistake a one-page sample for the whole table, which
     * is the same distinction `complete` draws for a pull.
     */
    readonly truncated: boolean;
}

export const DEFAULTS = {
    REQUEST_TIMEOUT_MS: 15_000,
    PULL_TIMEOUT_MS: 120_000,
    /** One page of 1,000 rows at the 4 KiB cell cap is far below this. */
    MAX_BYTES_PER_RESPONSE: 8 * 1024 * 1024,
    MAX_TOTAL_ROWS: 200_000,
} as const;

// ─── The capped reader ─────────────────────────────────────────────────────

/**
 * Read a response body, aborting the moment it exceeds `cap` bytes.
 *
 * Returns the decoded text. Throws {@link CapExceededError} without having
 * buffered more than `cap` plus one chunk.
 */
async function readCapped(res: Response, cap: number, controller: AbortController): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) {
        // A free refusal when the server happens to tell the truth. Not the check.
        controller.abort();
        throw new CapExceededError('bytes', cap, cap);
    }

    const body = res.body;
    if (!body) {
        // No stream to cap. `text()` on an empty/absent body allocates nothing
        // meaningful, and a missing body is a contract violation downstream.
        return '';
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
            // Stop the transfer. Without this the server keeps sending and the
            // socket keeps costing, even though we have already decided.
            await reader.cancel().catch(() => undefined);
            controller.abort();
            throw new CapExceededError('bytes', cap, cap);
        }
        out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
}

// ─── One JSON-RPC call ─────────────────────────────────────────────────────

interface CallContext {
    readonly url: string;
    readonly token: string;
    readonly requestTimeoutMs: number;
    readonly maxBytes: number;
    readonly pullDeadlineAt: number;
    readonly fetchImpl?: FetchImpl;
    sessionId: string | null;
    protocolVersion: string | null;
}

let rpcId = 0;

/**
 * Send one JSON-RPC request and return its `result`.
 *
 * `notify` sends a notification: no id, and no response body is read.
 */
async function rpc(
    ctx: CallContext,
    method: string,
    params: unknown,
    opts: { notify?: boolean } = {}
): Promise<unknown> {
    const remaining = ctx.pullDeadlineAt - Date.now();
    if (remaining <= 0) throw new TimeoutError('pull', 0);

    const budget = Math.min(ctx.requestTimeoutMs, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        // The contract forbids SSE, so we do not offer to accept it. A server that
        // sends it anyway is refused below — asking politely is not enforcement.
        accept: 'application/json',
        authorization: `Bearer ${ctx.token}`,
    };
    if (ctx.sessionId) headers['mcp-session-id'] = ctx.sessionId;
    if (ctx.protocolVersion) headers['mcp-protocol-version'] = ctx.protocolVersion;

    const body = JSON.stringify(
        opts.notify
            ? { jsonrpc: '2.0', method, params }
            : { jsonrpc: '2.0', id: ++rpcId, method, params }
    );

    let res: Response;
    try {
        const init = { method: 'POST', headers, body, signal: controller.signal };
        // An explicit branch, NOT `ctx.fetchImpl ?? safeFetch`. Two reasons, and
        // the SSRF sink registry found the first: resolving into an alias means
        // `safeFetch(` never literally appears in this file, so the registry's
        // check — "this sink calls safeFetch" — had nothing to match and was
        // passing on the import alone. The second is for a reader: a branch shows
        // that exactly one path reaches the network unprotected and that it is the
        // test seam, where a defaulted alias reads as if both are the same thing.
        res = ctx.fetchImpl
            ? await ctx.fetchImpl(ctx.url, init)
            : await safeFetch(ctx.url, init);
    } catch (e) {
        clearTimeout(timer);
        if (controller.signal.aborted) throw new TimeoutError('request', budget);
        throw mapEgressError(e);
    }

    try {
        // Capture a session the server issues, so later requests carry it. Read
        // BEFORE the status checks: a server may legitimately issue the session on
        // the same response that reports an error, and losing it would make the
        // retry look like a new client.
        const issued = res.headers.get('mcp-session-id');
        if (issued && !ctx.sessionId) ctx.sessionId = issued;

        if (res.status === 401 || res.status === 403) {
            throw new AuthenticationFailedError(res.status);
        }
        // A 3xx should never arrive — safeFetch refuses redirects — but an injected
        // fetch can produce one, and a client that followed it would be the bypass.
        if (res.status >= 300 && res.status < 400) {
            throw new SsrfBlockedError('redirect refused');
        }
        if (!res.ok) {
            throw new ContractViolationError('http status', String(res.status));
        }

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        // SSE is refused for a notification too: the contract forbids the transport,
        // not just the payload, and a server streaming at us on a notification is
        // the same server that will stream at us on a read.
        if (contentType.includes('text/event-stream')) {
            throw new ContractViolationError('content-type', 'server-sent events are not allowed');
        }

        // A notification has no response to parse, and a conforming server answers
        // it with a bodiless 202 carrying no content-type at all. Requiring
        // application/json here would refuse the correct behaviour — so the JSON
        // requirement belongs below this return, applying only where a body is
        // actually read.
        if (opts.notify) return undefined;

        if (!contentType.includes('application/json')) {
            throw new ContractViolationError('content-type', 'expected application/json');
        }

        const text = await readCapped(res, ctx.maxBytes, controller);

        let parsed: JsonRpcResponse;
        try {
            parsed = JSON.parse(text) as JsonRpcResponse;
        } catch {
            // The body is NOT quoted — it is untrusted and this message is logged.
            throw new ContractViolationError('body', 'not valid JSON');
        }

        if ('error' in parsed && parsed.error) {
            throw new ContractViolationError('rpc error', `code ${parsed.error.code}`);
        }
        if (!('result' in parsed)) {
            throw new ContractViolationError('rpc response', 'no result');
        }
        return parsed.result;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Handshake ─────────────────────────────────────────────────────────────

/**
 * `initialize`, then `notifications/initialized`.
 *
 * Three refusals live here, and each has a fault behind it:
 *
 *   - a protocol version we do not speak (`unsupportedProtocolVersion`);
 *   - a server that does not advertise `resources`, because a server without them
 *     cannot serve this contract and calling on would just fail later and less
 *     clearly;
 *   - `capabilities: {}` exactly, asserted on the wire by the fake server's log.
 *     We advertise nothing because we implement nothing — no sampling, no roots,
 *     no elicitation — and a client that claims a capability it lacks invites a
 *     server to use it.
 *
 * Tools are IGNORED, never refused. A legacy server may legitimately expose tools
 * for its own other consumers; what matters is that we never call one, which is a
 * property of this client's method set rather than of the server's manifest.
 */
async function handshake(ctx: CallContext): Promise<void> {
    const result = (await rpc(ctx, 'initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'inflect-legacy-access-client', version: '1' },
    })) as {
        protocolVersion?: unknown;
        capabilities?: Record<string, unknown>;
    } | null;

    if (!result || typeof result !== 'object') {
        throw new ContractViolationError('initialize', 'no result object');
    }

    const negotiated = result.protocolVersion;
    if (typeof negotiated !== 'string') {
        throw new ContractViolationError('initialize', 'protocolVersion missing');
    }
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
        throw new ContractViolationError('initialize', 'unsupported protocolVersion');
    }
    ctx.protocolVersion = negotiated;

    const caps = result.capabilities;
    if (!caps || typeof caps !== 'object' || caps.resources === undefined) {
        throw new ContractViolationError('initialize', 'server advertises no resources');
    }

    await rpc(ctx, 'notifications/initialized', {}, { notify: true });
}

/** Read one resource and return its decoded JSON payload. */
async function readResource(ctx: CallContext, uri: string): Promise<unknown> {
    const result = (await rpc(ctx, 'resources/read', { uri })) as {
        contents?: { text?: unknown }[];
    } | null;

    const first = result?.contents?.[0];
    if (!first || typeof first.text !== 'string') {
        throw new ContractViolationError('resources/read', 'no text content');
    }
    try {
        return JSON.parse(first.text);
    } catch {
        throw new ContractViolationError('resource payload', 'not valid JSON');
    }
}

// ─── The pull ──────────────────────────────────────────────────────────────

/**
 * Pull a whole snapshot.
 *
 * Returns a result rather than throwing: a partial pull is a legitimate outcome
 * that the caller records with its reason, and an exception would make the rows
 * read so far unavailable to a caller who wants to report how far it got. The
 * typed error is still reachable — it is reduced to `reason`, and the error
 * classes are exported for a caller that prefers to catch.
 *
 * `complete: false` is set on EVERY failure path, including the ones that also
 * throw internally. That is the one invariant in this module worth re-reading:
 * global rule 4 says a partial read is never reported as complete, and the way
 * that breaks is a new early-return added later that forgets the flag. There is
 * exactly one place `complete: true` is produced, at the bottom.
 */
export async function pullSnapshot(opts: PullOptions): Promise<PullResult> {
    const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.REQUEST_TIMEOUT_MS;
    const pullTimeoutMs = opts.pullTimeoutMs ?? DEFAULTS.PULL_TIMEOUT_MS;
    const maxBytes = opts.maxBytesPerResponse ?? DEFAULTS.MAX_BYTES_PER_RESPONSE;
    const maxRowsPerPage = opts.maxRowsPerPage ?? LIMITS.MAX_ROWS_PER_PAGE;
    const maxPages = opts.maxPages ?? LIMITS.MAX_PAGES;
    const maxTotalRows = opts.maxTotalRows ?? DEFAULTS.MAX_TOTAL_ROWS;

    const ctx: CallContext = {
        url: opts.url,
        token: opts.token,
        requestTimeoutMs,
        maxBytes,
        pullDeadlineAt: Date.now() + pullTimeoutMs,
        fetchImpl: opts.fetchImpl,
        sessionId: null,
        protocolVersion: null,
    };
        // Names only, deduplicated across every page. Never a value: the whole
        // point is that these columns' CONTENTS do not survive this loop.
        const oversharedColumns = new Set<string>();

    let manifest: LegacyManifest | null = null;
    const rows: LegacyRow[] = [];

    try {
        await handshake(ctx);

        const rawManifest = await readResource(ctx, MANIFEST_URI);
        const parsedManifest = ManifestSchema.safeParse(rawManifest);
        if (!parsedManifest.success) {
            throw new ContractViolationError('manifest', 'failed schema validation');
        }
        manifest = parsedManifest.data;

        if (!isSupportedContract(manifest.contract)) {
            throw new ContractViolationError('manifest', 'unsupported contract version');
        }
        if (manifest.pages.length > maxPages) {
            throw new CapExceededError('pages', maxPages, manifest.pages.length);
        }

        const snapshotId = manifest.snapshot.id;

        /**
         * The columns a row is allowed to carry.
         *
         * The projection when one was asked for, the manifest's full set otherwise.
         * `contract.ts` assigns this check here explicitly — its row schema cannot
         * see the manifest, so it says so rather than pretending to enforce it.
         *
         * A projection the manifest does not declare is refused before any page is
         * requested: asking for a column that does not exist would otherwise be
         * answered by a server inventing one, and the oversharing check below would
         * then accept it as requested.
         */
        const declared = new Set(manifest.columns.map((c) => c.name));
        if (opts.fields?.length) {
            const undeclared = opts.fields.filter((f) => !declared.has(f));
            if (undeclared.length > 0) {
                throw new ContractViolationError('projection', 'requests undeclared columns');
            }
        }
        const allowed = opts.fields?.length ? new Set(opts.fields) : declared;

        // Only counts and identifiers. Never a cell, never a column's VALUES.
        log('info', 'legacy-mcp.manifest', {
            // Member expressions rather than the `snapshotId` local: the
            // prompt-logging rule does no data-flow analysis, so a bare local
            // reads as "identifier bound elsewhere" — a hole it has to record even
            // though every field here is named and every value is an id or a
            // count. Spelling the path removes the hole instead of registering it.
            snapshotId: manifest.snapshot.id,
            pages: manifest.pages.length,
            columns: manifest.columns.length,
            layout: manifest.layout,
        });
        for (const [index, advertisedUri] of manifest.pages.entries()) {
            const expectedPage = index + 1;

            // The manifest advertises WHICH pages exist; we ask for them with the
            // projection we want. So the advertised URI is parsed for its page
            // number and then rebuilt — never requested verbatim, because a
            // server-supplied URI is a server-supplied request target and this
            // client requests only what its own grammar can express.
            const parsedUri = parseAccountsUri(advertisedUri);
            if (!parsedUri) {
                throw new ContractViolationError('manifest', 'unparseable page uri');
            }
            if (parsedUri.page !== expectedPage) {
                throw new ContractViolationError('manifest', 'page uris are not sequential');
            }

            const raw = await readResource(ctx, accountsUri(expectedPage, opts.fields));
            const parsedPage = PageSchema.safeParse(raw);
            if (!parsedPage.success) {
                throw new ContractViolationError('page', 'failed schema validation');
            }
            const body = parsedPage.data;

            // The torn-snapshot check runs BEFORE the rows are accepted. After
            // would leave a torn page's rows in the array at the moment we decide
            // to refuse, so `complete: false` would sit beside data from two
            // different states of the system.
            if (body.snapshotId !== snapshotId) {
                throw new TornSnapshotError(snapshotId, body.snapshotId, expectedPage);
            }
            if (body.page !== expectedPage) {
                throw new ContractViolationError('page', 'page number does not match the request');
            }

            if (body.rows.length > maxRowsPerPage) {
                throw new CapExceededError('rows-per-page', maxRowsPerPage, body.rows.length);
            }
            if (rows.length + body.rows.length > maxTotalRows) {
                throw new CapExceededError(
                    'total-rows',
                    maxTotalRows,
                    rows.length + body.rows.length
                );
            }

                // Oversharing. A row carrying a column nobody asked for is data we
                // did not request, leaving a system we do not run.
                //
                // STRIPPED here and REPORTED to the caller, not thrown. The strip is
                // the half only the transport can do: a column removed at the
                // boundary cannot be stored, rendered, logged or handed to a model
                // by any later caller, however careless. The REFUSAL is the half
                // only the caller can do, because fatality depends on the
                // never-request denylist, which is product policy this module
                // deliberately does not know -- the same reason `maxTotalRows` is
                // the caller's to pass rather than this module's to decide.
                //
                // Dropping them SILENTLY would be the bad version, and is what the
                // previous unconditional refusal was guarding against. Reporting the
                // names keeps the server owner's bug visible without letting it halt
                // a customer's recertification.
                for (const row of body.rows) {
                    const kept: LegacyRow = {};
                    for (const [column, value] of Object.entries(row)) {
                        if (allowed.has(column)) kept[column] = value;
                        else oversharedColumns.add(column);
                    }
                    rows.push(kept);
                }
        }

        log('info', 'legacy-mcp.pull_complete', {
            snapshotId: manifest.snapshot.id,
            pages: manifest.pages.length,
            rows: rows.length,
        });

        // THE ONLY `complete: true` IN THIS MODULE.
        return { manifest, rows, complete: true, overshared: [...oversharedColumns].sort() };
    } catch (e) {
        const err = e instanceof LegacyMcpClientError ? e : mapEgressError(e);
        log('warn', 'legacy-mcp.pull_failed', {
            kind: err.kind,
            snapshotId: manifest?.snapshot.id ?? null,
            rowsReadBeforeFailure: rows.length,
        });
        return {
            manifest,
            rows,
            complete: false,
            // Reported on the failure path TOO, from the pages that were read.
            //
            // An earlier draft of this returned `[]` here, reasoning that a partial
            // read gives no basis for claiming what the whole table overshares.
            // True, and beside the point: the caller already knows `complete:
            // false` means "not the whole picture", and a denylisted column having
            // crossed the wire is a FACT about what left the customer's network,
            // not a claim about the table. Suppressing it would hide the one
            // oversharing case that is security-relevant behind an unrelated
            // transport fault.
            overshared: [...oversharedColumns].sort(),
            reason: { kind: err.kind, message: err.message },
        };
    }
}

/**
 * Handshake and read the manifest. Nothing else.
 *
 * Step 1c's `validateConnection` needs to answer "is this a conforming server and
 * what columns does it expose?" — and `pullSnapshot` would answer it by reading
 * every page, which for a million-row legacy export is a lot of someone else's
 * bandwidth spent on a Test button.
 *
 * Same handshake, same strict manifest validation, same typed failures, same
 * `safeFetch`. It differs from `pullSnapshot` only in stopping after the manifest,
 * so a passing probe means exactly: the server speaks the protocol version, it
 * advertises resources, its manifest satisfies the schema, and the contract string
 * is ours. It does NOT mean the pages are readable — the `complete` flag on a real
 * pull is the only thing that says that, and conflating the two is what makes a
 * green Test button a promise the product cannot keep.
 */
export async function probeManifest(
    opts: Pick<PullOptions, 'url' | 'token' | 'requestTimeoutMs' | 'maxBytesPerResponse' | 'fetchImpl'>
): Promise<LegacyManifest> {
    const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.REQUEST_TIMEOUT_MS;
    const ctx: CallContext = {
        url: opts.url,
        token: opts.token,
        requestTimeoutMs,
        maxBytes: opts.maxBytesPerResponse ?? DEFAULTS.MAX_BYTES_PER_RESPONSE,
        // One handshake plus one read, so the pull budget is two request budgets
        // rather than the whole-pass one. A probe that could outlive a Test button
        // is a probe nobody waits for.
        pullDeadlineAt: Date.now() + requestTimeoutMs * 3,
        fetchImpl: opts.fetchImpl,
        sessionId: null,
        protocolVersion: null,
    };

    await handshake(ctx);
    const raw = await readResource(ctx, MANIFEST_URI);
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ContractViolationError('manifest', 'failed schema validation');
    }
    if (!isSupportedContract(parsed.data.contract)) {
        throw new ContractViolationError('manifest', 'unsupported contract version');
    }
    return parsed.data;
}

/** Re-exported so a caller can assert the client never speaks a tool method. */
/**
 * Read the manifest and the FIRST PAGE ONLY, for column profiling.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `pullSnapshot` WITH A CAP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every cap in {@link pullSnapshot} THROWS rather than truncating —
 * `maxPages: 1` raises `CapExceededError` before a single page is requested, and
 * `maxTotalRows` raises it mid-read. That is correct for a SNAPSHOT, where a
 * partial read must never be mistaken for a population: invariant 4 says a
 * truncated read is recorded with a named reason and never reported as complete.
 *
 * Profiling wants the opposite, and wants it honestly. One page is ENOUGH and is
 * not a failure, because a profile is not evidence — it is scaffolding for a
 * decision an administrator is about to make, with no `accountKey` requirement,
 * no payload hash, no stored row and no bearing on what recertification reads. So
 * stopping after page one is the contract here rather than a cap being breached,
 * and {@link ProfileReadResult.truncated} says plainly that more pages exist.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT REQUESTS MORE COLUMNS THAN A PULL, AND THAT IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A pull requests only the MAPPED columns. A profile requests every column that
 * is not denylisted, because you cannot map a column you were never shown — the
 * mapping does not exist yet. The denylist is what keeps that from being a
 * widening: a name matching it is excluded from profiling exactly as it is
 * excluded from a pull, so the sensitive columns are never requested at either
 * stage. The caller assembles that list; this function only transmits it.
 *
 * Rows are returned so the caller can compute statistics and DISCARD them.
 * `lib/legacy-access/profile.ts` is the only intended caller and returns no row
 * to anybody.
 */
export async function profileFirstPage(
    opts: Pick<PullOptions, 'url' | 'token' | 'fields' | 'requestTimeoutMs'
        | 'maxBytesPerResponse' | 'maxRowsPerPage' | 'fetchImpl'>
): Promise<ProfileReadResult> {
    const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.REQUEST_TIMEOUT_MS;
    const maxRowsPerPage = opts.maxRowsPerPage ?? LIMITS.MAX_ROWS_PER_PAGE;
    const ctx: CallContext = {
        url: opts.url,
        token: opts.token,
        requestTimeoutMs,
        maxBytes: opts.maxBytesPerResponse ?? DEFAULTS.MAX_BYTES_PER_RESPONSE,
        // Handshake, manifest, one page: three request budgets, not the whole-pull
        // one. Somebody is watching a spinner.
        pullDeadlineAt: Date.now() + requestTimeoutMs * 4,
        fetchImpl: opts.fetchImpl,
        sessionId: null,
        protocolVersion: null,
    };

    await handshake(ctx);

    const rawManifest = await readResource(ctx, MANIFEST_URI);
    const parsedManifest = ManifestSchema.safeParse(rawManifest);
    if (!parsedManifest.success) {
        throw new ContractViolationError('manifest', 'failed schema validation');
    }
    const manifest = parsedManifest.data;
    if (!isSupportedContract(manifest.contract)) {
        throw new ContractViolationError('manifest', 'unsupported contract version');
    }

    const declared = new Set(manifest.columns.map((c) => c.name));
    if (opts.fields?.length) {
        const undeclared = opts.fields.filter((f) => !declared.has(f));
        if (undeclared.length > 0) {
            throw new ContractViolationError('projection', 'requests undeclared columns');
        }
    }
    const allowed = opts.fields?.length ? new Set(opts.fields) : declared;

    // Page ONE, rebuilt from our own grammar rather than requested verbatim — a
    // server-supplied URI is a server-supplied request target, and that holds
    // whether the read is a pull or a probe.
    const advertised = manifest.pages[0];
    const parsedUri = parseAccountsUri(advertised);
    if (!parsedUri) throw new ContractViolationError('manifest', 'unparseable page uri');
    if (parsedUri.page !== 1) {
        throw new ContractViolationError('manifest', 'page uris are not sequential');
    }

    const rawPage = await readResource(ctx, accountsUri(1, opts.fields));
    const parsedPage = PageSchema.safeParse(rawPage);
    if (!parsedPage.success) {
        throw new ContractViolationError('page', 'failed schema validation');
    }
    const body = parsedPage.data;

    if (body.snapshotId !== manifest.snapshot.id) {
        throw new TornSnapshotError(manifest.snapshot.id, body.snapshotId, 1);
    }
    if (body.page !== 1) {
        throw new ContractViolationError('page', 'page number does not match the request');
    }
    if (body.rows.length > maxRowsPerPage) {
        throw new CapExceededError('rows-per-page', maxRowsPerPage, body.rows.length);
    }

    // Stripped and reported, as in a pull: a column we did not ask for is removed
    // here so no later caller can mishandle it, and NAMED so the server owner's
    // bug stays visible. For a profile the stripped set is the interesting one —
    // the projection already excluded the denylist, so anything stripped here is a
    // column the server volunteered against an explicit field list.
    const oversharedColumns = new Set<string>();
    const rows: LegacyRow[] = [];
    for (const row of body.rows) {
        const kept: LegacyRow = {};
        for (const [column, value] of Object.entries(row)) {
            if (allowed.has(column)) kept[column] = value;
            else oversharedColumns.add(column);
        }
        rows.push(kept);
    }

    log('info', 'legacy-mcp.profile_read', {
        snapshotId: manifest.snapshot.id,
        pages: manifest.pages.length,
        columns: manifest.columns.length,
        rows: rows.length,
    });

    return {
        manifest,
        rows,
        overshared: [...oversharedColumns].sort(),
        // More pages exist and we deliberately did not read them. Not a fault.
        truncated: manifest.pages.length > 1,
    };
}

export const CLIENT_METHODS = ['initialize', 'notifications/initialized', 'resources/read'] as const;

export { CONTRACT_VERSION };
