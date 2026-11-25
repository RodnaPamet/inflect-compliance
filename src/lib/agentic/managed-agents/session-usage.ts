/**
 * WHAT A HOSTED SESSION COST INFLECT IN TIME (#4173, owner decision 4 of
 * 2026-11-25; `docs/claude-managed-agents-design.md`, MA-C1 "Inflect pays").
 *
 * A Managed Agents session in Inflect's own Anthropic workspace (Step 6b) is
 * billed to Inflect for its tokens AND for the time it runs. The tokens are
 * already recorded per tenant (`WorkflowRun.costTokens` on a run marked
 * `hostedManagedAgents`). The time is the session object's
 * `usage.active_seconds` (`BetaManagedAgentsSessionUsage` in
 * `@anthropic-ai/sdk`): "the duration the session's runtime cost is priced
 * on", with concurrent threads counted once. It is OPTIONAL in the SDK's type,
 * so an absent figure is not a zero.
 *
 * THE RECORD is two columns on the run, written only here and only on a hosted
 * run (the WHERE below, and a CHECK in migration
 * `20261125120000_hosted_session_usage`):
 *
 *   hostedSessionsUnmetered  +1 when a hosted session's `SESSION_CREATED` step
 *                            is written (`openHostedSessionMeter`), −1 when its
 *                            usage is read at settle;
 *   hostedSessionSeconds     the sum of what was read; NULL while nothing was.
 *
 * So a session whose usage is never read (the read failed, it was still
 * running when the settle gave up, a dead worker left it to the
 * reconciliation) stays counted as UNKNOWN, and no path turns "not known"
 * into zero. A run in the tenant's OWN workspace records nothing here: that
 * time is the customer's, billed to the customer.
 *
 * NEVER BLOCKS THE SETTLE. `meterHostedSession` never throws: a failure to
 * read or to write is logged and counted, and the caller deletes the session
 * whatever happened here. The read itself is the settle's own
 * `sessions.retrieve` (it already polls the status before the delete), so
 * metering adds no request to the workspace.
 *
 * This module holds two writes and a pure parse; no permission check and no
 * usecase (global rule 2 of `docs/claude-agent-sdk-design.md`).
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { recordHostedSessionUsage } from '@/lib/observability/metrics';

/** Why a hosted session's usage is not known. */
export type HostedSessionUsageUnknown =
    /** `sessions.retrieve` threw: the network, a refusal, a 404. */
    | 'READ_FAILED'
    /** The last read still said `running` / `rescheduling`: its time was still growing. */
    | 'STILL_RUNNING'
    /** The session answered without `usage.active_seconds` (optional in the SDK). */
    | 'NOT_REPORTED';

export type HostedSessionUsageRead =
    | { readonly ok: true; readonly activeSeconds: number }
    | { readonly ok: false; readonly reason: HostedSessionUsageUnknown };

/**
 * The session's priced time, from one `sessions.retrieve` answer. Pure. A
 * session still running is not final, and a missing, negative or non-finite
 * figure is not one: each is UNKNOWN, never zero.
 */
export function sessionUsageFrom(session: { readonly status?: unknown; readonly usage?: unknown }): HostedSessionUsageRead {
    if (session.status === 'running' || session.status === 'rescheduling') return { ok: false, reason: 'STILL_RUNNING' };
    const usage = session.usage && typeof session.usage === 'object' ? (session.usage as { active_seconds?: unknown }) : null;
    const seconds = usage?.active_seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: 'NOT_REPORTED' };
    return { ok: true, activeSeconds: seconds };
}

/**
 * A hosted session was created and recorded: it is UNKNOWN until its usage is
 * read. Called beside the session's `SESSION_CREATED` step. Writes only a run
 * marked hosted. Never throws.
 */
export async function openHostedSessionMeter(ctx: RequestContext, runId: string): Promise<void> {
    // Log fields are read off this object, so each value's name is its own.
    const run = { runId } as const;
    try {
        await runInTenantContext(ctx, (db) =>
            db.$executeRaw`
                UPDATE "WorkflowRun"
                   SET "hostedSessionsUnmetered" = "hostedSessionsUnmetered" + 1
                 WHERE "id" = ${runId} AND "tenantId" = ${ctx.tenantId} AND "hostedManagedAgents" = true`,
        );
    } catch (err) {
        // The session is still settled and its usage still read; only the
        // count of sessions whose time is unknown misses this one.
        logger.error('managed-agents: a hosted session could not be counted for metering', {
            component: 'agentic',
            runId: run.runId,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
    }
}

/**
 * Record what one hosted session's read said, BEFORE it is deleted. A known
 * figure is added to the run's seconds and the session leaves the unmetered
 * count; an unknown one leaves the count as it is. Never throws.
 */
export async function meterHostedSession(ctx: RequestContext, runId: string, read: HostedSessionUsageRead): Promise<void> {
    // Log fields are read off this object, so each value's name is its own.
    const run = { runId } as const;
    if (!read.ok) {
        recordHostedSessionUsage({ outcome: read.reason });
        logger.warn('managed-agents: a hosted session\'s usage could not be read; its time is recorded as unknown', {
            component: 'agentic',
            runId: run.runId,
            reason: read.reason,
        });
        return;
    }
    try {
        const written = await runInTenantContext(ctx, (db) =>
            db.$executeRaw`
                UPDATE "WorkflowRun"
                   SET "hostedSessionSeconds" = COALESCE("hostedSessionSeconds", 0) + ${read.activeSeconds}::double precision,
                       "hostedSessionsUnmetered" = GREATEST("hostedSessionsUnmetered" - 1, 0)
                 WHERE "id" = ${runId} AND "tenantId" = ${ctx.tenantId} AND "hostedManagedAgents" = true`,
        );
        recordHostedSessionUsage({ outcome: written === 1 ? 'METERED' : 'RECORD_FAILED', activeSeconds: written === 1 ? read.activeSeconds : undefined });
    } catch (err) {
        recordHostedSessionUsage({ outcome: 'RECORD_FAILED' });
        logger.error('managed-agents: a hosted session\'s usage could not be recorded', {
            component: 'agentic',
            runId: run.runId,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
    }
}
