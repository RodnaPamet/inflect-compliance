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
 * `runGuardedTool`; the business-data transfer gate (#3872); and the DRIFT
 * CHECK: the agent is read at the version the profile pinned, and a `system`
 * or `tools` that no longer hashes to what Inflect wrote refuses the run
 * `AGENT_DRIFTED`. Every refusal settles the run with a named reason and
 * creates nothing at Anthropic.
 *
 * ── THE SESSION ─────────────────────────────────────────────────────────────
 *
 * Created with `agent_with_overrides` at the pinned version, whose `system`
 * override is the ONE place the tenant's instructions are sent; the
 * connection's environment; a dollar `budget` derived from the run's caps at
 * the tier's list price (`sessionBudgetFor`), a backstop behind the run's own
 * token count; and metadata naming the tenant and the run by id. The session
 * id is written to the ledger AT ONCE (`SESSION_CREATED`), so a crash leaves a
 * record Step 5c can clean up by id.
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
import { activateSkillTool, skillCatalogueText, type RunSkills } from '@/lib/agentic/tool-runner/skills';
import {
    SerialQueue,
    TurnCallCounter,
    toolRunnerToolsFor,
    type RunStop,
    type ToolRunBinding,
} from '@/lib/agentic/tool-runner/tools';
import { readTurnCaps } from '@/lib/agentic/turn-caps-policy';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { recordAgentKillRefusal } from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';
import { recordWorkflowContextIntegrityHalt } from '@/lib/observability/metrics';

import {
    MANAGED_AGENTS_GUARD_SOURCE,
    MANAGED_AGENTS_PREFIX,
    agentDrift,
    sessionBudgetFor,
    sessionMetadataFor,
    sessionSystemFor,
    type RetrievedAgent,
} from './definition';
import { recordManagedAgentsDecision, type InflectSentInput } from './model-decision';
import { sessionStepRecord, type SessionLifecycle } from './session-ledger';
import type { ProvisionRecord } from './store';

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

export function agentDriftedMessage(drift: string): string {
    return (
        `${AGENT_DRIFTED_PREFIX}: the agent in your Anthropic workspace no longer matches what Inflect provisioned for `
        + `this profile version (${drift}). Nothing was sent. Someone may have edited it in the Anthropic Console; `
        + 'approve the version again to re-provision it.'
    );
}

export const AGENT_UNREADABLE_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_agent_unreadable: the agent this profile version was provisioned as could not be read `
    + 'from your Anthropic workspace, so its configuration could not be checked. Nothing was sent.';

export const MODEL_UNPRICED_MESSAGE =
    `${MANAGED_AGENTS_PREFIX}_model_unpriced: no list price is known for this profile's model, so no spend cap could `
    + 'be set on the session. Nothing was sent.';

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
    /** Decision 4. */
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
        /** The stop is draining the session: no latch may cut the drain's own read. */
        draining: boolean;
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
        draining: false,
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
        if (state.operatorAborted) return { kind: 'OPERATOR_ABORT' };
        if (state.killVerdict || state.killUnreadable) return { kind: 'KILL' };
        if (state.breakerOpen || state.breakerUnreadable) return { kind: 'BREAKER' };
        if (state.capHalt) return { kind: 'CAP', halt: state.capHalt };
        if (state.worst !== 'CLEAN') return { kind: 'GUARD' };
        return null;
    };
    const isStopped = (): boolean => stopped() !== null || state.beyondCustomTools;

    const checkKill = async (): Promise<boolean> => {
        if (state.killVerdict || state.killUnreadable || state.operatorAborted) return true;
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

    // ── The offer, over the engine-neutral core, with this engine's prefix ──
    const queue = new SerialQueue();
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

    // ── DRIFT: the agent at the pinned version, before the session exists ───
    const pinned = route.provision;
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
        const status = await failRun(ctx, runId, AGENT_UNREADABLE_MESSAGE);
        return { status, stepFailures: 0 };
    }
    const found = { drift: agentDrift(agent, pinned) };
    if (found.drift) {
        logger.warn('managed-agents: the provisioned agent drifted; refusing the run', { component: 'agentic', runId: run.runId, drift: found.drift });
        const status = await failRun(ctx, runId, agentDriftedMessage(found.drift));
        return { status, stepFailures: 0 };
    }

    const sessionBudget = sessionBudgetFor({
        model: route.model,
        tokensLimit: caps.TOKENS.limit,
        runtimeMsLimit: caps.RUNTIME_MS.limit,
    });
    if (!sessionBudget) {
        const status = await failRun(ctx, runId, MODEL_UNPRICED_MESSAGE);
        return { status, stepFailures: 0 };
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

    // ── The session ─────────────────────────────────────────────────────────
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
    });
    const sessionId = session.id;
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
        await client.beta.sessions.events.send(sessionId, { events });
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
            let text: string;
            let isError = false;
            try {
                const out = await runnable.run(asToolArgs(call.input), {
                    toolUse: call.event,
                    toolUseBlock: call.event,
                } as unknown as BetaToolRunContext);
                text = typeof out === 'string' ? out : JSON.stringify(out);
            } catch (err) {
                isError = true;
                text = err instanceof Error ? err.message : 'The tool call failed.';
            }
            // A stop found AT the call (a cap, a guard verdict on its result, a
            // kill read when it finished): its result is not sent. The stop
            // answers it `is_error` with the run's own sentence.
            if (isStopped()) return;
            await answer([{ id, text, isError }], false);
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
        await recordStep(ctx, runId, binding.nextSeq(), 'MODEL_CALL', {
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
            },
        });
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

    const handle = async (ev: AnyEvent): Promise<void> => {
        // The kill switch and the run's own status, on EVERY event handled.
        await checkKill();
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
                if (!isStopped()) await runQueuedCalls();
                return;
            case 'agent.tool_use':
            case 'agent.mcp_tool_use':
                // Never on an agent Inflect provisioned: custom tools only.
                state.beyondCustomTools = true;
                abortRead();
                return;
            case 'session.status_idle': {
                const reason = ev.stop_reason?.type;
                if (reason === 'requires_action') {
                    if (!isStopped()) await runQueuedCalls();
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
            let history: AnyEvent[];
            try {
                history = [];
                for await (const ev of client.beta.sessions.events.list(sessionId, {})) history.push(ev);
            } catch (err) {
                return isStopped() || dropped(err);
            }
            for (const ev of history) {
                await processEvent(ev);
                if (end !== null || isStopped()) return true;
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
        // leaves a record Step 5c deletes by id.
        await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_CREATED', {
            sessionId,
            connectionId: route.connectionId,
            agentId: pinned.anthropicAgentId,
            agentVersion: pinned.anthropicAgentVersion,
            budgetCents: sessionBudget.max_list_cost.amount,
        });
        armWallClock();
        let first = true;
        let reconnects = 0;
        for (;;) {
            // A thrown error here is a failure to drive the session, not a
            // drop: it reaches the catch below, and the run fails and settles.
            const done = await readStream(async () => {
                if (!first) return;
                const opening = { type: 'user.message' as const, content: [{ type: 'text' as const, text: message }] };
                await client.beta.sessions.events.send(sessionId, { events: [opening] });
                sent.push(opening);
                first = false;
            }, !first);
            if (done || end !== null || isStopped()) break;
            reconnects += 1;
            if (reconnects > MAX_STREAM_RECONNECTS) {
                streamLost = true;
                break;
            }
        }

        // ── THE STOP: answer pending is_error, interrupt, drain to idle ──────
        if ((isStopped() || streamLost) && end === null) {
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
        await settleSession(ctx, runId, client, sessionId, route, binding, end === null);
    }

    // ── Settlement ──────────────────────────────────────────────────────────
    await updateRun(ctx, runId, { costTokens, stepCount: seq });

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

/** One step recording the session's lifecycle: ids and codes, never content. */
async function recordSessionStep(
    ctx: RequestContext,
    runId: string,
    seq: number,
    lifecycle: SessionLifecycle,
    facts: Record<string, unknown>,
): Promise<void> {
    await recordStep(ctx, runId, seq, 'SYNTHESIS', sessionStepRecord(lifecycle, facts));
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
    try {
        if (route.keepSessions) {
            await recordSessionStep(ctx, runId, binding.nextSeq(), 'SESSION_KEPT', { sessionId, connectionId: route.connectionId });
            return;
        }
        // Anthropic refuses a delete while the session runs, and its status
        // lags the stream's idle event: poll until it has left `running`. A
        // session a thrown error left running is interrupted first.
        for (let i = 0; i < SETTLE_POLL_ATTEMPTS; i += 1) {
            let status: string;
            try {
                status = (await client.beta.sessions.retrieve(sessionId)).status;
            } catch {
                break;
            }
            if (status !== 'running' && status !== 'rescheduling') break;
            if (i === 0 && mayBeRunning) {
                try {
                    await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });
                } catch {
                    // The delete below says whether it worked.
                }
            }
            await wait(SETTLE_POLL_MS);
        }
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
