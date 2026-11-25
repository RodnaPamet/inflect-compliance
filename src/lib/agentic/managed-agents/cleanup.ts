/**
 * THE REMOTE CLEAN-UP: what Inflect created in a customer's Anthropic
 * workspace, removed by recorded id (Step 5c of
 * `docs/claude-managed-agents-design.md`, #4166).
 *
 * This module holds the calls and nothing else: no Prisma call, no permission
 * check, no usecase (global rule 2). The caller,
 * `app-layer/usecases/managed-agents-cleanup.ts`, reads what was recorded,
 * builds the client through the one constructor (`managedAgentsClientFor`),
 * and stores what this returns.
 *
 * ── RECORDED IDS ONLY ───────────────────────────────────────────────────────
 *
 * A pass is given the session ids and agent ids Inflect recorded, and touches
 * those. The one read beyond them is the CRASH WINDOW: 5b records
 * `SESSION_CREATED` after `sessions.create` returns, so a crash in between
 * leaves a session nobody recorded. It is found WITHOUT listing the workspace:
 * sessions are listed only FILTERED BY AN AGENT ID INFLECT RECORDED
 * (`agent_id`, archived ones included), and a listed session is taken only when
 * its metadata (`sessionMetadataFor`) names THIS tenant and a run the caller
 * confirms this tenant holds (`runsHeld`). A foreign session on the same agent,
 * one naming another tenant, and one naming no run this tenant holds are left
 * alone.
 *
 * ── OUTCOMES ────────────────────────────────────────────────────────────────
 *
 * Every item ends a pass with a named outcome (`CleanupItemOutcome`). Done is
 * `DONE` or `ALREADY_GONE` (a 404: there is nothing left to delete) and
 * nothing else. A 401/403 is `AUTH_REFUSED`, never done. An answer naming
 * another workspace is `WORKSPACE_MISMATCH`, never done, whatever its status
 * (#5854 finding 4), and it halts the pass as a refused key does. A session whose status
 * is still `running` is `SESSION_STILL_RUNNING`: Anthropic refuses its delete,
 * and the pass does not interrupt a run it cannot see. An agent is archived
 * only after its crash-window listing succeeded, so a later pass can still
 * list it.
 *
 * ── THE DEADLINE ────────────────────────────────────────────────────────────
 *
 * Every call carries the pass's `AbortSignal`, so the tenant purge, which must
 * not wait on a provider beyond a bounded time, stops the pass at its deadline;
 * whatever the deadline cut off is `DEADLINE`, never done.
 */
import type Anthropic from '@anthropic-ai/sdk';

import { sessionMetadataFor } from './definition';
import { isManagedAgentsWorkspaceMismatch } from './workspace-header';

/** What happened to one session or agent in a pass. */
export type CleanupItemOutcome =
    /** Deleted (a session) or archived (an agent) by this pass. */
    | 'DONE'
    /** A 404: the object is not there, so nothing is left to remove. */
    | 'ALREADY_GONE'
    /** Anthropic refuses deleting a running session; retried later. */
    | 'SESSION_STILL_RUNNING'
    /** 401 or 403: the key no longer opens the workspace. Never done. */
    | 'AUTH_REFUSED'
    /**
     * The answer named a different workspace than the connection's (#5854
     * finding 4): nothing it said is believed, a 404 or a 2xx included, so the
     * object is never counted removed on it. Never done.
     */
    | 'WORKSPACE_MISMATCH'
    /** No answer: the network, a timeout, a refused connection. */
    | 'PROVIDER_UNREACHABLE'
    /** A 5xx. */
    | 'PROVIDER_ERROR'
    /** A 429. */
    | 'RATE_LIMITED'
    /** Any other 4xx. */
    | 'PROVIDER_REFUSED'
    /** The pass's deadline passed before this item was finished. */
    | 'DEADLINE'
    /** The crash-window listing reached its page cap: the agent's sessions were not all seen. */
    | 'LIST_TRUNCATED';

/** Done means removed or already gone. Nothing else is done. */
export function isDoneOutcome(outcome: CleanupItemOutcome): boolean {
    return outcome === 'DONE' || outcome === 'ALREADY_GONE';
}

/**
 * The order in which a record names its one reason when several items are
 * left: the reason that most needs a person comes first.
 */
export const CLEANUP_REASON_ORDER: readonly CleanupItemOutcome[] = [
    'WORKSPACE_MISMATCH',
    'AUTH_REFUSED',
    'PROVIDER_UNREACHABLE',
    'PROVIDER_ERROR',
    'RATE_LIMITED',
    'DEADLINE',
    'LIST_TRUNCATED',
    'SESSION_STILL_RUNNING',
    'PROVIDER_REFUSED',
];

/**
 * The outcome of a thrown SDK error, read off its `status`, never its message.
 * A response from another workspace is asked FIRST: it carries no status, and
 * whatever status the answer had is not one to believe (#5854 finding 4).
 */
export function outcomeOfError(err: unknown, signal?: AbortSignal | null): CleanupItemOutcome {
    if (signal?.aborted) return 'DEADLINE';
    if (isManagedAgentsWorkspaceMismatch(err)) return 'WORKSPACE_MISMATCH';
    const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : null;
    if (status === null) return 'PROVIDER_UNREACHABLE';
    if (status === 404) return 'ALREADY_GONE';
    if (status === 401 || status === 403) return 'AUTH_REFUSED';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'PROVIDER_ERROR';
    return 'PROVIDER_REFUSED';
}

/** How many pages of one agent's sessions a pass reads before it calls the listing truncated. */
export const CRASH_WINDOW_MAX_PAGES = 20;
export const CRASH_WINDOW_PAGE_SIZE = 100;

/** What a pass is asked to remove. Every id was recorded by Inflect. */
export interface CleanupPlan {
    readonly tenantId: string;
    /** Sessions to delete, by recorded id. */
    readonly sessionIds: readonly string[];
    /** Agents to archive, by recorded id. Empty on a DSAR erasure: its agents stay. */
    readonly agentIds: readonly string[];
    /**
     * Recorded agents whose sessions are listed for the crash window. Every
     * agent to archive is listed first; a DSAR erasure lists none.
     */
    readonly listAgentIds: readonly string[];
    /** Only sessions created at or before this instant are taken from a listing. */
    readonly createdAtOrBefore?: Date;
}

export interface CleanupPassResult {
    readonly deletedSessionIds: string[];
    readonly archivedAgentIds: string[];
    /** Sessions found through the crash window (also counted in deleted or remaining). */
    readonly crashWindowSessionIds: string[];
    /** Each item a pass did not finish, with its outcome. */
    readonly remaining: Record<string, CleanupItemOutcome>;
    readonly remainingSessionIds: string[];
    readonly remainingAgentIds: string[];
    /** The record's one reason: the first of `CLEANUP_REASON_ORDER` among `remaining`, or null. */
    readonly reason: CleanupItemOutcome | null;
}

export interface CleanupPassOptions {
    readonly signal?: AbortSignal;
    /** Of these run ids, the ones this tenant holds. The caller reads its own database. */
    readonly runsHeld: (runIds: readonly string[]) => Promise<ReadonlySet<string>>;
}

const META = sessionMetadataFor('t', 'r');
const TENANT_KEY = Object.keys(META).find((k) => META[k] === 't')!;
const RUN_KEY = Object.keys(META).find((k) => META[k] === 'r')!;

function requestOptions(signal?: AbortSignal): { signal?: AbortSignal } {
    return signal ? { signal } : {};
}

/** Delete one recorded session. Read first: a running session is not deleted. */
export async function deleteSession(client: Anthropic, sessionId: string, signal?: AbortSignal): Promise<CleanupItemOutcome> {
    try {
        const session = await client.beta.sessions.retrieve(sessionId, {}, requestOptions(signal));
        if (session.status === 'running' || session.status === 'rescheduling') return 'SESSION_STILL_RUNNING';
    } catch (err) {
        return outcomeOfError(err, signal);
    }
    try {
        await client.beta.sessions.delete(sessionId, {}, requestOptions(signal));
        return 'DONE';
    } catch (err) {
        return outcomeOfError(err, signal);
    }
}

/** Archive one recorded agent. Anthropic has no agent delete; archive is the end of its life. */
export async function archiveAgent(client: Anthropic, agentId: string, signal?: AbortSignal): Promise<CleanupItemOutcome> {
    try {
        const agent = await client.beta.agents.retrieve(agentId, {}, requestOptions(signal));
        if (agent.archived_at) return 'ALREADY_GONE';
    } catch (err) {
        return outcomeOfError(err, signal);
    }
    try {
        await client.beta.agents.archive(agentId, {}, requestOptions(signal));
        return 'DONE';
    } catch (err) {
        return outcomeOfError(err, signal);
    }
}

/**
 * The crash window for ONE recorded agent: its sessions, archived included,
 * whose metadata names this tenant and a run id. The caller decides which of
 * those runs this tenant holds.
 */
export async function listCrashWindow(
    client: Anthropic,
    agentId: string,
    tenantId: string,
    createdAtOrBefore: Date | undefined,
    signal?: AbortSignal,
): Promise<{ ok: true; candidates: Array<{ sessionId: string; runId: string }> } | { ok: false; outcome: CleanupItemOutcome }> {
    const candidates: Array<{ sessionId: string; runId: string }> = [];
    try {
        let page = await client.beta.sessions.list(
            {
                agent_id: agentId,
                include_archived: true,
                limit: CRASH_WINDOW_PAGE_SIZE,
                ...(createdAtOrBefore ? { 'created_at[lte]': createdAtOrBefore.toISOString() } : {}),
            },
            requestOptions(signal),
        );
        for (let pages = 1; ; pages += 1) {
            for (const s of page.data) {
                const meta = s.metadata ?? {};
                const runId = meta[RUN_KEY];
                // This tenant's metadata only. A session naming another tenant,
                // or naming none, is not Inflect's to delete here.
                if (meta[TENANT_KEY] !== tenantId || typeof runId !== 'string' || runId.length === 0) continue;
                candidates.push({ sessionId: s.id, runId });
            }
            if (!page.hasNextPage()) break;
            if (pages >= CRASH_WINDOW_MAX_PAGES) return { ok: false, outcome: 'LIST_TRUNCATED' };
            page = await page.getNextPage();
        }
    } catch (err) {
        return { ok: false, outcome: outcomeOfError(err, signal) };
    }
    return { ok: true, candidates };
}

/** One pass over a plan. Never throws: every failure is an outcome. */
export async function runCleanupPass(client: Anthropic, plan: CleanupPlan, options: CleanupPassOptions): Promise<CleanupPassResult> {
    const { signal } = options;
    const remaining: Record<string, CleanupItemOutcome> = {};
    // A refused key or a provider that does not answer will answer every
    // later call the same way: the rest of the pass is given that outcome
    // without being sent, rather than retried into the deadline.
    let halted: CleanupItemOutcome | null = null;
    const halting = (o: CleanupItemOutcome): CleanupItemOutcome => {
        if (o === 'AUTH_REFUSED' || o === 'WORKSPACE_MISMATCH' || o === 'PROVIDER_UNREACHABLE' || o === 'DEADLINE') halted = o;
        return o;
    };
    const stopped = (): CleanupItemOutcome | null => halted ?? (signal?.aborted ? 'DEADLINE' : null);
    const sessions = new Set(plan.sessionIds);
    const crashWindow: string[] = [];
    const listed = new Set<string>();

    // 1. The crash window, per recorded agent.
    for (const agentId of plan.listAgentIds) {
        const stop = stopped();
        if (stop) {
            remaining[agentId] = stop;
            continue;
        }
        const listing = await listCrashWindow(client, agentId, plan.tenantId, plan.createdAtOrBefore, signal);
        if (!listing.ok) {
            remaining[agentId] = halting(listing.outcome);
            continue;
        }
        listed.add(agentId);
        const candidates = listing.candidates.filter((c) => !sessions.has(c.sessionId));
        if (candidates.length === 0) continue;
        let held: ReadonlySet<string>;
        try {
            held = await options.runsHeld([...new Set(candidates.map((c) => c.runId))]);
        } catch {
            // Unknown whether the runs are this tenant's: take none, and list again later.
            listed.delete(agentId);
            remaining[agentId] = 'PROVIDER_REFUSED';
            continue;
        }
        for (const c of candidates) {
            if (!held.has(c.runId)) continue;
            sessions.add(c.sessionId);
            crashWindow.push(c.sessionId);
        }
    }

    // 2. Every session, recorded or found.
    const deletedSessionIds: string[] = [];
    for (const sessionId of sessions) {
        const outcome = stopped() ?? halting(await deleteSession(client, sessionId, signal));
        if (isDoneOutcome(outcome)) deletedSessionIds.push(sessionId);
        else remaining[sessionId] = outcome;
    }

    // 3. Every agent whose listing succeeded (or that needed none).
    const archivedAgentIds: string[] = [];
    for (const agentId of plan.agentIds) {
        if (remaining[agentId]) continue;
        if (plan.listAgentIds.includes(agentId) && !listed.has(agentId)) continue;
        const outcome = stopped() ?? halting(await archiveAgent(client, agentId, signal));
        if (isDoneOutcome(outcome)) archivedAgentIds.push(agentId);
        else remaining[agentId] = outcome;
    }

    const agentSet = new Set(plan.agentIds);
    const remainingAgentIds = plan.agentIds.filter((id) => remaining[id]);
    // An agent listed but not to be archived (none today) leaves no pending id.
    const remainingSessionIds = [...sessions].filter((id) => remaining[id] && !agentSet.has(id));
    const outcomes = new Set(Object.values(remaining));
    const reason = CLEANUP_REASON_ORDER.find((o) => outcomes.has(o)) ?? null;
    return {
        deletedSessionIds,
        archivedAgentIds,
        crashWindowSessionIds: crashWindow,
        remaining,
        remainingSessionIds,
        remainingAgentIds,
        reason,
    };
}
