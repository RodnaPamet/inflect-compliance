/**
 * DSAR erasure cascade (GDPR Art. 17 right-to-erasure).
 *
 * ⚠️ STAGE 1 FOUNDATION — execution is NOT enabled. This file documents
 * the intended cascade + carries the cooling-off guard; it is NOT
 * registered in register-schedules / executor-registry, so it never runs.
 * The irreversible execution lands in the Stage 3 PR (see docs/dsar.md),
 * which additionally requires:
 *   - a change to the IMMUTABLE_AUDIT_LOG DB trigger to PERMIT the
 *     pseudonymization UPDATE (NULL userId) while still refusing all other
 *     AuditLog UPDATEs, and
 *   - a full FK-cascade validated in staging against a real database.
 *
 * @module app-layer/jobs/dsar-erasure
 */
import { DSAR_COOLING_OFF_HOURS } from '@/lib/dsar';

/** Hours that must elapse after VERIFIED before erasure may fire. */
export const COOLING_OFF_HOURS = DSAR_COOLING_OFF_HOURS;

/**
 * The 24h cooling-off guard: erasure may only proceed once this window
 * has elapsed since the request reached VERIFIED, giving the user time to
 * cancel an irreversible deletion. Pure + unit-testable.
 */
export function coolingOffElapsed(verifiedAt: Date, now: Date = new Date()): boolean {
    return now.getTime() - verifiedAt.getTime() >= COOLING_OFF_HOURS * 3_600_000;
}

/**
 * Erase a user. NOT enabled in Stage 1 — throws. The body documents the
 * cascade so the Stage 3 implementation has a fixed contract.
 *
 * Stage 1 — Pseudonymize AuditLog: set `userId = NULL` for every row
 *   referencing the user. This is pseudonymization, NOT deletion —
 *   deleting audit rows breaks the hash chain and is refused by the
 *   IMMUTABLE_AUDIT_LOG trigger. NULL-userId is the GDPR-correct choice
 *   (Art. 17(3)(b): the audit trail is itself a compliance obligation).
 * Stage 2 — Hard-delete the User row + its `onDelete: Cascade` children
 *   (sessions, MFA enrolments, notification preferences). Authorship
 *   references (`onDelete: SetNull`) become "former user".
 * Stage 3 — Invalidate cached DEK material keyed on the user's email-hash
 *   (the per-tenant DEK itself is tenant-scoped and unaffected).
 * Stage 4 — Emit an anonymized verification report (which rows touched,
 *   which FKs nullified) as compliance evidence — no PII.
 */
export async function eraseUser(_userId: string): Promise<never> {
    throw new Error(
        'dsar-erasure: execution is not enabled (Stage 1 foundation — see docs/dsar.md)',
    );
}

// ─────────────────────────────────────────────────────────────────────────
//  DRY RUN — what erasure WOULD do, writing nothing
// ─────────────────────────────────────────────────────────────────────────
//
// WHY THIS IS NOT `eraseUser`. The obvious shape — make `eraseUser` report
// instead of write — reddens the Stage 3 oracle, and for a good reason. The
// probe in tests/helpers/dsar-erasure-probe.ts grades a run as REFUSED (threw
// the Stage-1 error, wrote nothing), EXECUTED (issued operations), or
// UNOBSERVED (returned without refusing and without touching the database) —
// and UNOBSERVED is a FAILURE carrying its own `UNOBSERVED_EXECUTION` code,
// because a function that quietly does nothing is indistinguishable from one
// wired to the wrong client. A dry run is exactly that shape.
//
// So `eraseUser` stays a refusing stub and this is a sibling. The property
// worth having is stronger than tidiness: NOTHING IN THIS PR CAN ERASE
// ANYTHING. The irreversible path is still closed, and A1/A2/B1 keep grading
// the real function honestly rather than being relaxed to accommodate a
// half-implementation.
//
// WHY IT READS THE CATALOG RATHER THAN THE PRISMA SCHEMA. The question this
// answers — "which FKs would refuse the Stage 2 hard-delete" — must be
// answered about the DATABASE, not about the file that is supposed to describe
// it. #2367 records 53 statements of drift between main's migrations and
// main's schema, including columns nullable in Prisma and NOT NULL in
// Postgres. A schema-derived answer here would be the kind that is confidently
// wrong.

/** Postgres `confdeltype`, decoded. What happens to a referencing row when its `User` is deleted. */
export type FkDeleteAction = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';

const DELETE_ACTION: Record<string, FkDeleteAction> = {
    c: 'CASCADE', r: 'RESTRICT', n: 'SET NULL', d: 'SET DEFAULT', a: 'NO ACTION',
};

export type ReferenceEffect =
    /** Goes with the User row automatically. */
    | 'DELETED_WITH_USER'
    /** Survives; the link to the subject is dropped. */
    | 'ATTRIBUTION_ANONYMIZED'
    /** The database will REFUSE the delete while these rows exist. */
    | 'BLOCKS_DELETE'
    /** Declared by the schema, but this subject has none. */
    | 'NO_ROWS';

export interface ErasureReference {
    table: string;
    column: string;
    onDelete: FkDeleteAction;
    rows: number;
    effect: ReferenceEffect;
}

export interface ErasurePlan {
    userId: string;
    /** AuditLog rows that would be pseudonymized (`userId` -> NULL), never deleted. */
    auditRowsToPseudonymize: number;
    /** Every FK referencing `User`, with what the database would do to it. */
    references: ErasureReference[];
    /** The subset that would REFUSE the hard-delete. Empty means Stage 2 can proceed. */
    blockers: ErasureReference[];
    /** False when anything blocks. A plan is a prediction, not a promise. */
    wouldSucceed: boolean;
    /** Literally zero. This is a read; the field exists so a caller can assert it. */
    writes: 0;
}

/** The slice of a Prisma client this needs. Narrow so a test can supply a fake. */
export interface ErasurePlanDb {
    $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

/**
 * Quote a catalog-sourced identifier — by REFUSING anything unexpected rather
 * than escaping it.
 *
 * An allowlist beats an escape here for two reasons. It is the stronger
 * property: escaping accommodates a hostile name, validation declines to have
 * one, and every identifier Prisma generates is `[A-Za-z_][A-Za-z0-9_]*`, so a
 * name outside that set means something is wrong upstream and the right answer
 * is to stop rather than to carry on carefully.
 *
 * It also avoids hand-rolling `"" `-doubling, which is byte-identical to CSV
 * cell escaping — `tests/guards/csv-export-neutralisation` flagged the earlier
 * version of this function for exactly that, correctly by its own heuristic.
 * The guard was wrong about the intent and right about the smell.
 */
function safeIdent(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
            `dsar-erasure: refusing an unexpected identifier from the catalog: ${JSON.stringify(name)}`,
        );
    }
    return `"${name}"`;
}

/**
 * Report what erasing `userId` WOULD do. Issues only SELECTs and writes nothing.
 *
 * The useful output is `blockers`: docs/dsar.md notes that several
 * User-referencing FKs are ON DELETE RESTRICT and that the Stage 2 hard-delete
 * "cannot succeed until they are resolved", without saying which or how many.
 * This answers that against a real database, per subject.
 */
export async function planErasure(userId: string, options: { db: ErasurePlanDb }): Promise<ErasurePlan> {
    const { db } = options;

    // ── REFUSE A PARTIAL VIEW ──────────────────────────────────────────
    //
    // 200 tables in this schema have RLS enabled, and three of the ones this
    // plan reasons about are among them: AuditLog (the pseudonymization
    // target), TenantMembership and Notification (both RESTRICT, i.e. exactly
    // the blockers). Run on a connection that has dropped to `app_user`, or
    // with `app.tenant_id` set, the counts below are filtered BEFORE they are
    // counted — so this would not merely under-report. It would report
    // `wouldSucceed: true` for a delete the database is going to refuse.
    //
    // That is the worst output this function could produce, it is silent, and
    // every test would still pass. So it refuses instead. A dry run whose view
    // is partial must fail loudly, not round down.
    //
    // Callers: use `runInGlobalContext` (src/lib/db-context.ts), the same
    // context Stage 3's erasure has to use because `app_user` has UPDATE on
    // AuditLog revoked outright.
    const [session] = await db.$queryRawUnsafe<Array<{ role: string; tenant: string | null }>>(
        `SELECT current_user::text AS role, current_setting('app.tenant_id', true) AS tenant`,
    );
    if (session?.role === 'app_user' || (session?.tenant ?? '') !== '') {
        throw new Error(
            'dsar-erasure: planErasure must run without RLS filtering '
                + `(role=${session?.role ?? '?'}, app.tenant_id=${session?.tenant || 'unset'}). `
                + 'Row-level security would hide blocking references and the plan would claim '
                + 'an erasure can succeed when it cannot. Run it via runInGlobalContext.',
        );
    }

    // ── POSITIVE CONTROL: prove the query can SEE ──────────────────────
    //
    // The session check above proves this connection is UNCONSTRAINED. It does
    // not prove the queries below actually observe anything — a wrong column, a
    // mistyped id, a subject that does not exist, and every `count(*)` returns
    // 0 while the session looks perfect. The plan would then report no blockers
    // and `wouldSucceed: true`, which is the same dangerous output by a
    // different route.
    //
    // So: the subject's own row must be visible before any zero below is
    // believed. A zero count is only meaningful once something non-zero has
    // been observed through the same client.
    const [subject] = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(
        `SELECT count(*)::bigint AS n FROM "User" WHERE "id" = $1`,
        userId,
    );
    if (Number(subject?.n ?? 0) === 0) {
        throw new Error(
            `dsar-erasure: subject ${JSON.stringify(userId)} is not visible to this connection. `
                + 'Refusing rather than reporting a plan whose every count would be zero — '
                + 'an absent subject and an unobservable one produce identical output.',
        );
    }

    // Every FK whose target is `User`, with its delete action, straight from
    // the catalog. `unnest(conkey) WITH ORDINALITY` expands composite keys
    // rather than silently reading only the first column.
    const fks = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string; confdeltype: string }>>(
        `SELECT src.relname AS table_name,
                att.attname AS column_name,
                c.confdeltype::text AS confdeltype
           FROM pg_constraint c
           JOIN pg_class src ON src.oid = c.conrelid
           JOIN pg_class tgt ON tgt.oid = c.confrelid
           JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
           JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k.attnum
          WHERE c.contype = 'f' AND tgt.relname = 'User'
          ORDER BY src.relname, att.attname`,
    );

    const references: ErasureReference[] = [];
    for (const fk of fks) {
        const onDelete = DELETE_ACTION[fk.confdeltype] ?? 'NO ACTION';
        const counted = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(
            `SELECT count(*)::bigint AS n FROM ${safeIdent(fk.table_name)} WHERE ${safeIdent(fk.column_name)} = $1`,
            userId,
        );
        const rows = Number(counted[0]?.n ?? 0);
        const effect: ReferenceEffect =
            rows === 0
                ? 'NO_ROWS'
                : onDelete === 'CASCADE'
                  ? 'DELETED_WITH_USER'
                  : onDelete === 'SET NULL' || onDelete === 'SET DEFAULT'
                    ? 'ATTRIBUTION_ANONYMIZED'
                    : 'BLOCKS_DELETE';
        references.push({ table: fk.table_name, column: fk.column_name, onDelete, rows, effect });
    }

    const audit = references.find((r) => r.table === 'AuditLog');
    const blockers = references.filter((r) => r.effect === 'BLOCKS_DELETE');

    return {
        userId,
        auditRowsToPseudonymize: audit?.rows ?? 0,
        references,
        blockers,
        wouldSucceed: blockers.length === 0,
        writes: 0,
    };
}
