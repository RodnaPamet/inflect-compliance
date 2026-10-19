/**
 * PROCEDURE 3 — `iam.time_bounded_access_expiry` (library v1, #3676).
 *
 * Did every time-bounded grant Inflect made end when it said it would? The
 * unit is one `ExternalWriteJournal` row of a grant tool (`GRANT_EXPIRY_ARGS`).
 *
 *   T1 the grant was bounded            → END_DATE_UNREADABLE / GRANT_UNBOUNDED
 *   T2 delivery is known                → DELIVERY_UNCONFIRMED (untestable)
 *   T3 it ended and was never seen live past its end
 *                                       → GRANT_OUTLIVED_WINDOW /
 *                                         EXPIRY_NOT_OBSERVED (untestable)
 *   T4 an outlived grant was followed up → OUTLIVED_GRANT_NOT_TASKED
 *
 * The end date is RE-PARSED from the journalled arguments (decrypted on read,
 * which is why the period filter runs in memory, as `verifyGrantExpiry` does)
 * and the bound recomputed against `MAX_GRANT_DAYS`. It never reads the
 * `endDateTime` or `overdueDays` a remediation task copied into its
 * `metadataJson`: the task is read only for WHETHER one exists (T4).
 *
 * The procedure runs no earlier than 24 hours after the period ends
 * (`PERIOD_NOT_SETTLED`), so a grant ending in the period's last minute has
 * been through the expiry sweep. An empty population is the common case for a
 * tenant that makes no time-bounded grants, and it is INCONCLUSIVE.
 */
import { GRANT_EXPIRY_ARGS } from '../../usecases/external-write-reconcile';
import { MAX_GRANT_DAYS } from '../../integrations/providers/entra-id/entitlement';
import type { AttributeResult } from '@/lib/agentic/audit-procedure-library';
import { judgeUnit } from '@/lib/agentic/audit-procedure-library';
import { periodBounds } from '@/lib/agentic/audit-workpaper';

import { POPULATION_CAP, type PopulationReading, type ProcedureModule, type ProcedureReadContext } from './shared';

const DAY_MS = 86_400_000;
/** Rows read for the window, one past the cap: the population is a subset of the read. */
const JOURNAL_READ_CAP = POPULATION_CAP;
const DELIVERY_OUTCOMES = ['APPLIED', 'ACCEPTED', 'INDETERMINATE'] as const;

/** The end date a grant's journalled arguments name, or null when it does not parse. */
export function grantEndDate(advertisedToolName: string, argumentsJson: string): Date | null {
    const field = GRANT_EXPIRY_ARGS.get(advertisedToolName);
    if (!field) return null;
    try {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        const raw = args[field];
        const parsed = typeof raw === 'string' ? new Date(raw) : null;
        return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    } catch {
        return null;
    }
}

/** Is the grant inside its bound: an end date that parses, at most MAX_GRANT_DAYS after the attempt? */
export function grantBounded(endDate: Date | null, attemptedAt: Date): boolean {
    return endDate !== null && endDate.getTime() - attemptedAt.getTime() <= MAX_GRANT_DAYS * DAY_MS;
}

/**
 * The period a row is tested in: its end date's, when that parses and is
 * within the bound; otherwise its `attemptedAt`'s, so a grant that breached
 * its bound is still tested once.
 */
function placedInPeriod(endDate: Date | null, attemptedAt: Date, start: Date, end: Date): boolean {
    const at = grantBounded(endDate, attemptedAt) ? (endDate as Date) : attemptedAt;
    return at.getTime() >= start.getTime() && at.getTime() < end.getTime();
}

export const timeBoundedAccessExpiry: ProcedureModule = {
    async read(rc: ProcedureReadContext): Promise<PopulationReading> {
        const { db, tenantId } = rc;
        const { start, end } = periodBounds(rc.periodLabel);
        const keys = [...GRANT_EXPIRY_ARGS.keys()];
        // Every row either rule can place in the period: attempted from
        // MAX_GRANT_DAYS before the period start to the period end.
        const rows = await db.externalWriteJournal.findMany({
            where: {
                tenantId,
                advertisedToolName: { in: keys },
                outcome: { in: [...DELIVERY_OUTCOMES] },
                attemptedAt: { gte: new Date(start.getTime() - MAX_GRANT_DAYS * DAY_MS), lt: end },
            },
            select: { id: true, advertisedToolName: true, argumentsJson: true, attemptedAt: true },
            orderBy: { id: 'asc' },
            take: JOURNAL_READ_CAP + 1,
        });
        const inPeriod = rows
            .slice(0, JOURNAL_READ_CAP)
            .filter((r) => placedInPeriod(grantEndDate(r.advertisedToolName, r.argumentsJson), r.attemptedAt, start, end));

        return {
            unitIds: inPeriod.map((r) => r.id),
            truncated: rows.length > JOURNAL_READ_CAP,
            populationExceptions: [],
            facts: [`grantToolsInScope=${keys.sort().join('|')}`, `journalRowsInWindow=${Math.min(rows.length, JOURNAL_READ_CAP)}`],
            async preconditions() {
                return null;
            },
            async evaluate(sampled) {
                const journal = await db.externalWriteJournal.findMany({
                    where: { tenantId, id: { in: [...sampled] } },
                    select: {
                        id: true,
                        advertisedToolName: true,
                        argumentsJson: true,
                        attemptedAt: true,
                        outcome: true,
                        expiryVerifiedAt: true,
                        expiryRaisedAt: true,
                    },
                    take: sampled.length,
                });
                // T4 asks only whether a GRANT_EXPIRY task names the row. The
                // copies of the end date in its metadata are never read.
                const raised = journal.filter((r) => r.expiryRaisedAt !== null).map((r) => r.id);
                const tasks =
                    raised.length === 0
                        ? []
                        : await db.task.findMany({
                              where: { tenantId, source: 'GRANT_EXPIRY', deletedAt: null },
                              select: { metadataJson: true },
                              take: POPULATION_CAP,
                          });
                const tasked = new Set(
                    tasks
                        .map((t) => (t.metadataJson as { externalWriteJournalId?: unknown } | null)?.externalWriteJournalId)
                        .filter((v): v is string => typeof v === 'string'),
                );
                const byId = new Map(journal.map((r) => [r.id, r] as const));

                const units = sampled.map((unitId) => {
                    const row = byId.get(unitId);
                    if (!row) return judgeUnit(unitId, [{ attribute: 'T1', result: 'UNTESTABLE', code: 'UNIT_NOT_FOUND' }]);
                    const results: AttributeResult[] = [];
                    const endDate = grantEndDate(row.advertisedToolName, row.argumentsJson);
                    if (endDate === null) {
                        results.push({ attribute: 'T1', result: 'EXCEPTION', code: 'END_DATE_UNREADABLE' });
                    } else if (!grantBounded(endDate, row.attemptedAt)) {
                        results.push({ attribute: 'T1', result: 'EXCEPTION', code: 'GRANT_UNBOUNDED' });
                    } else {
                        results.push({ attribute: 'T1', result: 'MET' });
                    }
                    results.push(
                        row.outcome === 'APPLIED'
                            ? { attribute: 'T2', result: 'MET' }
                            : { attribute: 'T2', result: 'UNTESTABLE', code: 'DELIVERY_UNCONFIRMED' },
                    );
                    if (row.expiryRaisedAt !== null) {
                        // Seen live past its end date: an exception whatever happened later.
                        results.push({ attribute: 'T3', result: 'EXCEPTION', code: 'GRANT_OUTLIVED_WINDOW' });
                        results.push(
                            tasked.has(row.id)
                                ? { attribute: 'T4', result: 'MET' }
                                : { attribute: 'T4', result: 'EXCEPTION', code: 'OUTLIVED_GRANT_NOT_TASKED' },
                        );
                    } else if (row.expiryVerifiedAt !== null) {
                        results.push({ attribute: 'T3', result: 'MET' });
                        results.push({ attribute: 'T4', result: 'NOT_APPLICABLE', code: 'GRANT_NOT_OUTLIVED' });
                    } else {
                        results.push({ attribute: 'T3', result: 'UNTESTABLE', code: 'EXPIRY_NOT_OBSERVED' });
                    }
                    return judgeUnit(unitId, results);
                });
                return { units, facts: [`remediationTasksRead=${tasks.length}`] };
            },
        };
    },
};
