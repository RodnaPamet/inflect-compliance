/**
 * THE MANAGED AGENTS RUN DRIVER (Step 5b of
 * `docs/claude-managed-agents-design.md`, shape MA-C2, #4165).
 *
 * Plans a run or refuses it before anything is sent, then hands it to
 * `execute.ts`. Every refusal is settled on the run row with a named reason
 * and never degrades to another engine (global rule 4).
 *
 * SELECTED BY THE GATE, NEVER BY THIS MODULE. Mapped in `drivers/index.ts`;
 * `resolveAgentDriver` permits this key only for a workspace that chose
 * `MANAGED_AGENTS` (which the setting allows only with a connected Anthropic
 * workspace, Step 5d), with `AGENT_MANAGED_AGENTS` on and
 * `DRIVER_IMPLEMENTED['managed-agents']` true, and `selectRunDriver` chooses it
 * only for a definition that asks for it: a profile of such a workspace.
 *
 * The order of the checks is the residency rule's: a LOCAL_ONLY tenant is
 * refused BEFORE the customer's connection, and so their key, is read. Then
 * the definition (a profile, asking for this engine), the ONE enabled
 * `anthropic-workspace` connection, the provision for the version in that
 * workspace, and the client, built per run from the connection's decrypted key
 * by the engine's one constructor (`managedAgentsClientFor`).
 */
import type { RequestContext } from '@/app-layer/types';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import {
    EXTERNAL_AI_ACK_SELECT,
    acknowledgementFrom,
    type ExternalAiAcknowledgement,
} from '@/lib/agentic/external-residency-gate';
import { RESIDENCY_SELECT, residencyTermsFrom, type FlueModelSelection } from '@/lib/agentic/flue/model-selection';
import { managedAgentsClientFor, type ManagedAgentsClientRefusal } from '@/lib/agentic/tool-runner/client';
import { ENGINE_CAPS, type WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

import { MANAGED_AGENTS_PREFIX, managedAgentsModelFor } from './definition';
import { executeManagedAgentsRun } from './execute';
import { readProvision, readWorkspaceConnection, type WorkspaceConnectionRefusal } from './store';

/** The route a Managed Agents run's model calls take, as the transfer gate reads it. Outside the deployment. */
export const MANAGED_AGENTS_PROVIDER_ID = 'anthropic-managed-agents';

/** Why a run may not start on this engine. Each is an operator-actionable gap. */
export type ManagedAgentsStartRefusal =
    | 'MANAGED_AGENTS_LOCAL_ONLY_UNSERVED'
    | 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER'
    | 'NOT_A_PROFILE'
    | 'NO_STEPS_REMAIN'
    | WorkspaceConnectionRefusal
    | 'NOT_PROVISIONED'
    | 'AGENT_ARCHIVED'
    | ManagedAgentsClientRefusal;

/** The sentence a refused run is settled with. Never the key, never a workspace's content. */
export function refusalMessage(reason: ManagedAgentsStartRefusal): string {
    const p = MANAGED_AGENTS_PREFIX;
    switch (reason) {
        case 'MANAGED_AGENTS_LOCAL_ONLY_UNSERVED':
            return (
                `${p}_local_only_unserved: this workspace is LOCAL_ONLY, and the Managed Agents engine runs in an `
                + 'Anthropic workspace, whose data is stored in the US. Nothing was sent. Run it on the Flue engine.'
            );
        case 'DEFINITION_ASKED_FOR_ANOTHER_DRIVER':
            return `${p}_not_requested: this workflow does not ask for the Managed Agents engine.`;
        case 'NOT_A_PROFILE':
            return `${p}_not_a_profile: the Managed Agents engine runs an approved agent profile, and this run has none.`;
        case 'NO_STEPS_REMAIN':
            return `${p}_no_steps_remain: the run resumed with its entire step budget already spent (${ENGINE_CAPS.MAX_STEPS}).`;
        case 'NO_CONNECTION':
            return `${p}_no_workspace: no Anthropic workspace is connected and enabled on Admin → Integrations.`;
        case 'AMBIGUOUS_CONNECTION':
            return (
                `${p}_ambiguous_workspace: more than one Anthropic workspace is connected and enabled, and a run never `
                + 'chooses between them. Disable all but one.'
            );
        case 'CONNECTION_UNREADABLE':
            return `${p}_workspace_unreadable: the Anthropic workspace connection's ID or key could not be read. Enter them again.`;
        case 'NOT_PROVISIONED':
            return (
                `${p}_not_provisioned: this profile version has no agent in the connected Anthropic workspace. `
                + 'Approving the version provisions it.'
            );
        case 'AGENT_ARCHIVED':
            return (
                `${p}_agent_archived: this profile version's agent was archived when the Anthropic workspace connection `
                + 'was removed, and re-enabling the connection does not bring it back. Approve a new version of the '
                + 'profile to create its agent again.'
            );
        case 'WORKSPACE_KEY_MISSING':
            return `${p}_workspace_key_missing: the Anthropic workspace connection holds no API key.`;
        case 'SDK_AMBIENT_HEADERS_SET':
            return (
                `${p}_ambient_headers_set: ANTHROPIC_CUSTOM_HEADERS is set on this deployment, and the SDK would add it `
                + 'to every request. Unset it to run this engine.'
            );
    }
}

interface ManagedAgentsPostures {
    readonly residency: FlueModelSelection;
    readonly acknowledgement: ExternalAiAcknowledgement;
}

/** The residency terms and the business-data transfer acknowledgement, in one read (#5364). */
async function posturesFor(ctx: RequestContext): Promise<ManagedAgentsPostures> {
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { ...RESIDENCY_SELECT, ...EXTERNAL_AI_ACK_SELECT },
        }),
    );
    return { residency: residencyTermsFrom(settings), acknowledgement: acknowledgementFrom(settings) };
}

export async function runManagedAgentsDriver(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
): Promise<RunDriverOutcome> {
    const run = { runId } as const;
    const refuse = async (reason: ManagedAgentsStartRefusal): Promise<RunDriverOutcome> => {
        // Settled, not thrown: the run row already exists.
        const status = await failRun(ctx, runId, refusalMessage(reason));
        return { status, stepFailures: 0 };
    };

    const postures = await posturesFor(ctx);
    // HARD residency invariant, before anything of the customer's is read.
    if (postures.residency.residency === 'LOCAL_ONLY') return refuse('MANAGED_AGENTS_LOCAL_ONLY_UNSERVED');
    if (def.driver !== 'managed-agents') return refuse('DEFINITION_ASKED_FOR_ANOTHER_DRIVER');
    if (!def.profile) return refuse('NOT_A_PROFILE');
    if (fromSeq >= ENGINE_CAPS.MAX_STEPS) return refuse('NO_STEPS_REMAIN');

    const read = await readWorkspaceConnection(ctx);
    if (!read.ok) return refuse(read.reason);
    const connection = read.connection;

    const provision = await readProvision(ctx, def.profile.versionId, connection.connectionId);
    if (!provision) return refuse('NOT_PROVISIONED');
    // A REMOVED-THEN-RE-ENABLED CONNECTION (Step 5d, #4167). Removing it
    // archived this version's agent (Step 5c), and an archived agent starts no
    // session. Refused by name, before a client exists, rather than sent to a
    // session create Anthropic would refuse. The next approval provisions a new
    // agent (`readProfileAgent` skips the archived one).
    if (provision.archived) return refuse('AGENT_ARCHIVED');

    const choice = managedAgentsClientFor({ apiKey: connection.apiKey, workspaceId: connection.workspaceId, runId });
    if (!choice.ok) return refuse(choice.reason);

    logger.warn('managed-agents: starting a run on the Managed Agents engine', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        requestId: ctx.requestId,
        runId: run.runId,
        workflowKey: def.key,
        connectionId: connection.connectionId,
    });

    return executeManagedAgentsRun(ctx, runId, def, fromSeq, runStartMs, choice.client, {
        providerId: MANAGED_AGENTS_PROVIDER_ID,
        externalAiAcknowledgement: postures.acknowledgement,
        connectionId: connection.connectionId,
        keepSessions: connection.keepSessions,
        provision,
        model: managedAgentsModelFor(def.profile.modelTier),
    });
}
