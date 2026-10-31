/**
 * NIS2 gap-assessment repository.
 *
 * Two axes:
 *   - **Reference reads** (`Nis2GapDomain` / `Nis2GapQuestion`) — GLOBAL
 *     library content (no tenantId, no RLS). The imported open-data
 *     question set (CC BY 4.0 — see
 *     prisma/fixtures/nis2-gap-assessment.LICENSE.md). Bounded `take` even
 *     though the set is fixed at 15 domains / 116 questions.
 *   - **Tenant reads/writes** (`Nis2SelfAssessment` /
 *     `Nis2SelfAssessmentAnswer`) — every query filters by
 *     `ctx.tenantId` (defence in depth on top of RLS). `answer.note` is
 *     encrypted at rest transparently by the Epic B middleware.
 *
 * This is the DATA LAYER only — no usecases, policies, scoring, or UI are
 * wired yet. Those are deliberate follow-ups.
 */
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';

// Tight SELECT for the question list — every field a future UI renders.
const questionSelect = {
    id: true,
    domainId: true,
    text: true,
    plainText: true,
    legalBasis: true,
    criticality: true,
    respondent: true,
    consequence: true,
    fineExposure: true,
    timeToFix: true,
    day: true,
    dependsOn: true,
} as const;

export class Nis2GapAssessmentRepository {
    // ─── Reference (global) ───────────────────────────────────────────

    /** All 15 gap-assessment domains, ordered by their natural day/id. */
    static async listDomains(db: PrismaTx) {
        return db.nis2GapDomain.findMany({
            orderBy: [{ day: 'asc' }, { id: 'asc' }],
            take: 50,
        });
    }

    /** The full question set (optionally filtered to one domain). */
    static async listQuestions(
        db: PrismaTx,
        options: { domainId?: number } = {},
    ) {
        return db.nis2GapQuestion.findMany({
            where: options.domainId !== undefined ? { domainId: options.domainId } : {},
            orderBy: [{ day: 'asc' }, { id: 'asc' }],
            select: questionSelect,
            take: 500,
        });
    }

    static async getQuestionById(db: PrismaTx, id: string) {
        return db.nis2GapQuestion.findUnique({ where: { id }, select: questionSelect });
    }

    // ─── Tenant-scoped ────────────────────────────────────────────────

    static async listAssessments(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number; status?: string } = {},
    ) {
        return db.nis2SelfAssessment.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(options.status ? { status: options.status } : {}),
            },
            orderBy: { updatedAt: 'desc' },
            take: options.take ?? 100,
        });
    }

    static async getAssessment(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.nis2SelfAssessment.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                answers: {
                    orderBy: { questionId: 'asc' },
                    take: 500,
                },
            },
        });
    }

    static async createAssessment(
        db: PrismaTx,
        ctx: RequestContext,
        input: { title?: string | null; createdById?: string | null; source?: string; status?: string },
    ) {
        return db.nis2SelfAssessment.create({
            data: {
                tenantId: ctx.tenantId,
                title: input.title ?? null,
                createdById: input.createdById ?? null,
                // WIZARD_BASELINE for the one-time onboarding run, STANDALONE
                // for later re-assessments (default). See gap-assessment lifecycle.
                source: input.source ?? 'STANDALONE',
                ...(input.status ? { status: input.status } : {}),
            },
        });
    }

    /** Stamp the run's provenance (e.g. WIZARD_BASELINE on the onboarding run). */
    static async setAssessmentSource(db: PrismaTx, ctx: RequestContext, id: string, source: string) {
        return db.nis2SelfAssessment.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { source },
        });
    }

    /**
     * Mark an assessment COMPLETED. Partial completion is valid — the
     * caller may complete with unanswered questions. `updateMany` carries
     * the explicit `tenantId` guard (defence in depth on top of RLS).
     */
    static async markAssessmentCompleted(db: PrismaTx, ctx: RequestContext, id: string) {
        await db.nis2SelfAssessment.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { status: 'COMPLETED', completedAt: new Date() },
        });
        return db.nis2SelfAssessment.findFirst({ where: { id, tenantId: ctx.tenantId } });
    }

    /**
     * Read a run's status under `FOR SHARE`, held until the transaction ends.
     * It conflicts with `markAssessmentCompleted`'s UPDATE, so an answer
     * written in the same transaction either lands before the run is
     * finalised (finalising then waits for it) or sees COMPLETED and is
     * refused. A plain read would leave a window between the status check and
     * the write. Null when the run does not exist in this tenant.
     */
    static async lockAssessmentStatusForShare(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
    ): Promise<{ status: string } | null> {
        const rows = await db.$queryRaw<Array<{ status: string }>>`
            SELECT "status"
              FROM "Nis2SelfAssessment"
             WHERE "id" = ${id} AND "tenantId" = ${ctx.tenantId}
               FOR SHARE`;
        return rows[0] ?? null;
    }

    static async listAnswers(db: PrismaTx, ctx: RequestContext, assessmentId: string) {
        return db.nis2SelfAssessmentAnswer.findMany({
            where: { tenantId: ctx.tenantId, assessmentId },
            orderBy: { questionId: 'asc' },
            take: 500,
        });
    }

    /**
     * Upsert one answer (idempotent on `[assessmentId, questionId]`).
     * `note` is encrypted on write by the Epic B middleware. Callers MUST
     * have validated `answer` against NIS2_ANSWER and sanitised `note`
     * before this point (the usecase layer's job — not yet built).
     */
    static async upsertAnswer(
        db: PrismaTx,
        ctx: RequestContext,
        input: {
            assessmentId: string;
            questionId: string;
            answer: string;
            note?: string | null;
            answeredById?: string | null;
        },
    ) {
        const base = {
            answer: input.answer,
            note: input.note ?? null,
            answeredById: input.answeredById ?? null,
        };
        return db.nis2SelfAssessmentAnswer.upsert({
            where: {
                assessmentId_questionId: {
                    assessmentId: input.assessmentId,
                    questionId: input.questionId,
                },
            },
            update: base,
            create: {
                tenantId: ctx.tenantId,
                assessmentId: input.assessmentId,
                questionId: input.questionId,
                ...base,
            },
        });
    }
}
