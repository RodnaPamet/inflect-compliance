/**
 * REFUSING A DELEGATION THE RUN IS NOT PERMITTED (#3473).
 *
 * Two caps, one seam, and the seam was found by measurement rather than from
 * the types.
 *
 * ## Why this is in the interceptor and nowhere else
 *
 * The `task` tool belongs to the RUNTIME, not to this product. It is in every
 * run's tool list already — measured in #3569, where a run bound with
 * `tools: []` still reaches the model with `['task']` — so there is no
 * `useTool` wrapper to put a check in and no point before the runtime at which
 * the call could be declined. `instrument()`'s interceptor holds a `next()` it
 * may choose not to call, which makes it the only place a refusal is
 * enforcement rather than advice.
 *
 * ## What a delegation actually looks like to the interceptor
 *
 * MEASURED against `@flue/runtime` 2.1.1 with a faux provider scripted to call
 * `task`. The operation is:
 *
 *     { type: 'tool', toolCallId: '…', toolName: 'task' }
 *     ctx = { instanceId: '<runId>', turnId: 'turn_…' }     // no taskId
 *
 * NOT `{ type: 'task' }`, and not `{ type: 'agent', operationKind: 'task' }`,
 * which is what reading the union would suggest. Those appear further in —
 * once a task session exists — and a gate there would refuse work the runtime
 * had already committed to. The tool call is the first observable moment and
 * the only one at which declining costs nothing.
 *
 * `instanceId` is the run id, because the driver does `init(InflectAgent,
 * { id: runId })`. `turnId` is the model turn. Together they are exactly the
 * key a PER-TURN fan-out cap needs, which is why the cap is per turn.
 *
 * ## DEPTH IS NOT ENFORCED HERE — and this paragraph used to say it was
 *
 * It claimed `ctx.taskId` distinguishes a delegation started by a parent from
 * one started inside a task. It does not, on the way in: see the long note at
 * the removed arm for the measurement (#3581). The claim came from reading the
 * value AFTER `next()`, where it is indeed set.
 *
 * Depth 1 — the owner's decision of 2026-10-15 — is enforced by the
 * specialists declaring no nested `useSubagent`, which the runtime backs with
 * `SubagentNotDeclaredError`. It sits inside the runtime's own
 * `MAX_DELEGATION_DEPTH = 4`, a module-level const we cannot configure.
 *
 * This module bounds FAN-OUT, which is the cap the runtime has none of.
 *
 * ## Why the counter is in a module-level Map
 *
 * The same reason the token cache in `mcp/token.ts` is: it is per-process
 * bookkeeping about work in flight, it dies with the process, and persisting
 * it would put a counter in a column that a crash would leave wrong. A run
 * whose process restarts mid-turn loses its count — which fails toward
 * ALLOWING one more delegation, bounded by `ENGINE_CAPS` as everything else
 * is. Failing the other way would refuse delegations for a run nobody is
 * delegating in.
 */
import { readRunBinding } from './run-binding';
import {
    evaluateFanOut,
    fanOutRefusalMessage,
    DEFAULT_MAX_SUBAGENTS_PER_TURN,
} from '@/lib/agentic/subagent-fanout';

/** The tool name the runtime gives delegation. Not ours; matched, not defined. */
export const DELEGATION_TOOL_NAME = 'task';

/**
 * Delegations started, keyed `<runId>:<turnId>`.
 *
 * Entries are never individually deleted. A turn ends and its key is simply
 * never consulted again; `releaseDelegationCounts(runId)` drops the run's keys
 * when the run does. Deleting per turn would need a turn-ended signal the
 * interceptor does not get, and a Map that grows for the length of one run is
 * a smaller problem than a cleanup hook that fires at the wrong time.
 */
const DELEGATIONS = new Map<string, number>();

/** How many delegations this run+turn has started. Exported for the tests. */
export function delegationsThisTurn(runId: string, turnId: string): number {
    return DELEGATIONS.get(`${runId}:${turnId}`) ?? 0;
}

/** Drop a finished run's counters. Called beside `releaseRun`. */
export function releaseDelegationCounts(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of DELEGATIONS.keys()) {
        if (key.startsWith(prefix)) DELEGATIONS.delete(key);
    }
}

/** Test seam — the Map is process-global and would otherwise leak between tests. */
export function _resetDelegationCounts(): void {
    DELEGATIONS.clear();
}

/** Thrown to refuse a delegation. The message reaches the MODEL. */
export class DelegationRefusedError extends Error {
    constructor(
        message: string,
        /**
         * Which cap refused, for the step ledger. Never the message's wording.
         *
         * `'fan-out'` ONLY since #3581. The union carried `'depth'` for an arm
         * that could not fire, and a type offering a state nothing produces
         * invites a reader to handle it — and a `switch` with an unreachable
         * branch is indistinguishable from one with a missing cause.
         */
        readonly cap: 'fan-out',
    ) {
        super(message);
        this.name = 'DelegationRefusedError';
    }
}

/**
 * Decide whether this operation may proceed, and COUNT it if it may.
 *
 * Throws `DelegationRefusedError` to refuse. Returns normally for everything
 * that is not a delegation — which is almost every operation, so the fast path
 * is two comparisons.
 *
 * COUNTS ON THE WAY IN, not on success. A delegation that starts and then
 * fails for its own reasons has still spent one of the turn's slots: the thing
 * being bounded is how many the model may LAUNCH, and a counter that only
 * recorded successes would let a model retry a failing delegate without limit.
 */
export function gateDelegation(
    operation: { type: string; toolName?: string },
    ctx: { instanceId?: string; turnId?: string; taskId?: string },
): void {
    if (operation.type !== 'tool' || operation.toolName !== DELEGATION_TOOL_NAME) return;

    // ── DEPTH 1 IS NOT ENFORCED HERE, AND THIS IS WHERE IT USED TO BE ──────
    //
    // An arm stood here refusing any `task` call whose `ctx.taskId` was set.
    // It could never fire, and it is removed rather than repaired (#3581).
    //
    // MEASURED, with the real runtime and a faux provider, logging the whole
    // `FlueExecutionContext` for every tool operation BEFORE `next()`:
    //
    //   root     list_controls  { instanceId, harness:'default', conversationId,
    //                            session:'default', operationId, turnId: …T }
    //   parent   task           { …same…,                        turnId: …W }
    //   delegate list_controls  { …same…,                        turnId: …Z }
    //
    // Indistinguishable except for `turnId`. No `taskId`, and `session` reads
    // `'default'` even for the call running INSIDE the delegation. `taskId` is
    // populated only AFTER `next()` — which is where it was first measured,
    // and that was the error. `guardDelegateResult` reads the id from the
    // result's own `details` and is unaffected.
    //
    // WHAT ENFORCES DEPTH 1 INSTEAD is the declaration: no specialist's render
    // calls `useSubagent`, so a delegate has no agent name to pass and the
    // runtime answers an undeclared one with `SubagentNotDeclaredError`. That
    // is checked by `tests/guards/flue-refused-capabilities.test.ts`, where a
    // failure is a structural fact rather than a runtime path nobody takes.
    //
    // This repo already argued the general case, in `refused-capabilities.ts`
    // about sandboxes: a ban on the import "is stronger than a runtime
    // assertion would be", and "a never-called checker … would read as defence
    // while defending nothing". The arm removed here was exactly that, and its
    // unit test passed by constructing the `ctx.taskId` the arm wanted — a
    // control that cannot express failure.

    // ── FAN-OUT ────────────────────────────────────────────────────────────
    //
    // An ungated call is one the gate could not key, and it is ALLOWED rather
    // than refused — deliberately, and worth the sentence. Without an
    // `instanceId` there is no binding to read, so the cap is unknown rather
    // than zero, and refusing on unknown would turn a runtime that stopped
    // populating the context into a product that stopped delegating. The
    // outer bound is `ENGINE_CAPS`, which does not depend on this context at
    // all. A missing `turnId` is the same argument: the count would be keyed
    // on nothing and every call would read 0.
    if (!ctx.instanceId || !ctx.turnId) return;

    const binding = readRunBinding(ctx.instanceId);
    // NO BINDING IS THE DEFAULT, NOT NO CAP. An unbound run is one this
    // product did not dispatch, and the safe reading of a delegation from a
    // run we do not recognise is the conservative one.
    const cap = binding?.maxSubagentsPerTurn ?? DEFAULT_MAX_SUBAGENTS_PER_TURN;

    const key = `${ctx.instanceId}:${ctx.turnId}`;
    const verdict = evaluateFanOut({ cap, delegatedThisTurn: DELEGATIONS.get(key) ?? 0 });
    if (!verdict.allowed) {
        throw new DelegationRefusedError(fanOutRefusalMessage(verdict), 'fan-out');
    }
    DELEGATIONS.set(key, verdict.delegatedThisTurn + 1);
}

/**
 * SCAN A DELEGATE'S ANSWER ON ITS WAY BACK INTO THE PARENT (#3473).
 *
 * The other half of this seam. `gateDelegation` runs before `next()` and
 * decides whether the delegation may start; this runs after it and decides
 * whether the answer may be seen.
 *
 * ## Why the answer needs scanning when the reads did not
 *
 * `narrowTools` hands a delegate the parent's OWN tool objects, so everything
 * it reads runs the parent's `wrapForLedger` — scanned by
 * `guardUntrustedInput` on the way in, by `guardEgress` on the way out,
 * recorded in the parent's step ledger and charged to its budget. Measured,
 * not assumed: a delegate's `list_controls` call runs the parent's wrapper.
 *
 * What that leaves is the delegate's own composed answer. It is model output
 * built from guarded reads, and it crosses into the parent's context as a tool
 * result — the same kind of inbound edge #3468 exists for, and the one edge
 * nothing was scanning, because `task` is the runtime's tool and our wrapper
 * never sees it.
 *
 * ## The result shape is measured
 *
 *     { content: [{ type: 'text', text: '<the delegate's answer>' }],
 *       details: { taskId, session, messageId } }
 *
 * Identical in shape to what our own tools return, so the text is joined the
 * same way `tools-adapter` joins it: every block, because reconstructing what
 * the model actually receives is the point.
 *
 * A result that carries no text at all is passed through. There is nothing to
 * scan, and inventing a refusal for an empty answer would make a delegate that
 * failed look like a delegate that was blocked.
 */
export async function guardDelegateResult(
    operation: { type: string; toolName?: string },
    ctx: { instanceId?: string; taskId?: string },
    result: unknown,
    guard: ((text: string, taskId: string | undefined) => Promise<void>) | undefined,
): Promise<void> {
    if (operation.type !== 'tool' || operation.toolName !== DELEGATION_TOOL_NAME) return;
    // NO GUARD IS NOT A SILENT PASS for a run this product dispatched — the
    // driver always supplies one. It is absent only for a run bound by a test
    // or by a caller that predates delegation, and refusing those would make
    // the hook mandatory on every existing `bindRun` call site.
    if (!guard) return;

    const text = delegateAnswerText(result);
    if (text === '') return;
    // THE TASK ID COMES FROM THE RESULT, NOT THE CONTEXT, and that is measured
    // rather than preferred. On the parent's `task` tool call `ctx.taskId` is
    // UNDEFINED — it is set for operations running INSIDE a delegation, which
    // is what the depth check above relies on. The id of the task that just
    // answered is in the result's own `details`.
    //
    // It is what the guard keys its `source` on, so getting this wrong does not
    // fail: it makes every flagged delegate answer attributable to `unknown`,
    // which is the shape of audit record that looks complete and names nothing.
    // `ctx.taskId` is kept as a fallback for a nested call this product does not
    // currently permit.
    await guard(text, delegateTaskId(result) ?? ctx.taskId);
}

/** The id of the task that produced this result, or undefined. */
export function delegateTaskId(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const details = (result as { details?: unknown }).details;
    if (!details || typeof details !== 'object') return undefined;
    const id = (details as { taskId?: unknown }).taskId;
    return typeof id === 'string' && id !== '' ? id : undefined;
}

/** The text blocks of a task result, joined. Exported for the tests. */
export function delegateAnswerText(result: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) =>
            block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
                ? (block as { text: string }).text
                : '',
        )
        .filter((t) => t !== '')
        .join('\n');
}
