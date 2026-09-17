/**
 * `planErasure` — the DSAR dry run.
 *
 * Two duties, and the first one is the reason this file exists:
 *
 *   1. IT WRITES NOTHING. Asserted by capturing every statement it issues and
 *      requiring all of them to be SELECTs — not by reading the source, and not
 *      by trusting the name. A dry run that writes is the one failure mode that
 *      matters, and it is the one a "did it return the right shape" test cannot
 *      see.
 *   2. It classifies each User-referencing FK by what the DATABASE would do to
 *      it, so `blockers` answers the question docs/dsar.md leaves open: which
 *      references would refuse the Stage 2 hard-delete.
 *
 * The fake below is a recording client, not a mock of the answer: it returns
 * catalog-shaped rows and counts, and the test reads the plan back out.
 */
import { planErasure, type ErasurePlanDb } from '@/app-layer/jobs/dsar-erasure';

interface FkRow { table_name: string; column_name: string; confdeltype: string }

/** Records every SQL statement, answers catalog queries and counts. */
function recordingDb(
    fks: FkRow[],
    counts: Record<string, number>,
    session: { role: string; tenant: string | null } = { role: 'postgres', tenant: null },
    subjectVisible = true,
) {
    const sql: string[] = [];
    const db: ErasurePlanDb = {
        async $queryRawUnsafe<T>(statement: string, ...values: unknown[]): Promise<T> {
            sql.push(statement);
            if (statement.includes('current_user')) return [session] as unknown as T;
            if (statement.includes('FROM "User" WHERE')) return [{ n: BigInt(subjectVisible ? 1 : 0) }] as unknown as T;
            if (statement.includes('pg_constraint')) return fks as unknown as T;
            // `SELECT count(*)::bigint AS n FROM "X" WHERE "y" = $1`
            const table = /FROM "([^"]+)"/.exec(statement)?.[1] ?? '';
            void values;
            return [{ n: BigInt(counts[table] ?? 0) }] as unknown as T;
        },
    };
    return { db, sql };
}

const FKS: FkRow[] = [
    { table_name: 'AuditLog', column_name: 'userId', confdeltype: 'n' },        // SET NULL
    { table_name: 'Session', column_name: 'userId', confdeltype: 'c' },         // CASCADE
    { table_name: 'TenantMembership', column_name: 'userId', confdeltype: 'r' },// RESTRICT
    { table_name: 'Notification', column_name: 'userId', confdeltype: 'a' },    // NO ACTION
    { table_name: 'Account', column_name: 'userId', confdeltype: 'c' },         // CASCADE, no rows
];

describe('planErasure — the dry run', () => {
    // ── It refuses a view RLS would have narrowed ─────────────────────
    it('REFUSES to run as app_user — RLS would hide blocking references', async () => {
        const { db, sql } = recordingDb(FKS, { TenantMembership: 1 }, { role: 'app_user', tenant: null });
        await expect(planErasure('subject-1', { db })).rejects.toThrow(/without RLS filtering/i);
        // Refused before counting anything, so no partial plan can escape.
        expect(sql.filter((s) => s.includes('count(*)'))).toEqual([]);
    });

    it('REFUSES when the subject is not visible — a zero it cannot justify', async () => {
        // The session can be perfectly unconstrained and the query still see
        // nothing: a wrong column or a mistyped id makes every count 0, and the
        // plan would report no blockers and wouldSucceed: true. A zero is only
        // meaningful once something non-zero has been observed on the same
        // client, so the subject's own row is the control.
        const { db, sql } = recordingDb(FKS, { TenantMembership: 1 }, { role: 'postgres', tenant: null }, false);
        await expect(planErasure('ghost', { db })).rejects.toThrow(/not visible to this connection/i);
        expect(sql.filter((s) => s.includes('pg_constraint'))).toEqual([]);
    });

    it('REFUSES when app.tenant_id is set, even as a superuser', async () => {
        // The role alone is not the discriminator: a superuser session with a
        // tenant id set still matches tenant-scoped policies.
        const { db } = recordingDb(FKS, {}, { role: 'postgres', tenant: 't-123' });
        await expect(planErasure('subject-1', { db })).rejects.toThrow(/app\.tenant_id=t-123/);
    });

    it('writes NOTHING: every statement it issues is a SELECT', async () => {
        const { db, sql } = recordingDb(FKS, { AuditLog: 9, Session: 2, TenantMembership: 1, Notification: 4 });
        await planErasure('subject-1', { db });

        // Non-vacuous: it really did talk to the database.
        expect(sql.length).toBeGreaterThan(1);
        // The claim, as a set rather than a spot check.
        const notSelect = sql.filter((s) => !/^\s*SELECT\b/i.test(s));
        expect(notSelect).toEqual([]);
        // And named explicitly, because "no UPDATE" is also true of a statement
        // that DELETEs.
        for (const verb of ['UPDATE', 'DELETE', 'INSERT', 'TRUNCATE', 'ALTER', 'DROP']) {
            expect(sql.filter((s) => new RegExp(`\\b${verb}\\b`, 'i').test(s))).toEqual([]);
        }
    });

    it('reports writes: 0 as a value a caller can assert on', async () => {
        const { db } = recordingDb(FKS, {});
        expect((await planErasure('subject-1', { db })).writes).toBe(0);
    });

    it('classifies each reference by what the database would do to it', async () => {
        const { db } = recordingDb(FKS, { AuditLog: 9, Session: 2, TenantMembership: 1, Notification: 4 });
        const plan = await planErasure('subject-1', { db });

        const byTable = Object.fromEntries(plan.references.map((r) => [r.table, r]));
        expect(byTable.AuditLog).toMatchObject({ onDelete: 'SET NULL', rows: 9, effect: 'ATTRIBUTION_ANONYMIZED' });
        expect(byTable.Session).toMatchObject({ onDelete: 'CASCADE', rows: 2, effect: 'DELETED_WITH_USER' });
        expect(byTable.TenantMembership).toMatchObject({ onDelete: 'RESTRICT', rows: 1, effect: 'BLOCKS_DELETE' });
        expect(byTable.Notification).toMatchObject({ onDelete: 'NO ACTION', rows: 4, effect: 'BLOCKS_DELETE' });
        // Declared by the schema, but this subject has none — reported, not omitted.
        expect(byTable.Account).toMatchObject({ onDelete: 'CASCADE', rows: 0, effect: 'NO_ROWS' });
    });

    it('NO ACTION blocks too — RESTRICT is not the only refusing action', async () => {
        // The distinction that would be easy to get wrong: NO ACTION defers the
        // check to end-of-statement but still REFUSES. Treating only RESTRICT as
        // a blocker would under-report, and a dry run that under-reports
        // blockers is worse than none.
        const { db } = recordingDb([FKS[3]], { Notification: 4 });
        const plan = await planErasure('subject-1', { db });
        expect(plan.blockers.map((b) => b.table)).toEqual(['Notification']);
        expect(plan.wouldSucceed).toBe(false);
    });

    it('wouldSucceed is true only when nothing blocks', async () => {
        const clear = FKS.filter((f) => f.confdeltype === 'c' || f.confdeltype === 'n');
        const { db } = recordingDb(clear, { AuditLog: 9, Session: 2 });
        const plan = await planErasure('subject-1', { db });
        expect(plan.blockers).toEqual([]);
        expect(plan.wouldSucceed).toBe(true);
        expect(plan.auditRowsToPseudonymize).toBe(9);
    });

    it('counts AuditLog rows as PSEUDONYMIZE, separately from the reference list', async () => {
        const { db } = recordingDb(FKS, { AuditLog: 9, Session: 2, TenantMembership: 1, Notification: 4 });
        const plan = await planErasure('subject-1', { db });
        // The number a compliance reader wants: rows that SURVIVE with their
        // subject removed, not rows that disappear.
        expect(plan.auditRowsToPseudonymize).toBe(9);
    });

    it('REFUSES an unexpected catalog identifier rather than escaping it', async () => {
        // Stronger than "escapes it safely": every identifier Prisma generates
        // matches [A-Za-z_][A-Za-z0-9_]*, so a name outside that set means
        // something upstream is wrong and carrying on carefully is the worse
        // answer. Also keeps this file free of `""`-doubling, which is
        // byte-identical to CSV cell escaping and trips the CSV guard.
        const { db, sql } = recordingDb([{ table_name: 'we"ird', column_name: 'userId', confdeltype: 'c' }], {});
        await expect(planErasure('subject-1', { db })).rejects.toThrow(/refusing an unexpected identifier/i);
        // It never queried the offending table. Note this is deliberately NOT
        // "issued no count at all" — the subject-visibility control legitimately
        // counts "User" first, and an assertion that forbade every count would
        // have to be weakened the moment a control was added, which is how a
        // guard quietly stops guarding.
        expect(sql.filter((s) => s.includes('we"ird'))).toEqual([]);
    });

    it('accepts ordinary catalog identifiers', async () => {
        // The positive control for the refusal above: without this, a function
        // that refused EVERYTHING would pass that test.
        const { db, sql } = recordingDb([{ table_name: 'TenantMembership', column_name: 'userId', confdeltype: 'r' }], { TenantMembership: 3 });
        const plan = await planErasure('subject-1', { db });
        expect(plan.blockers.map((b) => b.table)).toEqual(['TenantMembership']);
        expect(sql.some((s) => s.includes('"TenantMembership"'))).toBe(true);
    });
});
