/**
 * HOW MANY HOSTED RUNS MAY EXECUTE AT ONCE (Step 6b of
 * `docs/claude-managed-agents-design.md`, shape MA-C1).
 *
 * Anthropic's rate limits belong to an ORGANISATION, and every tenant hosted
 * in Inflect's workspace shares Inflect's. So hosted runs have two caps, both
 * source constants (never a tenant setting, never an environment variable a
 * tenant can reach):
 *
 *   HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT  one tenant's hosted runs executing
 *                                          at once;
 *   HOSTED_MAX_CONCURRENT_RUNS             this deployment's, across tenants.
 *
 * The per-tenant cap is below the deployment's, so one tenant's burst always
 * leaves a slot for another.
 *
 * WHY THESE NUMBERS. The binding limit is the Environments API: 60 requests a
 * minute and at most FIVE concurrent requests per organisation (Agents and
 * Sessions allow 300 creates and 600 other requests a minute). Every segment of
 * a run re-reads its environment before its session exists (#5854), and
 * production and staging are two deployments of one organisation, each with a
 * workspace of its own (MA-C1). Two hosted runs per deployment keeps both
 * deployments' segment starts below five concurrent environment reads even
 * when every run starts at the same instant. Raising either number is a
 * reviewed diff here.
 *
 * WHY A RUN OVER A CAP IS REFUSED, NOT HELD. A refusal is settled before any
 * client exists or any session is created, with a named reason
 * (`managed_agents_hosted_capacity_tenant` / `_deployment`), and the run can
 * be started again. Waiting would either hold a worker and its run lease while
 * doing nothing, or re-enqueue the segment, and #5900 names each segment's job
 * by the instant that authorised it, so BullMQ drops a second enqueue of the
 * same segment: a delayed retry would silently never run.
 *
 * THE COUNT is the run lease's own definition of "executing" (#5900): a run
 * that is RUNNING with a lease that has not lapsed on the database's clock.
 * The SQL function `hosted_managed_agents_claim_slot` (migration
 * `20261124140000_hosted_managed_agents`) counts them under one advisory lock
 * and marks this run `hostedManagedAgents` in the same transaction, so two
 * runs can never both take the last slot. A run stops counting when it
 * settles, pauses or releases its lease, or when a dead worker's lease lapses:
 * a slot is never released by hand and can never leak.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/** One tenant's hosted runs executing at once. Below the deployment's, so a burst leaves room. */
export const HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT = 1;

/** This deployment's hosted runs executing at once, across every tenant. */
export const HOSTED_MAX_CONCURRENT_RUNS = 2;

/** Why a hosted run may not take a slot. */
export type HostedCapacityRefusal =
    /** This tenant already has `HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT` hosted runs executing. */
    | 'HOSTED_CAPACITY_TENANT'
    /** This deployment already has `HOSTED_MAX_CONCURRENT_RUNS` hosted runs executing. */
    | 'HOSTED_CAPACITY_DEPLOYMENT'
    /**
     * The run holds no lease, so it cannot be counted: a hosted run executes
     * only on the worker, which claims one first. Refused rather than run
     * uncounted.
     */
    | 'HOSTED_RUN_NOT_LEASED';

const OUTCOME: Readonly<Record<string, HostedCapacityRefusal | null>> = {
    CLAIMED: null,
    TENANT_CAP: 'HOSTED_CAPACITY_TENANT',
    DEPLOYMENT_CAP: 'HOSTED_CAPACITY_DEPLOYMENT',
    NOT_HELD: 'HOSTED_RUN_NOT_LEASED',
};

/**
 * Take a hosted slot for this run, or say which cap refused it. Idempotent
 * for a run that already holds one (a resumed segment counts itself out).
 */
export async function claimHostedSlot(
    ctx: RequestContext,
    runId: string,
    caps: { readonly perTenant: number; readonly deployment: number } = {
        perTenant: HOSTED_MAX_CONCURRENT_RUNS_PER_TENANT,
        deployment: HOSTED_MAX_CONCURRENT_RUNS,
    },
): Promise<{ ok: true } | { ok: false; reason: HostedCapacityRefusal }> {
    const lease = ctx.runLeaseToken;
    if (!lease) return { ok: false, reason: 'HOSTED_RUN_NOT_LEASED' };
    const rows = await runInTenantContext(ctx, (db) =>
        db.$queryRaw<Array<{ outcome: string }>>`
            SELECT hosted_managed_agents_claim_slot(
                ${ctx.tenantId}, ${runId}, ${lease}, ${caps.perTenant}::int, ${caps.deployment}::int
            ) AS outcome`,
    );
    const outcome = rows[0]?.outcome ?? 'NOT_HELD';
    const refusal = Object.prototype.hasOwnProperty.call(OUTCOME, outcome) ? OUTCOME[outcome] : 'HOSTED_RUN_NOT_LEASED';
    return refusal ? { ok: false, reason: refusal } : { ok: true };
}
