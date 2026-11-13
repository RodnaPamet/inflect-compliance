/**
 * THE TOOL RUNNER ENGINE'S `delegate` TOOL (Step 2e of
 * `docs/claude-tool-runner-design.md`, "Delegation", #4594).
 *
 * Engine-supplied, like `activate_skill`, and offered to the PARENT ONLY,
 * beside its resolved tools and only when the run's profile version defines
 * sub-agents. Its `subagent` parameter is an enum of the version's sub-agent
 * names, and its description lists those names and nothing else (owner
 * decision 2): no part of a child's instructions reaches the parent's context.
 *
 * DEPTH 1 IS STRUCTURAL. A child's tools are a filter of the parent's OFFERED
 * set, which never contains an engine-supplied tool, so a child's request
 * carries no tool that could delegate. A child that names `delegate` anyway
 * is answered by the SDK (`Tool 'delegate' not found`) and its request is
 * recorded as a FAILED step, `SUBAGENT_TOOL_NOT_OFFERED`.
 *
 * ── ONE DELEGATION, IN ORDER, INSIDE THE PARENT'S SERIAL QUEUE ─────────────
 *
 *    1. a stop already latched refuses the call, as every tool does;
 *    2. one STEPS is charged (a delegation is a step, not a funnel call);
 *    3. the turn's tool-call cap: `delegate` counts against it like any tool;
 *    4. the arguments: a name in the enum (`SUBAGENT_NOT_DEFINED`, never
 *       echoed), a task within its bounds;
 *    5. the turn's DELEGATION cap, the value `readTurnCaps` read for the
 *       segment, counted on the way in (`evaluateFanOut`): 0 refuses, saying
 *       delegation is disabled;
 *    6. the task's egress scan, noted through the run's own latch: anything
 *       but clean stops the run at the guard;
 *    7. the kill switch and the breaker, uncached;
 *    8. the child's tools: `offerToolSet` over the parent's invocation with the
 *       sub-agent's tool names, the parent's `readOnly`, the sub-agent's guard
 *       source and THE PARENT'S LATCH, then intersected by name with the
 *       parent's offered set, so the subset is a property of this code and not
 *       of two calls agreeing. A child with no tools is refused;
 *    9. the child's skills: the run's resolved documents and pins filtered to
 *       the sub-agent's refs, nothing resolved or pinned again, the catalogue
 *       priced against the per-run budget;
 *   10. the child's runner, on the SAME client, from `lockedParams` with the
 *       `subagent` option, its signal `AbortSignal.any([parent, child])`, run
 *       by the ONE loop body both loops share (`execute.ts`);
 *   11. the child's answer, scanned on re-entry (`guardDelegateAnswer`), and
 *       returned fenced as `<subagent_answer name="…">`;
 *   12. the marker step, in `finally`, closing the span, then the kill read.
 *
 * Every child call goes through `runGuardedTool` on the parent's invocation:
 * the parent agent's identity, grants, card, scopes, ceiling and kill switch.
 * A sub-agent is not a principal. Its steps are charged to the parent run's
 * budget and labelled with its name in the ledger.
 *
 * The runnable tool is a plain object of the SDK's type, so this file loads no
 * `@anthropic-ai/*` package (`local/anthropic-client-single-seam`).
 */
import type { BetaRunnableTool, BetaToolRunContext } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';

import { guardEgress } from '@/app-layer/ai/guard';
import type { ProfileSubagent } from '@/lib/agentic/agent-profile';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import {
    asToolArgs,
    guardDelegateAnswer,
    type ReviewLatch,
    type StepGuardObservation,
} from '@/lib/agentic/engine-tools';
import { catalogBytes, MAX_CATALOG_BYTES } from '@/lib/agentic/flue/skills';
import { isTenantSkillPin } from '@/lib/agentic/flue/skills/mount-gate';
import type { EffectiveRunCaps } from '@/lib/agentic/run-caps';
import { fanOutRefusalMessage } from '@/lib/agentic/subagent-fanout';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import type { McpInvocation } from '@/lib/mcp/authorize';

import { lockedParams } from './params';
import { activateSkillTool, skillCatalogueText, type RunSkills } from './skills';
import { ACTIVATE_SKILL_TOOL_NAME, DELEGATE_TOOL_NAME } from './supplied-tools';
import {
    SerialQueue,
    TOOL_RUNNER_GUARD_SOURCE,
    refuseOverTurnCap,
    stoppedMessage,
    subagentGuardSource,
    toolRunnerToolsFor,
    type TurnCallCounter,
    type ToolRunBinding,
} from './tools';

/** The longest task a delegation may carry, in characters. */
export const DELEGATE_TASK_MAX_CHARS = 8_000;

/** Why a delegation was refused before or instead of running. Each is named in the error the model reads. */
export type DelegationRefusal =
    | 'SUBAGENT_NOT_DEFINED'
    | 'SUBAGENT_TASK_INVALID'
    | 'DELEGATIONS_PER_TURN_EXCEEDED'
    | 'SUBAGENT_BREAKER_OPEN'
    | 'SUBAGENT_HAS_NO_TOOLS'
    | 'SUBAGENT_CATALOGUE_OVER_BUDGET';

/** How a child's loop ended, as the shared loop body reports it. */
export interface ChildLoopResult {
    /** Model calls the child made. */
    readonly calls: number;
    /** A named stop reason the child reached (`refusal`, `max_tokens`, a full context), or null. */
    readonly namedStop: string | null;
    readonly lastStopReason: string | null;
    /** An error that was not a stop this run asked for, or null. */
    readonly failure: string | null;
    /** The child's last message's text: its answer. */
    readonly lastText: string;
}

/** The one loop body, run for a child: supplied by `execute.ts`, so both loops are the same code. */
export type ChildLoopRunner = (input: {
    readonly subagent: string;
    readonly binding: ToolRunBinding;
    readonly params: BetaToolRunnerParams & { stream: false };
    readonly signal: AbortSignal;
    /** The names the child was offered; any other `tool_use` is recorded as refused. */
    readonly offeredNames: ReadonlySet<string>;
    /** The names the run knows, so a refused request records a known name and never the model's string. */
    readonly knownNames: ReadonlySet<string>;
    /** Told the child's turn number before its tools run, so its tool-call cap counts its own turns. */
    readonly onTurn: (turn: number) => void;
}) => Promise<ChildLoopResult>;

/** Everything a delegation needs from the parent's run. */
export interface DelegationContext {
    /** The PARENT's binding: its budget, ledger counter, stops and kill read. */
    readonly binding: ToolRunBinding;
    readonly invocation: McpInvocation;
    readonly def: WorkflowDefinition;
    readonly caps: EffectiveRunCaps;
    /** What the run mounted, with the pins its row recorded. */
    readonly skills: RunSkills;
    readonly subagents: readonly ProfileSubagent[];
    /** The two per-turn caps `readTurnCaps` read for the segment. */
    readonly turnCaps: { readonly delegationsPerTurn: number; readonly toolCallsPerTurn: number };
    readonly turnCalls: TurnCallCounter;
    /** The parent's current turn: the number of its yielded message whose tools are running. */
    readonly parentTurn: () => number;
    /** The run's ONE latch. */
    readonly review: ReviewLatch;
    readonly observe: (o: StepGuardObservation) => void;
    /** The names of the parent's offered set: a child's tools are a filter of it. */
    readonly parentOffered: ReadonlySet<string>;
    /** The parent's signal: every stop the parent latches aborts a child request in flight. */
    readonly parentSignal: AbortSignal;
    readonly runLoop: ChildLoopRunner;
}

/** The sentence each refusal is answered with. Never the name the model sent when it was not a sub-agent's. */
export function delegationRefusalMessage(reason: DelegationRefusal, subagent: string | null): string {
    switch (reason) {
        case 'SUBAGENT_NOT_DEFINED':
            return 'subagent_not_defined: that is not a sub-agent of this agent. Only the names this tool lists can be delegated to.';
        case 'SUBAGENT_TASK_INVALID':
            return `subagent_task_invalid: a delegation carries a task of 1 to ${DELEGATE_TASK_MAX_CHARS} characters.`;
        case 'DELEGATIONS_PER_TURN_EXCEEDED':
            // Worded by the caller, from the verdict: see `fanOutRefusalMessage`.
            return 'delegation_limit_reached';
        case 'SUBAGENT_BREAKER_OPEN':
            return 'subagent_breaker_open: this agent is stopped, its circuit breaker is latched open. Nothing was delegated.';
        case 'SUBAGENT_HAS_NO_TOOLS':
            return `subagent_has_no_tools: sub-agent ${subagent ?? ''} can reach none of its tools in this run, so nothing was sent.`;
        case 'SUBAGENT_CATALOGUE_OVER_BUDGET':
            return `subagent_catalogue_over_budget: sub-agent ${subagent ?? ''}'s skills are over the per-run catalogue budget, so nothing was sent.`;
    }
}

/** The sentence a child's own end is returned to the parent with. Its end is not the run's end. */
export const CHILD_STOP_MESSAGES: Readonly<Record<string, string>> = {
    refusal: 'subagent_model_refused: the sub-agent declined to continue. Nothing more came from it.',
    max_tokens: 'subagent_max_tokens: the sub-agent reached its output limit before answering.',
    model_context_window_exceeded: 'subagent_context_exhausted: the sub-agent\'s conversation outgrew the model\'s context window.',
};

/** The child reached its turn limit still calling tools. */
export const SUBAGENT_TURNS_EXHAUSTED_MESSAGE =
    'subagent_turns_exhausted: the sub-agent reached its turn limit while still calling tools, so it gave no answer.';

/** The answer, fenced and labelled with the sub-agent's name. */
export function subagentAnswerText(name: string, text: string): string {
    return [`<subagent_answer name="${name}">`, text, '</subagent_answer>'].join('\n');
}

/** A refusal from a step of the delegation: the error the model reads, and what the marker records. */
class DelegationStopped extends Error {
    constructor(
        message: string,
        public readonly outcome: string,
    ) {
        super(message);
        this.name = 'DelegationStopped';
    }
}

/** The child's skills: the run's documents and pins, filtered to the sub-agent's refs. Nothing is resolved again. */
export function childSkills(skills: RunSkills, sub: ProfileSubagent): RunSkills {
    const wanted = new Set(sub.skillRefs.map((r) => `${r.origin}:${r.name}`));
    const pins = skills.pins.filter((p) => wanted.has(`${isTenantSkillPin(p) ? 'tenant' : 'repository'}:${p.name}`));
    const names = new Set(pins.map((p) => p.name));
    return { documents: skills.documents.filter((d) => names.has(d.name)), pins };
}

/** One delegation, in the design's order. */
async function delegate(dc: DelegationContext, args: Record<string, unknown>, toolUseId: string): Promise<string> {
    const b = dc.binding;

    // 1. A stop already latched.
    const before = b.stopped();
    if (before) throw new Error(stoppedMessage(before));

    // 2. One step.
    const stepHalt = b.budget.charge('STEPS', 1);
    if (stepHalt) {
        b.stopAtCap(stepHalt);
        throw new Error(stepHalt.message);
    }

    // 3. Tool calls per turn: `delegate` is a tool call of the turn.
    const turn = b.admitToolCall();
    if (!turn.allowed) return refuseOverTurnCap(b, DELEGATE_TOOL_NAME, turn);

    // The span's EXCLUSIVE lower bound (`delegationSpans` reads steps strictly
    // between it and the marker): the last seq taken before the delegation,
    // so every step the child records sits above it.
    const fromSeq = b.peekSeq() - 1;
    let sub: ProfileSubagent | undefined;
    let taskChars: number | null = null;
    let toolsLost: Array<{ name: string; reason: string }> = [];
    let child: ChildLoopResult | null = null;
    let outcome = 'answered';
    let failed = false;

    try {
        // 4. The arguments. A name outside the enum is never echoed.
        const name = args.subagent;
        sub = typeof name === 'string' ? dc.subagents.find((s) => s.name === name) : undefined;
        if (!sub) {
            throw new DelegationStopped(delegationRefusalMessage('SUBAGENT_NOT_DEFINED', null), 'SUBAGENT_NOT_DEFINED');
        }
        const task = args.task;
        if (typeof task !== 'string' || task.trim().length === 0 || task.length > DELEGATE_TASK_MAX_CHARS) {
            throw new DelegationStopped(delegationRefusalMessage('SUBAGENT_TASK_INVALID', sub.name), 'SUBAGENT_TASK_INVALID');
        }
        taskChars = task.length;

        // 5. Delegations per turn, counted in the parent's current turn.
        const fan = dc.turnCalls.admitDelegation('parent', dc.parentTurn(), dc.turnCaps.delegationsPerTurn);
        if (!fan.allowed) throw new DelegationStopped(fanOutRefusalMessage(fan), 'DELEGATIONS_PER_TURN_EXCEEDED');

        // 6. The task, on its way to a model: the egress slice every funnel
        // argument passes, through the run's own latch.
        const egress = await guardEgress(b.ctx, task, {
            source: `${TOOL_RUNNER_GUARD_SOURCE}-delegate-args:${sub.name}:${toolUseId}`,
        });
        try {
            dc.review.check(egress, DELEGATE_TOOL_NAME, 'args', toolUseId);
        } catch (err) {
            throw new DelegationStopped(err instanceof Error ? err.message : String(err), 'GUARD');
        }

        // 7. The kill switch and the breaker, uncached.
        if (await b.checkKill()) {
            const stop = b.stopped();
            throw new DelegationStopped(stop ? stoppedMessage(stop) : 'This run was stopped.', `RUN_STOPPED_${stop?.kind ?? 'KILL'}`);
        }
        if (await b.checkBreaker()) {
            throw new DelegationStopped(delegationRefusalMessage('SUBAGENT_BREAKER_OPEN', sub.name), 'SUBAGENT_BREAKER_OPEN');
        }

        // 8. The child's tools: a filter of the parent's offered set, over the
        // parent's invocation and latch, labelled with the sub-agent.
        let childTurn = 0;
        const childBinding: ToolRunBinding = {
            ...b,
            subagent: sub.name,
            admitToolCall: () => dc.turnCalls.admit(`delegate:${toolUseId}`, childTurn),
        };
        const queue = new SerialQueue();
        const offered = toolRunnerToolsFor(dc.invocation, childBinding, {
            readOnly: dc.def.readOnly === true,
            profileTools: sub.toolNames,
            observe: dc.observe,
            queue,
            review: dc.review,
            sourcePrefix: subagentGuardSource(sub.name),
        });
        const tools = offered.tools.filter((t) => dc.parentOffered.has(t.name));
        toolsLost = [
            ...offered.omitted.map((o) => ({ name: o.name, reason: o.reason })),
            ...offered.tools.filter((t) => !dc.parentOffered.has(t.name)).map((t) => ({ name: t.name, reason: 'NOT_IN_PARENT_SET' })),
        ];
        if (tools.length === 0) {
            throw new DelegationStopped(delegationRefusalMessage('SUBAGENT_HAS_NO_TOOLS', sub.name), 'SUBAGENT_HAS_NO_TOOLS');
        }

        // 9. The child's skills, a subset of the run's, priced again.
        const skills = childSkills(dc.skills, sub);
        if (catalogBytes(skills.documents) > MAX_CATALOG_BYTES) {
            throw new DelegationStopped(
                delegationRefusalMessage('SUBAGENT_CATALOGUE_OVER_BUDGET', sub.name),
                'SUBAGENT_CATALOGUE_OVER_BUDGET',
            );
        }
        const skillTool = activateSkillTool(childBinding, skills, queue);

        // 10. The child's runner, through the one shaping function and the one loop body.
        const childController = new AbortController();
        const childTools = skillTool ? [...tools, skillTool] : tools;
        const params = lockedParams({
            def: dc.def,
            tools: childTools,
            message: '',
            caps: dc.caps,
            fromSeq: b.budget.used('STEPS'),
            skillCatalogue: skillCatalogueText(skills.documents),
            toolCallsPerTurn: dc.turnCaps.toolCallsPerTurn,
            subagent: { name: sub.name, instructions: sub.instructions, maxTurns: sub.maxTurns, task },
        });
        const offeredNames = new Set(childTools.map((t) => t.name));
        try {
            child = await dc.runLoop({
                subagent: sub.name,
                binding: childBinding,
                params,
                signal: AbortSignal.any([dc.parentSignal, childController.signal]),
                offeredNames,
                knownNames: new Set([...dc.parentOffered, DELEGATE_TOOL_NAME, ACTIVATE_SKILL_TOOL_NAME]),
                onTurn: (n) => {
                    childTurn = n;
                },
            });
        } finally {
            childController.abort();
        }

        // 11. How the child ended. A stop it found is the RUN's; any other end
        // is an error the parent reads and decides about.
        const stop = b.stopped();
        if (stop) throw new DelegationStopped(stoppedMessage(stop), `RUN_STOPPED_${stop.kind}`);
        if (child.namedStop !== null) {
            throw new DelegationStopped(CHILD_STOP_MESSAGES[child.namedStop] ?? `subagent_stopped: ${child.namedStop}`, child.namedStop);
        }
        if (child.failure !== null) throw new DelegationStopped(`subagent_failed: ${child.failure}`, 'SUBAGENT_FAILED');
        if (child.calls === 0 || child.lastStopReason === 'tool_use' || child.lastStopReason === 'pause_turn') {
            throw new DelegationStopped(SUBAGENT_TURNS_EXHAUSTED_MESSAGE, 'SUBAGENT_TURNS_EXHAUSTED');
        }
        try {
            await guardDelegateAnswer(b.ctx, child.lastText, toolUseId, dc.review, TOOL_RUNNER_GUARD_SOURCE, DELEGATE_TOOL_NAME);
        } catch (err) {
            throw new DelegationStopped(err instanceof Error ? err.message : String(err), 'GUARD');
        }
        return subagentAnswerText(sub.name, child.lastText);
    } catch (err) {
        failed = true;
        b.onFailure();
        outcome = err instanceof DelegationStopped ? err.outcome : 'ERROR';
        throw err;
    } finally {
        // 12. The marker, closing the span: written even when the run was
        // killed mid-delegation, before the parent settles. Never the task or
        // the answer: both are model text composed from tenant reads.
        const verdict = b.takeVerdict(toolUseId);
        const seq = b.nextSeq();
        const childSteps = seq - fromSeq - 1;
        await recordStep(b.ctx, b.runId, seq, 'TOOL_CALL', {
            toolCalled: DELEGATE_TOOL_NAME,
            status: failed ? 'FAILED' : 'DONE',
            label: sub?.name ?? DELEGATE_TOOL_NAME,
            guardVerdict: verdict?.verdict,
            guardRuleIds: verdict?.ruleIds,
            input: {
                ...(sub ? { agent: sub.name } : {}),
                taskId: toolUseId,
                fromSeq,
                taskChars,
                toolsLost,
            },
            output: {
                outcome,
                modelCalls: child?.calls ?? 0,
                toolCalls: Math.max(childSteps - (child?.calls ?? 0), 0),
            },
        });
        await b.checkKill();
    }
}

/**
 * The `delegate` tool for a run whose version defines sub-agents, or null for
 * one that defines none. It shares the parent's serial queue, so a delegation
 * keeps its place in the ledger's order, and the child's calls wait on the
 * child's own queue.
 */
export function delegateTool(dc: DelegationContext, queue: SerialQueue): BetaRunnableTool<Record<string, unknown>> | null {
    if (dc.subagents.length === 0) return null;
    const names = dc.subagents.map((s) => s.name);
    return {
        type: 'custom',
        name: DELEGATE_TOOL_NAME,
        description:
            `Hand a task to one of this agent's sub-agents and receive its answer. The sub-agents are: ${names.join(', ')}. `
            + 'Each works only with its own subset of your tools, and cannot delegate further.',
        input_schema: {
            type: 'object',
            properties: {
                subagent: { type: 'string', enum: names },
                task: { type: 'string', minLength: 1, maxLength: DELEGATE_TASK_MAX_CHARS },
            },
            required: ['subagent', 'task'],
            additionalProperties: false,
        },
        parse: (content: unknown) => asToolArgs(content),
        run: (args: Record<string, unknown>, context?: BetaToolRunContext) =>
            queue.run(() => delegate(dc, args, context?.toolUse.id ?? `${DELEGATE_TOOL_NAME}:unidentified`)),
    };
}
