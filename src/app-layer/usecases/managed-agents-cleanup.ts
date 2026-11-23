/**
 * PURGE, CONNECTION REMOVAL AND DSAR REACH THE PROVIDER (Step 5c of
 * `docs/claude-managed-agents-design.md`, #4166).
 *
 * What Inflect created in a customer's Anthropic workspace — sessions and
 * agents — is removed by the ids Inflect recorded, on three triggers:
 *
 *   TENANT_PURGE        `cleanUpManagedAgentsBeforePurge`, called by the tenant
 *                       purge BEFORE any of the tenant's rows go: every session
 *                       Inflect recorded on each of the tenant's
 *                       `anthropic-workspace` connections (kept ones, and the
 *                       crash window) is deleted, and every agent in
 *                       `AgentProfileProvision` archived. ONE attempt, under a
 *                       bounded deadline. Owner decision 7: Inflect never keeps
 *                       the customer's key past the purge, so this is never
 *                       retried. What it could not finish is written, ids only,
 *                       to a retained `ManagedAgentsCleanup` row in the terminal
 *                       `PURGED_KEY_DESTROYED_UNFINISHED`, with an alert and a
 *                       metric, for a person to finish in the workspace.
 *   CONNECTION_REMOVED  `openConnectionRemovalCleanup`, after the connection is
 *                       disabled. The row (and its key) stays, so the clean-up
 *                       is retried by the data-lifecycle job until it is done.
 *   DSAR_ERASURE        `openDsarErasureCleanups`, after an erasure commits:
 *                       every KEPT session in every tenant where the person
 *                       held a membership. Agents are not touched: an archived
 *                       agent holds only Inflect's preamble and tool schemas.
 *
 * A retried record that cannot finish within `CLEANUP_ABANDON_AFTER_DAYS` ends
 * `ABANDONED`, with an alert, so it does not live for ever (an implementation
 * decision of Step 5c, not an owner decision).
 *
 * Beside the triggers, the data-lifecycle job runs ONE periodic
 * reconciliation (`reconcileLostSessionDeletes`) over every live tenant's
 * workspace connections. It retries a session whose latest ledger step is
 * `SESSION_DELETE_FAILED` (#5843), recording `SESSION_DELETED` on the run's
 * ledger when it goes, and reads back a session recorded DELETED in the last
 * week (a lost delete). A KEPT session is never touched by it.
 *
 * ── WHAT "RECORDED" MEANS ───────────────────────────────────────────────────
 *
 * Sessions come from the `managed-agents-session` SYNTHESIS steps 5b writes
 * (`SessionLifecycle`): a session is still Inflect's to delete when it was
 * CREATED and never DELETED, or KEPT, or its delete FAILED. A DSAR erasure
 * takes the KEPT ones only. Agents come from `AgentProfileProvision`. Nothing
 * here lists the customer's workspace: the crash window is listed by recorded
 * agent only (`managed-agents/cleanup.ts`).
 *
 * ── ORDER OF THE DATABASE AND THE NETWORK ───────────────────────────────────
 *
 * Every read and write is its own short tenant-bound transaction
 * (`runInTenantJobContext`), never held around a provider call. The decrypted
 * key lives in a local for one pass, goes to `managedAgentsClientFor`, and is
 * never written anywhere.
 */
import { buildSystemContext } from '@/app-layer/context-system';
import type { RequestContext } from '@/app-layer/types';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import {
    deleteSession,
    isDoneOutcome,
    runCleanupPass,
    type CleanupItemOutcome,
    type CleanupPassResult,
    type CleanupPlan,
} from '@/lib/agentic/managed-agents/cleanup';
// The steps are 5b's `managed-agents-session` SYNTHESIS steps. That label is
// not a column, so a step is known by its kind and the lifecycle in its input.
import { sessionStepRecord, type SessionLifecycle } from '@/lib/agentic/managed-agents/session-ledger';
import { ANTHROPIC_WORKSPACE_PROVIDER } from '@/lib/agentic/managed-agents/store';
import { managedAgentsClientFor } from '@/lib/agentic/tool-runner/client';
import { runInGlobalContext, runInTenantJobContext } from '@/lib/db-context';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import {
    recordManagedAgentsCleanup,
    recordManagedAgentsFailedDeleteRetry,
    recordManagedAgentsLostDelete,
} from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';

/** The job name every write here is attributed to. */
export const CLEANUP_SOURCE = 'managed-agents-cleanup';

export type CleanupTrigger = 'TENANT_PURGE' | 'CONNECTION_REMOVED' | 'DSAR_ERASURE';
export type CleanupStatus = 'OPEN' | 'DONE' | 'ABANDONED' | 'PURGED_KEY_DESTROYED_UNFINISHED' | 'SUPERSEDED_BY_PURGE';

/** Why a record is not done, beyond the per-item outcomes of a pass. */
export type CleanupReason =
    | CleanupItemOutcome
    /** The connection's key cannot be decrypted, or is empty. */
    | 'CONNECTION_UNREADABLE'
    /** The connection row is gone: nothing can open the workspace. */
    | 'CONNECTION_GONE'
    /** `ANTHROPIC_CUSTOM_HEADERS` is set, so no client is built. */
    | 'SDK_AMBIENT_HEADERS_SET'
    /** The ledger held more steps than one read takes: some sessions are unknown. */
    | 'LEDGER_TRUNCATED'
    /** The ledger and the provisions held nothing for the connection. Done, and said so. */
    | 'NOTHING_RECORDED'
    /** The clean-up itself threw. */
    | 'CLEANUP_FAILED';

/** A retried record still not done this many days after it opened ends ABANDONED. */
export const CLEANUP_ABANDON_AFTER_DAYS = 30;
/** The purge waits on the provider at most this long per tenant. */
export const PURGE_CLEANUP_DEADLINE_MS = 60_000;
/** One retry pass of one record waits at most this long. */
export const RETRY_CLEANUP_DEADLINE_MS = 60_000;
/** Steps one ledger read takes; one more is read so a truncation is a fact held. */
export const LEDGER_READ_CAP = 10_000;
/** OPEN records one data-lifecycle run retries. */
export const RETRY_BATCH = 200;
/** The reconciliation looks this far back for sessions recorded DELETED. */
export const RECONCILE_LOOKBACK_DAYS = 7;
/**
 * The failed-delete retry reads at most this many of a tenant's newest
 * `SESSION_DELETE_FAILED` steps per pass (one per run). Not a lookback: a
 * failed delete is retried however old it is, while it is among these.
 */
export const FAILED_DELETE_READ_CAP = 1_000;
/** Sessions whose delete failed that one pass retries per tenant, oldest first. */
export const FAILED_DELETE_RETRY_BATCH = 100;

const DAY_MS = 86_400_000;

// ─── Reads ──────────────────────────────────────────────────────────────────

/** One `anthropic-workspace` connection as the clean-up reads it: enabled OR disabled. */
interface CleanupConnection {
    readonly connectionId: string;
    readonly workspaceId: string;
    /** Decrypted; null when it cannot be read. */
    readonly apiKey: string | null;
}

function connectionFromRow(row: { id: string; configJson: unknown; secretEncrypted: string | null }): CleanupConnection {
    const config = (row.configJson ?? {}) as Record<string, unknown>;
    const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId.trim() : '';
    let apiKey: string | null = null;
    try {
        const secrets: unknown = row.secretEncrypted ? JSON.parse(decryptField(row.secretEncrypted)) : null;
        const value = (secrets as { apiKey?: unknown } | null)?.apiKey;
        apiKey = typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
        apiKey = null;
    }
    return { connectionId: row.id, workspaceId, apiKey };
}

/**
 * THE DEDICATED READER of a connection for the clean-up. Unlike the engine's
 * `readWorkspaceConnection` it reads a DISABLED row too: removing a connection
 * disables it, and that row's key is what the retry authenticates with.
 */
async function readCleanupConnections(tenantId: string, connectionId?: string): Promise<CleanupConnection[]> {
    const rows = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId, provider: ANTHROPIC_WORKSPACE_PROVIDER, ...(connectionId ? { id: connectionId } : {}) },
            select: { id: true, configJson: true, secretEncrypted: true },
            orderBy: { id: 'asc' },
            take: 50,
        }),
    );
    return rows.map(connectionFromRow);
}

/**
 * Does this tenant have anything here at all: an `anthropic-workspace`
 * connection, a provision, or a clean-up record? Read OUTSIDE the tenant
 * context, on purpose: opening a tenant context resolves the tenant's DEK,
 * which for a legacy tenant without one mints it (a Tenant write and an audit
 * row), and the purge and the erasure call this for every tenant they touch.
 * Ids only, no encrypted column, so the global client reads it as it is.
 */
async function hasManagedAgentsFootprint(tenantId: string): Promise<boolean> {
    return runInGlobalContext(async (db) => {
        const [connection, provision, record] = await Promise.all([
            db.integrationConnection.findFirst({ where: { tenantId, provider: ANTHROPIC_WORKSPACE_PROVIDER }, select: { id: true } }),
            db.agentProfileProvision.findFirst({ where: { tenantId }, select: { id: true } }),
            db.managedAgentsCleanup.findFirst({ where: { tenantId, status: 'OPEN' }, select: { id: true } }),
        ]);
        return Boolean(connection || provision || record);
    });
}

/** One session's recorded lifecycle, from the ledger. */
interface LedgerSession {
    readonly sessionId: string;
    readonly connectionId: string;
    readonly runId: string;
    readonly lifecycles: Set<SessionLifecycle>;
    /** The lifecycle of the session's most recent step. */
    latest: SessionLifecycle;
    /** When the last DELETED step was recorded, for the reconciliation. */
    deletedAt: Date | null;
}

/**
 * Every session the ledger records for a tenant's Managed Agents runs, by id.
 * Runs created after `runsCreatedBy` are left out, so a clean-up covers what
 * was recorded when it opened. `since` narrows to steps recorded after it, and
 * `runIds` to those runs.
 */
async function readLedgerSessions(
    tenantId: string,
    options: { runsCreatedBy?: Date; since?: Date; runIds?: readonly string[] } = {},
): Promise<{ sessions: Map<string, LedgerSession>; truncated: boolean }> {
    const steps = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
        db.workflowStep.findMany({
            where: {
                tenantId,
                kind: 'SYNTHESIS',
                ...(options.since ? { at: { gte: options.since } } : {}),
                ...(options.runIds ? { runId: { in: [...options.runIds] } } : {}),
                run: {
                    is: {
                        driver: 'MANAGED_AGENTS',
                        ...(options.runsCreatedBy ? { createdAt: { lte: options.runsCreatedBy } } : {}),
                    },
                },
            },
            select: { runId: true, inputJson: true, at: true },
            orderBy: [{ at: 'asc' }, { id: 'asc' }],
            take: LEDGER_READ_CAP + 1,
        }),
    );
    const truncated = steps.length > LEDGER_READ_CAP;
    const sessions = new Map<string, LedgerSession>();
    for (const step of steps.slice(0, LEDGER_READ_CAP)) {
        let input: Record<string, unknown> | null = null;
        try {
            const parsed: unknown = step.inputJson ? JSON.parse(step.inputJson) : null;
            input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
            input = null;
        }
        const lifecycle = input?.lifecycle;
        const sessionId = input?.sessionId;
        const connectionId = input?.connectionId;
        if (
            typeof lifecycle !== 'string' || !lifecycle.startsWith('SESSION_') ||
            typeof sessionId !== 'string' || typeof connectionId !== 'string'
        ) continue;
        const entry = sessions.get(sessionId) ?? {
            sessionId, connectionId, runId: step.runId, lifecycles: new Set<SessionLifecycle>(),
            latest: lifecycle as SessionLifecycle, deletedAt: null,
        };
        entry.lifecycles.add(lifecycle as SessionLifecycle);
        // Steps are read oldest first, so the last one seen is the latest.
        entry.latest = lifecycle as SessionLifecycle;
        if (lifecycle === 'SESSION_DELETED') entry.deletedAt = step.at;
        sessions.set(sessionId, entry);
    }
    return { sessions, truncated };
}

/**
 * Is this session still Inflect's to delete? CREATED with no DELETED, or KEPT,
 * or DELETE_FAILED. `keptOnly` (a DSAR erasure) takes the KEPT ones alone.
 */
export function sessionIsPending(lifecycles: ReadonlySet<string>, keptOnly: boolean): boolean {
    if (keptOnly) return lifecycles.has('SESSION_KEPT');
    if (lifecycles.has('SESSION_KEPT') || lifecycles.has('SESSION_DELETE_FAILED')) return true;
    return lifecycles.has('SESSION_CREATED') && !lifecycles.has('SESSION_DELETED');
}

/**
 * Is this session one the failed-delete retry takes? Its LATEST step is
 * DELETE_FAILED, so no later pass has deleted it, and it was never KEPT: a
 * kept session is the customer's choice (decision 4) and only a purge, a
 * connection removal or an erasure deletes it.
 */
export function awaitsDeleteRetry(session: { readonly latest: string; readonly lifecycles: ReadonlySet<string> }): boolean {
    return session.latest === 'SESSION_DELETE_FAILED' && !session.lifecycles.has('SESSION_KEPT');
}

/**
 * The sessions of a tenant whose latest step is DELETE_FAILED. Found in two
 * reads, because the lifecycle is inside the ENCRYPTED `inputJson`: first the
 * newest FAILED session steps by their plaintext status (on a Managed Agents
 * run a SYNTHESIS step is a session step, and only DELETE_FAILED is FAILED),
 * then every session step of those runs, to learn which are still the latest.
 */
async function readFailedDeletes(tenantId: string): Promise<{ sessions: LedgerSession[]; truncated: boolean }> {
    const failed = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
        db.workflowStep.findMany({
            where: { tenantId, kind: 'SYNTHESIS', status: 'FAILED', run: { is: { driver: 'MANAGED_AGENTS' } } },
            select: { runId: true },
            orderBy: [{ at: 'desc' }, { id: 'desc' }],
            take: FAILED_DELETE_READ_CAP + 1,
        }),
    );
    const truncated = failed.length > FAILED_DELETE_READ_CAP;
    const runIds = [...new Set(failed.slice(0, FAILED_DELETE_READ_CAP).map((s) => s.runId))];
    if (runIds.length === 0) return { sessions: [], truncated };
    const { sessions } = await readLedgerSessions(tenantId, { runIds });
    return { sessions: [...sessions.values()].filter(awaitsDeleteRetry), truncated };
}

async function readRecordedAgents(tenantId: string, coversUntil?: Date): Promise<Array<{ connectionId: string; agentId: string }>> {
    const rows = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
        db.agentProfileProvision.findMany({
            where: { tenantId, ...(coversUntil ? { createdAt: { lte: coversUntil } } : {}) },
            select: { connectionId: true, anthropicAgentId: true },
            orderBy: { createdAt: 'asc' },
            // guardrail-allow: unbounded — reason: every recorded agent must be archived; one row per approved profile version per workspace.
            take: 5_000,
        }),
    );
    const seen = new Set<string>();
    const out: Array<{ connectionId: string; agentId: string }> = [];
    for (const r of rows) {
        const key = `${r.connectionId}\u0000${r.anthropicAgentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ connectionId: r.connectionId, agentId: r.anthropicAgentId });
    }
    return out;
}

/** Of these run ids, the ones this tenant holds. The crash window's second half. */
async function readRunsHeld(tenantId: string, runIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (runIds.length === 0) return new Set();
    const rows = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
        db.workflowRun.findMany({ where: { tenantId, id: { in: [...runIds] } }, select: { id: true }, take: runIds.length }),
    );
    return new Set(rows.map((r) => r.id));
}

// ─── One pass ───────────────────────────────────────────────────────────────

type PassOutcome =
    | { readonly kind: 'pass'; readonly result: CleanupPassResult }
    | { readonly kind: 'refused'; readonly reason: CleanupReason };

/** One pass with the connection's key, under a deadline. Never throws. */
async function passWithKey(
    tenantId: string,
    connection: CleanupConnection,
    plan: CleanupPlan,
    signal: AbortSignal,
): Promise<PassOutcome> {
    if (!connection.apiKey || !connection.workspaceId) return { kind: 'refused', reason: 'CONNECTION_UNREADABLE' };
    const choice = managedAgentsClientFor({ apiKey: connection.apiKey, workspaceId: connection.workspaceId });
    if (!choice.ok) {
        return { kind: 'refused', reason: choice.reason === 'SDK_AMBIENT_HEADERS_SET' ? 'SDK_AMBIENT_HEADERS_SET' : 'CONNECTION_UNREADABLE' };
    }
    try {
        const result = await runCleanupPass(choice.client, plan, {
            signal,
            runsHeld: (runIds) => readRunsHeld(tenantId, runIds),
        });
        return { kind: 'pass', result };
    } catch {
        return { kind: 'refused', reason: 'CLEANUP_FAILED' };
    }
}

const EMPTY_PASS: CleanupPassResult = {
    deletedSessionIds: [],
    archivedAgentIds: [],
    crashWindowSessionIds: [],
    remaining: {},
    remainingSessionIds: [],
    remainingAgentIds: [],
    reason: null,
};

/**
 * A pass for a plan: nothing to remove needs no key and sends nothing (the
 * crash window is listed only by a recorded agent, so a plan with no agent has
 * no crash window); a connection row that is gone is `CONNECTION_GONE`.
 */
async function passFor(
    tenantId: string,
    connection: CleanupConnection | null,
    plan: CleanupPlan,
    signal: AbortSignal,
): Promise<PassOutcome> {
    if (plan.sessionIds.length === 0 && plan.agentIds.length === 0 && plan.listAgentIds.length === 0) {
        return { kind: 'pass', result: EMPTY_PASS };
    }
    if (!connection) return { kind: 'refused', reason: 'CONNECTION_GONE' };
    return passWithKey(tenantId, connection, plan, signal);
}

function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    timer.unref?.();
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function alertUnfinished(record: { id: string; tenantId: string; trigger: CleanupTrigger; status: CleanupStatus; reason: string | null; sessions: number; agents: number }): void {
    // An operator alert: the Grafana rule on `agentic.managed_agents.cleanup`
    // fires on these statuses, and this line is what the person reads.
    logger.error('managed-agents: the remote clean-up did not finish', {
        component: 'managed-agents-cleanup',
        cleanupId: record.id,
        tenantId: record.tenantId,
        trigger: record.trigger,
        status: record.status,
        reason: record.reason,
        sessionsLeft: record.sessions,
        agentsLeft: record.agents,
    });
}

function settle(
    trigger: CleanupTrigger,
    status: CleanupStatus,
    reason: string | null,
): void {
    recordManagedAgentsCleanup({ trigger, status, reason: reason ?? 'NONE' });
}

// ─── Trigger 1: the tenant purge ────────────────────────────────────────────

export interface PurgeCleanupSummary {
    /** One per connection the tenant recorded anything for. */
    readonly records: ReadonlyArray<{ readonly id: string; readonly connectionId: string; readonly status: CleanupStatus; readonly reason: string | null }>;
}

/**
 * THE PURGE'S ONE ATTEMPT. Called by `purgeSoftDeletedTenants` for a tenant
 * BEFORE its rows are deleted, so the key, the ledger and the provisions can
 * still be read. Never throws and never waits past `deadlineMs`: the purge
 * goes on whatever happens here.
 */
export async function cleanUpManagedAgentsBeforePurge(
    tenantId: string,
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<PurgeCleanupSummary> {
    const now = options.now ?? new Date();
    const timer = deadline(options.deadlineMs ?? PURGE_CLEANUP_DEADLINE_MS);
    const records: Array<{ id: string; connectionId: string; status: CleanupStatus; reason: string | null }> = [];
    try {
        if (!(await hasManagedAgentsFootprint(tenantId))) return { records };
        const [connections, ledger, agents, openRecords] = await Promise.all([
            readCleanupConnections(tenantId),
            readLedgerSessions(tenantId),
            readRecordedAgents(tenantId),
            runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
                db.managedAgentsCleanup.findMany({
                    where: { tenantId },
                    select: { id: true, connectionId: true, status: true, pendingSessionIds: true, deletedSessionIds: true, archivedAgentIds: true },
                    orderBy: { createdAt: 'asc' },
                    take: 1_000,
                }),
            ),
        ]);

        // Every connection anything was recorded for: a row, a provision, a
        // session, or an open clean-up. A recorded id whose connection row is
        // gone cannot be reached, and is reported, never dropped.
        const connectionIds = new Set<string>([
            ...connections.map((c) => c.connectionId),
            ...agents.map((a) => a.connectionId),
            ...[...ledger.sessions.values()].map((s) => s.connectionId),
            ...openRecords.filter((r) => r.status === 'OPEN').map((r) => r.connectionId),
        ]);
        const doneSessions = new Set(openRecords.flatMap((r) => r.deletedSessionIds));
        const doneAgents = new Set(openRecords.flatMap((r) => r.archivedAgentIds));

        for (const connectionId of [...connectionIds].sort()) {
            const connection = connections.find((c) => c.connectionId === connectionId) ?? null;
            const sessionIds = new Set<string>();
            for (const s of ledger.sessions.values()) {
                if (s.connectionId === connectionId && sessionIsPending(s.lifecycles, false) && !doneSessions.has(s.sessionId)) sessionIds.add(s.sessionId);
            }
            // What earlier records found and could not finish (the crash
            // window included): an open removal or erasure, or an earlier
            // purge attempt whose transaction then failed.
            for (const r of openRecords) {
                if (r.connectionId === connectionId) for (const id of r.pendingSessionIds) if (!doneSessions.has(id)) sessionIds.add(id);
            }
            const agentIds = agents.filter((a) => a.connectionId === connectionId && !doneAgents.has(a.agentId)).map((a) => a.agentId);
            const plan: CleanupPlan = { tenantId, sessionIds: [...sessionIds], agentIds, listAgentIds: agentIds };

            let pass: PassOutcome;
            try {
                pass = await passFor(tenantId, connection, plan, timer.signal);
            } catch {
                // Still a record, naming everything the plan held.
                pass = { kind: 'refused', reason: 'CLEANUP_FAILED' };
            }
            const deleted = pass.kind === 'pass' ? pass.result.deletedSessionIds : [];
            const archived = pass.kind === 'pass' ? pass.result.archivedAgentIds : [];
            const pendingSessionIds = pass.kind === 'pass' ? pass.result.remainingSessionIds : plan.sessionIds.slice();
            const pendingAgentIds = pass.kind === 'pass' ? pass.result.remainingAgentIds : plan.agentIds.slice();
            const reason: string | null = pass.kind === 'pass'
                ? (pass.result.reason ?? (ledger.truncated ? 'LEDGER_TRUNCATED' : null))
                : pass.reason;
            const finished = reason === null && pendingSessionIds.length === 0 && pendingAgentIds.length === 0;
            const nothing = finished && deleted.length === 0 && archived.length === 0;
            const status: CleanupStatus = finished ? 'DONE' : 'PURGED_KEY_DESTROYED_UNFINISHED';
            const finalReason = finished ? (nothing ? 'NOTHING_RECORDED' : null) : (reason ?? 'CLEANUP_FAILED');
            const row = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
                db.managedAgentsCleanup.create({
                    data: {
                        tenantId,
                        trigger: 'TENANT_PURGE',
                        connectionId,
                        workspaceId: connection?.workspaceId ?? '',
                        status,
                        outcome: finalReason,
                        coversUntil: now,
                        pendingSessionIds,
                        pendingAgentIds,
                        deletedSessionIds: deleted,
                        archivedAgentIds: archived,
                        attempts: 1,
                        lastAttemptAt: new Date(),
                        closedAt: new Date(),
                    },
                    select: { id: true },
                }),
            );
            records.push({ id: row.id, connectionId, status, reason: finalReason });
            settle('TENANT_PURGE', status, finalReason);
            if (!finished) {
                alertUnfinished({ id: row.id, tenantId, trigger: 'TENANT_PURGE', status, reason: finalReason, sessions: pendingSessionIds.length, agents: pendingAgentIds.length });
            }
        }

        // The open records of removed connections and erasures cannot be
        // retried once the purge has taken their keys: the purge's own
        // records above now carry what they had left.
        const open = openRecords.filter((r) => r.status === 'OPEN').map((r) => r.id);
        if (open.length > 0) {
            await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
                db.managedAgentsCleanup.updateMany({
                    where: { tenantId, id: { in: open }, status: 'OPEN' },
                    data: { status: 'SUPERSEDED_BY_PURGE', closedAt: new Date() },
                }),
            );
        }
    } catch (err) {
        logger.error('managed-agents: the purge\'s remote clean-up failed before it could record its outcome', {
            component: 'managed-agents-cleanup',
            tenantId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
        settle('TENANT_PURGE', 'PURGED_KEY_DESTROYED_UNFINISHED', 'CLEANUP_FAILED');
    } finally {
        timer.clear();
    }
    return { records };
}

// ─── Triggers 2 and 3: retried records ──────────────────────────────────────

interface OpenRecord {
    readonly id: string;
    readonly tenantId: string;
    readonly trigger: string;
    readonly connectionId: string;
    readonly coversUntil: Date;
    readonly createdAt: Date;
    readonly pendingSessionIds: string[];
    readonly deletedSessionIds: string[];
    readonly archivedAgentIds: string[];
}

const OPEN_RECORD_SELECT = {
    id: true,
    tenantId: true,
    trigger: true,
    connectionId: true,
    coversUntil: true,
    createdAt: true,
    pendingSessionIds: true,
    deletedSessionIds: true,
    archivedAgentIds: true,
} as const;

/**
 * One attempt at an OPEN record. Re-derives what is left from the ledger and
 * the provisions as of `coversUntil`, plus what earlier passes found, minus
 * what they removed, so a record never forgets a session and never deletes one
 * twice. Never throws.
 */
export async function attemptCleanupRecord(
    record: OpenRecord,
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<{ status: CleanupStatus; reason: string | null }> {
    const now = options.now ?? new Date();
    const trigger = record.trigger as CleanupTrigger;
    const keptOnly = trigger === 'DSAR_ERASURE';
    const timer = deadline(options.deadlineMs ?? RETRY_CLEANUP_DEADLINE_MS);
    try {
        const [connections, ledger, agents] = await Promise.all([
            readCleanupConnections(record.tenantId, record.connectionId),
            readLedgerSessions(record.tenantId, { runsCreatedBy: record.coversUntil }),
            keptOnly ? Promise.resolve([]) : readRecordedAgents(record.tenantId, record.coversUntil),
        ]);
        const deletedBefore = new Set(record.deletedSessionIds);
        const archivedBefore = new Set(record.archivedAgentIds);
        const sessionIds = new Set<string>();
        for (const s of ledger.sessions.values()) {
            if (s.connectionId === record.connectionId && sessionIsPending(s.lifecycles, keptOnly) && !deletedBefore.has(s.sessionId)) {
                sessionIds.add(s.sessionId);
            }
        }
        for (const id of record.pendingSessionIds) if (!deletedBefore.has(id)) sessionIds.add(id);
        const agentIds = agents.filter((a) => a.connectionId === record.connectionId && !archivedBefore.has(a.agentId)).map((a) => a.agentId);
        const plan: CleanupPlan = {
            tenantId: record.tenantId,
            sessionIds: [...sessionIds],
            agentIds,
            listAgentIds: agentIds,
            createdAtOrBefore: record.coversUntil,
        };

        const pass: PassOutcome = await passFor(record.tenantId, connections[0] ?? null, plan, timer.signal);
        const deleted = pass.kind === 'pass' ? pass.result.deletedSessionIds : [];
        const archived = pass.kind === 'pass' ? pass.result.archivedAgentIds : [];
        const pendingSessionIds = pass.kind === 'pass' ? pass.result.remainingSessionIds : plan.sessionIds.slice();
        const pendingAgentIds = pass.kind === 'pass' ? pass.result.remainingAgentIds : plan.agentIds.slice();
        const reason: string | null = pass.kind === 'pass'
            ? (pass.result.reason ?? (ledger.truncated ? 'LEDGER_TRUNCATED' : null))
            : pass.reason;
        const finished = reason === null && pendingSessionIds.length === 0 && pendingAgentIds.length === 0;
        const nothingEver = finished && deleted.length === 0 && archived.length === 0 && deletedBefore.size === 0 && archivedBefore.size === 0;
        const expired = now.getTime() - record.createdAt.getTime() >= CLEANUP_ABANDON_AFTER_DAYS * DAY_MS;
        // A connection row that is gone will not come back: nothing can open
        // the workspace, so waiting changes nothing.
        const status: CleanupStatus = finished ? 'DONE' : expired || reason === 'CONNECTION_GONE' ? 'ABANDONED' : 'OPEN';
        const finalReason = finished ? (nothingEver ? 'NOTHING_RECORDED' : null) : reason ?? 'CLEANUP_FAILED';
        const closedAt = status === 'OPEN' ? null : new Date();
        const written = await runInTenantJobContext({ tenantId: record.tenantId, source: CLEANUP_SOURCE }, (db) =>
            db.managedAgentsCleanup.updateMany({
                // Conditional on OPEN: a concurrent pass or the purge got there first.
                where: { id: record.id, tenantId: record.tenantId, status: 'OPEN' },
                data: {
                    status,
                    outcome: finalReason,
                    pendingSessionIds,
                    pendingAgentIds,
                    deletedSessionIds: [...deletedBefore, ...deleted],
                    archivedAgentIds: [...archivedBefore, ...archived],
                    attempts: { increment: 1 },
                    lastAttemptAt: new Date(),
                    closedAt,
                },
            }),
        );
        if (written.count === 1) {
            settle(trigger, status, finalReason);
            if (status === 'ABANDONED') {
                alertUnfinished({ id: record.id, tenantId: record.tenantId, trigger, status, reason: finalReason, sessions: pendingSessionIds.length, agents: pendingAgentIds.length });
            }
        }
        return { status, reason: finalReason };
    } catch (err) {
        logger.error('managed-agents: a clean-up attempt failed', {
            component: 'managed-agents-cleanup',
            cleanupId: record.id,
            tenantId: record.tenantId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
        settle(trigger, 'OPEN', 'CLEANUP_FAILED');
        return { status: 'OPEN', reason: 'CLEANUP_FAILED' };
    } finally {
        timer.clear();
    }
}

async function openRecord(
    tenantId: string,
    trigger: 'CONNECTION_REMOVED' | 'DSAR_ERASURE',
    connection: { connectionId: string; workspaceId: string },
    coversUntil: Date,
): Promise<OpenRecord> {
    return runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, async (db) => {
        // One OPEN record per connection and trigger: a second removal of the
        // same connection, or a second erasure, joins the open one.
        const existing = await db.managedAgentsCleanup.findFirst({
            where: { tenantId, connectionId: connection.connectionId, trigger, status: 'OPEN' },
            select: OPEN_RECORD_SELECT,
        });
        if (existing) return existing;
        return db.managedAgentsCleanup.create({
            data: {
                tenantId,
                trigger,
                connectionId: connection.connectionId,
                workspaceId: connection.workspaceId,
                status: 'OPEN',
                coversUntil,
            },
            select: OPEN_RECORD_SELECT,
        });
    });
}

/**
 * TRIGGER 2: an `anthropic-workspace` connection was removed (disabled). Opens
 * the record and makes the first attempt at once; data-lifecycle retries what
 * is left. Called after the removal has committed. Never throws.
 */
export async function openConnectionRemovalCleanup(
    ctx: RequestContext,
    connectionId: string,
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<{ status: CleanupStatus; reason: string | null } | null> {
    try {
        const [connection] = await readCleanupConnections(ctx.tenantId, connectionId);
        if (!connection) return null;
        const record = await openRecord(ctx.tenantId, 'CONNECTION_REMOVED', connection, options.now ?? new Date());
        return await attemptCleanupRecord(record, options);
    } catch (err) {
        logger.error('managed-agents: the connection-removal clean-up could not be opened', {
            component: 'managed-agents-cleanup',
            tenantId: ctx.tenantId,
            connectionId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
        settle('CONNECTION_REMOVED', 'OPEN', 'CLEANUP_FAILED');
        return null;
    }
}

/**
 * TRIGGER 3: a DSAR erasure has COMMITTED. For every tenant where the person
 * held a membership, every connection's KEPT sessions are deleted. The
 * person's id is never written: the records name tenants and connections.
 * Never throws.
 */
export async function openDsarErasureCleanups(
    tenantIds: readonly string[],
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<Array<{ tenantId: string; connectionId: string; status: CleanupStatus; reason: string | null }>> {
    const out: Array<{ tenantId: string; connectionId: string; status: CleanupStatus; reason: string | null }> = [];
    const now = options.now ?? new Date();
    for (const tenantId of [...new Set(tenantIds)].sort()) {
        try {
            // guardrail-allow: n+1 — reason: one existence probe per tenant the person held a membership in.
            if (!(await hasManagedAgentsFootprint(tenantId))) continue;
            for (const connection of await readCleanupConnections(tenantId)) {
                const record = await openRecord(tenantId, 'DSAR_ERASURE', connection, now);
                const result = await attemptCleanupRecord(record, options);
                out.push({ tenantId, connectionId: connection.connectionId, ...result });
            }
        } catch (err) {
            logger.error('managed-agents: the DSAR clean-up could not be opened', {
                component: 'managed-agents-cleanup',
                tenantId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
            settle('DSAR_ERASURE', 'OPEN', 'CLEANUP_FAILED');
        }
    }
    return out;
}

/**
 * THE RETRY, run by the data-lifecycle job: every OPEN record, oldest first.
 * A purge record is never OPEN (a CHECK), so this never retries a purge.
 */
export async function retryOpenManagedAgentsCleanups(
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<{ attempted: number; done: number; abandoned: number; open: number }> {
    const records = await runWithoutRls({ reason: 'cross-tenant-sweep' }, (db) =>
        db.managedAgentsCleanup.findMany({
            where: { status: 'OPEN' },
            select: OPEN_RECORD_SELECT,
            orderBy: { createdAt: 'asc' },
            take: RETRY_BATCH,
        }),
    );
    const tally = { attempted: 0, done: 0, abandoned: 0, open: 0 };
    for (const record of records) {
        // guardrail-allow: n+1 — reason: each record is one provider pass with its own key and deadline.
        const { status } = await attemptCleanupRecord(record, options);
        tally.attempted += 1;
        if (status === 'DONE') tally.done += 1;
        else if (status === 'ABANDONED') tally.abandoned += 1;
        else tally.open += 1;
    }
    return tally;
}

// ─── The reconciliation: failed deletes and lost deletes ────────────────────

type ManagedAgentsClient = Extract<ReturnType<typeof managedAgentsClientFor>, { ok: true }>['client'];

/** Outcomes after which every later call of the pass would answer the same. */
const HALTING_OUTCOMES: ReadonlySet<CleanupItemOutcome> = new Set(['AUTH_REFUSED', 'PROVIDER_UNREACHABLE', 'DEADLINE']);

export interface ReconcileTally {
    /** Lost deletes: sessions recorded DELETED that were read back. */
    checked: number;
    lost: number;
    deleted: number;
    failed: number;
    /** Failed deletes (#5843): sessions whose latest step is DELETE_FAILED, attempted. */
    retried: number;
    /** Of those, deleted now or already gone, with their DELETED step written. */
    retriedDeleted: number;
    /** Of those, left for the next pass, each with its named outcome. */
    retriedLeft: number;
}

/** The ledger step a pass writes when it deletes a session: what the run writes. */
async function recordSessionDeleted(tenantId: string, session: LedgerSession): Promise<void> {
    const last = await runInTenantJobContext({ tenantId, source: CLEANUP_SOURCE }, (db) =>
        db.workflowStep.findFirst({ where: { tenantId, runId: session.runId }, orderBy: { seq: 'desc' }, select: { seq: true } }),
    );
    const ctx = buildSystemContext({ tenantId, job: CLEANUP_SOURCE, discriminator: session.runId });
    await recordStep(
        ctx,
        session.runId,
        (last?.seq ?? 0) + 1,
        'SYNTHESIS',
        sessionStepRecord('SESSION_DELETED', { sessionId: session.sessionId, connectionId: session.connectionId }),
    );
}

/**
 * THE FAILED-DELETE RETRY for one connection (#5843). Each session goes
 * through the clean-up's own call (`deleteSession`: read first, so a running
 * session is left running), with the client from the one constructor. Done is
 * removed or a 404, and then `SESSION_DELETED` is written on the run's ledger
 * so the session is not retried again. Anything else is left, as the ledger
 * already has it, for the next pass. A refused key, an unreachable provider
 * or the deadline ends the connection's pass: the rest are given that outcome
 * without being sent. Every session's outcome is a metric. Never throws.
 */
async function retryFailedDeletesFor(
    tenantId: string,
    connection: CleanupConnection | null,
    sessions: readonly LedgerSession[],
    signal: AbortSignal,
    tally: ReconcileTally,
): Promise<void> {
    const leave = (s: LedgerSession, outcome: string): void => {
        tally.retriedLeft += 1;
        recordManagedAgentsFailedDeleteRetry({ outcome });
        logger.warn('managed-agents: a session whose delete failed is still there, and is left for the next pass', {
            component: 'managed-agents-cleanup', tenantId, runId: s.runId, outcome,
        });
    };
    let client: ManagedAgentsClient | null = null;
    let unavailable: CleanupReason = 'CONNECTION_UNREADABLE';
    if (!connection) unavailable = 'CONNECTION_GONE';
    else if (connection.apiKey && connection.workspaceId) {
        const choice = managedAgentsClientFor({ apiKey: connection.apiKey, workspaceId: connection.workspaceId });
        if (choice.ok) client = choice.client;
        else if (choice.reason === 'SDK_AMBIENT_HEADERS_SET') unavailable = 'SDK_AMBIENT_HEADERS_SET';
    }
    let halted: CleanupItemOutcome | null = null;
    for (const s of sessions) {
        tally.retried += 1;
        if (!client) {
            leave(s, unavailable);
            continue;
        }
        const outcome: CleanupItemOutcome = halted ?? (signal.aborted ? 'DEADLINE' : await deleteSession(client, s.sessionId, signal));
        if (HALTING_OUTCOMES.has(outcome)) halted = outcome;
        if (!isDoneOutcome(outcome)) {
            leave(s, outcome);
            continue;
        }
        try {
            await recordSessionDeleted(tenantId, s);
        } catch (err) {
            // The session is gone; the next pass reads it back as a 404 and writes the step.
            tally.retriedLeft += 1;
            recordManagedAgentsFailedDeleteRetry({ outcome: 'LEDGER_WRITE_FAILED' });
            logger.error('managed-agents: a session whose delete had failed was deleted, but its step could not be written', {
                component: 'managed-agents-cleanup', tenantId, runId: s.runId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
            continue;
        }
        tally.retriedDeleted += 1;
        recordManagedAgentsFailedDeleteRetry({ outcome });
        logger.info('managed-agents: a session whose delete had failed was deleted', {
            component: 'managed-agents-cleanup', tenantId, runId: s.runId, outcome,
        });
    }
}

/**
 * THE RECONCILIATION, run by data-lifecycle over the `anthropic-workspace`
 * connections of every tenant that is not soft-deleted (a soft-deleted
 * tenant's workspace is the purge's), disabled connections included, read
 * through the clean-up's own reader. Per tenant, under one deadline:
 *
 *   1. FAILED DELETES (#5843). Every session whose LATEST step is
 *      `SESSION_DELETE_FAILED`, and that was never KEPT, is deleted by its
 *      recorded id, and `SESSION_DELETED` is written on its run's ledger
 *      (`retryFailedDeletesFor`). Bounded per pass: the newest
 *      `FAILED_DELETE_READ_CAP` failed steps are read (more is reported
 *      `LEDGER_TRUNCATED`), and at most `FAILED_DELETE_RETRY_BATCH` sessions
 *      are attempted, oldest first, under `RETRY_CLEANUP_DEADLINE_MS`.
 *   2. LOST DELETES. Every session recorded DELETED in the last
 *      `RECONCILE_LOOKBACK_DAYS` is read back, and one that still exists is
 *      deleted (`agentic.managed_agents.lost_delete`).
 *
 * Never throws.
 */
export async function reconcileLostSessionDeletes(
    options: { now?: Date; deadlineMs?: number } = {},
): Promise<ReconcileTally> {
    const now = options.now ?? new Date();
    const tally: ReconcileTally = { checked: 0, lost: 0, deleted: 0, failed: 0, retried: 0, retriedDeleted: 0, retriedLeft: 0 };
    const tenants = await runWithoutRls({ reason: 'cross-tenant-sweep' }, (db) =>
        db.integrationConnection.findMany({
            // A soft-deleted workspace is the purge's: it makes its own
            // attempt before the rows go (#5017's rule for cross-tenant reads).
            where: { provider: ANTHROPIC_WORKSPACE_PROVIDER, tenant: { deletedAt: null } },
            select: { tenantId: true },
            distinct: ['tenantId'],
            orderBy: { tenantId: 'asc' },
            take: 1_000,
        }),
    );
    for (const { tenantId } of tenants) {
        const timer = deadline(options.deadlineMs ?? RETRY_CLEANUP_DEADLINE_MS);
        try {
            // guardrail-allow: n+1 — reason: one tenant-bound read per tenant; RLS binds each to its own tenant.
            const failedDeletes = await readFailedDeletes(tenantId);
            if (failedDeletes.truncated) {
                recordManagedAgentsFailedDeleteRetry({ outcome: 'LEDGER_TRUNCATED' });
                logger.warn('managed-agents: more failed session deletes than one pass reads; the oldest wait', {
                    component: 'managed-agents-cleanup', tenantId, readCap: FAILED_DELETE_READ_CAP,
                });
            }
            const retrying = failedDeletes.sessions.slice(0, FAILED_DELETE_RETRY_BATCH);
            // guardrail-allow: n+1 — reason: one tenant-bound read per tenant; RLS binds each to its own tenant.
            const { sessions } = await readLedgerSessions(tenantId, { since: new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * DAY_MS) });
            const deletedOnes = [...sessions.values()].filter((s) => s.lifecycles.has('SESSION_DELETED'));
            if (deletedOnes.length === 0 && retrying.length === 0) continue;
            const connections = await readCleanupConnections(tenantId);

            // 1. Failed deletes, per recorded connection; a connection whose row is gone is named.
            const byConnection = new Map<string, LedgerSession[]>();
            for (const s of retrying) byConnection.set(s.connectionId, [...(byConnection.get(s.connectionId) ?? []), s]);
            for (const [connectionId, mine] of [...byConnection.entries()].sort(([x], [y]) => x.localeCompare(y))) {
                const connection = connections.find((c) => c.connectionId === connectionId) ?? null;
                await retryFailedDeletesFor(tenantId, connection, mine, timer.signal, tally);
            }

            // 2. Lost deletes.
            for (const connection of connections) {
                const mine = deletedOnes.filter((s) => s.connectionId === connection.connectionId);
                if (mine.length === 0 || !connection.apiKey) continue;
                const choice = managedAgentsClientFor({ apiKey: connection.apiKey, workspaceId: connection.workspaceId });
                if (!choice.ok) continue;
                for (const s of mine) {
                    tally.checked += 1;
                    let exists = false;
                    try {
                        await choice.client.beta.sessions.retrieve(s.sessionId, {}, { signal: timer.signal });
                        exists = true;
                    } catch (err) {
                        const status = (err as { status?: unknown } | null)?.status;
                        if (status !== 404) {
                            recordManagedAgentsLostDelete({ outcome: 'unverified' });
                            continue;
                        }
                    }
                    if (!exists) continue;
                    tally.lost += 1;
                    try {
                        await choice.client.beta.sessions.delete(s.sessionId, {}, { signal: timer.signal });
                        tally.deleted += 1;
                        recordManagedAgentsLostDelete({ outcome: 'deleted' });
                        logger.warn('managed-agents: a session recorded deleted still existed, and was deleted', {
                            component: 'managed-agents-cleanup', tenantId, runId: s.runId,
                        });
                    } catch {
                        tally.failed += 1;
                        recordManagedAgentsLostDelete({ outcome: 'delete_failed' });
                        logger.error('managed-agents: a session recorded deleted still exists and could not be deleted', {
                            component: 'managed-agents-cleanup', tenantId, runId: s.runId,
                        });
                    }
                }
            }
        } catch (err) {
            logger.error('managed-agents: the lost-delete reconciliation failed for a tenant', {
                component: 'managed-agents-cleanup',
                tenantId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
        } finally {
            timer.clear();
        }
    }
    return tally;
}
