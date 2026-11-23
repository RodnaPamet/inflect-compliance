/**
 * PROVISION AN APPROVED PROFILE VERSION as a Managed Agent in the tenant's own
 * Anthropic workspace (Step 5b of `docs/claude-managed-agents-design.md`,
 * shape MA-C2, #4165).
 *
 * Called by `approveAgentProfileVersion` once its transaction has committed.
 * It provisions ONLY for a tenant whose engine is in force as Managed Agents,
 * asked through `resolveDriverForTenant`, the same resolver a run asks: a
 * workspace that chose MANAGED_AGENTS (Step 5d), with `AGENT_MANAGED_AGENTS`
 * on and `DRIVER_IMPLEMENTED['managed-agents']` true. Every other tenant gets
 * `ENGINE_NOT_IN_FORCE`, and nothing is created or written.
 *
 * After a connection is removed and re-enabled, the profile's recorded agent
 * is ARCHIVED (Step 5c's clean-up), and `readProfileAgent` skips it, so the
 * next approved version gets a NEW agent rather than an update to one Anthropic
 * would refuse (Step 5d). The version in force when the connection was removed
 * keeps its archived row, and a run of it is refused
 * `managed_agents_agent_archived`. An agent edited or archived in the Console
 * is replaced the same way at the next approval (#5854), and the audit row
 * names the agent it replaced.
 *
 * It NEVER THROWS into the approval: the version is approved whatever happens
 * here, and a run of a version that was not provisioned is refused by name
 * (`managed_agents_not_provisioned`) rather than run on something else.
 *
 * What it writes is decided by `provisionManagedAgent` and `agentBodyFor`: an
 * agent whose `system` is Inflect's preamble and whose tools are the version's
 * tools from Inflect's own catalogue, plus `activate_skill` when the version
 * mounts skills. The version's instructions are not read here at all.
 */
import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import { resolveDriverForTenant } from '@/lib/agentic/agent-driver-policy';
import { PROFILE_MODEL_TIERS, type ProfileModelTier } from '@/lib/agentic/agent-profile';
import { RESIDENCY_SELECT, residencyTermsFrom } from '@/lib/agentic/flue/model-selection';
import { agentToolsFor, managedAgentsModelFor, type ProvisionShapeRefusal } from '@/lib/agentic/managed-agents/definition';
import { provisionManagedAgent } from '@/lib/agentic/managed-agents/provision';
import { readWorkspaceConnection, type WorkspaceConnectionRefusal } from '@/lib/agentic/managed-agents/store';
import { managedAgentsClientFor, type ManagedAgentsClientRefusal } from '@/lib/agentic/tool-runner/client';
import { runInTenantContext } from '@/lib/db-context';
import { READ_TOOLS } from '@/lib/mcp/tools/registry';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { logger } from '@/lib/observability/logger';

export type ProvisionApprovedOutcome =
    | { readonly provisioned: true; readonly created: boolean }
    | {
          readonly provisioned: false;
          readonly reason:
              | 'ENGINE_NOT_IN_FORCE'
              | 'LOCAL_ONLY'
              | 'VERSION_NOT_APPROVED'
              | WorkspaceConnectionRefusal
              | ProvisionShapeRefusal
              | ManagedAgentsClientRefusal
              | 'PROVIDER_ERROR';
      };

/** Inflect's own tool catalogue, by the fields provisioning reads. */
function catalogue(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return [
        ...READ_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ...PROPOSE_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ];
}

export async function provisionApprovedProfileVersion(
    ctx: RequestContext,
    versionId: string,
): Promise<ProvisionApprovedOutcome> {
    const version = { versionId } as const;
    try {
        const decision = await resolveDriverForTenant(ctx.tenantId);
        if (decision.driver !== 'managed-agents') return { provisioned: false, reason: 'ENGINE_NOT_IN_FORCE' };

        const { settings, version } = await runInTenantContext(ctx, async (db) => ({
            settings: await db.tenantSecuritySettings.findUnique({ where: { tenantId: ctx.tenantId }, select: RESIDENCY_SELECT }),
            version: await db.agentProfileVersion.findFirst({
                where: { id: versionId, tenantId: ctx.tenantId },
                select: { id: true, profileId: true, status: true, toolNames: true, skillRefs: true, modelTier: true },
            }),
        }));
        // Before the customer's key is read, as the run's own driver does.
        if (residencyTermsFrom(settings).residency === 'LOCAL_ONLY') return { provisioned: false, reason: 'LOCAL_ONLY' };
        if (!version || version.status !== 'APPROVED') return { provisioned: false, reason: 'VERSION_NOT_APPROVED' };

        const tier: ProfileModelTier = (PROFILE_MODEL_TIERS as readonly string[]).includes(version.modelTier)
            ? (version.modelTier as ProfileModelTier)
            : 'balanced';
        const shaped = agentToolsFor({
            toolNames: version.toolNames,
            catalogue: catalogue(),
            mountsSkills: Array.isArray(version.skillRefs) && version.skillRefs.length > 0,
        });
        if (!shaped.ok) return { provisioned: false, reason: shaped.reason };

        const read = await readWorkspaceConnection(ctx);
        if (!read.ok) return { provisioned: false, reason: read.reason };
        const choice = managedAgentsClientFor({ apiKey: read.connection.apiKey, workspaceId: read.connection.workspaceId });
        if (!choice.ok) return { provisioned: false, reason: choice.reason };

        const { record, created, replaced } = await provisionManagedAgent(ctx, choice.client, {
            profileId: version.profileId,
            profileVersionId: version.id,
            connectionId: read.connection.connectionId,
            model: managedAgentsModelFor(tier),
            tools: shaped.tools,
        });
        if (created) {
            await runInTenantContext(ctx, (db) =>
                logEvent(db, ctx, {
                    action: 'AGENT_PROFILE_PROVISIONED',
                    entityType: 'AgentProfileVersion',
                    entityId: version.id,
                    details: 'Provisioned the approved profile version as a Managed Agent in the connected Anthropic workspace',
                    detailsJson: {
                        category: 'access',
                        entityName: 'AgentProfileVersion',
                        operation: 'created',
                        after: {
                            connectionId: record.connectionId,
                            anthropicAgentId: record.anthropicAgentId,
                            anthropicAgentVersion: record.anthropicAgentVersion,
                            environmentId: record.environmentId,
                            systemHash: record.systemHash,
                            toolsHash: record.toolsHash,
                            environmentHash: record.environmentHash,
                            // The profile's earlier agent, edited or archived in
                            // the Console, that this new agent replaces (#5854).
                            // It stays recorded on the earlier versions' rows.
                            replacedAnthropicAgentId: replaced?.anthropicAgentId ?? null,
                            replacedBecause: replaced?.drift ?? null,
                        },
                    },
                }),
            );
        }
        return { provisioned: true, created };
    } catch (err) {
        logger.error('managed-agents: provisioning an approved profile version failed', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            versionId: version.versionId,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
        return { provisioned: false, reason: 'PROVIDER_ERROR' };
    }
}
