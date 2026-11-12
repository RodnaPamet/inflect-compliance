/**
 * Test-double support for the deadline monitor's two-sided reads (#5202).
 *
 * The monitor queries each source twice, once for rows coming due
 * (`{ gte: now, lte: horizon }`) and once for rows already overdue
 * (`{ lt: now }`). A `findMany` double that ignores `where` returns its rows to
 * BOTH reads, which no database would. `honourDueRange` applies the range the
 * monitor asked for to whatever the double returned.
 */
const DUE_FIELDS = ['nextDueAt', 'nextReviewAt', 'dueAt', 'targetDate', 'dueDate'] as const;

type Range = { gte?: Date; lte?: Date; lt?: Date };

export function honourDueRange<T>(rows: T[], args: unknown): T[] {
    const where = ((args as { where?: Record<string, unknown> } | undefined)?.where ?? {}) as Record<string, unknown>;
    for (const field of DUE_FIELDS) {
        const range = where[field] as Range | undefined;
        if (!range || typeof range !== 'object' || !('lt' in range || 'gte' in range)) continue;
        return rows.filter((row) => {
            const raw = (row as Record<string, unknown>)[field];
            if (!raw) return false;
            const t = new Date(raw as string | Date).getTime();
            if (range.lt && !(t < range.lt.getTime())) return false;
            if (range.gte && !(t >= range.gte.getTime())) return false;
            if (range.lte && !(t <= range.lte.getTime())) return false;
            return true;
        });
    }
    return rows;
}

/** Wrap a `{ model: { findMany } }` double so every findMany honours the range. */
export function withDueRanges<P extends Record<string, unknown>>(prisma: P): P {
    return new Proxy(prisma, {
        get(target, key) {
            const model = (target as Record<string | symbol, unknown>)[key] as
                | { findMany?: (args: unknown) => Promise<unknown[]> }
                | undefined;
            if (!model || typeof model.findMany !== 'function') return model;
            const findMany = model.findMany;
            return {
                ...model,
                findMany: async (args: unknown) => honourDueRange(await findMany(args), args),
            };
        },
    });
}
