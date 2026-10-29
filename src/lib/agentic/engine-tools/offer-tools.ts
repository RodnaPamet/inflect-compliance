/**
 * WHAT AN AGENT IS OFFERED: the read surface and the propose surface, narrowed
 * to what this invocation will actually be permitted, for every engine Inflect
 * runs.
 *
 * Engine-neutral: no import of `@flue/*`, `valibot` or any ESM-only package
 * (enforced in `eslint.config.mjs`). Moved out of `flue/tools-adapter.ts` in
 * Step 0a of `docs/claude-agent-sdk-design.md`. What differs between engines is
 * only the SHAPE a tool is handed over in — Flue wants a valibot schema, another
 * engine a JSON schema — so that is the one thing an engine supplies, as a
 * `ToolBuilder`. The narrowing, the latch and the guarded call are shared.
 *
 * Why the advertised set is narrower than MCP's `tools/list`, and why the
 * narrowing is an advertising probe rather than an enforcement, is recorded in
 * the header of `flue/tools-adapter.ts`.
 */
import type { RequestContext } from '@/app-layer/types';
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import {
    requiredAutonomyFor,
    withinCeiling,
    type McpCapabilityClass,
} from '@/lib/agentic/autonomy-ceiling';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { loadableReadTools } from '@/lib/mcp/tools/registry';
import { loadableProposeTools } from '@/lib/mcp/tools/propose-tools';
import type { McpReadTool } from '@/lib/mcp/tools/types';

import { ReviewLatch, type GuardObserver } from './review-latch';
import { runGuardedTool } from './run-guarded-tool';

/**
 * The autonomy class each surface sits in — a fact about which REGISTRY a tool
 * came out of, not per-tool data. Reading a tenant is rung 1; drafting into the
 * approval queue is rung 2, because putting words in front of an approver is a
 * different act. Both numbers live in `AUTONOMY_REQUIRED_BY_CAPABILITY`, and
 * `requiredAutonomyFor` is what turns a class into a rung here exactly as it
 * does at the two enforcement seams.
 */
const READ_CAPABILITY: McpCapabilityClass = 'read';
const PROPOSE_CAPABILITY: McpCapabilityClass = 'propose';

/**
 * Narrow the runtime's `unknown` arguments to the object shape the funnel takes.
 *
 * A non-object — which the runtime should never produce for an object schema —
 * becomes `{}` rather than throwing. The funnel then validates `{}` against the
 * tool's Zod schema and refuses it if arguments were required, which is a
 * better-reported failure than a `TypeError` thrown inside someone else's event
 * loop.
 */
export function asToolArgs(data: unknown): Record<string, unknown> {
    return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
}

/**
 * Why a tool was not advertised. Diagnostic only — never a refusal.
 * `READ_ONLY_WORKFLOW` is a propose tool withheld because the run's workflow
 * declares `readOnly` (#3749). `PROFILE_TOOL_NOT_GRANTED` is a tool an agent
 * profile names that the agent's current grants no longer reach, typically a
 * grant revoked after the profile version was approved (#4143).
 * `CONNECTION_READ_ONLY` is an EXTERNAL write-classified tool whose connection
 * sits at the ladder's `DISABLED` rung, where the dispatch would refuse it with
 * nothing sent (#3872).
 */
export type ToolOmissionReason =
    | 'SCOPE'
    | 'AUTONOMY'
    | 'UNCONVERTIBLE_SCHEMA'
    | 'READ_ONLY_WORKFLOW'
    | 'PROFILE_TOOL_NOT_GRANTED'
    | 'CONNECTION_READ_ONLY';

/**
 * One tool that survived the narrowing, handed to the engine to put in its own
 * shape.
 *
 * `run` is the ONLY way the engine's tool may execute: it is `runGuardedTool`
 * already bound to this invocation, this run's latch, the engine's guard source
 * prefix and, on the propose surface, the run's origin. An engine passes it the
 * arguments exactly as the model sent them — `unknown`, narrowed by `asToolArgs`
 * here — and the runtime's own call id.
 */
export interface OfferedTool {
    readonly tool: OfferableTool;
    readonly capability: McpCapabilityClass;
    readonly run: (data: unknown, toolCallId: string) => Promise<string>;
}

/**
 * The engine's half: put one offered tool in the engine's shape, or return
 * `null` when this engine cannot express the tool's input schema.
 *
 * A `null` drops the tool and records `UNCONVERTIBLE_SCHEMA`, rather than
 * offering it without a schema: a tool the model cannot call correctly, with
 * no signal that anything was wrong, is worse than a visible omission.
 */
export type ToolBuilder<T> = (offered: OfferedTool) => T | null;

export interface OfferedToolSet<T> {
    tools: T[];
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
function holdsScope(ctx: RequestContext, tool: OfferableTool): boolean {
    try {
        enforceApiKeyScope(ctx, tool.resourceScope.resource, tool.resourceScope.action);
        return true;
    } catch {
        return false;
    }
}

/**
 * What the advertising probe reads off a tool.
 *
 * A read tool and a propose tool differ in how they RUN and agree on every
 * field this probe looks at, so the probe is written once against what they
 * share. Two near-identical loops is how the card term went missing from one
 * copy of the MCP listing and not the other.
 */
/**
 * WHICH STEP OF WHICH RUN a call belongs to, resolved at call time.
 *
 * A resolver rather than a value because the tool set is built once per run and
 * a step seq is allocated per call — and keyed by `toolCallId` rather than held
 * in a field because the runtime may have more than one call in flight, which
 * is the same reason the guard observations are keyed that way. Returning
 * `undefined` is a real answer: a caller with no run (the direct MCP route)
 * supplies no resolver at all, and `runProposeTool`'s own signature makes
 * absence an answer rather than an omission.
 */
export type OriginResolver = (toolCallId: string) => { runId: string; stepSeq: number } | undefined;

export type OfferableTool = Pick<
    McpReadTool<unknown>,
    'name' | 'description' | 'inputSchema' | 'resourceScope' | 'authorize' | 'externalConnection'
>;


/**
 * Narrow one surface's loadable set to what this invocation will actually be
 * permitted, and wrap each survivor's `run` in the guard sandwich.
 *
 * The candidate list is already the exposure ∩ register-grant ∩ policy-card
 * intersection its own registry computed; this adds the two call-time terms a
 * listing may not claim — the credential's resource scope and the autonomy
 * ceiling — by calling the very functions the funnel calls.
 */
function offerTools<T>(
    inv: McpInvocation,
    candidates: readonly OfferableTool[],
    capability: McpCapabilityClass,
    review: ReviewLatch,
    build: ToolBuilder<T>,
    sourcePrefix: string,
    originFor?: OriginResolver,
): Pick<OfferedToolSet<T>, 'tools' | 'omitted'> {
    const tools: T[] = [];
    const omitted: OfferedToolSet<T>['omitted'] = [];

    for (const tool of candidates) {
        if (!holdsScope(inv.ctx, tool)) {
            omitted.push({ name: tool.name, reason: 'SCOPE' });
            continue;
        }

        // BOTH arguments, as both enforcement seams in `authorize.ts` pass
        // them. The class supplies the rung its surface sits on, and a tool's
        // own declared override replaces it. Passing only the class would
        // advertise a tool that declares a higher rung and then watch the
        // funnel refuse every call to it — the exact mismatch this probe is
        // here to prevent.
        const required = requiredAutonomyFor(capability, tool.authorize.autonomy);
        if (!withinCeiling(required, inv.autonomyCeiling)) {
            omitted.push({ name: tool.name, reason: 'AUTONOMY' });
            continue;
        }

        // ── READ-ONLY STAYS READ-ONLY (#3872) ───────────────────────────────
        //
        // The same argument as the AUTONOMY probe directly above, one axis
        // over: there, a tool whose required rung exceeds the AGENT's ceiling;
        // here, a write-classified tool whose CONNECTION sits at the ladder's
        // `DISABLED` rung. `dispatchWrite` handles `DRY_RUN`, `PROPOSE_ONLY`
        // and `AUTOMATIC` and falls through to a refusal that sends nothing, so
        // offering it advertises a tool every call to which is refused.
        //
        // Both terms were read at invocation-build time from the same values
        // the dispatch branches on (`external-tools.ts::adapterFor`), so the
        // offer cannot form a different opinion about whether a tool is a write
        // or whether its connection takes one. Internal tools carry no
        // `externalConnection` at all, which is why absence skips this entirely
        // rather than defaulting either way.
        if (tool.externalConnection?.declaresWrite && tool.externalConnection.connectionRefusesWrites) {
            omitted.push({ name: tool.name, reason: 'CONNECTION_READ_ONLY' });
            continue;
        }

        const built = build({
            tool,
            capability,
            run: (data, toolCallId) =>
                runGuardedTool(inv, tool.name, asToolArgs(data), {
                    sourcePrefix,
                    toolCallId,
                    review,
                    origin: originFor?.(toolCallId),
                }),
        });
        if (built === null) {
            omitted.push({ name: tool.name, reason: 'UNCONVERTIBLE_SCHEMA' });
            continue;
        }
        tools.push(built);
    }

    return { tools, omitted };
}

/**
 * Build the tool set for one invocation: the read surface and the propose
 * surface, each narrowed by the same two call-time terms.
 *
 * Pure apart from the schema conversion; performs no authorization and writes
 * no audit row. The returned `run` closures are where anything happens.
 */
export function offerToolSet<T>(
    inv: McpInvocation,
    build: ToolBuilder<T>,
    opts: {
        /** The engine's guard source prefix; see `runGuardedTool`. */
        readonly sourcePrefix: string;
        readonly observe?: GuardObserver;
        readonly originFor?: OriginResolver;
        /**
         * The run's workflow declares `readOnly` (#3749): offer the read
         * surface alone. Every propose tool the registry would have offered is
         * listed as omitted, so "offered no propose tool" is a fact the run
         * records rather than one inferred from an empty list.
         */
        readonly readOnly?: boolean;
        /**
         * The run executes an agent profile (#4143): offer only the tools it
         * names. The candidates are still the registry's loadable set (the
         * agent's current grants, its policy card and the exposure), so this
         * only NARROWS: a tool the profile names that the agent no longer
         * reaches is not offered and is listed as `PROFILE_TOOL_NOT_GRANTED`,
         * never failed open. An empty list offers nothing. Absent means the
         * engine's usual offer.
         */
        readonly profileTools?: readonly string[];
    },
): OfferedToolSet<T> {
    // One latch for the RUN — review, once required, stays required across
    // every subsequent tool, on EITHER surface. The observer is per-run too;
    // observations carry their own `toolCallId` so concurrent calls cannot
    // cross. A second latch for the propose tools would let a flagged read be
    // followed by a clean proposal, which is the routing-around it exists to
    // stop, and on the surface where it would matter most.
    const review = new ReviewLatch(opts.observe);

    const profileTools = opts.profileTools === undefined ? null : new Set(opts.profileTools);
    const inProfile = (t: OfferableTool): boolean => profileTools === null || profileTools.has(t.name);
    const readCandidates = loadableReadTools(inv);
    const proposeCandidates = loadableProposeTools(inv);

    const read = offerTools(inv, readCandidates.filter(inProfile), READ_CAPABILITY, review, build, opts.sourcePrefix);
    // The origin resolver reaches only the propose surface, because only a
    // propose call writes a row that can carry one. Passing it to both would
    // read as though a read were being attributed somewhere.
    const propose: Pick<OfferedToolSet<T>, 'tools' | 'omitted'> = opts.readOnly
        ? {
              tools: [],
              omitted: proposeCandidates.filter(inProfile).map((t) => ({ name: t.name, reason: 'READ_ONLY_WORKFLOW' as const })),
          }
        : offerTools(
              inv,
              proposeCandidates.filter(inProfile),
              PROPOSE_CAPABILITY,
              review,
              build,
              opts.sourcePrefix,
              opts.originFor,
          );

    // A tool the profile names that neither registry would load for this
    // agent now: the grant was revoked, the card narrowed or the tool left the
    // exposure. Recorded, so a profile run that cannot do what its author
    // chose says why rather than looking incapable.
    const lost: OfferedToolSet<T>['omitted'] =
        profileTools === null
            ? []
            : [...profileTools]
                  .filter((name) => !readCandidates.some((t) => t.name === name) && !proposeCandidates.some((t) => t.name === name))
                  .sort()
                  .map((name) => ({ name, reason: 'PROFILE_TOOL_NOT_GRANTED' as const }));

    return {
        tools: [...read.tools, ...propose.tools],
        omitted: [...read.omitted, ...propose.omitted, ...lost],
        review,
    };
}
