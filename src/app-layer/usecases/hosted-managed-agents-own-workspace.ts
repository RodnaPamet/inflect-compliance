/**
 * A HOSTED WORKSPACE CONNECTS ITS OWN ANTHROPIC WORKSPACE (#4173, owner
 * decision 3 of 2026-11-25; `docs/claude-managed-agents-design.md`, MA-C1 "A
 * tenant's own workspace wins").
 *
 * From the moment a workspace saves an enabled `anthropic-workspace`
 * connection of its own, its runs go there (`resolveManagedAgentsWorkspace`),
 * never to Inflect's workspace again. What Inflect created for it in Inflect's
 * workspace (sessions and agents, Step 6b) is then cleaned up automatically,
 * BY RECORDED ID, through Step 5c's own clean-up: a `CONNECTION_REMOVED`
 * record under the fixed connection id `inflect-hosted`, exactly the record an
 * owner's opt-out opens. Its first attempt is made at once; what it leaves
 * stays OPEN and the data-lifecycle job retries it, or it ends `ABANDONED`
 * after 30 days, as every hosted clean-up does. No new trigger or reason: the
 * record says what it is (Inflect's workspace, removed from this tenant), and
 * the opt-in's audit row says why.
 *
 * WHEN. Only when the workspace has hosted records the clean-up has not
 * already covered: an opt-in, an OPEN hosted clean-up, or a hosted provision
 * or a hosted run created after the newest DONE hosted clean-up's
 * `coversUntil` (any, when there is none). So the first save of an own
 * connection cleans up, and a later save (a rename, a second connection, a
 * re-enable) sends nothing for objects already removed.
 *
 * THE OPT-IN IS WITHDRAWN TOO (`withdrawHostedOptInOnOwnWorkspace`, in the
 * opt-in's one-writer file): see there for why.
 *
 * NEVER THROWS, and is called only after the connection save has COMMITTED:
 * a hosted clean-up that cannot run never fails the customer's save. While
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is false the hosted workspace cannot be
 * opened (`inflectHostedWorkspace` returns before it reads Inflect's key), so
 * a record with anything to remove stays OPEN, `HOSTED_NOT_ACTIVE`, and no
 * request leaves.
 */
import type { RequestContext } from '@/app-layer/types';
import { withdrawHostedOptInOnOwnWorkspace } from '@/app-layer/usecases/hosted-managed-agents-opt-in';
import { openConnectionRemovalCleanup, type CleanupStatus } from '@/app-layer/usecases/managed-agents-cleanup';
import { INFLECT_HOSTED_CONNECTION_ID } from '@/lib/agentic/managed-agents/workspace';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

/** What the workspace holds in Inflect's workspace that no finished clean-up covers. */
export interface UncoveredHostedRecords {
    readonly optedIn: boolean;
    /** A hosted clean-up still OPEN: a new attempt joins it. */
    readonly openCleanup: boolean;
    /** A hosted provision or a hosted run newer than the newest DONE hosted clean-up. */
    readonly recordsSinceLastCleanup: boolean;
}

/** Ids and flags only, in the tenant's own context. */
export async function readUncoveredHostedRecords(ctx: RequestContext): Promise<UncoveredHostedRecords> {
    return runInTenantContext(ctx, async (db) => {
        const [settings, open, lastDone] = await Promise.all([
            db.tenantSecuritySettings.findUnique({ where: { tenantId: ctx.tenantId }, select: { hostedManagedAgentsOptIn: true } }),
            db.managedAgentsCleanup.findFirst({
                where: { tenantId: ctx.tenantId, connectionId: INFLECT_HOSTED_CONNECTION_ID, status: 'OPEN' },
                select: { id: true },
            }),
            db.managedAgentsCleanup.findFirst({
                where: { tenantId: ctx.tenantId, connectionId: INFLECT_HOSTED_CONNECTION_ID, status: 'DONE' },
                select: { coversUntil: true },
                orderBy: { coversUntil: 'desc' },
            }),
        ]);
        // The clean-up's own scope rule: it covers what was created at or
        // before its `coversUntil` (provisions by `createdAt`, the ledger by
        // its run's `createdAt`).
        const after = lastDone ? { createdAt: { gt: lastDone.coversUntil } } : {};
        const [provision, run] = await Promise.all([
            db.agentProfileProvision.findFirst({
                where: { tenantId: ctx.tenantId, connectionId: INFLECT_HOSTED_CONNECTION_ID, ...after },
                select: { id: true },
            }),
            db.workflowRun.findFirst({
                where: { tenantId: ctx.tenantId, hostedManagedAgents: true, ...after },
                select: { id: true },
            }),
        ]);
        return {
            optedIn: settings?.hostedManagedAgentsOptIn === true,
            openCleanup: Boolean(open),
            recordsSinceLastCleanup: Boolean(provision || run),
        };
    });
}

export interface OwnWorkspaceHostedCleanup {
    /** The opt-in was on, and is now withdrawn. */
    readonly optInWithdrawn: boolean;
    /** The hosted clean-up's first attempt, or null when there was nothing to clean up. */
    readonly cleanup: { readonly status: CleanupStatus; readonly reason: string | null } | null;
}

/**
 * The workspace saved an enabled `anthropic-workspace` connection of its own
 * (`connectionId`). Withdraw its hosted opt-in and clean up what Inflect
 * created for it in Inflect's workspace. Never throws.
 */
export async function cleanUpHostedOnOwnWorkspaceConnected(
    ctx: RequestContext,
    connectionId: string,
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<OwnWorkspaceHostedCleanup> {
    try {
        const held = await readUncoveredHostedRecords(ctx);
        if (!held.optedIn && !held.openCleanup && !held.recordsSinceLastCleanup) return { optInWithdrawn: false, cleanup: null };
        // The opt-in first: once it is off, no new hosted run can start while
        // the clean-up runs (the own connection already wins the resolution).
        const optInWithdrawn = held.optedIn ? await withdrawHostedOptInOnOwnWorkspace(ctx, connectionId) : false;
        // Step 5c's clean-up of Inflect's workspace, by recorded id. It never
        // throws, and returns null only when it could not open its record.
        const cleanup = await openConnectionRemovalCleanup(ctx, INFLECT_HOSTED_CONNECTION_ID, options);
        logger.info('managed-agents: own Anthropic workspace connected; the hosted records are being cleaned up', {
            component: 'managed-agents-cleanup',
            tenantId: ctx.tenantId,
            connectionId,
            optInWithdrawn,
            status: cleanup?.status ?? 'NOT_OPENED',
            reason: cleanup?.reason ?? null,
        });
        return { optInWithdrawn, cleanup };
    } catch (err) {
        logger.error('managed-agents: the hosted clean-up after an own workspace was connected could not be opened', {
            component: 'managed-agents-cleanup',
            tenantId: ctx.tenantId,
            connectionId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
        return { optInWithdrawn: false, cleanup: null };
    }
}
