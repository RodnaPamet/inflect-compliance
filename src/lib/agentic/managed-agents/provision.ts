/**
 * PROVISIONING: one Managed Agent per profile, in the customer's workspace
 * (Step 5b of `docs/claude-managed-agents-design.md`, #4165).
 *
 * Called for an APPROVED profile version, by `provisionApprovedProfileVersion`
 * (`app-layer/usecases/agent-profile-provision.ts`), which asks first whether
 * the tenant runs this engine at all. It:
 *
 *   1. returns the existing record when this version is already provisioned in
 *      this workspace, so a retry creates nothing twice;
 *   2. makes the connection's ONE environment, or reuses it: `cloud`, `limited`
 *      networking, no allowed hosts (`environmentBodyFor`);
 *   3. creates the profile's agent, or UPDATES the one an earlier version made,
 *      passing its version for Anthropic's optimistic concurrency. The body is
 *      `agentBodyFor`'s: Inflect's preamble as `system`, custom tools only;
 *   4. records the agent's id and version and the hashes of the `system` and
 *      `tools` it WROTE (`recordProvision`), which a run compares before every
 *      session.
 *
 * The tenant's instructions are not an input here at all: nothing in this
 * module can put them on an agent, which can never be deleted at Anthropic.
 */
import type Anthropic from '@anthropic-ai/sdk';

import type { RequestContext } from '@/app-layer/types';

import {
    agentBodyFor,
    environmentBodyFor,
    systemHashOf,
    toolsHashOf,
    type ManagedAgentCustomTool,
} from './definition';
import {
    readConnectionEnvironment,
    readProfileAgent,
    readProvision,
    recordProvision,
    type ProvisionRecord,
} from './store';

export interface ProvisionInput {
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly connectionId: string;
    readonly model: string;
    readonly tools: readonly ManagedAgentCustomTool[];
}

export async function provisionManagedAgent(
    ctx: RequestContext,
    client: Anthropic,
    input: ProvisionInput,
): Promise<{ record: ProvisionRecord; created: boolean }> {
    const existing = await readProvision(ctx, input.profileVersionId, input.connectionId);
    if (existing) return { record: existing, created: false };

    const environmentId =
        (await readConnectionEnvironment(ctx, input.connectionId)) ??
        (await client.beta.environments.create(environmentBodyFor(input.connectionId))).id;

    const body = agentBodyFor({ profileId: input.profileId, model: input.model, tools: input.tools });
    const prior = await readProfileAgent(ctx, input.profileId, input.connectionId);
    const agent = prior
        ? await client.beta.agents.update(prior.anthropicAgentId, { ...body, version: prior.anthropicAgentVersion })
        : await client.beta.agents.create(body);

    const record: ProvisionRecord = {
        profileId: input.profileId,
        profileVersionId: input.profileVersionId,
        connectionId: input.connectionId,
        anthropicAgentId: agent.id,
        anthropicAgentVersion: agent.version,
        environmentId,
        // What Inflect WROTE: the run compares the agent Anthropic returns with these.
        systemHash: systemHashOf(body.system),
        toolsHash: toolsHashOf(body.tools),
    };
    await recordProvision(ctx, record);
    return { record, created: true };
}
