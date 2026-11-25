/**
 * THE MANAGED AGENTS SESSION JOB (Step 5b of
 * `docs/claude-managed-agents-design.md`, shape MA-C2, #4165).
 *
 * One run, one session, in the customer's own Anthropic workspace. Anthropic
 * runs the agent loop; this file holds the session's event stream and decides,
 * at every event, whether the run may go on. It runs in the worker, as every
 * reasoning engine's run does (`isReasoningEngine`): the workflow-run job is
 * the BullMQ job per run the design names.
 *
 * ── BEFORE THE SESSION EXISTS ───────────────────────────────────────────────
 *
 * The kill switch; the run row and its declared input; the skills and their
 * pins (`resolveRunSkillMount`, the resolver every reasoning engine uses); the
 * invocation, the caps and the wall clock; the tool offer, built over the
 * engine-neutral core with this engine's guard prefix (`managed-agents`), so a
 * call is offered exactly what any engine is offered and runs through
 * `runGuardedTool`; the business-data transfer gate (#3872); a look for a
 * session of THIS run that a dead segment created and never recorded, which is
 * recorded and settled (`settleUnrecordedSessions`, #5854); and the DRIFT
 * CHECK: the agent is read at the version the profile pinned, and a `system`
 * or `tools` that no longer hashes to what Inflect wrote refuses the run
 * `AGENT_DRIFTED`; and the ENVIRONMENT, read again and compared with what
 * Inflect wrote the same way, refused `ENVIRONMENT_DRIFTED` (#5854). Every
 * refusal settles the run with a named reason and creates nothing at
 * Anthropic.
 *
 * ── THE SESSION ─────────────────────────────────────────────────────────────
 *
 * Created with `agent_with_overrides` at the pinned version, whose `system`
 * override is the ONE place the tenant's instructions are sent; the
 * connection's environment; a dollar `budget` derived from what is left of
 * the run's caps at the tier's list price (`sessionBudgetFor`), a backstop
 * behind the run's own token count; and metadata naming the tenant and the
 * run by id. The session
 * id is written to the ledger AT ONCE (`SESSION_CREATED`), so a crash leaves a
 * record Step 5c can clean up by id. A create Anthropic REFUSES settles the run
 * with its status and error type, never its text; one that gets NO answer may
 * still have made a session, which is found by this run's metadata on the
 * pinned agent, recorded and settled (`settleUnrecordedSessions`, Step 5H). The
 * create, like every POST here, is never re-sent by the SDK (`SEND_ONCE`).
 *
 * ── THE STREAM ──────────────────────────────────────────────────────────────
 *
 * Opened before the opening message is sent. Every event is deduplicated by id
 * and, first, the kill switch and the run's own status are read: a kill or an
 * operator's Abort stops the run at once. Then by type:
 *
 *   agent.message          the egress scan on its text, before Inflect uses it.
 *                          Anthropic has already stored it; that is the
 *                          weaker property decision 3 accepted.
 *   agent.custom_tool_use  QUEUED, never run at once: a turn's calls are run
 *                          after its `span.model_request_end`, so the token cap
 *                          and the scan of the turn's text are read first, as
 *                          the Tool Runner reads them before it runs a turn's
 *                          tools. Each queued call is run through the run's
 *                          runnable for that name (`toolRunnerToolsFor` /
 *                          `activateSkillTool`): the stop check, STEPS, the
 *                          turn's call cap, TOOL_CALLS, PROPOSALS, the guarded
 *                          call, the TOOL_CALL step and the kill read after.
 *                          A name the run does not offer is refused; the answer
 *                          is `user.custom_tool_result`, `is_error` on a
 *                          refusal. Each call is answered ONCE (`answered`).
 *   span.model_request_end one MODEL_CALL step and one Art 12 row, both naming
 *                          the digest of what Inflect had sent so far and both
 *                          marked span-derived; the tokens, STEPS and the wall
 *                          clock charged; the breaker read.
 *   agent.tool_use,
 *   agent.mcp_tool_use     the agent reached beyond its custom tools, which an
 *                          agent Inflect provisioned cannot: the run stops.
 *   session.updated        with a new `agent` (tools, MCP servers) or `budget`:
 *                          someone with the workspace's key edited the session
 *                          the drift check passed, and the run stops at once
 *                          rather than at the first call that uses it (5H).
 *   session.status_idle    `requires_action` runs the queue; any other reason
 *                          ends the stream.
 *
 * A DROPPED STREAM is reopened, and before it is read the session's event list
 * is read in full and every event not seen is handled, so a custom call the
 * drop hid is answered, and one already answered is not answered again.
 *
 * ── THE STOP ────────────────────────────────────────────────────────────────
 *
 * A kill, an Abort, a cap, a guard verdict, the breaker or the wall clock:
 * every pending custom call is answered `is_error`, `user.interrupt` is sent,
 * and the stream is drained until the session is idle. Anthropic honours the
 * interrupt "at a safe boundary", so the model may finish a request it had
 * begun; no tool it asks for after the stop is ever run. This is the variance
 * the conformance adapter declares for the kill switch.
 *
 * ── SETTLE ──────────────────────────────────────────────────────────────────
 *
 * In `finally`, whatever happened above, thrown errors included: the session is
 * DELETED (`DELETE /v1/sessions/{id}`, after its status has left `running`) and
 * the deletion recorded (`SESSION_DELETED`, or `SESSION_DELETE_FAILED` with the
 * provider's status), unless the connection keeps sessions (decision 4), when
 * it is recorded `SESSION_KEPT` so Step 5c finds it. Then the run settles in
 * the Tool Runner's order: an operator's Abort, a kill, the breaker, a cap, a
 * guard verdict, a reach beyond custom tools, a failure, the session's own end.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaToolRunContext } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type {
    BetaManagedAgentsSessionEvent,
    BetaManagedAgentsStreamSessionEvents,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';

import { computeInputDigest } from '@/app-layer/ai/decision-log';
import { guardEgress } from '@/app-layer/ai/guard';
import type { RequestContext } from '@/app-layer/types';
import { latchOnGuardBlock, readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import {
    failRun,
    haltRunAtCap,
    haltRunAtGuard,
    haltRunAtKill,
    isRunAborted,
    updateRun,
    type CapBesideKill,
} from '@/lib/agentic/drivers/run-settlement';
import { getRunRow, proposedItemsSoFar } from '@/lib/agentic/drivers/run-store';
import {
    keepCallResults,
    keepsCheckpoint,
    markCallInFlight,
    readCheckpoint,
    writeTurnCheckpointInTx,
} from '@/lib/agentic/drivers/checkpoint-store';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import type { RunDriverOutcome } from '@/lib/agentic/drivers/types';
import { asToolArgs, stepVerdictOf, type StepGuardObservation } from '@/lib/agentic/engine-tools';
import { emptyCatalogueMessage } from '@/lib/agentic/empty-catalogue-message';
import { externalResidencyRefusal, type ExternalAiAcknowledgement } from '@/lib/agentic/external-residency-gate';
import { openDeclaredRunInput, runMessage } from '@/lib/agentic/flue/run-message';
import { SkillLoadError } from '@/lib/agentic/flue/skills';
import { parseMountedSkillPins } from '@/lib/agentic/flue/skills/mount-gate';
import { skillPinDrift } from '@/lib/agentic/flue/skills/resolve';
import { resolveRunSkillMount } from '@/lib/agentic/flue/skills/tenant-mount';
import {
    KILL_SWITCH_DRILL_AGENT_ID,
    killRefusalMessage,
    resolveKillState,
    type KillVerdict,
} from '@/lib/agentic/kill-switch';
import { createRunBudget, resolveRunCaps, type RunCapHalt } from '@/lib/agentic/run-caps';
import { runLeaseTakenOver } from '@/lib/agentic/run-lease';
import { activateSkillTool, skillCatalogueText, type RunSkills } from '@/lib/agentic/tool-runner/skills';
import {
    SerialQueue,
    TurnCallCounter,
    toolRunnerToolsFor,
    type CallCheckpointHooks,
    type RunStop,
    type ToolRunBinding,
} from '@/lib/agentic/tool-runner/tools';
import { TOOL_CALL_OUTCOME_UNKNOWN } from '@/lib/agentic/tool-runner/transcript';
import { readTurnCaps } from '@/lib/agentic/turn-caps-policy';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { recordAgentKillRefusal } from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';
import { recordWorkflowContextIntegrityHalt } from '@/lib/observability/metrics';

import {
    MANAGED_AGENTS_GUARD_SOURCE,
    MANAGED_AGENTS_PREFIX,
    SEND_ONCE,
    agentDrift,
    environmentDrift,
    sessionBudgetFor,
    sessionMetadataFor,
    sessionSystemFor,
    type RetrievedAgent,
    type RetrievedEnvironment,
    writtenEnvironmentHash,
} from './definition';
import { listCrashWindow } from './cleanup';
import { recordManagedAgentsDecision, type InflectSentInput } from './model-decision';
import {
    CALL_START_NOT_RECORDED_MESSAGE,
    answerOpenCalls,
    keptResultOf,
    openSessionCheckpoint,
    planReconnect,
    sealKeptResults,
    sealSessionCheckpoint,
    type HistoryEvent,
    type KeptCallResult,
    type OpenedSessionCheckpoint,
    type ReconnectAnswer,
} from './reconnect';
import { sessionStepRecord, type SessionLifecycle } from './session-ledger';
import { meterHostedSession, openHostedSessionMeter, sessionUsageFrom, type HostedSessionUsageRead } from './session-usage';
import {
    readRecordedSessionIds,
    readSegmentLedger,
    recordEnvironmentHashOnFirstUse,
    type ProvisionRecord,
    type SegmentSession,
} from './store';
import type { ManagedAgentsWorkspaceKind } from './workspace';

const RANK: Record<StepGuardObservation['verdict'], number> = { CLEAN: 0, FLAGGED: 1, QUARANTINED: 2 };

// The session step's label and shape live in `session-ledger.ts`, which the
// data-lifecycle reconciliation also writes through (#5843).
export { SESSION_STEP_LABEL, type SessionLifecycle } from './session-ledger';

/** The text a pending custom call is answered with when the run stops. Never a tool's output. */
export const STOPPED_TOOL_RESULT = 'This run was stopped by Inflect. The tool was not run.';

/** The text a call to a tool this run does not offer is answered with. Never names what the model sent. */
export const NOT_OFFERED_TOOL_RESULT = 'This tool is not available to this run, so the call was refused.';

/** How many times a dropped stream is reopened before the run gives up. */
export const MAX_STREAM_RECONNECTS = 5;

/** How many interrupt rounds the stop makes before it stops waiting and deletes. */
const MAX_STOP_ROUNDS = 3;

/** How long the stop waits for the session to go idle, per round. */
export const STOP_DRAIN_TIMEOUT_MS = 30_000;

/** How long the settle waits for a session to leave `running` before it deletes. */
const SETTLE_POLL_ATTEMPTS = 10;
const SETTLE_POLL_MS = 200;

// ── Settlement sentences ────────────────────────────────────────────────────

export const AGENT_DRIFTED_PREFIX = `${MANAGED_AGENTS_PREFIX}_agent_drifted`;

/**
 * What a refusal before the session says was sent. A reconnecting segment
 * (#5854, 2026-11-25) had already sent the session the run's opening message
 * and its earlier results, so "Nothing was sent" would be false: it says the
 * run did not continue there instead.
 */
function sentClause(reconnecting: boolean): string {
    return reconnecting
        ? 'The run had begun in a session before its worker stopped, and it was not continued there.'
        : 'Nothing was sent.';
}

/**
 * The remedy is the one that works (#5854): a version is approved once, and
 * approving the NEXT version provisions a new agent in place of one edited or
 * archived in the Console (`provisionManagedAgent`). The old agent stays
 * recorded, so removing the connection or purging the workspace archives it.
 */
export function agentDriftedMessage(drift: string, reconnecting = false): string {
    return (
        `${AGENT_DRIFTED_PREFIX}: the agent in your Anthropic workspace no longer matches what Inflect provisioned for `
        + `this profile version (${drift}). ${sentClause(reconnecting)} Someone may have edited or archived it in the Anthropic `
        + 'Console. Approve a new version of this profile: approval provisions a new agent for it, and the old agent is '
        + 'archived when the connection is removed.'
    );
}

export const ENVIRONMENT_DRIFTED_PREFIX = `${MANAGED_AGENTS_PREFIX}_environment_drifted`;

/**
 * The remedy is the one that works (#5854). Inflect makes ONE environment per
 * connection and never a second, so an archived one cannot be replaced by
 * approving anything; a changed one matches again once its settings are put
 * back, because only the settings are compared.
 */
export function environmentDriftedMessage(drift: string, reconnecting = false): string {
    const remedy =
        drift === 'ARCHIVED'
            ? 'It was archived, and Inflect makes one environment per connection and does not make another, so no run can start in it.'
            : 'Someone may have edited it in the Anthropic Console. Set it back to limited networking with no allowed hosts, '
              + 'no MCP servers, no package managers and no packages, and runs can start again.';
    return (
        `${ENVIRONMENT_DRIFTED_PREFIX}: the environment in your Anthropic workspace no longer matches what Inflect `
        + `provisioned for this connection (${drift}). ${sentClause(reconnecting)} ${remedy}`
    );
}

export const ENVIRONMENT_UNREADABLE_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_environment_unreadable: the environment this connection's runs use could not be read `
    + 'from your Anthropic workspace, so its configuration could not be checked. Nothing was sent.';

export const AGENT_UNREADABLE_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_agent_unreadable: the agent this profile version was provisioned as could not be read `
    + 'from your Anthropic workspace, so its configuration could not be checked. Nothing was sent.';

/** A refusal written for a fresh session, said of a reconnecting one (#5854). */
function asReconnecting(message: string, reconnecting: boolean): string {
    return reconnecting ? message.replace('Nothing was sent.', sentClause(true)) : message;
}

export const MODEL_UNPRICED_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_model_unpriced: no list price is known for this profile's model, so no spend cap could `
    + 'be set on the session. Nothing was sent.';

export const SESSION_NOT_CREATED_PREFIX = `${MANAGED_AGENTS_PREFIX}_session_not_created`;

/** The provider's status and error type, never its text. A lost response has neither. */
export function sessionNotCreatedMessage(code: { status: number | null; type: string | null }): string {
    const what = code.status !== null ? `provider status ${code.status}${code.type ? ` (${code.type})` : ''}` : 'the provider did not answer';
    return `${SESSION_NOT_CREATED_PREFIX}: ${what}. Nothing was run.`;
}

// ── A reconnecting segment's refusals (#5854, owner decision 2026-11-25) ────

/** How many events of a session's history one read takes at most; one more is a truncation, refused. */
export const SESSION_HISTORY_READ_CAP = 5_000;

/** The page size of a session's history read. */
export const SESSION_HISTORY_PAGE_SIZE = 100;

/** Why a retried or taken-over segment did not continue in its session. */
export type ReconnectRefusal =
    | 'SESSION_GONE'
    | 'SESSION_TERMINATED'
    | 'SESSION_UNREADABLE'
    | 'SESSION_SETTLED_EARLIER'
    | 'SESSION_STOPPED_EARLIER'
    | 'WORKSPACE_CHANGED'
    | 'LEDGER_TRUNCATED'
    | 'CHECKPOINT_UNREADABLE';

/** The sentence a reconnecting segment's refusal settles the run with. Never the session's content. */
export function reconnectRefusalMessage(reason: ReconnectRefusal): string {
    const p = `${MANAGED_AGENTS_PREFIX}_reconnect`;
    const tail = 'A run never starts a second session for the same segment, so it stopped. Start the run again.';
    switch (reason) {
        case 'SESSION_GONE':
            return `${p}_session_gone: this run's worker stopped, and the session the run was continuing in is no longer in the Anthropic workspace. ${tail}`;
        case 'SESSION_TERMINATED':
            return `${p}_session_terminated: this run's worker stopped, and Anthropic had ended the session the run was continuing in. ${tail}`;
        case 'SESSION_UNREADABLE':
            return `${p}_session_unreadable: this run's worker stopped, and the session the run was continuing in could not be read, so it was not continued unchecked. ${tail}`;
        case 'SESSION_SETTLED_EARLIER':
            return (
                `${p}_session_settled: an earlier attempt of this segment had already deleted or kept its session and then `
                + `stopped before the run was settled, so there is no session to continue in. ${tail}`
            );
        case 'SESSION_STOPPED_EARLIER':
            return (
                `${p}_session_stopped: an earlier attempt of this segment had already stopped its session (a kill, an `
                + 'abort, a cap or a guard verdict) and then stopped before the run was settled, so the run is not continued.'
            );
        case 'WORKSPACE_CHANGED':
            return (
                `${p}_workspace_changed: the session this run was continuing in belongs to a different Anthropic workspace `
                + `connection than the one in use now. ${tail}`
            );
        case 'LEDGER_TRUNCATED':
            return `${p}_ledger_truncated: this segment's ledger is longer than one read, so the session to continue in could not be told for certain. ${tail}`;
        case 'CHECKPOINT_UNREADABLE':
            return (
                `${p}_checkpoint_unreadable: the record of which tool calls this run had made could not be read as it was `
                + 'written, so the run stopped rather than guess which calls had run.'
            );
    }
}

export const SESSION_HISTORY_TRUNCATED_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_session_history_truncated: the session's event history is longer than `
    + `${SESSION_HISTORY_READ_CAP} events, so it could not be read in full, and the run stopped rather than continue on `
    + 'part of it.';

export const KILL_UNREADABLE_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_kill_switch_unreadable: the kill switch could not be read, so the run stopped rather `
    + 'than carry on unchecked.';

export const BREAKER_OPEN_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_breaker_open: this agent's circuit breaker is latched open, so the run stopped. An `
    + 'administrator must review and close it.';

export const BREAKER_UNREADABLE_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_breaker_unreadable: the circuit breaker could not be read, so the run stopped rather `
    + 'than carry on unchecked.';

export const BEYOND_CUSTOM_TOOLS_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_reached_beyond_custom_tools: the agent called a tool Inflect did not provision, which `
    + 'only an edit made in the Anthropic Console can add. The run stopped; no such call was answered by Inflect.';

export const SESSION_EDITED_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_session_edited: the session's tools, MCP servers or spend cap were changed in your `
    + 'Anthropic workspace while the run was going on, which only someone holding the workspace\'s key can do. The run '
    + 'stopped; no call after the change was run by Inflect.';

export const STREAM_LOST_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_stream_lost: the session's event stream dropped ${MAX_STREAM_RECONNECTS} times, so `
    + 'the run stopped rather than leave a call unanswered.';

export const SESSION_STOP_REASONS = {
    retries_exhausted:
        `${MANAGED_AGENTS_PREFIX}_retries_exhausted: Anthropic gave up on the session after repeated errors.`,
    budget_reached:
        `${MANAGED_AGENTS_PREFIX}_budget_reached: the session reached its spend cap, the backstop behind the run's `
        + 'token cap, and stopped.',
    refusal: `${MANAGED_AGENTS_PREFIX}_model_refused: the model declined to continue this run.`,
    terminated: `${MANAGED_AGENTS_PREFIX}_session_terminated: Anthropic ended the session before it finished.`,
} as const;

export type SessionEnd = 'end_turn' | keyof typeof SESSION_STOP_REASONS;

/** The provider's HTTP status and error type, never its message: the ledger and the log carry codes. */
function providerCodeOf(err: unknown): { status: number | null; type: string | null } {
    if (!err || typeof err !== 'object') return { status: null, type: null };
    const thrown = err as { status?: unknown; type?: unknown; error?: { error?: { type?: unknown } } };
    const type =
        typeof thrown.type === 'string' ? thrown.type
            : typeof thrown.error?.error?.type === 'string' ? thrown.error.error.type
                : null;
    return { status: typeof thrown.status === 'number' ? thrown.status : null, type };
}

/** The text of an `agent.message`, from its text blocks only. */
function messageText(content: ReadonlyArray<unknown>): string {
    return content
        .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
        .filter((t) => t.length > 0)
        .join('\n');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type AnyEvent = BetaManagedAgentsStreamSessionEvents | BetaManagedAgentsSessionEvent;

/** The route the driver decided before anything was read here. */
export interface ManagedAgentsRoute {
    readonly providerId: string;
    readonly externalAiAcknowledgement: ExternalAiAcknowledgement;
    readonly connectionId: string;
    /**
     * Whose workspace this run uses (Step 6b): the tenant's own (`TENANT`) or
     * Inflect's (`HOSTED`). Written on the ledger's `SESSION_CREATED` step and
     * on every `MODEL_CALL` step, so the run records which workspace it used
     * and, for a hosted run, what Inflect paid for.
     */
    readonly workspaceKind: ManagedAgentsWorkspaceKind;
    /** Decision 4. Always false for a hosted workspace. */
    readonly keepSessions: boolean;
    readonly provision: ProvisionRecord;
    readonly model: string;
}

export async function executeManagedAgentsRun(
    ctx: RequestContext,
    runId: string,
    def: WorkflowDefinition,
    fromSeq: number,
    runStartMs: number,
    client: Anthropic,
    route: ManagedAgentsRoute,
): Promise<RunDriverOutcome> {
    // Log fields are read off this object, so each value's name is its own.
    const run = { runId } as const;

    // ── The kill switch, before anything is read or sent ────────────────────
    const kill = await resolveKillState(ctx.tenantId, ctx.agentId ?? null);
    if (kill) {
        recordAgentKillRefusal({ scope: kill.scope, drill: ctx.agentId === KILL_SWITCH_DRILL_AGENT_ID });
        const status = await haltRunAtKill(ctx, runId, kill, killRefusalMessage(kill.scope), null, MANAGED_AGENTS_PREFIX);
        return { status, stepFailures: 0 };
    }

    const initial = await getRunRow(ctx, runId);
    let costTokens = initial.costTokens ?? 0;

    const declared = openDeclaredRunInput({
        tenantId: ctx.tenantId,
        runId,
        def,
        storedJson: initial.contextJson ?? null,
        storedHash: initial.contextHash ?? null,
    });
    if (!declared.ok) {
        if (declared.integrityCode) recordWorkflowContextIntegrityHalt({ code: declared.integrityCode });
        const status = await failRun(ctx, runId, declared.message);
        return { status, stepFailures: 0 };
    }
    const message = runMessage(def, declared.input);

    // ── The run's skills: the one resolver, the row's pins ──────────────────
    let skills: RunSkills;
    try {
        const mount = await resolveRunSkillMount(ctx, def);
        const drift = skillPinDrift(initial.mountedSkills, mount.pins);
        if (drift) {
            const status = await failRun(ctx, runId, `skill_pin_drift: ${drift}`);
            return { status, stepFailures: 0 };
        }
        skills = { documents: mount.documents, pins: parseMountedSkillPins(initial.mountedSkills) ?? mount.pins };
    } catch (err) {
        if (!(err instanceof SkillLoadError)) throw err;
        const status = await failRun(ctx, runId, `skill_not_mountable: ${err.message}`);
        return { status, stepFailures: 0 };
    }

    const invocation = await resolveMcpInvocation(ctx, { actionsAlready: fromSeq });
    const caps = resolveRunCaps(invocation.policyCard?.inForce.value ?? null);
    const budget = createRunBudget({
        caps,
        now: () => Date.now(),
        startedAtMs: runStartMs,
        spent: {
            STEPS: fromSeq,
            TOOL_CALLS: fromSeq,
            PROPOSALS: await proposedItemsSoFar(ctx, runId),
            TOKENS: costTokens,
        },
    });
    const preflight = budget.charge('RUNTIME_MS', 0);
    if (preflight) {
        const status = await haltRunAtCap(ctx, runId, preflight, null);
        return { status, stepFailures: 0 };
    }

    const turnCaps = await readTurnCaps(ctx.tenantId, ctx.requestId);
    const turnCalls = new TurnCallCounter(turnCaps.toolCallsPerTurn.value);

    // ── The run's state: one object, so a check sees what a closure latched ─
    const state: {
        capHalt: RunCapHalt | null;
        killVerdict: KillVerdict | null;
        killAfterCap: boolean;
        killUnreadable: boolean;
        operatorAborted: boolean;
        breakerOpen: boolean;
        breakerUnreadable: boolean;
        worst: StepGuardObservation['verdict'];
        worstRuleIds: readonly string[];
        beyondCustomTools: boolean;
        /** Someone else changed the session's tools, MCP servers or spend cap mid-run (Step 5H). */
        sessionEdited: boolean;
        /** The stop is draining the session: no latch may cut the drain's own read. */
        draining: boolean;
        /**
         * ANOTHER WORKER TOOK THE RUN OVER (#5854, owner decision 2026-11-25):
         * this execution's lease lapsed and a successor claimed the run. The
         * successor reconnects to the session and continues in it, so this
         * execution leaves it exactly as it is: no answer, no interrupt, no
         * delete. Its own writes are already fenced.
         */
        handedOver: boolean;
        /** The session's history holds an interrupt an earlier attempt sent (a reconnect refuses it). */
        stoppedEarlier: boolean;
        /** The session's history is longer than one bounded read (refused by name). */
        historyTruncated: boolean;
    } = {
        capHalt: null,
        killVerdict: null,
        killAfterCap: false,
        killUnreadable: false,
        operatorAborted: false,
        breakerOpen: false,
        breakerUnreadable: false,
        worst: 'CLEAN',
        worstRuleIds: [],
        beyondCustomTools: false,
        sessionEdited: false,
        draining: false,
        handedOver: false,
        stoppedEarlier: false,
        historyTruncated: false,
    };
    // Aborted by every stop: it ends the read of the stream, never a call the
    // stop itself makes (the interrupt, the drain, the delete).
    let streamController = new AbortController();
    const abortRead = (): void => {
        if (!state.draining) streamController.abort();
    };
    const seen = new Map<string, StepGuardObservation>();
    const origins = new Map<string, number>();
    let seq = fromSeq;
    let stepFailures = 0;
    let modelCalls = 0;

    const stopped = (): RunStop | null => {
        // A run handed to a successor refuses every call as an Abort would;
        // nothing it refuses is ever sent to the session.
        if (state.handedOver || state.operatorAborted) return { kind: 'OPERATOR_ABORT' };
        if (state.killVerdict || state.killUnreadable) return { kind: 'KILL' };
        if (state.breakerOpen || state.breakerUnreadable) return { kind: 'BREAKER' };
        if (state.capHalt) return { kind: 'CAP', halt: state.capHalt };
        if (state.worst !== 'CLEAN') return { kind: 'GUARD' };
        return null;
    };
    const isStopped = (): boolean =>
        stopped() !== null || state.beyondCustomTools || state.sessionEdited || state.stoppedEarlier || state.historyTruncated;

    const checkKill = async (): Promise<boolean> => {
        if (state.killVerdict || state.killUnreadable || state.operatorAborted || state.handedOver) return true;
        let found: KillVerdict | null;
        try {
            found = await resolveKillState(ctx.tenantId, ctx.agentId ?? null);
        } catch (err) {
            logger.warn('managed-agents: kill-switch read failed; stopping the run', {
                component: 'agentic',
                runId: run.runId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
            state.killUnreadable = true;
            abortRead();
            return true;
        }
        if (!found) {
            // AN OPERATOR'S ABORT STOPS THE RUN WHERE A KILL DOES (#5366).
            if (!(await isRunAborted(ctx, runId))) return false;
            // …and so does a lost lease. A lease ANOTHER worker now holds is a
            // takeover (#5854, 2026-11-25): the successor continues in this
            // run's session, so this execution must leave it untouched. A read
            // that fails is read as a takeover too: leaving a session alone is
            // recoverable (the reconciliation settles it once the run has
            // ended), and deleting a session a successor drives is not.
            if (await runLeaseTakenOver(ctx, runId).catch(() => true)) {
                state.handedOver = true;
                abortRead();
                return true;
            }
            state.operatorAborted = true;
            abortRead();
            return true;
        }
        recordAgentKillRefusal({ scope: found.scope, drill: ctx.agentId === KILL_SWITCH_DRILL_AGENT_ID });
        state.killAfterCap = state.capHalt !== null;
        state.killVerdict = found;
        abortRead();
        return true;
    };

    const checkBreaker = async (): Promise<boolean> => {
        if (!ctx.agentId) return false;
        try {
            const latch = await readBreakerLatch(ctx.tenantId, ctx.agentId);
            if (latch?.state !== 'OPEN') return false;
            state.breakerOpen = true;
        } catch (err) {
            logger.warn('managed-agents: circuit-breaker read failed; stopping the run', {
                component: 'agentic',
                runId: run.runId,
                error: err instanceof Error ? err.message : 'a non-Error value was thrown',
            });
            state.breakerUnreadable = true;
        }
        abortRead();
        return true;
    };

    const noteVerdict = (o: StepGuardObservation): void => {
        const prior = seen.get(o.toolCallId);
        seen.set(o.toolCallId, prior && RANK[prior.verdict] >= RANK[o.verdict] ? prior : o);
        if (RANK[o.verdict] > RANK[state.worst]) {
            state.worst = o.verdict;
            state.worstRuleIds = o.ruleIds;
        }
        if (o.verdict !== 'CLEAN') abortRead();
    };

    const binding: ToolRunBinding = {
        ctx,
        runId,
        budget,
        subagent: null,
        nextSeq: () => seq++,
        peekSeq: () => seq,
        stopped,
        stopAtCap: (halt) => {
            if (state.capHalt === null) state.capHalt = halt;
            abortRead();
        },
        checkKill,
        checkBreaker,
        takeVerdict: (id) => {
            const o = seen.get(id);
            seen.delete(id);
            return o;
        },
        noteOrigin: (id, stepSeq) => {
            origins.set(id, stepSeq);
        },
        originOf: (id) => origins.get(id),
        forgetOrigin: (id) => {
            origins.delete(id);
        },
        onFailure: () => {
            stepFailures += 1;
        },
        // A turn is one model call: the calls the model asked for in it are run
        // after its span ends, numbered by the calls ended so far.
        admitToolCall: () => turnCalls.admit('parent', modelCalls),
        // RUNS_DEFERRALS is false for this engine: admission refuses a version
        // naming deferred tools, so nothing here ever waits for a person.
        deferredTools: new Set<string>(),
        latchDeferral: () => {
            abortRead();
        },
    };

    // ── The call record a reconnecting segment reads (#5854, 2026-11-25) ───
    // The run's ONE checkpoint row, as the Tool Runner keeps it: every turn's
    // MODEL_CALL step points it at the session and the span (in the step's
    // own transaction), the call about to run is named in flight before it
    // reaches the funnel, and its result is kept once it settles. Only an
    // execution holding a run lease keeps one (`keepsCheckpoint`): only it is
    // retried or taken over. Null until this segment checkpoints a turn.
    let keptResults: KeptCallResult[] | null = null;
    const checkpointHooks: CallCheckpointHooks = {
        start: async (callId) => {
            if (keptResults === null) return;
            if (!(await markCallInFlight(ctx, runId, callId))) throw new Error(CALL_START_NOT_RECORDED_MESSAGE);
        },
        settle: async (callId, outcome) => {
            if (keptResults === null) return;
            keptResults = [...keptResults.filter((r) => r.id !== callId), keptResultOf(callId, outcome)];
            await keepCallResults(ctx, runId, sealKeptResults(keptResults)).catch((err) => {
                // The next write carries them whole: nothing is lost but this one.
                logger.warn('managed-agents: a call result was not kept in the checkpoint', {
                    component: 'agentic',
                    runId: run.runId,
                    error: err instanceof Error ? err.message : 'a non-Error value was thrown',
                });
            });
        },
    };

    // ── The offer, over the engine-neutral core, with this engine's prefix ──
    const queue = new SerialQueue(keepsCheckpoint(ctx) ? checkpointHooks : undefined);
    const offered = toolRunnerToolsFor(invocation, binding, {
        readOnly: def.readOnly === true,
        ...(def.profile ? { profileTools: def.profile.toolNames } : {}),
        observe: noteVerdict,
        queue,
        sourcePrefix: MANAGED_AGENTS_GUARD_SOURCE,
    });

    if (offered.tools.length === 0) {
        const settled = await updateRun(ctx, runId, {
            status: 'EMPTY_CATALOGUE',
            completedAt: new Date(),
            stepCount: seq,
            costTokens,
            errorMessage: emptyCatalogueMessage(MANAGED_AGENTS_PREFIX, {
                grantedTools: invocation.grantedTools,
                permittedTools: invocation.policyCard?.inForce.value.permittedTools ?? null,
                offeredTools: invocation.offeredTools,
                omitted: offered.omitted,
                ...(def.profile ? { profileTools: def.profile.toolNames } : {}),
            }),
        });
        if (!settled) return { status: 'ABORTED', stepFailures: 0 };
        return { status: 'EMPTY_CATALOGUE', stepFailures: 1 };
    }

    // Asked BEFORE the session exists: after it, the transfer has happened.
    const transferRefusal = externalResidencyRefusal({
        providerId: route.providerId,
        offered: offered.externalConnections.map((c) => ({
            name: c.connectionName,
            connectionId: c.connectionId,
            connectionName: c.connectionName,
            reachesBusinessSystem: c.reachesBusinessSystem,
        })),
        acknowledgement: route.externalAiAcknowledgement,
        enginePrefix: MANAGED_AGENTS_PREFIX,
    });
    if (transferRefusal) {
        const status = await failRun(ctx, runId, transferRefusal.message);
        return { status, stepFailures: 0 };
    }

    const skillTool = activateSkillTool(binding, skills, queue);
    const runnables = new Map([...offered.tools, ...(skillTool ? [skillTool] : [])].map((t) => [t.name, t]));

    const pinned = route.provision;

    // ── A RETRIED OR TAKEN-OVER SEGMENT RECONNECTS (#5854, 2026-11-25) ──────
    // Owner decision: a segment the worker retries, or another worker takes
    // over, RECONNECTS to the session it created and continues there. The
    // worker says where the segment began (`runSegmentFromSeq`); its own part
    // of the ledger names the session. The NEWEST session the segment created
    // (one a segment's start found unrecorded is never continued: the opening
    // never reached it) decides: none, and this attempt creates one as every
    // first attempt does; one nobody settled, and it is reconnected to; one an
    // earlier attempt deleted or kept, and the run is refused by name: a
    // segment never gets a second session. Read before anything is settled
    // here, so the segment's start cannot confuse its own settlements for the
    // dead attempt's.
    let reconnectTo: SegmentSession | null = null;
    let segmentVerdicts: ReadonlyArray<{ seq: number; verdict: 'FLAGGED' | 'QUARANTINED'; ruleIds: readonly string[] }> = [];
    let recordedSpanIds: ReadonlySet<string> = new Set();
    if (ctx.runSegmentFromSeq !== undefined) {
        const segment = await readSegmentLedger(ctx, runId, ctx.runSegmentFromSeq);
        if (segment.truncated) {
            const status = await failRun(ctx, runId, reconnectRefusalMessage('LEDGER_TRUNCATED'));
            return { status, stepFailures: 0 };
        }
        const own = segment.sessions.filter((x) => !x.foundUnrecorded);
        const newest = own.length > 0 ? own[own.length - 1] : null;
        if (newest && newest.latest !== 'SESSION_CREATED') {
            const status = await failRun(ctx, runId, reconnectRefusalMessage('SESSION_SETTLED_EARLIER'));
            return { status, stepFailures: 0 };
        }
        if (newest && newest.connectionId !== route.connectionId) {
            // Left for the reconciliation, which reaches it through its own
            // connection once this run has settled.
            const status = await failRun(ctx, runId, reconnectRefusalMessage('WORKSPACE_CHANGED'));
            return { status, stepFailures: 0 };
        }
        if (newest) {
            reconnectTo = newest;
            segmentVerdicts = segment.verdicts.filter((v) => v.seq > newest.createdSeq);
            recordedSpanIds = segment.spanEventIds;
        }
    }
    const reconnecting = reconnectTo !== null;
    // Log fields are read off this object, so each value's name is its own.
    const segmentFacts = { reconnecting } as const;
    /** A refusal of a reconnecting segment settles its session first: the run ends here. */
    const refuseAfterSession = async (refusal: string, stepFailures = 0): Promise<RunDriverOutcome> => {
        if (reconnectTo) await settleSession(ctx, runId, client, reconnectTo.sessionId, route, binding, true);
        const status = await failRun(ctx, runId, refusal);
        return { status, stepFailures };
    };

    // ── A DEAD SEGMENT'S UNRECORDED SESSION (Step 5H, #5854) ────────────────
    // A worker that died after `sessions.create` answered and before
    // `SESSION_CREATED` was written left a session no ledger names, which only
    // a purge or a connection removal would find. This run is re-run in a new
    // segment, so its start looks first: the pinned agent's sessions, by the
    // crash window's own listing, taken only when their metadata names this
    // tenant AND this run and the run's ledger does not hold them. Each is
    // recorded, then settled. Never throws, and never blocks the run: what it
    // cannot reach is left to the purge and a connection removal, as before.
    await settleUnrecordedSessions(ctx, runId, client, pinned.anthropicAgentId, route, binding, 'AT_SEGMENT_START');

    // ── DRIFT: the agent at the pinned version, before the session is used ──
    // Asked again by a reconnecting segment (#5854): a Console edit made while
    // the worker was down refuses the run rather than continue under it.
    let agent: RetrievedAgent;
    try {
        agent = (await client.beta.agents.retrieve(pinned.anthropicAgentId, { version: pinned.anthropicAgentVersion })) as unknown as RetrievedAgent;
    } catch (err) {
        logger.warn('managed-agents: the provisioned agent could not be read', {
            component: 'agentic',
            runId: run.runId,
            providerStatus: providerCodeOf(err).status,
            providerErrorType: providerCodeOf(err).type,
        });
        return refuseAfterSession(asReconnecting(AGENT_UNREADABLE_MESSAGE, reconnecting));
    }
    const found = { drift: agentDrift(agent, pinned) };
    if (found.drift) {
        logger.warn('managed-agents: the provisioned agent drifted; refusing the run', { component: 'agentic', runId: run.runId, drift: found.drift, reconnecting: segmentFacts.reconnecting });
        return refuseAfterSession(agentDriftedMessage(found.drift, reconnecting));
    }

    // ── THE ENVIRONMENT, read again before the session is used (#5854) ─────
    // The same rule as the agent: compared with what Inflect WROTE. A row from
    // before the hash was recorded is not refused for that: its first run
    // records what Inflect wrote (`writtenEnvironmentHash`), never what it
    // read, and compares as every later run will.
    let environment: RetrievedEnvironment;
    try {
        environment = (await client.beta.environments.retrieve(pinned.environmentId)) as unknown as RetrievedEnvironment;
    } catch (err) {
        logger.warn('managed-agents: the provisioned environment could not be read', {
            component: 'agentic',
            runId: run.runId,
            providerStatus: providerCodeOf(err).status,
            providerErrorType: providerCodeOf(err).type,
        });
        return refuseAfterSession(asReconnecting(ENVIRONMENT_UNREADABLE_MESSAGE, reconnecting));
    }
    const environmentHash = pinned.environmentHash ?? writtenEnvironmentHash(route.connectionId);
    if (pinned.environmentHash === null) {
        await recordEnvironmentHashOnFirstUse(ctx, pinned.profileVersionId, route.connectionId, environmentHash);
    }
    const environmentFound = { drift: environmentDrift(environment, { environmentId: pinned.environmentId, environmentHash }) };
    if (environmentFound.drift) {
        logger.warn('managed-agents: the provisioned environment drifted; refusing the run', {
            component: 'agentic',
            runId: run.runId,
            drift: environmentFound.drift,
            reconnecting: segmentFacts.reconnecting,
        });
        return refuseAfterSession(environmentDriftedMessage(environmentFound.drift, reconnecting));
    }

    const system = sessionSystemFor(def, skillCatalogueText(skills.documents));
    // Everything Inflect sends the session, in order: the decision rows' input.
    const sent: unknown[] = [];
    const inflectSent = (): InflectSentInput => ({
        basis: 'INFLECT_SENT',
        agent: { id: pinned.anthropicAgentId, version: pinned.anthropicAgentVersion },
        system,
        sent: [...sent],
    });
    const opening = { type: 'user.message' as const, content: [{ type: 'text' as const, text: message }] };

    let sessionId: string;
    /** What the `SESSION_CREATED` step records, for a session this attempt created. */
    let createdSessionFacts: Record<string, unknown> | null = null;
    /** The call record a reconnecting segment answers the session's open calls from. */
    let reconnectCheckpoint: OpenedSessionCheckpoint | null = null;
    if (reconnectTo) {
        sessionId = reconnectTo.sessionId;
        // ── THE SESSION, READ BEFORE IT IS CONTINUED ────────────────────────
        // Gone (404) or ended by Anthropic, it is not continued, and no second
        // session is made for the segment. A gone one is recorded so, so the
        // reconciliation does not chase it; a terminated one is deleted.
        // Log fields are read off this object, so each value's name is its own.
        const sessionRead = { status: '' };
        try {
            sessionRead.status = (await client.beta.sessions.retrieve(sessionId)).status;
        } catch (err) {
            const code = providerCodeOf(err);
            logger.warn('managed-agents: the session to reconnect to could not be read', {
                component: 'agentic', runId: run.runId, providerStatus: code.status, providerErrorType: code.type,
            });
            if (code.status === 404) {
                await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_DELETED', {
                    sessionId, connectionId: route.connectionId, foundGone: true,
                }).catch(() => undefined);
                const status = await failRun(ctx, runId, reconnectRefusalMessage('SESSION_GONE'));
                return { status, stepFailures: 1 };
            }
            // Not known to be gone: left as the ledger has it, for the
            // reconciliation once the run has settled.
            const status = await failRun(ctx, runId, reconnectRefusalMessage('SESSION_UNREADABLE'));
            return { status, stepFailures: 1 };
        }
        if (sessionRead.status === 'terminated') return refuseAfterSession(reconnectRefusalMessage('SESSION_TERMINATED'), 1);
        // ── THE CALL RECORD: what ran, and what was running ─────────────────
        const stored = keepsCheckpoint(ctx) ? await readCheckpoint(ctx, runId) : null;
        const opened = stored === 'UNREADABLE' ? null : openSessionCheckpoint(stored, sessionId);
        if (!opened || !opened.ok) return refuseAfterSession(reconnectRefusalMessage('CHECKPOINT_UNREADABLE'), 1);
        reconnectCheckpoint = opened.checkpoint;
        // A VERDICT THE DEAD ATTEMPT LATCHED and died before acting on: the run
        // stops as that attempt would have, before a kept result it flagged
        // could reach the model.
        for (const v of segmentVerdicts) {
            noteVerdict({ toolCallId: `reconnect-ledger:${v.seq}`, tool: 'ledger', slice: 'result', verdict: v.verdict, ruleIds: v.ruleIds });
        }
        logger.warn('managed-agents: reconnecting to the session a retried segment created', {
            component: 'agentic',
            runId: run.runId,
            sessionStatus: sessionRead.status,
            keptResults: reconnectCheckpoint.kept.size,
            callInFlight: reconnectCheckpoint.inFlightCallId !== null,
        });
    } else {
        // What the run has LEFT, not its whole cap (Step 5H, #4169): a resumed
        // run's earlier segments spent part of it, and each segment's session is a
        // new one with a budget of its own, so a whole-cap backstop per session
        // would let a run's sessions together spend its cap once per segment.
        const sessionBudget = sessionBudgetFor({
            model: route.model,
            tokensLimit: budget.remaining('TOKENS'),
            runtimeMsLimit: budget.remaining('RUNTIME_MS'),
        });
        if (!sessionBudget) {
            const status = await failRun(ctx, runId, MODEL_UNPRICED_MESSAGE);
            return { status, stepFailures: 0 };
        }

        // ── The session ─────────────────────────────────────────────────────
        // A refusal is SETTLED with the provider's codes, never thrown (Step 5H,
        // #4169): the SDK's error message carries the response body, and a throw
        // would put it in the worker's `job failed` log line and BullMQ's stored
        // failure, then retry the run into another session create.
        try {
            const session = await client.beta.sessions.create({
                agent: {
                    type: 'agent_with_overrides',
                    id: pinned.anthropicAgentId,
                    version: pinned.anthropicAgentVersion,
                    system,
                },
                environment_id: pinned.environmentId,
                budget: sessionBudget,
                metadata: sessionMetadataFor(ctx.tenantId, runId),
            }, SEND_ONCE);
            sessionId = session.id;
        } catch (err) {
            const code = providerCodeOf(err);
            logger.warn('managed-agents: the session could not be created', {
                component: 'agentic',
                runId: run.runId,
                providerStatus: code.status,
                providerErrorType: code.type,
            });
            // NO ANSWER IS NOT "NOT CREATED" (Step 5H, #4169). The request may have
            // reached Anthropic and made a session whose id never came back, and
            // nothing would record it. Find it as the purge's crash window does:
            // sessions listed by the pinned agent only, taken only when their
            // metadata names this tenant AND this run. Each is recorded, then
            // settled like any other (deleted, or recorded kept). Never throws.
            if (code.status === null) {
                await settleUnrecordedSessions(ctx, runId, client, pinned.anthropicAgentId, route, binding, 'AFTER_LOST_CREATE');
            }
            const status = await failRun(ctx, runId, sessionNotCreatedMessage(code));
            return { status, stepFailures: 1 };
        }
        createdSessionFacts = {
            sessionId,
            connectionId: route.connectionId,
            workspaceKind: route.workspaceKind,
            agentId: pinned.anthropicAgentId,
            agentVersion: pinned.anthropicAgentVersion,
            budgetCents: sessionBudget.max_list_cost.amount,
        };
    }
    // The wall clock: the read of the stream stops at the run's deadline.
    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    const armWallClock = (): void => {
        const remaining = budget.remaining('RUNTIME_MS');
        wallTimer = setTimeout(() => {
            const halt = budget.charge('RUNTIME_MS', 0);
            if (halt) binding.stopAtCap(halt);
            else armWallClock();
        }, remaining + 50);
        wallTimer.unref?.();
    };

    // ── The stream ──────────────────────────────────────────────────────────
    const handled = new Set<string>();
    /** Every custom call seen, in order; removed once answered. */
    const pending = new Map<string, { name: string; input: unknown; event: AnyEvent }>();
    const answered = new Set<string>();
    let turnText: string[] = [];
    let turnTextVerdict: StepGuardObservation['verdict'] = 'CLEAN';
    let turnTextRuleIds: readonly string[] = [];
    let end: SessionEnd | null = null;
    let streamLost = false;
    let failure: string | null = null;
    /** The first MODEL_CALL a reconnected segment records says so (#5854). */
    let reconnectMark: { sessionId: string; afterEventId: string | null } | null = null;
    /** The reconnect's history replay is still to run (once, before anything is sent). */
    let segmentReplayPending = reconnecting;
    /** What a reconnect sends when the stream opens: the opening it never sent, or its open calls' answers. */
    let reconnectOutbox: { opening: boolean; answers: readonly ReconnectAnswer[] } | null = null;

    const answer = async (results: Array<{ id: string; text: string; isError: boolean }>, interrupt: boolean): Promise<void> => {
        const fresh = results.filter((r) => !answered.has(r.id));
        if (fresh.length === 0 && !interrupt) return;
        const events = [
            ...fresh.map((r) => ({
                type: 'user.custom_tool_result' as const,
                custom_tool_use_id: r.id,
                is_error: r.isError,
                content: [{ type: 'text' as const, text: r.text }],
            })),
            ...(interrupt ? [{ type: 'user.interrupt' as const }] : []),
        ];
        for (const r of fresh) {
            answered.add(r.id);
            pending.delete(r.id);
        }
        await client.beta.sessions.events.send(sessionId, { events }, SEND_ONCE);
        for (const e of events) sent.push(e);
    };

    /** Run the turn's queued calls, one at a time, each answered once. */
    const runQueuedCalls = async (): Promise<void> => {
        for (const [id, call] of [...pending.entries()]) {
            if (answered.has(id) || isStopped()) return;
            const runnable = runnables.get(call.name);
            if (!runnable) {
                // A name the run was not offered. Answered with our sentence,
                // never the name the model sent.
                await answer([{ id, text: NOT_OFFERED_TOOL_RESULT, isError: true }], false);
                continue;
            }
            // Built as the checkpoint keeps it (`keptResultOf`), so a result a
            // reconnecting segment sends as kept is exactly this answer (#5854).
            let result: KeptCallResult;
            try {
                const out = await runnable.run(asToolArgs(call.input), {
                    toolUse: call.event,
                    toolUseBlock: call.event,
                } as unknown as BetaToolRunContext);
                result = keptResultOf(id, { returned: out });
            } catch (err) {
                result = keptResultOf(id, { threw: err });
            }
            // A stop found AT the call (a cap, a guard verdict on its result, a
            // kill read when it finished): its result is not sent. The stop
            // answers it `is_error` with the run's own sentence.
            if (isStopped()) return;
            await answer([result], false);
        }
    };

    const onSpanEnd = async (ev: Extract<AnyEvent, { type: 'span.model_request_end' }>): Promise<void> => {
        modelCalls += 1;
        const u = ev.model_usage;
        const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
        const tokensIn = n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens);
        const tokensOut = n(u?.output_tokens);
        costTokens += tokensIn + tokensOut;
        const input = inflectSent();
        const decisionDigest = computeInputDigest(input);
        const text = turnText.join('\n');
        const stepSeq = binding.nextSeq();
        const mark = reconnectMark;
        reconnectMark = null;
        // THE TURN'S CHECKPOINT (#5854, 2026-11-25), in the step's own
        // transaction: it points at this session and this span, with no result
        // kept yet and nothing in flight. Only a leased execution keeps one.
        const turnCheckpoint = keepsCheckpoint(ctx)
            ? (() => {
                  const pointer = sealSessionCheckpoint({ sessionId, spanEventId: ev.id });
                  const results = sealKeptResults([]);
                  return writeTurnCheckpointInTx(ctx, runId, {
                      transcriptJson: pointer.json,
                      transcriptHash: pointer.hash,
                      resultsJson: results.json,
                      resultsHash: results.hash,
                      atSeq: stepSeq,
                      elapsedMs: Math.max(Date.now() - runStartMs, 0),
                      costTokens,
                  });
              })()
            : undefined;
        await recordStep(ctx, runId, stepSeq, 'MODEL_CALL', {
            status: ev.is_error ? 'FAILED' : 'DONE',
            label: def.key,
            tokens: tokensIn + tokensOut,
            ...(turnText.length > 0 ? { guardVerdict: turnTextVerdict, guardRuleIds: turnTextRuleIds } : {}),
            input: {
                modelCalls: 1,
                decisionDigest,
                // Decision 3: the digest covers what Inflect SENT, and the call's
                // own prompt is held in the customer's workspace.
                inputBasis: 'INFLECT_SENT',
                spanDerived: true,
                model: route.model,
                spanEventId: ev.id,
                // Whose workspace the call ran in (Step 6b): a HOSTED call's
                // tokens are Inflect's to pay, recorded per tenant here and in
                // the run's `costTokens`.
                workspace: route.workspaceKind,
                // The first model call of a RECONNECTED segment (#5854,
                // 2026-11-25) says so, and from which session event it picked up.
                ...(mark ? { reconnectedToSession: mark.sessionId, reconnectedAfterEventId: mark.afterEventId } : {}),
            },
        }, undefined, turnCheckpoint);
        if (turnCheckpoint) keptResults = [];
        await recordManagedAgentsDecision(
            ctx,
            runId,
            def,
            input,
            text.length > 0 && turnTextVerdict === 'CLEAN' ? text : null,
            { tokensIn, tokensOut },
            route.model,
        );
        await updateRun(ctx, runId, { costTokens, stepCount: seq });
        turnText = [];
        turnTextVerdict = 'CLEAN';
        turnTextRuleIds = [];

        // The caps, charged after the call as the Tool Runner charges them, and
        // before any tool of this turn runs.
        if (isStopped()) return;
        const halt =
            budget.charge('STEPS', 1)
            ?? budget.charge('TOKENS', costTokens - budget.used('TOKENS'))
            ?? budget.charge('RUNTIME_MS', 0);
        if (halt) binding.stopAtCap(halt);
        if (!isStopped()) await checkBreaker();
    };

    const handle = async (ev: AnyEvent, replaying = false): Promise<void> => {
        // The kill switch and the run's own status, on EVERY event handled.
        // A reconnect's replay of the history reads them once around it.
        if (!replaying) await checkKill();
        switch (ev.type) {
            case 'agent.message': {
                const text = messageText(ev.content);
                if (text.length === 0) return;
                turnText.push(text);
                const outcome = await guardEgress(ctx, text, {
                    source: `${MANAGED_AGENTS_GUARD_SOURCE}-model-output:${runId}:${modelCalls + 1}`,
                });
                const verdict = stepVerdictOf(outcome);
                if (RANK[verdict] > RANK[turnTextVerdict]) {
                    turnTextVerdict = verdict;
                    turnTextRuleIds = outcome.ruleIds;
                }
                if (verdict !== 'CLEAN') {
                    noteVerdict({ toolCallId: `model-output:${ev.id}`, tool: 'model-output', slice: 'result', verdict, ruleIds: outcome.ruleIds });
                }
                return;
            }
            case 'agent.custom_tool_use':
                if (!answered.has(ev.id)) pending.set(ev.id, { name: ev.name, input: ev.input, event: ev });
                return;
            case 'span.model_request_end':
                await onSpanEnd(ev);
                // A replayed turn's calls are never run: they are answered by
                // the reconnect's rule once the history is read (#5854).
                if (!replaying && !isStopped()) await runQueuedCalls();
                return;
            case 'agent.tool_use':
            case 'agent.mcp_tool_use':
                // Never on an agent Inflect provisioned: custom tools only.
                state.beyondCustomTools = true;
                abortRead();
                return;
            case 'session.updated':
                // Inflect never updates a session (the client refuses the
                // route), so this is someone with the workspace's key. A new
                // `agent` (tools, MCP servers) or a changed or removed `budget`
                // is a session the drift check never saw: stop. A title or
                // metadata alone reaches nothing.
                if (ev.agent !== undefined || ev.budget !== undefined) {
                    state.sessionEdited = true;
                    abortRead();
                }
                return;
            case 'session.status_idle': {
                const reason = ev.stop_reason?.type;
                if (reason === 'requires_action') {
                    if (!replaying && !isStopped()) await runQueuedCalls();
                    return;
                }
                end = reason === 'end_turn' || reason === undefined ? 'end_turn' : reason;
                return;
            }
            case 'session.status_terminated':
                if (end === null) end = 'terminated';
                return;
            case 'session.error':
                logger.warn('managed-agents: the session reported an error', { component: 'agentic', runId: run.runId, eventId: ev.id });
                return;
            default:
                return;
        }
    };

    /** Handle an event once. Returns whether it was new. */
    const processEvent = async (ev: AnyEvent): Promise<boolean> => {
        const id = (ev as { id?: unknown }).id;
        if (typeof id !== 'string' || handled.has(id)) return false;
        handled.add(id);
        await handle(ev);
        return true;
    };
    const awaitsUs = (ev: AnyEvent): boolean =>
        ev.type === 'session.status_idle' && ev.stop_reason?.type === 'requires_action';

    /**
     * THE RECONNECT'S REPLAY (#5854, owner decision 2026-11-25), once, over
     * the session's whole history before anything is sent:
     *
     *   1. an interrupt in the history means an earlier attempt STOPPED the
     *      session: it is not continued (`SESSION_STOPPED_EARLIER`);
     *   2. every event up to the last span the ledger recorded was accounted
     *      for by the attempt that recorded it: only its bookkeeping is redone
     *      (the turn count, the calls still open, a reach beyond custom tools
     *      or an edit of the session, which stop the run as they would have);
     *   3. every event after it is handled as the stream would have handled it
     *      (a model call recorded, with the reconnect named on it; text
     *      scanned), except that no call is run;
     *   4. each custom-tool call with no result event is answered by the Tool
     *      Runner's rule (`answerOpenCalls`): kept, `TOOL_CALL_OUTCOME_UNKNOWN`
     *      or `TOOL_CALL_NOT_RUN`. The last two are FAILED steps, charged one
     *      STEPS each. None is run again.
     *
     * The answers, or the opening message the dead attempt never sent, go out
     * when the stream opens (`reconnectOutbox`).
     */
    const replayForReconnect = async (events: readonly AnyEvent[]): Promise<void> => {
        const plan = planReconnect(events as unknown as readonly HistoryEvent[], recordedSpanIds);
        if (plan.stoppedEarlier) {
            state.stoppedEarlier = true;
            abortRead();
            return;
        }
        for (const id of plan.answered) answered.add(id);
        reconnectMark = { sessionId, afterEventId: plan.lastEventId };
        if (plan.openingSent) sent.push(opening);
        for (const [i, ev] of events.entries()) {
            const id = (ev as { id?: unknown }).id;
            if (typeof id !== 'string' || handled.has(id)) continue;
            handled.add(id);
            if (i <= plan.accountedThrough) {
                if (ev.type === 'agent.message') continue;
                if (ev.type === 'span.model_request_end') {
                    modelCalls += 1;
                    turnText = [];
                    turnTextVerdict = 'CLEAN';
                    turnTextRuleIds = [];
                    continue;
                }
            }
            await handle(ev, true);
            if (end !== null || isStopped()) return;
        }
        if (await checkKill()) return;
        const answers = answerOpenCalls(
            plan.openCalls.filter((c) => !answered.has(c.id)),
            reconnectCheckpoint ?? { kept: new Map(), inFlightCallId: null },
        );
        for (const a of answers) {
            if (a.answer === 'KEPT') continue;
            const halt = budget.charge('STEPS', 1);
            if (halt) {
                binding.stopAtCap(halt);
                return;
            }
            stepFailures += 1;
            await recordStep(ctx, runId, binding.nextSeq(), 'TOOL_CALL', {
                ...(runnables.has(a.name) ? { toolCalled: a.name } : {}),
                status: 'FAILED',
                label: a.answer === TOOL_CALL_OUTCOME_UNKNOWN ? 'tool-call-outcome-unknown' : 'tool-call-not-run',
                output: { outcome: a.answer, reconnectedToSession: sessionId },
            });
        }
        logger.info('managed-agents: reconnected to the session', {
            component: 'agentic',
            runId: run.runId,
            historyEvents: events.length,
            callsKept: answers.filter((a) => a.answer === 'KEPT').length,
            callsOutcomeUnknown: answers.filter((a) => a.answer === TOOL_CALL_OUTCOME_UNKNOWN).length,
            callsNotRun: answers.filter((a) => a.answer !== 'KEPT' && a.answer !== TOOL_CALL_OUTCOME_UNKNOWN).length,
            openingSent: plan.openingSent,
        });
        reconnectOutbox = { opening: !plan.openingSent, answers };
    };

    /**
     * Read the stream until the session ends, the run stops or it drops.
     * Returns false on a DROP: a failure to open the stream, to read the
     * history or to read the next event. A failure while HANDLING an event (a
     * tool result that could not be sent, a ledger write) is not a drop: it
     * propagates, and the run fails and settles.
     */
    const readStream = async (onOpen: () => Promise<void>, reconnecting: boolean): Promise<boolean> => {
        const dropped = (err: unknown): false => {
            logger.warn('managed-agents: the event stream dropped; reconnecting', { component: 'agentic', runId: run.runId, providerStatus: providerCodeOf(err).status, providerErrorType: providerCodeOf(err).type });
            return false;
        };
        let stream: AsyncIterable<AnyEvent>;
        try {
            stream = await client.beta.sessions.events.stream(sessionId, {}, { signal: streamController.signal });
        } catch (err) {
            return isStopped() || dropped(err);
        }
        if (reconnecting) {
            // The stream does not replay: read the whole history, dedupe by id.
            // Paged and bounded (#5854): a history past the cap is refused by
            // name, never continued on part of it.
            const history = await readSessionHistory(client, sessionId, streamController.signal);
            if (history.kind === 'TRUNCATED') {
                state.historyTruncated = true;
                abortRead();
                return true;
            }
            if (history.kind === 'FAILED') return isStopped() || dropped(history.error);
            if (segmentReplayPending) {
                segmentReplayPending = false;
                await replayForReconnect(history.events);
                if (end !== null || isStopped()) return true;
            } else {
                for (const ev of history.events) {
                    await processEvent(ev);
                    if (end !== null || isStopped()) return true;
                }
            }
        }
        await onOpen();
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
            let next: IteratorResult<AnyEvent>;
            try {
                next = await iterator.next();
            } catch (err) {
                return isStopped() || dropped(err);
            }
            if (next.done) return end !== null || isStopped();
            await processEvent(next.value);
            if (end !== null || isStopped()) {
                await iterator.return?.();
                return true;
            }
        }
    };

    try {
        // The id, in the ledger, before anything else: a crash from here on
        // leaves a record Step 5c deletes by id, and a retry reconnects to.
        if (createdSessionFacts) await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_CREATED', createdSessionFacts);
        armWallClock();
        // A reconnecting segment has sent its opening already (or sends it from
        // the outbox): its first read replays the history instead.
        let first = !reconnecting;
        let reconnects = 0;
        // A reconnect that latched a stop before reading anything (a verdict
        // the dead attempt recorded) goes straight to the stop.
        while (!isStopped()) {
            // A thrown error here is a failure to drive the session, not a
            // drop: it reaches the catch below, and the run fails and settles.
            const done = await readStream(async () => {
                if (first) {
                    await client.beta.sessions.events.send(sessionId, { events: [opening] }, SEND_ONCE);
                    sent.push(opening);
                    first = false;
                    return;
                }
                const outbox = reconnectOutbox;
                reconnectOutbox = null;
                if (!outbox || isStopped()) return;
                if (outbox.opening) {
                    await client.beta.sessions.events.send(sessionId, { events: [opening] }, SEND_ONCE);
                    sent.push(opening);
                    return;
                }
                if (outbox.answers.length > 0) {
                    await answer(outbox.answers.map((a) => ({ id: a.id, text: a.text, isError: a.isError })), false);
                }
            }, !first);
            if (done || end !== null || isStopped()) break;
            reconnects += 1;
            if (reconnects > MAX_STREAM_RECONNECTS) {
                streamLost = true;
                break;
            }
        }

        // ── THE STOP: answer pending is_error, interrupt, drain to idle ──────
        // Not for a run handed to a successor (#5854): the session is its now.
        if ((isStopped() || streamLost) && end === null && !state.handedOver) {
            state.draining = true;
            for (let round = 0; round < MAX_STOP_ROUNDS && end === null; round += 1) {
                const unanswered = [...pending.keys()].filter((id) => !answered.has(id));
                await answer(unanswered.map((id) => ({ id, text: STOPPED_TOOL_RESULT, isError: true })), true);
                streamController = new AbortController();
                const drainTimer = setTimeout(() => streamController.abort(), STOP_DRAIN_TIMEOUT_MS);
                drainTimer.unref?.();
                const draining = { idleAwaiting: false };
                try {
                    const stream = await client.beta.sessions.events.stream(sessionId, {}, { signal: streamController.signal });
                    for await (const ev of client.beta.sessions.events.list(sessionId, {})) {
                        const fresh = await processEvent(ev);
                        if (end !== null) break;
                        if (fresh && awaitsUs(ev)) {
                            draining.idleAwaiting = true;
                            break;
                        }
                    }
                    if (end === null && !draining.idleAwaiting) {
                        for await (const ev of stream) {
                            const fresh = await processEvent(ev);
                            if (end !== null) break;
                            if (fresh && awaitsUs(ev)) {
                                draining.idleAwaiting = true;
                                break;
                            }
                        }
                    }
                } catch (err) {
                    logger.warn('managed-agents: the stop could not drain the session', { component: 'agentic', runId: run.runId, providerStatus: providerCodeOf(err).status, providerErrorType: providerCodeOf(err).type });
                } finally {
                    clearTimeout(drainTimer);
                }
                if (!draining.idleAwaiting) break;
            }
        }
    } catch (err) {
        const code = providerCodeOf(err);
        failure = code.status !== null ? `provider status ${code.status}${code.type ? ` (${code.type})` : ''}` : 'the session could not be driven';
        logger.error('managed-agents: the run failed', { component: 'agentic', runId: run.runId, providerStatus: code.status, providerErrorType: code.type });
    } finally {
        if (wallTimer) clearTimeout(wallTimer);
        // A run handed to a successor leaves the session to it (#5854); the
        // settle asks again before it touches the session, for a takeover this
        // execution never read.
        if (!state.handedOver) await settleSession(ctx, runId, client, sessionId, route, binding, end === null);
    }

    // ── Settlement ──────────────────────────────────────────────────────────
    await updateRun(ctx, runId, { costTokens, stepCount: seq });

    // Handed over: nothing lands (every write is fenced), and the worker
    // reports the lost lease (`executeFrom`), not this status.
    if (state.handedOver) return { status: 'ABORTED', stepFailures };
    if (state.operatorAborted) return { status: 'ABORTED', stepFailures };
    if (state.killVerdict) {
        const beside: CapBesideKill | null = state.capHalt
            ? { halt: state.capHalt, observedFirst: state.killAfterCap ? 'CAP' : 'KILL' }
            : null;
        const status = await haltRunAtKill(ctx, runId, state.killVerdict, killRefusalMessage(state.killVerdict.scope), beside, MANAGED_AGENTS_PREFIX);
        return { status, stepFailures };
    }
    if (state.killUnreadable) {
        const status = await failRun(ctx, runId, KILL_UNREADABLE_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.breakerOpen || state.breakerUnreadable) {
        const status = await failRun(ctx, runId, state.breakerOpen ? BREAKER_OPEN_MESSAGE : BREAKER_UNREADABLE_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.capHalt) {
        const status = await haltRunAtCap(ctx, runId, state.capHalt, null);
        return { status, stepFailures };
    }
    if (state.worst !== 'CLEAN') {
        if (state.worst === 'QUARANTINED' && ctx.agentId) await latchOnGuardBlock(ctx.tenantId, ctx.agentId, new Date());
        const status = await haltRunAtGuard(ctx, runId, state.worst, state.worstRuleIds, MANAGED_AGENTS_PREFIX);
        return { status, stepFailures };
    }
    if (state.beyondCustomTools) {
        const status = await failRun(ctx, runId, BEYOND_CUSTOM_TOOLS_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.sessionEdited) {
        const status = await failRun(ctx, runId, SESSION_EDITED_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.stoppedEarlier) {
        const status = await failRun(ctx, runId, reconnectRefusalMessage('SESSION_STOPPED_EARLIER'));
        return { status, stepFailures: stepFailures + 1 };
    }
    if (state.historyTruncated) {
        const status = await failRun(ctx, runId, SESSION_HISTORY_TRUNCATED_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (failure !== null) {
        const status = await failRun(ctx, runId, `${MANAGED_AGENTS_PREFIX}_run_failed: ${failure}`);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (streamLost) {
        const status = await failRun(ctx, runId, STREAM_LOST_MESSAGE);
        return { status, stepFailures: stepFailures + 1 };
    }
    // Typed through a function so the narrowing of `end` by the closures above survives.
    const sessionEnd = ((): SessionEnd | null => end)();
    if (sessionEnd !== null && sessionEnd !== 'end_turn') {
        const status = await failRun(ctx, runId, SESSION_STOP_REASONS[sessionEnd]);
        return { status, stepFailures: stepFailures + 1 };
    }
    if (modelCalls === 0) {
        const status = await failRun(ctx, runId, SESSION_STOP_REASONS.terminated);
        return { status, stepFailures: stepFailures + 1 };
    }
    const completed = await updateRun(ctx, runId, { status: 'COMPLETED', completedAt: new Date(), stepCount: seq, costTokens });
    if (!completed) return { status: 'ABORTED', stepFailures };
    return { status: 'COMPLETED', stepFailures };
}

/** A session's history, read whole, or why not. */
type SessionHistoryRead =
    | { readonly kind: 'READ'; readonly events: AnyEvent[] }
    | { readonly kind: 'TRUNCATED' }
    | { readonly kind: 'FAILED'; readonly error: unknown };

/**
 * A SESSION'S WHOLE HISTORY, PAGED AND BOUNDED (#5854, 2026-11-25): pages of
 * `SESSION_HISTORY_PAGE_SIZE` through the SDK's own cursor, oldest first, and
 * at most `SESSION_HISTORY_READ_CAP` events. One more is a TRUNCATION, a fact
 * the caller refuses by name rather than continue on part of the history. A
 * read that fails is a drop, as a failed stream is.
 */
async function readSessionHistory(client: Anthropic, sessionId: string, signal: AbortSignal): Promise<SessionHistoryRead> {
    const events: AnyEvent[] = [];
    try {
        for await (const ev of client.beta.sessions.events.list(sessionId, { limit: SESSION_HISTORY_PAGE_SIZE }, { signal })) {
            events.push(ev);
            if (events.length > SESSION_HISTORY_READ_CAP) return { kind: 'TRUNCATED' };
        }
    } catch (error) {
        return { kind: 'FAILED', error };
    }
    return { kind: 'READ', events };
}

/** One step recording the session's lifecycle: ids and codes, never content. */
async function recordSessionStep(
    ctx: RequestContext,
    runId: string,
    seq: number,
    lifecycle: SessionLifecycle,
    facts: Record<string, unknown>,
): Promise<void> {
    await recordStep(ctx, runId, seq, 'SYNTHESIS', sessionStepRecord(lifecycle, facts));
    // A HOSTED session's time is Inflect's to pay (#4173): it is counted
    // unknown from here until its usage is read at settle. A session in the
    // tenant's own workspace records nothing.
    if (lifecycle === 'SESSION_CREATED' && facts.workspaceKind === 'HOSTED') await openHostedSessionMeter(ctx, runId);
}

/**
 * When an unrecorded session of this run is looked for: at the start of every
 * segment (#5854), and after a `sessions.create` that got no answer (#4169).
 */
type UnrecordedSessionSearch = 'AT_SEGMENT_START' | 'AFTER_LOST_CREATE';

/**
 * The sessions of THIS run that no ledger step names (Step 5H): a create whose
 * answer the network lost (#4169), or one a dead segment's worker never got to
 * record (#5854). Listed through the clean-up's own crash-window call
 * (`listCrashWindow`, by the pinned agent, this tenant's metadata only), taken
 * only when the metadata names this run and the run's ledger does not already
 * hold the session, so a KEPT or a failed-delete session of an earlier segment
 * is left to the settle and the reconciliation that own it. Each one taken is
 * recorded `SESSION_CREATED`, then settled. Never throws: what it cannot reach
 * is left to the purge's and a connection removal's crash window.
 */
async function settleUnrecordedSessions(
    ctx: RequestContext,
    runId: string,
    client: Anthropic,
    agentId: string,
    route: ManagedAgentsRoute,
    binding: ToolRunBinding,
    search: UnrecordedSessionSearch,
): Promise<void> {
    // Log fields are read off this object, so each value's name is its own.
    const look = { search } as const;
    try {
        const listing = await listCrashWindow(client, agentId, ctx.tenantId, undefined);
        if (!listing.ok) {
            logger.warn('managed-agents: the agent\'s sessions could not be listed for an unrecorded session of this run', {
                component: 'agentic', runId: binding.runId, search: look.search, outcome: listing.outcome,
            });
            return;
        }
        const ours = listing.candidates.filter((c) => c.runId === runId);
        if (ours.length === 0) return;
        const ledger = await readRecordedSessionIds(ctx, runId);
        if (ledger.truncated) {
            logger.warn('managed-agents: the run\'s ledger is longer than one read; no unrecorded session is settled', {
                component: 'agentic', runId: binding.runId, search: look.search,
            });
            return;
        }
        for (const found of ours.filter((c) => !ledger.sessionIds.has(c.sessionId))) {
            await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_CREATED', {
                sessionId: found.sessionId,
                connectionId: route.connectionId,
                workspaceKind: route.workspaceKind,
                agentId,
                foundUnrecorded: look.search,
            });
            await settleSession(ctx, runId, client, found.sessionId, route, binding, search === 'AT_SEGMENT_START');
        }
    } catch (err) {
        logger.error('managed-agents: an unrecorded session of this run could not be settled', {
            component: 'agentic',
            runId: binding.runId,
            search: look.search,
            error: err instanceof Error ? err.name : 'a non-Error value was thrown',
        });
    }
}

/**
 * THE SETTLE: delete the session, or record it kept (decision 4). Never
 * throws: it runs in `finally`, and a failure here must not hide the run's own
 * outcome. A deletion that fails is recorded with the provider's status, so
 * Step 5c's reconciliation finds it by id.
 */
async function settleSession(
    ctx: RequestContext,
    runId: string,
    client: Anthropic,
    sessionId: string,
    route: ManagedAgentsRoute,
    binding: ToolRunBinding,
    mayBeRunning: boolean,
): Promise<void> {
    // A SUCCESSOR HOLDS THE RUN (#5854, owner decision 2026-11-25): it has
    // reconnected, or will, to this session and continues in it. This
    // execution neither records it kept nor interrupts or deletes it. A read
    // that fails is read as a takeover: a session left alone is settled by the
    // reconciliation once the run has ended; one deleted under a successor is
    // a run lost. A context with no lease asks nothing.
    const handedOver = async (): Promise<boolean> => {
        if (!(await runLeaseTakenOver(ctx, runId).catch(() => true))) return false;
        logger.warn('managed-agents: another worker holds the run; its session is left to it', {
            component: 'agentic',
            runId: binding.runId,
        });
        return true;
    };
    try {
        if (await handedOver()) return;
        if (route.keepSessions) {
            await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_KEPT', { sessionId, connectionId: route.connectionId });
            return;
        }
        // Anthropic refuses a delete while the session runs, and its status
        // lags the stream's idle event: poll until it has left `running`. A
        // session a thrown error left running is interrupted first. The last
        // read is also the session's usage (#4173): unknown until one answers.
        let usage: HostedSessionUsageRead = { ok: false, reason: 'READ_FAILED' };
        for (let i = 0; i < SETTLE_POLL_ATTEMPTS; i += 1) {
            let status: string;
            try {
                const read = await client.beta.sessions.retrieve(sessionId);
                status = read.status;
                usage = sessionUsageFrom(read);
            } catch {
                usage = { ok: false, reason: 'READ_FAILED' };
                break;
            }
            if (status !== 'running' && status !== 'rescheduling') break;
            if (i === 0 && mayBeRunning) {
                try {
                    await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] }, SEND_ONCE);
                } catch {
                    // The delete below says whether it worked.
                }
            }
            await wait(SETTLE_POLL_MS);
        }
        // Asked again right before the one write that cannot be undone.
        if (await handedOver()) return;
        // A HOSTED session's time, recorded BEFORE the delete, which then runs
        // whatever this recorded: it never throws, and an unknown is recorded
        // as unknown, never as zero (#4173). The customer's own is not ours.
        if (route.workspaceKind === 'HOSTED') await meterHostedSession(ctx, runId, usage);
        try {
            await client.beta.sessions.delete(sessionId);
            await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_DELETED', { sessionId, connectionId: route.connectionId });
        } catch (err) {
            const code = providerCodeOf(err);
            logger.error('managed-agents: the session could not be deleted', { component: 'agentic', runId: binding.runId, providerStatus: code.status, providerErrorType: code.type });
            await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_DELETE_FAILED', {
                sessionId,
                connectionId: route.connectionId,
                providerStatus: code.status,
                providerErrorType: code.type,
            });
        }
    } catch (err) {
        logger.error('managed-agents: the session settle could not be recorded', {
            component: 'agentic',
            runId: binding.runId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
    }
}
