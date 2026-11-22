/**
 * THE MANAGED AGENTS ENGINE'S READS AND ITS ONE WRITE (Step 5b of
 * `docs/claude-managed-agents-design.md`, #4165).
 *
 * The engine's loop holds no Prisma call (global rule 2 of the roadmap in
 * `docs/claude-agent-sdk-design.md`); what it needs from the database comes
 * from here, every read and write inside the caller's tenant context, so RLS
 * binds each one to the run's own tenant:
 *
 *   readWorkspaceConnection   the tenant's ONE enabled `anthropic-workspace`
 *                             connection, its key decrypted and its config
 *                             read. None, or more than one, is a refusal by
 *                             name: a run never chooses between workspaces.
 *   readProvision             what was provisioned for one version in one
 *                             workspace.
 *   readProfileAgent          the profile's agent in a workspace, for the next
 *                             version's update.
 *   readConnectionEnvironment the environment already made for a connection.
 *   recordProvision           the ONE writer of `AgentProfileProvision`.
 *
 * The decrypted key leaves this module only as a field of the returned
 * connection, which the driver hands to `managedAgentsClientFor` and drops.
 * It is never logged and never stored anywhere else.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { decryptField } from '@/lib/security/encryption';

/** The provider id of the customer's workspace connection (Step 5a). */
export const ANTHROPIC_WORKSPACE_PROVIDER = 'anthropic-workspace';

/** The run's workspace, as the engine uses it. */
export interface WorkspaceConnection {
    readonly connectionId: string;
    readonly workspaceId: string;
    /** Decision 4: keep sessions in the customer's workspace after the run. Off unless the config says `true`. */
    readonly keepSessions: boolean;
    /** Decrypted. Handed to the client and nowhere else. */
    readonly apiKey: string;
}

/** Why a run has no workspace to run in. */
export type WorkspaceConnectionRefusal =
    | 'NO_CONNECTION'
    | 'AMBIGUOUS_CONNECTION'
    | 'CONNECTION_UNREADABLE';

export async function readWorkspaceConnection(
    ctx: RequestContext,
): Promise<{ ok: true; connection: WorkspaceConnection } | { ok: false; reason: WorkspaceConnectionRefusal }> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider: ANTHROPIC_WORKSPACE_PROVIDER, isEnabled: true },
            select: { id: true, configJson: true, secretEncrypted: true },
            // One past the answer, so "more than one" is a fact held rather than inferred.
            take: 2,
            orderBy: { id: 'asc' },
        }),
    );
    if (rows.length === 0) return { ok: false, reason: 'NO_CONNECTION' };
    if (rows.length > 1) return { ok: false, reason: 'AMBIGUOUS_CONNECTION' };
    const row = rows[0];
    const config = (row.configJson ?? {}) as Record<string, unknown>;
    const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId.trim() : '';
    let apiKey = '';
    try {
        const secrets: unknown = row.secretEncrypted ? JSON.parse(decryptField(row.secretEncrypted)) : null;
        const value = (secrets as { apiKey?: unknown } | null)?.apiKey;
        apiKey = typeof value === 'string' ? value.trim() : '';
    } catch {
        return { ok: false, reason: 'CONNECTION_UNREADABLE' };
    }
    if (!workspaceId || !apiKey) return { ok: false, reason: 'CONNECTION_UNREADABLE' };
    return {
        ok: true,
        connection: {
            connectionId: row.id,
            workspaceId,
            // Strictly `true`: an absent, malformed or string value deletes, the default.
            keepSessions: config.keepSessions === true,
            apiKey,
        },
    };
}

/** One provision row, as the engine reads it. */
export interface ProvisionRecord {
    readonly profileId: string;
    readonly profileVersionId: string;
    readonly connectionId: string;
    readonly anthropicAgentId: string;
    readonly anthropicAgentVersion: number;
    readonly environmentId: string;
    readonly systemHash: string;
    readonly toolsHash: string;
}

const PROVISION_SELECT = {
    profileId: true,
    profileVersionId: true,
    connectionId: true,
    anthropicAgentId: true,
    anthropicAgentVersion: true,
    environmentId: true,
    systemHash: true,
    toolsHash: true,
} as const;

export async function readProvision(
    ctx: RequestContext,
    profileVersionId: string,
    connectionId: string,
): Promise<ProvisionRecord | null> {
    return runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.findFirst({
            where: { tenantId: ctx.tenantId, profileVersionId, connectionId },
            select: PROVISION_SELECT,
        }),
    );
}

/** The profile's agent in this workspace, from its latest provision, or null before the first. */
export async function readProfileAgent(
    ctx: RequestContext,
    profileId: string,
    connectionId: string,
): Promise<{ anthropicAgentId: string; anthropicAgentVersion: number } | null> {
    return runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.findFirst({
            where: { tenantId: ctx.tenantId, profileId, connectionId },
            orderBy: [{ anthropicAgentVersion: 'desc' }, { createdAt: 'desc' }],
            select: { anthropicAgentId: true, anthropicAgentVersion: true },
        }),
    );
}

/** The environment already made for a connection, or null before the first provision. */
export async function readConnectionEnvironment(ctx: RequestContext, connectionId: string): Promise<string | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.findFirst({
            where: { tenantId: ctx.tenantId, connectionId },
            orderBy: { createdAt: 'asc' },
            select: { environmentId: true },
        }),
    );
    return row?.environmentId ?? null;
}

/** THE ONE WRITER of `AgentProfileProvision`. */
export async function recordProvision(ctx: RequestContext, record: ProvisionRecord): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.create({ data: { tenantId: ctx.tenantId, ...record } }),
    );
}
