/**
 * Conversational compliance assistant (PR-10).
 *
 * READ-MOSTLY + governed. A natural-language question is answered from the
 * tenant's live posture data (the stable `getDashboardData` stats shape, read
 * inside the tenant RLS context). Any ACTION the user asks for (raise a
 * finding / create a risk) is NEVER executed here — it is handed off to the
 * EXISTING agent-proposal queue (`createAgentProposal`) as a PENDING proposal
 * that a human approves in the review queue, which then runs the real
 * create-usecase. This reuses the load-bearing propose-not-commit safety gate
 * already built for external agents (see `agent-proposals.ts`) rather than
 * inventing a parallel one.
 *
 * Governed-AI ordering mirrors risk-suggestions / questionnaire:
 *   enforceFeatureGate → checkRateLimit → guardUntrustedInput → answer/propose
 *   → guardEgress → recordGeneration.
 *
 * The intent router is deterministic (keyword-based) in this first cut; a
 * provider-backed LLM tool-use loop is the additive enhancement — the
 * governance + tenant-scoping + propose-not-commit invariants are independent
 * of it.
 */
import { z } from 'zod';
import type { RequestContext } from '../types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { enforceFeatureGate } from '@/app-layer/ai/risk-assessment/feature-gate';
import { checkRateLimit, recordGeneration } from '@/app-layer/ai/risk-assessment/rate-limiter';
import { recordAiGeneration } from '@/lib/observability/integration-metrics';
import { logger } from '@/lib/observability/logger';
import { guardUntrustedInput, guardEgress, assertGuardAllowed, assertNoReviewRequired } from '@/app-layer/ai/guard';
import { getDashboardData } from './dashboard';
import { runInTenantContext } from '@/lib/db-context';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { RESIDENCY_SELECT, residencyTermsFrom, resolveFlueModel } from '@/lib/agentic/flue/model-selection';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { assistantTools, type ProposalOutcome } from '@/app-layer/ai/assistant/tools';
import { assistantProviderFor } from '@/app-layer/ai/assistant/turn-provider';
import { runAssistantLoop, haltNotice, DEFAULT_LOOP_BOUNDS, type LoopOutcome } from '@/app-layer/ai/assistant/tool-loop';
import type { AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';
import { env } from '@/env';

/**
 * The user-facing sentence for a queued proposal.
 *
 * A proposal the agentic output guard QUARANTINES never enters the review
 * queue, so telling the asker it is "queued for review" would be false — and
 * false in the direction that matters: they would wait for an approval that
 * cannot arrive, and nobody would look at the quarantine. See
 * `ai/guard/proposal-guard.ts`.
 */
function proposalMessage(
    status: string,
    noun: string,
    title: string,
): string {
    if (status === 'QUARANTINED') {
        return (
            `I could not queue the ${noun} "${title}": its text was withheld by the ` +
            `content guard, which refuses material that reads as an instruction rather ` +
            `than as a record. Nothing was created. Rephrase it, or ask an administrator ` +
            `to review the quarantined item.`
        );
    }
    return `I've queued a ${noun} "${title}" as a proposal for review — nothing is created until a reviewer approves it.`;
}

/**
 * The user-facing sentence for a turn that proposed something (#3882).
 *
 * ═══ COMPOSED, NEVER RELAYED ═══
 *
 * The model's own sentence is not used. The funnel's result tells the truth
 * and the system prompt instructs the model to repeat it, but an instruction
 * is not an enforcement: the model could paraphrase, and the paraphrase that
 * matters is "queued for review" about something that was quarantined. Then
 * the asker waits for an approval that cannot arrive and nobody looks at the
 * quarantine — false in the direction that costs most.
 *
 * So the verdict here comes only from WHICH ID ARRAY the funnel put an id in.
 * The title is quoted from the item, exactly as the deterministic keyword path
 * always did, and sanitised the same way.
 *
 * The one-item wording is `proposalMessage`'s, unchanged, so the common path's
 * text does not move because the producer changed.
 */
function proposalOutcomeMessage(outcomes: readonly ProposalOutcome[]): string {
    const queued = outcomes.flatMap((o) => o.queued);
    const quarantined = outcomes.flatMap((o) => o.quarantined);
    const unreadable = outcomes.some((o) => o.unreadable === true);
    const noun = nounFor(outcomes);

    // An unreadable result is reported as unknown, never as "nothing was
    // created". A row may exist, and claiming otherwise is the one sentence
    // that cannot be walked back.
    if (unreadable) {
        return (
            `I submitted the ${noun} but could not read back what happened to it. ` +
            `Check the agent-proposals review queue before trying again — it may ` +
            `already be there, and asking twice would queue it twice.`
        );
    }

    const title = (i: number): string =>
        sanitizePlainText(outcomes.flatMap((o) => o.titles)[i] ?? '').slice(0, 200) || 'Untitled';

    // ONE item, which is the overwhelmingly common case: the exact sentence
    // the keyword path produced, so nothing user-visible changes with the
    // producer.
    if (queued.length + quarantined.length === 1) {
        return proposalMessage(quarantined.length === 1 ? 'QUARANTINED' : 'PENDING', noun, title(0));
    }

    if (queued.length === 0) {
        return (
            `I could not queue ${quarantined.length} ${noun}(s): the content guard ` +
            `withheld them, which it does for material that reads as an instruction ` +
            `rather than as a record. Nothing was created and nothing is awaiting ` +
            `review. Rephrase, or ask an administrator to look at the quarantined items.`
        );
    }
    if (quarantined.length === 0) {
        return (
            `I've queued ${queued.length} ${noun}(s) as proposals for review — ` +
            `nothing is created until a reviewer approves them.`
        );
    }
    // MIXED, and said as two facts rather than one summary. A single number
    // here is what let "3 proposed" stand for a batch that queued one.
    return (
        `I've queued ${queued.length} ${noun}(s) for review. ${quarantined.length} ` +
        `were withheld by the content guard and did NOT enter the queue — nothing ` +
        `was created for those, and no reviewer will see them.`
    );
}

/** The noun to use, from the funnel's own `kind`. */
function nounFor(outcomes: readonly ProposalOutcome[]): string {
    const kinds = new Set(outcomes.map((o) => o.kind).filter((k) => k !== 'unknown'));
    if (kinds.size === 1) return [...kinds][0].toLowerCase();
    // Several kinds in one turn, or none reported: a neutral noun rather than
    // a guessed one. Naming the wrong entity in a compliance record is worse
    // than naming none.
    return 'item';
}

import { describePageContext, PageContextSchema, type PageContext } from '@/app-layer/ai/assistant/page-context';
import { checkGuidanceRoutes, GUIDANCE_ROUTE_REFUSAL } from '@/app-layer/ai/assistant/guidance';
import { routeTableForPrompt } from '@/app-layer/ai/assistant/nav-routes';

export const AskAssistantSchema = z.object({
    question: z.string().min(1).max(2000),
    /**
     * What the user is looking at (#3841). OPTIONAL, which is what keeps
     * `/assistant/ask` unchanged for its existing callers (#3822) — an older
     * client that sends only a question behaves exactly as before.
     */
    pageContext: PageContextSchema.optional(),
});

export interface AssistantAnswer {
    kind: 'answer' | 'proposal';
    message: string;
    /** Present when kind='proposal' — the PENDING agent-proposal awaiting human approval. */
    proposalId?: string;
    proposalKind?: string;
    /**
     * The proposal's own status, so a CALLER can tell queued from quarantined
     * without parsing the message (#3847).
     *
     * `proposalMessage` already says the right thing in prose — a quarantined
     * item is told plainly that nothing was created. But a UI that wants to
     * render a status chip and a link to the review queue would otherwise have
     * to infer the status from that sentence, and the one thing it must never
     * do is call a quarantined proposal queued. Inferring a safety property
     * from prose is how that goes wrong, so the status travels as data.
     */
    proposalStatus?: string;
}


/**
 * Answer a read question from live tenant data, or PROPOSE an action (via the
 * existing agent-proposal queue — never a direct mutation).
 */
export async function askAssistant(
    ctx: RequestContext,
    input: z.infer<typeof AskAssistantSchema>,
): Promise<AssistantAnswer> {
    return runGoverned(
        ctx,
        input.question,
        (question, contextBlock) => produceAnswer(ctx, question, contextBlock),
        input.pageContext,
    );
}

/**
 * THE GOVERNED ORDERING, in one place (#3809).
 *
 * ```
 * enforceFeatureGate -> checkRateLimit -> guardUntrustedInput
 *   -> <produce> -> guardEgress -> recordGeneration
 * ```
 *
 * Extracted when the streaming entry point arrived, because the alternative was
 * a second copy of this sequence. Two copies look identical at review time and
 * diverge at the first edit that touches only one — and what would diverge here
 * is the order of the guards, which is the one property this file exists to
 * hold. `tests/unit/usecases/assistant.test.ts` asserts the sequence; it now
 * asserts it for both callers at once.
 *
 * The producer sees a question that has ALREADY passed the input guard, and its
 * output is guarded on the way out. It cannot reorder either.
 */
/**
 * How a turn was actually produced, for the Art 12 row.
 *
 * Reported by the producer rather than assumed by the logger, because the two
 * paths differ in the one way the record must not get wrong: the loop calls a
 * MODEL, and the keyword router calls none. A row naming a provider and model
 * for an answer the deterministic router composed would be a false Art 12
 * record — and false in the direction that matters, since the whole purpose of
 * the row is to say what produced the output.
 */
interface ProducedBy {
    readonly provider: string;
    readonly model: string | null;
    readonly toolCalls: number;
    /**
     * What the turn cost, null when unknown (#3833).
     *
     * ═══ THE ASSISTANT IS METERED SEPARATELY, AND HERE IS WHY ═══
     *
     * `agentMonthlyTokenBudget` is AGENT-scoped by name, and `spentThisMonth`
     * sums `workflowRun.costTokens`. The assistant creates no run, so its spend
     * is invisible to that ceiling — which the roadmap correctly flagged as a
     * second, unbudgeted path.
     *
     * It is NOT folded into that sum. Doing so would silently redefine a
     * setting tenants have already configured: an agent budget would begin
     * refusing agent runs because a human used the assistant, and every other
     * AI feature's spend would start counting too.
     *
     * What bounds it instead: `checkRateLimit` already applies
     * `AI_RISK_DAILY_QUOTA` (50 turns per tenant per day by default) and
     * `AI_RISK_USER_RPM` (5 per user per minute). With `MAX_TOKENS` at 8192 per
     * round-trip and the loop capped at 6 iterations, a turn's ceiling is
     * ~49k output tokens and a tenant's day is bounded above by 50 of those.
     * That is a real bound, derived rather than asserted.
     *
     * And the spend is RECORDED per turn here, so it is visible and
     * attributable even though no ceiling refuses it. An unrecorded cost would
     * be the actual defect; an un-gated but measured one is a decision.
     */
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
}

async function runGoverned(
    ctx: RequestContext,
    question: string,
    produce: (
        question: string,
        contextBlock: string | null,
    ) => Promise<{ answer: AssistantAnswer; by: ProducedBy }>,
    pageContext?: PageContext,
): Promise<AssistantAnswer> {
    await enforceFeatureGate(ctx, 'assistant');
    await checkRateLimit(ctx.tenantId, ctx.userId);

    // The question is untrusted external input — guard before it steers
    // anything. H2 — auto-draft surface: abort on ANY review-required verdict
    // (flag OR block) so an injected prompt never reaches the model/router even
    // under the default balanced guard mode.
    assertNoReviewRequired(await guardUntrustedInput(ctx, question, { source: 'assistant' }));

    // The page context is a SIXTH customer-controlled field (#3841), so it is
    // guarded on the same path as the question rather than trusted for having
    // a narrow schema. Its shape forbids most prose; "disregard the above" is
    // only letters and spaces, so shape alone is not the defence.
    //
    // A separate `source` so a refusal says WHICH field carried the injection:
    // "the assistant refused" with no field named is a report that arrives
    // without a reproduction.
    const contextBlock = describePageContext(pageContext);
    if (contextBlock !== null) {
        assertNoReviewRequired(
            await guardUntrustedInput(ctx, contextBlock, { source: 'assistant:page-context' }),
        );
    }

    const startedAt = Date.now();
    // `let`, not `const`: the guidance check below replaces the answer when it
    // names a route the nav cannot vouch for.
    let { answer, by } = await produce(question, contextBlock);

    // Guard the outbound message before it leaves the boundary.
    assertGuardAllowed(await guardEgress(ctx, { message: answer.message }, { source: 'assistant:outbound' }));

    // ── GUIDANCE MUST STAY INSIDE THE REAL IA (#3845) ──
    //
    // The route table is in the prompt, which makes naming a path recall-free
    // — but an instruction is not an enforcement, so the answer is checked.
    // A path the nav cannot vouch for replaces the ANSWER rather than being
    // stripped from it: deleting the path would leave the surrounding
    // sentence ("open and read the panel on the right") reading as though a
    // screen exists, which is the same wrong belief with the evidence
    // removed.
    //
    // Deliberately AFTER the egress guard and BEFORE the decision-log row, so
    // what gets recorded is what the user was actually shown.
    const guidance = checkGuidanceRoutes(answer.message);
    if (!guidance.ok) {
        logger.warn('assistant.guidance_route_refused', {
            tenantId: ctx.tenantId,
            unknownRoutes: guidance.unknownRoutes,
        });
        answer = { kind: 'answer', message: GUIDANCE_ROUTE_REFUSAL };
    }

    // ── ART 12 RECORD: ONE ROW PER TURN (#3828) ──
    //
    // The unit is the turn, and the append-only trigger is what settles it: a
    // conversation-level row could not accumulate turns, so it would have to be
    // written once at the end — leaving NO record for a conversation the user
    // abandons, which is the wrong failure for record-keeping. Conversation
    // grouping, when wanted, is `sessionRef` across turn rows.
    //
    // AFTER the egress guard, so the summary records what the user was actually
    // allowed to see rather than what the model first produced.
    //
    // Best-effort: a logging failure must not deny the user their answer. The
    // row is the record of a decision already made, not a precondition for it.
    try {
        await runInTenantContext(ctx, (db) =>
            logAiDecision(db, ctx, {
                feature: 'assistant',
                provider: by.provider,
                model: by.model,
                sanitizedInput: { question: sanitizePlainText(question) },
                outputSummary: answer.message,
                latencyMs: Date.now() - startedAt,
                tokensIn: by.tokensIn,
                tokensOut: by.tokensOut,
                sessionRef: ctx.requestId,
            }),
        );
    } catch (err) {
        logger.warn('assistant: decision log write failed', {
            component: 'assistant',
            error: err instanceof Error ? err.message : String(err),
        });
    }

    await recordGeneration(ctx.tenantId, ctx.userId);
    recordAiGeneration({ feature: 'assistant' }); // H6 — AI cost visibility
    return answer;
}

/** The non-streaming producer: action intents propose, everything else answers. */
async function produceAnswer(
    ctx: RequestContext,
    question: string,
    contextBlock: string | null = null,
    /**
     * Streaming observers, threaded through to the loop (#3899).
     *
     * Empty by default, so the `/assistant/ask` caller is unchanged. The
     * streaming surface used to re-implement a SUBSET of this function and so
     * could not reach the propose branches below at all — the UI rendered a
     * queued-proposal block that nothing could ever produce. One producer for
     * both surfaces, which is the argument `runGoverned` makes one level up:
     * the sequence exists once so two callers cannot drift, and this is the
     * drift that happened a level beneath it.
     */
    observe: ToolLoopObservers = {},
): Promise<{ answer: AssistantAnswer; by: ProducedBy }> {
    const q = question.toLowerCase();
    let answer: AssistantAnswer;
    let by: ProducedBy = DETERMINISTIC;

    // Which policy-card version governs a proposal queued from here. The
    // assistant speaks for a HUMAN — `ctx.agentId` is absent on a session
    // context — so this resolves to `NO_POLICY_CARD` without a query. Written
    // anyway rather than left NULL: "no card governed this" and "this row
    // predates pinning" are different facts, and the queue is one table whose
    // rows come from both an agent and a person.
    // NO policy-card pin computed here any more (#3882).
    //
    // It has not been lost — it MOVED, and to a better place. `runProposeTool`
    // pins `pinFromCard(inv.policyCard?.inForce)`: the version that AUTHORIZED
    // this call, taken from the invocation the gate already checked. The pin
    // this line used to compute was a fresh `resolvePolicyCardPin` read, which
    // answers "what is in force now" — a different claim, and the funnel's own
    // comment says why that difference matters: between the gate and the write
    // an operator can have edited the card.

    // ── EVERY intent goes through the loop now (#3882) ──
    //
    // The two keyword propose branches that used to sit here are GONE, not
    // kept as a fallback. They matched a verb and a noun — "raise a finding
    // about X" — and anything phrased differently was answered as a read
    // question, so the capability was reachable only by guessing the pattern.
    //
    // Deleting them rather than leaving them in front of the loop is the point.
    // With both, the keyword branch would win whenever its regex happened to
    // match, so the two producers would disagree on which phrasings propose
    // and a user would get a proposal or an answer depending on their wording.
    // One path means one behaviour.
    //
    // What is NOT lost: the sentence stays deterministic. The loop's propose
    // outcomes are composed by `proposalOutcomeMessage` from the funnel's own
    // id arrays, never from the model's prose — see that function's header.
    const loop = await answerFromToolLoop(ctx, question, observe, contextBlock);
    if (loop !== null) {
        answer = loop.answer;
        by = loop.by;
    } else {
        // The deterministic router, still the fallback when no model is
        // configured. It answers READ questions only, which is honest: with no
        // model there is nothing to turn a request into a proposal.
        answer = await answerFromKeywords(ctx, q);
    }

    return { answer, by };
}

/**
 * The provenance of an answer no model produced.
 *
 * Named rather than inlined so the Art 12 row says `deterministic` explicitly
 * instead of carrying an empty provider that a reader would have to interpret.
 * "No model was called" and "we did not record which model" are different
 * facts, and only one of them is true here.
 */
const DETERMINISTIC: ProducedBy = {
    provider: 'deterministic',
    model: null,
    toolCalls: 0,
    // Zero, not null: a path that calls no model is KNOWN to have cost nothing.
    tokensIn: 0,
    tokensOut: 0,
};

/**
 * The deterministic read router — still here, now as the FALLBACK.
 *
 * `assistant.ts` called this "the first cut", and #3808 replaced it as the
 * PRIMARY path rather than deleting it. Deleting it would regress a tenant who
 * has the assistant enabled and no model configured: today they get real
 * answers from live posture data, and refusing them instead would be a
 * regression dressed as a feature.
 *
 * It is also what makes the assistant the legitimate exception to
 * `resolveFlueModel`'s refuse-rather-than-fall-back rule. That rule exists
 * because "there is no deterministic substitute for a model call" — true for an
 * agent run, false here. This IS the substitute, and it answers from the same
 * RLS-scoped data the loop would read.
 */
async function answerFromKeywords(ctx: RequestContext, q: string): Promise<AssistantAnswer> {
    const { stats } = await getDashboardData(ctx);
    const say = (message: string): AssistantAnswer => ({ kind: 'answer', message });

    if (/\bhigh[-\s]?risk|top risk|critical risk/.test(q)) {
        return say(`You have ${stats.highRisks} high-severity risk(s) (inherent score ≥ 15) out of ${stats.risks} total.`);
    }
    if (/\brisk/.test(q)) {
        return say(`You have ${stats.risks} risk(s) on the register, ${stats.highRisks} of them high-severity.`);
    }
    if (/\bfinding/.test(q)) {
        return say(`You have ${stats.openFindings} open finding(s).`);
    }
    if (/\btask|remediat|action item/.test(q)) {
        return say(`You have ${stats.openTasks} open task(s) in progress.`);
    }
    if (/\bevidence/.test(q)) {
        return say(
            `You have ${stats.evidence} evidence item(s); ${stats.pendingEvidence} awaiting review and ${stats.overdueEvidence} overdue for re-review.`,
        );
    }
    if (/\bcontrol|coverage|soc\s?2|iso|posture|status|summary|overview/.test(q)) {
        return say(
            `Posture: ${stats.controls} control(s), ${stats.risks} risk(s) (${stats.highRisks} high), ${stats.openFindings} open finding(s), ${stats.openTasks} open task(s), ${stats.evidence} evidence item(s).`,
        );
    }
    return say(
        'I can answer read questions about your posture (high risks, open findings, tasks, evidence status, control coverage) and queue actions (raise a finding, create a risk) for a reviewer to approve. What would you like to know?',
    );
}

/**
 * Answer through the LLM tool-use loop, or `null` to fall back (#3808).
 *
 * ═══ WHAT BOUNDS WHAT THIS CAN READ ═══
 *
 * `resolveMcpInvocation(ctx)` on a session context yields `agentId: null`, so
 * `grantedTools` is null and the deny-by-default exposure term is SKIPPED
 * rather than narrowed — `workflow-runs.ts` calls that state "the worse one"
 * for an unbound caller. The binding filter is the one `loadableReadTools`
 * applies last: `canSee(inv, t.authorize.keys)`, the ACTING CONTEXT's own
 * permission keys.
 *
 * So the loop is offered exactly the tools this user could call themselves, and
 * every call runs under their own `RequestContext`. The assistant cannot
 * out-read its asker, and there is no service-account path to make it able to.
 *
 * READ TOOLS ONLY, deliberately — see the note on `readOnly` below.
 */
interface ToolLoopObservers {
    readonly signal?: AbortSignal;
    readonly onToolCall?: (name: string) => void;
    readonly onToolResult?: (name: string, ok: boolean, truncated: boolean) => void;
    readonly onHalt?: (outcome: LoopOutcome, notice: string) => void;
}

async function answerFromToolLoop(
    ctx: RequestContext,
    question: string,
    observe: ToolLoopObservers = {},
    contextBlock: string | null = null,
): Promise<{ answer: AssistantAnswer; by: ProducedBy } | null> {
    // THROUGH `runInTenantContext`, not the global client. `tests/unit/no-direct-prisma.test.ts`
    // forbids a usecase importing `@/lib/prisma` — and the reason is the one that
    // matters here rather than tidiness: this read is tenant-scoped, so it belongs
    // inside the RLS context like every other read on this path. The same
    // correction `risk-suggestions.ts` already carries: "the read stays here, on
    // the `db` this block already holds".
    const secSettings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: RESIDENCY_SELECT,
        }),
    );
    // AI sovereignty: the residency posture decides the model, and LOCAL_ONLY
    // short-circuits before any external consideration. Never `setProvider` —
    // see the header on `tool-loop.ts` for why a race here is a cross-tenant
    // egress rather than a flake.
    const choice = resolveFlueModel(residencyTermsFrom(secSettings));
    if (!choice.ok) return null;

    const provider = assistantProviderFor(choice, env);
    if (provider === null) return null;

    const inv = await resolveMcpInvocation(ctx);
    // `readOnly: true` for now. The propose surface is reachable through the
    // same adapter, but the ACTION branches above still own proposing, because
    // they return a `proposalId` and compose the user-facing sentence from the
    // proposal's own status — which is what keeps a QUARANTINED item from being
    // described as queued. Routing proposals through the loop means relaying
    // the funnel's sentence instead, and the funnel does say it honestly, but
    // the id would be lost to existing callers. Tracked separately rather than
    // half-done here.
    // `readOnly: false` (#3882). The propose surface is offered to the MODEL
    // now, not merely to the adapter — the keyword intents that used to own
    // proposing are gone, so this is the only path to a proposal.
    const set = assistantTools(inv, { readOnly: false });

    const result = await runAssistantLoop({
        provider,
        specifier: choice.specifier,
        system: assistantSystemPrompt(contextBlock),
        question,
        tools: set.tools,
        guardTripped: set.reviewRequired,
        signal: observe.signal,
        // LIVE, per dispatch (#3886). These used to be replayed from
        // `result.calls` AFTER the loop returned: the events arrived in the
        // right order with the right names, and all of them arrived together
        // just before the answer — so the `tool_call` event that exists to
        // explain a pause arrived after the pause had already happened.
        //
        // The replay loop that used to sit here is GONE rather than kept
        // alongside: with both, every call would be announced twice, and a
        // duplicate `tool_call` reads to a client as a second lookup the
        // assistant never made.
        onToolCall: observe.onToolCall,
        onToolResult: observe.onToolResult,
    });

    if (result.outcome !== 'answered') {
        const notice = haltNotice(result.outcome, DEFAULT_LOOP_BOUNDS);
        if (notice !== null) observe.onHalt?.(result.outcome, notice);
    }

    // An empty answer is not an answer. Falling back rather than returning
    // nothing, so a model that said nothing useful does not become a blank
    // reply the user reads as a hang.
    // ── A PROPOSAL'S SENTENCE IS COMPOSED, NOT RELAYED (#3882) ──
    //
    // Checked BEFORE the empty-text fallback: a turn that proposed and then
    // said nothing still proposed, and falling through to the keyword router
    // would answer a read question about a write that already happened.
    const proposals = set.proposals();
    if (proposals.length > 0) {
        const queuedId = proposals.flatMap((o) => o.queued)[0];
        const kindOf = proposals.find((o) => o.queued.length > 0)?.kind;
        return {
            answer: {
                // `proposal` only when something is actually AWAITING REVIEW.
                // An all-quarantined turn created nothing a reviewer will see,
                // so calling it a proposal would be the same false claim in a
                // different field.
                kind: queuedId === undefined ? 'answer' : 'proposal',
                message: proposalOutcomeMessage(proposals),
                ...(queuedId === undefined ? {} : { proposalId: queuedId }),
                ...(kindOf === undefined || kindOf === 'unknown' ? {} : { proposalKind: kindOf }),
                ...(proposals.some((o) => o.quarantined.length > 0)
                    ? { proposalStatus: 'QUARANTINED' }
                    : queuedId === undefined
                      ? {}
                      : { proposalStatus: 'PENDING' }),
            },
            by: {
                provider:
                    choice.specifier.slice(0, Math.max(0, choice.specifier.indexOf('/'))) ||
                    'unknown',
                model: choice.specifier.slice(choice.specifier.indexOf('/') + 1) || null,
                toolCalls: result.calls.length,
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
            },
        };
    }

    if (result.text.trim() === '') return null;
    return {
        answer: { kind: 'answer', message: result.text },
        by: {
            // The specifier is `<provider-id>/<model-id>`; both halves are
            // recorded rather than the whole string, because the Art 12 row
            // asks which model, and a reader should not have to parse.
            provider: choice.specifier.slice(0, Math.max(0, choice.specifier.indexOf('/'))) || 'unknown',
            model: choice.specifier.slice(choice.specifier.indexOf('/') + 1) || null,
            toolCalls: result.calls.length,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
        },
    };
}

/**
 * What the model is told it is, and what it may not do.
 *
 * The prohibitions are the load-bearing half. Each one names a failure the
 * surrounding code cannot prevent on its own: the funnels stop an unpermitted
 * READ, but nothing except this text stops the model inventing a control status
 * when a read FAILED, or describing a quarantined proposal as queued.
 */
/**
 * The STREAMING entry point (#3809).
 *
 * ═══ ONE COPY OF THE GOVERNED ORDERING, NOT TWO ═══
 *
 * The sequence `askAssistant` runs — feature gate, rate limit, input guard,
 * answer, egress guard, record — is the thing this file exists to get right,
 * and two copies of it would be two chances to drift. So the ordering lives
 * once, in `runGoverned` below, and both entry points pass it a producer.
 *
 * Writing a second sequence here would have been the easier diff and the worse
 * one: the copies look identical at review time and diverge at the first edit
 * that touches only one of them.
 *
 * ═══ WHAT STREAMS TODAY, STATED PLAINLY ═══
 *
 * LIFECYCLE events stream: `thinking`, each `tool_call` by name, each
 * `tool_result` with its truncation flag, then the answer, then `done`. A
 * refusal or a halt arrives as its own event with a reason.
 *
 * The ANSWER TEXT arrives as one `answer` event rather than token deltas,
 * because no provider in this codebase streams — verified: zero matches for
 * `stream: true` across `src/app-layer/ai/**`. Token deltas need an SSE parser
 * per provider, which is its own capability and its own tests. The user sees
 * progress throughout either way, which is what stops a pause reading as a
 * hang; they do not yet see the answer assemble word by word.
 */
export interface StreamAssistantOptions {
    readonly emit: (event: AssistantStreamEvent) => void;
    readonly signal?: AbortSignal;
}

export async function streamAssistant(
    ctx: RequestContext,
    input: z.infer<typeof AskAssistantSchema>,
    opts: StreamAssistantOptions,
): Promise<void> {
    try {
        const answer = await runGoverned(
            ctx,
            input.question,
            async (question, contextBlock) => {
                opts.emit({ type: 'thinking' });
                // `produceAnswer`, NOT a re-implementation of part of it (#3899).
                //
                // This used to call `answerFromToolLoop` and fall back to
                // `answerFromKeywords` directly. Both of those answer READ
                // questions — the loop runs `readOnly: true` — so the propose
                // intents, which live only in `produceAnswer`, were unreachable
                // from the streaming route. The UI shipped a queued-proposal
                // block that nothing could produce, and `/assistant/ask` held
                // the only path that could, with no caller.
                return produceAnswer(ctx, question, contextBlock, {
                    signal: opts.signal,
                    onToolCall: (name) => opts.emit({ type: 'tool_call', name }),
                    onToolResult: (name, ok, truncated) =>
                        opts.emit({ type: 'tool_result', name, ok, truncated }),
                    onHalt: (outcome, notice) => opts.emit({ type: 'halt', outcome, notice }),
                });
            },
            // The STREAMING surface gets the page context too. Threading it on
            // the ask path only would have been the subtler half-delivery: the
            // UI built in this prompt streams, so the context would have been
            // live in tests and absent in the product.
            input.pageContext,
        );

        opts.emit({
            type: 'answer',
            text: answer.message,
            // The proposal travels as structured data so the UI can render
            // "queued" with a link, or "not queued" with none, without
            // reading the sentence (#3847).
            ...(answer.kind === 'proposal' && answer.proposalId !== undefined
                ? {
                      proposal: {
                          id: answer.proposalId,
                          kind: answer.proposalKind ?? 'unknown',
                          status: answer.proposalStatus ?? 'unknown',
                      },
                  }
                : {}),
        });
        opts.emit({ type: 'done', truncatedAny: false });
    } catch (err) {
        // A GUARD refusal reaches here as a thrown `forbidden(...)`, and it must
        // arrive as a visible refusal with a reason (#3826). An empty stream
        // that simply ends is indistinguishable from a crash, so the user
        // retries — which spends again and teaches them the feature is
        // unreliable.
        //
        // The guard's own message is NOT forwarded: it carries rule ids, and
        // `ai/guard` keeps those out of user-facing text. The reason the user
        // gets says what happened and what it means for their data.
        const refusal = isGuardRefusal(err)
            ? 'That request was withheld by the content guard, which refuses material that reads as an instruction rather than as a record. Nothing was created and your data was not read.'
            : 'The assistant could not answer this. Nothing was created.';
        opts.emit({ type: 'refusal', reason: refusal });
        opts.emit({ type: 'done', truncatedAny: false });
    }
}

/**
 * Is this the guard saying no, as opposed to anything else failing?
 *
 * Matched on the message prefix `ai/guard` writes, which is the only signal it
 * gives: both `assertGuardAllowed` and `assertNoReviewRequired` throw the same
 * `forbidden(...)` shape, so the HTTP status cannot tell them apart from a
 * permission refusal.
 *
 * Deliberately narrow, and the consequence of a miss is the safe direction: an
 * unrecognised throw becomes the generic refusal, which still says nothing was
 * created. A rename upstream therefore degrades the WORDING, not the honesty —
 * and `tests/unit/ai/assistant-stream-transport.test.ts` pins the prefix so the
 * rename is visible rather than silent.
 */
export const GUARD_REFUSAL_PREFIXES = ['ai_guard_blocked:', 'ai_guard_review_required:'] as const;

function isGuardRefusal(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return GUARD_REFUSAL_PREFIXES.some((p) => message.includes(p));
}

/**
 * The system prompt, per turn.
 *
 * A function rather than a constant because two parts of it are
 * request-scoped: the page context (#3841) and nothing else about the turn.
 * The route table is static but is assembled here so the prompt has exactly
 * one definition rather than a constant plus an append at the call site.
 *
 * ═══ WHY THE NAVIGATION RULE CHANGED ═══
 *
 * Prompt 1 shipped a blanket ban: "Do not describe menu paths or navigation."
 * That was the right conservative default when the model had no way to know
 * the real IA, because the failure it avoided — confidently naming a screen
 * that does not exist — costs more in a compliance product than the silence
 * costs. #3845 removes the REASON for the ban instead of the ban's effect:
 * the actual route table goes in, so naming a path is no longer recall. The
 * ban survives in narrowed form (only these routes) and is enforced on the
 * way out by `checkGuidanceRoutes`, because a prompt is an instruction and
 * not a guarantee.
 */
function assistantSystemPrompt(contextBlock: string | null): string {
    return [
        'You are a compliance assistant inside the Inflect platform, answering about THIS tenant only.',
        '',
        'Use the provided tools to read live data. Rules you must follow:',
        '- If a tool returns an ERROR, say the data is unavailable. NEVER infer, estimate or recall a',
        '  control status, a count, or a posture from anything but a successful tool result.',
        '- If a tool result says TRUNCATED, say your answer is based on a partial result, and do not',
        '  state totals or conclusions about the full set.',
        '- If a tool result says an item was QUARANTINED, say exactly that it did NOT enter the review',
        '  queue and nothing was created. Never describe a quarantined item as queued or pending.',
        '- Be concise. Give the number or the fact first.',
        '',
        'NAVIGATION. You may refer to a page ONLY if its path appears in the list below. If the page',
        'someone would need is not in the list, say you cannot point them to it rather than guessing a',
        'path. Never invent a sub-page, a settings screen, or a tab. Do not describe click-by-click',
        'menu paths — name the page and let the product render the link.',
        '',
        routeTableForPrompt(),
        ...(contextBlock === null ? [] : ['', contextBlock]),
    ].join('\n');
}
