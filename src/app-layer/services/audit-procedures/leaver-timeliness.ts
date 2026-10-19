/**
 * PROCEDURE 1 — `iam.leaver_timeliness` (library v1, #3676).
 *
 * Was every directory account of a person who left disabled within the leaver
 * window? Re-performed from `Employee`, `IdentityAccountLink`,
 * `ConnectedIdentityAccount`, `IdentityWriteJournal` and `IntegrationExecution`
 * (the sync freshness rows). It never reads the leaver pass's
 * `IntegrationExecution.resultJson`, the personnel check's `CheckResult`, or
 * any count the leaver pass logged.
 *
 *   L1  the account is not ACTIVE                → LEAVER_ACCOUNT_ACTIVE
 *   L2  the disable has a recorded time          → DISABLE_TIME_UNKNOWN /
 *                                                  WRITE_OUTCOME_UNKNOWN (untestable)
 *   L3  the disable was inside the window        → LEAVER_DISABLED_LATE
 *
 * Population-level: a TERMINATED employee with no `endDate` who still holds an
 * ACTIVE considered account is LEAVER_ACCOUNT_ACTIVE_UNDATED, on every run.
 * Such an exception makes the population not empty: it FAILs on its own.
 */
import { OBSERVATION_FRESHNESS_MS } from '../../usecases/identity-write-target';
import type { AttributeResult } from '@/lib/agentic/audit-procedure-library';
import { judgeUnit } from '@/lib/agentic/audit-procedure-library';
import type { PrismaTx } from '@/lib/db-context';

import {
    emailKey,
    freshConnectionIds,
    groupBy,
    POPULATION_CAP,
    type PopulationReading,
    type ProcedureModule,
    type ProcedureReadContext,
} from './shared';

/** Links and accounts read for one batch of employees: a person may hold several. */
const ACCOUNT_READ_CAP = POPULATION_CAP * 4;

interface Leaver {
    id: string;
    workEmail: string;
    endDate: Date | null;
}

interface Account {
    id: string;
    provider: string;
    externalUserId: string;
    email: string;
    status: string;
    connectionId: string;
}

interface Considered {
    /** Per employee, the accounts considered: on enabled connections, through an uncontradicted link or the email join. */
    byEmployee: Map<string, Account[]>;
    /** Each considered account's link id, when it has one (an account has at most one). */
    linkIdOf: Map<string, string>;
    connections: { id: string; provider: string }[];
    excludedDisabledConnection: number;
    contradictedLinks: number;
    truncated: boolean;
}

/**
 * The accounts considered for each employee, as the catalogue joins them:
 * through an `IdentityAccountLink` with `contradictedAt` null, together with
 * any account whose email equals the employee's `workEmail` ignoring case.
 * Accounts on a disabled connection, which no sync observes, are excluded and
 * counted; so are contradicted links. Protected accounts are included:
 * protection explains why the leaver pass skipped an account, it does not make
 * lingering access timely.
 */
async function consideredAccounts(db: PrismaTx, tenantId: string, employees: readonly Leaver[]): Promise<Considered> {
    if (employees.length === 0) {
        return {
            byEmployee: new Map(),
            linkIdOf: new Map(),
            connections: [],
            excludedDisabledConnection: 0,
            contradictedLinks: 0,
            truncated: false,
        };
    }
    const employeeIds = employees.map((e) => e.id);
    const emails = [...new Set(employees.map((e) => emailKey(e.workEmail)).filter((e): e is string => e !== null))];

    const [links, byEmail] = await Promise.all([
        db.identityAccountLink.findMany({
            where: { tenantId, employeeId: { in: employeeIds } },
            select: { id: true, employeeId: true, connectedAccountId: true, contradictedAt: true },
            take: ACCOUNT_READ_CAP + 1,
        }),
        emails.length === 0
            ? Promise.resolve([] as Account[])
            : db.connectedIdentityAccount.findMany({
                  where: { tenantId, email: { in: emails, mode: 'insensitive' } },
                  select: { id: true, provider: true, externalUserId: true, email: true, status: true, connectionId: true },
                  take: ACCOUNT_READ_CAP + 1,
              }),
    ]);
    const liveLinks = links.filter((l) => l.contradictedAt === null);
    const linkedAccounts =
        liveLinks.length === 0
            ? []
            : await db.connectedIdentityAccount.findMany({
                  where: { tenantId, id: { in: liveLinks.map((l) => l.connectedAccountId) } },
                  select: { id: true, provider: true, externalUserId: true, email: true, status: true, connectionId: true },
                  take: ACCOUNT_READ_CAP + 1,
              });

    const accountById = new Map<string, Account>();
    for (const a of [...linkedAccounts, ...byEmail]) accountById.set(a.id, a);

    // Every considered account's link, wherever it points: L2 matches the
    // journal on it, and an account has at most one (`connectedAccountId` is unique).
    const allAccountIds = [...accountById.keys()];
    const accountLinks =
        allAccountIds.length === 0
            ? []
            : await db.identityAccountLink.findMany({
                  where: { tenantId, connectedAccountId: { in: allAccountIds } },
                  select: { id: true, connectedAccountId: true },
                  take: allAccountIds.length,
              });

    const connectionIds = [...new Set([...accountById.values()].map((a) => a.connectionId))];
    const connections =
        connectionIds.length === 0
            ? []
            : await db.integrationConnection.findMany({
                  where: { tenantId, id: { in: connectionIds } },
                  select: { id: true, provider: true, isEnabled: true },
                  take: connectionIds.length,
              });
    const enabled = new Set(connections.filter((c) => c.isEnabled).map((c) => c.id));

    const linksByEmployee = groupBy(liveLinks, (l) => l.employeeId);
    const byEmailKey = groupBy(byEmail, (a) => emailKey(a.email) ?? '');
    const byEmployee = new Map<string, Account[]>();
    let excluded = 0;
    for (const e of employees) {
        const seen = new Map<string, Account>();
        for (const l of linksByEmployee.get(e.id) ?? []) {
            const a = accountById.get(l.connectedAccountId);
            if (a) seen.set(a.id, a);
        }
        const k = emailKey(e.workEmail);
        for (const a of k ? (byEmailKey.get(k) ?? []) : []) seen.set(a.id, a);
        const kept = [...seen.values()].filter((a) => enabled.has(a.connectionId));
        excluded += seen.size - kept.length;
        byEmployee.set(e.id, kept);
    }

    return {
        byEmployee,
        linkIdOf: new Map(accountLinks.map((l) => [l.connectedAccountId, l.id] as const)),
        connections: connections.filter((c) => c.isEnabled).map((c) => ({ id: c.id, provider: c.provider })),
        excludedDisabledConnection: excluded,
        contradictedLinks: links.length - liveLinks.length,
        truncated:
            links.length > ACCOUNT_READ_CAP ||
            byEmail.length > ACCOUNT_READ_CAP ||
            linkedAccounts.length > ACCOUNT_READ_CAP,
    };
}

export const leaverTimeliness: ProcedureModule = {
    async read(rc: ProcedureReadContext): Promise<PopulationReading> {
        const { db, tenantId } = rc;
        const [dated, undated] = await Promise.all([
            db.employee.findMany({
                where: { tenantId, status: 'TERMINATED', endDate: { gte: rc.periodStart, lt: rc.periodEnd } },
                select: { id: true, workEmail: true, endDate: true },
                orderBy: { id: 'asc' },
                take: POPULATION_CAP + 1,
            }),
            db.employee.findMany({
                where: { tenantId, status: 'TERMINATED', endDate: null },
                select: { id: true, workEmail: true, endDate: true },
                orderBy: { id: 'asc' },
                take: POPULATION_CAP + 1,
            }),
        ]);
        const truncatedRead = dated.length > POPULATION_CAP || undated.length > POPULATION_CAP;
        const considered = truncatedRead
            ? null
            : await consideredAccounts(db, tenantId, [...dated, ...undated]);

        // The population-level check: an undated leaver still holding an ACTIVE
        // account is an exception whatever the date — HR has marked them gone.
        const populationExceptions = (considered ? undated : [])
            .filter((e) => (considered?.byEmployee.get(e.id) ?? []).some((a) => a.status === 'ACTIVE'))
            .map((e) => ({ unitId: e.id, code: 'LEAVER_ACCOUNT_ACTIVE_UNDATED' }));

        const facts = considered
            ? [
                  `undatedLeavers=${undated.length}`,
                  `accountsOnDisabledConnections=${considered.excludedDisabledConnection}`,
                  `contradictedLinks=${considered.contradictedLinks}`,
              ]
            : [];

        return {
            unitIds: dated.slice(0, POPULATION_CAP).map((e) => e.id),
            truncated: truncatedRead || (considered?.truncated ?? false),
            populationExceptions,
            facts,
            async preconditions() {
                // SYNC_NOT_FRESH over every enabled connection holding a
                // considered account of the population, dated or not.
                const conns = considered?.connections ?? [];
                const fresh = await freshConnectionIds(
                    db,
                    tenantId,
                    conns,
                    new Date(rc.now.getTime() - OBSERVATION_FRESHNESS_MS),
                );
                return conns.every((c) => fresh.has(c.id)) ? null : 'SYNC_NOT_FRESH';
            },
            async evaluate(sampled) {
                const windowHours = rc.parameters.leaverWindowHours;
                const employees = await db.employee.findMany({
                    where: { tenantId, id: { in: [...sampled] } },
                    select: { id: true, workEmail: true, endDate: true, status: true },
                    take: sampled.length,
                });
                const c = await consideredAccounts(db, tenantId, employees);
                const accounts = [...c.byEmployee.values()].flat();
                const linkIds = accounts.map((a) => c.linkIdOf.get(a.id)).filter((id): id is string => !!id);
                const journal =
                    accounts.length === 0
                        ? []
                        : await db.identityWriteJournal.findMany({
                              where: {
                                  tenantId,
                                  action: 'DISABLE_ACCOUNT',
                                  OR: [
                                      ...(linkIds.length > 0 ? [{ linkId: { in: linkIds } }] : []),
                                      { linkId: null, externalUserId: { in: accounts.map((a) => a.externalUserId) } },
                                  ],
                              },
                              select: { linkId: true, provider: true, externalUserId: true, outcome: true, settledAt: true },
                              take: ACCOUNT_READ_CAP,
                          });
                const employeeById = new Map(employees.map((e) => [e.id, e] as const));

                const units = sampled.map((unitId) => {
                    const e = employeeById.get(unitId);
                    if (!e) {
                        return judgeUnit(unitId, [{ attribute: 'L1', result: 'UNTESTABLE', code: 'UNIT_NOT_FOUND' }]);
                    }
                    const results: AttributeResult[] = [];
                    for (const a of c.byEmployee.get(e.id) ?? []) {
                        if (a.status === 'ACTIVE') {
                            results.push({ attribute: 'L1', result: 'EXCEPTION', code: 'LEAVER_ACCOUNT_ACTIVE' });
                            continue;
                        }
                        results.push({ attribute: 'L1', result: 'MET' });
                        const linkId = c.linkIdOf.get(a.id) ?? null;
                        const rows = journal.filter((j) =>
                            j.linkId !== null
                                ? j.linkId === linkId
                                : j.provider === a.provider && j.externalUserId === a.externalUserId,
                        );
                        const applied = rows
                            .filter((j) => j.outcome === 'APPLIED' && j.settledAt !== null)
                            .map((j) => (j.settledAt as Date).getTime());
                        if (applied.length === 0) {
                            const unsettled = rows.some((j) => j.outcome === 'PENDING' || j.outcome === 'INDETERMINATE');
                            results.push({
                                attribute: 'L2',
                                result: 'UNTESTABLE',
                                code: unsettled ? 'WRITE_OUTCOME_UNKNOWN' : 'DISABLE_TIME_UNKNOWN',
                            });
                            continue;
                        }
                        results.push({ attribute: 'L2', result: 'MET' });
                        // The disable that put the account where it is now: the latest.
                        const disabledAt = Math.max(...applied);
                        if (e.endDate === null) {
                            results.push({ attribute: 'L3', result: 'UNTESTABLE', code: 'END_DATE_REMOVED' });
                        } else if (disabledAt - e.endDate.getTime() > windowHours * 3_600_000) {
                            results.push({ attribute: 'L3', result: 'EXCEPTION', code: 'LEAVER_DISABLED_LATE' });
                        } else {
                            results.push({ attribute: 'L3', result: 'MET' });
                        }
                    }
                    if (results.length === 0) {
                        results.push({ attribute: 'L1', result: 'NOT_APPLICABLE', code: 'NO_CONSIDERED_ACCOUNT' });
                    }
                    return judgeUnit(unitId, results);
                });
                return {
                    units,
                    facts: [`sampledAccountsConsidered=${accounts.length}`],
                };
            },
        };
    },
};
