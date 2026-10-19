/**
 * THE AUDITOR READS AND PROPOSES, NEVER CHANGES (#3676, step 3c).
 *
 * An auditor agent may hold only Inflect's own read tools and `propose_finding`
 * (`AUDITOR_TOOL_REMIT` in `src/lib/agentic/audit-procedure-library.ts`). It is
 * held at the three moments an auditor's authority is granted, by named
 * refusal (`details.reason: 'AUDITOR_REMIT_EXCEEDED'`, the offending tools in
 * `details.toolsOutsideRemit`):
 *
 *   • a tool is GRANTED to an auditor (`grantAgentTool`);
 *   • an agent BECOMES an auditor while holding a tool outside the remit (an
 *     amend that sets `isAuditor`);
 *   • an auditor goes ACTIVE (`assertActivatable`, the status writer), which
 *     catches a grant any writer slipped in around the first two.
 *
 * And a fourth time when it acts: the procedure handler refuses to run an
 * auditor whose grants exceed the remit (`AUDITOR_REMIT_EXCEEDED`, no
 * workpaper). Unmarking an auditor and revoking a grant only take authority
 * away, so neither is ever refused.
 */
import { ConflictError } from '@/lib/errors/types';
import type { PrismaTx } from '@/lib/db-context';
import { AUDITOR_TOOL_REMIT, toolsOutsideAuditorRemit } from '@/lib/agentic/audit-procedure-library';

import type { RequestContext } from '../types';

export const AUDITOR_REMIT_EXCEEDED = 'AUDITOR_REMIT_EXCEEDED' as const;

function refuse(tools: readonly string[], when: string): never {
    throw new ConflictError(
        `An auditor agent reads and proposes findings, and changes nothing: it may hold only ` +
            `Inflect's read tools and propose_finding. ${when} (${tools.join(', ')}).`,
        { reason: AUDITOR_REMIT_EXCEEDED, toolsOutsideRemit: [...tools] },
    );
}

/** Refuse granting `toolName` to an auditor when it is outside the remit. */
export function assertGrantWithinAuditorRemit(agent: { isAuditor: boolean }, toolName: string): void {
    if (!agent.isAuditor || AUDITOR_TOOL_REMIT.has(toolName)) return;
    refuse([toolName], 'This tool is not one of them, so it is not granted');
}

/** Refuse when the agent already holds a tool outside the remit (becoming an auditor, or going ACTIVE as one). */
export async function assertHoldsOnlyAuditorRemitInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    when: 'mark' | 'activate',
): Promise<void> {
    const grants = await db.registeredAgentTool.findMany({
        where: { tenantId: ctx.tenantId, agentId },
        select: { toolName: true },
        take: 500,
    });
    const outside = toolsOutsideAuditorRemit(grants.map((g) => g.toolName));
    if (outside.length === 0) return;
    refuse(
        outside,
        when === 'mark'
            ? 'This agent holds tools outside that remit; revoke them before marking it an auditor'
            : 'This auditor holds tools outside that remit; revoke them before activating it',
    );
}
