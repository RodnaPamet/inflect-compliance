/**
 * NIS2 gap-assessment — multi-respondent async collection (Prompt 2).
 *
 * NIS2 accountability is cross-functional: scoping is a CEO answer, cryptography
 * is IT, training is HR, supply chain is Procurement. The shared bank already
 * tags every question with `respondent`; this partitions a STANDALONE run's 116
 * questions into DISJOINT per-role buckets and routes each to the member who can
 * answer it.
 *
 * Load-bearing invariants:
 *  - PARTITION: the union of all assignments' questionIds is exactly the bank's
 *    ids, with NO overlap (disjoint cover) — enforced at dispatch. This is what
 *    makes "write only my questions" safe and merge-free.
 *  - SINGLE SOURCE OF ANSWERS: answers live ONLY on the parent
 *    `Nis2SelfAssessmentAnswer` (one row per (assessment, question), unique) —
 *    assignments never copy answers. Disjoint buckets therefore write DIFFERENT
 *    rows, so concurrent submits can't clobber each other (no JSON-blob merge).
 *  - DATA-LAYER AUTHORIZATION: `submitAssignmentAnswers` rejects any questionId
 *    outside the caller's bucket, verified against the assignment row in the
 *    usecase — not the client. An HR assignee cannot write a Cryptography answer
 *    even with a crafted payload.
 *  - BASELINE IS NEVER DELEGATED: dispatch rejects a WIZARD_BASELINE run.
 *  - PROPOSE-NOT-COMMIT stays finalize-time (Prompt 1); dispatch only creates
 *    the assignee Tasks (a normal audited `task.createTask`, not a propose breach)
 *    and completion snapshots — risks/controls are still approval-gated.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { Nis2GapAssessmentRepository } from '../repositories/Nis2GapAssessmentRepository';
import { NIS2_ANSWER } from '@/lib/schemas/nis2-gap-assessment';
import { logEvent } from '../events/audit';
import { createTask } from './task';
import { snapshotNis2Readiness } from './nis2-readiness';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { resolveTenantSlugForLinks, tenantPageLink } from '../notifications/tenant-link';
import { isFinalizedNis2Run } from '@/lib/nis2-run-status';

export const NIS2_RESPONDENT_ROLES = ['CEO', 'IT', 'HR', 'PROCUREMENT', 'ANYONE'] as const;
export type Nis2RespondentRole = (typeof NIS2_RESPONDENT_ROLES)[number];

// ─── Partition ──────────────────────────────────────────────────────

/**
 * Split the bank's questions into disjoint buckets keyed by `respondent`.
 * Deterministic (questions come sorted from the repo). PURE over the bank —
 * imports no local copy. The union is exactly the full question set.
 */
export async function partitionByRespondent(
    ctx: RequestContext,
): Promise<Record<string, string[]>> {
    assertCanRead(ctx);
    const questions = await runInTenantContext(ctx, (db) =>
        Nis2GapAssessmentRepository.listQuestions(db),
    );
    const buckets: Record<string, string[]> = {};
    for (const role of NIS2_RESPONDENT_ROLES) buckets[role] = [];
    for (const q of questions) {
        const role = (buckets[q.respondent] ? q.respondent : 'ANYONE') as string;
        buckets[role].push(q.id);
    }
    return buckets;
}

/** Assert a bucket map is a disjoint cover of `allIds` (no gaps, no overlap). */
function assertDisjointCover(buckets: Record<string, string[]>, allIds: string[]): void {
    const seen = new Set<string>();
    let count = 0;
    for (const ids of Object.values(buckets)) {
        for (const id of ids) {
            if (seen.has(id)) throw badRequest(`Partition overlap on question ${id}`);
            seen.add(id);
            count += 1;
        }
    }
    if (count !== allIds.length || seen.size !== allIds.length) {
        throw badRequest(`Partition is not a complete cover (${seen.size}/${allIds.length}).`);
    }
}

// ─── Dispatch ───────────────────────────────────────────────────────

export interface DispatchResult {
    assignmentsCreated: number;
    assignmentsUpdated: number;
    tasksCreated: number;
}

/**
 * Fan a STANDALONE assessment out to its respondents. Idempotent (upsert per
 * role). Rejects a WIZARD_BASELINE run. Creates a scoped Task + Notification per
 * assignee. `roleToUserId` maps each respondent role to a tenant member id.
 */
export async function dispatchAssignments(
    ctx: RequestContext,
    assessmentId: string,
    roleToUserId: Record<string, string | null | undefined>,
): Promise<DispatchResult> {
    assertCanWrite(ctx);

    const buckets = await partitionByRespondent(ctx);
    const allIds = Object.values(buckets).flat();
    assertDisjointCover(buckets, allIds);

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.nis2SelfAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: { id: true, source: true },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (assessment.source === 'WIZARD_BASELINE') {
            throw badRequest('The wizard baseline run cannot be delegated — start a re-assessment first.');
        }

        let created = 0;
        let updated = 0;
        let tasksCreated = 0;
        // For the assignee's notification link, which must carry the
        // `/t/<slug>` prefix — a bare tenant path 404'd from the bell (#4128).
        // Resolved once, not per role.
        const tenantSlug = await resolveTenantSlugForLinks(db, ctx);

        // Bounded to the 5 respondent roles, all inside one tenant transaction;
        // the per-role upsert/task cannot be hoisted into a single query.
        for (const role of NIS2_RESPONDENT_ROLES) { // guardrail-allow: n+1
            const questionIds = buckets[role];
            if (!questionIds.length) continue;
            const assigneeUserId = roleToUserId[role] ?? null;

            const existing = await db.nis2GapAssignment.findUnique({
                where: { assessmentId_respondentRole: { assessmentId, respondentRole: role } },
                select: { id: true, assigneeUserId: true },
            });

            const assignment = await db.nis2GapAssignment.upsert({
                where: { assessmentId_respondentRole: { assessmentId, respondentRole: role } },
                update: { assigneeUserId, questionIds },
                create: { tenantId: ctx.tenantId, assessmentId, respondentRole: role, assigneeUserId, questionIds, status: 'PENDING' },
            });
            if (existing) updated += 1; else created += 1;

            // Notify + task the assignee only when there IS one and it changed
            // (idempotent re-dispatch doesn't spam an unchanged assignee).
            const assigneeChanged = !existing || existing.assigneeUserId !== assigneeUserId;
            if (assigneeUserId && assigneeChanged) {
                await createTask(ctx, {
                    title: `Answer the NIS2 gap assessment questions for ${respondentLabel(role)} (${questionCount(questionIds.length)})`,
                    type: 'CONTROL_GAP',
                    source: 'AUDIT',
                    assigneeUserId,
                    metadataJson: {
                        source: 'NIS2_GAP_ASSIGNMENT',
                        assignmentId: assignment.id,
                        respondentRole: role,
                        // Deep-link to the assignee's scoped answer page.
                        href: `/audits/nis2-gap/respond/${assignment.id}`,
                    },
                });
                tasksCreated += 1;
                // ON CONFLICT DO NOTHING (#5257). A re-dispatch back to an
                // earlier assignee meets the dedupe key from the first
                // dispatch; a caught unique violation here aborted this
                // interactive transaction, so the next statement failed and
                // every assignment in the dispatch rolled back.
                await db.notification.createMany({
                    data: [
                        {
                            tenantId: ctx.tenantId,
                            userId: assigneeUserId,
                            type: 'GENERAL',
                            title: 'NIS2 gap assessment assigned',
                            message: `You have ${questionCount(questionIds.length)} to answer in the NIS2 gap assessment, for ${respondentLabel(role)}.`,
                            linkUrl: tenantPageLink(tenantSlug, `/audits/nis2-gap/respond/${assignment.id}`),
                            dedupeKey: `NIS2_GAP_ASSIGNMENT:${assignment.id}:${assigneeUserId}`,
                        },
                    ],
                    skipDuplicates: true,
                });
            }
        }

        await logEvent(db, ctx, {
            action: 'NIS2_ASSIGNMENTS_DISPATCHED',
            entityType: 'Nis2SelfAssessment',
            entityId: assessmentId,
            detailsJson: { category: 'custom', event: 'nis2_assignments_dispatched', created, updated, tasksCreated },
        });

        return { assignmentsCreated: created, assignmentsUpdated: updated, tasksCreated };
    });
}

// ─── Assignee read ──────────────────────────────────────────────────

/** List assignments for the current run (owner view). */
export async function listAssignments(ctx: RequestContext, assessmentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.nis2GapAssignment.findMany({
            where: { tenantId: ctx.tenantId, assessmentId },
            orderBy: { respondentRole: 'asc' },
        }),
    );
}

/**
 * The caller's scoped assignment: only their bucket's questions + current
 * answers. Authorization: the assignee themselves, or an assessment admin.
 */
export async function getAssignmentForRespondent(ctx: RequestContext, assignmentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const assignment = await db.nis2GapAssignment.findFirst({
            where: { id: assignmentId, tenantId: ctx.tenantId },
        });
        if (!assignment) throw notFound('Assignment not found');
        const isAssignee = assignment.assigneeUserId != null && assignment.assigneeUserId === ctx.userId;
        const isAdmin = ctx.appPermissions?.admin?.tenant_lifecycle === true || ctx.role === 'OWNER' || ctx.role === 'ADMIN';
        if (!isAssignee && !isAdmin) throw forbidden('This assignment belongs to another member.');

        const bucket = new Set(assignment.questionIds);
        const [allQuestions, domains, existingAnswers, assessment] = await Promise.all([
            Nis2GapAssessmentRepository.listQuestions(db),
            Nis2GapAssessmentRepository.listDomains(db),
            Nis2GapAssessmentRepository.listAnswers(db, ctx, assignment.assessmentId),
            db.nis2SelfAssessment.findFirst({
                where: { id: assignment.assessmentId, tenantId: ctx.tenantId },
                select: { status: true },
            }),
        ]);
        const questions = allQuestions.filter((q) => bucket.has(q.id));
        const answers = existingAnswers
            .filter((a) => bucket.has(a.questionId))
            .map((a) => ({ questionId: a.questionId, answer: a.answer, note: a.note ?? null }));
        // The respond page offers Submit (and re-submit) only while this is
        // false; the submit itself refuses the same state.
        const finalized = isFinalizedRun(assessment?.status ?? null);
        return { assignment, questions, domains, answers, finalized };
    });
}

// ─── Submit (assignee-scoped, data-layer authz) ─────────────────────

/** A COMPLETED or ARCHIVED run, or a missing one, no longer takes answers. */
const isFinalizedRun = isFinalizedNis2Run;

/**
 * The respondent group in words, for the task and notification an assignee
 * receives (#4929). They are stored text with no recipient locale to render
 * in, so they are English; the codes stay in the task's metadata.
 */
const RESPONDENT_LABEL: Record<string, string> = {
    CEO: 'leadership',
    IT: 'IT',
    HR: 'HR',
    PROCUREMENT: 'procurement',
    ANYONE: 'anyone in the organisation',
};
const respondentLabel = (role: string) => RESPONDENT_LABEL[role] ?? role;
const questionCount = (n: number) => (n === 1 ? '1 question' : `${n} questions`);

/**
 * Write ONLY answers whose ids are in this assignment's bucket into the parent
 * answer table; REJECT any id outside the bucket (authorization at the data
 * layer). Concurrent submits of disjoint buckets are safe — each answer is its
 * own row.
 *
 * SAVE OR SUBMIT (#4929): a save (`final: false`) writes what is there and
 * moves a PENDING assignment to IN_PROGRESS. A submit (the default) needs
 * every question in the bucket answered, stored or in this request, and sets
 * the assignment SUBMITTED; otherwise it is refused (409) and writes nothing.
 * It used to mark three answers of twelve as a submitted assignment.
 *
 * WHO: the assignee, whatever their role, or an Owner or Admin (#4633 owner
 * decision, 2026-10-30). The assignment IS the grant: an admin chose this
 * person for these questions, and the picker lists every member. This used to
 * call `assertCanWrite` first, so a Reader, Auditor or AI admin who was
 * assigned questions could open them and never submit.
 *
 * WHEN: until the run is finalised, re-submits included. A finalised run is a
 * COMPLETED record with a readiness snapshot taken from these answers, so a
 * late submit is refused (409) rather than rewriting it.
 */
export async function submitAssignmentAnswers(
    ctx: RequestContext,
    assignmentId: string,
    answers: Array<{ questionId: string; answer: string; note?: string | null }>,
    opts: { final?: boolean } = {},
): Promise<{ written: number; status: 'IN_PROGRESS' | 'SUBMITTED'; unanswered: number }> {
    // A submit claims the assignment is done, so it must be (#4929): every
    // question in the bucket answered. A save writes what there is.
    const final = opts.final ?? true;
    assertCanRead(ctx);
    // Validate the answer enum up front.
    for (const a of answers) {
        if (!(NIS2_ANSWER as readonly string[]).includes(a.answer)) {
            throw badRequest(`Invalid answer "${a.answer}".`);
        }
    }
    return runInTenantContext(ctx, async (db) => {
        const assignment = await db.nis2GapAssignment.findFirst({
            where: { id: assignmentId, tenantId: ctx.tenantId },
        });
        if (!assignment) throw notFound('Assignment not found');
        const isAssignee = assignment.assigneeUserId != null && assignment.assigneeUserId === ctx.userId;
        const isAdmin = ctx.role === 'OWNER' || ctx.role === 'ADMIN';
        if (!isAssignee && !isAdmin) throw forbidden('This assignment belongs to another member.');

        const run = await Nis2GapAssessmentRepository.lockAssessmentStatusForShare(db, ctx, assignment.assessmentId);
        if (isFinalizedRun(run?.status ?? null)) {
            throw conflict('This assessment has been finalised, so its answers can no longer change.');
        }

        // DATA-LAYER AUTHORIZATION: every answered id MUST be in this bucket.
        const bucket = new Set(assignment.questionIds);
        for (const a of answers) {
            if (!bucket.has(a.questionId)) {
                throw forbidden(`Question ${a.questionId} is not in your assignment.`);
            }
        }

        const answered = new Set(
            ((await Nis2GapAssessmentRepository.listAnswers(db, ctx, assignment.assessmentId)) ?? [])
                .map((r) => r.questionId)
                .filter((id) => bucket.has(id)),
        );
        for (const a of answers) answered.add(a.questionId);
        const unanswered = bucket.size - answered.size;
        if (final && unanswered > 0) {
            throw conflict(
                `${unanswered} of ${bucket.size} questions in this assignment are not answered yet. Answer them all to submit, or save your answers and come back.`,
            );
        }

        let written = 0;
        for (const a of answers) {
            // Epic D.2 — `note` is an encrypted free-text column. Encryption is
            // confidentiality at rest; the decrypted value is read back by the
            // assessment UI, the readiness export and the audit pack. Sanitise
            // at the write seam, matching the sibling NIS2 answer path in
            // `onboarding-nis2.ts::saveNis2Answer`.
            const note =
                a.note != null && a.note.trim() !== '' ? sanitizePlainText(a.note) : null;
            await Nis2GapAssessmentRepository.upsertAnswer(db, ctx, {
                assessmentId: assignment.assessmentId,
                questionId: a.questionId,
                answer: a.answer,
                note,
                answeredById: ctx.userId ?? null,
            });
            written += 1;
        }

        // A save moves a PENDING assignment on to IN_PROGRESS and leaves a
        // SUBMITTED one SUBMITTED: its answers can only have been changed, not
        // removed, so it is still complete.
        const status: 'IN_PROGRESS' | 'SUBMITTED' =
            final || assignment.status === 'SUBMITTED' ? 'SUBMITTED' : 'IN_PROGRESS';
        await db.nis2GapAssignment.updateMany({
            where: { id: assignmentId, tenantId: ctx.tenantId },
            data: final ? { status: 'SUBMITTED', submittedAt: new Date() } : { status },
        });

        await logEvent(db, ctx, {
            action: final ? 'NIS2_ASSIGNMENT_SUBMITTED' : 'NIS2_ASSIGNMENT_SAVED',
            entityType: 'Nis2GapAssignment',
            entityId: assignmentId,
            detailsJson: {
                category: 'custom',
                event: final ? 'nis2_assignment_submitted' : 'nis2_assignment_saved',
                written,
                unanswered,
            },
        });

        return { written, status, unanswered };
    });
}

// ─── Finalize ───────────────────────────────────────────────────────

/**
 * Complete a delegated run once every assignment is SUBMITTED (or the owner
 * force-finalizes — unanswered questions are simply excluded from scoring, i.e.
 * treated as NA). Marks the run COMPLETED and snapshots readiness for the trend.
 * The propose-not-commit remediation review (Prompt 1) stays a separate,
 * approval-gated action on /audits/nis2-gap — nothing is auto-created here.
 */
export async function finalizeAssessment(
    ctx: RequestContext,
    assessmentId: string,
    options: { force?: boolean } = {},
): Promise<{ finalized: true }> {
    assertCanWrite(ctx);
    await runInTenantContext(ctx, async (db) => {
        const assignments = await db.nis2GapAssignment.findMany({
            where: { tenantId: ctx.tenantId, assessmentId },
            select: { status: true },
        });
        const outstanding = assignments.filter((a) => a.status !== 'SUBMITTED').length;
        if (!options.force && outstanding > 0) {
            throw badRequest(`${outstanding} assignment(s) not yet submitted — force to finalize with partial answers.`);
        }
        await Nis2GapAssessmentRepository.markAssessmentCompleted(db, ctx, assessmentId);
        await logEvent(db, ctx, {
            action: 'NIS2_ASSESSMENT_FINALIZED',
            entityType: 'Nis2SelfAssessment',
            entityId: assessmentId,
            detailsJson: { category: 'custom', event: 'nis2_assessment_finalized', forced: !!options.force, outstanding },
        });
    });
    // Snapshot outside the tenant tx (its own tenant context) — best-effort.
    await snapshotNis2Readiness(ctx).catch(() => { /* snapshot failure must not fail finalize */ });
    return { finalized: true };
}
