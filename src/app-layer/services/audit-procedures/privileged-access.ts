/**
 * PROCEDURE 4 — `iam.privileged_access` (library v1, #3676).
 *
 * Is every privileged account attributable to a current person or a recorded
 * break-glass decision, protected by MFA where the signal exists, and
 * recertified within 90 days? Two sub-populations, each sampled on its own
 * with `/directory` and `/membership` on the epoch; their unit ids carry the
 * same prefixes, so one frozen list and one digest hold both.
 *
 *   directory  PD1 attributable          → PRIVILEGED_UNATTRIBUTED / PRIVILEGED_HOLDER_DEPARTING
 *              PD2 MFA enrolled          → PRIVILEGED_WITHOUT_MFA (google-workspace) /
 *                                          MFA_SIGNAL_AMBIGUOUS (okta, entra-id; untestable) /
 *                                          not applicable (active-directory)
 *              PD3 recertified ≤ 90 days → PRIVILEGE_NOT_RECERTIFIED
 *   membership PM1 recertified ≤ 90 days → PRIVILEGE_NOT_RECERTIFIED
 *              PM2 holder not leaving    → PRIVILEGED_HOLDER_DEPARTING
 *
 * Reads the raw flags and joins. Never the identity providers' `CheckResult`
 * for their MFA or admin checks, nor any `IntegrationExecution.resultJson`.
 *
 * The directory sub-population is a LOWER BOUND: identity sync stores an
 * undetermined `isAdmin` or `mfaEnrolled` as `false`, so a stored `false` is
 * "no" or "not determined", and a `false` MFA reading is evidence only where
 * the provider always determines it. `ADMIN_SIGNAL_ABSENT` refuses a directory
 * that has users and no administrator at all.
 */
import { OBSERVATION_FRESHNESS_MS } from '../../usecases/identity-write-target';
import type { AttributeResult } from '@/lib/agentic/audit-procedure-library';
import { judgeUnit } from '@/lib/agentic/audit-procedure-library';

import {
    emailKey,
    freshConnectionIds,
    IDENTITY_PROVIDERS,
    POPULATION_CAP,
    type PopulationReading,
    type ProcedureModule,
    type ProcedureReadContext,
} from './shared';

export const DIRECTORY_PREFIX = 'directory:';
export const MEMBERSHIP_PREFIX = 'membership:';
const RECERT_WINDOW_MS = 90 * 86_400_000;
const DEPARTING = new Set(['TERMINATED', 'OFFBOARDING']);

export const privilegedAccess: ProcedureModule = {
    async read(rc: ProcedureReadContext): Promise<PopulationReading> {
        const { db, tenantId } = rc;
        const enabledIdentity = await db.integrationConnection.findMany({
            where: { tenantId, isEnabled: true, provider: { in: [...IDENTITY_PROVIDERS] } },
            select: { id: true, provider: true },
            take: POPULATION_CAP,
        });
        const enabledIds = enabledIdentity.map((c) => c.id);
        const [admins, members, signal] = await Promise.all([
            enabledIds.length === 0
                ? Promise.resolve([] as { id: string; connectionId: string }[])
                : db.connectedIdentityAccount.findMany({
                      where: { tenantId, isAdmin: true, status: 'ACTIVE', connectionId: { in: enabledIds } },
                      select: { id: true, connectionId: true },
                      orderBy: { id: 'asc' },
                      take: POPULATION_CAP + 1,
                  }),
            db.tenantMembership.findMany({
                where: { tenantId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                select: { id: true },
                orderBy: { id: 'asc' },
                take: POPULATION_CAP + 1,
            }),
            enabledIds.length === 0
                ? Promise.resolve([] as { connectionId: string; isAdmin: boolean }[])
                : db.connectedIdentityAccount.groupBy({
                      by: ['connectionId', 'isAdmin'],
                      where: { tenantId, status: 'ACTIVE', connectionId: { in: enabledIds } },
                      orderBy: [{ connectionId: 'asc' }, { isAdmin: 'asc' }],
                  }),
        ]);
        const directory = admins.slice(0, POPULATION_CAP).map((a) => `${DIRECTORY_PREFIX}${a.id}`);
        const membership = members.slice(0, POPULATION_CAP).map((m) => `${MEMBERSHIP_PREFIX}${m.id}`);

        return {
            unitIds: [...directory, ...membership],
            subPopulations: { directory, membership },
            truncated:
                admins.length > POPULATION_CAP ||
                members.length > POPULATION_CAP ||
                directory.length + membership.length > POPULATION_CAP,
            populationExceptions: [],
            facts: [`directoryPrivileged=${directory.length}`, `membershipPrivileged=${membership.length}`],
            async preconditions() {
                // A directory with users and no administrator is far more likely
                // an undetermined reading stored as `false` than a fact.
                const withUsers = new Set(signal.map((g) => g.connectionId));
                const withAdmins = new Set(signal.filter((g) => g.isAdmin).map((g) => g.connectionId));
                if ([...withUsers].some((id) => !withAdmins.has(id))) return 'ADMIN_SIGNAL_ABSENT';
                const holding = new Set(admins.map((a) => a.connectionId));
                const conns = enabledIdentity.filter((c) => holding.has(c.id));
                const fresh = await freshConnectionIds(db, tenantId, conns, new Date(rc.now.getTime() - OBSERVATION_FRESHNESS_MS));
                return conns.every((c) => fresh.has(c.id)) ? null : 'SYNC_NOT_FRESH';
            },
            async evaluate(sampled) {
                const recertSince = new Date(rc.periodEnd.getTime() - RECERT_WINDOW_MS);
                const accountIds = sampled.filter((u) => u.startsWith(DIRECTORY_PREFIX)).map((u) => u.slice(DIRECTORY_PREFIX.length));
                const membershipIds = sampled
                    .filter((u) => u.startsWith(MEMBERSHIP_PREFIX))
                    .map((u) => u.slice(MEMBERSHIP_PREFIX.length));

                const [accounts, links, accountDecisions, memberships, memberDecisions] = await Promise.all([
                    accountIds.length === 0
                        ? Promise.resolve([])
                        : db.connectedIdentityAccount.findMany({
                              where: { tenantId, id: { in: accountIds } },
                              select: {
                                  id: true,
                                  provider: true,
                                  mfaEnrolled: true,
                                  isProtected: true,
                                  protectionReason: true,
                              },
                              take: accountIds.length,
                          }),
                    accountIds.length === 0
                        ? Promise.resolve([])
                        : db.identityAccountLink.findMany({
                              where: { tenantId, connectedAccountId: { in: accountIds }, contradictedAt: null },
                              select: { connectedAccountId: true, employee: { select: { status: true } } },
                              take: accountIds.length,
                          }),
                    accountIds.length === 0
                        ? Promise.resolve([])
                        : db.accessReviewConnectedDecision.findMany({
                              where: {
                                  tenantId,
                                  connectedAccountId: { in: accountIds },
                                  decision: { not: null },
                                  accessReview: {
                                      scope: 'CONNECTED_APP',
                                      status: 'CLOSED',
                                      deletedAt: null,
                                      closedAt: { gte: recertSince, lt: rc.periodEnd },
                                  },
                              },
                              select: { connectedAccountId: true },
                              take: POPULATION_CAP,
                          }),
                    membershipIds.length === 0
                        ? Promise.resolve([])
                        : db.tenantMembership.findMany({
                              where: { tenantId, id: { in: membershipIds } },
                              select: { id: true, user: { select: { email: true } } },
                              take: membershipIds.length,
                          }),
                    membershipIds.length === 0
                        ? Promise.resolve([])
                        : db.accessReviewDecision.findMany({
                              where: {
                                  tenantId,
                                  membershipId: { in: membershipIds },
                                  decision: { not: null },
                                  accessReview: {
                                      scope: { in: ['ALL_USERS', 'ADMIN_ONLY'] },
                                      status: 'CLOSED',
                                      deletedAt: null,
                                      closedAt: { gte: recertSince, lt: rc.periodEnd },
                                  },
                              },
                              select: { membershipId: true },
                              take: POPULATION_CAP,
                          }),
                ]);
                const memberEmails = [
                    ...new Set(memberships.map((m) => emailKey(m.user.email)).filter((e): e is string => e !== null)),
                ];
                const employees =
                    memberEmails.length === 0
                        ? []
                        : await db.employee.findMany({
                              where: { tenantId, workEmail: { in: memberEmails, mode: 'insensitive' } },
                              select: { workEmail: true, status: true },
                              take: memberEmails.length * 2,
                          });

                const accountById = new Map(accounts.map((a) => [a.id, a] as const));
                const linkByAccount = new Map(links.map((l) => [l.connectedAccountId, l] as const));
                const recertifiedAccounts = new Set(accountDecisions.map((d) => d.connectedAccountId));
                const membershipById = new Map(memberships.map((m) => [m.id, m] as const));
                const recertifiedMembers = new Set(memberDecisions.map((d) => d.membershipId));
                const employeeByEmail = new Map(employees.map((e) => [emailKey(e.workEmail), e] as const));
                let noRosterMatch = 0;

                const units = sampled.map((unitId) => {
                    const results: AttributeResult[] = [];
                    if (unitId.startsWith(DIRECTORY_PREFIX)) {
                        const id = unitId.slice(DIRECTORY_PREFIX.length);
                        const a = accountById.get(id);
                        if (!a) return judgeUnit(unitId, [{ attribute: 'PD1', result: 'UNTESTABLE', code: 'UNIT_NOT_FOUND' }]);
                        const link = linkByAccount.get(id);
                        if (link) {
                            results.push(
                                DEPARTING.has(link.employee.status)
                                    ? { attribute: 'PD1', result: 'EXCEPTION', code: 'PRIVILEGED_HOLDER_DEPARTING' }
                                    : { attribute: 'PD1', result: 'MET' },
                            );
                        } else if (a.isProtected && (a.protectionReason ?? '').trim().length > 0) {
                            results.push({ attribute: 'PD1', result: 'MET' });
                        } else {
                            results.push({ attribute: 'PD1', result: 'EXCEPTION', code: 'PRIVILEGED_UNATTRIBUTED' });
                        }
                        if (a.mfaEnrolled) results.push({ attribute: 'PD2', result: 'MET' });
                        else if (a.provider === 'google-workspace') {
                            results.push({ attribute: 'PD2', result: 'EXCEPTION', code: 'PRIVILEGED_WITHOUT_MFA' });
                        } else if (a.provider === 'active-directory') {
                            results.push({ attribute: 'PD2', result: 'NOT_APPLICABLE', code: 'MFA_NOT_REPORTED' });
                        } else {
                            results.push({ attribute: 'PD2', result: 'UNTESTABLE', code: 'MFA_SIGNAL_AMBIGUOUS' });
                        }
                        results.push(
                            recertifiedAccounts.has(id)
                                ? { attribute: 'PD3', result: 'MET' }
                                : { attribute: 'PD3', result: 'EXCEPTION', code: 'PRIVILEGE_NOT_RECERTIFIED' },
                        );
                        return judgeUnit(unitId, results);
                    }
                    const id = unitId.slice(MEMBERSHIP_PREFIX.length);
                    const m = membershipById.get(id);
                    if (!m) return judgeUnit(unitId, [{ attribute: 'PM1', result: 'UNTESTABLE', code: 'UNIT_NOT_FOUND' }]);
                    results.push(
                        recertifiedMembers.has(id)
                            ? { attribute: 'PM1', result: 'MET' }
                            : { attribute: 'PM1', result: 'EXCEPTION', code: 'PRIVILEGE_NOT_RECERTIFIED' },
                    );
                    const employee = employeeByEmail.get(emailKey(m.user.email));
                    if (!employee) {
                        noRosterMatch += 1;
                        results.push({ attribute: 'PM2', result: 'NOT_APPLICABLE', code: 'NO_ROSTER_MATCH' });
                    } else {
                        results.push(
                            DEPARTING.has(employee.status)
                                ? { attribute: 'PM2', result: 'EXCEPTION', code: 'PRIVILEGED_HOLDER_DEPARTING' }
                                : { attribute: 'PM2', result: 'MET' },
                        );
                    }
                    return judgeUnit(unitId, results);
                });
                return { units, facts: [`membershipsWithoutRosterMatch=${noRosterMatch}`] };
            },
        };
    },
};
