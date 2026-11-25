/**
 * The Prisma-backed `MappingStore` (#5937 step 2): one person's
 * `UserCalendarEventMapping` rows for one provider.
 *
 * ═══ ONE SHORT TRANSACTION PER CALL ═══
 *
 * Every method opens its own tenant transaction through `run` — the job's
 * `runInTenantJobContext` or a request's `runInTenantContext` — and closes it
 * before returning. The sweep calls the store between provider requests, and a
 * transaction held across an HTTP call to Google or Graph pins a Postgres
 * backend (and a PgBouncer server connection) for the provider's latency.
 *
 * ═══ RLS AND THE APPLICATION FILTER, BOTH ═══
 *
 * Every query names `tenantId`, `userId` and `provider` in its `where`, and
 * runs as `app_user` with the tenant bound, so the table's `tenant_isolation`
 * policy holds even if a filter were dropped (do-not-touch §2's two layers).
 *
 * @module usecases/calendar-mapping-store
 */
import type { ExistingMapping } from './calendar-event-reconcile';
import type { MappingStore } from './calendar-reconcile-sweep';
import type { CalendarConnectionIdentity, CalendarTenantRun } from './user-calendar-connection';

/**
 * Rows read per person per provider. A person's own deadlines over a 90-day
 * window are far below it; the bound is the guardrail's, not a product limit.
 */
export const MAPPING_READ_CAP = 10_000;

/** Operator-facing and bounded; never rendered to the person. */
const ERROR_MAX = 300;

export function createPrismaMappingStore(
    run: CalendarTenantRun,
    identity: CalendarConnectionIdentity,
    now: () => Date = () => new Date(),
): MappingStore {
    const owner = { tenantId: identity.tenantId, userId: identity.userId, provider: identity.provider };
    const one = (sourceKey: string, sourceEntityId: string) => ({ ...owner, sourceKey, sourceEntityId });

    return {
        async list(): Promise<ExistingMapping[]> {
            return run((db) =>
                db.userCalendarEventMapping.findMany({
                    where: owner,
                    select: {
                        sourceKey: true,
                        sourceEntityId: true,
                        remoteEventId: true,
                        clientEventId: true,
                        contentHash: true,
                        state: true,
                    },
                    orderBy: { id: 'asc' },
                    take: MAPPING_READ_CAP,
                }),
            );
        },

        async upsertPushed({ sourceKey, sourceEntityId, remoteEventId, clientEventId, contentHash }) {
            const at = now();
            await run((db) =>
                db.userCalendarEventMapping.upsert({
                    where: { tenantId_userId_provider_sourceKey_sourceEntityId: one(sourceKey, sourceEntityId) },
                    create: {
                        ...one(sourceKey, sourceEntityId),
                        remoteEventId,
                        clientEventId,
                        contentHash,
                        state: 'PUSHED',
                        lastPushedAt: at,
                    },
                    update: {
                        remoteEventId,
                        // A patch passes '' — it never chose an id. Keep the
                        // one the insert recorded.
                        ...(clientEventId ? { clientEventId } : {}),
                        contentHash,
                        state: 'PUSHED',
                        lastError: null,
                        lastPushedAt: at,
                    },
                }),
            );
        },

        async markFailed({ sourceKey, sourceEntityId, error }) {
            // updateMany: a failed FIRST insert has no row, and needs none — the
            // next run inserts again under the same deterministic client id.
            await run((db) =>
                db.userCalendarEventMapping.updateMany({
                    where: one(sourceKey, sourceEntityId),
                    data: { state: 'FAILED', lastError: error.slice(0, ERROR_MAX) },
                }),
            );
        },

        async drop({ sourceKey, sourceEntityId }) {
            await run((db) => db.userCalendarEventMapping.deleteMany({ where: one(sourceKey, sourceEntityId) }));
        },

        async markPendingDelete({ sourceKey, sourceEntityId, error }) {
            await run((db) =>
                db.userCalendarEventMapping.updateMany({
                    where: one(sourceKey, sourceEntityId),
                    data: { state: 'PENDING_DELETE', lastError: error.slice(0, ERROR_MAX) },
                }),
            );
        },
    };
}
