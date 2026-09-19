/**
 * `eraseUser` — the irreversible half of DSAR (#2287 Stage 3).
 *
 * WHAT THIS ADDS TO THE PROBE. `tests/guardrails/dsar-workflow-coverage.test.ts`
 * drives the real `eraseUser` through the in-memory oracle in
 * `tests/helpers/dsar-erasure-probe.ts` and grades the RESULT: rows survived,
 * the subject is gone from them, the chain is intact, nobody else moved. That
 * is the GDPR invariant and it is the more important of the two.
 *
 * It cannot see three things, because its client cannot fail:
 *
 *   1. ORDER. The probe's store ends up the same whether the audit rows are
 *      pseudonymized before the `User` row is deleted or after — but on a real
 *      database it is not the same at all. `AuditLog.userId` is ON DELETE SET
 *      NULL, so deleting the subject first would let the DATABASE null those
 *      rows as a side effect of an FK action, and the explicit statement would
 *      then match nothing and report `auditRowsPseudonymized: 0`. Erasure
 *      would still look correct and its evidence would be wrong.
 *   2. ATOMICITY. Several `User`-referencing FKs are ON DELETE RESTRICT, so
 *      the hard delete genuinely can be refused. If the pseudonymization is
 *      not rolled back with it, the trail is permanently de-attributed for a
 *      user who still exists — permanently, because the narrowed
 *      `IMMUTABLE_AUDIT_LOG` trigger permits `userId` value -> NULL and
 *      nothing else. There is no statement that could put it back.
 *   3. THE DEFAULT PATH. The probe always passes `options.db`. Nothing there
 *      exercises the branch that resolves a client on its own — the branch
 *      that has to reach `runInGlobalContext`, because `app_user` has UPDATE
 *      on the audit table REVOKED and every tenant-path context drops to it.
 *
 * So these are behavioural tests with FAILING fakes, not a second reading of
 * the source.
 */
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import { runInGlobalContext } from '@/lib/db-context';

// Holder rather than a closed-over binding: a jest.mock factory may only
// reference out-of-scope identifiers whose name begins with `mock`.
const mockGlobalDbHolder: { db: unknown } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInGlobalContext: jest.fn(async (callback: (db: unknown) => Promise<unknown>) =>
        callback(mockGlobalDbHolder.db),
    ),
}));

const SUBJECT = 'user-subject-2287';

interface FakeDb {
    /** Every statement issued, in order, as `table:method`. */
    calls: string[];
    /** What SURVIVED the transaction. A rollback leaves this untouched. */
    committed: { auditRowsNulled: number; userDeleted: boolean };
    db: Parameters<typeof eraseUser>[1] extends { db?: infer D } ? D : never;
}

/**
 * A client whose `$transaction` really rolls back.
 *
 * Writes land in `staged` and are promoted to `committed` only when the
 * callback RESOLVES — which is the whole point: a fake that commits
 * unconditionally cannot tell an atomic erasure from a half-run one, and a
 * half-run one is the failure this file exists to catch.
 */
function makeFakeDb(
    options: { subjectVisible?: boolean; auditRows?: number; deleteError?: unknown } = {},
): FakeDb {
    const { subjectVisible = true, auditRows = 3, deleteError } = options;

    const calls: string[] = [];
    const committed = { auditRowsNulled: 0, userDeleted: false };
    let staged = { auditRowsNulled: 0, userDeleted: false };

    const delegates = {
        user: {
            async findUnique(args: { where: { id: string } }) {
                calls.push('user:findUnique');
                return subjectVisible && args.where.id === SUBJECT ? { id: SUBJECT } : null;
            },
            async delete(args: { where: { id: string } }) {
                calls.push('user:delete');
                if (deleteError) throw deleteError;
                staged.userDeleted = args.where.id === SUBJECT;
                return { id: args.where.id };
            },
        },
        auditLog: {
            async updateMany(args: { where: { userId: string }; data: { userId: null } }) {
                calls.push(`auditLog:updateMany:${JSON.stringify(args)}`);
                staged.auditRowsNulled = auditRows;
                return { count: auditRows };
            },
        },
    };

    const db = {
        ...delegates,
        async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
            calls.push('$transaction');
            staged = { auditRowsNulled: 0, userDeleted: false };
            const result = await fn(db);
            committed.auditRowsNulled = staged.auditRowsNulled;
            committed.userDeleted = staged.userDeleted;
            return result;
        },
    };

    return { calls, committed, db: db as FakeDb['db'] };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGlobalDbHolder.db = null;
});

describe('eraseUser — the cascade', () => {
    it('pseudonymizes the audit trail BEFORE deleting the subject', async () => {
        const fake = makeFakeDb();
        await eraseUser(SUBJECT, { db: fake.db });

        // The order is the assertion. Reversing these two lines in the
        // implementation leaves the probe oracle green and makes the receipt
        // lie on a real database, where AuditLog.userId is ON DELETE SET NULL.
        expect(fake.calls.map((c) => c.split(':').slice(0, 2).join(':'))).toEqual([
            '$transaction',
            'user:findUnique',
            'auditLog:updateMany',
            'user:delete',
        ]);
    });

    it('nulls userId for the subject ONLY, and writes no other column', async () => {
        const fake = makeFakeDb();
        await eraseUser(SUBJECT, { db: fake.db });

        const update = fake.calls.find((c) => c.startsWith('auditLog:updateMany:'))!;
        const args = JSON.parse(update.slice('auditLog:updateMany:'.length));
        // The trigger grades ONE ROW at a time against a SHAPE, so it cannot
        // tell the subject's rows from anybody else's. The `where` is the only
        // thing standing between erasure and anonymizing the whole table.
        expect(args.where).toEqual({ userId: SUBJECT });
        // And exactly one column moves — `to_jsonb(NEW) - 'userId' =
        // to_jsonb(OLD) - 'userId'` is the database half of this.
        expect(args.data).toEqual({ userId: null });
    });

    it('reports what it did, and that it deleted no audit rows', async () => {
        const fake = makeFakeDb({ auditRows: 7 });
        const receipt = await eraseUser(SUBJECT, { db: fake.db });

        expect(receipt).toEqual({
            userId: SUBJECT,
            auditRowsPseudonymized: 7,
            auditRowsDeleted: 0,
            userDeleted: true,
        });
        expect(fake.committed).toEqual({ auditRowsNulled: 7, userDeleted: true });
    });

    it('runs the whole cascade inside ONE transaction', async () => {
        const fake = makeFakeDb();
        await eraseUser(SUBJECT, { db: fake.db });
        expect(fake.calls.filter((c) => c === '$transaction')).toHaveLength(1);
        // …and every statement is inside it.
        expect(fake.calls[0]).toBe('$transaction');
    });
});

describe('eraseUser — the refusals', () => {
    it('refuses an empty subject id before opening a transaction', async () => {
        const fake = makeFakeDb();
        await expect(eraseUser('', { db: fake.db })).rejects.toThrow(/without a subject id/i);
        expect(fake.calls).toEqual([]);
    });

    it('refuses a subject it cannot see, rather than reporting an empty erasure', async () => {
        // A wrong column, a mistyped id, or a connection whose view is
        // narrowed makes every count zero — and an erasure that touched
        // nothing reports success. An absent subject and an unobservable one
        // produce identical output, so neither is believed.
        const fake = makeFakeDb({ subjectVisible: false });
        await expect(eraseUser(SUBJECT, { db: fake.db })).rejects.toThrow(
            /not visible to this connection/i,
        );
        expect(fake.calls).toEqual(['$transaction', 'user:findUnique']);
        expect(fake.committed).toEqual({ auditRowsNulled: 0, userDeleted: false });
    });

    it('rolls the pseudonymization BACK when a RESTRICT reference refuses the delete', async () => {
        // THE failure this file exists for. The pseudonymization has already
        // succeeded by the time the delete is refused; if it is not undone
        // with it, the trail is de-attributed for a user who still exists —
        // and the narrowed trigger permits value -> NULL only, so there is no
        // statement that could restore it.
        const p2003 = Object.assign(new Error('Foreign key constraint violated'), {
            code: 'P2003',
        });
        const fake = makeFakeDb({ deleteError: p2003 });

        await expect(eraseUser(SUBJECT, { db: fake.db })).rejects.toThrow(
            /refused by a reference to them/i,
        );
        // It ATTEMPTED the pseudonymization…
        expect(fake.calls.some((c) => c.startsWith('auditLog:updateMany'))).toBe(true);
        // …and nothing survived.
        expect(fake.committed).toEqual({ auditRowsNulled: 0, userDeleted: false });
    });

    it('sends the operator to planErasure rather than surfacing P2003', async () => {
        const fake = makeFakeDb({
            deleteError: Object.assign(new Error('Foreign key constraint violated on the (not available)'), {
                code: 'P2003',
            }),
        });
        const error = await eraseUser(SUBJECT, { db: fake.db }).catch((e: Error) => e);
        expect((error as Error).message).toMatch(/planErasure/);
        // The original is kept as the cause — the translation adds context, it
        // does not discard the database's own answer.
        expect(((error as Error).cause as { code?: string })?.code).toBe('P2003');
    });

    it('does NOT translate an error that is not a reference refusal', async () => {
        // A connection drop is not "resolve the blocking references", and
        // saying so would send an operator hunting for FKs that are fine.
        const boom = Object.assign(new Error('connection terminated'), { code: 'P1017' });
        const fake = makeFakeDb({ deleteError: boom });
        await expect(eraseUser(SUBJECT, { db: fake.db })).rejects.toThrow(/connection terminated/);
    });
});

describe('eraseUser — the default client', () => {
    it('resolves its client through runInGlobalContext, never a tenant context', async () => {
        // `app_user` has UPDATE on the audit table REVOKED and every
        // tenant-path context (`withTenantDb` / `runInTenantContext` /
        // `runInTenantJobContext`) does `SET LOCAL ROLE app_user`, so an
        // erasure run from one of them cannot write at all. This branch is the
        // only thing that chooses; the probe never exercises it because it
        // always injects `options.db`.
        const fake = makeFakeDb();
        mockGlobalDbHolder.db = fake.db;

        const receipt = await eraseUser(SUBJECT);

        expect(runInGlobalContext).toHaveBeenCalledTimes(1);
        expect(receipt.userDeleted).toBe(true);
        expect(fake.committed.userDeleted).toBe(true);
    });

    it('does not reach for a client at all when one is injected', async () => {
        const fake = makeFakeDb();
        await eraseUser(SUBJECT, { db: fake.db });
        expect(runInGlobalContext).not.toHaveBeenCalled();
    });
});
