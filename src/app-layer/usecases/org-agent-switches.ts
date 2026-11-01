/**
 * The organization's two agent switches (#4557): the agent profile surface and
 * the Tool Runner engine, for every workspace under the organization.
 *
 * ═══ THE ORGANIZATION DECIDES ONLY WHAT THE DEPLOYMENT LEAVES OPEN ═══
 *
 * The rule is `resolveAgentSwitch` in `src/lib/agentic/agent-switches.ts`.
 * The deployment's `1` turns a switch on everywhere and any other set value
 * turns it off everywhere. Only when the variable is unset does this row
 * decide. The read below reports the deployment's state beside the
 * organization's choice, so the page can say "your choice is overridden"
 * instead of showing a control that changes nothing.
 *
 * The write is allowed in every deployment state. A choice made while the
 * deployment overrides it is stored, and it takes effect the moment the
 * operator unsets the variable. The page says so, rather than refusing the
 * write and leaving the admin with no way to prepare.
 *
 * ═══ WRITE, THEN AUDIT, BOTH VALUES ═══
 *
 * `ORG_AGENT_SWITCHES_CHANGED` carries the before and after values of each
 * switch that moved, and only those. A PUT that moves nothing writes no row.
 * The audit append runs in its own transaction, as every org audit write does
 * (`appendOrgAuditEntry` takes the org's advisory lock), after the update
 * commits. A failure there is logged at ERROR and does not undo the switch,
 * which is how the member-role and threat-level writers behave.
 *
 * Org-scoped (global prisma, keyed on `organizationId` from the context), so
 * no tenant RLS applies.
 */
import prisma from '@/lib/prisma';
import { env } from '@/env';
import type { OrgContext } from '../types';
import { forbidden } from '@/lib/errors/types';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { logger } from '@/lib/observability/logger';
import {
    AGENT_SWITCHES,
    readDeploymentSwitch,
    type AgentSwitch,
    type DeploymentSwitch,
} from '@/lib/agentic/agent-switches';

/** The row column for each switch. */
const COLUMN: Readonly<Record<AgentSwitch, 'agentProfilesEnabled' | 'agentToolRunnerEnabled'>> = {
    agentProfiles: 'agentProfilesEnabled',
    toolRunner: 'agentToolRunnerEnabled',
};

export interface OrgAgentSwitchState {
    /** What the organization chose. */
    readonly organization: boolean;
    /** What the deployment says: `UNSET` is the only state in which the choice applies. */
    readonly deployment: DeploymentSwitch;
}

export interface OrgAgentSwitches {
    readonly agentProfiles: OrgAgentSwitchState;
    readonly toolRunner: OrgAgentSwitchState;
    /** Whether the caller may change them. */
    readonly canManage: boolean;
    /**
     * How many live workspaces the organization has: the reach of a switch,
     * which the page names before a switch is turned off (#4850).
     */
    readonly workspaceCount: number;
}

export type OrgAgentSwitchesPatch = Partial<Record<AgentSwitch, boolean>>;

function deploymentStates(): Record<AgentSwitch, DeploymentSwitch> {
    return {
        agentProfiles: readDeploymentSwitch(env.AGENT_PROFILES),
        toolRunner: readDeploymentSwitch(env.AGENT_DRIVER_TOOL_RUNNER),
    };
}

async function readRow(organizationId: string) {
    return prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { agentProfilesEnabled: true, agentToolRunnerEnabled: true },
    });
}

/** The organization's live workspaces: a soft-deleted one is reached by no switch. */
async function countWorkspaces(organizationId: string): Promise<number> {
    return prisma.tenant.count({ where: { organizationId, deletedAt: null } });
}

function present(
    row: { agentProfilesEnabled: boolean; agentToolRunnerEnabled: boolean },
    canManage: boolean,
    workspaceCount: number,
): OrgAgentSwitches {
    const deployment = deploymentStates();
    return {
        agentProfiles: { organization: row.agentProfilesEnabled, deployment: deployment.agentProfiles },
        toolRunner: { organization: row.agentToolRunnerEnabled, deployment: deployment.toolRunner },
        canManage,
        workspaceCount,
    };
}

/** Read the switches. Any org member who can see the portfolio may read them. */
export async function getOrgAgentSwitches(ctx: OrgContext): Promise<OrgAgentSwitches> {
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
 * Set one or both switches. `canManageAgentSwitches` (ORG_ADMIN) is checked by
 * the route's `requireOrgPermission`, which audits a refusal, and again here,
 * so no other caller of this usecase skips it.
 */
export async function setOrgAgentSwitches(
    ctx: OrgContext,
    patch: OrgAgentSwitchesPatch,
): Promise<OrgAgentSwitches> {
    if (!ctx.permissions.canManageAgentSwitches) {
        throw forbidden('Only an organization admin can change the agent switches.');
    }

    const before = await readRow(ctx.organizationId);
    // Field names only, never content: `moved.changes` is what the audit row
    // carries, read through a member so the logging rule can see its shape.
    const moved: {
        data: { agentProfilesEnabled?: boolean; agentToolRunnerEnabled?: boolean };
        changes: Partial<Record<AgentSwitch, { before: boolean; after: boolean }>>;
    } = { data: {}, changes: {} };
    for (const key of AGENT_SWITCHES) {
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
        select: { agentProfilesEnabled: true, agentToolRunnerEnabled: true },
    });

    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: 'ORG_AGENT_SWITCHES_CHANGED',
            targetUserId: null,
            // The deployment's state at the moment of the change, beside each
            // switch: a choice made while the deployment overrides it changes
            // no workspace until the operator unsets the variable, and the
            // trail must be able to tell the two apart.
            detailsJson: { changes: moved.changes, deployment: deploymentStates() },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.error('org-agent-switches.audit_emit_failed', {
            component: 'org-agent-switches',
            organizationId: ctx.organizationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return present(after, true, await countWorkspaces(ctx.organizationId));
}
