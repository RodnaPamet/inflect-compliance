/**
 * personnel usecase (PR-4) — list + manual entry for the Employee hub.
 * Tenant-scoped via runInTenantContext; permission-gated by the caller
 * (personnel.view / personnel.manage).
 *
 * Two write functions live here and they are deliberately unequal:
 * `createEmployee` writes the whole row, `setEmployeeManager` writes ONE
 * column. The asymmetry is the point — see the block above
 * `setEmployeeManager` for why `status` is not reachable from the second.
 */
import { z } from 'zod';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { Prisma } from '@prisma/client';

const EMPLOYEE_STATUSES = ['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'TERMINATED', 'LEAVE'] as const;

export const CreateEmployeeSchema = z.object({
    fullName: z.string().min(1).max(200),
    workEmail: z.string().email().max(320),
    status: z.enum(EMPLOYEE_STATUSES).default('ACTIVE'),
    department: z.string().max(200).optional(),
    jobTitle: z.string().max(200).optional(),
    startDate: z.string().datetime().optional(),
});

export interface EmployeeListRow {
    id: string;
    fullName: string;
    workEmail: string;
    status: string;
    department: string | null;
    jobTitle: string | null;
    managerEmployeeId: string | null;
    source: string;
    startDate: Date | null;
}

export async function listEmployees(
    ctx: RequestContext,
    filters: { status?: string; search?: string } = {},
): Promise<EmployeeListRow[]> {
    return runInTenantContext(ctx, (db) => {
        const where: Prisma.EmployeeWhereInput = { tenantId: ctx.tenantId };
        if (filters.status && EMPLOYEE_STATUSES.includes(filters.status as (typeof EMPLOYEE_STATUSES)[number])) {
            where.status = filters.status as (typeof EMPLOYEE_STATUSES)[number];
        }
        if (filters.search) {
            where.OR = [
                { fullName: { contains: filters.search, mode: 'insensitive' } },
                { workEmail: { contains: filters.search, mode: 'insensitive' } },
            ];
        }
        return db.employee.findMany({
            where,
            select: { id: true, fullName: true, workEmail: true, status: true, department: true, jobTitle: true, managerEmployeeId: true, source: true, startDate: true },
            orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
            take: 500,
        });
    });
}

export async function getEmployee(ctx: RequestContext, id: string) {
    return runInTenantContext(ctx, (db) =>
        db.employee.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { id: true, fullName: true, workEmail: true, status: true, department: true, jobTitle: true, managerEmployeeId: true, source: true, startDate: true, endDate: true, externalId: true, syncedAt: true },
        }),
    );
}

export async function createEmployee(ctx: RequestContext, data: z.infer<typeof CreateEmployeeSchema>) {
    if (!ctx.permissions?.canAdmin && !ctx.appPermissions?.personnel?.manage) {
        throw forbidden('You do not have permission to manage personnel.');
    }
    return runInTenantContext(ctx, async (db) => {
        const employee = await db.employee.create({
            data: {
                tenantId: ctx.tenantId,
                fullName: sanitizePlainText(data.fullName),
                workEmail: data.workEmail,
                status: data.status,
                department: data.department ? sanitizePlainText(data.department) : null,
                jobTitle: data.jobTitle ? sanitizePlainText(data.jobTitle) : null,
                startDate: data.startDate ? new Date(data.startDate) : null,
                source: 'MANUAL',
            },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Employee',
            entityId: employee.id,
            details: `Created employee: ${employee.fullName}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Employee', operation: 'created', after: { workEmail: employee.workEmail, status: employee.status }, summary: `Created employee: ${employee.fullName}` },
        });
        return employee;
    });
}

/**
 * The manager field's update path — and ONLY the manager field (#2492).
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `Employee.managerEmployeeId` had exactly one writer: `hris-sync.ts`, which
 * needs an ENABLED BambooHR/Workday connection, a feed carrying `managerEmail`,
 * and that manager present in the same roster. `createEmployee` cannot set it
 * and there was no update path at all. So at a tenant that onboards people by
 * hand — every tenant before it wires an HRIS — no employee has a manager,
 * nothing can give one, and the leaver mail #2488 raised to WARN has no
 * recipient on every single disable. This is the cause; #2488 logged the
 * symptom.
 *
 * ═══ `status` IS NOT REACHABLE FROM HERE, AND THAT IS THE WHOLE DESIGN ═══
 *
 * CLAUDE.md: "There is no update path for an employee's status outside HRIS
 * sync." `TERMINATED` is what makes a worker a candidate for a real directory
 * disable, so a second writer on that column is a second way to cause an
 * automated write to a customer's directory. A general `updateEmployee` would
 * have been one. Three independent things stop it:
 *
 *   1. `SetEmployeeManagerSchema` is `.strict()` and declares ONE key, so a
 *      body carrying `status` is a 400 — not a silently stripped field the
 *      caller believes was applied.
 *   2. The Prisma `data` literal below names one column. It is not spread
 *      from the parsed body, so widening the schema alone cannot widen the
 *      write.
 *   3. The route's URL is `.../personnel/[employeeId]/manager` — it names the
 *      field it writes, so adding a second field means moving the route,
 *      which is a diff a reviewer cannot miss.
 *
 * Pinned by `tests/guards/employee-status-single-write-seam.test.ts`, which
 * fails if this body ever writes `status` or if a third file starts writing
 * `Employee.status` at all.
 *
 * ═══ PRECEDENCE: THE FEED WINS WHEN IT SPEAKS, THE MANUAL VALUE STANDS WHEN
 *     IT DOES NOT ═══
 *
 * This is the existing behaviour of the other writer, stated and tested rather
 * than introduced — `hris-sync.ts` needed no change for it. Its manager pass
 * writes `managerEmployeeId` only for roster rows whose `managerEmail`
 * RESOLVES to somebody in the same roster, and it never writes null. So:
 *
 *   • feed names a manager        → the feed's value replaces whatever is here;
 *   • feed is silent about it     → the value set here survives, indefinitely.
 *
 * The rejected alternative is a stickiness marker (a `managerSource` column)
 * making a manual value outlive the feed permanently. That buys the failure
 * nobody notices: a reorg moves somebody under a new manager, Workday says so
 * every night, and the row keeps pointing at whoever was correct on the day
 * somebody hand-fixed it — so the leaver mail goes to the wrong manager at the
 * one moment it matters, silently.
 *
 * The direction chosen fails the other way, and that way is visible: the
 * manager is on screen in the roster, and this function leaves an
 * `entity_lifecycle` audit row carrying BEFORE and AFTER, so "who last set
 * this, and to what" still has an answer and the correction can be re-applied.
 * It also only bites a tenant that has a feed AND hand-corrects it; the tenant
 * this issue is about has no second speaker at all.
 *
 * Tested both ways in `tests/unit/personnel-manager-update.test.ts`.
 */
export const SetEmployeeManagerSchema = z
    .object({
        /**
         * Null clears the manager — an explicit "reports to nobody", which is
         * a real answer for a founder and the only way to undo a mistake.
         */
        managerEmployeeId: z.string().cuid().nullable(),
    })
    // .strict(), not .strip(): an undeclared field is a 400, not a silent
    // drop. See CreateControlSchema in @/lib/schemas — same reasoning, and
    // here it is also the first of the three rails keeping `status` out.
    .strict();

export async function setEmployeeManager(
    ctx: RequestContext,
    employeeId: string,
    data: z.infer<typeof SetEmployeeManagerSchema>,
) {
    if (!ctx.permissions?.canAdmin && !ctx.appPermissions?.personnel?.manage) {
        throw forbidden('You do not have permission to manage personnel.');
    }
    return runInTenantContext(ctx, async (db) => {
        const employee = await db.employee.findFirst({
            where: { id: employeeId, tenantId: ctx.tenantId },
            select: { id: true, fullName: true, workEmail: true, managerEmployeeId: true },
        });
        if (!employee) throw notFound('Employee not found.');

        const managerEmployeeId = data.managerEmployeeId;
        if (managerEmployeeId !== null) {
            // Self-reference, refused for the reason leaver.ts already refuses
            // to USE one: some feeds encode "reports to nobody" that way, and a
            // worker who is their own manager is a leaver whose offboarding
            // mail is addressed to the mailbox the pass just disabled.
            if (managerEmployeeId === employee.id) {
                throw badRequest('An employee cannot be their own manager.');
            }
            // The FK `Employee.managerEmployeeId → Employee.id` is NOT
            // tenant-scoped — the database would happily accept another
            // tenant's employee id. RLS narrows this read to the caller's
            // tenant, so a foreign id resolves to nothing and is refused here
            // rather than linking an org chart across a tenant boundary.
            const manager = await db.employee.findFirst({
                where: { id: managerEmployeeId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!manager) throw notFound('Manager not found.');
        }

        const updated = await db.employee.update({
            where: { id: employee.id },
            // ONE column. Not a spread of `data` — see rail 2 above.
            data: { managerEmployeeId },
            select: { id: true, fullName: true, workEmail: true, managerEmployeeId: true },
        });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Employee',
            entityId: updated.id,
            details: `Set manager for employee: ${updated.fullName}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Employee',
                operation: 'updated',
                changedFields: ['managerEmployeeId'],
                // BEFORE is what makes a later HRIS overwrite recoverable:
                // the precedence above lets the feed replace this value, and
                // this row is where the replaced one is still written down.
                before: { managerEmployeeId: employee.managerEmployeeId },
                after: { managerEmployeeId: updated.managerEmployeeId },
                summary: `Set manager for employee: ${updated.fullName}`,
            },
        });

        return updated;
    });
}
