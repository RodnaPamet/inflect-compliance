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
import { ERASURE_EXECUTED_ACTION } from '@/lib/audit/erasure-record';
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
    options: {
        subjectVisible?: boolean;
        auditRows?: number;
        deleteError?: unknown;
        /**
         * Rows for this subject that COMMIT between the pre-read and the
         * `updateMany` — the READ COMMITTED race (#2682). The read cannot see
         * them, the update touches them anyway, so the erasure record would
         * name fewer rows than were actually pseudonymized.
         */
        rowsCommittedMidTransaction?: number;
    } = {},
): FakeDb {
    const {
        subjectVisible = true,
        auditRows = 3,
        deleteError,
        rowsCommittedMidTransaction = 0,
    } = options;
    const updatedRows = auditRows + rowsCommittedMidTransaction;

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
            async findMany(args: { where: { userId: string } }) {
                calls.push(`auditLog:findMany:${JSON.stringify(args)}`);
                // The rows the ERASURE_EXECUTED record (#2682) has to name.
                // Their `entryHash` is deliberately a literal that cannot be
                // the real canonical hash, so `recordErasure`'s pre-erasure
                // control REJECTS every one of them and no tolerance is
                // recorded. That is the honest outcome for a fake that does
                // not hash: the record still gets written (it is evidence of
                // the erasure) and `auditRowsTolerated` is 0. The DB-backed
                // `dsar-erasure-audit-survival.test.ts` is where real
                // tolerances are produced and graded.
                return Array.from({ length: auditRows }, (_, i) => ({
                    id: `audit-${i}`,
                    tenantId: i % 2 === 0 ? 'tenant-a' : 'tenant-b',
                    userId: args.where.userId,
                    actorType: 'USER',
                    entity: 'Control',
                    entityId: `ctrl-${i}`,
                    action: 'CONTROL_UPDATED',
                    detailsJson: { category: 'custom' },
                    previousHash: null,
                    entryHash: 'not-a-real-hash',
                    version: 1,
                    createdAt: new Date('2026-09-20T00:00:00.000Z'),
                }));
            },
            async updateMany(args: { where: { userId: string }; data: { userId: null } }) {
                calls.push(`auditLog:updateMany:${JSON.stringify(args)}`);
                // NOT necessarily `auditRows`: a second snapshot can see rows
                // the `findMany` above could not. Defaults to agreeing.
                staged.auditRowsNulled = updatedRows;
                return { count: updatedRows };
            },
        },
    };

    const db = {
        ...delegates,
        // The erasure record goes through `appendAuditEntryWithin`, which
        // issues raw SQL against "AuditLog" — recorded here so the ordering
        // assertions can see it, and answered with the shapes that writer
        // expects (an array for the chain-tip read, a row count otherwise).
        async $queryRawUnsafe(sql: string, ...values: unknown[]) {
            calls.push(`$raw:$queryRawUnsafe:${JSON.stringify([sql, ...values])}`);
            return [] as unknown[];
        },
        async $executeRawUnsafe(sql: string, ...values: unknown[]) {
            calls.push(`$raw:$executeRawUnsafe:${JSON.stringify([sql, ...values])}`);
            return 1;
        },
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
        //
        // #2682 ADDED THREE THINGS TO THIS SEQUENCE, and each one's POSITION
        // is the claim, not its presence:
        //
        //   auditLog:findMany BEFORE updateMany — `updateMany` returns a
        //     count, not ids, and afterwards the subject's rows are no longer
        //     findable by `userId`. Read it later and the erasure record
        //     names nothing.
        //   the $raw block AFTER updateMany — the ERASURE_EXECUTED entry
        //     asserts these rows HAVE been pseudonymized. Written first it
        //     would be a prediction.
        //   the $raw block BEFORE user:delete — it is inside the same
        //     transaction as the delete, so a refused delete rolls the record
        //     back along with the pseudonymization it describes. That is the
        //     "same transaction" constraint of the owner decision, and this
        //     line is where a future refactor that moves the record outside
        //     the transaction reddens.
        //
        // The fixture spans TWO tenants (see `findMany` above), so the $raw
        // block repeats per tenant — the chain is per-tenant and one record
        // in one tenant would leave the other's verifier still reporting
        // tampering.
        const RAW_APPEND = [
            '$raw:$executeRawUnsafe',   // pg_advisory_xact_lock for this tenant
            '$raw:$queryRawUnsafe',     // chain tip
            '$raw:$executeRawUnsafe',   // INSERT the ERASURE_EXECUTED row
        ];
        expect(fake.calls.map((c) => c.split(':').slice(0, 2).join(':'))).toEqual([
            '$transaction',
            'user:findUnique',
            'auditLog:findMany',
            'auditLog:updateMany',
            ...RAW_APPEND,
            ...RAW_APPEND,
            'user:delete',
        ]);
    });

    it('writes the erasure record through the sanctioned AuditLog writer, per tenant', async () => {
        const fake = makeFakeDb();
        const receipt = await eraseUser(SUBJECT, { db: fake.db });

        // One ERASURE_EXECUTED entry per tenant the erasure touched. The
        // fixture's three rows span two tenants, so two records — an
        // implementation that wrote one (or wrote it for the "current"
        // tenant only) leaves the other chain unexplained.
        expect(receipt.erasureRecordIds).toHaveLength(2);
        expect(new Set(receipt.erasureRecordIds).size).toBe(2);

        const inserts = fake.calls.filter((c) => c.includes('INSERT INTO \\"AuditLog\\"'));
        expect(inserts).toHaveLength(2);

        // COUNTED rather than asserted per-iteration with `toContain`. The
        // loop form read `for (const insert of inserts) expect(insert)
        // .toContain(...)`, and `assertion-needle-uniqueness-ratchet`'s
        // `UNANALYSABLE_READ_BASELINE` went up by exactly 3 for it — a
        // loop binding is a subject its analyser cannot resolve
        // (`binding-not-resolvable`), which is a blind spot whether or not
        // this particular assertion is sound. Filtering says the same thing
        // with a denominator the ratchet can read, and a failure names how
        // many of the two inserts satisfied it rather than stopping at the
        // first.
        //
        // The entry's actor is the JOB and its userId is NULL. Naming the
        // subject would re-identify them in their own erasure record — and
        // the record would then be pseudonymized by the very `updateMany` it
        // describes, leaving it outside its own named set.
        expect(inserts.filter((c) => c.includes(ERASURE_EXECUTED_ACTION))).toHaveLength(2);
        expect(inserts.filter((c) => c.includes('JOB'))).toHaveLength(2);
        expect(inserts.filter((c) => c.includes(SUBJECT))).toEqual([]);

        // This fake cannot produce a real canonical hash, so the pre-erasure
        // control in `recordErasure` rejects every row and NO tolerance is
        // recorded. Asserted rather than left implicit: it is the difference
        // between "the record was written" and "the record excuses anything".
        expect(receipt.auditRowsTolerated).toBe(0);
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
            // #2682 — two tenants in the fixture, so two records. Ids are
            // generated, so the shape is asserted rather than the values.
            erasureRecordIds: expect.arrayContaining([expect.any(String)]),
            auditRowsTolerated: 0,
        });
        expect(receipt.erasureRecordIds).toHaveLength(2);
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


describe('eraseUser — the read and the write must have seen the same rows (#2682)', () => {
    // The pre-read and the `updateMany` are two statements at READ COMMITTED,
    // so each takes its own snapshot. A row for this subject that commits
    // between them is invisible to the read and pseudonymized by the write —
    // leaving a de-attributed row no ERASURE_EXECUTED entry names, which is
    // exactly the false positive this whole change removes.
    //
    // It cannot be closed by taking the named set from the write instead:
    // `updateMany` returns a count and no ids, and `updateManyAndReturn` would
    // hand back POST-update rows whose `userId` is already NULL — so
    // `recordErasure` could no longer compute the PRE-erasure control hash
    // that stops an erasure laundering an already-broken chain. What the count
    // does support is detection, and a divergence rolls the whole thing back.

    it('refuses, and rolls back, when a row appears between the read and the update', async () => {
        const fake = makeFakeDb({ auditRows: 3, rowsCommittedMidTransaction: 1 });

        await expect(eraseUser(SUBJECT, { db: fake.db })).rejects.toThrow(
            /changed between the read \(3 row\(s\)\) and the pseudonymization \(4 row\(s\)\)/,
        );

        // A refusal that still committed would be worse than no check at all:
        // the rows are nulled, the subject is gone, and the record under-names.
        expect(fake.committed.auditRowsNulled).toBe(0);
        expect(fake.committed.userDeleted).toBe(false);
    });

    it('POSITIVE CONTROL — the identical fake with no interleaved row succeeds', async () => {
        // Same construction, same 3 rows; the ONLY difference is that the two
        // snapshots agree. Without this pair, the red above could just mean
        // the fake never worked.
        const fake = makeFakeDb({ auditRows: 3 });

        const receipt = await eraseUser(SUBJECT, { db: fake.db });

        expect(receipt.auditRowsPseudonymized).toBe(3);
        expect(fake.committed.auditRowsNulled).toBe(3);
        expect(fake.committed.userDeleted).toBe(true);
    });

    it('the refusal is raised BEFORE the subject is deleted', async () => {
        // Ordering matters for what the rollback has to undo — and on a real
        // database the hard delete is the irreversible half.
        const fake = makeFakeDb({ auditRows: 2, rowsCommittedMidTransaction: 3 });

        await expect(eraseUser(SUBJECT, { db: fake.db })).rejects.toThrow(/dsar-erasure/);

        expect(fake.calls).not.toContain('user:delete');
    });
});
