/**
 * The reference implementation of `inflect-legacy-access/1`, and the fault injector
 * every later step's tests are driven through.
 *
 * TWO JOBS, AND THE FIRST ONE CONSTRAINS HOW THIS FILE IS WRITTEN.
 * `docs/legacy-mcp-access-contract.md` names this file as the normative reference an
 * operator may read to see what a conforming server does. So the conforming path is
 * kept clean and commented, and every fault is opt-in and lives behind a named flag
 * rather than being woven through the happy path. A reference implementation whose
 * correct behaviour you have to disentangle from thirteen deliberate bugs is not a
 * reference.
 *
 * Because the document points here, the suite validates THIS server's output against
 * the schemas in `src/lib/mcp/client/contract.ts`. The document, the schemas and the
 * reference therefore cannot drift apart without something going red.
 *
 * IN-PROCESS, Web `Request` to `Response`. No port is opened and nothing is listening:
 * the handler is passed to the Step 1b client as its injected `fetch`, which is the
 * only seam that client has. Production code never passes one.
 */
import {
    CONTRACT_VERSION,
    LIMITS,
    MANIFEST_URI,
    parseAccountsUri,
    type LegacyRow,
} from '@/lib/mcp/client/contract';

/** Protocol versions this fake negotiates. Mirrors `src/lib/mcp/protocol.ts`. */
const PROTOCOL_VERSION = '2025-06-18';

/**
 * The thirteen faults, each independently switchable.
 *
 * Named for what the SERVER does, not for what the client should conclude — the
 * client's conclusion is the thing under test, and a fault called
 * `shouldProduceTornSnapshotError` would be asserting the answer in the fixture.
 */
export type FaultName =
    /** Page 2 reports a different `snapshotId` than the manifest. */
    | 'tornSnapshot'
    /** Rows carry columns the projection did not ask for. */
    | 'oversharing'
    /** A page body far past the client byte cap. */
    | 'oversizedPage'
    /** Responds after a delay, to exercise the per-request deadline. */
    | 'slowResponse'
    /** A 200 whose body is not JSON. */
    | 'malformedJson'
    /** `text/event-stream`, which the contract forbids. */
    | 'serverSentEvents'
    /** `initialize` returns a protocol version the client does not speak. */
    | 'unsupportedProtocolVersion'
    /** Advertises tools. The client must still never call one. */
    | 'toolsAdvertised'
    /** A 302 to another origin. */
    | 'redirect'
    /** The column set changes between pulls. */
    | 'schemaDrift'
    /** Two rows share the key column's value. */
    | 'duplicateAccountKey'
    /** A row omits the key column entirely. */
    | 'rowWithoutAccountKey'
    /** A cell holding something shaped like a credential. */
    | 'secretShapedValue';

/**
 * Every fault, as a VALUE.
 *
 * `FaultName` is a type and a type cannot be enumerated at runtime, so Step 1b's
 * "the expectation table covers every declared fault" test first read THIS FILE
 * and regexed the union out of it. That worked and was worse in two ways: a
 * whole-file read is what the Class D needle ratchet counts as un-analysable (it
 * went one over its ceiling), and a regex over source text is a weaker guarantee
 * than the compiler's.
 *
 * The check below makes adding a member to `FaultName` without adding it here a
 * COMPILE error, so the list cannot drift from the union it mirrors.
 */
export const FAULT_NAMES = [
    'tornSnapshot',
    'oversharing',
    'oversizedPage',
    'slowResponse',
    'malformedJson',
    'serverSentEvents',
    'unsupportedProtocolVersion',
    'toolsAdvertised',
    'redirect',
    'schemaDrift',
    'duplicateAccountKey',
    'rowWithoutAccountKey',
    'secretShapedValue',
] as const satisfies readonly FaultName[];

/** Fails to compile if a `FaultName` is missing from {@link FAULT_NAMES}. */
type UnlistedFault = Exclude<FaultName, (typeof FAULT_NAMES)[number]>;
const _everyFaultIsListed: UnlistedFault extends never ? true : never = true;
void _everyFaultIsListed;

export interface FakeServerOptions {
    /** Accounts in the snapshot. Default 7 — enough to page, small enough to read. */
    accounts?: number;
    rowsPerPage?: number;
    faults?: Partial<Record<FaultName, boolean>>;
    /** Milliseconds for `slowResponse`. */
    slowMs?: number;
    /** Where `redirect` points. Another origin, so SSRF rules bite. */
    redirectTo?: string;
    /**
     * Declare a column whose NAME is on the never-request denylist.
     *
     * Not a fault: a legacy access table legitimately HAS a password column, and a
     * conforming server is entitled to declare it. What must never happen is a
     * caller requesting it — which is a property of OUR projection, provable only
     * if the server offers the column in the first place. Step 2b's profiler asks
     * for every non-denylisted column, so this is what makes that assertion mean
     * something.
     */
    declaresDeniedColumn?: boolean;
}

export interface LoggedRequest {
    method: string;
    uri?: string;
    /** The `Mcp-Session-Id` the client sent back, if any. */
    sessionId: string | null;
    protocolVersion: string | null;
}

/**
 * The column the fixture treats as the account key.
 *
 * At the WIRE level there is no such concept: a row is a record from column name to
 * scalar, and which column identifies an account is a mapping decision made in
 * Step 2a. This constant exists only so the `duplicateAccountKey` and
 * `rowWithoutAccountKey` faults have something to manipulate, and so a later step's
 * test can name the column it mapped.
 */
export const KEY_COLUMN = 'LOGIN_NAME';

const BASE_COLUMNS = [
    { name: KEY_COLUMN, type: 'string' as const, nullable: false },
    { name: 'DISPLAY_NAME', type: 'string' as const, nullable: true },
    { name: 'EMAIL_ADDR', type: 'string' as const, nullable: true },
    { name: 'DEPT_CODE', type: 'string' as const, nullable: true },
    { name: 'JOB_TITLE', type: 'string' as const, nullable: true },
    { name: 'STATUS_FLAG', type: 'string' as const, nullable: true },
    { name: 'CREATED_ON', type: 'date' as const, nullable: true },
    { name: 'ROLE_ADMIN', type: 'boolean' as const, nullable: true },
];

/** A column that appears only after `schemaDrift` — the added one a drift test sees. */
const DRIFT_COLUMN = { name: 'COST_CENTRE', type: 'string' as const, nullable: true };

/**
 * A declared column that no caller may request.
 *
 * `PASSWORD_HASH` matches the denylist's `hash` alternative as well as `pass`, so
 * a test using it proves the pattern rather than one literal.
 */
const DENIED_COLUMN = { name: 'PASSWORD_HASH', type: 'string' as const, nullable: true };

/**
 * A credential-shaped value for the `secretShapedValue` fault.
 *
 * Deliberately a RECOGNISABLE SHAPE rather than a real pattern from the AI Guard's
 * table: this is a fixture, and a fixture carrying something that looks like a live
 * key invites exactly one bad afternoon. It is long, high-entropy-looking and
 * prefixed, which is what a detector keys on.
 */
const SECRET_SHAPED = 'sk-live-FAKEFIXTURE000000000000000000000000000000000000';

function jsonRpcResult(id: unknown, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export interface LegacyMcpFakeServer {
    /** The injected `fetch` for the Step 1b client. */
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
    /** Every request the client made, in order. Proves no `tools/*` call was sent. */
    requests: LoggedRequest[];
    setFault(name: FaultName, on: boolean): void;
    /** Advance to the next pull, so drift and torn-snapshot faults differ across pulls. */
    nextPull(): void;
    /** The snapshot id this pull is serving. */
    snapshotId(): string;
    /** The columns this pull advertises. */
    columns(): ReadonlyArray<{ name: string; type: string; nullable: boolean }>;
    sessionId: string;
}

export function createLegacyMcpFakeServer(opts: FakeServerOptions = {}): LegacyMcpFakeServer {
    const accounts = opts.accounts ?? 7;
    const rowsPerPage = opts.rowsPerPage ?? 3;
    const faults: Partial<Record<FaultName, boolean>> = { ...(opts.faults ?? {}) };
    const slowMs = opts.slowMs ?? 50;
    const redirectTo = opts.redirectTo ?? 'http://169.254.169.254/latest/meta-data/';
    const requests: LoggedRequest[] = [];
    const sessionId = 'fake-session-0001';
    let pull = 1;

    const on = (f: FaultName) => faults[f] === true;
    const snapshotId = () => `snap-${pull}`;
    const columns = () => {
        const base = on('schemaDrift') && pull > 1 ? [...BASE_COLUMNS, DRIFT_COLUMN] : BASE_COLUMNS;
        return opts.declaresDeniedColumn ? [...base, DENIED_COLUMN] : base;
    };
    const pageCount = () => Math.max(1, Math.ceil(accounts / rowsPerPage));

    /** The conforming row for account `i`, before any projection or fault. */
    function rowFor(i: number): LegacyRow {
        const row: LegacyRow = {
            [KEY_COLUMN]: `user${i}`,
            DISPLAY_NAME: `User ${i} Example`,
            EMAIL_ADDR: `user${i}@example.test`,
            DEPT_CODE: i % 2 === 0 ? 'FIN' : 'OPS',
            JOB_TITLE: i % 3 === 0 ? 'Analyst' : 'Clerk',
            STATUS_FLAG: i % 5 === 0 ? 'D' : 'A',
            CREATED_ON: '2021-03-04',
            ROLE_ADMIN: i === 1,
        };
        if (on('schemaDrift') && pull > 1) row[DRIFT_COLUMN.name] = 'CC-100';
        return row;
    }

    /** `?fields=` is a PROJECTION: the server returns these columns and no others. */
    function project(row: LegacyRow, fields: readonly string[]): LegacyRow {
        if (fields.length === 0) return row;
        const out: LegacyRow = {};
        for (const f of fields) if (f in row) out[f] = row[f];
        // Oversharing is the server ignoring the projection it was given. Added AFTER
        // the projection so the extra column is unmistakably unrequested.
        if (on('oversharing')) {
            out.SSN_LAST4 = '1234';
            out.HOME_PHONE = '+359700000000';
        }
        return out;
    }

    function rowsForPage(page: number, fields: readonly string[]): LegacyRow[] {
        const start = (page - 1) * rowsPerPage + 1;
        const end = Math.min(start + rowsPerPage - 1, accounts);
        const rows: LegacyRow[] = [];
        for (let i = start; i <= end; i++) rows.push(project(rowFor(i), fields));

        if (page === 1 && rows.length > 0) {
            if (on('duplicateAccountKey')) {
                // The SAME key twice in one page. An upsert would silently collapse
                // these two accounts into one, which is why the pull must refuse.
                rows.push({ ...rows[0] });
            }
            if (on('rowWithoutAccountKey')) {
                const { [KEY_COLUMN]: _dropped, ...rest } = rows[0];
                rows.push(rest as LegacyRow);
            }
            if (on('secretShapedValue')) {
                rows.push(project({ ...rowFor(accounts + 1), JOB_TITLE: SECRET_SHAPED }, fields));
            }
        }
        if (on('oversizedPage')) {
            // Past any sane byte cap. The client must abort mid-stream rather than
            // buffer this, so the assertion is about WHERE it stops, not what it parses.
            const filler = 'x'.repeat(LIMITS.MAX_CELL_LENGTH);
            for (let i = 0; i < 4_000; i++) rows.push({ [KEY_COLUMN]: `pad${i}`, DISPLAY_NAME: filler });
        }
        return rows;
    }

    function manifestBody() {
        return {
            contract: CONTRACT_VERSION,
            app: { name: 'Mainframe Payroll', owner: 'Finance Systems' },
            snapshot: {
                id: snapshotId(),
                generatedAt: '2026-10-08T06:00:00.000Z',
                rowCount: accounts,
            },
            columns: columns(),
            pages: Array.from({ length: pageCount() }, (_, i) => `inflect-access://accounts/${i + 1}`),
            layout: 'wide' as const,
        };
    }

    async function handle(req: Request): Promise<Response> {
        if (on('redirect')) {
            return new Response(null, { status: 302, headers: { location: redirectTo } });
        }
        if (on('slowResponse')) await new Promise((r) => setTimeout(r, slowMs));

        const body = (await req.json().catch(() => null)) as
            | { id?: unknown; method?: string; params?: { uri?: string } }
            | null;
        const method = body?.method ?? '<unparseable>';
        requests.push({
            method,
            uri: body?.params?.uri,
            sessionId: req.headers.get('mcp-session-id'),
            protocolVersion: req.headers.get('mcp-protocol-version'),
        });

        if (on('malformedJson')) {
            return new Response('{"jsonrpc":"2.0",', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (on('serverSentEvents')) {
            return new Response('event: message' + String.fromCharCode(10) + 'data: {}' + String.fromCharCode(10, 10), {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        }

        const json = (payload: string) =>
            new Response(payload, {
                status: 200,
                headers: { 'content-type': 'application/json', 'mcp-session-id': sessionId },
            });

        // ---- the conforming path -------------------------------------
        if (method === 'initialize') {
            return json(
                jsonRpcResult(body?.id, {
                    protocolVersion: on('unsupportedProtocolVersion') ? '1999-01-01' : PROTOCOL_VERSION,
                    // RESOURCES ONLY. A conforming server advertises no tools; the
                    // `toolsAdvertised` fault exists to prove the client still never
                    // calls one even when they are offered.
                    capabilities: on('toolsAdvertised') ? { resources: {}, tools: {} } : { resources: {} },
                    serverInfo: { name: 'legacy-access-fake', version: '1.0.0' },
                }),
            );
        }
        if (method === 'notifications/initialized') {
            // A notification has no id and no result.
            return new Response(null, { status: 202, headers: { 'mcp-session-id': sessionId } });
        }
        if (method === 'resources/read') {
            const uri = body?.params?.uri ?? '';
            if (uri === MANIFEST_URI) {
                return json(
                    jsonRpcResult(body?.id, {
                        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(manifestBody()) }],
                    }),
                );
            }
            const parsed = parseAccountsUri(uri);
            if (!parsed) {
                return json(JSON.stringify({ jsonrpc: '2.0', id: body?.id, error: { code: -32602, message: 'unknown resource' } }));
            }
            const pageSnapshot = on('tornSnapshot') && parsed.page > 1 ? `snap-${pull}-torn` : snapshotId();
            return json(
                jsonRpcResult(body?.id, {
                    contents: [
                        {
                            uri,
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                snapshotId: pageSnapshot,
                                page: parsed.page,
                                rows: rowsForPage(parsed.page, parsed.fields),
                            }),
                        },
                    ],
                }),
            );
        }
        return json(JSON.stringify({ jsonrpc: '2.0', id: body?.id, error: { code: -32601, message: 'method not found' } }));
    }

    return {
        fetch: async (input, init) => {
            const req = input instanceof Request ? input : new Request(input, init);
            return handle(req);
        },
        requests,
        setFault: (name, value) => {
            faults[name] = value;
        },
        nextPull: () => {
            pull += 1;
        },
        snapshotId,
        columns,
        sessionId,
    };
}
