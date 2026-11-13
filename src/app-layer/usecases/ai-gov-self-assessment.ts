/**
 * AI-governance self-assessment usecases — mirrors the NIS2 self-assessment.
 *
 * One 30-question assessment (global reference content) + a tenant-scoped run.
 * Answers project onto AISVS / ISO 42001 / EU AI Act via each question's
 * mappings (see ai-gov-coverage). Conditional questions (RAG / AGENTIC) auto-
 * resolve to N/A unless the tenant runs that architecture.
 *
 * This is a self-assessment aid, NOT legal advice.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { createFinding } from './finding';
import {
    computeAiGovCoverage,
    type AiGovAnswerValue,
    type AiGovCriticality,
    type AiGovMappings,
    type AiGovScoredQuestion,
} from '@/app-layer/services/ai-gov-coverage';

const ANSWER_VALUES: readonly AiGovAnswerValue[] = ['NA', 'NO', 'PARTIALLY', 'YES'];
const FINDING_MARKER = 'AI_GOV_SELF_ASSESSMENT';

/** Architecture the tenant runs — gates the conditional questions. */
export type AiGovArchitecture = 'NONE' | 'RAG' | 'AGENTIC' | 'BOTH';

function conditionalApplies(conditional: string | null, arch: AiGovArchitecture): boolean {
    if (!conditional) return true;
    if (arch === 'BOTH') return true;
    return conditional === arch;
}

/** Load-or-create the tenant's active (non-completed/archived) assessment. */
async function activeAssessment(ctx: RequestContext) {
    return runInTenantContext(ctx, async (db) => {
        let a = await db.aiGovSelfAssessment.findFirst({
            where: { tenantId: ctx.tenantId, status: { in: ['DRAFT', 'IN_PROGRESS'] } },
            orderBy: { updatedAt: 'desc' },
        });
        if (!a) {
            a = await db.aiGovSelfAssessment.create({
                data: { tenantId: ctx.tenantId, status: 'DRAFT', createdById: ctx.userId },
            });
        }
        return a;
    });
}

/** Domains + questions + the tenant's answers + the 3-way coverage readout. */
export async function getAiGovAssessmentState(
    ctx: RequestContext,
    opts: { architecture?: AiGovArchitecture } = {},
) {
    if (!ctx.permissions.canRead) throw badRequest('Read access required.');
    const arch = opts.architecture ?? 'NONE';
    const assessment = await activeAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [domains, questions, answers] = await Promise.all([
            db.aiGovDomain.findMany({ orderBy: { id: 'asc' } }),
            db.aiGovQuestion.findMany({ orderBy: { id: 'asc' } }),
            db.aiGovSelfAssessmentAnswer.findMany({
                where: { tenantId: ctx.tenantId, assessmentId: assessment.id },
            }),
        ]);
        const answerByQ = new Map(answers.map((a) => [a.questionId, a]));

        const scored: AiGovScoredQuestion[] = questions.map((q) => {
            const applies = conditionalApplies(q.conditional, arch);
            const stored = answerByQ.get(q.id);
            // A conditional question that doesn't apply is treated as N/A.
            const answer: AiGovAnswerValue | null = !applies
                ? 'NA'
                : ((stored?.answer as AiGovAnswerValue) ?? null);
            return {
                id: q.id,
                domainId: q.domainId,
                criticality: q.criticality as AiGovCriticality,
                mappings: q.mappingsJson as unknown as AiGovMappings,
                answer,
            };
        });

        return {
            assessmentId: assessment.id,
            status: assessment.status,
            questionSetVersion: assessment.questionSetVersion,
            architecture: arch,
            domains,
            questions: questions.map((q) => ({
                id: q.id,
                domainId: q.domainId,
                text: q.text,
                criticality: q.criticality,
                conditional: q.conditional,
                mappings: q.mappingsJson,
                applicable: conditionalApplies(q.conditional, arch),
                answer: answerByQ.get(q.id)?.answer ?? null,
                // The stored note, so the wizard can seed it (#5128). Without
                // it the wizard held null and sent null on the next answer
                // change, overwriting the note.
                note: answerByQ.get(q.id)?.note ?? null,
            })),
            coverage: computeAiGovCoverage(scored),
        };
    });
}

/** Upsert one answer (note sanitised + encrypted at rest) + audit. */
export async function saveAiGovAnswer(
    ctx: RequestContext,
    input: { questionId: string; answer: AiGovAnswerValue; note?: string | null },
) {
    if (!ctx.permissions.canWrite) throw badRequest('Write access required.');
    if (!ANSWER_VALUES.includes(input.answer)) {
        throw badRequest(`Invalid answer '${input.answer}'.`);
    }
    const assessment = await activeAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        const question = await db.aiGovQuestion.findUnique({ where: { id: input.questionId } });
        if (!question) throw notFound('Question not found');

        // `note` absent leaves the stored note as it is; `null` clears it
        // (#5128). An answer-only change must not erase a justification.
        const note = input.note != null ? sanitizePlainText(input.note) : null;
        const saved = await db.aiGovSelfAssessmentAnswer.upsert({
            where: { assessmentId_questionId: { assessmentId: assessment.id, questionId: input.questionId } },
            update: {
                answer: input.answer,
                ...(input.note === undefined ? {} : { note }),
                answeredById: ctx.userId,
                answeredAt: new Date(),
            },
            create: {
                tenantId: ctx.tenantId,
                assessmentId: assessment.id,
                questionId: input.questionId,
                answer: input.answer,
                note,
                answeredById: ctx.userId,
            },
        });
        if (assessment.status === 'DRAFT') {
            await db.aiGovSelfAssessment.update({ where: { id: assessment.id }, data: { status: 'IN_PROGRESS' } });
        }
        await logEvent(db, ctx, {
            action: 'AIGOV_ASSESSMENT_ANSWERED',
            entityType: 'AiGovSelfAssessmentAnswer',
            entityId: saved.id,
            details: `Answered ${input.questionId}: ${input.answer}`,
            detailsJson: { category: 'custom', event: 'aigov_assessment_answered', questionId: input.questionId, answer: input.answer },
        });
        return saved;
    });
}

/** Mark the active assessment COMPLETED + audit. */
export async function completeAiGovAssessment(ctx: RequestContext) {
    if (!ctx.permissions.canWrite) throw badRequest('Write access required.');
    const assessment = await activeAssessment(ctx);
    return runInTenantContext(ctx, async (db) => {
        const done = await db.aiGovSelfAssessment.update({
            where: { id: assessment.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
        });
        await logEvent(db, ctx, {
            action: 'AIGOV_ASSESSMENT_COMPLETED',
            entityType: 'AiGovSelfAssessment',
            entityId: done.id,
            details: 'AI-governance self-assessment completed',
            detailsJson: { category: 'custom', event: 'aigov_assessment_completed' },
        });
        return done;
    });
}

/**
 * EXPLICIT, opt-in: materialise Findings for HIGH/CRITICAL questions answered
 * NO/PARTIALLY, via the existing createFinding usecase. Idempotent — a finding
 * is keyed by a deterministic marker `[AI_GOV_SELF_ASSESSMENT:<questionId>]` in
 * the title, so re-running doesn't duplicate; a question that is no longer a gap
 * does not (re)create one.
 */
export async function raiseFindingsFromAiGovGaps(
    ctx: RequestContext,
    opts: { architecture?: AiGovArchitecture } = {},
): Promise<{ created: string[] }> {
    if (!ctx.permissions.canWrite) throw badRequest('Write access required.');
    const arch = opts.architecture ?? 'NONE';
    const assessment = await activeAssessment(ctx);

    const gaps = await runInTenantContext(ctx, async (db) => {
        const [questions, answers, existingFindings] = await Promise.all([
            db.aiGovQuestion.findMany(),
            db.aiGovSelfAssessmentAnswer.findMany({ where: { tenantId: ctx.tenantId, assessmentId: assessment.id } }),
            db.finding.findMany({ where: { tenantId: ctx.tenantId, title: { contains: FINDING_MARKER } }, select: { title: true } }),
        ]);
        const qById = new Map(questions.map((q) => [q.id, q]));
        const existingMarkers = new Set(existingFindings.map((f) => f.title));
        const out: Array<{ questionId: string; criticality: string; text: string }> = [];
        for (const a of answers) {
            const q = qById.get(a.questionId);
            if (!q) continue;
            if (!conditionalApplies(q.conditional, arch)) continue;
            const isGap = a.answer === 'NO' || a.answer === 'PARTIALLY';
            const isHighPlus = q.criticality === 'HIGH' || q.criticality === 'CRITICAL';
            if (!isGap || !isHighPlus) continue;
            const marker = `[${FINDING_MARKER}:${q.id}]`;
            if ([...existingMarkers].some((t) => t.includes(marker))) continue; // idempotent
            out.push({ questionId: q.id, criticality: q.criticality, text: q.text });
        }
        return out;
    });

    const created: string[] = [];
    for (const g of gaps) {
        const finding = await createFinding(ctx, {
            severity: g.criticality === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
            // A FindingType (#5181): 'AI governance' is not one, and the
            // enum column refused it, so raising these findings failed. A
            // self-reported gap is an observation until someone audits it.
            type: 'OBSERVATION',
            title: `AI-governance gap (${g.questionId}) [${FINDING_MARKER}:${g.questionId}]`,
            description: `Self-assessed gap: "${g.text}" — answered below YES. Source: unified AI-governance self-assessment (self-reported, not legal advice).`,
        });
        created.push(finding.id);
    }
    return { created };
}
