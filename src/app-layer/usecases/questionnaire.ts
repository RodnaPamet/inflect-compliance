/**
 * Inbound security questionnaire autofill (PR-9).
 *
 * Governed-AI ordering mirrors risk-suggestions:
 *   enforceFeatureGate → checkRateLimit → runInTenantContext →
 *   gather grounding → per item: library match OR cited AI draft →
 *   flag low-confidence → logEvent per answer → recordGeneration.
 *
 * The draft is grounded ONLY in the tenant's approved Control / Policy /
 * Evidence content; low-confidence items are FLAGGED for a human, never
 * auto-answered. Accepted answers feed the answer library.
 *
 * NOTE (residency / injection): the questionnaire text is untrusted external
 * input. It is sanitised before persistence and truncated before it reaches
 * the provider; the provider prompt instructs answer-only-from-grounding. A
 * dedicated per-tenant residency / prompt-injection guard is NOT yet built for
 * this surface — it is new scope here (see impl note).
 */
import { z } from 'zod';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { forbidden, notFound } from '@/lib/errors/types';
import { enforceFeatureGate } from '@/app-layer/ai/risk-assessment/feature-gate';
import { checkRateLimit, recordGeneration } from '@/app-layer/ai/risk-assessment/rate-limiter';
import { recordAiGeneration } from '@/lib/observability/integration-metrics';
import { guardUntrustedInput, guardEgress, assertGuardAllowed, assertNoReviewRequired } from '@/app-layer/ai/guard';
import { getQuestionnaireProvider, type GroundingSnippet } from '@/app-layer/ai/questionnaire';
import { relevance } from '@/app-layer/ai/questionnaire/types';

const CONFIDENCE_FLOOR = 0.4;
const LIBRARY_MATCH_FLOOR = 0.6;
const MAX_QUESTIONS = 500;
const MAX_GROUNDING = 400;

export const UploadQuestionnaireSchema = z.object({
    name: z.string().min(1).max(200),
    source: z.string().max(120).optional(),
    questions: z.array(z.string().min(1).max(2000)).min(1).max(MAX_QUESTIONS),
});

function assertManage(ctx: RequestContext) {
    if (!ctx.permissions?.canWrite) throw forbidden('You do not have permission to manage questionnaires.');
}

export async function uploadQuestionnaire(ctx: RequestContext, input: z.infer<typeof UploadQuestionnaireSchema>) {
    assertManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const q = await db.inboundQuestionnaire.create({ data: { tenantId: ctx.tenantId, name: sanitizePlainText(input.name), source: input.source ?? null, itemCount: input.questions.length, createdByUserId: ctx.userId, status: 'UPLOADED' } });
        await db.inboundQuestionnaireItem.createMany({
            data: input.questions.map((question, i) => ({ tenantId: ctx.tenantId, questionnaireId: q.id, order: i, questionText: sanitizePlainText(question).slice(0, 2000), status: 'PENDING' as const })),
        });
        return { questionnaireId: q.id, itemCount: input.questions.length };
    });
}

export async function listQuestionnaires(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.inboundQuestionnaire.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true, source: true, status: true, itemCount: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
}

export async function getQuestionnaireItems(ctx: RequestContext, questionnaireId: string) {
    return runInTenantContext(ctx, (db) =>
        db.inboundQuestionnaireItem.findMany({ where: { tenantId: ctx.tenantId, questionnaireId }, select: { id: true, order: true, questionText: true, draftAnswer: true, confidence: true, sourceCitation: true, status: true, acceptedAnswer: true }, orderBy: { order: 'asc' }, take: MAX_QUESTIONS }),
    );
}

/**
 * H4 — minimize PII before grounding leaves the tenant boundary to the LLM.
 * `guardEgress` only scans for secret shapes, not personal data. Redact email
 * addresses and long digit runs (phone / SSN / account numbers) from any
 * snippet text bound for the provider.
 */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const LONG_DIGITS_RE = /\b\d[\d\s-]{6,}\d\b/g;
function minimizePii(text: string): string {
    return text.replace(EMAIL_RE, '[email]').replace(LONG_DIGITS_RE, '[redacted]');
}

/** Gather approved compliance content as grounding snippets. Bounded + minimized. */
async function gatherGrounding(db: Parameters<Parameters<typeof runInTenantContext>[1]>[0], tenantId: string): Promise<GroundingSnippet[]> {
    const [controls, policies, evidence] = await Promise.all([
        db.control.findMany({ where: { tenantId, deletedAt: null, applicability: 'APPLICABLE' }, select: { id: true, name: true, objective: true, successCriteria: true }, take: 200 }),
        db.policy.findMany({ where: { tenantId }, select: { id: true, title: true, description: true }, take: 100 }),
        // H4 — evidence `content` is often a raw artefact dump (screenshots
        // transcribed, log excerpts, exports) laden with PII; ship only the
        // TITLE, never the body, to the third-party model.
        db.evidence.findMany({ where: { tenantId, status: 'APPROVED', deletedAt: null }, select: { id: true, title: true }, take: 100 }),
    ]);
    const out: GroundingSnippet[] = [];
    for (const c of controls) out.push({ kind: 'CONTROL', id: c.id, label: c.name, text: minimizePii([c.objective, c.successCriteria].filter(Boolean).join(' ').slice(0, 1000)) });
    for (const p of policies) out.push({ kind: 'POLICY', id: p.id, label: p.title, text: minimizePii((p.description ?? '').slice(0, 1000)) });
    for (const e of evidence) out.push({ kind: 'EVIDENCE', id: e.id, label: e.title, text: '' });
    return out.slice(0, MAX_GROUNDING);
}

export interface AutofillResult {
    drafted: number;
    flagged: number;
    fromLibrary: number;
}

export async function autofillQuestionnaire(ctx: RequestContext, questionnaireId: string): Promise<AutofillResult> {
    await enforceFeatureGate(ctx, 'questionnaire');
    if (!ctx.permissions?.canWrite) throw forbidden('You do not have permission to autofill questionnaires.');
    await checkRateLimit(ctx.tenantId, ctx.userId);
    const provider = getQuestionnaireProvider();

    const result = await runInTenantContext(ctx, async (db) => {
        const q = await db.inboundQuestionnaire.findFirst({ where: { id: questionnaireId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!q) throw notFound('Questionnaire not found.');
        const items = await db.inboundQuestionnaireItem.findMany({ where: { tenantId: ctx.tenantId, questionnaireId, status: 'PENDING' }, select: { id: true, questionText: true }, take: MAX_QUESTIONS });
        const grounding = await gatherGrounding(db, ctx.tenantId);
        const library = await db.questionnaireAnswerLibrary.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, questionText: true, answerText: true, sourceRefsJson: true }, take: 1000 });

        // AISVS L2 — the questionnaire text is untrusted external input, and the
        // grounding is tenant content bound for the LLM. Guard both before any
        // model call (mirrors risk-suggestions); a malicious-input or
        // secret-leak verdict aborts the whole autofill.
        const inputGuard = await guardUntrustedInput(ctx, items.map((i) => i.questionText).join('\n'), { source: 'questionnaire', db });
        const egressGuard = await guardEgress(ctx, { grounding }, { source: 'questionnaire:outbound', db });
        // H2 — auto-draft surface: abort on ANY review-required input verdict
        // (flag OR block), so an injected question never reaches the LLM even
        // under the default balanced guard mode.
        assertNoReviewRequired(inputGuard);
        assertGuardAllowed(egressGuard);

        let drafted = 0, flagged = 0, fromLibrary = 0;
        for (const item of items) { // guardrail-allow: n+1 — per-question draft, bounded by MAX_QUESTIONS
            // 1. Library retrieval — reuse a previously-accepted answer.
            const libMatch = library.map((l) => ({ l, score: relevance(item.questionText, l.questionText) })).filter((r) => r.score >= LIBRARY_MATCH_FLOOR).sort((a, b) => b.score - a.score)[0];
            let draftAnswer: string, confidence: number, citation: string;
            if (libMatch) {
                draftAnswer = libMatch.l.answerText;
                confidence = Math.min(0.95, 0.6 + libMatch.score * 0.35);
                citation = 'From answer library (previously accepted).';
                fromLibrary += 1;
                await db.questionnaireAnswerLibrary.updateMany({ where: { id: libMatch.l.id, tenantId: ctx.tenantId }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
            } else {
                // 2. Grounded AI draft — never fabricates beyond the grounding.
                // H4 — charge the limiter PER provider call. The loop can make up
                // to MAX_QUESTIONS model calls; the old per-RUN charge let one
                // 500-question upload drive ~500× the daily quota of OpenRouter
                // calls. checkRateLimit throws when the quota is exhausted.
                await checkRateLimit(ctx.tenantId, ctx.userId);
                const out = await provider.draftAnswer({ question: item.questionText, grounding });
                await recordGeneration(ctx.tenantId, ctx.userId);
                recordAiGeneration({ feature: 'questionnaire' }); // H6 — AI cost visibility
                draftAnswer = sanitizePlainText(out.answer);
                confidence = out.confidence;
                citation = out.citations.length ? out.citations.map((c) => `${c.kind}: ${c.label}`).join('; ') : 'No supporting control/policy found.';
            }

            const status = confidence >= CONFIDENCE_FLOOR ? 'DRAFTED' : 'FLAGGED';
            if (status === 'DRAFTED') drafted += 1; else flagged += 1;
            await db.inboundQuestionnaireItem.updateMany({ where: { id: item.id, tenantId: ctx.tenantId }, data: { draftAnswer, confidence, sourceCitation: citation.slice(0, 500), status } });
            await logEvent(db, ctx, { action: 'CREATE', entityType: 'InboundQuestionnaireItem', entityId: item.id, details: `AI drafted questionnaire answer (${status})`, detailsJson: { category: 'ai', entityName: 'InboundQuestionnaireItem', operation: 'ai_draft', summary: `AI drafted answer (${status}, confidence ${confidence.toFixed(2)})`, after: { status, confidence, fromLibrary: !!libMatch } } });
        }
        await db.inboundQuestionnaire.updateMany({ where: { id: questionnaireId, tenantId: ctx.tenantId }, data: { status: 'REVIEW' } });
        return { drafted, flagged, fromLibrary };
    });

    // H4 — generation is now charged PER question inside the loop (above), not
    // once per run.
    return result;
}

export const AcceptItemSchema = z.object({ answer: z.string().max(5000).optional() });

/** Accept an item's answer (edited or as-drafted); feed it to the answer library. */
export async function acceptQuestionnaireItem(ctx: RequestContext, itemId: string, input: z.infer<typeof AcceptItemSchema>) {
    if (!ctx.permissions?.canWrite) throw forbidden('You do not have permission to accept answers.');
    return runInTenantContext(ctx, async (db) => {
        const item = await db.inboundQuestionnaireItem.findFirst({ where: { id: itemId, tenantId: ctx.tenantId }, select: { id: true, questionText: true, draftAnswer: true, sourceCitation: true } });
        if (!item) throw notFound('Item not found.');
        const finalAnswer = sanitizePlainText(input.answer ?? item.draftAnswer ?? '');
        if (!finalAnswer) throw forbidden('No answer to accept.');
        await db.inboundQuestionnaireItem.updateMany({ where: { id: itemId, tenantId: ctx.tenantId }, data: { acceptedAnswer: finalAnswer, status: 'ACCEPTED' } });
        // Feed the answer library (feedback loop).
        await db.questionnaireAnswerLibrary.create({ data: { tenantId: ctx.tenantId, questionText: item.questionText, answerText: finalAnswer, sourceRefsJson: [], confidence: 0.9 } });
        return { itemId, accepted: true };
    });
}
