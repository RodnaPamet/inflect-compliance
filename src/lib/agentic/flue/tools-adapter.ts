/**
 * Bridge this product's MCP read tools into the shape an external agent runtime
 * calls — without moving a single authorization decision out of `runReadTool`.
 *
 * ## The one rule
 *
 * The external engine decides WHAT TO TRY. `runReadTool` decides WHAT IS
 * PERMITTED. Every tool this adapter produces routes its `run` through that
 * funnel, which means an agent driven by third-party code passes through the
 * identical gate a human-driven MCP call does: token audience, credential
 * liveness, deny-by-default tool exposure, the autonomy ceiling, the policy
 * card, credential scope, then the same `assertPermission` / `assertCan*` the
 * equivalent human route uses — with exactly one hash-chained audit row per
 * call and per refusal.
 *
 * Nothing here re-implements any of that, and nothing here may. If a future
 * edit finds itself reaching for a permission check in this file, the change
 * belongs in the funnel.
 *
 * ## The advertised set is NARROWER than MCP's, deliberately
 *
 * `loadableReadTools` gives the offered set: exposure allowlist ∩ register
 * grants ∩ policy card ∩ the principal's permissions. That is what MCP's
 * `tools/list` advertises, and it stops there on purpose — credential scope and
 * the autonomy ceiling are call-time decisions that write audit rows, and a
 * listing must not make an authorization claim it records nothing for.
 *
 * This adapter narrows by those two as well, because the consumer is different.
 * An MCP client is a program that can handle a 403; a language model handed a
 * tool it will always be refused simply plans against it and burns the run. The
 * registry's own history is the argument: the card term was missing from the
 * listing once, and the recorded consequence was "an agent whose card narrowed
 * its grants was still advertised the wider list, and every call it planned
 * against the difference 403'd".
 *
 * The narrowing here is an ADVERTISING probe, never an enforcement: it throws
 * nothing, writes nothing, and a tool that slips through it is still refused by
 * the funnel with a proper audit row. Both terms are evaluated by calling the
 * same functions the funnel calls, so there is no second copy of either rule.
 *
 * ## The guard sandwich, and where it actually belongs
 *
 * The integration plan asked for AI Guard around every model call. The runtime's
 * public API cannot carry that — `useModel` takes only `thinkingLevel` and
 * `compaction`, and the response lifecycle callbacks are typed
 * `ResponseMetadataCallback` and carry neither prompt nor output text. See
 * `docs/implementation-notes/2026-09-20-flue-2-1-0-api-verification.md`.
 *
 * So the sandwich is here, at the tool boundary, and both slices are load-bearing
 * in a way the model-call placement would not have improved on:
 *
 *   • EGRESS on the model's proposed ARGUMENTS, before the funnel runs. A tool
 *     call is the action. This is the slice that matters, and it sits in front
 *     of the thing it is guarding rather than beside it.
 *
 *   • UNTRUSTED INPUT on the tool's RESULT, before it returns to the model.
 *     Tool results are where tenant-authored content enters an agent's context
 *     — a risk description or a finding write-up carrying "ignore previous
 *     instructions". Guarding the assembled prompt would have caught the same
 *     text later and with less context about where it came from.
 *
 * What is given up, and it is stated rather than glossed: the model's own
 * free-text output is not egress-scanned. Under propose-not-commit that output
 * is not an action — it becomes an `AgentProposal` a human reads, already
 * covered by `guardAgentProposal` and the `guardVerdict` / `guardRuleIds` /
 * `guardInputDigest` columns on that row.
 */
import type * as v from 'valibot';

import type { RequestContext } from '@/app-layer/types';
import {
    guardEgress,
    guardUntrustedInput,
    assertGuardAllowed,
    assertNoReviewRequired,
    type GuardOutcome,
    type GuardVerdict,
    type GuardDirection,
} from '@/app-layer/ai/guard';
// The PERSISTED verdict vocabulary. `proposal-guard` declares it as mirroring
// the `AgentGuardVerdict` Prisma enum exactly, so importing it from there
// keeps this module free of a Prisma value import while still being checked
// against the enum the column accepts.
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';
import { forbidden } from '@/lib/errors/types';
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import {
    requiredAutonomyFor,
    withinCeiling,
    type McpCapabilityClass,
} from '@/lib/agentic/autonomy-ceiling';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { loadableReadTools, runReadTool } from '@/lib/mcp/tools/registry';
import type { McpReadTool } from '@/lib/mcp/tools/types';

import { toValibotInputSchema } from './json-schema-to-valibot';

/** Read tools are read tools; the class is not per-tool data. */
const READ_CAPABILITY: McpCapabilityClass = 'read';

/**
 * The subset of the runtime's `useTool` argument this adapter produces.
 *
 * Structurally assignable to Flue's `ToolDefinition`, and a compile-time test
 * asserts exactly that against the published types. Declared here rather than
 * imported so that this module — and everything that unit-tests it — carries no
 * runtime import of the agent runtime: the adapter is a pure mapping and is
 * worth being able to test without booting anything.
 */
export interface FlueToolDefinition {
    name: string;
    description: string;
    input: v.GenericSchema<Record<string, unknown>, unknown>;
    /**
     * MCP annotations. The runtime ignores these — its own docs say so — and
     * application code reads the hints to gate calls. Every tool this adapter
     * emits is a read tool, so `readOnlyHint` is true and `destructiveHint` is
     * false for all of them, and that is a fact about the funnel rather than a
     * per-tool claim: `runReadTool` can only reach `McpReadTool.run`, and the
     * propose tools live behind a different funnel entirely.
     */
    annotations: { readOnlyHint: true; destructiveHint: false; title: string };
    run: (context: FlueToolCallContext) => Promise<string>;
}

/**
 * What the runtime hands a tool's `run`.
 *
 * Mirrors the shape of Flue's `ToolContext` for a tool that declares an input
 * schema and neither `harness` nor `durable`: the VALIDATED arguments arrive as
 * `data`, not as a bare first parameter. Getting that wrong is the first thing
 * the compile-time check at the bottom of this file would have caught, and did.
 *
 * `toolCallId` is the runtime's own correlation id for this call — the same id
 * its `tool_start` / `tool` events carry. It is threaded into the guard source
 * label so a guard verdict can be tied back to the exact call that produced it.
 */
export interface FlueToolCallContext {
    readonly toolCallId: string;
    /**
     * The runtime aborts this on timeout. `runReadTool` takes no signal, so a
     * cancelled call still runs to completion here and its result is discarded
     * by the runtime — the same behaviour every other in-process read in this
     * codebase has. Declared rather than omitted so the field is visibly
     * received and visibly unused, instead of looking like it was never there.
     */
    readonly signal?: AbortSignal;
    /**
     * The runtime-validated arguments — typed `unknown`, and that is the
     * runtime's shape rather than a hedge here.
     *
     * `ToolInputSchema` is `v.GenericSchema<Record<string, unknown>, unknown>`,
     * whose OUTPUT parameter is `unknown`, so `ToolContext['data']` infers as
     * `unknown` no matter how specific the schema handed in actually is.
     * Declaring this `Record<string, unknown>` made the descriptor unassignable
     * — a parameter type has to be a supertype, not a subtype — which is the
     * second contract error the compile-time check at the bottom of this file
     * caught and no hand-written interface would have.
     *
     * So it is narrowed at runtime instead, by `asToolArgs`. Nothing is lost:
     * `runReadTool` validates against the tool's Zod schema regardless, so this
     * narrowing decides only what the funnel is asked, never what it accepts.
     */
    readonly data: unknown;
}

/**
 * Narrow the runtime's `unknown` arguments to the object shape the funnel takes.
 *
 * A non-object — which the runtime should never produce for an object schema —
 * becomes `{}` rather than throwing. The funnel then validates `{}` against the
 * tool's Zod schema and refuses it if arguments were required, which is a
 * better-reported failure than a `TypeError` thrown inside someone else's event
 * loop.
 */
function asToolArgs(data: unknown): Record<string, unknown> {
    return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
}

/** Why a tool was not advertised. Diagnostic only — never a refusal. */
export type ToolOmissionReason = 'SCOPE' | 'AUTONOMY' | 'UNCONVERTIBLE_SCHEMA';

/**
 * One guard flag. Rule ids and verdict only — never the content that tripped it.
 */
export interface ReviewFlag {
    readonly tool: string;
    /** Which slice of the sandwich fired: the model's ARGUMENTS, or the RESULT. */
    readonly slice: 'args' | 'result';
    readonly direction: GuardDirection;
    readonly verdict: GuardVerdict;
    readonly ruleIds: readonly string[];
}

/**
 * The invocation-scoped answer to "may this run carry on by itself?".
 *
 * ## Why refusing one call was not enough
 *
 * `GuardAction` has three values and the middle one is the default outcome.
 * Under `balanced` — the mode a tenant gets without configuring anything — a
 * SUSPICIOUS finding in either direction, and a MALICIOUS one on input,
 * resolve to `flag`, whose contract `policy.ts` states as "allow, but force
 * human review; NEVER auto-commit".
 *
 * This adapter honoured only `assertGuardAllowed`, which fires on `blocked`
 * alone. So a flag did nothing: flagged ARGUMENTS went on to the funnel, and a
 * flagged RESULT — tenant-authored text that reads as an instruction — was
 * returned into the model's context verbatim. The guard ran, recorded its
 * verdict, and changed nothing, which is the shape of a control that reports
 * itself working.
 *
 * Throwing on the flagged call is necessary and is NOT sufficient. A tool that
 * throws is, to a language model, a tool that did not work: it picks another
 * one and keeps going. Refusing call three of seven while calls four through
 * seven proceed is auto-continuation with an extra error in the transcript —
 * and the one thing a flag must never do is let the agent route around it.
 *
 * So the latch is one-way and invocation-wide. The first flag trips it, and
 * every later call in the same invocation refuses BEFORE the funnel, before
 * the guards, before anything. A tripped latch is the driver's signal to put
 * the run into `AWAITING_APPROVAL`: `required` is the question it asks, and
 * `flags` is what it shows the human who has to answer.
 *
 * Nothing is reset. There is no `clear()` and there must not be one — the run
 * is answered by a person, not by the next call going well.
 */
/**
 * WHAT THE GUARD SAID ABOUT ONE SLICE OF ONE TOOL CALL.
 *
 * Reported for EVERY scan, not only the refusing ones. "The guard ran and
 * found nothing" and "the guard never ran" are different facts, and a ledger
 * that records only refusals cannot tell them apart — the same reasoning that
 * put `guardInputDigest` on `AgentProposal`.
 */
export interface StepGuardObservation {
    /** Ties the observation to the call, so concurrent tools cannot cross. */
    toolCallId: string;
    tool: string;
    slice: ReviewFlag['slice'];
    verdict: AgentGuardVerdict;
    ruleIds: readonly string[];
}

export type GuardObserver = (observation: StepGuardObservation) => void;

/**
 * The scanner's answer, as the step ledger records it.
 *
 * NOT `proposal-guard`'s ladder, deliberately. That ladder quarantines a
 * malicious scan because a proposal becomes a live compliance record; a tool
 * call is a different question. Here the enforcement outcome IS the verdict:
 * a blocked call never returned data, a flagged one latched review, and
 * anything else was scanned and permitted.
 */
function stepVerdictOf(outcome: GuardOutcome): AgentGuardVerdict {
    if (outcome.blocked) return 'QUARANTINED';
    if (outcome.reviewRequired) return 'FLAGGED';
    return 'CLEAN';
}

export class ReviewLatch {
    private readonly recorded: ReviewFlag[] = [];

    /**
     * Optional, because the latch's REFUSAL job does not depend on anyone
     * listening. A run with no observer behaves exactly as before.
     */
    constructor(private readonly observe?: GuardObserver) {}

    /** Did a guard flag anything in this invocation? */
    get required(): boolean {
        return this.recorded.length > 0;
    }

    /** The flags, in the order they fired. */
    get flags(): readonly ReviewFlag[] {
        return this.recorded;
    }

    /**
     * Refuse outright once anything has been flagged.
     *
     * Called at the TOP of every guarded call, so a tripped latch costs no
     * funnel call, no audit row and no guard scan. The message names the flag
     * that stopped the run rather than the call that just bounced off it,
     * because the second one is never the interesting half.
     */
    assertNotTripped(tool: string): void {
        const first = this.recorded[0];
        if (!first) return;
        throw forbidden(
            `ai_guard_review_required: awaiting human review since ` +
                `${first.slice} of ${first.tool} ` +
                `[${first.ruleIds.join(',')}] — refusing ${tool}`,
        );
    }

    /**
     * Record a verdict, then enforce it.
     *
     * The order is load-bearing: both assertions throw, and a flag recorded
     * after the throw would be a flag nobody could read — the latch would stay
     * down while the call that should have tripped it unwound.
     *
     * Both assertions, not one. `assertNoReviewRequired` subsumes
     * `assertGuardAllowed` (a block sets `reviewRequired` too), but running the
     * narrower one first keeps a block reporting itself as `ai_guard_blocked`
     * instead of being relabelled as something milder.
     */
    check(
        outcome: GuardOutcome,
        tool: string,
        slice: ReviewFlag['slice'],
        toolCallId = 'standalone',
    ): void {
        // REPORTED FIRST, before either assertion below can throw.
        //
        // A blocked or flagged scan is exactly the one the ledger most needs
        // to record, and both of those paths leave this method by throwing.
        // Observing after the asserts would record every CLEAN verdict and
        // silently drop every refusal — the inversion of what is wanted.
        this.observe?.({
            toolCallId,
            tool,
            slice,
            verdict: stepVerdictOf(outcome),
            // `?? []` because this runs INSIDE the guard seam. `GuardOutcome`
            // types `ruleIds` as required, so this should never fire — but a
            // scanner returning a malformed outcome would otherwise throw
            // here, turning a CLEAN scan into a 500 raised by the very code
            // that exists to observe it. The observation degrades; the call
            // does not.
            ruleIds: [...(outcome.ruleIds ?? [])],
        });

        if (outcome.reviewRequired) {
            this.recorded.push({
                tool,
                slice,
                direction: outcome.direction,
                verdict: outcome.verdict,
                ruleIds: [...outcome.ruleIds],
            });
        }
        assertGuardAllowed(outcome);
        assertNoReviewRequired(outcome);
    }
}

export interface FlueToolSet {
    tools: FlueToolDefinition[];
    /**
     * What was dropped and why, for the operator surface and the tests.
     *
     * Returned rather than logged-and-forgotten because "the model was offered
     * six tools" and "the model was offered six of ten tools" are different
     * facts, and only the second one explains a run that failed to get
     * anywhere. A silent narrowing is the shape that makes an agent look
     * incapable when it is actually under-provisioned.
     */
    omitted: Array<{ name: string; reason: ToolOmissionReason }>;
    /**
     * ONE latch for the whole tool set, shared by every `run` closure below.
     *
     * Per-tool latches would let a flagged `list_risks` be followed by a clean
     * `list_controls`, which is the routing-around this is here to stop.
     */
    review: ReviewLatch;
}

/**
 * Does the invocation's credential hold the tool's resource scope?
 *
 * Implemented by CALLING the funnel's own `enforceApiKeyScope` and catching,
 * rather than re-reading `ctx.apiKeyScopes` here. The scope vocabulary has
 * wildcard forms (`*`, `resource:*`) and a session-auth no-op case, and a
 * second reading of those rules is precisely the four-verbatim-copies failure
 * this repo has already paid for. The function is pure — it either returns or
 * throws — so using it as a predicate is sound.
 */
function holdsScope(ctx: RequestContext, tool: McpReadTool<unknown>): boolean {
    try {
        enforceApiKeyScope(ctx, tool.resourceScope.resource, tool.resourceScope.action);
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the tool set for one invocation.
 *
 * Pure apart from the schema conversion; performs no authorization and writes
 * no audit row. The returned `run` closures are where anything happens.
 */
export function flueToolsFor(inv: McpInvocation, observe?: GuardObserver): FlueToolSet {
    const tools: FlueToolDefinition[] = [];
    const omitted: FlueToolSet['omitted'] = [];
    // One latch for the RUN — review, once required, stays required across
    // every subsequent tool. The observer is per-run too; observations carry
    // their own `toolCallId` so concurrent calls cannot cross.
    const review = new ReviewLatch(observe);

    for (const tool of loadableReadTools(inv)) {
        if (!holdsScope(inv.ctx, tool)) {
            omitted.push({ name: tool.name, reason: 'SCOPE' });
            continue;
        }

        const required = requiredAutonomyFor(READ_CAPABILITY, tool.authorize.autonomy);
        if (!withinCeiling(required, inv.autonomyCeiling)) {
            omitted.push({ name: tool.name, reason: 'AUTONOMY' });
            continue;
        }

        let input: v.GenericSchema<Record<string, unknown>, unknown>;
        try {
            input = toValibotInputSchema(tool.name, tool.inputSchema);
        } catch {
            // A tool whose schema this build cannot express is DROPPED, not
            // offered without one. Offering it unschema'd would hand the model
            // a tool it cannot call correctly and no signal that anything was
            // wrong; dropping it is visible in `omitted`, and the converter's
            // own test fails CI before this branch can be reached in practice.
            omitted.push({ name: tool.name, reason: 'UNCONVERTIBLE_SCHEMA' });
            continue;
        }

        tools.push({
            name: tool.name,
            description: tool.description,
            input,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                title: tool.name,
            },
            run: (context) =>
                runGuardedTool(
                    inv,
                    tool.name,
                    asToolArgs(context.data),
                    context.toolCallId,
                    review,
                ),
        });
    }

    return { tools, omitted, review };
}

/**
 * One guarded tool call: egress on the arguments, the funnel, untrusted-input
 * on the result.
 *
 * Exported for the tests, which need to exercise the sandwich without building
 * a whole tool set.
 */
export async function runGuardedTool(
    inv: McpInvocation,
    name: string,
    args: Record<string, unknown>,
    toolCallId = 'standalone',
    review: ReviewLatch = new ReviewLatch(),
): Promise<string> {
    const ctx = inv.ctx;

    // ── 0. ALREADY AWAITING A HUMAN ─────────────────────────────────────────
    //
    // Before the guards, not after: a run that is waiting on a person must not
    // spend another funnel call, another audit row or another scan to be told
    // the same thing again.
    review.assertNotTripped(name);

    // ── 1. The model's proposed ARGUMENTS, on their way to an action ────────
    //
    // Before the funnel, not after: the funnel's step 3 runs the usecase, and a
    // guard that fired after that would be reporting on a read that had already
    // happened.
    const egress = await guardEgress(ctx, args, { source: `flue-tool-args:${name}:${toolCallId}` });
    review.check(egress, name, 'args', toolCallId);

    const result = await runReadTool(inv, name, args);

    // ── 2. The RESULT, on its way into the model's context ──────────────────
    //
    // `content[0]` is the tool's JSON payload and `content[1]` is the
    // provenance banner the funnel appends. Both are scanned: the banner is
    // ours and will never trip a rule, and reconstructing the joined text is
    // what the model actually receives.
    const text = result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');

    const injected = await guardUntrustedInput(ctx, text, {
        source: `flue-tool-result:${name}:${toolCallId}`,
    });
    // The read has already happened, and that is fine — it is a READ, it is
    // audited, and nothing was committed. What must not happen is the text
    // reaching the model, so the flag is enforced between the funnel and the
    // return rather than being allowed through with a warning attached.
    review.check(injected, name, 'result', toolCallId);

    return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE-TIME CONTRACT CHECK
//
// `FlueToolDefinition` is declared locally so this module carries no runtime
// import of the agent runtime. The cost of that choice is that the local shape
// could drift from the real one, silently, until something tried to run — and
// the value of paying for it here is that it cannot.
//
// This function is never called. It exists so `tsc` proves that what
// `flueToolsFor` returns is a legal argument to the real `useTool`. It has
// already earned its place: the first draft of this adapter declared
// `run: (args) => ...`, and the real contract passes a `ToolContext` whose
// validated arguments arrive as `context.data`. That descriptor would have
// type-checked perfectly against a hand-written interface, produced tools whose
// every call received `undefined` arguments, and failed at runtime inside
// someone else's event loop.
//
// A type-only import, so nothing from the runtime is pulled into the bundle.
// ─────────────────────────────────────────────────────────────────────────────
import type { useTool as FlueUseTool } from '@flue/runtime';

export function __assertDescriptorIsALegalFlueTool(
    // Named `registerTool` rather than `useTool`: eslint's `react-hooks` plugin
    // keys off the `use` prefix and reports a hook called outside a component.
    // Flue's `useTool` is an agent-scoped hook, not a React one, and the
    // warning would be permanent noise on a line whose whole job is to be
    // type-checked.
    registerTool: typeof FlueUseTool,
    descriptor: FlueToolDefinition,
): void {
    registerTool(descriptor);
}
