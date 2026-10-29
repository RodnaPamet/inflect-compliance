/**
 * training + background-check usecase (PR-6) — manual entry that stands alone
 * (no provider required). Tenant-scoped; gated by the PR-4 personnel
 * permission (people layer). `resultSummary` is auto-encrypted by the Epic B
 * field-encryption extension (manifest entry).
 */
import { z } from 'zod';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';

const BG_STATUSES = ['PENDING', 'IN_PROGRESS', 'CLEAR', 'CONSIDER', 'FAILED'] as const;

function assertManage(ctx: RequestContext) {
    if (!ctx.appPermissions?.personnel?.manage && !ctx.permissions?.canAdmin) {
        throw forbidden('You do not have permission to manage training / background checks.');
    }
}

// ─── Training courses + assignments ───

export const CreateCourseSchema = z.object({ name: z.string().min(1).max(200), provider: z.string().max(120).optional(), cadenceDays: z.number().int().min(1).max(3650).optional() });
export const AssignTrainingSchema = z.object({ employeeId: z.string().min(1), courseId: z.string().min(1), dueAt: z.string().datetime().optional() });

/** The assignment read. Asserts `personnel.view` itself, the key `GET /training` holds. */
export async function listTrainingAssignments(ctx: RequestContext) {
    if (!ctx.appPermissions?.personnel?.view) {
        throw forbidden('You do not have permission to view training assignments.');
    }
    return runInTenantContext(ctx, (db) =>
        db.trainingAssignment.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, status: true, assignedAt: true, dueAt: true, completedAt: true, employee: { select: { fullName: true, workEmail: true } }, course: { select: { name: true } } },
            orderBy: [{ status: 'asc' }, { assignedAt: 'desc' }],
            take: 500,
        }),
    );
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
