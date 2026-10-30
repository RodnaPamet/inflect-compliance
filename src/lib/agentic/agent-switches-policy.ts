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
 */
import prisma from '@/lib/prisma';
import { env } from '@/env';

import {
    needsOrganization,
    readDeploymentSwitch,
    resolveAgentSwitch,
    slugIsAllowlisted,
    type AgentSwitchDecision,
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
