/**
 * The pre-hire surface — #2715. Owner decision 2.
 *
 * A PRE-HIRE IS NOT AN EMPLOYEE WITH MISSING FIELDS. It is a person the HRIS
 * has hired and not yet given a mailbox, and that distinction is the whole
 * design: modelling it as its own row with its own pending state is what keeps
 * `Employee.workEmail` NOT NULL and its `@@unique([tenantId, workEmail])`
 * intact. That key is what the idempotent HRIS upsert addresses rows by.
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT is a DUPLICATE EMPLOYEE ROW. If
 * this product wrote `Employee.workEmail` directly, the next HRIS upsert would
 * look for the person by `(tenantId, workEmail)`, miss — because the roster
 * still reports no address — and INSERT a second row for the same human. The
 * address reaches the system of record through the HRIS write-back (#2716),
 * never through this product writing the column.
 *
 * RECONCILIATION MATCHES ON `externalId`, NOT ON EMAIL AND NOT ON NAME. The
 * email is the thing that does not exist yet, which is the entire premise; a
 * name is neither unique nor stable. The HRIS's own identifier is the only
 * anchor that survives the window this model covers.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';

export interface RecordPreHireInput {
    readonly externalId: string;
    readonly fullName: string;
    readonly department?: string | null;
    readonly startDate?: Date | null;
}

export interface PreHireRow {
    readonly id: string;
    readonly externalId: string;
    readonly fullName: string;
    readonly department: string | null;
    readonly startDate: Date | null;
    readonly intendedAddress: string | null;
    readonly status: 'PENDING' | 'RECONCILED' | 'CANCELLED';
    readonly reconciledEmployeeId: string | null;
}

/**
 * Record a pre-hire, or refresh the one already recorded.
 *
 * Idempotent on `(tenantId, externalId)` — the same key the unique index
 * enforces — so a roster re-read cannot create a second row for one person.
 */
export async function recordPreHire(
    ctx: RequestContext,
    input: RecordPreHireInput,
): Promise<PreHireRow> {
    return runInTenantContext(ctx, async (db) => {
        const row = await db.preHire.upsert({
            where: {
                tenantId_externalId: { tenantId: ctx.tenantId, externalId: input.externalId },
            },
            create: {
                tenantId: ctx.tenantId,
                externalId: input.externalId,
                fullName: input.fullName,
                department: input.department ?? null,
                startDate: input.startDate ?? null,
            },
            // A refresh must NOT resurrect a reconciled or cancelled row into
            // PENDING: the roster re-reporting someone does not un-hire them.
            update: {
                fullName: input.fullName,
                department: input.department ?? null,
                startDate: input.startDate ?? null,
            },
        });
        return row as PreHireRow;
    });
}

/** Everyone still waiting on an address. */
export async function listPendingPreHires(ctx: RequestContext): Promise<readonly PreHireRow[]> {
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.preHire.findMany({
            where: { tenantId: ctx.tenantId, status: 'PENDING' },
            orderBy: { startDate: 'asc' },
        });
        return rows as PreHireRow[];
    });
}

export type ReconcileOutcome =
    | { readonly kind: 'RECONCILED'; readonly preHireId: string; readonly employeeId: string }
    /** No `Employee` carries this `externalId` yet — the normal pending state. */
    | { readonly kind: 'NOT_YET'; readonly preHireId: string }
    /** Already reconciled. Idempotent, not an error. */
    | { readonly kind: 'ALREADY'; readonly preHireId: string; readonly employeeId: string };

/**
 * Reconcile a pre-hire to the `Employee` the HRIS now carries.
 *
 * READ-ONLY WITH RESPECT TO `Employee`. This function never creates, never
 * updates and never touches `workEmail`. It finds the employee the ordinary
 * HRIS sync already created and records the link on the PRE-HIRE side. That
 * asymmetry is deliberate: every write stays on the row this product owns, so
 * there is no path here that can collide with the ingest's
 * `(tenantId, workEmail)` upsert key.
 */
export async function reconcilePreHire(
    ctx: RequestContext,
    preHireId: string,
): Promise<ReconcileOutcome> {
    return runInTenantContext(ctx, async (db) => {
        const pre = await db.preHire.findFirst({
            where: { id: preHireId, tenantId: ctx.tenantId },
        });
        if (!pre) throw new Error(`No pre-hire ${preHireId} in this tenant`);

        if (pre.status === 'RECONCILED' && pre.reconciledEmployeeId) {
            return {
                kind: 'ALREADY',
                preHireId: pre.id,
                employeeId: pre.reconciledEmployeeId,
            } as const;
        }

        // Matched on externalId — see the module docblock for why not email.
        const employee = await db.employee.findFirst({
            where: { tenantId: ctx.tenantId, externalId: pre.externalId },
            select: { id: true },
        });
        if (!employee) return { kind: 'NOT_YET', preHireId: pre.id } as const;

        await db.preHire.update({
            where: { id: pre.id },
            data: {
                status: 'RECONCILED',
                reconciledEmployeeId: employee.id,
                reconciledAt: new Date(),
            },
        });
        return { kind: 'RECONCILED', preHireId: pre.id, employeeId: employee.id } as const;
    });
}
