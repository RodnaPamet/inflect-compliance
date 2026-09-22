/**
 * Hard-purge the data of tenants deleted from the org plane (#2747).
 *
 * ═══ THE BUG THIS FIXES ═══
 *
 * `deleteTenant` sets `Tenant.deletedAt` and nothing ever removes the rows
 * behind it. The org plane says "deleted", every view hides the tenant, and the
 * data stays forever — 9 soft-deleted tenants were still holding 768 controls
 * when this was reported. "Deleted" was a promise the product did not keep.
 *
 * ═══ WHY A TOMBSTONE REMAINS, AND WHY THAT IS NOT A CLIMBDOWN ═══
 *
 * The `Tenant` row itself is NOT deleted, and cannot be:
 *
 *   `AuditLog.tenantId` is `String` (NOT NULL) with a non-cascading FK to
 *   `Tenant`. So are `Incident`, `IncidentNotification`,
 *   `IncidentTimelineEntry` and `ReadinessSnapshot`.
 *
 * `docs/data-retention.md` classes exactly those as **regulatory artefacts** —
 * *"immutable + hash-chained … Retention is a legal decision; we do not delete
 * by default"* — and marks `AiDecisionLog` an EU AI Act Art 12 record needing
 * legal input. Deleting the tenant row therefore requires either destroying a
 * hash-chained regulatory record or nulling its tenant attribution, and both
 * are decisions for a compliance owner rather than a purge job.
 *
 * So the purge empties the tenant and leaves a tombstone. Every Business record
 * and Configuration row goes; the regulatory trail and the row it points at
 * stay. That is what fixes the report: the DATA is gone and the tenant is gone
 * from every view. Owner decision, 2026-09-22.
 *
 * ═══ WHY THE ORDER IS DERIVED, NOT LISTED ═══
 *
 * 173 relations point at `Tenant` and only 42 cascade, so a naive
 * `tenant.delete()` fails on 131 foreign keys. A hand-maintained deletion order
 * would be wrong the first time somebody adds a model and forgets — and the
 * failure would be a half-purged tenant.
 *
 * The order is therefore computed from the LIVE foreign-key graph in
 * `pg_constraint`, children before parents. The database is the authority on
 * its own constraints; a list in TypeScript is a copy that rots.
 *
 * ═══ WHY IT MUST NOT RUN AS app_user ═══
 *
 * 186 tables carry FORCE ROW LEVEL SECURITY. Their `tenant_isolation` policy
 * matches `current_setting('app.tenant_id')`, so a purge running as `app_user`
 * would delete NOTHING for any tenant but the one in context — and report
 * success, because a DELETE that matches no rows is not an error. That is the
 * silent-zero failure this codebase has been bitten by before.
 *
 * Every table also carries `superuser_bypass`:
 * `current_setting('role') <> 'app_user'`. `runInGlobalContext` does not set
 * that role, so it bypasses — which is exactly why the purge uses it and why
 * this comment exists to stop someone "tidying" it onto a tenant-scoped client.
 *
 * @module usecases/tenant-purge
 */
import { runInGlobalContext } from '@/lib/db-context';
import { internal } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/**
 * Tables whose rows survive a tenant purge, and the reason each one does.
 *
 * FROZEN without a compliance decision. Adding a name here retains data the
 * owner asked to be deleted; removing one destroys a record `data-retention.md`
 * says is not ours to delete.
 */
export const TENANT_PURGE_RETAINED: ReadonlySet<string> = new Set([
    // Every model `docs/data-retention.md` classes as a REGULATORY ARTEFACT
    // and that carries a tenantId — i.e. every one this purge could otherwise
    // reach. The list is not curated by hand: `tests/guardrails/
    // tenant-purge-retains-regulatory.test.ts` re-derives it from the doc and
    // fails if the two drift, in either direction.
    //
    // I originally listed eight of these from memory. The guard found nine
    // more, including `IdentityWriteJournal` — of which the doc says
    // "deleting an employee for privacy must not erase the record that their
    // access was revoked, which is frequently the artefact an auditor asks
    // for". That is the class of mistake this list exists to prevent.
    'AccessReviewConnectedDecision',
    'AgentActionReceipt',
    'AgentKillSwitch',
    'AgentKillSwitchDrill',
    'AgentPolicyCardVersion',
    'AgentProposalApproval',
    'AgentProposalSampleAudit',
    'AgenticEvidenceArtefact',
    'AiDecisionLog',
    'AuditLog',
    'IdentityWriteJournal',
    'Incident',
    'IncidentEvidence',
    'IncidentNotification',
    'IncidentTimelineEntry',
    'ReadinessSnapshot',
    'TenantCalendarConsent',

    // The tombstone the artefacts above point at. `AuditLog.tenantId` is NOT
    // NULL with a non-cascading FK, so the Tenant row cannot go while they
    // stay — see the module docblock.
    'Tenant',
]);

/** Days a soft-deleted tenant is recoverable before its data is purged. */
export const DEFAULT_TENANT_PURGE_GRACE_DAYS = 90;

export interface TenantPurgeOptions {
    now?: Date;
    graceDays?: number;
    /** Report what WOULD be deleted and change nothing. */
    dryRun?: boolean;
    /** Purge only this tenant, ignoring the grace period. For operator use. */
    tenantId?: string;
}

export interface TenantPurgeResult {
    readonly tenantId: string;
    readonly slug: string;
    readonly deletedAt: Date | null;
    /** rows removed per table, tables with zero omitted */
    readonly deleted: Record<string, number>;
    readonly totalRows: number;
    readonly dryRun: boolean;
}

/** A table that carries `tenantId`, with its FK dependencies. */
interface TableNode {
    readonly table: string;
    readonly dependsOn: ReadonlySet<string>;
}

/**
 * Every public table holding a `tenantId`, with the tables each one references.
 *
 * Read from the live catalogue rather than from Prisma's schema so the order
 * reflects the constraints the database will actually enforce.
 */
async function tenantScopedTables(db: {
    $queryRawUnsafe: (q: string) => Promise<unknown>;
}): Promise<TableNode[]> {
    const withTenant = (await db.$queryRawUnsafe(`
        SELECT c.table_name AS table
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND c.column_name = 'tenantId'
           AND t.table_type = 'BASE TABLE'
    `)) as Array<{ table: string }>;

    const fks = (await db.$queryRawUnsafe(`
        SELECT child.relname AS child, parent.relname AS parent
          FROM pg_constraint con
          JOIN pg_class child  ON child.oid  = con.conrelid
          JOIN pg_class parent ON parent.oid = con.confrelid
          JOIN pg_namespace n  ON n.oid = child.relnamespace
         WHERE con.contype = 'f' AND n.nspname = 'public'
    `)) as Array<{ child: string; parent: string }>;

    const names = new Set(withTenant.map((r) => r.table));
    const deps = new Map<string, Set<string>>();
    for (const t of names) deps.set(t, new Set());
    for (const { child, parent } of fks) {
        // Only edges BETWEEN tenant-scoped tables matter for ordering; a
        // reference to a global table is never a reason to wait.
        if (child !== parent && names.has(child) && names.has(parent)) {
            deps.get(child)!.add(parent);
        }
    }
    return [...names].map((table) => ({ table, dependsOn: deps.get(table)! }));
}

/**
 * Children first. Cycles are broken deterministically by name rather than
 * throwing: a self-referencing hierarchy (`RiskHierarchyNode` has one) is a
 * legitimate shape, and the rows inside it still delete once the whole table
 * goes in one statement.
 */
export function deletionOrder(nodes: readonly TableNode[]): string[] {
    const remaining = new Map(nodes.map((n) => [n.table, new Set(n.dependsOn)]));
    const order: string[] = [];
    while (remaining.size > 0) {
        // A table nothing remaining depends ON can go first — i.e. it is not a
        // parent of anything still queued.
        const parentsStillNeeded = new Set<string>();
        for (const deps of remaining.values()) for (const d of deps) parentsStillNeeded.add(d);
        const ready = [...remaining.keys()].filter((t) => !parentsStillNeeded.has(t)).sort();
        if (ready.length === 0) {
            // Cycle: take the alphabetically first and move on.
            const forced = [...remaining.keys()].sort()[0];
            order.push(forced);
            remaining.delete(forced);
            for (const deps of remaining.values()) deps.delete(forced);
            continue;
        }
        for (const t of ready) {
            order.push(t);
            remaining.delete(t);
        }
        for (const deps of remaining.values()) for (const t of ready) deps.delete(t);
    }
    return order;
}

/**
 * Purge the data of tenants soft-deleted longer ago than the grace period.
 *
 * Returns one result per tenant purged. A tenant with nothing left to delete
 * still returns a result with `totalRows: 0` — "already empty" and "not
 * considered" must not look the same to whoever reads the job output.
 */
export async function purgeSoftDeletedTenants(
    options: TenantPurgeOptions = {},
): Promise<TenantPurgeResult[]> {
    const now = options.now ?? new Date();
    const graceDays = options.graceDays ?? DEFAULT_TENANT_PURGE_GRACE_DAYS;
    const dryRun = options.dryRun ?? false;
    const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

    return runInGlobalContext(async (db) => {
        const raw = db as unknown as {
            $queryRawUnsafe: (q: string) => Promise<unknown>;
            $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
        };

        const tenants = (await raw.$queryRawUnsafe(
            options.tenantId
                ? `SELECT id, slug, "deletedAt" FROM "Tenant" WHERE id = '${options.tenantId.replace(/'/g, "''")}'`
                : `SELECT id, slug, "deletedAt" FROM "Tenant"
                    WHERE "deletedAt" IS NOT NULL AND "deletedAt" < '${cutoff.toISOString()}'`,
        )) as Array<{ id: string; slug: string; deletedAt: Date | null }>;

        if (tenants.length === 0) return [];

        const order = deletionOrder(await tenantScopedTables(raw)).filter(
            (t) => !TENANT_PURGE_RETAINED.has(t),
        );

        const results: TenantPurgeResult[] = [];
        for (const tenant of tenants) {
            // ONE TRANSACTION PER TENANT, and the first real run is why.
            //
            // Without it the purge hit the LAST_OWNER_GUARD trigger part-way
            // through and left the tenant HALF PURGED — TenantSecuritySettings
            // already gone, memberships still present. A tenant in that state
            // is worse than either end of the operation: it is not recoverable
            // by restoring the soft delete, and not finished either.
            //
            // Per tenant rather than per run, so one tenant failing does not
            // roll back the ones that already succeeded.
            const { deleted, totalRows } = await (
                db as unknown as {
                    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
                }
            ).$transaction(async (txRaw) => {
                const tx = txRaw as typeof raw;
                return purgeOneTenant(tx, tenant.id, order, dryRun);
            });
            results.push({
                tenantId: tenant.id,
                slug: tenant.slug,
                deletedAt: tenant.deletedAt,
                deleted,
                totalRows,
                dryRun,
            });
            logger.info(
                {
                    component: 'tenant-purge',
                    tenantId: tenant.id,
                    slug: tenant.slug,
                    tables: Object.keys(deleted).length,
                    totalRows,
                    dryRun,
                    retained: [...TENANT_PURGE_RETAINED],
                },
                dryRun ? 'tenant purge (dry run)' : 'tenant purged',
            );
        }
        return results;
    });
}

/**
 * Delete one tenant's rows, children first. Split out so the whole thing can
 * sit inside a single transaction — see the call site for why that matters.
 */
/**
 * Tables a purge must NEVER issue DML against, whatever the retained set says.
 *
 * DEFENCE IN DEPTH, not a duplicate of `TENANT_PURGE_RETAINED`. That set is a
 * policy decision derived from a document and checked by a guard; this is a
 * last-ditch refusal in the code path that actually builds the SQL. If the two
 * ever disagree, the purge stops rather than deletes.
 *
 * It exists because this function interpolates a table name into `DELETE FROM
 * "${table}"`. `audit-immutability-guardrails` flags that shape on sight, and
 * its comment names the precedent: `tests/e2e/global-teardown.ts` looped a
 * hand-maintained list with 'AuditLog' in it through exactly this statement.
 * A hash-chained regulatory record is not something to protect with one list.
 */
const NEVER_DML: ReadonlySet<string> = new Set(['AuditLog', 'OrgAuditLog', 'AiDecisionLog']);

async function purgeOneTenant(
    raw: {
        $queryRawUnsafe: (q: string) => Promise<unknown>;
        $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
    },
    tenantId: string,
    order: readonly string[],
    dryRun: boolean,
): Promise<{ deleted: Record<string, number>; totalRows: number }> {
    const deleted: Record<string, number> = {};
    let totalRows = 0;
    for (const table of order) {
        // Table names come from the catalogue, never from a caller — and even
        // so, an audit table reaching here is a bug that must not proceed.
        if (NEVER_DML.has(table)) {
            throw internal(
                `tenant-purge refused to issue DML against "${table}": it is an append-only ` +
                    'audit table. The retained set and NEVER_DML disagree, which means one of ' +
                    'them is wrong — nothing was purged for this tenant.',
            );
        }
        const n = dryRun
            ? ((await raw.$queryRawUnsafe(
                  `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = '${tenantId.replace(/'/g, "''")}'`,
              )) as Array<{ n: number }>)[0]?.n ?? 0
            : await raw.$executeRawUnsafe(
                  `DELETE FROM "${table}" WHERE "tenantId" = $1`,
                  tenantId,
              );
        if (n > 0) {
            deleted[table] = n;
            totalRows += n;
        }
    }
    return { deleted, totalRows };
}
