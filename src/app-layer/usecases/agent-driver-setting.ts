/**
 * The CUSTOMER's half of the two-key agentic-driver gate, and the only way to
 * write it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `TenantSecuritySettings.agentDriver` has been readable since the driver seam
 * landed — `resolveDriverForTenant` selects it on every agentic run — and had
 * no writer anywhere in `src/`. A column with a reader and no writer is not a
 * switch; it is a constant that looks like a switch. Every tenant sat at the
 * `@default(STATIC)` the migration gave them, and the only way to move one was
 * an UPDATE against production by hand: no authorization, no audit row, and no
 * record afterwards of who decided it.
 *
 * That is the specific failure this subsystem keeps naming in its own comments
 * — settable-and-inert, or in this case gated-and-unsettable — so the write
 * path is a usecase with the same shape as `setIdentityWriteMode`, which is
 * the nearest thing in the repo: a customer-side half of a two-key gate over
 * authority that reaches the customer's own data.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not enable anything. `resolveAgentDriver` ANDs three independent
 * terms and this is one of them; the operator's `AGENT_DRIVER_FLUE` and
 * `DRIVER_IMPLEMENTED.flue` are the other two, and either still refuses. Which
 * is exactly why `getAgentDriverSetting` returns the other two ALONGSIDE the
 * stored value rather than the stored value alone — a tenant reading FLUE
 * while the env switch is off is running on the static engine, and without the
 * other terms in the same response there is nothing to tell them so. The
 * identity write-policy route learned this the expensive way; its `honoured`
 * block exists for the same reason and is the model for `effective` here.
 */
import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import {
    AGENT_DRIVER_MODES,
    DRIVER_IMPLEMENTED,
    coerceStoredDriverMode,
    flueEnvEnabled,
    resolveAgentDriver,
    type AgentDriverMode,
    type StoredDriverMode,
} from '@/lib/agentic/agent-driver';
import { narrowToWhatAWorkflowAsksFor } from '@/lib/agentic/agent-driver-policy';
import type { AgentSwitchBasis } from '@/lib/agentic/agent-switches';
import { toolRunnerDecisionFor } from '@/lib/agentic/agent-switches-policy';
import { managedAgentsEnabled } from '@/lib/agentic/managed-agents-switch';
import {
    readManagedAgentsWorkspaceState,
    type HostedWorkspaceRefusal,
    type ManagedAgentsWorkspaceState,
} from '@/lib/agentic/managed-agents/workspace';
import { runInTenantContext } from '@/lib/db-context';
import { readStoredDriverMode } from '@/lib/agentic/agent-driver-stored-mode';
import { env } from '@/env';
import { ConflictError, badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability';

/**
 * Why a workspace may not choose the Managed Agents engine (Step 5d, #4167).
 * The engine runs in the workspace's own Anthropic workspace, and a run never
 * chooses between two, so the choice needs exactly one enabled
 * `anthropic-workspace` connection.
 */
export type ManagedAgentsChoiceRefusal = 'MANAGED_AGENTS_NO_WORKSPACE' | 'MANAGED_AGENTS_AMBIGUOUS_WORKSPACE';

const MANAGED_AGENTS_CHOICE_REFUSAL: Record<Exclude<ManagedAgentsWorkspaceState, 'CONNECTED' | 'HOSTED'>, ManagedAgentsChoiceRefusal> = {
    NONE: 'MANAGED_AGENTS_NO_WORKSPACE',
    AMBIGUOUS: 'MANAGED_AGENTS_AMBIGUOUS_WORKSPACE',
};

const MANAGED_AGENTS_CHOICE_MESSAGE: Record<ManagedAgentsChoiceRefusal, string> = {
    MANAGED_AGENTS_NO_WORKSPACE:
        'The Managed Agents engine runs in your own Anthropic workspace, and none is connected. Connect one under ' +
        'Admin, Integrations, Anthropic workspace, then choose the engine.',
    MANAGED_AGENTS_AMBIGUOUS_WORKSPACE:
        'More than one Anthropic workspace is connected and enabled, and a run never chooses between them. ' +
        'Disable all but one under Admin, Integrations, then choose the engine.',
};

export interface AgentDriverSetting {
    /**
     * What this tenant has ASKED for. Never null: an absent row reads STATIC.
     * Any value the enum declares, a READ_ONLY one included (#4241): only a
     * rollback from a build that wrote it can put one there, and it reads as
     * itself rather than as STATIC.
     */
    mode: StoredDriverMode;
    /**
     * What a run would ACTUALLY execute on, right now, with all three terms
     * ANDed — and why, when that is not what `mode` says. Computed by
     * `resolveAgentDriver`, the same function the run path calls, rather than
     * re-derived: a second copy of the AND is how a settings page ends up
     * reporting a capability the runtime refuses.
     */
    effective: { driver: string; reason: string | null };
    /** The operator's process-wide switch for the Flue engine — the other key. */
    envEnabled: boolean;
    /** Whether this build has a Flue implementation at all. */
    implemented: boolean;
    /**
     * The same two terms for the Tool Runner engine (Step 2c, #4150), which has
     * its own operator switch, `AGENT_DRIVER_TOOL_RUNNER`. Reported beside
     * Flue's rather than instead of them: the page offers both engines, and
     * which ones an owner may choose depends on each engine's own switch.
     *
     * Since #4557 that switch may be the tenant's ORGANIZATION's: with
     * `AGENT_DRIVER_TOOL_RUNNER` unset, an org admin decides. `envEnabled` is
     * therefore "available to this workspace", whoever decided, and `basis`
     * says who did, so the page can name the person to ask.
     */
    toolRunner: { envEnabled: boolean; implemented: boolean; basis: AgentSwitchBasis };
    /**
     * The same two terms for the Managed Agents engine (Step 5d, #4167), whose
     * operator switch is `AGENT_MANAGED_AGENTS`, and the one thing only it
     * needs before it may be chosen: exactly one enabled Anthropic workspace
     * connection (`workspace`). The page offers the engine only when the switch
     * is on and the workspace is `CONNECTED`; the writer refuses it without one.
     *
     * Since Step 6b the workspace may instead be INFLECT's own (`HOSTED`): no
     * connection of the tenant's, and every hosted term holds (the source
     * constant, the deployment's workspace pair, an owner's opt-in, a
     * residency that is not LOCAL_ONLY and the plan's entitlement). It is
     * read by the same rules the run's resolution applies
     * (`readManagedAgentsWorkspaceState`), with no key read. `hostedRefusal`
     * names the hosted term that failed when the answer is `NONE`. While
     * `HOSTED_MANAGED_AGENTS_ACTIVE` is false it is never `HOSTED`.
     */
    managedAgents: {
        envEnabled: boolean;
        implemented: boolean;
        workspace: ManagedAgentsWorkspaceState;
        hostedRefusal: HostedWorkspaceRefusal | null;
    };
}

/** Read the stored mode and, more importantly, what it will actually do. */
export async function getAgentDriverSetting(ctx: RequestContext): Promise<AgentDriverSetting> {
    // READ AS TEXT, through the reader the run path also uses (#4224). Read
    // through the generated client, a stored value this build's enum does not
    // contain fails the whole query — so this surface answered 500 and the
    // `UNRECOGNISED_SETTING` sentence below it, which tells an owner to choose
    // an engine again, was unreachable at exactly the moment it applied.
    const stored = await runInTenantContext(ctx, (db) =>
        readStoredDriverMode(db, ctx.tenantId),
    );

    // COERCED on read, and the run path reaches the same arms through
    // `resolveAgentDriver`. An absent row, a NULL and a value this build does
    // not recognise all read STATIC, and reading them any other way here would
    // make this surface disagree with the run path about the same stored byte.
    const mode = coerceStoredDriverMode(stored);
    const envEnabled = flueEnvEnabled(env.AGENT_DRIVER_FLUE);
    const toolRunnerSwitch = await toolRunnerDecisionFor({ tenantId: ctx.tenantId });
    const toolRunnerEnvEnabled = toolRunnerSwitch.on;
    const managedAgentsEnvEnabled = managedAgentsEnabled();
    const workspace = await readManagedAgentsWorkspaceState(ctx);
    // FOUR terms, not three. `resolveAgentDriver` ANDs env, tenant and the
    // build flag; `narrowToWhatAWorkflowAsksFor` applies the fourth — no
    // registered WorkflowDefinition asks for the engine, so `selectRunDriver`
    // cannot choose it however the other three are set. Without this the page
    // reported `flue` with `reason: null` on a deployment that runs every
    // workflow on the static engine.
    const decision = await narrowToWhatAWorkflowAsksFor(
        // The Managed Agents switch too (Step 5d). Without it a workspace that
        // chose the engine read ENV_DISABLED here whatever the deployment said,
        // while the run path, which passes it, ran the engine.
        resolveAgentDriver({ envEnabled, toolRunnerEnvEnabled, managedAgentsEnvEnabled, tenantSetting: mode }),
        ctx.tenantSlug,
    );

    return {
        mode,
        effective: { driver: decision.driver, reason: decision.reason ?? null },
        envEnabled,
        implemented: DRIVER_IMPLEMENTED.flue,
        toolRunner: {
            envEnabled: toolRunnerEnvEnabled,
            implemented: DRIVER_IMPLEMENTED['tool-runner'],
            basis: toolRunnerSwitch.basis,
        },
        managedAgents: {
            envEnabled: managedAgentsEnvEnabled,
            implemented: DRIVER_IMPLEMENTED['managed-agents'],
            workspace: workspace.state,
            hostedRefusal: workspace.hostedRefusal,
        },
    };
}

/**
 * Set the tenant's half of the gate.
 *
 * NO LADDER, and that is a deliberate difference from `setIdentityWriteMode`.
 * The identity ladder exists because its rungs are progressively more
 * dangerous and the dwell is what buys observation time in between. This is
 * not a ladder: it is two values, both of which run the same register controls
 * in front of every tool call, and neither of which can act without the
 * operator's switch. A dwell here would gate nothing that the operator's own
 * key does not already gate.
 *
 * Both directions are always permitted, including a widen straight to FLUE and
 * an immediate narrow back. The narrow is the one that has to be instant: it
 * is the kill switch an operator reaches for while a run is misbehaving, and a
 * cooldown on the way DOWN is how a safety control becomes the incident.
 */
export async function setAgentDriverSetting(
    ctx: RequestContext,
    next: AgentDriverMode,
): Promise<AgentDriverSetting> {
    if (!AGENT_DRIVER_MODES.includes(next)) {
        throw badRequest(`Unknown agent driver mode: ${next}`);
    }

    const before = await getAgentDriverSetting(ctx);

    // THE MANAGED AGENTS ENGINE NEEDS A WORKSPACE TO RUN IN (Step 5d). Refused
    // by name, before anything is written, unless exactly one enabled
    // `anthropic-workspace` connection exists: with none a run could only
    // refuse, and with two it would refuse too, because a run never chooses.
    // Only the move TO this engine is refused; every move away stays instant,
    // for the reason the docblock gives.
    // Inflect's own workspace (`HOSTED`, Step 6b) is a workspace a run can use
    // too, by the run's own rules.
    const usable = before.managedAgents.workspace;
    if (next === 'MANAGED_AGENTS' && usable !== 'CONNECTED' && usable !== 'HOSTED') {
        const reason = MANAGED_AGENTS_CHOICE_REFUSAL[usable];
        throw new ConflictError(`${reason}: ${MANAGED_AGENTS_CHOICE_MESSAGE[reason]}`, { reason });
    }

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            // UPSERT, because a tenant may have no settings row at all — which
            // is the common case for exactly the tenants nobody has configured
            // anything for, i.e. the ones a first enablement is aimed at. An
            // `update` alone would throw P2025 on them.
            create: { tenantId: ctx.tenantId, agentDriver: next },
            update: { agentDriver: next },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'AGENT_DRIVER_MODE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Agentic driver: ${before.mode} → ${next}`,
            // `access`, not `configuration`, for the same reason the identity
            // ladder is: this decides whether a third-party runtime drives a
            // model over the tenant's compliance data. An access-review reader
            // is the audience.
            detailsJson: {
                category: 'access',
                // Every reasoning engine is a grant: each hands the walk of a
                // run to code this repository did not write. Only the move back
                // to the built-in engine takes that away.
                operation: next === 'STATIC' ? 'revoke' : 'grant',
                summary: `Agentic driver: ${before.mode} → ${next}`,
            },
            // The OTHER key's state at the moment of the decision. Without it
            // the trail cannot distinguish "switched to FLUE and ran on Flue"
            // from "switched to FLUE and kept running static because the
            // deployment switch was off" — two very different sets of runs.
            metadata: {
                from: before.mode,
                to: next,
                envEnabled: before.envEnabled,
                implemented: before.implemented,
                toolRunnerEnvEnabled: before.toolRunner.envEnabled,
                toolRunnerBasis: before.toolRunner.basis,
                toolRunnerImplemented: before.toolRunner.implemented,
                managedAgentsEnvEnabled: before.managedAgents.envEnabled,
                managedAgentsImplemented: before.managedAgents.implemented,
                managedAgentsWorkspace: before.managedAgents.workspace,
            },
        }),
    );

    logger.info('agent driver mode changed', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        from: before.mode,
        to: next,
        envEnabled: before.envEnabled,
    });

    return getAgentDriverSetting(ctx);
}
