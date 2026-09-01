/**
 * The audit extension `src/lib/prisma.ts` composes onto every client, and the
 * slow-query listener beside it.
 *
 * Both are module-private (`buildAuditExtension`, `parseModelFromSql`, the
 * `$on('query')` closure) and neither has a test. They are reachable the same
 * way the real client reaches them: mock `@prisma/client` with a double whose
 * `$extends` / `$on` record what the module registers, then drive the
 * registered handlers directly.
 *
 * What the branches decide is the shape of the audit row — which is the
 * evidence artefact this product sells. A `createMany` recorded as
 * `entityId: 'unknown'` with no count, an `updateMany` whose `filterKeys`
 * never lands, or an `upsert` diffed off `args.data` (which upserts do not
 * have) are all invisible at runtime: the write succeeds and the audit trail
 * is quietly wrong.
 */

// ─── Recording doubles for the Prisma client ──────────────────────────

interface QueryEvent {
    query: string;
    params: string;
    duration: number;
}
type QueryListener = (e: QueryEvent) => void;
interface ExtensionConfig {
    name: string;
    query: { $allModels: Record<string, OperationHandler> };
}
type HandlerParams = {
    model: string;
    operation: string;
    args: Record<string, unknown>;
    query: (a: Record<string, unknown>) => Promise<unknown>;
};
type OperationHandler = (p: HandlerParams) => Promise<unknown>;

const queryListeners: QueryListener[] = [];
const extensionConfigs: ExtensionConfig[] = [];

jest.mock('@prisma/adapter-pg', () => ({
    PrismaPg: class PrismaPg {
        constructor(_cfg: { connectionString: string }) { /* no pool in tests */ }
    },
}));

jest.mock('@prisma/client', () => ({
    PrismaClient: class PrismaClient {
        $on(event: string, cb: QueryListener): void {
            if (event === 'query') queryListeners.push(cb);
        }
        $extends(cfg: ExtensionConfig): this {
            extensionConfigs.push(cfg);
            return this;
        }
    },
}));

// The other four extensions in the compose chain are somebody else's tests.
// Identity stubs keep this suite pointed at the audit extension alone.
jest.mock('@/lib/soft-delete', () => ({ withSoftDeleteExtension: <T>(c: T): T => c }));
jest.mock('@/lib/security/pii-middleware', () => ({ withPiiEncryptionExtension: <T>(c: T): T => c }));
jest.mock('@/lib/db/encryption-middleware', () => ({ withEncryptionExtension: <T>(c: T): T => c }));
jest.mock('@/lib/db/rls-middleware', () => ({ withRlsTripwireExtension: <T>(c: T): T => c }));

const loggerWarn = jest.fn<void, [string, Record<string, unknown>?]>();
const loggerInfo = jest.fn<void, [string, Record<string, unknown>?]>();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (m: string, f?: Record<string, unknown>) => loggerWarn(m, f),
        info: (m: string, f?: Record<string, unknown>) => loggerInfo(m, f),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const recordSlowQueryMock = jest.fn<void, [string]>();
jest.mock('@/lib/observability/metrics', () => ({
    recordSlowQuery: (model: string) => recordSlowQueryMock(model),
}));

const auditContext: { tenantId?: string; actorUserId?: string; requestId?: string; source?: string } = {};
jest.mock('@/lib/audit-context', () => ({
    getAuditContext: () => ({ ...auditContext }),
}));

interface AuditEntry {
    tenantId: string;
    userId: string | null;
    actorType: string;
    entity: string;
    entityId: string;
    action: string;
    requestId: string | null;
    recordIds: { count: number } | null;
    metadataJson: Record<string, unknown>;
    diffJson: { changedFields: string[]; after: Record<string, unknown> } | null;
    detailsJson: Record<string, unknown>;
}
const appendAuditEntryMock = jest.fn<Promise<void>, [AuditEntry]>(
    (): Promise<void> => Promise.resolve(),
);
jest.mock('@/lib/audit/audit-writer', () => ({
    appendAuditEntry: (input: AuditEntry): Promise<void> => appendAuditEntryMock(input),
}));

// Importing for the module-load side effects: building the client registers
// the `$on('query')` listener and pushes the audit extension config.
import '@/lib/prisma';

// ─── Accessors over what the module registered ────────────────────────

function auditExtension(): ExtensionConfig {
    const cfg = extensionConfigs.find((c) => c.name === 'audit-middleware');
    if (!cfg) throw new Error('prisma.ts registered no audit-middleware extension');
    return cfg;
}

/** The registered handler for one Prisma operation. */
function op(name: string): OperationHandler {
    const handler = auditExtension().query.$allModels[name];
    if (!handler) throw new Error(`audit extension registered no "${name}" handler`);
    return handler;
}

function slowQueryListener(): QueryListener {
    if (queryListeners.length === 0) throw new Error('no query listener registered');
    return queryListeners[0];
}

/** The single audit row this operation produced. Throws if there was not exactly one. */
function soleAuditEntry(): AuditEntry {
    const calls = appendAuditEntryMock.mock.calls;
    if (calls.length !== 1) {
        throw new Error(`expected exactly 1 audit entry, saw ${calls.length}`);
    }
    return calls[0][0];
}

beforeEach(() => {
    appendAuditEntryMock.mockClear();
    appendAuditEntryMock.mockImplementation((): Promise<void> => Promise.resolve());
    loggerWarn.mockClear();
    loggerInfo.mockClear();
    recordSlowQueryMock.mockClear();
    for (const k of Object.keys(auditContext)) {
        delete auditContext[k as keyof typeof auditContext];
    }
    auditContext.tenantId = 'tenant-A';
    auditContext.actorUserId = 'user-1';
    auditContext.requestId = 'req-1';
    auditContext.source = 'api';
});

// ══════════════════════════════════════════════════════════════════════
// The three passthrough gates
// ══════════════════════════════════════════════════════════════════════

describe('audit extension — operations it must not audit', () => {
    it('writes no audit row for the AuditLog model itself', async () => {
        // The recursion guard. Without it, appending an audit row triggers the
        // extension again, which appends another — a write amplification that
        // only shows up under load.
        const query = jest.fn(async (): Promise<unknown> => ({ id: 'a1' }));
        const result = await op('create')({
            model: 'AuditLog',
            operation: 'create',
            args: { data: { entity: 'Risk' } },
            query,
        });

        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(result).toStrictEqual({ id: 'a1' });
    });

    it('writes no audit row when there is no ambient tenant', async () => {
        // A tenant-less write is seed / migration / bootstrap traffic. The
        // audit row is tenant-scoped, so there is nowhere to put it.
        delete auditContext.tenantId;
        const query = jest.fn(async (): Promise<unknown> => ({ id: 'r1' }));

        await op('create')({
            model: 'Risk',
            operation: 'create',
            args: { data: { title: 'T' } },
            query,
        });

        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('writes no audit row for an operation outside the write set', async () => {
        const query = jest.fn(async (): Promise<unknown> => []);
        await op('create')({
            model: 'Risk',
            operation: 'findMany',
            args: { where: { status: 'OPEN' } },
            query,
        });

        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('DOES audit an ordinary tenant-scoped create — the positive control', async () => {
        const query = jest.fn(async (): Promise<unknown> => ({ id: 'r1' }));
        await op('create')({
            model: 'Risk',
            operation: 'create',
            args: { data: { title: 'T' } },
            query,
        });

        expect(soleAuditEntry()).toMatchObject({
            tenantId: 'tenant-A',
            userId: 'user-1',
            requestId: 'req-1',
            entity: 'Risk',
            entityId: 'r1',
            action: 'CREATE',
            actorType: 'SYSTEM',
        });
    });
});

// ══════════════════════════════════════════════════════════════════════
// entityId / recordIds, per operation family
// ══════════════════════════════════════════════════════════════════════

describe('audit extension — how each operation names the row it touched', () => {
    it('takes the id off the returned row for a single-row write', async () => {
        await op('update')({
            model: 'Risk',
            operation: 'update',
            args: { where: { id: 'r9' }, data: { title: 'new' } },
            query: async (): Promise<unknown> => ({ id: 'r9', title: 'new' }),
        });

        const entry = soleAuditEntry();
        expect(entry.entityId).toBe('r9');
        expect(entry.recordIds).toBeNull();
        expect(entry.detailsJson.summary).toBe('UPDATE Risk r9');
    });

    it('falls back to "unknown" — and drops it from the summary — when the row has no id', async () => {
        // `delete` on some models returns a row without `id` selected. The
        // summary must not read "DELETE Risk undefined".
        await op('delete')({
            model: 'Risk',
            operation: 'delete',
            args: { where: { key: 'k' } },
            query: async (): Promise<unknown> => ({ key: 'k' }),
        });

        const entry = soleAuditEntry();
        expect(entry.entityId).toBe('unknown');
        expect(entry.detailsJson.summary).toBe('DELETE Risk');
    });

    it('records a createMany as a counted batch, not as a row', async () => {
        await op('createMany')({
            model: 'Risk',
            operation: 'createMany',
            args: { data: [{ title: 'a' }, { title: 'b' }] },
            query: async (): Promise<unknown> => ({ count: 2 }),
        });

        const entry = soleAuditEntry();
        expect(entry.entityId).toBe('batch');
        expect(entry.recordIds).toStrictEqual({ count: 2 });
    });

    it('records a batch count of 0 when the driver returns no count', async () => {
        // What bites here is the coercion itself, not the choice of operator:
        // `?? 0` and `|| 0` are indistinguishable on this input (both yield 0
        // for `undefined` and for 0). Drop the coercion entirely and the entry
        // becomes `{ count: undefined }`, which serialises the recordIds column
        // as `{}` — an audit row that no longer says a bulk delete happened.
        await op('deleteMany')({
            model: 'Risk',
            operation: 'deleteMany',
            args: { where: { status: 'CLOSED' } },
            query: async (): Promise<unknown> => null,
        });

        expect(soleAuditEntry().recordIds).toStrictEqual({ count: 0 });
    });

    it('records the FILTER KEYS of a bulk update, never the filter values', async () => {
        // The keys say what the bulk write was scoped by; the values could be
        // anything, including encrypted business content.
        await op('updateMany')({
            model: 'Risk',
            operation: 'updateMany',
            args: {
                where: { status: 'OPEN', ownerId: 'user-77' },
                data: { status: 'CLOSED' },
            },
            query: async (): Promise<unknown> => ({ count: 5 }),
        });

        const entry = soleAuditEntry();
        expect(entry.metadataJson).toStrictEqual({
            source: 'api',
            filterKeys: ['status', 'ownerId'],
        });
        expect(JSON.stringify(entry.metadataJson)).not.toContain('user-77');
    });

    it('does NOT attach filterKeys to a single-row update that also has a where', async () => {
        await op('update')({
            model: 'Risk',
            operation: 'update',
            args: { where: { id: 'r1' }, data: { title: 'x' } },
            query: async (): Promise<unknown> => ({ id: 'r1' }),
        });

        expect(soleAuditEntry().metadataJson).toStrictEqual({ source: 'api' });
    });

    it('defaults the source label to "api" when the context omits it', async () => {
        delete auditContext.source;
        delete auditContext.actorUserId;
        delete auditContext.requestId;

        await op('create')({
            model: 'Risk',
            operation: 'create',
            args: { data: { title: 'T' } },
            query: async (): Promise<unknown> => ({ id: 'r1' }),
        });

        const entry = soleAuditEntry();
        expect(entry.metadataJson).toStrictEqual({ source: 'api' });
        expect(entry.userId).toBeNull();
        expect(entry.requestId).toBeNull();
    });

    it('carries a non-api source label through to the audit row', async () => {
        auditContext.source = 'job';
        await op('create')({
            model: 'Risk',
            operation: 'create',
            args: { data: { title: 'T' } },
            query: async (): Promise<unknown> => ({ id: 'r1' }),
        });

        expect(soleAuditEntry().metadataJson).toStrictEqual({ source: 'job' });
    });
});

// ══════════════════════════════════════════════════════════════════════
// The diff
// ══════════════════════════════════════════════════════════════════════

describe('audit extension — the changed-field diff', () => {
    it('diffs an update against the RETURNED row, redacting sensitive fields', async () => {
        await op('update')({
            model: 'User',
            operation: 'update',
            args: { where: { id: 'u1' }, data: { name: 'Ada', passwordHash: 'raw' } },
            query: async (): Promise<unknown> => ({
                id: 'u1',
                name: 'Ada',
                passwordHash: '$2b$hash',
            }),
        });

        const entry = soleAuditEntry();
        expect(entry.diffJson?.changedFields).toStrictEqual(['name', 'passwordHash']);
        expect(entry.diffJson?.after.name).toBe('Ada');
        expect(entry.diffJson?.after.passwordHash).not.toBe('$2b$hash');
        expect(entry.detailsJson.changedFields).toStrictEqual(['name', 'passwordHash']);
    });

    it('diffs an UPSERT off args.update — upserts have no args.data', async () => {
        // The single most consequential branch in this file. Reading
        // `args.data` for an upsert yields undefined, `buildDiffJson` returns
        // null, and every upsert in the product silently audits with no diff.
        await op('upsert')({
            model: 'Risk',
            operation: 'upsert',
            args: {
                where: { id: 'r1' },
                create: { title: 'created title' },
                update: { title: 'updated title' },
            },
            query: async (): Promise<unknown> => ({ id: 'r1', title: 'updated title' }),
        });

        const entry = soleAuditEntry();
        expect(entry.diffJson).toStrictEqual({
            changedFields: ['title'],
            after: { title: 'updated title' },
        });
    });

    it('omits a changed field the returned row does not carry', async () => {
        // `field in result` is the gate. Without it the `after` object gains a
        // key whose value is undefined, which JSON-serialises away and leaves
        // the changedFields list disagreeing with the after block.
        await op('update')({
            model: 'Risk',
            operation: 'update',
            args: { where: { id: 'r1' }, data: { title: 'x', notSelected: 'y' } },
            query: async (): Promise<unknown> => ({ id: 'r1', title: 'x' }),
        });

        const entry = soleAuditEntry();
        expect(entry.diffJson?.changedFields).toStrictEqual(['title', 'notSelected']);
        expect(Object.keys(entry.diffJson?.after ?? {})).toStrictEqual(['title']);
    });

    it('attaches NO diff to a create — a create has no before state to differ from', async () => {
        await op('create')({
            model: 'Risk',
            operation: 'create',
            args: { data: { title: 'T' } },
            query: async (): Promise<unknown> => ({ id: 'r1', title: 'T' }),
        });

        const entry = soleAuditEntry();
        expect(entry.diffJson).toBeNull();
        expect(entry.detailsJson).not.toHaveProperty('changedFields');
        expect(entry.detailsJson).not.toHaveProperty('after');
    });

    it('attaches no diff when the update payload is entirely Prisma internals', async () => {
        await op('update')({
            model: 'Risk',
            operation: 'update',
            args: { where: { id: 'r1' }, data: { _count: 1 } },
            query: async (): Promise<unknown> => ({ id: 'r1' }),
        });

        expect(soleAuditEntry().diffJson).toBeNull();
    });

    it('attaches no diff when an update carries no data at all', async () => {
        await op('update')({
            model: 'Risk',
            operation: 'update',
            args: { where: { id: 'r1' } },
            query: async (): Promise<unknown> => ({ id: 'r1' }),
        });

        expect(soleAuditEntry().diffJson).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════════════════
// Audit failure must never fail the write
// ══════════════════════════════════════════════════════════════════════

describe('audit extension — when the audit write itself fails', () => {
    it('still returns the query result to the caller', async () => {
        // The write already committed. Rethrowing here would surface a
        // successful mutation to the caller as a failure, and the retry would
        // duplicate the row.
        appendAuditEntryMock.mockImplementation(
            (): Promise<void> => Promise.reject(new Error('audit chain broken')),
        );

        const result = await op('create')({
            model: 'Risk',
            operation: 'create',
            args: { data: { title: 'T' } },
            query: async (): Promise<unknown> => ({ id: 'r1', title: 'T' }),
        });

        expect(result).toStrictEqual({ id: 'r1', title: 'T' });
    });

    it('stays silent about the failure outside development', async () => {
        // NODE_ENV is set explicitly rather than relied on: the env mock reads
        // process.env first, so an assertion against its fallback would depend
        // on the var being unset.
        const savedNodeEnv = process.env.NODE_ENV;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        appendAuditEntryMock.mockImplementation(
            (): Promise<void> => Promise.reject(new Error('audit chain broken')),
        );

        try {
            await op('create')({
                model: 'Risk',
                operation: 'create',
                args: { data: { title: 'T' } },
                query: async (): Promise<unknown> => ({ id: 'r1' }),
            });
        } finally {
            (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
        }

        expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('logs the reason in development, without the row payload', async () => {
        const savedNodeEnv = process.env.NODE_ENV;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        appendAuditEntryMock.mockImplementation(
            (): Promise<void> => Promise.reject(new Error('audit chain broken')),
        );

        try {
            await op('create')({
                model: 'Risk',
                operation: 'create',
                args: { data: { title: 'a very secret title' } },
                query: async (): Promise<unknown> => ({ id: 'r1' }),
            });
        } finally {
            (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
        }

        expect(loggerWarn).toHaveBeenCalledWith('Failed to write audit log', {
            component: 'audit-middleware',
            error: 'audit chain broken',
        });
    });

    it('stringifies a non-Error rejection instead of reading .message off it', async () => {
        const savedNodeEnv = process.env.NODE_ENV;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        appendAuditEntryMock.mockImplementation(
            (): Promise<void> => Promise.reject('plain string rejection'),
        );

        try {
            await op('create')({
                model: 'Risk',
                operation: 'create',
                args: { data: { title: 'T' } },
                query: async (): Promise<unknown> => ({ id: 'r1' }),
            });
        } finally {
            (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
        }

        expect(loggerWarn).toHaveBeenCalledWith('Failed to write audit log', {
            component: 'audit-middleware',
            error: 'plain string rejection',
        });
    });
});

// ══════════════════════════════════════════════════════════════════════
// The slow-query listener
// ══════════════════════════════════════════════════════════════════════

describe('slow-query listener', () => {
    it('says nothing for a query at or under the 50 ms threshold', async () => {
        slowQueryListener()({ query: 'SELECT * FROM "Risk"', params: '[]', duration: 50 });
        expect(recordSlowQueryMock).not.toHaveBeenCalled();
        expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('labels a slow SELECT with the table it read', () => {
        slowQueryListener()({
            query: 'SELECT "public"."Risk"."id" FROM "Risk" WHERE "tenantId" = $1',
            params: '["tenant-A"]',
            duration: 51,
        });

        expect(recordSlowQueryMock).toHaveBeenCalledWith('Risk');
    });

    it.each([
        ['INSERT INTO "Evidence" ("id") VALUES ($1)', 'Evidence'],
        ['UPDATE "Control" SET "status" = $1', 'Control'],
        ['SELECT 1 FROM "A" INNER JOIN "Finding" ON true', 'A'],
    ])('parses the model out of %s', (sql: string, model: string) => {
        slowQueryListener()({ query: sql, params: '[]', duration: 999 });
        expect(recordSlowQueryMock).toHaveBeenCalledWith(model);
    });

    it('labels an unparseable statement "unknown" rather than dropping the signal', () => {
        // A metric label of `unknown` is still a slow query somebody can chase;
        // an early return here would make the whole class invisible.
        slowQueryListener()({ query: 'BEGIN', params: '[]', duration: 400 });
        expect(recordSlowQueryMock).toHaveBeenCalledWith('unknown');
    });

    it('truncates the logged statement and params so a slow query cannot dump a row', () => {
        const longQuery = `SELECT * FROM "Risk" WHERE note = '${'x'.repeat(2_000)}'`;
        const longParams = `[${'"p",'.repeat(500)}"p"]`;

        slowQueryListener()({ query: longQuery, params: longParams, duration: 120 });

        expect(loggerWarn).toHaveBeenCalledTimes(1);
        const fields = loggerWarn.mock.calls[0][1] as {
            query: string;
            params: string;
            durationMs: number;
        };
        expect(fields.query).toHaveLength(500);
        expect(fields.params).toHaveLength(200);
        expect(fields.durationMs).toBe(120);
    });
});
