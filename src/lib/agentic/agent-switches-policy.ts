/**
 * The server half of the agent switches (#4557): read the deployment's three
 * states, and the organization's row only when they leave the decision open.
 *
 * Split from `agent-switches.ts` so the rule stays free of server imports and
 * the org page can hold it. Everything here touches Prisma or `env`.
 *
 * ═══ ONE READER PER SWITCH ═══
 *
 * Every surface that asks "is the profile surface on here?" or "is the Tool
 * Runner available here?" goes through these two functions: the profile route
 * gate, the profile usecases, the agent page, the run path's driver
 * resolution, the Agent engines page and its checklist. A surface that read the
 * environment by itself would report a switch the organization turned on as
 * off, or the reverse.
 *
 * The organization's row is read by the TENANT's own id or slug, so a request
 * never names the organization whose choice applies to it.
 *
 * ═══ AND THE MANAGED AGENTS SWITCH, WHICH THE WORKSPACE DECIDES (#5964) ═══
 *
 * `managedAgentsDecisionFor` is the one reader of `AGENT_MANAGED_AGENTS` and
 * of `TenantSecuritySettings.managedAgentsEnabled`: the run gate, the
 * integrations surface (listing, saving and testing the `anthropic-workspace`
 * connection), the Agent engines page and the switch's own section all ask it.
 * `tests/guards/managed-agents-switch-single-reader.test.ts` refuses a direct
 * read of the variable anywhere else in `src/`.
 */
import prisma from '@/lib/prisma';
import { env } from '@/env';

import {
    needsOrganization,
    readDeploymentSwitch,
    resolveAgentSwitch,
    resolveWorkspaceAgentSwitch,
    slugIsAllowlisted,
    type AgentSwitchDecision,
    type DeploymentSwitch,
    type WorkspaceAgentSwitchDecision,
} from './agent-switches';

type TenantRef = { readonly tenantId: string } | { readonly tenantSlug: string };

/**
 * The organization's stored choice for one switch, or `null` when the
 * workspace belongs to no organization (or does not exist: a slug that names
 * no workspace has no organization to decide for it).
 */
async function organizationChoice(
    tenant: TenantRef,
    column: 'agentProfilesEnabled' | 'agentToolRunnerEnabled',
): Promise<boolean | null> {
    const where = 'tenantId' in tenant ? { id: tenant.tenantId } : { slug: tenant.tenantSlug };
    const row = await prisma.tenant.findUnique({
        where,
        select: { organization: { select: { agentProfilesEnabled: true, agentToolRunnerEnabled: true } } },
    });
    const org = row?.organization ?? null;
    return org === null ? null : org[column] === true;
}

/**
 * Is the agent profile surface on for this workspace, and why?
 *
 * No slug (a context that carries none) is never allowlisted and names no
 * organization, so the answer fails closed.
 */
export async function agentProfilesDecisionFor(
    tenantSlug: string | null | undefined,
): Promise<AgentSwitchDecision> {
    const deployment = readDeploymentSwitch(env.AGENT_PROFILES);
    const allowlisted = slugIsAllowlisted(env.AGENT_PROFILES_TENANTS, tenantSlug);
    const hasSlug = typeof tenantSlug === 'string' && tenantSlug.trim() !== '';
    const organization =
        needsOrganization(deployment, allowlisted) && hasSlug
            ? await organizationChoice({ tenantSlug: tenantSlug.trim() }, 'agentProfilesEnabled')
            : null;
    return resolveAgentSwitch({ deployment, allowlisted, organization });
}

/** The same question, as a boolean. */
export async function agentProfilesOnFor(tenantSlug: string | null | undefined): Promise<boolean> {
    return (await agentProfilesDecisionFor(tenantSlug)).on;
}

/**
 * Is the Tool Runner engine available to this workspace, and why?
 *
 * "Available" is the operator's half of the engine gate, which an organization
 * may now hold instead. The workspace's owner still chooses the engine on the
 * Agent engines page; this only decides whether that choice can take effect.
 */
export async function toolRunnerDecisionFor(tenant: TenantRef): Promise<AgentSwitchDecision> {
    const deployment = readDeploymentSwitch(env.AGENT_DRIVER_TOOL_RUNNER);
    const organization = needsOrganization(deployment)
        ? await organizationChoice(tenant, 'agentToolRunnerEnabled')
        : null;
    return resolveAgentSwitch({ deployment, organization });
}

/**
 * The operator's override of the Managed Agents switch, as one of the three
 * states (#5964). For a caller that must decide before it knows the tenant
 * (`resolveDriverForTenant`'s short-circuit): `OFF` is off for every workspace,
 * so nothing tenant-specific needs reading.
 */
export function managedAgentsDeployment(): DeploymentSwitch {
    return readDeploymentSwitch(env.AGENT_MANAGED_AGENTS);
}

/**
 * The workspace owner's stored toggle (#5964). A workspace with no settings
 * row, or a slug that names no workspace, has not turned it on.
 */
async function workspaceManagedAgentsChoice(tenant: TenantRef): Promise<boolean> {
    const where = 'tenantId' in tenant ? { tenantId: tenant.tenantId } : { tenant: { slug: tenant.tenantSlug } };
    const row = await prisma.tenantSecuritySettings.findFirst({ where, select: { managedAgentsEnabled: true } });
    return row?.managedAgentsEnabled === true;
}

/**
 * Is the Managed Agents engine on for this workspace, and why (#5964)?
 *
 * The operator's `AGENT_MANAGED_AGENTS` decides when it is set (`1`/`true` on
 * for every workspace, any other value off for every workspace); unset, the
 * workspace owner's toggle on Admin → AI features decides. Read on every call,
 * so a toggle takes effect on the next request, with no restart.
 *
 * Off means: no new Managed Agents run starts, a queued or paused one does not
 * continue, and the `anthropic-workspace` card, save and Test are refused for
 * the workspace. The connection, the engine choice and what Inflect created at
 * Anthropic are kept, and the clean-ups never ask this.
 */
export async function managedAgentsDecisionFor(tenant: TenantRef): Promise<WorkspaceAgentSwitchDecision> {
    const deployment = managedAgentsDeployment();
    const workspace = deployment === 'UNSET' ? await workspaceManagedAgentsChoice(tenant) : false;
    return resolveWorkspaceAgentSwitch({ deployment, workspace });
}

/** The same question, as a boolean. */
export async function managedAgentsOnFor(tenant: TenantRef): Promise<boolean> {
    return (await managedAgentsDecisionFor(tenant)).on;
}
