/**
 * Bridge this product's MCP tools — the READ surface and the PROPOSE surface —
 * into the shape an external agent runtime calls, without moving a single
 * authorization decision out of the funnel that owns it.
 *
 * ## Both halves, because half an agent is a worse agent
 *
 * A Flue agent is offered read tools AND propose tools. Offering only reads
 * gave the model a way to look at a tenant and no way to write down what it
 * found: under propose-not-commit the proposal IS the output, so an agent with
 * no propose tool cannot finish a single piece of work. It cannot commit
 * anything either way — a propose call queues a PENDING row a human approves.
 *
 * ## The one rule
 *
 * The external engine decides WHAT TO TRY. `runReadTool` and `runProposeTool`
 * decide WHAT IS PERMITTED. Every tool this adapter produces routes its `run`
 * through one of those two funnels, which means an agent driven by third-party
 * code passes through the identical gate a human-driven MCP call does: token
 * audience, credential liveness, deny-by-default tool exposure, the autonomy
 * ceiling, the policy card, credential capability and scope, then the same
 * `assertPermission` / `assertCan*` the equivalent human route uses — with
 * exactly one hash-chained audit row per call and per refusal.
 *
 * Nothing here re-implements any of that, and nothing here may. If a future
 * edit finds itself reaching for a permission check — or for a usecase, or for
 * Prisma — in this file, the change belongs in the funnel.
 *
 * ## The advertised set is NARROWER than MCP's, deliberately
 *
 * `loadableReadTools` and `loadableProposeTools` give the offered set: exposure
 * allowlist ∩ register grants ∩ policy card, plus the principal's permissions
 * on the read side and the credential's propose capability on the other. That
 * is what MCP's `tools/list` advertises, and it stops there on purpose —
 * credential resource scope and the autonomy ceiling are call-time decisions
 * that write audit rows, and a listing must not make an authorization claim it
 * records nothing for.
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
 * free-text output is not egress-scanned. That is safe only because of where
 * such output can GO, and there are exactly two places.
 *
 *   • OUTPUT THAT BECOMES AN ACTION goes through a propose tool, so it is a
 *     tool ARGUMENT and the egress slice above has already scanned it before
 *     the funnel ran. `createAgentProposal` then guards each item again and can
 *     quarantine it on its own, recording `guardVerdict` / `guardRuleIds` /
 *     `guardInputDigest` on the row. Two scans, neither of them this one.
 *
 *   • OUTPUT THAT BECOMES NOTHING reaches exactly one column:
 *     `AiDecisionLog.outputSummary`, the EU AI Act Art 12 record, where
 *     `logAiDecision` sanitises it and bounds it to `SUMMARY_MAX`. It is not
 *     written to the step ledger — `executeFlueRun` says so at the
 *     `MODEL_CALL` step and means it — it is not returned to any caller, and
 *     it never re-enters the model's context, because a dispatch is one turn
 *     and the runtime's own loop feeds back tool RESULTS, which the untrusted-
 *     input slice above scans.
 *
 * THIS PARAGRAPH USED TO BE WRONG, which is why it is now pinned by
 * `tests/guards/flue-model-output-has-one-destination.test.ts`. It claimed
 * output "becomes an `AgentProposal`" at a time when the Flue adapter offered
 * read tools only, so there was no propose tool for a model to call and the
 * justification described a path that did not exist. A comment that explains
 * why a guard is unnecessary is load-bearing exactly like the guard would have
 * been, and this one was discharging that duty against a future.
 *
 * ## What lives here now, and what moved
 *
 * Step 0a of `docs/claude-agent-sdk-design.md` moved the engine-neutral half of
 * this file into `src/lib/agentic/engine-tools/`: the scope / autonomy /
 * read-only narrowing (`offerToolSet`), the guarded call (`runGuardedTool`) and
 * the latch and verdict types. What stays is what is Flue-shaped: the valibot
 * schema, the `FlueToolDefinition` the runtime's `useTool` takes, the delegate
 * answer of the runtime's own `task` tool, and the compile-time check against
 * the published types. Everything said above about the sandwich and the probe
 * is now true of every engine that uses the core, not of Flue alone.
 */
import type * as v from 'valibot';

import type { RequestContext } from '@/app-layer/types';
import {
    guardUntrustedInput,
    assertGuardAllowed,
    assertNoReviewRequired,
} from '@/app-layer/ai/guard';
import type { McpInvocation } from '@/lib/mcp/authorize';
import {
    offerToolSet,
    runGuardedTool as runEngineGuardedTool,
    stepVerdictOf,
    ReviewLatch,
    type GuardObserver,
    type OfferedToolSet,
    type OriginResolver,
} from '@/lib/agentic/engine-tools';

import { toValibotInputSchema } from './json-schema-to-valibot';

// The engine-neutral names this module used to declare, re-exported so every
// importer — the Flue engine, the assistant and their tests — reads them from
// where it always has. They are DECLARED in `engine-tools/` and only there.
export {
    ReviewLatch,
    type GuardObserver,
    type OriginResolver,
    type ReviewFlag,
    type StepGuardObservation,
    type ToolOmissionReason,
} from '@/lib/agentic/engine-tools';

/**
 * Flue's name in every guard source a Flue tool call writes:
 * `flue-tool-args:…`, `flue-tool-result:…`, `flue-tool-result-egress:…`. The
 * strings those sources carried before the core moved, so no audit row changes
 * shape.
 */
const FLUE_GUARD_SOURCE_PREFIX = 'flue';

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
     * application code reads the hints to gate calls. `readOnlyHint` is a fact
     * about WHICH FUNNEL the closure below routes to rather than a per-tool
     * claim to be kept in sync: a read tool's `run` can only reach
     * `McpReadTool.run`, and a propose tool's can only reach the proposal
     * queue, which is a write and says so.
     *
     * `destructiveHint` is false throughout, and that is true by construction
     * of both paths: a read changes nothing, and the propose surface queues a
     * PENDING row a human approves — no tool this adapter can emit destroys or
     * overwrites a record.
     */
    annotations: { readOnlyHint: boolean; destructiveHint: false; title: string };
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

/** A Flue tool set: the engine-neutral offer, in the shape `useTool` takes. */
export type FlueToolSet = OfferedToolSet<FlueToolDefinition>;

/**
 * SCAN A DELEGATE'S ANSWER, exactly as a tool RESULT is scanned (#3473).
 *
 * Lives here rather than in the driver because the delegate is the RUNTIME's
 * own `task` tool, so this is Flue-shaped; what it shares with a tool result it
 * takes from the core: `stepVerdictOf` from `engine-tools/review-latch.ts`, and
 * the two assertions and the guard call that `ReviewLatch.check` makes. A second
 * implementation in the driver would be the same sandwich with its own
 * opinions about which verdicts throw.
 *
 * ## Why a delegate's answer is a tool result in every respect that matters
 *
 * It crosses into the parent's context as the `task` tool's return value. The
 * only thing that makes it special is that `task` belongs to the RUNTIME, so
 * `wrapForLedger` never sees it — which is why nothing was scanning it.
 *
 * The delegate's own READS need no help: `narrowTools` hands it the parent's
 * own tool objects, so each one runs the parent's wrapper and is scanned both
 * directions, recorded in the parent's ledger and charged to its budget.
 * Measured. What is left is the composed answer.
 *
 * ## It reports through the SAME observer, so a flag settles the run
 *
 * A flagged answer trips the same latch a flagged tool result does, which is
 * what puts the run into `AWAITING_APPROVAL` with the flag attached. Reported
 * BEFORE the assertions for the reason `check` gives: both of those paths
 * leave by throwing, and observing afterwards would record every clean verdict
 * and drop every refusal.
 *
 * `slice: 'result'` because that is what it is, and the ledger folds every
 * verdict for one id into the worst seen. The `tool` is `task` — the name the
 * model called, not the specialist it selected, because the specialist is in
 * the arguments and this field is the tool.
 */
export async function guardDelegateAnswer(
    ctx: RequestContext,
    text: string,
    taskId: string | undefined,
    observe: GuardObserver | undefined,
): Promise<void> {
    const outcome = await guardUntrustedInput(ctx, text, {
        source: `flue-delegate-answer:${taskId ?? 'unknown'}`,
    });
    observe?.({
        toolCallId: taskId ?? 'standalone',
        tool: 'task',
        slice: 'result',
        verdict: stepVerdictOf(outcome),
        ruleIds: [...(outcome.ruleIds ?? [])],
    });
    assertGuardAllowed(outcome);
    assertNoReviewRequired(outcome);
}

/**
 * Build the tool set for one invocation: the read surface and the propose
 * surface, each narrowed by the same two call-time terms.
 *
 * Pure apart from the schema conversion; performs no authorization and writes
 * no audit row. The returned `run` closures are where anything happens.
 */
export function flueToolsFor(
    inv: McpInvocation,
    observe?: GuardObserver,
    originFor?: OriginResolver,
    opts: {
        /**
         * The run's workflow declares `readOnly` (#3749): offer the read
         * surface alone. Every propose tool the registry would have offered is
         * listed as omitted, so "offered no propose tool" is a fact the run
         * records rather than one inferred from an empty list.
         */
        readOnly?: boolean;
    } = {},
): FlueToolSet {
    return offerToolSet<FlueToolDefinition>(
        inv,
        ({ tool, capability, run }) => {
            let input: v.GenericSchema<Record<string, unknown>, unknown>;
            try {
                input = toValibotInputSchema(tool.name, tool.inputSchema);
            } catch {
                // A tool whose schema this build cannot express is DROPPED, not
                // offered without one. Offering it unschema'd would hand the model
                // a tool it cannot call correctly and no signal that anything was
                // wrong; dropping it is visible in `omitted`, and the converter's
                // own test fails CI before this branch can be reached in practice.
                return null;
            }
            return {
                name: tool.name,
                description: tool.description,
                input,
                annotations: {
                    readOnlyHint: capability === 'read',
                    destructiveHint: false,
                    title: tool.name,
                },
                run: (context) => run(context.data, context.toolCallId),
            };
        },
        { sourcePrefix: FLUE_GUARD_SOURCE_PREFIX, observe, originFor, readOnly: opts.readOnly },
    );
}

/**
 * One guarded tool call: egress on the arguments, the funnel, untrusted-input
 * on the result.
 *
 * Exported for the tests, which need to exercise the sandwich without building
 * a whole tool set.
 *
 * WHICH funnel is decided from the NAME, by asking the registry that owns the
 * answer, rather than from a parameter the caller supplies. A parameter would
 * need a default, and the default would route a propose name into the read
 * funnel for any caller that forgot it — a refusal, but a misreported one. The
 * name is the whole input either way: both funnels resolve it through this
 * invocation's pinned manifest, so a tool this run was never offered is
 * refused with its own audit row before any object is obtained.
 */
export async function runGuardedTool(
    inv: McpInvocation,
    name: string,
    args: Record<string, unknown>,
    toolCallId = 'standalone',
    review: ReviewLatch = new ReviewLatch(),
    /**
     * Forwarded verbatim to `runProposeTool` and ignored on a read. Absent for
     * the direct MCP route and for a standalone call, which is what the
     * funnel's optional parameter is for.
     */
    origin?: { runId: string; stepSeq: number },
): Promise<string> {
    // The engine-neutral call, under Flue's name. The positional signature is
    // the one this export has always had, so its callers and tests are as
    // they were; the sandwich itself lives in `engine-tools/run-guarded-tool.ts`.
    return runEngineGuardedTool(inv, name, args, {
        sourcePrefix: FLUE_GUARD_SOURCE_PREFIX,
        toolCallId,
        review,
        origin,
    });
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
