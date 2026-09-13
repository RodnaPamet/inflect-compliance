/**
 * The repo's ONLY sanctioned raw SQL against the audit trails.
 *
 * WHY THIS MODULE EXISTS (#2523)
 * ──────────────────────────────
 * `AuditLog` and `OrgAuditLog` each carry a `BEFORE DELETE OR UPDATE … FOR
 * EACH ROW` trigger (`audit_log_immutable` / its Org twin) that raises
 * SQLSTATE 23001 unconditionally. The trail is append-only by design and the
 * application has no reason to ever delete from it — measured at the base
 * commit, ZERO files under `src/` contain either idiom, and there is no
 * exception there.
 *
 * Tests are the one place that genuinely needs the rows gone. A suite that
 * seeds a tenant and asserts on its audit rows has to remove them again, and
 * `AuditLog_tenantId_fkey` is ON DELETE RESTRICT — so surviving audit rows
 * ALSO block the teardown's own `tenant.deleteMany`. A suite that cannot
 * clear its audit rows leaks a Tenant row per run, not just audit rows. The
 * shared `inflect_test` database was measured going from 986 to 1727
 * AuditLog rows in a single pass.
 *
 * Wrapping the delete in a transaction that first runs
 * `SET LOCAL session_replication_role = 'replica'` turns the trigger off for
 * the duration, so the delete ACTUALLY WORKS. That is the difference between
 * this and the 25 Prisma-verb calls removed in #2517: those could neither
 * fail nor succeed, while this is a visible, working bypass. The owner's
 * decision on #2523 was to ALLOW it — through exactly one documented helper
 * — rather than forbid it and add a reaper, or change the foreign key.
 *
 * WHAT THIS MODULE MAY DELETE
 * ───────────────────────────
 * Rows of `AuditLog` and `OrgAuditLog`, and nothing else. Every selector
 * below is closed over a scope the caller owns — its own tenant ids, its own
 * organization ids, or an action prefix a suite stamps on the rows it writes.
 * There is deliberately no "delete everything" entry point: a suite that
 * wants a clean slate wants ITS slate clean, and a bare
 * `DELETE FROM "AuditLog"` on a shared database is a different, much worse
 * operation than the one this module exists to perform.
 *
 * There is also no delete-by-row-id selector, and its absence is deliberate.
 * One was written, because `WHERE "id" = $1` appeared five times at the base
 * commit — but every one of those five turned out to be an immutability
 * ASSERTION, and they became `attemptAuditDelete` below. A selector with no
 * callers has no tests either: it could carry wrong SQL indefinitely and
 * nothing would say so. Add it back when something needs it.
 *
 * Other tables that ride along in a teardown (`TenantMembership` and the
 * last-OWNER guard, FK ordering, …) are NOT this module's business. Those
 * sites keep their own transaction; they disable a different trigger, and
 * the guard below does not police them.
 *
 * THIS MODULE IS THE SOLE EXEMPTION
 * ─────────────────────────────────
 * `tests/guards/audit-immutability-guardrails.test.ts` scans `src` AND
 * `tests` for raw SQL UPDATE/DELETE against the audit tables and reports
 * every match as a violation — except this file, whose path that guard
 * DERIVES from this module's own location rather than naming in an
 * allowlist. Writing `DELETE FROM "AuditLog"` anywhere else in the repo is a
 * failing test. Add a selector here instead.
 *
 * WHY THE ASSERTION AND TAMPER HELPERS LIVE HERE TOO
 * ──────────────────────────────────────────────────
 * Three jobs need raw audit DML, not one, and a guard with a single
 * exemption only works if all three live behind it:
 *
 *   1. CLEANUP — `deleteAuditRows*`, under the bypass. The bulk.
 *   2. TAMPER — `tamperAuditRow` / `tamperOrgAuditRow`, under the bypass.
 *      The hash-chain suites forge a row's stored column and then assert the
 *      recorded `entryHash` no longer matches, i.e. that tampering is
 *      DETECTABLE. Forging requires the trigger off.
 *   3. REFUSAL — `attemptAuditUpdate` / `attemptAuditDelete`, deliberately
 *      WITHOUT the bypass. These are the detector for the trigger itself:
 *      `audit-immutability.test.ts` asserts they reject with
 *      `IMMUTABLE_AUDIT_LOG`. They must never catch, and must never acquire
 *      a bypass — a "fix" that made them succeed would delete the only
 *      evidence that the trigger works. Same reasoning the guard file
 *      records for the DSAR erasure oracle.
 */
/**
 * This module's own absolute path, so the guard's exemption is DERIVED
 * rather than written down.
 *
 * `tests/guards/audit-immutability-guardrails.test.ts` imports this value and
 * runs it through `repoRelative` — the same way it resolves its own SELF
 * skip from `__filename`. There is no allowlist array of filenames anywhere:
 * renaming or moving this file changes the exemption automatically, and
 * DELETING it breaks the guard's import rather than silently widening what
 * the scan permits. A string literal could do neither.
 */
export const AUDIT_CLEANUP_MODULE = __filename;

/** The two append-only trails this module is allowed to touch. */
export type AuditTable = 'AuditLog' | 'OrgAuditLog';

/** A transaction client: enough of Prisma's surface to issue raw SQL. */
export interface RawSqlTx {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * A Prisma client that can open an interactive transaction.
 *
 * Structural rather than `PrismaClient` so the many call sites that hold a
 * narrowed or adapter-wrapped client still type-check, and so this module
 * does not drag `@prisma/client` into files that never imported it.
 */
export interface RawSqlClient extends RawSqlTx {
    $transaction<T>(fn: (tx: RawSqlTx) => Promise<T>): Promise<T>;
}

const asArray = (v: string | readonly string[]): string[] =>
    (typeof v === 'string' ? [v] : [...v]);

/**
 * Run `statements` in one transaction with the audit triggers disabled.
 *
 * THE ONE PLACE `session_replication_role` IS SET FOR AUDIT DML. `SET LOCAL`
 * scopes the change to this transaction, so it reverts on commit or rollback
 * even if a statement throws — the connection never escapes with replication
 * role still set.
 */
async function withAuditTriggersDisabled<T>(
    db: RawSqlClient,
    body: (tx: RawSqlTx) => Promise<T>,
): Promise<T> {
    return db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        return body(tx);
    });
}

/**
 * Delete this suite's `AuditLog` rows for the given tenant ids.
 *
 * The common case, and the one that unblocks `tenant.deleteMany`: with the
 * audit rows gone, `AuditLog_tenantId_fkey` (ON DELETE RESTRICT) stops
 * firing and the teardown's own tenant delete succeeds instead of leaking a
 * Tenant row.
 *
 * @returns the number of rows deleted.
 */
export async function deleteAuditRowsForTenants(
    db: RawSqlClient,
    tenantIds: string | readonly string[],
): Promise<number> {
    const ids = asArray(tenantIds);
    if (ids.length === 0) return 0;
    return withAuditTriggersDisabled(db, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, ids),
    );
}

/**
 * Delete `AuditLog` rows whose `action` matches a SQL LIKE pattern.
 *
 * For suites that stamp a unique prefix on every action they write (see
 * `audit-hash-chain.test.ts`) and clean up by that prefix rather than by
 * tenant, because the tenant is shared with rows they did not create.
 */
export async function deleteAuditRowsByActionLike(
    db: RawSqlClient,
    actionPattern: string,
): Promise<number> {
    return withAuditTriggersDisabled(db, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "action" LIKE $1`, actionPattern),
    );
}

/** Delete `OrgAuditLog` rows for the given organization ids. */
export async function deleteOrgAuditRowsForOrganizations(
    db: RawSqlClient,
    organizationIds: string | readonly string[],
): Promise<number> {
    const ids = asArray(organizationIds);
    if (ids.length === 0) return 0;
    return withAuditTriggersDisabled(db, (tx) =>
        tx.$executeRawUnsafe(
            `DELETE FROM "OrgAuditLog" WHERE "organizationId" = ANY($1::text[])`,
            ids,
        ),
    );
}

/**
 * Columns a tamper test is allowed to forge, per table.
 *
 * A closed union, not a free string: the column name cannot be parameterised
 * in SQL, so it is interpolated, and interpolating an arbitrary caller string
 * into DDL-shaped SQL is the injection this list forecloses. The runtime
 * check below is not redundant with the type — a `.ts` test can be wrong at
 * runtime in ways `tsc` did not see (an `as any`, a value read from a
 * fixture).
 */
const TAMPERABLE: Record<AuditTable, readonly string[]> = {
    AuditLog: ['action', 'details', 'entryHash'],
    OrgAuditLog: ['actorType', 'entryHash'],
};

async function tamper(
    db: RawSqlClient,
    table: AuditTable,
    id: string,
    column: string,
    value: string,
): Promise<number> {
    if (!TAMPERABLE[table].includes(column)) {
        throw new Error(
            `audit-cleanup: "${column}" is not a tamperable column of ${table} ` +
                `(allowed: ${TAMPERABLE[table].join(', ')})`,
        );
    }
    return withAuditTriggersDisabled(db, (tx) =>
        tx.$executeRawUnsafe(
            `UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`,
            value,
            id,
        ),
    );
}

/**
 * Forge one column of one committed `AuditLog` row, trigger disabled.
 *
 * The POINT is that the row's stored `entryHash` was computed before the
 * forgery, so chain verification must now report the row as broken. Used
 * only to prove tampering is detectable.
 */
export function tamperAuditRow(
    db: RawSqlClient,
    id: string,
    column: 'action' | 'details' | 'entryHash',
    value: string,
): Promise<number> {
    return tamper(db, 'AuditLog', id, column, value);
}

/** `tamperAuditRow` for the organization trail. */
export function tamperOrgAuditRow(
    db: RawSqlClient,
    id: string,
    column: 'actorType' | 'entryHash',
    value: string,
): Promise<number> {
    return tamper(db, 'OrgAuditLog', id, column, value);
}

/**
 * Attempt a raw UPDATE against an audit trail WITH NO BYPASS, so the caller
 * can assert the immutability trigger refuses it.
 *
 * Deliberately does not catch. The rejection IS the result under test —
 * `audit-immutability.test.ts` matches the raised message against
 * `IMMUTABLE_AUDIT_LOG` and checks it names the operation and says
 * "append-only". Never give this function a bypass.
 */
export function attemptAuditUpdate(
    db: RawSqlTx,
    table: AuditTable,
    setClause: string,
    whereClause: string,
    ...params: unknown[]
): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "${table}" SET ${setClause} WHERE ${whereClause}`,
        ...params,
    );
}

/**
 * Attempt a raw DELETE against an audit trail WITH NO BYPASS, so the caller
 * can assert the immutability trigger refuses it. See `attemptAuditUpdate`.
 */
export function attemptAuditDelete(
    db: RawSqlTx,
    table: AuditTable,
    whereClause: string,
    ...params: unknown[]
): Promise<number> {
    return db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${whereClause}`, ...params);
}
