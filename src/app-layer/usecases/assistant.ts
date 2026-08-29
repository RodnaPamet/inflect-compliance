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

    // ── Action intents → propose (PENDING), never execute ──
    if (/\b(create|open|raise|add|log|file)\b.*\bfinding\b/.test(q)) {
        const title = extractTitle(question, /\bfinding\b(\s+(to|for|about|:))?/i);
        const proposal = await createAgentProposal(ctx, {
            kind: 'FINDING',
            payload: { title, severity: 'MEDIUM', type: 'OBSERVATION' },
            rationale: `Proposed by the compliance assistant from: "${sanitizePlainText(question).slice(0, 400)}"`,
        });
        answer = {
            kind: 'proposal',
            proposalId: proposal.id,
            proposalKind: proposal.kind,
            message: `I've queued a finding "${title}" as a proposal for review — nothing is created until a reviewer approves it in the proposal queue.`,
        };
    } else if (/\b(create|open|add|log|raise)\b.*\brisk\b/.test(q)) {
        const title = extractTitle(question, /\brisk\b(\s+(to|for|about|:))?/i);
        const proposal = await createAgentProposal(ctx, {
            kind: 'RISK',
            payload: { title },
            rationale: `Proposed by the compliance assistant from: "${sanitizePlainText(question).slice(0, 400)}"`,
        });
        answer = {
            kind: 'proposal',
            proposalId: proposal.id,
            proposalKind: proposal.kind,
            message: `I've queued a risk "${title}" as a proposal for review — nothing is created until a reviewer approves it.`,
        };
    } else {
        // ── Read intents → answer from live posture data (RLS-scoped) ──
        const { stats } = await getDashboardData(ctx);
        if (/\bhigh[-\s]?risk|top risk|critical risk/.test(q)) {
            answer = { kind: 'answer', message: `You have ${stats.highRisks} high-severity risk(s) (inherent score ≥ 15) out of ${stats.risks} total.` };
        } else if (/\brisk/.test(q)) {
            answer = { kind: 'answer', message: `You have ${stats.risks} risk(s) on the register, ${stats.highRisks} of them high-severity.` };
        } else if (/\bfinding/.test(q)) {
            answer = { kind: 'answer', message: `You have ${stats.openFindings} open finding(s).` };
        } else if (/\btask|remediat|action item/.test(q)) {
            answer = { kind: 'answer', message: `You have ${stats.openTasks} open task(s) in progress.` };
        } else if (/\bevidence/.test(q)) {
            answer = { kind: 'answer', message: `You have ${stats.evidence} evidence item(s); ${stats.pendingEvidence} awaiting review and ${stats.overdueEvidence} overdue for re-review.` };
        } else if (/\bcontrol|coverage|soc\s?2|iso|posture|status|summary|overview/.test(q)) {
            answer = { kind: 'answer', message: `Posture: ${stats.controls} control(s), ${stats.risks} risk(s) (${stats.highRisks} high), ${stats.openFindings} open finding(s), ${stats.openTasks} open task(s), ${stats.evidence} evidence item(s).` };
        } else {
            answer = {
                kind: 'answer',
                message: 'I can answer read questions about your posture (high risks, open findings, tasks, evidence status, control coverage) and queue actions (raise a finding, create a risk) for a reviewer to approve. What would you like to know?',
            };
        }
    }

    // Guard the outbound message before it leaves the boundary.
    assertGuardAllowed(await guardEgress(ctx, { message: answer.message }, { source: 'assistant:outbound' }));
    await recordGeneration(ctx.tenantId, ctx.userId);
    recordAiGeneration({ feature: 'assistant' }); // H6 — AI cost visibility
    return answer;
}
