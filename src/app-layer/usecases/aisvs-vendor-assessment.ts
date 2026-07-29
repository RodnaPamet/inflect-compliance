/**
 * AISVS AI-vendor assessment — coverage readout + opt-in risk linkage.
 *
 * Thin layer over the EXISTING vendor-assessment system (no new assessment
 * plumbing): it reads a submitted assessment created from the AISVS vendor
 * questionnaire, translates the answers into an AISVS coverage readout
 * (vendor-coverage service), and — on EXPLICIT request — raises a Finding via
 * the existing `createFinding` usecase when L1 coverage is below a threshold,
 * so weak AI-vendor due-diligence flows into IC's risk register instead of a
 * dead PDF.
 *
 * Self-reported: answers are vendor self-attestations, not verified by IC.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound, forbidden } from '@/lib/errors/types';
import {
    computeAisvsCoverage,
    type AisvsAnsweredQuestion,
    type AisvsCoverageReadout,
} from '@/app-layer/services/aisvs-vendor-coverage';
import { createFinding } from './finding';

/** Pull a yes/partial/no/na token out of the stored answerJson (defensive). */
function answerToken(answerJson: unknown): string | null {
    if (answerJson == null) return null;
    if (typeof answerJson === 'string') return answerJson;
    if (typeof answerJson === 'object') {
        const o = answerJson as Record<string, unknown>;
        for (const k of ['value', 'selected', 'option', 'label', 'answer']) {
            if (typeof o[k] === 'string') return o[k] as string;
        }
    }
    return null;
}

/** Load the assessment's questions + answers as AISVS-answered questions. */
async function loadAnswered(
    ctx: RequestContext,
    assessmentId: string,
): Promise<{ vendorId: string; questions: AisvsAnsweredQuestion[] }> {
    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: { id: true, vendorId: true, templateVersionId: true },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (!assessment.templateVersionId) {
            throw badRequest('Assessment is not a template-versioned (G-3) assessment.');
        }
        const [questions, answers] = await Promise.all([
            db.vendorAssessmentTemplateQuestion.findMany({
                where: { tenantId: ctx.tenantId, templateId: assessment.templateVersionId },
                select: { id: true, prompt: true },
            }),
            db.vendorAssessmentAnswer.findMany({
                where: { tenantId: ctx.tenantId, assessmentId },
                select: { templateQuestionId: true, answerJson: true },
            }),
        ]);
        const byQ = new Map<string, unknown>();
        for (const a of answers) {
            if (a.templateQuestionId) byQ.set(a.templateQuestionId, a.answerJson);
        }
        return {
            vendorId: assessment.vendorId,
            questions: questions.map((q) => ({
                prompt: q.prompt,
                answer: answerToken(byQ.get(q.id)),
            })),
        };
    });
}

/** AISVS coverage readout for a submitted AI-vendor assessment. */
export async function getAisvsVendorCoverage(
    ctx: RequestContext,
    assessmentId: string,
): Promise<AisvsCoverageReadout> {
    // 403, not 400 — an authorization denial is not a malformed request.
    if (!ctx.permissions.canRead) throw forbidden('Read access required.');
    const { questions } = await loadAnswered(ctx, assessmentId);
    return computeAisvsCoverage(questions);
}

export interface RaiseFindingOptions {
    /** Raise a finding when L1 coverage percent is below this (default 70). */
    l1Threshold?: number;
}

/**
 * EXPLICIT, opt-in: convert weak AISVS vendor coverage into a Finding via the
 * existing `createFinding` usecase (NOT raw prisma). Returns the finding id, or
 * null when coverage is at/above threshold (nothing raised).
 */
export async function raiseFindingFromAisvsCoverage(
    ctx: RequestContext,
    assessmentId: string,
    opts: RaiseFindingOptions = {},
): Promise<{ findingId: string; l1Percent: number } | null> {
    if (!ctx.permissions.canWrite) throw forbidden('Write access required.');
    const threshold = opts.l1Threshold ?? 70;

    const { vendorId, questions } = await loadAnswered(ctx, assessmentId);
    const coverage = computeAisvsCoverage(questions);
    if (coverage.l1.percent == null || coverage.l1.percent >= threshold) {
        return null; // adequate L1 coverage — nothing to raise
    }

    const vendor = await runInTenantContext(ctx, (db) =>
        db.vendor.findFirst({ where: { id: vendorId, tenantId: ctx.tenantId }, select: { name: true } }),
    );
    const vendorName = vendor?.name ?? 'AI vendor';
    const weakChapters = coverage.byChapter
        .filter((c) => c.percent != null && c.percent < threshold)
        .map((c) => c.chapter)
        .join(', ');

    const finding = await createFinding(ctx, {
        severity: coverage.l1.percent < 40 ? 'HIGH' : 'MEDIUM',
        type: 'AI vendor security',
        title: `AISVS AI-vendor gap: ${vendorName} (${coverage.l1.percent}% L1)`,
        description:
            `${vendorName} attests to only ${coverage.l1.percent}% of assessed AISVS L1 ` +
            `requirements (L2: ${coverage.l2.percent ?? 'n/a'}%)` +
            (weakChapters ? `; weakest chapters: ${weakChapters}` : '') +
            `. Source: OWASP AISVS AI-vendor questionnaire (self-reported). Review before procurement.`,
    });

    return { findingId: finding.id, l1Percent: coverage.l1.percent };
}
