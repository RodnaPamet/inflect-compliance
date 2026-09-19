/**
 * DSAR erasure cascade (GDPR Art. 17 right-to-erasure).
 *
 * STAGE 3 — `eraseUser` EXECUTES. It is still NOT registered in
 * register-schedules / executor-registry and nothing in `src/` calls it, so
 * no scheduler and no route can reach it; whether it gets an operator entry
 * point (who may run it, for which subject, with what audit record) is a
 * separate decision and deliberately not taken here. What changed is that the
 * function is no longer a stub: called, it writes.
 *
 * THE TWO GATES ON `AuditLog`, AND WHICH ONE THIS DEPENDS ON. There are two,
 * and only one was ever loosened:
 *
 *   privilege — WHO may attempt the write. `app_user` still has UPDATE and
 *     DELETE on the audit table REVOKED outright (migration
 *     20260324010000_audit_log_immutable_trigger), and 20260917130000
 *     deliberately did NOT grant it back. Every tenant-path context
 *     (`withTenantDb`, `runInTenantContext`, `runInTenantJobContext`) does
 *     `SET LOCAL ROLE app_user`, so erasure run from any of them fails on
 *     privilege before the trigger is ever consulted.
 *   trigger — WHICH write is acceptable. `audit_log_immutable_guard()`
 *     permits exactly one shape (20260917130000): `OLD."userId" IS NOT NULL`,
 *     `NEW."userId" IS NULL`, and `to_jsonb(NEW) - 'userId' =
 *     to_jsonb(OLD) - 'userId'`. DELETE stays unconditionally refused.
 *
 * So the default path below runs through `runInGlobalContext`, which never
 * drops to `app_user`. Granting UPDATE back to `app_user` would widen the
 * permitted write to every tenant request in the product and is NOT how this
 * is to be made to work.
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

// ─────────────────────────────────────────────────────────────────────────
//  ERASURE — the irreversible path
// ─────────────────────────────────────────────────────────────────────────

/**
 * The slice of a Prisma client erasure needs. Narrow so a test can supply a
 * fake, and so the set of tables this function can possibly reach is readable
 * in one screen rather than inferred from a whole client.
 *
 * `$transaction` is REQUIRED, not optional, and an already-open transaction
 * is therefore not an acceptable argument: atomicity is the safety property
 * (see `eraseUserWithin`), and a seam that silently degrades to non-atomic
 * when handed a `PrismaTx` would lose it without saying so.
 */
export interface ErasureDb {
    $transaction<T>(fn: (tx: ErasureDb) => Promise<T>): Promise<T>;
    user: {
        findUnique(args: { where: { id: string } }): Promise<{ id: string } | null>;
        delete(args: { where: { id: string } }): Promise<unknown>;
    };
    auditLog: {
        updateMany(args: {
            where: { userId: string };
            data: { userId: null };
        }): Promise<{ count: number }>;
    };
}

/** What an erasure did. No PII — this is the compliance evidence. */
export interface ErasureReceipt {
    userId: string;
    /** AuditLog rows whose `userId` went from the subject to NULL. */
    auditRowsPseudonymized: number;
    /** Literally zero, and a field rather than a comment so a caller can assert it. */
    auditRowsDeleted: 0;
    /** The subject's own `User` row, hard-deleted. */
    userDeleted: true;
}

/**
 * Prisma error codes for "a reference refuses this delete".
 *
 * P2003 is the FK-constraint failure Postgres raises for ON DELETE RESTRICT /
 * NO ACTION; P2014 is Prisma's own required-relation refusal. Both mean the
 * same thing to an operator — something still points at this subject — and
 * both are recognised here so the message can say so, rather than surfacing
 * "Foreign key constraint violated on the (not available)" from a function
 * whose whole job was to delete a user.
 */
const REFERENCE_REFUSAL_CODES = new Set(['P2003', 'P2014']);

function isReferenceRefusal(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && REFERENCE_REFUSAL_CODES.has(code);
}

/**
 * Erase `userId`. GDPR Art. 17.
 *
 * ── THE INVARIANT: PSEUDONYMIZATION, NOT DELETION ──────────────────
 *
 * The audit trail SURVIVES this. Every `AuditLog` row referencing the subject
 * keeps existing, keeps every column it had — `entryHash` and `previousHash`
 * included, because those are the hash chain and rewriting one forges history
 * — and loses exactly one thing: the link to the subject. `userId` ends NULL.
 * The RECORD OF THE ACTION is retained (Art. 17(3)(b): the trail is itself a
 * compliance obligation); the IDENTITY OF THE ACTOR is not. Nothing here
 * deletes an audit row, and the database refuses one unconditionally even if
 * something tried.
 *
 * Everything else the subject's `User` row owns goes with it by FK cascade —
 * the database's own `ON DELETE CASCADE` declarations are the enumeration.
 * This function deliberately keeps no second list of child tables to delete
 * by hand: an un-extended list is how a table added next quarter quietly
 * survives an erasure, and the catalog already knows the answer (that is what
 * `planErasure` below reads). Authored content (`ON DELETE SET NULL`) is
 * retained with its attribution anonymized, per docs/dsar.md.
 *
 * ── WHAT THIS FUNCTION DOES NOT DO, ON PURPOSE ─────────────────────
 *
 * IT DOES NOT CHECK THE COOLING-OFF WINDOW. `coolingOffElapsed()` above is
 * the 24h gate and it belongs to whoever drives the DSAR workflow, not here:
 * this function receives a subject id and no `verifiedAt`, so a check it
 * could make would be one it skips whenever the caller omits the timestamp —
 * a gate that is off by default is worse than an absent one. A caller that
 * cannot show the window elapsed must not call this.
 *
 * IT DOES NOT CHECK THE SESSION'S ROLE. `planErasure` does, because it is a
 * READ whose partial view would produce a confidently wrong answer; here the
 * database is the enforcement point and it is not silent — `app_user` has
 * UPDATE on "AuditLog" revoked, so an erasure mistakenly run on a tenant-path
 * connection fails loudly on privilege rather than half-succeeding.
 *
 * IT DOES NOT DECIDE WHETHER THE ERASURE IS ALLOWED. `evaluateDsarRejection`
 * (`src/lib/dsar.ts`) owns LAST_OWNER / OUTSTANDING_BALANCE / LEGAL_HOLD.
 *
 * ── ATOMIC, AND THAT IS THE SAFETY PROPERTY ────────────────────────
 *
 * The pseudonymization and the hard delete are ONE transaction. Several
 * `User`-referencing FKs are `ON DELETE RESTRICT`, so the delete genuinely
 * can be refused (that is the question `planErasure` answers per subject). If
 * it is, the pseudonymization must go back too — because it cannot be undone
 * afterwards: the trigger permits `userId` value -> NULL and nothing else, so
 * a half-run erasure would leave the trail permanently de-attributed for a
 * user who still exists, with no statement that could restore it. All or
 * nothing.
 *
 * @param options.db A FULL client (not a `PrismaTx`). Omit it and the
 *   erasure runs via `runInGlobalContext` — the RLS-free, never-`app_user`
 *   context the `AuditLog` privilege gate requires.
 */
export async function eraseUser(
    userId: string,
    options: { db?: ErasureDb } = {},
): Promise<ErasureReceipt> {
    if (!userId) {
        throw new Error('dsar-erasure: refusing to erase without a subject id.');
    }
    if (options.db) return eraseUserWithin(options.db, userId);

    // Imported lazily so that merely importing this module does not build the
    // Prisma client: `coolingOffElapsed` and `planErasure` are both usable
    // without one, and their tests should not pay for a client they never use.
    const { runInGlobalContext } = await import('@/lib/db-context');
    return runInGlobalContext((db) => eraseUserWithin(db as unknown as ErasureDb, userId));
}

/** The cascade itself, in one transaction. See {@link eraseUser}. */
async function eraseUserWithin(db: ErasureDb, userId: string): Promise<ErasureReceipt> {
    return db.$transaction(async (tx) => {
        // ── POSITIVE CONTROL, same reasoning as planErasure's ──────
        //
        // Every count and every zero below is only meaningful once something
        // non-zero has been observed through this same client. A wrong
        // column, a mistyped id, or a connection whose view is narrowed makes
        // an erasure that touched nothing indistinguishable from one that had
        // nothing to touch — and this one reports success. So the subject's
        // own row must be visible first.
        const subject = await tx.user.findUnique({ where: { id: userId } });
        if (!subject) {
            throw new Error(
                `dsar-erasure: subject ${JSON.stringify(userId)} is not visible to this `
                    + 'connection. Refusing rather than reporting an erasure whose every '
                    + 'count would be zero — an absent subject and an unobservable one '
                    + 'produce identical output.',
            );
        }

        // ── PSEUDONYMIZE ───────────────────────────────────────────
        //
        // `where` carries the subject id and nothing else: the trigger grades
        // ONE ROW at a time against a SHAPE, so a statement that nulled
        // `userId` on every row in the table would satisfy it row by row. Not
        // over-anonymizing is an application obligation, and this clause is
        // where it lives.
        //
        // `data` carries ONE column. `AuditLog` has no `@updatedAt`, so
        // nothing else moves and `to_jsonb(NEW) - 'userId' = to_jsonb(OLD) -
        // 'userId'` holds. Adding a second field here is how the hash chain
        // gets rewritten inside something called a pseudonymization.
        const { count } = await tx.auditLog.updateMany({
            where: { userId },
            data: { userId: null },
        });

        // ── HARD-DELETE THE SUBJECT ────────────────────────────────
        try {
            await tx.user.delete({ where: { id: userId } });
        } catch (error) {
            if (!isReferenceRefusal(error)) throw error;
            throw new Error(
                `dsar-erasure: the hard delete of ${JSON.stringify(userId)} was refused by a `
                    + 'reference to them (an ON DELETE RESTRICT FK, or a required relation). '
                    + 'The whole erasure is rolled back, pseudonymization included — a '
                    + 'half-run erasure cannot be undone. Run planErasure() for the list of '
                    + 'blocking references and resolve them first.',
                { cause: error },
            );
        }

        return {
            userId,
            auditRowsPseudonymized: count,
            auditRowsDeleted: 0,
            userDeleted: true,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────
//  DRY RUN — what erasure WOULD do, writing nothing
// ─────────────────────────────────────────────────────────────────────────
//
// WHY THIS IS NOT `eraseUser`, STILL. It was written while `eraseUser` was a
// refusing stub, and the reason it stayed a sibling rather than becoming a
// `dryRun: true` flag on the real function outlives that: the probe in
// tests/helpers/dsar-erasure-probe.ts grades a run as REFUSED, EXECUTED, or
// UNOBSERVED (returned without refusing and without touching the database) —
// and UNOBSERVED is a FAILURE carrying its own `UNOBSERVED_EXECUTION` code,
// because a function that quietly does nothing is indistinguishable from one
// wired to the wrong client. A dry run is exactly that shape, so a reporting
// mode on `eraseUser` would be gradeable only by weakening the oracle.
//
// `eraseUser` executes now. That does NOT make this redundant: it answers,
// before anything irreversible is attempted, which references would refuse the
// hard delete — the question `eraseUser` can otherwise only answer by trying
// it and rolling back. Nothing calls either of them yet.
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
