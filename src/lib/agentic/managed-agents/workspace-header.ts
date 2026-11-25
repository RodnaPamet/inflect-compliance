/**
 * THE WORKSPACE A MANAGED AGENTS RESPONSE CAME FROM (#5854 finding 4, owner
 * decision 2026-11-25).
 *
 * Every request the engine's client sends names the workspace it is for, in
 * `anthropic-workspace-id` (`anthropicWorkspaceHeaders`). Anthropic answers
 * with the workspace the work ran in, in the response's own header of that
 * name. `managedAgentsClientFor` (`tool-runner/client.ts`) asks this module of
 * EVERY response, in its middleware, the one place every Managed Agents
 * response passes, for the customer's own workspace and Inflect's hosted one
 * alike, and for the event stream's initial response before a byte of its
 * body is read. The comparison is `answeredWorkspace`, the one the
 * connection's Test makes (`lib/ai/anthropic-workspace.ts`).
 *
 *   MATCH     passes.
 *   MISMATCH  FAILS THE CALL: the response is not handed to the SDK, its body
 *             is cancelled, and `ManagedAgentsWorkspaceMismatchError` is
 *             thrown. Thrown from middleware, it is not retried by the SDK.
 *             The client's latch records it (`workspaceMismatchSeen`), so the
 *             engine stops driving the session and settles the run
 *             `managed_agents_workspace_mismatch` (`execute.ts`), and no caller can read a
 *             status (a 404, a 2xx) from the answer: a clean-up never counts
 *             the object deleted on it.
 *   MISSING   PASSES, counted (`agentic.managed_agents.workspace_header`) and
 *             logged once per client, with no workspace id in the log. The
 *             owner's decision: refusing it waits for evidence from a real
 *             workspace (5H part 2) that every endpoint a run uses sends the
 *             header. When it is in, flip `REFUSE_MISSING_WORKSPACE_HEADER`:
 *             one line, a source constant, never configuration.
 */
import { answeredWorkspace, type AnsweredWorkspace } from '@/lib/ai/anthropic-workspace';
import { recordManagedAgentsWorkspaceHeader } from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';

/**
 * THE SWITCH. False: a response naming no workspace passes, counted. True: it
 * fails the call as a mismatch does (`answered: 'MISSING'`). Flip it only on
 * the evidence the owner asked for: a real-workspace run showing every
 * endpoint the engine calls answers with the header.
 */
export const REFUSE_MISSING_WORKSPACE_HEADER = false;

/** The answers that fail the call, under a given switch. */
export type RefusedAnswer = Exclude<AnsweredWorkspace, 'MATCH'>;

/**
 * Whether `answered` fails the call. Pure, so both positions of the switch are
 * unit-tested. Not a type predicate: a MISSING that passes is still MISSING,
 * not MATCH.
 */
export function failsTheCall(answered: AnsweredWorkspace, refuseMissing: boolean = REFUSE_MISSING_WORKSPACE_HEADER): boolean {
    return answered === 'MISMATCH' || (answered === 'MISSING' && refuseMissing);
}

/**
 * A Managed Agents response that did not come from the configured workspace.
 * Carries no status and no provider type on purpose: nothing the response
 * said may be read as an outcome (a 404 is not "already gone" from a workspace
 * that is not ours). Its `type` is ours, so a ledger step records it by name.
 */
export class ManagedAgentsWorkspaceMismatchError extends Error {
    override readonly name = 'ManagedAgentsWorkspaceMismatchError';
    /** Read by the engine's `providerCodeOf`, so a recorded step names it. */
    readonly type = 'workspace_mismatch';
    constructor(
        readonly answered: RefusedAnswer,
        readonly endpoint: string,
    ) {
        super(
            answered === 'MISMATCH'
                ? 'A Managed Agents response named a different Anthropic workspace than the one configured.'
                : 'A Managed Agents response named no Anthropic workspace, and a response must name the configured one.',
        );
    }
}

/** Is `err` the workspace check failing a call? */
export function isManagedAgentsWorkspaceMismatch(err: unknown): err is ManagedAgentsWorkspaceMismatchError {
    return err instanceof ManagedAgentsWorkspaceMismatchError;
}

/** What one client has seen: the latch the engine reads, and the once-per-client log. */
export interface WorkspaceHeaderLatch {
    mismatch: { readonly answered: RefusedAnswer; readonly endpoint: string } | null;
    missingLogged: boolean;
}

export function newWorkspaceHeaderLatch(): WorkspaceHeaderLatch {
    return { mismatch: null, missingLogged: false };
}

/** Each client's latch, held weakly so it goes when the client does. */
const LATCHES = new WeakMap<object, WorkspaceHeaderLatch>();

/** Bind a latch to the client it was built for. Called by `managedAgentsClientFor` only. */
export function bindWorkspaceHeaderLatch(client: object, latch: WorkspaceHeaderLatch): void {
    LATCHES.set(client, latch);
}

/**
 * Whether any response this client received failed the check. A run's client
 * is the run's alone, so this is "did this run ever hear from another
 * workspace", including from a call whose caller swallows errors (a listing,
 * a drain).
 */
export function workspaceMismatchSeen(client: object): RefusedAnswer | null {
    return LATCHES.get(client)?.mismatch?.answered ?? null;
}

/**
 * Check one response. Throws `ManagedAgentsWorkspaceMismatchError` when it
 * fails the call, after cancelling its body (an event stream would otherwise
 * stay open). Counts every response, by endpoint and answer.
 */
export function checkResponseWorkspace(
    response: Response,
    call: {
        readonly configuredWorkspaceId: string;
        readonly endpoint: string;
        readonly method: string;
        readonly runId?: string;
        readonly latch: WorkspaceHeaderLatch;
    },
): void {
    const answered = answeredWorkspace(response.headers, call.configuredWorkspaceId);
    const responseClass = response.ok ? 'success' : 'error';
    recordManagedAgentsWorkspaceHeader({ endpoint: call.endpoint, answered: answered.toLowerCase() as Lowercase<AnsweredWorkspace>, response: responseClass });
    // Log fields are read off this object, so each value's name is its own.
    const facts = { endpoint: call.endpoint, method: call.method, status: response.status, answered } as const;
    if (answered !== 'MATCH' && failsTheCall(answered)) {
        if (call.latch.mismatch === null) call.latch.mismatch = { answered, endpoint: call.endpoint };
        void response.body?.cancel().catch(() => undefined);
        logger.error('managed-agents: a response did not come from the configured workspace; the call fails', {
            component: 'agentic',
            runId: call.runId,
            endpoint: facts.endpoint,
            method: facts.method,
            status: facts.status,
            answered: facts.answered,
        });
        throw new ManagedAgentsWorkspaceMismatchError(answered, call.endpoint);
    }
    if (answered === 'MISSING' && !call.latch.missingLogged) {
        call.latch.missingLogged = true;
        logger.info('managed-agents: a response named no workspace; passed, and counted', {
            component: 'agentic',
            runId: call.runId,
            endpoint: facts.endpoint,
            method: facts.method,
            status: facts.status,
        });
    }
}
