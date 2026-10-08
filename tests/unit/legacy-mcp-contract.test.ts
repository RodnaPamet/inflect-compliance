/**
 * The contract, its schemas, and the reference server that serves it.
 *
 * WHY THESE LIVE IN ONE FILE. `docs/legacy-mcp-access-contract.md` names
 * `tests/helpers/legacy-mcp-fake-server.ts` as the normative reference
 * implementation. A document saying "build to this" and a fixture that quietly
 * stopped conforming would be worse than no reference at all, so the suite that
 * proves the schemas also proves the reference against them. The three artefacts
 * cannot drift apart without something here going red.
 *
 * There is no client yet — Step 1b builds it. These tests speak JSON-RPC to the
 * fake server directly.
 */
import {
    CONTRACT_VERSION,
    LIMITS,
    MANIFEST_URI,
    ManifestSchema,
    PageSchema,
    ColumnNameSchema,
    accountsUri,
    parseAccountsUri,
    isSupportedContract,
} from '@/lib/mcp/client/contract';
import {
    createLegacyMcpFakeServer,
    KEY_COLUMN,
    type FaultName,
    type LegacyMcpFakeServer,
} from '../helpers/legacy-mcp-fake-server';

// --- talking to the fake ---------------------------------------------

let nextId = 1;

async function rpc(server: LegacyMcpFakeServer, method: string, params?: unknown) {
    const res = await server.fetch('https://legacy.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    return res;
}

/** The decoded resource payload, or `null` when the body is not what we expect. */
async function readResource(server: LegacyMcpFakeServer, uri: string): Promise<unknown> {
    const res = await rpc(server, 'resources/read', { uri });
    const body = (await res.json()) as { result?: { contents?: Array<{ text?: string }> } };
    const text = body.result?.contents?.[0]?.text;
    return text === undefined ? null : JSON.parse(text);
}

async function initialize(server: LegacyMcpFakeServer) {
    const res = await rpc(server, 'initialize', { capabilities: {} });
    return (await res.json()) as {
        result?: { protocolVersion?: string; capabilities?: Record<string, unknown> };
    };
}

// --- the conforming path --------------------------------------------

describe('the reference server conforms to the schemas', () => {
    it('serves a manifest that validates', async () => {
        const server = createLegacyMcpFakeServer();
        const manifest = ManifestSchema.parse(await readResource(server, MANIFEST_URI));
        expect(manifest.contract).toBe(CONTRACT_VERSION);
        expect(manifest.columns.map((c) => c.name)).toContain(KEY_COLUMN);
        expect(manifest.pages).toHaveLength(3); // 7 accounts, 3 per page
    });

    it('serves every page, and each one validates', async () => {
        const server = createLegacyMcpFakeServer();
        const manifest = ManifestSchema.parse(await readResource(server, MANIFEST_URI));
        let seen = 0;
        for (const uri of manifest.pages) {
            const page = PageSchema.parse(await readResource(server, uri));
            // THE TORN-READ CHECK, which is the contract's central integrity rule.
            expect(page.snapshotId).toBe(manifest.snapshot.id);
            seen += page.rows.length;
        }
        expect(seen).toBe(manifest.snapshot.rowCount);
    });

    it('honours ?fields= as a projection, returning those columns and no others', async () => {
        const server = createLegacyMcpFakeServer();
        const page = PageSchema.parse(
            await readResource(server, accountsUri(1, [KEY_COLUMN, 'EMAIL_ADDR'])),
        );
        expect(page.rows.length).toBeGreaterThan(0);
        for (const row of page.rows) {
            expect(Object.keys(row).sort()).toEqual([KEY_COLUMN, 'EMAIL_ADDR'].sort());
        }
    });

    it('advertises resources and no tools', async () => {
        const server = createLegacyMcpFakeServer();
        const { result } = await initialize(server);
        expect(result?.capabilities).toEqual({ resources: {} });
        expect(result?.protocolVersion).toBe('2025-06-18');
    });

    it('issues a session id the client can echo', async () => {
        const server = createLegacyMcpFakeServer();
        const res = await rpc(server, 'initialize', { capabilities: {} });
        expect(res.headers.get('mcp-session-id')).toBe(server.sessionId);
    });
});

// --- every fault is observable ---------------------------------------

/**
 * THE POPULATION CHECK for the faults.
 *
 * Thirteen are named in the step. A fault that existed in the type but did nothing
 * would make its test pass by vacuity and leave a later step's "the client refuses
 * X" assertion resting on a server that never did X. So each is switched on and
 * something observable has to change.
 */
const ALL_FAULTS: readonly FaultName[] = [
    'tornSnapshot', 'oversharing', 'oversizedPage', 'slowResponse', 'malformedJson',
    'serverSentEvents', 'unsupportedProtocolVersion', 'toolsAdvertised', 'redirect',
    'schemaDrift', 'duplicateAccountKey', 'rowWithoutAccountKey', 'secretShapedValue',
];

describe('the fault injector', () => {
    it('declares exactly the thirteen faults the step names', () => {
        expect(ALL_FAULTS).toHaveLength(13);
        expect(new Set(ALL_FAULTS).size).toBe(13);
    });

    it('torn snapshot: a later page reports a different snapshotId', async () => {
        const server = createLegacyMcpFakeServer({ faults: { tornSnapshot: true } });
        const manifest = ManifestSchema.parse(await readResource(server, MANIFEST_URI));
        const page2 = PageSchema.parse(await readResource(server, manifest.pages[1]));
        expect(page2.snapshotId).not.toBe(manifest.snapshot.id);
    });

    it('oversharing: rows carry columns the projection did not request', async () => {
        const server = createLegacyMcpFakeServer({ faults: { oversharing: true } });
        const page = PageSchema.parse(await readResource(server, accountsUri(1, [KEY_COLUMN])));
        const extra = Object.keys(page.rows[0]).filter((k) => k !== KEY_COLUMN);
        expect(extra.length).toBeGreaterThan(0);
    });

    it('oversized page: the body far exceeds the client byte cap', async () => {
        const server = createLegacyMcpFakeServer({ faults: { oversizedPage: true } });
        const res = await rpc(server, 'resources/read', { uri: accountsUri(1) });
        const bytes = (await res.text()).length;
        expect(bytes).toBeGreaterThan(LIMITS.MAX_ROWS_PER_PAGE * LIMITS.MAX_CELL_LENGTH);
    });

    it('slow response: the server answers later than its deadline would allow', async () => {
        const server = createLegacyMcpFakeServer({ faults: { slowResponse: true }, slowMs: 120 });
        const started = Date.now();
        await rpc(server, 'initialize', { capabilities: {} });
        // Asserted as a LOWER bound on elapsed time, never an upper one: an upper
        // bound here would be a flake on a loaded machine, which is how a timing
        // assertion earns its reputation.
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    it('malformed json: a 200 whose body does not parse', async () => {
        const server = createLegacyMcpFakeServer({ faults: { malformedJson: true } });
        const res = await rpc(server, 'initialize', { capabilities: {} });
        expect(res.status).toBe(200);
        await expect(res.json()).rejects.toThrow();
    });

    it('server-sent events: the content type the contract forbids', async () => {
        const server = createLegacyMcpFakeServer({ faults: { serverSentEvents: true } });
        const res = await rpc(server, 'initialize', { capabilities: {} });
        expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('unsupported protocol version: a version the client does not speak', async () => {
        const server = createLegacyMcpFakeServer({ faults: { unsupportedProtocolVersion: true } });
        const { result } = await initialize(server);
        expect(result?.protocolVersion).toBe('1999-01-01');
    });

    it('tools advertised: capabilities include tools', async () => {
        const server = createLegacyMcpFakeServer({ faults: { toolsAdvertised: true } });
        const { result } = await initialize(server);
        expect(result?.capabilities).toHaveProperty('tools');
        // And the reason this fault exists: the request log stays free of tools/*.
        expect(server.requests.some((r) => r.method.startsWith('tools/'))).toBe(false);
    });

    it('redirect: a 302 pointing at another origin', async () => {
        const server = createLegacyMcpFakeServer({ faults: { redirect: true } });
        const res = await rpc(server, 'initialize', { capabilities: {} });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toContain('169.254.169.254');
    });

    it('schema drift: the column set changes between pulls', async () => {
        const server = createLegacyMcpFakeServer({ faults: { schemaDrift: true } });
        const before = ManifestSchema.parse(await readResource(server, MANIFEST_URI));
        server.nextPull();
        const after = ManifestSchema.parse(await readResource(server, MANIFEST_URI));
        expect(after.columns.length).toBe(before.columns.length + 1);
        expect(after.columns.map((c) => c.name)).toContain('COST_CENTRE');
    });

    it('duplicate account key: one page holds the same key twice', async () => {
        const server = createLegacyMcpFakeServer({ faults: { duplicateAccountKey: true } });
        const page = PageSchema.parse(await readResource(server, accountsUri(1)));
        const keys = page.rows.map((r) => r[KEY_COLUMN]);
        expect(new Set(keys).size).toBeLessThan(keys.length);
    });

    it('row without an account key: the key column is absent, not empty', async () => {
        const server = createLegacyMcpFakeServer({ faults: { rowWithoutAccountKey: true } });
        const page = PageSchema.parse(await readResource(server, accountsUri(1)));
        // ABSENT rather than null. A null would be a value a later step could key on
        // and reject; a missing property is the shape that gets silently skipped.
        expect(page.rows.some((r) => !(KEY_COLUMN in r))).toBe(true);
    });

    it('secret-shaped value: a cell holding something credential-shaped', async () => {
        const server = createLegacyMcpFakeServer({ faults: { secretShapedValue: true } });
        const page = PageSchema.parse(await readResource(server, accountsUri(1)));
        expect(page.rows.some((r) => String(r.JOB_TITLE ?? '').startsWith('sk-live-'))).toBe(true);
    });

    it('and with every fault off, the snapshot is clean — the control', async () => {
        // Without this, a server that was broken in some constant way would make the
        // thirteen tests above pass while nothing conformed.
        const server = createLegacyMcpFakeServer();
        const manifest = ManifestSchema.parse(await readResource(server, MANIFEST_URI));
        for (const uri of manifest.pages) {
            const page = PageSchema.parse(await readResource(server, uri));
            expect(page.snapshotId).toBe(manifest.snapshot.id);
            for (const row of page.rows) expect(KEY_COLUMN in row).toBe(true);
        }
        expect(server.requests.every((r) => !r.method.startsWith('tools/'))).toBe(true);
    });
});

// --- what the schemas refuse -----------------------------------------

describe('the schemas refuse what the contract forbids', () => {
    const base = {
        contract: CONTRACT_VERSION,
        app: { name: 'A', owner: 'B' },
        snapshot: { id: 's1', generatedAt: '2026-10-08T06:00:00.000Z', rowCount: 1 },
        columns: [{ name: 'C', type: 'string', nullable: true }],
        pages: ['inflect-access://accounts/1'],
        layout: 'wide',
    };

    it('an unknown contract version', () => {
        expect(ManifestSchema.safeParse({ ...base, contract: 'inflect-legacy-access/2' }).success).toBe(false);
        expect(isSupportedContract('inflect-legacy-access/2')).toBe(false);
        expect(isSupportedContract(CONTRACT_VERSION)).toBe(true);
    });

    it('an unknown key, because the envelope is strict', () => {
        // The reason strict matters: Zod's default would STRIP this and hand back a
        // clean object, so a server sending more than it should would look healthy.
        expect(ManifestSchema.safeParse({ ...base, extra: 'surprise' }).success).toBe(false);
    });

    it('more columns than the bound', () => {
        const columns = Array.from({ length: LIMITS.MAX_COLUMNS + 1 }, (_, i) => ({
            name: `C${i}`, type: 'string', nullable: true,
        }));
        expect(ManifestSchema.safeParse({ ...base, columns }).success).toBe(false);
    });

    it('a duplicate column name, which would make a row ambiguous', () => {
        const columns = [
            { name: 'SAME', type: 'string', nullable: true },
            { name: 'SAME', type: 'number', nullable: true },
        ];
        expect(ManifestSchema.safeParse({ ...base, columns }).success).toBe(false);
    });

    it('a column name past its length cap', () => {
        expect(ColumnNameSchema.safeParse('x'.repeat(LIMITS.MAX_COLUMN_NAME_LENGTH + 1)).success).toBe(false);
    });

    it.each([
        ['tab', 'emp\tid'],
        ['newline', 'emp\nid'],
        ['zero width', 'emp\u200Bid'],
        ['bidi override', 'emp\u202Eid'],
        ['byte order mark', '\uFEFFid'],
    ])('a column name carrying an invisible character: %s', (_label, name) => {
        // Rejected, never stripped: stripping renames a column, and two names
        // differing only by an invisible character would then collide — a mapping
        // that points at the wrong data.
        expect(ColumnNameSchema.safeParse(name).success).toBe(false);
    });

    it('but accepts the names a real legacy export uses', () => {
        for (const ok of ['LOGIN_NAME', 'Employee Number - legacy', 'HR.Employee_No', 'Иванов_ид']) {
            expect(ColumnNameSchema.safeParse(ok).success).toBe(true);
        }
    });

    it('a cell past its length cap, and a page past its row cap', () => {
        const big = { snapshotId: 's1', page: 1, rows: [{ C: 'x'.repeat(LIMITS.MAX_CELL_LENGTH + 1) }] };
        expect(PageSchema.safeParse(big).success).toBe(false);
        const many = {
            snapshotId: 's1', page: 1,
            rows: Array.from({ length: LIMITS.MAX_ROWS_PER_PAGE + 1 }, () => ({ C: 'v' })),
        };
        expect(PageSchema.safeParse(many).success).toBe(false);
    });

    it('a nested value, because cells are scalars on the wire', () => {
        expect(PageSchema.safeParse({ snapshotId: 's1', page: 1, rows: [{ C: { nested: true } }] }).success).toBe(false);
        expect(PageSchema.safeParse({ snapshotId: 's1', page: 1, rows: [{ C: ['a'] }] }).success).toBe(false);
    });
});

// --- URIs -------------------------------------------------------------

describe('page URIs round-trip', () => {
    it('builds and parses, with and without a projection', () => {
        expect(parseAccountsUri(accountsUri(2))).toEqual({ page: 2, fields: [] });
        expect(parseAccountsUri(accountsUri(2, ['A', 'B']))).toEqual({ page: 2, fields: ['A', 'B'] });
    });

    it('refuses a page number outside the bound, and anything not a page URI', () => {
        expect(parseAccountsUri('inflect-access://accounts/0')).toBeNull();
        expect(parseAccountsUri('inflect-access://accounts/99999')).toBeNull();
        expect(parseAccountsUri('inflect-access://manifest')).toBeNull();
        expect(parseAccountsUri('https://example.test/accounts/1')).toBeNull();
    });
});
