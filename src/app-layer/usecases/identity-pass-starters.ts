/**
 * Who each joiner-pass decision is about (#4876).
 *
 * The pass records its per-starter decisions by `employeeId`, which the page
 * used only as a row key: the table showed the intended address and never the
 * person, so an Owner could not tell whether the planned account was right for
 * the person it was planned for. This resolves the ids to the names HR holds.
 *
 * Read on the passes route, which is `admin.tenant_lifecycle` (Owner-only).
 * An employee deleted since resolves to nothing, and the page says so.
 *
 * @module usecases/identity-pass-starters
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';

/** At most this many distinct starters are resolved for one page. */
export const MAX_RESOLVED_STARTERS = 5000;

/** The distinct `employeeId`s named by the decisions in these passes' results. */
export function decisionEmployeeIds(passes: ReadonlyArray<{ resultJson: unknown }>): string[] {
    const ids = new Set<string>();
    for (const pass of passes) {
        const decisions = (pass.resultJson as { decisions?: unknown } | null)?.decisions;
        if (!Array.isArray(decisions)) continue;
        for (const d of decisions) {
            const id = (d as { employeeId?: unknown } | null)?.employeeId;
            if (typeof id === 'string' && id) ids.add(id);
            if (ids.size >= MAX_RESOLVED_STARTERS) return [...ids];
        }
    }
    return [...ids];
}

export async function resolveStarterNames(
    ctx: RequestContext,
    employeeIds: readonly string[],
): Promise<Record<string, string>> {
    const ids = [...new Set(employeeIds)].slice(0, MAX_RESOLVED_STARTERS);
    if (ids.length === 0) return {};
    const rows = await runInTenantContext(ctx, (db) =>
        db.employee.findMany({
            where: { tenantId: ctx.tenantId, id: { in: ids } },
            select: { id: true, fullName: true },
            take: ids.length,
        }),
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
        if (row.fullName) out[row.id] = row.fullName;
    }
    return out;
}
