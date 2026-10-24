/**
 * Give already-installed template tasks the steps their template now carries.
 *
 * Install copies a template task's steps onto the tenant's task as a checklist
 * (`taskFromTemplateTask`), once, at install. A task installed before its
 * template had steps therefore has none — and stays that way, because nothing
 * revisits an installed task. MGF's 24 tasks had no steps until 2026-10-24, so
 * every tenant that installed MGF before then holds tasks the template has
 * since given steps to; the same is true of every framework whose steps were
 * authored after a tenant installed it. Re-authoring the catalogue reaches the
 * catalogue and no further.
 *
 * ═══ WHAT IS TOUCHED, AND WHAT IS NOT ═══
 *
 * A task is filled when ALL of these hold, and only then:
 *
 *   • it records the template task it came from (`templateTaskId`) — the only
 *     way to know which steps belong to it. Tasks installed before that column
 *     existed are indistinguishable from hand-written ones and are left alone;
 *     `task-from-template.ts` explains why that cannot be recovered;
 *   • its checklist is NULL — a checklist that exists, ticked or not, is the
 *     tenant's and is never replaced, so a re-run and a re-authoring of the
 *     steps both leave it as it is;
 *   • it is not deleted and not terminal. A closed task's record is what was
 *     done; adding unticked steps to it after the fact would report work as
 *     outstanding on a task somebody finished;
 *   • its template task is live (not deprecated) and carries steps. A
 *     deprecated row is advice the template withdrew.
 *
 * The write repeats the NULL test in its WHERE, so a task that gained a
 * checklist between the read and the write is not overwritten.
 *
 * Runs as the connection's own role, which the RLS `superuser_bypass` policy
 * admits, as `scripts/seed-vendor-questionnaires.ts` does for its per-tenant
 * rows. It writes no audit row: it adds template guidance to a task, not work
 * a person did, which is what the trail records — the same position install
 * takes for the checklist it writes.
 *
 * @module prisma/task-checklist-backfill
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { checklistFromSteps } from '@/app-layer/usecases/control/task-from-template';
import { TERMINAL_TASK_STATUSES } from '@/app-layer/domain/task-status';

/** Tasks read per round trip. */
const BATCH_SIZE = 500;

export interface TaskChecklistBackfillResult {
    /** Candidate tasks read: template-installed, live, open, no checklist. */
    scanned: number;
    /** Tasks given a checklist by this run. */
    filled: number;
    /** Candidates whose template task is deprecated, gone, or has no steps. */
    noSteps: number;
    /** Candidates that gained a checklist between the read and the write. */
    raced: number;
}

export async function backfillTemplateTaskChecklists(
    prisma: PrismaClient,
): Promise<TaskChecklistBackfillResult> {
    const result: TaskChecklistBackfillResult = { scanned: 0, filled: 0, noSteps: 0, raced: 0 };
    let cursor: string | undefined;

    for (;;) {
        const tasks = await prisma.task.findMany({
            where: {
                templateTaskId: { not: null },
                checklistJson: { equals: Prisma.DbNull },
                deletedAt: null,
                status: { notIn: [...TERMINAL_TASK_STATUSES] },
            },
            select: { id: true, tenantId: true, templateTaskId: true },
            orderBy: { id: 'asc' },
            take: BATCH_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (tasks.length === 0) break;
        cursor = tasks[tasks.length - 1].id;
        result.scanned += tasks.length;

        const templateIds = [...new Set(tasks.map((t) => t.templateTaskId as string))];
        const templates = await prisma.controlTemplateTask.findMany({
            where: { id: { in: templateIds }, deprecatedAt: null },
            select: { id: true, stepsJson: true },
        });
        const stepsByTemplate = new Map(templates.map((t) => [t.id, t.stepsJson]));

        for (const task of tasks) {
            const checklist = checklistFromSteps(stepsByTemplate.get(task.templateTaskId as string));
            if (!checklist) {
                result.noSteps++;
                continue;
            }
            const res = await prisma.task.updateMany({
                where: {
                    id: task.id,
                    tenantId: task.tenantId,
                    checklistJson: { equals: Prisma.DbNull },
                },
                data: { checklistJson: checklist as unknown as Prisma.InputJsonValue },
            });
            if (res.count === 1) result.filled++;
            else result.raced++;
        }

        if (tasks.length < BATCH_SIZE) break;
    }

    return result;
}
