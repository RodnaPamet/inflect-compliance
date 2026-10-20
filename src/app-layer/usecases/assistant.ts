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
import { guardUntrustedInput, guardEgress, assertGuardAllowed, assertNoReviewRequired } from '@/app-layer/ai/guard';
import { getDashboardData } from './dashboard';
import { createAgentProposal } from './agent-proposals';
import { resolvePolicyCardPin } from '@/lib/agentic/policy-card-pin';
import prisma from '@/lib/prisma';
import { RESIDENCY_SELECT, residencyTermsFrom, resolveFlueModel } from '@/lib/agentic/flue/model-selection';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { assistantTools } from '@/app-layer/ai/assistant/tools';
import { assistantProviderFor } from '@/app-layer/ai/assistant/turn-provider';
import { runAssistantLoop } from '@/app-layer/ai/assistant/tool-loop';
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

export const AskAssistantSchema = z.object({ question: z.string().min(1).max(2000) });

export interface AssistantAnswer {
    kind: 'answer' | 'proposal';
    message: string;
    /** Present when kind='proposal' — the PENDING agent-proposal awaiting human approval. */
    proposalId?: string;
    proposalKind?: string;
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
    await enforceFeatureGate(ctx, 'assistant');
    await checkRateLimit(ctx.tenantId, ctx.userId);
    const question = input.question;

    // The question is untrusted external input — guard before it steers
    // anything. H2 — auto-draft surface: abort on ANY review-required verdict
    // (flag OR block) so an injected prompt never reaches the model/router even
    // under the default balanced guard mode.
    assertNoReviewRequired(await guardUntrustedInput(ctx, question, { source: 'assistant' }));

    const q = question.toLowerCase();
    let answer: AssistantAnswer;

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
            message: proposalMessage(proposal.status, 'risk', title),
        };
    } else {
        // ── Read intents → the TOOL-USE LOOP, falling back to keywords ──
        answer = (await answerFromToolLoop(ctx, question)) ?? (await answerFromKeywords(ctx, q));
    }

    // Guard the outbound message before it leaves the boundary.
    assertGuardAllowed(await guardEgress(ctx, { message: answer.message }, { source: 'assistant:outbound' }));
    await recordGeneration(ctx.tenantId, ctx.userId);
    recordAiGeneration({ feature: 'assistant' }); // H6 — AI cost visibility
    return answer;
}

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
async function answerFromToolLoop(ctx: RequestContext, question: string): Promise<AssistantAnswer | null> {
    const secSettings = await prisma.tenantSecuritySettings.findUnique({
        where: { tenantId: ctx.tenantId },
        select: RESIDENCY_SELECT,
    });
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
        system: ASSISTANT_SYSTEM_PROMPT,
        question,
        tools: set.tools,
        guardTripped: set.reviewRequired,
    });

    // An empty answer is not an answer. Falling back rather than returning
    // nothing, so a model that said nothing useful does not become a blank
    // reply the user reads as a hang.
    if (result.text.trim() === '') return null;
    return { kind: 'answer', message: result.text };
}

/**
 * What the model is told it is, and what it may not do.
 *
 * The prohibitions are the load-bearing half. Each one names a failure the
 * surrounding code cannot prevent on its own: the funnels stop an unpermitted
 * READ, but nothing except this text stops the model inventing a control status
 * when a read FAILED, or describing a quarantined proposal as queued.
 */
const ASSISTANT_SYSTEM_PROMPT = [
    'You are a compliance assistant inside the Inflect platform, answering about THIS tenant only.',
    '',
    'Use the provided tools to read live data. Rules you must follow:',
    '- If a tool returns an ERROR, say the data is unavailable. NEVER infer, estimate or recall a',
    '  control status, a count, or a posture from anything but a successful tool result.',
    '- If a tool result says TRUNCATED, say your answer is based on a partial result, and do not',
    '  state totals or conclusions about the full set.',
    '- If a tool result says an item was QUARANTINED, say exactly that it did NOT enter the review',
    '  queue and nothing was created. Never describe a quarantined item as queued or pending.',
    '- Do not describe menu paths or navigation. Answer from data, and let the product link.',
    '- Be concise. Give the number or the fact first.',
].join('\n');
