/**
 * A fake `integrationExecution.groupBy` that EVALUATES the caller's `where`.
 *
 * #2252 — both freshness surfaces (`getEnabledConnectionFreshness` for the OTel
 * gauge, `getConnectionsHealth` for the admin view) decide what counts as a
 * successful collection inside a Prisma `where`: PASSED for every provider,
 * plus FAILED for cloud-posture providers only. Stubbing that query's RESULT
 * would make a test about the fixture, not about the predicate — it would pass
 * unchanged if the allowlist widened fleet-wide, narrowed back to PASSED-only,
 * or became a `{ not: 'ERROR' }` denylist admitting RUNNING.
 *
 * So these helpers run a tiny in-memory execution table THROUGH the real
 * `where`, and group the survivors the way Prisma would. One copy, shared by
 * both suites, so the two cannot verify subtly different things.
 */

/** A row of the fake `IntegrationExecution` table. */
export interface FakeExecution {
    connectionId: string;
    status: string;
    completedAt?: Date | null;
    executedAt?: Date | null;
}

/** The subset of Prisma filter shapes these two call sites actually build. */
type ValueFilter = string | { in?: readonly string[]; not?: string };

export interface FakeWhere {
    tenantId?: string;
    status?: ValueFilter;
    connectionId?: ValueFilter;
    OR?: FakeWhere[];
}

export interface FakeGroupRow {
    connectionId: string;
    _max: { completedAt: Date | null; executedAt: Date | null };
}

function allowed(filter: ValueFilter | undefined, value: string): boolean {
    if (filter === undefined) return true;
    if (typeof filter === 'string') return filter === value;
    if (filter.in !== undefined) return filter.in.includes(value);
    // Present so a `{ not: 'ERROR' }` denylist is EVALUATED rather than
    // silently ignored — the tests that reject RUNNING must fail loudly if
    // someone swaps the allowlist for one.
    if (filter.not !== undefined) return filter.not !== value;
    return true;
}

function clauseMatches(exec: FakeExecution, clause: FakeWhere): boolean {
    if (clause.OR !== undefined && !clause.OR.some((c) => clauseMatches(exec, c))) return false;
    return allowed(clause.status, exec.status) && allowed(clause.connectionId, exec.connectionId);
}

function newer(a: Date | null, b: Date | null): Date | null {
    if (a === null) return b;
    if (b === null) return a;
    return a > b ? a : b;
}

/**
 * Group `rows` by connectionId after filtering them through `where`, exactly as
 * `groupBy({ by: ['connectionId'], _max: { completedAt, executedAt } })` would.
 */
export function groupExecutionsBy(rows: FakeExecution[], where: FakeWhere): FakeGroupRow[] {
    const byConn = new Map<string, FakeGroupRow['_max']>();
    for (const e of rows) {
        if (!clauseMatches(e, where)) continue;
        const cur = byConn.get(e.connectionId) ?? { completedAt: null, executedAt: null };
        byConn.set(e.connectionId, {
            completedAt: newer(cur.completedAt, e.completedAt ?? null),
            executedAt: newer(cur.executedAt, e.executedAt ?? null),
        });
    }
    return [...byConn.entries()].map(([connectionId, _max]) => ({ connectionId, _max }));
}

/** A `jest.fn()` shaped like Prisma's groupBy, backed by `rows`. */
export function fakeExecutionGroupBy(rows: FakeExecution[]) {
    return jest.fn(async (args: { where?: FakeWhere }): Promise<FakeGroupRow[]> =>
        groupExecutionsBy(rows, args.where ?? {}),
    );
}
