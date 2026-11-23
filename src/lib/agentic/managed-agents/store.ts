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
 *                             workspace, and whether a removal of that
 *                             connection has since archived its agent.
 *   readProfileAgent          the profile's live agent in a workspace, for the
 *                             next version's update.
 *   readConnectionEnvironment the environment already made for a connection,
 *                             and the hash its provision recorded.
 *   readRecordedSessionIds    the sessions this run's ledger already names
 *                             (#5854), so a segment's start settles only the
 *                             ones a dead segment never recorded.
 *   recordProvision           the ONE writer of `AgentProfileProvision`.
 *   recordEnvironmentHashOnFirstUse
 *                             fills a NULL `environmentHash` once (#5854):
 *                             a row written before the column existed. It
 *                             writes that column only, and only while NULL.
 *
 * The decrypted key leaves this module only as a field of the returned
 * connection, which the driver hands to `managedAgentsClientFor` and drops.
 * It is never logged and never stored anywhere else.
 */
import type { Prisma } from '@prisma/client';

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

/**
 * Whether the tenant has a workspace a run could use: exactly ONE enabled
 * `anthropic-workspace` connection (`CONNECTED`), none, or more than one
 * (Step 5d). The same rows `readWorkspaceConnection` reads, and the same "one
 * past the answer", without decrypting anything: the engine setting asks this
 * before it lets a workspace choose the engine, and needs no key to ask it.
 */
export type WorkspaceConnectionState = 'CONNECTED' | 'NONE' | 'AMBIGUOUS';

/**
 * Takes the caller's tenant-bound client rather than opening its own context,
 * so the engine setting reads it inside the context it already holds.
 */
export async function readWorkspaceConnectionState(
    db: Pick<Prisma.TransactionClient, 'integrationConnection'>,
    tenantId: string,
): Promise<WorkspaceConnectionState> {
    const rows = await db.integrationConnection.findMany({
        where: { tenantId, provider: ANTHROPIC_WORKSPACE_PROVIDER, isEnabled: true },
        select: { id: true },
        take: 2,
    });
    if (rows.length === 0) return 'NONE';
    return rows.length > 1 ? 'AMBIGUOUS' : 'CONNECTED';
}

/**
 * WHEN A REMOVAL OF THIS CONNECTION ARCHIVED WHAT IT HAD (Step 5d, #4167).
 *
 * Removing an `anthropic-workspace` connection disables the row and opens a
 * `CONNECTION_REMOVED` clean-up (Step 5c) that archives every agent recorded in
 * `AgentProfileProvision` at or before its `coversUntil`. The provision rows
 * stay. Re-enabling the same row (the card's Enable) therefore leaves rows that
 * name ARCHIVED agents, which can start no session.
 *
 * So a provision is STALE when a removal of its connection covers it: a
 * `CONNECTION_REMOVED` record whose `coversUntil` is at or after the
 * provision's `createdAt`. The latest such instant is returned, or null when
 * the connection was never removed. It is the clean-up's own scope rule, read
 * from its own record, so "archived" here and "archived" there cannot disagree.
 * Whether the clean-up has finished does not matter: once it is opened, the
 * agent is on its way out, and a run must not race it.
 */
async function connectionRemovedUntil(ctx: RequestContext, connectionId: string): Promise<Date | null> {
    const removal = await runInTenantContext(ctx, (db) =>
        db.managedAgentsCleanup.findFirst({
            where: { tenantId: ctx.tenantId, connectionId, trigger: 'CONNECTION_REMOVED' },
            orderBy: { coversUntil: 'desc' },
            select: { coversUntil: true },
        }),
    );
    return removal?.coversUntil ?? null;
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
    /**
     * The environment's configuration as Inflect wrote it (#5854), or null when
     * the row predates the column: "not recorded", recorded at first use.
     */
    readonly environmentHash: string | null;
}

/**
 * A provision as a run reads it: the record, and whether a removal of its
 * connection has archived its agent since it was written (Step 5d). An
 * archived provision is never run and never updated; the next approval of a
 * version writes a new agent instead.
 */
export interface ReadProvision extends ProvisionRecord {
    readonly archived: boolean;
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
    environmentHash: true,
} as const;

export async function readProvision(
    ctx: RequestContext,
    profileVersionId: string,
    connectionId: string,
): Promise<ReadProvision | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.findFirst({
            where: { tenantId: ctx.tenantId, profileVersionId, connectionId },
            select: { ...PROVISION_SELECT, createdAt: true },
        }),
    );
    if (!row) return null;
    const { createdAt, ...record } = row;
    const removedUntil = await connectionRemovedUntil(ctx, connectionId);
    return { ...record, archived: removedUntil !== null && createdAt <= removedUntil };
}

/** The profile's agent as its latest provision recorded it: the next version's update starts here. */
export interface ProfileAgentRecord {
    readonly anthropicAgentId: string;
    readonly anthropicAgentVersion: number;
    /** What Inflect wrote at that version, which the next provisioning compares (#5854). */
    readonly systemHash: string;
    readonly toolsHash: string;
}

/**
 * The profile's LIVE agent in this workspace, from its latest provision that no
 * removal of the connection has archived, or null before the first or after a
 * removal (Step 5d): an archived agent cannot be updated, so the next version
 * creates a new one.
 *
 * LATEST BY WHEN IT WAS RECORDED, never by agent version (#5854). A profile's
 * agent can be REPLACED by a new one, whose versions start again at 1, when the
 * old one was edited or archived in the Console (`provisionManagedAgent`); the
 * old agent's higher version number must not make it the one updated next.
 */
export async function readProfileAgent(
    ctx: RequestContext,
    profileId: string,
    connectionId: string,
): Promise<ProfileAgentRecord | null> {
    const removedUntil = await connectionRemovedUntil(ctx, connectionId);
    return runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.findFirst({
            where: {
                tenantId: ctx.tenantId,
                profileId,
                connectionId,
                ...(removedUntil ? { createdAt: { gt: removedUntil } } : {}),
            },
            orderBy: [{ createdAt: 'desc' }, { anthropicAgentVersion: 'desc' }],
            select: { anthropicAgentId: true, anthropicAgentVersion: true, systemHash: true, toolsHash: true },
        }),
    );
}

/**
 * The environment already made for a connection, with the hash its first
 * provision recorded (null when that row predates the column), or null before
 * the first provision.
 */
export async function readConnectionEnvironment(
    ctx: RequestContext,
    connectionId: string,
): Promise<{ environmentId: string; environmentHash: string | null } | null> {
    return runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.findFirst({
            where: { tenantId: ctx.tenantId, connectionId },
            orderBy: { createdAt: 'asc' },
            select: { environmentId: true, environmentHash: true },
        }),
    );
}

/** How many ledger steps one read of a run's sessions takes; one more is read so a truncation is a fact held. */
export const RUN_SESSION_STEPS_READ_CAP = 500;

/**
 * THE SESSIONS THIS RUN'S LEDGER ALREADY NAMES (Step 5H, #5854): every session
 * id on one of its `managed-agents-session` steps, whatever the lifecycle. On
 * this engine every SYNTHESIS step of a run is a session step; the lifecycle
 * is inside the encrypted `inputJson`, so each is read and parsed. A run makes
 * one session per segment, so the read is small; `truncated` says when it was
 * not, and the caller then settles nothing rather than settle a session that
 * may be recorded past the cap.
 */
export async function readRecordedSessionIds(
    ctx: RequestContext,
    runId: string,
): Promise<{ sessionIds: ReadonlySet<string>; truncated: boolean }> {
    const steps = await runInTenantContext(ctx, (db) =>
        db.workflowStep.findMany({
            where: { tenantId: ctx.tenantId, runId, kind: 'SYNTHESIS' },
            select: { inputJson: true },
            orderBy: [{ seq: 'asc' }, { id: 'asc' }],
            take: RUN_SESSION_STEPS_READ_CAP + 1,
        }),
    );
    const sessionIds = new Set<string>();
    for (const step of steps.slice(0, RUN_SESSION_STEPS_READ_CAP)) {
        let input: unknown = null;
        try {
            input = step.inputJson ? JSON.parse(step.inputJson) : null;
        } catch {
            input = null;
        }
        const { lifecycle, sessionId } = (input ?? {}) as { lifecycle?: unknown; sessionId?: unknown };
        if (typeof lifecycle === 'string' && lifecycle.startsWith('SESSION_') && typeof sessionId === 'string') {
            sessionIds.add(sessionId);
        }
    }
    return { sessionIds, truncated: steps.length > RUN_SESSION_STEPS_READ_CAP };
}

/** THE ONE WRITER of `AgentProfileProvision`. */
export async function recordProvision(ctx: RequestContext, record: ProvisionRecord): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.create({ data: { tenantId: ctx.tenantId, ...record } }),
    );
}

/**
 * A provision written before `environmentHash` existed records it at its first
 * run (#5854). The run passes what Inflect WROTE (`writtenEnvironmentHash`),
 * never the environment it read: a Console edit made before the first run must
 * not become the record it is compared with. Only a NULL is filled, so a
 * recorded hash is never moved.
 */
export async function recordEnvironmentHashOnFirstUse(
    ctx: RequestContext,
    profileVersionId: string,
    connectionId: string,
    environmentHash: string,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.agentProfileProvision.updateMany({
            where: { tenantId: ctx.tenantId, profileVersionId, connectionId, environmentHash: null },
            data: { environmentHash },
        }),
    );
}
