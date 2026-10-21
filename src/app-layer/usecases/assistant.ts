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
import { createAgentProposal } from './agent-proposals';
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';
import { runInTenantContext } from '@/lib/db-context';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { RESIDENCY_SELECT, residencyTermsFrom, resolveFlueModel } from '@/lib/agentic/flue/model-selection';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { assistantTools } from '@/app-layer/ai/assistant/tools';
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

/** Pull the free-text subject out of an action request ("raise a finding about X" → "X"). */
function extractTitle(question: string, verb: RegExp): string {
    const m = question.match(verb);
    const rest = m ? question.slice((m.index ?? 0) + m[0].length) : question;
    const title = sanitizePlainText(rest.replace(/^[\s:,.-]+/, '').trim() || question.trim());
    return title.slice(0, 200) || 'Untitled';
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
    const policyCardVersion = await resolvePolicyCardPin(ctx.tenantId, ctx.agentId);

    // ── Action intents → propose (PENDING), never execute ──
    if (/\b(create|open|raise|add|log|file)\b.*\bfinding\b/.test(q)) {
        const title = extractTitle(question, /\bfinding\b(\s+(to|for|about|:))?/i);
        const proposal = await createAgentProposal(ctx, {
            kind: 'FINDING',
            payload: { title, severity: 'MEDIUM', type: 'OBSERVATION' },
            rationale: `Proposed by the compliance assistant from: "${sanitizePlainText(question).slice(0, 400)}"`,
            policyCardVersion,
        });
        answer = {
            kind: 'proposal',
            proposalId: proposal.id,
            proposalKind: proposal.kind,
            proposalStatus: proposal.status,
            message: proposalMessage(proposal.status, 'finding', title),
        };
    } else if (/\b(create|open|add|log|raise)\b.*\brisk\b/.test(q)) {
        const title = extractTitle(question, /\brisk\b(\s+(to|for|about|:))?/i);
        const proposal = await createAgentProposal(ctx, {
            kind: 'RISK',
            payload: { title },
            rationale: `Proposed by the compliance assistant from: "${sanitizePlainText(question).slice(0, 400)}"`,
            policyCardVersion,
        });
        answer = {
            kind: 'proposal',
            proposalId: proposal.id,
            proposalKind: proposal.kind,
            proposalStatus: proposal.status,
            message: proposalMessage(proposal.status, 'risk', title),
        };
    } else {
        // ── Read intents → the TOOL-USE LOOP, falling back to keywords ──
        const loop = await answerFromToolLoop(ctx, question, observe, contextBlock);
        if (loop !== null) {
            answer = loop.answer;
            by = loop.by;
        } else {
            answer = await answerFromKeywords(ctx, q);
        }
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
    const set = assistantTools(inv, { readOnly: true });

    const result = await runAssistantLoop({
        provider,
        specifier: choice.specifier,
        system: assistantSystemPrompt(contextBlock),
        question,
        tools: set.tools,
        guardTripped: set.reviewRequired,
        signal: observe.signal,
    });

    // Observation AFTER the loop rather than during it, which is a real
    // limitation and not a preference: `runAssistantLoop` returns its call
    // list when the turn ends, so these events describe work already done.
    // A caller watching sees them in order, but not while each call is still
    // in flight. Making them live means the loop taking a per-dispatch hook,
    // which is #3886.
    for (const call of result.calls) {
        observe.onToolCall?.(call.name);
        observe.onToolResult?.(call.name, call.ok, call.truncated);
    }
    if (result.outcome !== 'answered') {
        const notice = haltNotice(result.outcome, DEFAULT_LOOP_BOUNDS);
        if (notice !== null) observe.onHalt?.(result.outcome, notice);
    }

    // An empty answer is not an answer. Falling back rather than returning
    // nothing, so a model that said nothing useful does not become a blank
    // reply the user reads as a hang.
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
