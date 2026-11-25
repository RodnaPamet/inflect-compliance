/**
 * THE MANAGED AGENTS SWITCH, THE WORKSPACE'S HALF (#5964, owner decisions
 * 2026-11-25), and the one writer of `TenantSecuritySettings.managedAgentsEnabled`.
 *
 * An OWNER turns the Managed Agents engine on or off for this workspace on
 * Admin → AI features. The route's PUT carries a literal
 * `requirePermission('admin.tenant_lifecycle')`, and this usecase asks the same
 * key again and asks that the caller is a PERSON in their own session: an API
 * key, an agent and a job are refused, whatever they hold. Every change is
 * audited (`MANAGED_AGENTS_SWITCH_CHANGED`, category `access`) with the
 * operator's override and the effective answer before and after, so the trail
 * can tell a toggle that took effect from one the deployment overrode.
 *
 * The write is accepted in every deployment state, as an organization's agent
 * switches are: with `AGENT_MANAGED_AGENTS` set the operator decides and the
 * toggle is not read, and the section says so; the stored choice takes effect
 * the moment the operator unsets the variable. It takes effect at once
 * otherwise: `managedAgentsDecisionFor` reads it on every call.
 *
 * OFF STOPS RUNS AND KEEPS THE SET-UP. Turning it off writes this one column
 * and nothing else: the `anthropic-workspace` connection, the engine choice and
 * what Inflect created in the customer's Anthropic workspace stay, so turning
 * it back on resumes. (Removing the connection is what cleans up, and it stays
 * available whatever the switch says.)
 */
import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import type { DeploymentSwitch, WorkspaceAgentSwitchBasis } from '@/lib/agentic/agent-switches';
import { managedAgentsDecisionFor, managedAgentsDeployment } from '@/lib/agentic/agent-switches-policy';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/** What the section shows. */
export interface ManagedAgentsSwitchSetting {
    /** The workspace owner's stored toggle. Read only while `deployment` is `UNSET`. */
    readonly enabled: boolean;
    /** The operator's `AGENT_MANAGED_AGENTS`, as one of the three states. */
    readonly deployment: DeploymentSwitch;
    /** Whether the engine is on for this workspace now, and who decided. */
    readonly effective: { readonly on: boolean; readonly basis: WorkspaceAgentSwitchBasis };
}

/** OWNER-tier, and a person in their own session. */
function assertOwnerPerson(ctx: RequestContext): void {
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden('Only an owner can turn the Managed Agents engine on or off for this workspace.', {
            reason: 'MANAGED_AGENTS_SWITCH_IS_OWNER_TIER',
        });
    }
    // A key, an agent or a job never decides this, whatever it holds. A
    // context with no actor type is a signed-in person's (`logEvent` reads it
    // as USER).
    if (ctx.apiKeyId || ctx.agentId || (ctx.actorType !== undefined && ctx.actorType !== 'USER')) {
        throw forbidden(
            'Whether the Managed Agents engine is on for this workspace is decided by a person in their own '
                + 'session, never by an API key, an agent or a scheduled job.',
            { reason: 'MANAGED_AGENTS_SWITCH_NOT_A_PERSON' },
        );
    }
}

async function readSetting(ctx: RequestContext): Promise<ManagedAgentsSwitchSetting> {
    const row = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({ where: { tenantId: ctx.tenantId }, select: { managedAgentsEnabled: true } }),
    );
    const decision = await managedAgentsDecisionFor({ tenantId: ctx.tenantId });
    return {
        enabled: row?.managedAgentsEnabled === true,
        deployment: managedAgentsDeployment(),
        effective: { on: decision.on, basis: decision.basis },
    };
}

/**
 * The setting, for the section. The route reads it under `admin.view`, so every
 * admin sees whether the engine is on and who decided; only an owner can change it.
 */
export async function getManagedAgentsSwitch(ctx: RequestContext): Promise<ManagedAgentsSwitchSetting> {
    return readSetting(ctx);
}

/** Turn the Managed Agents engine on or off for this workspace. */
export async function setManagedAgentsSwitch(ctx: RequestContext, enabled: boolean): Promise<ManagedAgentsSwitchSetting> {
    assertOwnerPerson(ctx);
    const before = await readSetting(ctx);
    if (before.enabled === enabled) return before;

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            // UPSERT: a workspace nobody has configured has no settings row.
            create: { tenantId: ctx.tenantId, managedAgentsEnabled: enabled },
            update: { managedAgentsEnabled: enabled },
        }),
    );
    const after = await readSetting(ctx);

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'MANAGED_AGENTS_SWITCH_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: enabled
                ? 'Turned the Managed Agents engine on for this workspace'
                : 'Turned the Managed Agents engine off for this workspace',
            // `access`, as the engine choice is: this decides whether runs may
            // use the customer's Anthropic workspace at all.
            detailsJson: {
                category: 'access',
                operation: enabled ? 'grant' : 'revoke',
                summary: enabled ? 'Managed Agents engine: turned on' : 'Managed Agents engine: turned off',
            },
            // The operator's override at the moment of the decision, and the
            // effective answer either side of it: a toggle the deployment
            // overrides changes the stored choice and nothing that runs.
            metadata: {
                from: before.enabled,
                to: enabled,
                deployment: before.deployment,
                effectiveBefore: before.effective.on,
                effectiveBasisBefore: before.effective.basis,
                effectiveAfter: after.effective.on,
                effectiveBasisAfter: after.effective.basis,
            },
        }),
    );

    logger.info('managed agents switch changed', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        enabled,
        deployment: before.deployment,
    });

    return after;
}
