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
 *
 * ON PROVISIONS WHAT WAS APPROVED WHILE IT WAS OFF (owner decision 2026-11-25,
 * comment 7162402419 on #5964). Approval provisions a version only while the
 * engine is in force, so a version approved while the switch was off has no
 * agent at Anthropic. Two writes enqueue `managed-agents-provision-in-force`,
 * each AFTER it and its audit row have committed: this one when it moves the
 * switch from off to on (`SWITCH_ON`), and `setAgentDriverSetting` when it
 * moves the stored engine TO Managed Agents (`ENGINE_CHOSEN`). The engine can
 * be chosen only while the switch is on and a workspace is connected, so in
 * the realistic order (switch on, connect, choose) the second one is what
 * provisions. The job runs `provisionProfilesInForce`, which calls the
 * approval's own `provisionApprovedProfileVersion` for every profile's version
 * in force, once all three preconditions hold. A job and not inline: each version is up to three calls to
 * Anthropic, and a workspace can hold many profiles, so inline it would hold
 * the owner's request for as long as the slowest workspace answers. Nothing it
 * does can undo the switch, and every outcome is recorded
 * (`MANAGED_AGENTS_PROFILES_PROVISIONED`).
 */
import { logEvent } from '@/app-layer/events/audit';
import { enqueue } from '@/app-layer/jobs/queue';
import type { ProvisionInForceTrigger } from '@/app-layer/jobs/types';
import type { RequestContext } from '@/app-layer/types';
import { resolveDriverForTenant } from '@/lib/agentic/agent-driver-policy';
import type { DeploymentSwitch, WorkspaceAgentSwitchBasis } from '@/lib/agentic/agent-switches';
import { managedAgentsDecisionFor, managedAgentsDeployment } from '@/lib/agentic/agent-switches-policy';
import { readManagedAgentsWorkspaceState } from '@/lib/agentic/managed-agents/workspace';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

import { provisionApprovedProfileVersion } from './agent-profile-provision';

/** What the section shows. */
export interface ManagedAgentsSwitchSetting {
    /** The workspace owner's stored toggle. Read only while `deployment` is `UNSET`. */
    readonly enabled: boolean;
    /** The operator's `AGENT_MANAGED_AGENTS`, as one of the three states. */
    readonly deployment: DeploymentSwitch;
    /** Whether the engine is on for this workspace now, and who decided. */
    readonly effective: { readonly on: boolean; readonly basis: WorkspaceAgentSwitchBasis };
}

/**
 * What a write did about provisioning (#5964): `QUEUED` when it was a trigger
 * (the switch moved from off to on, or the engine moved to Managed Agents) and
 * the job was enqueued, `ENQUEUE_FAILED` when that enqueue failed (logged and
 * recorded; the write stands), `NOT_NEEDED` otherwise.
 */
export type InForceProvisioning = 'QUEUED' | 'ENQUEUE_FAILED' | 'NOT_NEEDED';

export interface ManagedAgentsSwitchWrite extends ManagedAgentsSwitchSetting {
    readonly provisioning: InForceProvisioning;
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
export async function setManagedAgentsSwitch(ctx: RequestContext, enabled: boolean): Promise<ManagedAgentsSwitchWrite> {
    assertOwnerPerson(ctx);
    const before = await readSetting(ctx);
    if (before.enabled === enabled) return { ...before, provisioning: 'NOT_NEEDED' };

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

    // OFF → ON: provision what was approved while it was off, in the
    // background, now that the write has committed. Never inside it, and a
    // failure to enqueue never undoes it: it is logged and recorded.
    const provisioning = !before.effective.on && after.effective.on ? await enqueueProvisionInForce(ctx, 'SWITCH_ON') : 'NOT_NEEDED';
    return { ...after, provisioning };
}

/**
 * Enqueue `managed-agents-provision-in-force` for this workspace, acting as the
 * caller (#5964). Called by a write AFTER it committed; never throws: a failed
 * enqueue is logged, recorded, and reported as `ENQUEUE_FAILED`.
 */
export async function enqueueProvisionInForce(
    ctx: RequestContext,
    trigger: ProvisionInForceTrigger,
): Promise<InForceProvisioning> {
    try {
        await enqueue('managed-agents-provision-in-force', {
            tenantId: ctx.tenantId,
            requestedByUserId: ctx.userId,
            trigger,
            requestId: ctx.requestId,
        });
        return 'QUEUED';
    } catch (err) {
        logger.error('managed agents: provisioning could not be enqueued', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            trigger,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
        await recordProvisionOutcome(ctx, trigger, {
            outcome: 'ENQUEUE_FAILED',
            versions: 0,
            created: 0,
            alreadyProvisioned: 0,
            failed: [],
            truncated: false,
        }).catch(() => undefined);
        return 'ENQUEUE_FAILED';
    }
}

// ─── Provisioning the versions in force ─────────────────────────────

/** How many profiles one run provisions; one past it is read to know. */
export const PROVISION_IN_FORCE_CAP = 200;

/**
 * What one provisioning run did, as recorded on the audit trail.
 *
 *   PROVISIONED           every version in force has an agent (created now or before);
 *   PARTIAL               at least one version failed, named in `failed`;
 *   NOTHING_TO_PROVISION  no profile has a version in force;
 *   NO_WORKSPACE          no usable Anthropic workspace (none, or more than one):
 *                         nothing is provisioned, and that is not a failure;
 *   ENGINE_NOT_IN_FORCE   the workspace has not chosen the engine, so approval
 *                         would not have provisioned either;
 *   SWITCH_OFF            the switch was off again by the time the job ran;
 *   REQUESTER_NOT_AUTHORISED  the owner whose write enqueued it is no longer
 *                         an active member holding the key: nothing is done in
 *                         their name;
 *   ENQUEUE_FAILED        the job could not be enqueued.
 */
export type InForceProvisionOutcome =
    | 'PROVISIONED'
    | 'PARTIAL'
    | 'NOTHING_TO_PROVISION'
    | 'NO_WORKSPACE'
    | 'ENGINE_NOT_IN_FORCE'
    | 'SWITCH_OFF'
    | 'REQUESTER_NOT_AUTHORISED'
    | 'ENQUEUE_FAILED';

export interface InForceProvisionResult {
    readonly outcome: InForceProvisionOutcome;
    /** Versions in force considered. */
    readonly versions: number;
    readonly created: number;
    /** Already provisioned in this workspace: not provisioned again. */
    readonly alreadyProvisioned: number;
    readonly failed: ReadonlyArray<{ readonly versionId: string; readonly reason: string }>;
    /** More profiles than `PROVISION_IN_FORCE_CAP`: the rest were not considered. */
    readonly truncated: boolean;
}

/**
 * Provision every agent profile's version in force for this workspace,
 * through the approval's own `provisionApprovedProfileVersion` (#5964).
 *
 * Idempotent: a version already provisioned in the workspace is returned as it
 * is by `provisionManagedAgent` (`readProvision`), so a second run creates
 * nothing. Never throws: every outcome, a failure included, is logged and
 * recorded with the trigger that asked, and nothing here touches the switch or
 * the engine choice.
 */
export async function provisionProfilesInForce(
    ctx: RequestContext,
    trigger: ProvisionInForceTrigger,
): Promise<InForceProvisionResult> {
    const nothing = { versions: 0, created: 0, alreadyProvisioned: 0, failed: [], truncated: false } as const;
    let result: InForceProvisionResult;
    try {
        result = await provisionInForce(ctx, nothing);
    } catch (err) {
        logger.error('managed agents: provisioning the versions in force failed', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
        result = { ...nothing, outcome: 'PARTIAL', failed: [{ versionId: '*', reason: 'UNEXPECTED_ERROR' }] };
    }
    const log = result.failed.length > 0 ? logger.warn : logger.info;
    log.call(logger, 'managed agents: provisioning the versions in force', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        trigger,
        outcome: result.outcome,
        versions: result.versions,
        created: result.created,
        alreadyProvisioned: result.alreadyProvisioned,
        failed: result.failed.length,
        truncated: result.truncated,
    });
    await recordProvisionOutcome(ctx, trigger, result).catch((err) => {
        logger.error('managed agents: the provisioning outcome could not be recorded', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
    });
    return result;
}

async function provisionInForce(
    ctx: RequestContext,
    nothing: Omit<InForceProvisionResult, 'outcome'>,
): Promise<InForceProvisionResult> {
    // Each a reason to provision nothing, asked before any version is read.
    if (!(await managedAgentsDecisionFor({ tenantId: ctx.tenantId })).on) return { ...nothing, outcome: 'SWITCH_OFF' };
    const workspace = await readManagedAgentsWorkspaceState(ctx);
    if (workspace.state !== 'CONNECTED' && workspace.state !== 'HOSTED') return { ...nothing, outcome: 'NO_WORKSPACE' };
    if ((await resolveDriverForTenant(ctx.tenantId)).driver !== 'managed-agents') {
        return { ...nothing, outcome: 'ENGINE_NOT_IN_FORCE' };
    }

    const { versionIds, truncated } = await runInTenantContext(ctx, async (db) => {
        const profiles = await db.agentProfile.findMany({
            where: { tenantId: ctx.tenantId, currentApprovedVersion: { not: null }, agent: { status: { not: 'RETIRED' } } },
            select: { id: true, currentApprovedVersion: true },
            orderBy: { id: 'asc' },
            take: PROVISION_IN_FORCE_CAP + 1,
        });
        const considered = profiles.slice(0, PROVISION_IN_FORCE_CAP);
        const versions = considered.length === 0
            ? []
            : await db.agentProfileVersion.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      status: 'APPROVED',
                      OR: considered.map((p) => ({ profileId: p.id, version: p.currentApprovedVersion as number })),
                  },
                  select: { id: true },
                  orderBy: { id: 'asc' },
                  take: PROVISION_IN_FORCE_CAP,
              });
        return { versionIds: versions.map((v) => v.id), truncated: profiles.length > PROVISION_IN_FORCE_CAP };
    });
    if (versionIds.length === 0) return { ...nothing, truncated, outcome: 'NOTHING_TO_PROVISION' };

    let created = 0;
    let alreadyProvisioned = 0;
    const failed: Array<{ versionId: string; reason: string }> = [];
    // One at a time: each is up to three calls to the customer's workspace,
    // and the first creates its one environment, which the rest reuse.
    for (const versionId of versionIds) {
        const outcome = await provisionApprovedProfileVersion(ctx, versionId);
        if (outcome.provisioned) {
            if (outcome.created) created += 1;
            else alreadyProvisioned += 1;
        } else {
            failed.push({ versionId, reason: outcome.reason });
        }
    }
    return {
        outcome: failed.length > 0 ? 'PARTIAL' : 'PROVISIONED',
        versions: versionIds.length,
        created,
        alreadyProvisioned,
        failed,
        truncated,
    };
}

async function recordProvisionOutcome(
    ctx: RequestContext,
    trigger: ProvisionInForceTrigger,
    result: InForceProvisionResult,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'MANAGED_AGENTS_PROFILES_PROVISIONED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Managed Agents versions in force (${trigger}): provisioning ${result.outcome}`,
            detailsJson: {
                category: 'access',
                operation: 'created',
                summary: `Managed Agents provisioning (${trigger}): ${result.outcome}`,
            },
            metadata: {
                trigger,
                outcome: result.outcome,
                versions: result.versions,
                created: result.created,
                alreadyProvisioned: result.alreadyProvisioned,
                failed: result.failed,
                truncated: result.truncated,
            },
        }),
    );
}
