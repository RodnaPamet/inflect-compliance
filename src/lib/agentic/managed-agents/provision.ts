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
 *      networking, no allowed hosts (`environmentBodyFor`), and records the
 *      hash of the configuration Inflect wrote (`environmentHash`, #5854),
 *      which a run compares with the environment before every session;
 *   3. creates the profile's agent, or UPDATES the one an earlier version made,
 *      passing its version for Anthropic's optimistic concurrency. The body is
 *      `agentBodyFor`'s: Inflect's preamble as `system`, custom tools only.
 *      Before an update the earlier agent is read at its latest version, and
 *      one that is no longer what Inflect recorded (edited in the Console, so
 *      ahead of the record, or archived there) is REPLACED by a new agent
 *      rather than updated (#5854): Anthropic refuses an update naming a stale
 *      version, and an archived agent starts no session, so an update would
 *      fail for this version and every later one. The old agent's id stays on
 *      the earlier versions' rows, so a connection removal's and a purge's
 *      clean-up (Step 5c) still archive it; the new row is written now, after
 *      any clean-up already opened, so none of those archives the new agent;
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
    SEND_ONCE,
    agentBodyFor,
    agentDrift,
    environmentBodyFor,
    environmentHashOf,
    systemHashOf,
    toolsHashOf,
    type AgentDrift,
    type ManagedAgentCustomTool,
    type RetrievedAgent,
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

/** The earlier agent a provisioning replaced with a new one, and why (#5854). */
export interface ReplacedAgent {
    readonly anthropicAgentId: string;
    readonly drift: AgentDrift;
}

export async function provisionManagedAgent(
    ctx: RequestContext,
    client: Anthropic,
    input: ProvisionInput,
): Promise<{ record: ProvisionRecord; created: boolean; replaced: ReplacedAgent | null }> {
    const existing = await readProvision(ctx, input.profileVersionId, input.connectionId);
    if (existing) return { record: existing, created: false, replaced: null };

    // What Inflect writes for this connection's environment. A reused one keeps
    // the hash its first provision recorded; one recorded before the column
    // existed gets what Inflect wrote, which is this body (#5854).
    const environmentBody = environmentBodyFor(input.connectionId);
    const written = environmentHashOf(environmentBody.config);
    const reused = await readConnectionEnvironment(ctx, input.connectionId);
    const environmentId = reused?.environmentId ?? (await client.beta.environments.create(environmentBody, SEND_ONCE)).id;
    const environmentHash = reused?.environmentHash ?? written;

    const body = agentBodyFor({ profileId: input.profileId, model: input.model, tools: input.tools });
    const prior = await readProfileAgent(ctx, input.profileId, input.connectionId);
    // The earlier agent at its LATEST version: still the one Inflect recorded?
    // A read that fails throws, as the update would have: nothing is created.
    let replaced: ReplacedAgent | null = null;
    if (prior) {
        const latest = (await client.beta.agents.retrieve(prior.anthropicAgentId)) as unknown as RetrievedAgent;
        const drift = agentDrift(latest, prior);
        if (drift) replaced = { anthropicAgentId: prior.anthropicAgentId, drift };
    }
    const agent = prior && !replaced
        ? await client.beta.agents.update(prior.anthropicAgentId, { ...body, version: prior.anthropicAgentVersion }, SEND_ONCE)
        : await client.beta.agents.create(body, SEND_ONCE);

    const record: ProvisionRecord = {
        profileId: input.profileId,
        profileVersionId: input.profileVersionId,
        connectionId: input.connectionId,
        anthropicAgentId: agent.id,
        anthropicAgentVersion: agent.version,
        environmentId,
        // What Inflect WROTE: the run compares the agent and the environment
        // Anthropic returns with these.
        systemHash: systemHashOf(body.system),
        toolsHash: toolsHashOf(body.tools),
        environmentHash,
    };
    await recordProvision(ctx, record);
    return { record, created: true, replaced };
}
