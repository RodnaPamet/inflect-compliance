/**
 * WHO MAY CHANGE AN AUDIT PROCEDURE'S PLAN (#3676, owner decisions 3 and 6).
 *
 * A control-test plan whose `automationConfig` names an audit procedure is how
 * the auditor agent is operated: which procedure, against which control, with
 * which parameters, on which cron. The second line owns and operates the
 * auditor, so the second line — in the person of the auditor agent's owner —
 * is the only party that may set that plan up, change it, or switch it off.
 *
 * "Switch it off" is the half this module exists for. The audited first line
 * holds `tests.create` on most workspaces and `admin.manage` on many; without
 * this gate it could pause, archive or delete the plan that audits it, and the
 * audit would stop with nothing more than an ordinary plan-status audit row to
 * say so. So every path that can stop a procedure plan running refuses, with
 * the one named reason below, unless the caller is a PERSON who owns the
 * auditor agent the plan names:
 *
 *   - `scheduleTestPlan`        set, change or remove a procedure config, or the cron
 *   - `updateTestPlan`          a status other than ACTIVE, or a new automation type
 *   - `bulkSetTestPlanStatus`   PAUSED or ARCHIVED
 *   - `bulkDeleteTestPlan`      the soft delete
 *
 * A plan that carries no procedure is not touched by any of it: the gate
 * returns before reading anything, so those paths behave exactly as they did.
 *
 * A person, not a credential: an API key carries its creator's `userId`, and an
 * agent or a job carries a principal's. Each is refused even when that user is
 * the auditor's owner, because the owner's decision is the thing being asked
 * for and none of those can make it.
 *
 * An auditor no longer in the register has no owner to defer to, so it holds
 * nothing back; its plan already runs INCONCLUSIVE `AUDITOR_NOT_FOUND` on every
 * tick, and leaving it unremovable would help nobody.
 *
 * @module usecases/audit-procedure-plans
 */
import type { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';

/** The named reason every refusal in this module carries. */
export const AUDIT_PROCEDURE_PLAN_OWNER_ONLY = 'AUDIT_PROCEDURE_PLAN_OWNER_ONLY' as const;

/** What the caller was trying to do, for the refusal's message and details. */
export type AuditProcedurePlanChange = 'SCHEDULE' | 'PAUSE' | 'ARCHIVE' | 'AUTOMATION_CHANGE' | 'DELETE';

/**
 * The auditor agent a stored config names, or `null` when the config carries no
 * procedure. Read from the raw blob rather than through
 * `parseAuditProcedureConfig`, so a malformed procedure config — which no
 * write path accepts, but which a hand-written row could hold — still names its
 * auditor here and is still protected.
 */
export function procedureCarrier(config: unknown): { auditorAgentId: string | null } | null {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
    const cfg = config as Record<string, unknown>;
    if (!('procedure' in cfg)) return null;
    return { auditorAgentId: typeof cfg.auditorAgentId === 'string' ? cfg.auditorAgentId : null };
}

/**
 * Refuse unless the caller is a person who owns every auditor agent these
 * plans' configs name. A no-op when no config carries a procedure.
 */
export async function assertAuditorOwnerMayChangeProcedurePlans(
    db: PrismaTx,
    ctx: RequestContext,
    configs: readonly unknown[],
    change: AuditProcedurePlanChange,
): Promise<void> {
    const carriers = configs.map(procedureCarrier).filter((c): c is NonNullable<typeof c> => c !== null);
    if (carriers.length === 0) return;

    if (ctx.apiKeyId !== undefined || ctx.agentId !== undefined || ctx.actorType === 'JOB') {
        throw refusal(change, 'An audit procedure plan is changed by a person: the owner of the auditor agent it names.');
    }

    const ids = [...new Set(carriers.map((c) => c.auditorAgentId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return;
    const agents = await db.registeredAgent.findMany({
        where: { tenantId: ctx.tenantId, id: { in: ids }, deletedAt: null },
        select: { id: true, ownerUserId: true },
        take: ids.length,
    });
    if (agents.some((a) => a.ownerUserId !== ctx.userId)) {
        throw refusal(
            change,
            "An audit procedure's plan is operated by the second line: only the owner of the auditor agent it " +
                'names may set it up, change it, pause it or delete it.',
        );
    }
}

function refusal(change: AuditProcedurePlanChange, message: string) {
    return forbidden(message, { reason: AUDIT_PROCEDURE_PLAN_OWNER_ONLY, change });
}
