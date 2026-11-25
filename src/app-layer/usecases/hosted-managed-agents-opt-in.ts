/**
 * A WORKSPACE OPTS IN, OR OUT, OF MANAGED AGENTS HOSTED BY INFLECT (Step 6b
 * of `docs/claude-managed-agents-design.md`, shape MA-C1).
 *
 * THE ONE WRITER of `TenantSecuritySettings.hostedManagedAgentsOptIn`. Its
 * route carries a literal `requirePermission('admin.tenant_lifecycle')`, and
 * this usecase asks the same key again and asks that the caller is a PERSON
 * in their own session: an API key, an agent and a job are refused, whatever
 * permissions they hold. Hosting moves a workspace's instructions and
 * read-tool output into Inflect's own Anthropic organisation, stored in the US
 * without Zero Data Retention while each run lasts; that is a decision an
 * owner takes knowingly, never one a credential or a schedule takes.
 *
 * Every change is audited (`HOSTED_MANAGED_AGENTS_OPT_IN_CHANGED`, category
 * `access`), with the other terms as they stood at the decision, so the trail
 * can tell an opt-in that ran hosted from one the deployment never honoured.
 *
 * OPTING IN is refused unless hosting is offered: the source constant
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is true and the deployment holds its workspace
 * pair (`HOSTED_NOT_OFFERED`); the plan includes it (`HOSTED_NOT_ENTITLED`);
 * and the residency is not LOCAL_ONLY (`HOSTED_LOCAL_ONLY`). So while the
 * constant is false no workspace can opt in, and the opt-in a customer reads
 * on the page is one the deployment can honour. The run's resolution asks
 * every term again, because each can change after the opt-in.
 *
 * OPTING OUT is always allowed, and runs Step 5c's clean-up for this tenant's
 * records in Inflect's workspace (`openConnectionRemovalCleanup` under the
 * fixed hosted connection id): every session Inflect recorded is deleted and
 * every agent archived, by recorded id, and what cannot be finished at once is
 * retried by data-lifecycle. The clean-up runs after the opt-out commits and
 * never throws into it.
 *
 * CONNECTING THE WORKSPACE'S OWN ANTHROPIC WORKSPACE WITHDRAWS THE OPT-IN
 * (#4173, `withdrawHostedOptInOnOwnWorkspace`). It is the column's one other
 * write, it lives here so this file stays the column's only writer, and it can
 * only turn the opt-in OFF: a narrowing, made by whoever saved the connection
 * (an admin act), audited with the connection that caused it. Opting back in
 * is still an owner's act, in person, through `setHostedManagedAgentsOptIn`.
 */
import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import { openConnectionRemovalCleanup, type CleanupStatus } from '@/app-layer/usecases/managed-agents-cleanup';
import {
    INFLECT_HOSTED_CONNECTION_ID,
    inflectHostedWorkspace,
    readHostedTenantTerms,
    readManagedAgentsWorkspaceState,
    type HostedWorkspaceRefusal,
    type ManagedAgentsWorkspaceState,
} from '@/lib/agentic/managed-agents/workspace';
import { runInTenantContext } from '@/lib/db-context';
import { ConflictError, forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

/** What the owner's section shows: the opt-in, and every other term beside it. */
export interface HostedManagedAgentsSetting {
    /** What an owner chose. */
    readonly optedIn: boolean;
    /** The deployment offers hosting: the source constant is true and its workspace pair is set. */
    readonly offered: boolean;
    /** The tenant's plan includes hosting (`hostedManagedAgents`). */
    readonly entitled: boolean;
    readonly residency: 'EXTERNAL' | 'LOCAL_ONLY';
    /**
     * Where a run would go today, by the run's own rules: `CONNECTED` (the
     * workspace's own Anthropic workspace wins), `AMBIGUOUS`, `HOSTED` or
     * `NONE`, and the hosted term that failed when it is `NONE`.
     */
    readonly workspace: ManagedAgentsWorkspaceState;
    readonly hostedRefusal: HostedWorkspaceRefusal | null;
}

/** Why an opt-in was refused. Opting out is never refused for these. */
export type HostedOptInRefusal = 'HOSTED_NOT_OFFERED' | 'HOSTED_NOT_ENTITLED' | 'HOSTED_LOCAL_ONLY';

const REFUSAL_MESSAGE: Record<HostedOptInRefusal, string> = {
    HOSTED_NOT_OFFERED: 'This deployment does not offer agents hosted in Inflect\'s Anthropic organisation.',
    HOSTED_NOT_ENTITLED: 'This workspace\'s plan does not include agents hosted by Inflect.',
    HOSTED_LOCAL_ONLY:
        'This workspace keeps AI processing local (LOCAL_ONLY), and hosted agents are stored in the US. Change where AI runs first.',
};

/** OWNER-tier, and a person in their own session. */
function assertOwnerPerson(ctx: RequestContext): void {
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden('Only an owner can view or change whether agents may be hosted by Inflect.', {
            reason: 'HOSTED_OPT_IN_IS_OWNER_TIER',
        });
    }
    // A key, an agent or a job never decides this, whatever it holds. A
    // context with no actor type is a signed-in person's (`logEvent` reads it
    // as USER).
    if (ctx.apiKeyId || ctx.agentId || (ctx.actorType !== undefined && ctx.actorType !== 'USER')) {
        throw forbidden(
            'Whether agents may be hosted by Inflect is decided by a person in their own session, never by an API key, '
                + 'an agent or a scheduled job.',
            { reason: 'HOSTED_OPT_IN_NOT_A_PERSON' },
        );
    }
}

async function readSetting(ctx: RequestContext): Promise<HostedManagedAgentsSetting> {
    const [terms, workspace] = await Promise.all([readHostedTenantTerms(ctx), readManagedAgentsWorkspaceState(ctx)]);
    return {
        optedIn: terms.optedIn,
        // Key-free: the reader's answer only. While the constant is false it
        // returns before either variable is read.
        offered: inflectHostedWorkspace().ok,
        entitled: terms.entitled,
        residency: terms.residency,
        workspace: workspace.state,
        hostedRefusal: workspace.hostedRefusal,
    };
}

/** The setting, for the owner's section. */
export async function getHostedManagedAgentsSetting(ctx: RequestContext): Promise<HostedManagedAgentsSetting> {
    assertOwnerPerson(ctx);
    return readSetting(ctx);
}

export interface HostedOptInResult {
    readonly setting: HostedManagedAgentsSetting;
    /** The clean-up an opt-out ran, or null for an opt-in or no change. */
    readonly cleanup: { readonly status: CleanupStatus; readonly reason: string | null } | null;
}

/** Opt this workspace in to, or out of, agents hosted by Inflect. */
export async function setHostedManagedAgentsOptIn(ctx: RequestContext, optIn: boolean): Promise<HostedOptInResult> {
    assertOwnerPerson(ctx);
    const before = await readSetting(ctx);
    if (before.optedIn === optIn) return { setting: before, cleanup: null };

    if (optIn) {
        const refusal: HostedOptInRefusal | null = !before.offered
            ? 'HOSTED_NOT_OFFERED'
            : !before.entitled
              ? 'HOSTED_NOT_ENTITLED'
              : before.residency === 'LOCAL_ONLY'
                ? 'HOSTED_LOCAL_ONLY'
                : null;
        if (refusal) throw new ConflictError(`${refusal}: ${REFUSAL_MESSAGE[refusal]}`, { reason: refusal });
    }

    await runInTenantContext(ctx, async (db) => {
        await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, hostedManagedAgentsOptIn: optIn },
            update: { hostedManagedAgentsOptIn: optIn },
        });
        await logEvent(db, ctx, {
            action: 'HOSTED_MANAGED_AGENTS_OPT_IN_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: optIn
                ? 'Opted in to agents hosted in Inflect\'s Anthropic organisation'
                : 'Opted out of agents hosted in Inflect\'s Anthropic organisation',
            // `access`: this decides whether a third party stores the
            // workspace's instructions and tool output.
            detailsJson: {
                category: 'access',
                operation: optIn ? 'grant' : 'revoke',
                summary: optIn ? 'Hosted Managed Agents: opted in' : 'Hosted Managed Agents: opted out',
            },
            metadata: {
                from: before.optedIn,
                to: optIn,
                offered: before.offered,
                entitled: before.entitled,
                residency: before.residency,
                workspace: before.workspace,
            },
        });
    });

    logger.info('hosted managed agents opt-in changed', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        optedIn: optIn,
    });

    // OPTING OUT CLEANS UP, after the opt-out has committed (Step 5c's own
    // clean-up, under Inflect's workspace's fixed id). Never throws.
    const cleanup = optIn ? null : await openConnectionRemovalCleanup(ctx, INFLECT_HOSTED_CONNECTION_ID);
    return { setting: await readSetting(ctx), cleanup };
}

/**
 * THE OPT-IN IS WITHDRAWN WHEN THE WORKSPACE CONNECTS ITS OWN ANTHROPIC
 * WORKSPACE (#4173). The tenant's own workspace wins the resolution anyway;
 * withdrawing the opt-in is what keeps that true AFTERWARDS: a later removal
 * of the own connection (a key rotated by remove and re-add, or leaving
 * Anthropic) must not silently move the next run's instructions and tool
 * output into Inflect's US organisation without Zero Data Retention. Coming
 * back to hosting is an owner's decision, taken again, in person.
 *
 * Only ever turns the opt-in off, and only when it is on; audited as the same
 * action as an owner's change, naming the cause and the connection. Returns
 * whether it changed anything. The caller (the connection save, after it has
 * committed) never lets this fail the save.
 */
export async function withdrawHostedOptInOnOwnWorkspace(ctx: RequestContext, connectionId: string): Promise<boolean> {
    const withdrawn = await runInTenantContext(ctx, async (db) => {
        const changed = await db.tenantSecuritySettings.updateMany({
            where: { tenantId: ctx.tenantId, hostedManagedAgentsOptIn: true },
            data: { hostedManagedAgentsOptIn: false },
        });
        if (changed.count === 0) return false;
        await logEvent(db, ctx, {
            action: 'HOSTED_MANAGED_AGENTS_OPT_IN_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: 'Opted out of agents hosted in Inflect\'s Anthropic organisation: the workspace connected its own Anthropic workspace',
            detailsJson: {
                category: 'access',
                operation: 'revoke',
                summary: 'Hosted Managed Agents: opted out (own Anthropic workspace connected)',
            },
            metadata: { from: true, to: false, cause: 'OWN_WORKSPACE_CONNECTED', connectionId },
        });
        return true;
    });
    if (withdrawn) {
        logger.info('hosted managed agents opt-in withdrawn: the workspace connected its own Anthropic workspace', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            connectionId,
        });
    }
    return withdrawn;
}
