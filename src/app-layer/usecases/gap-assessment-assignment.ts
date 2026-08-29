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
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { Nis2GapAssessmentRepository } from '../repositories/Nis2GapAssessmentRepository';
import { NIS2_ANSWER } from '@/lib/schemas/nis2-gap-assessment';
import { logEvent } from '../events/audit';
import { createTask } from './task';
import { snapshotNis2Readiness } from './nis2-readiness';
import { sanitizePlainText } from '@/lib/security/sanitize';

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
                    title: `Answer NIS2 gap assessment — ${role} (${questionIds.length} questions)`,
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
                await db.notification.create({
                    data: {
                        tenantId: ctx.tenantId,
                        userId: assigneeUserId,
                        type: 'GENERAL',
                        title: 'NIS2 gap assessment assigned',
                        message: `You have ${questionIds.length} NIS2 questions to answer (${role}).`,
                        linkUrl: `/audits/nis2-gap/respond/${assignment.id}`,
                        dedupeKey: `NIS2_GAP_ASSIGNMENT:${assignment.id}:${assigneeUserId}`,
                    },
                }).catch(() => { /* dedupe/notification failure must not fail dispatch */ });
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
        const [allQuestions, domains, existingAnswers] = await Promise.all([
            Nis2GapAssessmentRepository.listQuestions(db),
            Nis2GapAssessmentRepository.listDomains(db),
            Nis2GapAssessmentRepository.listAnswers(db, ctx, assignment.assessmentId),
        ]);
        const questions = allQuestions.filter((q) => bucket.has(q.id));
        const answers = existingAnswers
            .filter((a) => bucket.has(a.questionId))
            .map((a) => ({ questionId: a.questionId, answer: a.answer, note: a.note ?? null }));
        return { assignment, questions, domains, answers };
    });
}

// ─── Submit (assignee-scoped, data-layer authz) ─────────────────────

/**
 * Write ONLY answers whose ids are in this assignment's bucket into the parent
 * answer table; REJECT any id outside the bucket (authorization at the data
 * layer). Sets the assignment SUBMITTED. Concurrent submits of disjoint buckets
 * are safe — each answer is its own row.
 */
export async function submitAssignmentAnswers(
    ctx: RequestContext,
    assignmentId: string,
    answers: Array<{ questionId: string; answer: string; note?: string | null }>,
): Promise<{ written: number }> {
    assertCanWrite(ctx);
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

        // DATA-LAYER AUTHORIZATION: every answered id MUST be in this bucket.
        const bucket = new Set(assignment.questionIds);
        for (const a of answers) {
            if (!bucket.has(a.questionId)) {
                throw forbidden(`Question ${a.questionId} is not in your assignment.`);
            }
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

        await db.nis2GapAssignment.updateMany({
            where: { id: assignmentId, tenantId: ctx.tenantId },
            data: { status: 'SUBMITTED', submittedAt: new Date() },
        });

        await logEvent(db, ctx, {
            action: 'NIS2_ASSIGNMENT_SUBMITTED',
            entityType: 'Nis2GapAssignment',
            entityId: assignmentId,
            detailsJson: { category: 'custom', event: 'nis2_assignment_submitted', written },
        });

        return { written };
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
