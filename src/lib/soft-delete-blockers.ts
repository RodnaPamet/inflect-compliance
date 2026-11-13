/**
 * A SOFT DELETE REFUSES WHILE A RESTRICT CHILD EXISTS — #5083, owner decision
 * 2026-11-13.
 *
 * These parents are soft-deleted now and HARD-deleted ninety days later by the
 * `data-lifecycle` sweep. Several of their children sit behind an `ON DELETE
 * RESTRICT` foreign key and are not soft-delete models themselves, so the
 * child is still there when the sweep runs: the DELETE raises SQLSTATE 23503,
 * and before #5509 that one row aborted the platform-wide purge for every
 * tenant, every day.
 *
 * #5509 made the sweep survive it. This is the other half: refuse the delete at
 * the moment somebody asks for it, while there is still a person to tell. The
 * owner chose refusing over cascading, and the reason is the Control edges — a
 * control's test runs, test plans and exceptions are EVIDENCE, and cascading
 * them would destroy a regulatory record to tidy up a deletion. Nothing here
 * ever deletes a child.
 *
 * ═══ THE LIST IS CHECKED, NOT TRUSTED ═══
 *
 * Two of the six edges are RESTRICT by Prisma's DEFAULT rather than by an
 * explicit `onDelete: Restrict` — a required relation with no `onDelete`
 * defaults to Restrict. So a list built by grepping for `onDelete: Restrict`
 * misses `ControlException.control` and `RiskTreatmentPlan.risk`, which are
 * exactly two of the three edges the original report named. That is why
 * `tests/guardrails/soft-delete-blockers-match-the-schema.test.ts` re-derives
 * the set from the schema under Prisma's own rule and holds this map equal to
 * it: a new RESTRICT child, explicit or default, fails CI until it is listed
 * here, rather than silently re-opening the purge crash.
 */

export interface SoftDeleteBlocker {
    /** The child model holding the parent down. */
    readonly model: string;
    /** Its foreign-key scalar onto the parent. */
    readonly fk: string;
    /** What a person should be told this is, in their words. */
    readonly label: string;
}

export const SOFT_DELETE_BLOCKERS: Readonly<Record<string, readonly SoftDeleteBlocker[]>> = {
    Control: [
        { model: 'ControlException', fk: 'controlId', label: 'exception' },
        { model: 'ControlTestPlan', fk: 'controlId', label: 'test plan' },
        { model: 'ControlTestRun', fk: 'controlId', label: 'test run' },
    ],
    Risk: [{ model: 'RiskTreatmentPlan', fk: 'riskId', label: 'treatment plan' }],
    Vendor: [
        { model: 'PeerAgent', fk: 'vendorId', label: 'A2A peer' },
        { model: 'RegisteredAgent', fk: 'vendorId', label: 'registered agent' },
    ],
};

/** A delegate shape narrow enough that any client satisfies it. */
interface CountDelegate {
    count(args: { where: Record<string, unknown> }): Promise<number>;
}

/**
 * What still points at this parent, counted per child model.
 *
 * One `count` per blocking edge — at most three — and only for the models that
 * can block, rather than a probe of every relation. The caller is inside the
 * tenant transaction already, so these counts are RLS-scoped like everything
 * else.
 */
export async function findSoftDeleteBlockers(
    db: unknown,
    parentModel: string,
    parentId: string,
): Promise<Array<{ blocker: SoftDeleteBlocker; count: number }>> {
    const edges = SOFT_DELETE_BLOCKERS[parentModel] ?? [];
    const found: Array<{ blocker: SoftDeleteBlocker; count: number }> = [];
    for (const blocker of edges) {
        const key = blocker.model.charAt(0).toLowerCase() + blocker.model.slice(1);
        const delegate = (db as Record<string, CountDelegate | undefined>)[key];
        // A missing delegate is NOT treated as "nothing blocks": a client that
        // cannot see the model cannot vouch for it either, and reading absence
        // as zero is how a refusal quietly stops refusing.
        if (!delegate) {
            throw new Error(
                `findSoftDeleteBlockers: no delegate for ${blocker.model} — cannot establish `
                    + `whether it blocks ${parentModel} ${parentId}`,
            );
        }
        const count = await delegate.count({ where: { [blocker.fk]: parentId } });
        if (count > 0) found.push({ blocker, count });
    }
    return found;
}

interface GroupDelegate {
    findMany(args: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>>;
}

/**
 * Which of these parents are blocked, for a BULK delete.
 *
 * One query per blocking EDGE (at most three), never one per parent: the loop
 * is over child models, whose number is fixed by the schema, so the query count
 * does not grow with the selection. A per-parent probe would be an N+1 on a
 * path a person can point at fifty rows.
 */
export async function findBlockedParents(
    db: unknown,
    parentModel: string,
    parentIds: readonly string[],
): Promise<Map<string, SoftDeleteBlocker[]>> {
    const blocked = new Map<string, SoftDeleteBlocker[]>();
    if (parentIds.length === 0) return blocked;

    for (const blocker of SOFT_DELETE_BLOCKERS[parentModel] ?? []) {
        const key = blocker.model.charAt(0).toLowerCase() + blocker.model.slice(1);
        const delegate = (db as Record<string, GroupDelegate | undefined>)[key];
        if (!delegate) {
            throw new Error(
                `findBlockedParents: no delegate for ${blocker.model} — cannot establish `
                    + `whether it blocks ${parentModel}`,
            );
        }
        const rows = await delegate.findMany({
            where: { [blocker.fk]: { in: [...parentIds] } },
            select: { [blocker.fk]: true },
        });
        for (const row of rows) {
            const id = row[blocker.fk];
            if (typeof id !== 'string') continue;
            const list = blocked.get(id) ?? [];
            if (!list.some((b) => b.model === blocker.model)) list.push(blocker);
            blocked.set(id, list);
        }
    }
    return blocked;
}

/**
 * The sentence a person reads, naming WHAT blocks and HOW MANY.
 *
 * Named rather than generic because "cannot delete" with no reason sends
 * somebody to support; the counts tell them where to look. No ids: this
 * string reaches an API response.
 */
export function softDeleteBlockedMessage(
    parentLabel: string,
    found: Array<{ blocker: SoftDeleteBlocker; count: number }>,
): string {
    const parts = found.map(
        ({ blocker, count }) => `${count} ${blocker.label}${count === 1 ? '' : 's'}`,
    );
    return (
        `This ${parentLabel} still has ${parts.join(' and ')}, which are kept as a record and `
        + `are never deleted with it. Remove or reassign them first, or keep the ${parentLabel}.`
    );
}

/**
 * The bulk sentence: how many were refused and what holds them.
 *
 * All-or-nothing, which is why this names a COUNT of parents rather than
 * reporting a partial success. A bulk delete that silently did some of what
 * was asked would leave the caller guessing which, and the alternative —
 * changing the result shape to report skips — is a bigger change than the
 * refusal warrants while the children are kept deliberately.
 */
export function bulkSoftDeleteBlockedMessage(
    parentLabelPlural: string,
    blocked: Map<string, SoftDeleteBlocker[]>,
): string {
    const labels = [
        ...new Set([...blocked.values()].flat().map((b) => b.label)),
    ].sort();
    return (
        `${blocked.size} of the selected ${parentLabelPlural} still have records that are kept `
        + `and never deleted with them (${labels.join(', ')}). Nothing was deleted. Deselect `
        + `those ${parentLabelPlural}, or remove the records first.`
    );
}
