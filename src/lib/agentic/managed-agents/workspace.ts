/**
 * WHICH ANTHROPIC WORKSPACE A MANAGED AGENTS RUN USES (Step 6b of
 * `docs/claude-managed-agents-design.md`, shapes MA-C2 and MA-C1).
 *
 * ONE RESOLUTION FUNCTION, `resolveManagedAgentsWorkspace`, asked by the run's
 * driver and by provisioning, and its key-free twin
 * `readManagedAgentsWorkspaceState`, asked by the settings pages. Both apply
 * the same rules in the same order:
 *
 *   1. THE TENANT'S OWN WORKSPACE WINS (MA-C2). Exactly one enabled
 *      `anthropic-workspace` connection runs there. One that is ambiguous or
 *      unreadable REFUSES by name: a run never falls back to Inflect's
 *      workspace because the customer's could not be read.
 *   2. OTHERWISE INFLECT'S OWN WORKSPACE (MA-C1), only when every term holds,
 *      in this order, and the first that fails is the refusal's name:
 *        HOSTED_NOT_ACTIVE      the source constant `HOSTED_MANAGED_AGENTS_ACTIVE`
 *                               is false (it is, until Step 6c);
 *        HOSTED_NOT_CONFIGURED  the deployment has no workspace pair of its
 *                               own (`AGENT_MANAGED_AGENTS_HOSTED_*`);
 *        HOSTED_NOT_OPTED_IN    no owner opted this tenant in;
 *        HOSTED_LOCAL_ONLY      the tenant's AI residency is LOCAL_ONLY, and
 *                               the only storage on offer is in the US;
 *        HOSTED_NOT_ENTITLED    the tenant's plan does not include hosting
 *                               (`hostedManagedAgents` in `entitlements.ts`;
 *                               no plan does until the owner opens one).
 *
 * INFLECT'S KEY HAS ONE READER, `inflectHostedWorkspace`, and it returns
 * BEFORE it reads the deployment's workspace id or key while the constant is
 * false. Nothing else in `src/` reads `AGENT_MANAGED_AGENTS_HOSTED_API_KEY`.
 * `tests/guards/hosted-managed-agents-activation.test.ts` reads this file for
 * both. The key leaves here only as a field of the resolved workspace, which
 * the caller hands to `managedAgentsClientFor` (the engine's one constructor,
 * with its allowlist) and drops.
 *
 * A hosted workspace is recorded under the fixed connection id
 * `INFLECT_HOSTED_CONNECTION_ID` wherever a connection id is recorded (the
 * provision rows, the session ledger, the clean-up records), and it NEVER
 * keeps sessions: decision 4's keep choice is MA-C2's only, so a hosted
 * session is always deleted at settle.
 */
import type { RequestContext } from '@/app-layer/types';
import { env } from '@/env';
import { RESIDENCY_SELECT, residencyTermsFrom } from '@/lib/agentic/flue/model-selection';
import { isEntitledTo } from '@/lib/billing/entitlements';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { HOSTED_MANAGED_AGENTS_ACTIVE } from './hosted-activation';
import {
    readWorkspaceConnection,
    readWorkspaceConnectionState,
    type WorkspaceConnection,
    type WorkspaceConnectionRefusal,
} from './store';

/**
 * The connection id every record of Inflect's own workspace carries. Not a row
 * of `IntegrationConnection`: the workspace is the deployment's, not a
 * tenant's. Plain text, and shape-free on purpose, so it can never collide
 * with a cuid. A migration CHECK on `ManagedAgentsCleanup` names it.
 */
export const INFLECT_HOSTED_CONNECTION_ID = 'inflect-hosted';

/** Whose workspace a run uses: the tenant's own (MA-C2) or Inflect's (MA-C1). */
export type ManagedAgentsWorkspaceKind = 'TENANT' | 'HOSTED';

/** A workspace a run or a provisioning can use. */
export interface ResolvedWorkspace extends WorkspaceConnection {
    readonly kind: ManagedAgentsWorkspaceKind;
}

/** Why Inflect's own workspace is not this tenant's. */
export type HostedWorkspaceRefusal =
    | 'HOSTED_NOT_ACTIVE'
    | 'HOSTED_NOT_CONFIGURED'
    | 'HOSTED_NOT_OPTED_IN'
    | 'HOSTED_LOCAL_ONLY'
    | 'HOSTED_NOT_ENTITLED';

/** Why a tenant has no workspace a run could use. */
export type WorkspaceResolutionRefusal = Exclude<WorkspaceConnectionRefusal, 'NO_CONNECTION'> | HostedWorkspaceRefusal;

export type WorkspaceResolution =
    | { readonly ok: true; readonly workspace: ResolvedWorkspace }
    | { readonly ok: false; readonly reason: WorkspaceResolutionRefusal };

/** The deployment's own workspace pair, or why there is none. */
export type InflectHostedWorkspace =
    | { readonly ok: true; readonly workspaceId: string; readonly apiKey: string }
    | { readonly ok: false; readonly reason: 'HOSTED_NOT_ACTIVE' | 'HOSTED_NOT_CONFIGURED' };

/**
 * THE ONE READER OF INFLECT'S WORKSPACE ID AND KEY.
 *
 * The constant is asked FIRST, before either variable is read: while
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is false this returns `HOSTED_NOT_ACTIVE`
 * whatever the deployment holds, so nothing downstream can build a client
 * with Inflect's key. Then both variables must be set: a deployment without
 * them never offers hosting (the self-hosted case).
 */
export function inflectHostedWorkspace(): InflectHostedWorkspace {
    if (!HOSTED_MANAGED_AGENTS_ACTIVE) return { ok: false, reason: 'HOSTED_NOT_ACTIVE' };
    const workspaceId = env.AGENT_MANAGED_AGENTS_HOSTED_WORKSPACE_ID?.trim() ?? '';
    const apiKey = env.AGENT_MANAGED_AGENTS_HOSTED_API_KEY?.trim() ?? '';
    if (!workspaceId || !apiKey) return { ok: false, reason: 'HOSTED_NOT_CONFIGURED' };
    return { ok: true, workspaceId, apiKey };
}

/** What a tenant must hold for hosting, beside the deployment. */
export interface HostedTenantTerms {
    readonly optedIn: boolean;
    readonly residency: 'EXTERNAL' | 'LOCAL_ONLY';
    readonly entitled: boolean;
}

/** The first tenant term that fails, in the documented order, or null. Pure. */
export function hostedTermsRefusal(terms: HostedTenantTerms): HostedWorkspaceRefusal | null {
    if (!terms.optedIn) return 'HOSTED_NOT_OPTED_IN';
    if (terms.residency === 'LOCAL_ONLY') return 'HOSTED_LOCAL_ONLY';
    if (!terms.entitled) return 'HOSTED_NOT_ENTITLED';
    return null;
}

/** The tenant's opt-in and residency, in one read, and its plan's entitlement. */
export async function readHostedTenantTerms(ctx: RequestContext): Promise<HostedTenantTerms> {
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { ...RESIDENCY_SELECT, hostedManagedAgentsOptIn: true },
        }),
    );
    return {
        optedIn: settings?.hostedManagedAgentsOptIn === true,
        residency: residencyTermsFrom(settings).residency === 'LOCAL_ONLY' ? 'LOCAL_ONLY' : 'EXTERNAL',
        entitled: await isEntitledTo(ctx, 'hostedManagedAgents'),
    };
}

/** Inflect's workspace for this tenant, or the first term that fails. */
async function resolveHostedWorkspace(ctx: RequestContext): Promise<WorkspaceResolution> {
    const deployment = inflectHostedWorkspace();
    if (!deployment.ok) return { ok: false, reason: deployment.reason };
    const refusal = hostedTermsRefusal(await readHostedTenantTerms(ctx));
    if (refusal) return { ok: false, reason: refusal };
    return {
        ok: true,
        workspace: {
            kind: 'HOSTED',
            connectionId: INFLECT_HOSTED_CONNECTION_ID,
            workspaceId: deployment.workspaceId,
            // Decision 4: the keep choice is MA-C2's only. Always deleted.
            keepSessions: false,
            apiKey: deployment.apiKey,
        },
    };
}

/**
 * THE RESOLUTION: the tenant's own workspace, or Inflect's, or the named
 * reason there is none. Never throws a refusal; a database error propagates.
 */
export async function resolveManagedAgentsWorkspace(ctx: RequestContext): Promise<WorkspaceResolution> {
    const own = await readWorkspaceConnection(ctx);
    if (own.ok) return { ok: true, workspace: { ...own.connection, kind: 'TENANT' } };
    // A connection that exists but cannot be used is the customer's to fix;
    // falling back to Inflect's workspace would move their data somewhere
    // they did not choose.
    if (own.reason !== 'NO_CONNECTION') return { ok: false, reason: own.reason };
    return resolveHostedWorkspace(ctx);
}

/**
 * Whether the tenant has a workspace a run could use, WITHOUT reading any key:
 * `CONNECTED` (its own, one), `AMBIGUOUS` (its own, more than one), `HOSTED`
 * (none of its own, and every hosted term holds) or `NONE`. `hostedRefusal`
 * names the hosted term that failed when the answer is `NONE`. The same rules
 * as `resolveManagedAgentsWorkspace`, so a settings page and a run cannot
 * disagree.
 */
export type ManagedAgentsWorkspaceState = 'CONNECTED' | 'AMBIGUOUS' | 'HOSTED' | 'NONE';

export async function readManagedAgentsWorkspaceState(
    ctx: RequestContext,
): Promise<{ state: ManagedAgentsWorkspaceState; hostedRefusal: HostedWorkspaceRefusal | null }> {
    const own = await runInTenantContext(ctx, (db) => readWorkspaceConnectionState(db, ctx.tenantId));
    if (own !== 'NONE') return { state: own, hostedRefusal: null };
    const deployment = inflectHostedWorkspace();
    if (!deployment.ok) return { state: 'NONE', hostedRefusal: deployment.reason };
    const refusal = hostedTermsRefusal(await readHostedTenantTerms(ctx));
    return refusal ? { state: 'NONE', hostedRefusal: refusal } : { state: 'HOSTED', hostedRefusal: null };
}
