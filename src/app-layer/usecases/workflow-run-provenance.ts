/**
 * WHO STARTED A RUN, AND WHICH RULE CAUSED IT — for the run's own page (#4894).
 *
 * The run row carries ids only: `startedByUserId` (the person, or for an
 * automation-started run the rule's OWNER, whose permissions it ran under) and
 * `parentExecutionId` (the automation execution that caused it). The page used
 * to print the execution id and say "the name above is the rule owner" while
 * showing no name at all. This resolves both to what a reader can recognise.
 *
 * Read-only, and bounded to one membership and one execution. The caller has
 * already passed the run page's own gate; nothing here widens what it may see:
 * the starter's name is shown only when they are a member of THIS workspace,
 * and the rule only when the execution is this workspace's.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';

export interface WorkflowRunProvenance {
    /** The starter's display name, or null when they are not a member here. */
    startedBy: string | null;
    /** The automation rule's name, or null when no rule caused the run. */
    ruleName: string | null;
}

export async function readWorkflowRunProvenance(
    ctx: RequestContext,
    run: { startedByUserId: string | null; parentExecutionId: string | null },
): Promise<WorkflowRunProvenance> {
    return runInTenantContext(ctx, async (db) => {
        const [membership, execution] = await Promise.all([
            run.startedByUserId
                ? db.tenantMembership.findFirst({
                      where: { tenantId: ctx.tenantId, userId: run.startedByUserId },
                      select: { user: { select: { name: true, email: true } } },
                  })
                : null,
            run.parentExecutionId
                ? db.automationExecution.findFirst({
                      where: { id: run.parentExecutionId, tenantId: ctx.tenantId },
                      select: { rule: { select: { name: true } } },
                  })
                : null,
        ]);
        return {
            startedBy: membership?.user ? membership.user.name || membership.user.email : null,
            ruleName: execution?.rule?.name ?? null,
        };
    });
}
