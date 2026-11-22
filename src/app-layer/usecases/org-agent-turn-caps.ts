/**
 * The organization's two per-turn caps (#4594, owner decision 3 of
 * 2026-11-13): the CEILING of delegations and of tool calls one agent turn may
 * start, for every workspace under the organization.
 *
 * ═══ THE ONLY WRITER OF THE TWO COLUMNS ═══
 *
 * `Organization.agentMaxSubagentsPerTurn` and `agentMaxToolCallsPerTurn` are
 * written here and nowhere else, and read only through
 * `src/lib/agentic/turn-caps-policy.ts`. A workspace narrows with its own
 * columns on `PUT admin/security-settings`; the value that applies is the
 * lower of the two (`resolveTurnCaps`).
 *
 * A ceiling has no deployment override, unlike the agent switches beside it:
 * the operator's bound is `ENGINE_CAPS`, which no organization reaches. So the
 * read reports the organization's values alone.
 *
 * ═══ LOWERING A CEILING REWRITES NO WORKSPACE ═══
 *
 * A workspace's stored value above a lowered ceiling is kept; the ceiling
 * applies from the next segment any run reads, and the workspace's own value
 * applies again if the ceiling is raised. The read counts the workspaces the
 * ceiling reaches, so the page can name them before a ceiling is lowered.
 *
 * ═══ WRITE, THEN AUDIT, BOTH VALUES ═══
 *
 * `ORG_AGENT_TURN_CAPS_CHANGED` carries the before and after of each cap that
 * moved, and only those. A PUT that moves nothing writes no row. The audit
 * append runs after the update commits, in the org writer's own transaction; a
 * failure there is logged at ERROR and does not undo the change, as the
 * switches' writer behaves.
 *
 * Org-scoped (global prisma, keyed on `organizationId` from the context), so
 * no tenant RLS applies.
 */
import prisma from '@/lib/prisma';
import type { OrgContext } from '../types';
import { badRequest, forbidden } from '@/lib/errors/types';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { logger } from '@/lib/observability/logger';
import {
    TURN_CAP_KEYS,
    TURN_CAP_MAX,
    TURN_CAP_MIN,
    isPermittedTurnCap,
    type TurnCapKey,
} from '@/lib/agentic/turn-caps';

/** The row column for each cap. */
const COLUMN: Readonly<Record<TurnCapKey, 'agentMaxSubagentsPerTurn' | 'agentMaxToolCallsPerTurn'>> = {
    delegationsPerTurn: 'agentMaxSubagentsPerTurn',
    toolCallsPerTurn: 'agentMaxToolCallsPerTurn',
};

const SELECT = { agentMaxSubagentsPerTurn: true, agentMaxToolCallsPerTurn: true } as const;

type Row = { agentMaxSubagentsPerTurn: number; agentMaxToolCallsPerTurn: number };

export interface OrgAgentTurnCaps {
    /** The ceiling of `delegate` / `task` calls one turn may start. */
    readonly delegationsPerTurn: number;
    /** The ceiling of tool calls one Tool Runner turn may make. */
    readonly toolCallsPerTurn: number;
    /** Whether the caller may change them. */
    readonly canManage: boolean;
    /** How many live workspaces the organization has: the reach of a ceiling. */
    readonly workspaceCount: number;
}

export type OrgAgentTurnCapsPatch = Partial<Record<TurnCapKey, number>>;

async function readRow(organizationId: string): Promise<Row> {
    return prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: SELECT });
}

/** The organization's live workspaces: a soft-deleted one is reached by no ceiling. */
async function countWorkspaces(organizationId: string): Promise<number> {
    return prisma.tenant.count({ where: { organizationId, deletedAt: null } });
}

function present(row: Row, canManage: boolean, workspaceCount: number): OrgAgentTurnCaps {
    return {
        delegationsPerTurn: row.agentMaxSubagentsPerTurn,
        toolCallsPerTurn: row.agentMaxToolCallsPerTurn,
        canManage,
        workspaceCount,
    };
}

/** Read the ceilings. Any org member who can see the portfolio may read them. */
export async function getOrgAgentTurnCaps(ctx: OrgContext): Promise<OrgAgentTurnCaps> {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden('You do not have access to this organization.');
    }
    const [row, workspaceCount] = await Promise.all([
        readRow(ctx.organizationId),
        countWorkspaces(ctx.organizationId),
    ]);
    return present(row, ctx.permissions.canManageAgentSwitches, workspaceCount);
}

/**
 * Set one or both ceilings. `canManageAgentSwitches` (ORG_ADMIN), the
 * switches' permission, is checked by the route's `requireOrgPermission`,
 * which audits a refusal, and again here, so no other caller skips it. The
 * ranges are checked here as well as in the route's schema, because a usecase
 * is reachable from callers that are not that route; the CHECKs are the last
 * word.
 */
export async function setOrgAgentTurnCaps(
    ctx: OrgContext,
    patch: OrgAgentTurnCapsPatch,
): Promise<OrgAgentTurnCaps> {
    if (!ctx.permissions.canManageAgentSwitches) {
        throw forbidden('Only an organization admin can change the per-turn limits.');
    }
    for (const key of TURN_CAP_KEYS) {
        const next = patch[key];
        if (next !== undefined && !isPermittedTurnCap(key, next)) {
            throw badRequest(`${key} must be a whole number from ${TURN_CAP_MIN[key]} to ${TURN_CAP_MAX}.`);
        }
    }

    const before = await readRow(ctx.organizationId);
    // Cap names and numbers only: `moved.changes` is what the audit row carries.
    const moved: {
        data: { agentMaxSubagentsPerTurn?: number; agentMaxToolCallsPerTurn?: number };
        changes: Partial<Record<TurnCapKey, { before: number; after: number }>>;
    } = { data: {}, changes: {} };
    for (const key of TURN_CAP_KEYS) {
        const next = patch[key];
        if (next === undefined || next === before[COLUMN[key]]) continue;
        moved.data[COLUMN[key]] = next;
        moved.changes[key] = { before: before[COLUMN[key]], after: next };
    }

    if (Object.keys(moved.changes).length === 0) {
        return present(before, true, await countWorkspaces(ctx.organizationId));
    }

    const after = await prisma.organization.update({
        where: { id: ctx.organizationId },
        data: moved.data,
        select: SELECT,
    });

    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: 'ORG_AGENT_TURN_CAPS_CHANGED',
            targetUserId: null,
            detailsJson: { changes: moved.changes },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.error('org-agent-turn-caps.audit_emit_failed', {
            component: 'org-agent-turn-caps',
            organizationId: ctx.organizationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return present(after, true, await countWorkspaces(ctx.organizationId));
}
