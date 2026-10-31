/**
 * NIS2 self-assessment — onboarding usecase surface.
 *
 * The CONDITIONAL onboarding step (NIS2_SELF_ASSESSMENT, shown only when
 * NIS2 is among the selected frameworks) is backed by these three
 * usecases. They sit on top of the Prompt-1 data layer
 * (`Nis2GapAssessmentRepository`): the tenant's single self-assessment is
 * resolved get-or-create, answers autosave one at a time, and completion
 * is allowed with unanswered questions (partial completion is valid).
 *
 * Authorization mirrors the rest of onboarding — `assertCanManageOnboarding`
 * (ADMIN+) at the usecase layer; the routes wrap with `withApiErrorHandling`
 * so mutations also get the mutation-tier rate limit.
 */
import { RequestContext } from '../types';
import { runInTenantContext, PrismaTx } from '@/lib/db-context';
import { badRequest, ConflictError } from '@/lib/errors/types';
import { isFinalizedNis2Run } from '@/lib/nis2-run-status';
import type { OnboardingRefusal } from '@/lib/onboarding-refusals';
import { assertCanManageOnboarding } from '../policies/onboarding.policies';
import { Nis2GapAssessmentRepository } from '../repositories/Nis2GapAssessmentRepository';
import { NIS2_ANSWER } from '@/lib/schemas/nis2-gap-assessment';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { getOnboardingState, completeOnboardingStep } from './onboarding';
import { snapshotNis2Readiness } from './nis2-readiness';
import { logger } from '@/lib/observability/logger';

/**
 * Resolve the tenant's ACTIVE self-assessment (latest run), creating it on
 * first touch. The first-ever run is the wizard BASELINE (assessment #1 in the
 * lifecycle history); later re-assessments are started explicitly via
 * `startStandaloneNis2Assessment` and become the latest, so subsequent answer
 * saves + completion target the standalone run.
 */
async function resolveAssessment(db: PrismaTx, ctx: RequestContext) {
    const existing = await Nis2GapAssessmentRepository.listAssessments(db, ctx, { take: 1 });
    if (existing[0]) return existing[0];
    return Nis2GapAssessmentRepository.createAssessment(db, ctx, {
        createdById: ctx.userId ?? null,
        source: 'WIZARD_BASELINE',
    });
}

/**
 * Start a fresh STANDALONE re-assessment (Audits lifecycle "Re-run"). Creates a
 * new IN_PROGRESS run against the same shared bank; it becomes the latest run,
 * so the existing answer/complete usecases operate on it. Never overwrites the
 * baseline or prior runs — history is append-only.
 */
export async function startStandaloneNis2Assessment(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const created = await Nis2GapAssessmentRepository.createAssessment(db, ctx, {
            createdById: ctx.userId ?? null,
            source: 'STANDALONE',
            status: 'IN_PROGRESS',
        });
        await logEvent(db, ctx, {
            action: 'NIS2_ASSESSMENT_STARTED',
            entityType: 'Nis2SelfAssessment',
            entityId: created.id,
            detailsJson: { category: 'custom', event: 'nis2_assessment_restarted', source: 'STANDALONE' },
        });
        return created;
    });
}

/**
 * The full assessment state for the step UI: the 15 domains, the question
 * set, the tenant's current answers, and answered/total progress.
 */
export async function getNis2AssessmentState(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [domains, questions] = await Promise.all([
            Nis2GapAssessmentRepository.listDomains(db),
            Nis2GapAssessmentRepository.listQuestions(db),
        ]);
        const assessment = await resolveAssessment(db, ctx);
        const answers = await Nis2GapAssessmentRepository.listAnswers(db, ctx, assessment.id);
        return {
            assessmentId: assessment.id,
            status: assessment.status,
            domains,
            questions,
            answers: answers.map((a) => ({
                questionId: a.questionId,
                answer: a.answer,
                note: a.note ?? null,
            })),
            progress: { answered: answers.length, total: questions.length },
        };
    });
}

/**
 * Upsert one answer (autosave). Validates the answer enum + that the
 * question exists, sanitises the free-text note (Epic D), and emits an
 * audit entry. The assessment is resolved server-side — the client never
 * manages an assessment id.
 */
export async function saveNis2Answer(
    ctx: RequestContext,
    input: { questionId: string; answer: string; note?: string | null },
) {
    assertCanManageOnboarding(ctx);
    if (!(NIS2_ANSWER as readonly string[]).includes(input.answer)) {
        throw badRequest(`Invalid answer "${input.answer}" — expected one of ${NIS2_ANSWER.join(', ')}.`);
    }
    return runInTenantContext(ctx, async (db) => {
        const question = await Nis2GapAssessmentRepository.getQuestionById(db, input.questionId);
        if (!question) {
            throw badRequest(`Unknown NIS2 question "${input.questionId}".`);
        }
        const assessment = await resolveAssessment(db, ctx);
        // A finalised run's answers are its record (#4734). This used to write
        // into whatever run was latest, so answering after completion rewrote
        // a completed run and the gap page's history stopped matching what was
        // answered at the time. The lock is the one the delegated answers take,
        // so finalising and answering cannot interleave.
        const run = await Nis2GapAssessmentRepository.lockAssessmentStatusForShare(db, ctx, assessment.id);
        if (isFinalizedNis2Run(run?.status)) {
            throw new ConflictError('This assessment has been completed, so its answers can no longer change. Start a new run from the NIS2 gap page.', {
                reason: 'NIS2_RUN_FINALISED' satisfies OnboardingRefusal,
            });
        }
        const note =
            input.note != null && input.note.trim() !== ''
                ? sanitizePlainText(input.note)
                : null;
        const saved = await Nis2GapAssessmentRepository.upsertAnswer(db, ctx, {
            assessmentId: assessment.id,
            questionId: input.questionId,
            answer: input.answer,
            note,
            answeredById: ctx.userId ?? null,
        });
        await logEvent(db, ctx, {
            action: 'NIS2_ASSESSMENT_ANSWERED',
            entityType: 'Nis2SelfAssessmentAnswer',
            entityId: saved.id,
            // `category` is the REQUIRED discriminator on AuditDetailsJsonSchema.
            // Without it the audit write 400s ("Invalid detailsJson structure")
            // and the answer autosave fails outright; the extra keys pass through.
            detailsJson: {
                category: 'custom',
                event: 'nis2_assessment_answered',
                questionId: input.questionId,
                answer: input.answer,
            },
        });
        return saved;
    });
}

/**
 * Mark the assessment COMPLETED (partial completion allowed) and, when
 * onboarding is still in progress, complete the NIS2_SELF_ASSESSMENT step
 * so the wizard advances to ASSET_SETUP. Completing from the resume-later
 * surface (onboarding already finished) just marks the assessment.
 */
export async function completeNis2Assessment(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    const assessment = await runInTenantContext(ctx, async (db) => {
        const a = await resolveAssessment(db, ctx);
        // Completing a finalised run again keeps it as it was: re-marking it
        // moved its completedAt (#4734). The onboarding step still advances
        // below, so a wizard whose run was completed elsewhere can go on.
        if (isFinalizedNis2Run(a.status)) return a;
        return Nis2GapAssessmentRepository.markAssessmentCompleted(db, ctx, a.id);
    });

    // Advance the onboarding step only if onboarding is mid-flight.
    try {
        const state = await getOnboardingState(ctx);
        if (
            state.status === 'IN_PROGRESS' &&
            !state.completedSteps.includes('NIS2_SELF_ASSESSMENT')
        ) {
            await completeOnboardingStep(ctx, 'NIS2_SELF_ASSESSMENT');
        }
    } catch (e) {
        logger.warn('nis2 assessment: onboarding step advance skipped', {
            component: 'onboarding',
            error: e instanceof Error ? { name: e.name, message: e.message } : { name: 'UnknownError', message: String(e) },
        });
    }

    // Snapshot the readiness score for the trend line (best-effort — a
    // snapshot failure must not fail completion).
    try {
        await snapshotNis2Readiness(ctx);
    } catch (e) {
        logger.warn('nis2 assessment: readiness snapshot skipped', {
            component: 'onboarding',
            error: e instanceof Error ? { name: e.name, message: e.message } : { name: 'UnknownError', message: String(e) },
        });
    }

    return assessment;
}
