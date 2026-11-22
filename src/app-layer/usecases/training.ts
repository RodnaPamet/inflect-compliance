/**
 * training + background-check usecase (PR-6) — manual entry that stands alone
 * (no provider required). Tenant-scoped; gated by the PR-4 personnel
 * permission (people layer). `resultSummary` is auto-encrypted by the Epic B
 * field-encryption extension (manifest entry).
 */
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { buildCursorWhere, computePageInfo, CURSOR_ORDER_BY } from '@/lib/pagination';
import { normaliseTrainingFilters, TRAINING_PAGE_SIZE, type TrainingFilterStatus } from '@/lib/training-list';

const BG_STATUSES = ['PENDING', 'IN_PROGRESS', 'CLEAR', 'CONSIDER', 'FAILED'] as const;

function assertManage(ctx: RequestContext) {
    if (!ctx.appPermissions?.personnel?.manage && !ctx.permissions?.canAdmin) {
        throw forbidden('You do not have permission to manage training / background checks.');
    }
}

// ─── Training courses + assignments ───

export const CreateCourseSchema = z.object({ name: z.string().min(1).max(200), provider: z.string().max(120).optional(), cadenceDays: z.number().int().min(1).max(3650).optional() });
export const AssignTrainingSchema = z.object({ employeeId: z.string().min(1), courseId: z.string().min(1), dueAt: z.string().datetime().optional() });

const OPEN_STATUSES = ['ASSIGNED', 'IN_PROGRESS'] as const;

/**
 * The status filter in SQL, by each assignment's status as it stands at `now`
 * (`effectiveTrainingStatus`): OVERDUE is a stored OVERDUE or an open
 * assignment past its due date, and an open assignment matches its stored
 * status only while it is not past due. No statuses is no filter.
 */
export function trainingStatusWhere(
    statuses: readonly TrainingFilterStatus[],
    now: Date,
): Prisma.TrainingAssignmentWhereInput | null {
    if (statuses.length === 0) return null;
    const notPastDue: Prisma.TrainingAssignmentWhereInput = { OR: [{ dueAt: null }, { dueAt: { gte: now } }] };
    const arms: Prisma.TrainingAssignmentWhereInput[] = statuses.map((s) => {
        switch (s) {
            case 'OVERDUE':
                return { OR: [{ status: 'OVERDUE' }, { status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } }] };
            case 'COMPLETED':
                return { status: 'COMPLETED' };
            case 'ASSIGNED':
            case 'IN_PROGRESS':
                return { AND: [{ status: s }, notPastDue] };
        }
    });
    return { OR: arms };
}

function trainingSearchWhere(q: string): Prisma.TrainingAssignmentWhereInput | null {
    if (!q) return null;
    const term = { contains: q, mode: 'insensitive' as const };
    return { OR: [{ employee: { fullName: term } }, { employee: { workEmail: term } }, { course: { name: term } }] };
}

export interface TrainingAssignmentPageOptions {
    /** Where the page starts: the `nextCursor` of the page before. A malformed one reads as the first page. */
    cursor?: string | null;
    /** Page size, clamped to 1..TRAINING_PAGE_SIZE. */
    limit?: number;
    q?: string | null;
    status?: string | readonly string[] | null;
}

/**
 * The assignment read, a page at a time (#5764 item 6). Newest first
 * (`createdAt desc, id desc`, the cursor convention in `docs/pagination.md`),
 * with the search and the status filter applied in SQL, so a filter covers
 * every assignment rather than the first page. `total` counts every assignment
 * the filters match, not the page.
 *
 * Asserts `personnel.view` itself, the key `GET /training` holds.
 */
export async function listTrainingAssignments(
    ctx: RequestContext,
    options: TrainingAssignmentPageOptions = {},
    now: Date = new Date(),
) {
    if (!ctx.appPermissions?.personnel?.view) {
        throw forbidden('You do not have permission to view training assignments.');
    }
    const filters = normaliseTrainingFilters(options);
    const requested =
        options.limit !== undefined && Number.isFinite(options.limit) ? Math.trunc(options.limit) : TRAINING_PAGE_SIZE;
    const limit = Math.min(TRAINING_PAGE_SIZE, Math.max(1, requested));
    const filterArms = [trainingStatusWhere(filters.statuses, now), trainingSearchWhere(filters.q)].filter(
        (w): w is Prisma.TrainingAssignmentWhereInput => w !== null,
    );
    const where: Prisma.TrainingAssignmentWhereInput = { tenantId: ctx.tenantId, AND: filterArms };
    const cursorWhere = buildCursorWhere(options.cursor) as Prisma.TrainingAssignmentWhereInput | null;
    return runInTenantContext(ctx, async (db) => {
        const [found, total] = await Promise.all([
            db.trainingAssignment.findMany({
                where: cursorWhere ? { tenantId: ctx.tenantId, AND: [...filterArms, cursorWhere] } : where,
                select: {
                    id: true,
                    status: true,
                    assignedAt: true,
                    dueAt: true,
                    completedAt: true,
                    createdAt: true,
                    employee: { select: { fullName: true, workEmail: true } },
                    course: { select: { name: true } },
                },
                orderBy: CURSOR_ORDER_BY,
                // One past the page, so the read knows whether another follows.
                take: limit + 1,
            }),
            db.trainingAssignment.count({ where }),
        ]);
        const { trimmedItems, nextCursor } = computePageInfo(found, limit);
        return { rows: trimmedItems, nextCursor: nextCursor ?? null, total, filters };
    });
}

export async function createTrainingCourse(ctx: RequestContext, data: z.infer<typeof CreateCourseSchema>) {
    assertManage(ctx);
    return runInTenantContext(ctx, (db) =>
        db.trainingCourse.create({ data: { tenantId: ctx.tenantId, name: sanitizePlainText(data.name), provider: data.provider ?? null, cadenceDays: data.cadenceDays ?? 365 } }),
    );
}

export async function assignTraining(ctx: RequestContext, data: z.infer<typeof AssignTrainingSchema>) {
    assertManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Both refs must belong to this tenant (RLS also enforces this).
        const [emp, course] = await Promise.all([
            db.employee.findFirst({ where: { id: data.employeeId, tenantId: ctx.tenantId }, select: { id: true } }),
            db.trainingCourse.findFirst({ where: { id: data.courseId, tenantId: ctx.tenantId }, select: { id: true } }),
        ]);
        if (!emp || !course) throw forbidden('Unknown employee or course.');
        return db.trainingAssignment.create({ data: { tenantId: ctx.tenantId, employeeId: data.employeeId, courseId: data.courseId, dueAt: data.dueAt ? new Date(data.dueAt) : null, status: 'ASSIGNED' } });
    });
}

export async function completeTrainingAssignment(ctx: RequestContext, id: string, now: Date = new Date()) {
    assertManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const res = await db.trainingAssignment.updateMany({ where: { id, tenantId: ctx.tenantId }, data: { status: 'COMPLETED', completedAt: now } });
        return { completed: res.count > 0 };
    });
}

// ─── Background checks ───

export const RecordBackgroundCheckSchema = z.object({
    employeeId: z.string().min(1),
    provider: z.string().max(120).optional(),
    status: z.enum(BG_STATUSES).default('PENDING'),
    resultSummary: z.string().max(5000).optional(),
});

export async function listBackgroundChecks(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.backgroundCheck.findMany({
            where: { tenantId: ctx.tenantId },
            // resultSummary intentionally omitted from the list projection (sensitive).
            select: { id: true, status: true, provider: true, requestedAt: true, completedAt: true, employee: { select: { fullName: true, workEmail: true } } },
            orderBy: { createdAt: 'desc' },
            take: 500,
        }),
    );
}

export async function recordBackgroundCheck(ctx: RequestContext, data: z.infer<typeof RecordBackgroundCheckSchema>, now: Date = new Date()) {
    assertManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const emp = await db.employee.findFirst({ where: { id: data.employeeId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!emp) throw forbidden('Unknown employee.');
        const terminal = data.status === 'CLEAR' || data.status === 'CONSIDER' || data.status === 'FAILED';
        return db.backgroundCheck.create({
            data: {
                tenantId: ctx.tenantId,
                employeeId: data.employeeId,
                provider: data.provider ?? null,
                status: data.status,
                requestedAt: now,
                completedAt: terminal ? now : null,
                // Encrypted at rest by the Epic B field-encryption extension.
                resultSummary: data.resultSummary ? sanitizePlainText(data.resultSummary) : null,
            },
        });
    });
}
