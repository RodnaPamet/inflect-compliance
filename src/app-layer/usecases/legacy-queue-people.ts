/**
 * Who each reconciliation candidate is (#4871).
 *
 * The queue names its candidates by `employeeId`, a database id, and the page
 * printed it in a code font — so "Confirm" asked a reviewer to confirm a match
 * they could not read. This resolves the candidates on one queue page to the
 * name and work email HR holds. It reads the roster and writes nothing: the
 * directory and resolution tables are not touched (invariant 1).
 *
 * @module usecases/legacy-queue-people
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanViewReconciliation } from '../policies/identity-reconciliation';

/** At most this many distinct candidates are resolved for one queue page. */
export const MAX_QUEUE_PEOPLE = 5000;

export interface QueuePerson {
    name: string;
    email: string | null;
}

export async function readQueuePeople(
    ctx: RequestContext,
    rows: ReadonlyArray<{ readonly candidates: ReadonlyArray<{ readonly employeeId: string }> }>,
): Promise<Record<string, QueuePerson>> {
    assertCanViewReconciliation(ctx);
    const ids = [...new Set(rows.flatMap((r) => r.candidates.map((c) => c.employeeId)))].slice(0, MAX_QUEUE_PEOPLE);
    if (ids.length === 0) return {};
    const employees = await runInTenantContext(ctx, (db) =>
        db.employee.findMany({
            where: { tenantId: ctx.tenantId, id: { in: ids } },
            select: { id: true, fullName: true, workEmail: true },
            take: ids.length,
        }),
    );
    const out: Record<string, QueuePerson> = {};
    for (const e of employees) {
        if (e.fullName) out[e.id] = { name: e.fullName, email: e.workEmail || null };
    }
    return out;
}
