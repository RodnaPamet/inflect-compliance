/**
 * PROCEDURE 2 — `iam.recertification_completeness` (library v1, #3676).
 *
 * Was every population that must be recertified covered in the quarter by a
 * complete, closed campaign whose revocations took effect? The units are the
 * review populations (memberships, each enabled identity connection holding an
 * ACTIVE account, each enabled legacy application holding a COMPLETE snapshot),
 * and the WHOLE population is tested: there are as few units as connections.
 *
 *   R1 a covering campaign exists                 → NOT_RECERTIFIED_IN_PERIOD
 *   R2 it is non-empty and fully decided          → CAMPAIGN_INCOMPLETE
 *   R3 it covered its whole population            → CAMPAIGN_TRUNCATED
 *   R4 it closed on time                          → CLOSED_AFTER_DUE
 *   R5 nobody decided their own access            → SELF_REVIEW
 *   R6 revocations took effect                    → REVOCATION_NOT_EXECUTED /
 *                                                   REVOKED_ACCESS_STILL_ACTIVE /
 *                                                   NO_OBSERVATION_AFTER_CLOSE (untestable)
 *   R7 the close produced its evidence            → EVIDENCE_NOT_GENERATED
 *
 * Re-performed from the decision rows, the membership rows, the directory
 * mirror and the legacy snapshots. NEVER from `executedAt`, which the close
 * stamps on every decided row "regardless of outcome" — including a
 * `SKIPPED_LAST_OWNER` where nothing changed — and never from the `snapshotCount`
 * or `executed` figures in the campaign's audit rows, or its evidence PDF.
 * R2 is written `subjectCount > 0 && decided === subjectCount`, never
 * `decided === subjectCount`, which is true of an empty campaign.
 */
import type { AttributeResult, UnitJudgement } from '@/lib/agentic/audit-procedure-library';
import { judgeUnit } from '@/lib/agentic/audit-procedure-library';

import {
    emailKey,
    groupBy,
    IDENTITY_PROVIDERS,
    POPULATION_CAP,
    syncAutomationKey,
    type PopulationReading,
    type ProcedureModule,
    type ProcedureReadContext,
} from './shared';

const MEMBERSHIPS_UNIT = 'memberships';
const CONNECTION_PREFIX = 'connection:';
const LEGACY_PREFIX = 'legacy:';
/** The most campaigns closed in one quarter this read considers. */
const CAMPAIGN_CAP = 500;
/** Decision rows across the covering campaigns: MAX_SUBJECTS per campaign, many campaigns. */
const DECISION_CAP = POPULATION_CAP * 10;
const DAY_MS = 86_400_000;

type Scope = 'ALL_USERS' | 'CONNECTED_APP' | 'LEGACY_APP';

interface Campaign {
    id: string;
    scope: Scope;
    closedAt: Date;
    dueAt: Date | null;
    snapshotTruncated: boolean;
    evidenceFileRecordId: string | null;
}

export const recertificationCompleteness: ProcedureModule = {
    async read(rc: ProcedureReadContext): Promise<PopulationReading> {
        const { db, tenantId } = rc;
        const [activeMemberships, identityConns, legacyConns] = await Promise.all([
            db.tenantMembership.count({ where: { tenantId, status: 'ACTIVE' } }),
            db.integrationConnection.findMany({
                where: { tenantId, isEnabled: true, provider: { in: [...IDENTITY_PROVIDERS] } },
                select: { id: true, provider: true },
                orderBy: { id: 'asc' },
                take: POPULATION_CAP + 1,
            }),
            db.integrationConnection.findMany({
                where: { tenantId, isEnabled: true, provider: 'legacy-mcp' },
                select: { id: true },
                orderBy: { id: 'asc' },
                take: POPULATION_CAP + 1,
            }),
        ]);
        const [withActive, withSnapshot] = await Promise.all([
            identityConns.length === 0
                ? Promise.resolve([] as { connectionId: string }[])
                : db.connectedIdentityAccount.groupBy({
                      by: ['connectionId'],
                      where: { tenantId, status: 'ACTIVE', connectionId: { in: identityConns.map((c) => c.id) } },
                      orderBy: { connectionId: 'asc' },
                  }),
            legacyConns.length === 0
                ? Promise.resolve([] as { connectionId: string }[])
                : db.legacyAccessSnapshot.groupBy({
                      by: ['connectionId'],
                      where: { tenantId, status: 'COMPLETE', connectionId: { in: legacyConns.map((c) => c.id) } },
                      orderBy: { connectionId: 'asc' },
                  }),
        ]);

        const unitIds = [
            ...(activeMemberships > 0 ? [MEMBERSHIPS_UNIT] : []),
            ...withActive.map((r) => `${CONNECTION_PREFIX}${r.connectionId}`),
            ...withSnapshot.map((r) => `${LEGACY_PREFIX}${r.connectionId}`),
        ];
        const providerOf = new Map(identityConns.map((c) => [c.id, c.provider] as const));
        const quarterEnd = rc.periodEnd;

        return {
            unitIds,
            truncated:
                identityConns.length > POPULATION_CAP ||
                legacyConns.length > POPULATION_CAP ||
                unitIds.length > POPULATION_CAP,
            populationExceptions: [],
            facts: [
                `identityConnectionsWithoutActiveAccounts=${identityConns.length - withActive.length}`,
                `legacyConnectionsWithoutCompleteSnapshot=${legacyConns.length - withSnapshot.length}`,
            ],
            async preconditions() {
                return null;
            },
            async evaluate(sampled) {
                const windowMs = rc.parameters.remediationWindowDays * DAY_MS;
                const campaigns = (await db.accessReview.findMany({
                    where: {
                        tenantId,
                        deletedAt: null,
                        status: 'CLOSED',
                        closedAt: { gte: rc.periodStart, lt: quarterEnd },
                        scope: { in: ['ALL_USERS', 'CONNECTED_APP', 'LEGACY_APP'] },
                    },
                    select: {
                        id: true,
                        scope: true,
                        closedAt: true,
                        dueAt: true,
                        snapshotTruncated: true,
                        evidenceFileRecordId: true,
                    },
                    orderBy: [{ closedAt: 'desc' }, { id: 'asc' }],
                    take: CAMPAIGN_CAP,
                })) as Campaign[];
                const facts: string[] = [`campaignsClosedInPeriod=${campaigns.length}`];

                // Which units each connected and legacy campaign reaches. One read
                // of their decision rows, which R2, R5 and R6 need anyway.
                const connectedCampaigns = campaigns.filter((c) => c.scope !== 'ALL_USERS');
                const connectedRows =
                    connectedCampaigns.length === 0
                        ? []
                        : await db.accessReviewConnectedDecision.findMany({
                              where: { tenantId, accessReviewId: { in: connectedCampaigns.map((c) => c.id) } },
                              select: {
                                  id: true,
                                  accessReviewId: true,
                                  connectedAccountId: true,
                                  subjectRef: true,
                                  snapshotJson: true,
                                  decision: true,
                                  decidedAt: true,
                                  decidedByUserId: true,
                              },
                              take: DECISION_CAP + 1,
                          });
                const connectedTruncated = connectedRows.length > DECISION_CAP;
                const accountIds = [
                    ...new Set(connectedRows.map((r) => r.connectedAccountId).filter((id): id is string => !!id)),
                ];
                const accounts =
                    accountIds.length === 0
                        ? []
                        : await db.connectedIdentityAccount.findMany({
                              where: { tenantId, id: { in: accountIds } },
                              select: { id: true, connectionId: true, status: true },
                              take: accountIds.length,
                          });
                const accountById = new Map(accounts.map((a) => [a.id, a] as const));
                const rowsByCampaign = groupBy(connectedRows, (r) => r.accessReviewId);

                const coveringFor = (unitId: string): Campaign | null => {
                    if (unitId === MEMBERSHIPS_UNIT) return campaigns.find((c) => c.scope === 'ALL_USERS') ?? null;
                    if (unitId.startsWith(CONNECTION_PREFIX)) {
                        const connId = unitId.slice(CONNECTION_PREFIX.length);
                        return (
                            campaigns.find(
                                (c) =>
                                    c.scope === 'CONNECTED_APP' &&
                                    (rowsByCampaign.get(c.id) ?? []).some(
                                        (r) =>
                                            r.connectedAccountId !== null &&
                                            accountById.get(r.connectedAccountId)?.connectionId === connId,
                                    ),
                            ) ?? null
                        );
                    }
                    const connId = unitId.slice(LEGACY_PREFIX.length);
                    return (
                        campaigns.find(
                            (c) =>
                                c.scope === 'LEGACY_APP' &&
                                (rowsByCampaign.get(c.id) ?? []).some((r) => r.subjectRef.startsWith(`${connId}:`)),
                        ) ?? null
                    );
                };
                const covering = new Map(sampled.map((u) => [u, coveringFor(u)] as const));

                // The membership campaign's rows, and the memberships its decisions name.
                const membershipCampaign = covering.get(MEMBERSHIPS_UNIT) ?? null;
                const membershipRows = membershipCampaign
                    ? await db.accessReviewDecision.findMany({
                          where: { tenantId, accessReviewId: membershipCampaign.id },
                          select: {
                              id: true,
                              membershipId: true,
                              subjectUserId: true,
                              decision: true,
                              decidedAt: true,
                              decidedByUserId: true,
                              modifiedToRole: true,
                              modifiedToCustomRoleId: true,
                          },
                          take: DECISION_CAP + 1,
                      })
                    : [];
                const changedMembershipIds = membershipRows
                    .filter((r) => r.decision === 'REVOKE' || r.decision === 'MODIFY')
                    .map((r) => r.membershipId)
                    .filter((id): id is string => !!id);
                const memberships =
                    changedMembershipIds.length === 0
                        ? []
                        : await db.tenantMembership.findMany({
                              where: { tenantId, id: { in: changedMembershipIds } },
                              select: { id: true, status: true, role: true, customRoleId: true },
                              take: changedMembershipIds.length,
                          });
                const membershipById = new Map(memberships.map((m) => [m.id, m] as const));

                // What the close SAID it did, beside what the rows show: reported, never relied on.
                const executedRows =
                    changedMembershipIds.length === 0
                        ? []
                        : await db.auditLog.findMany({
                              where: {
                                  tenantId,
                                  action: 'ACCESS_REVIEW_DECISION_EXECUTED',
                                  entity: 'AccessReviewDecision',
                                  entityId: {
                                      in: membershipRows
                                          .filter((r) => r.decision === 'REVOKE' || r.decision === 'MODIFY')
                                          .map((r) => r.id),
                                  },
                              },
                              select: { detailsJson: true },
                              take: DECISION_CAP,
                          });
                const outcomeCounts = new Map<string, number>();
                for (const row of executedRows) {
                    const after = (row.detailsJson as { after?: { outcome?: unknown } } | null)?.after;
                    const outcome = typeof after?.outcome === 'string' ? after.outcome : 'UNRECORDED';
                    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
                }
                for (const [outcome, n] of [...outcomeCounts.entries()].sort()) {
                    facts.push(`membershipCloseReported_${outcome}=${n}`);
                }

                // R5 for connected and legacy rows: the decider's address against the subject's.
                const coveredConnected = new Set(
                    [...covering.values()].filter((c): c is Campaign => !!c && c.scope !== 'ALL_USERS').map((c) => c.id),
                );
                const deciderIds = [
                    ...new Set(
                        connectedRows
                            .filter((r) => coveredConnected.has(r.accessReviewId))
                            .map((r) => r.decidedByUserId)
                            .filter((id): id is string => !!id),
                    ),
                ];
                const deciders =
                    deciderIds.length === 0
                        ? []
                        : await db.user.findMany({
                              where: { id: { in: deciderIds } },
                              select: { id: true, email: true },
                              take: deciderIds.length,
                          });
                const deciderEmail = new Map(deciders.map((u) => [u.id, emailKey(u.email)] as const));

                // R6 observations: the newest PASSED sync of each identity
                // connection, and the COMPLETE snapshots of each legacy one.
                const identityUnitConns = sampled
                    .filter((u) => u.startsWith(CONNECTION_PREFIX))
                    .map((u) => u.slice(CONNECTION_PREFIX.length));
                const legacyUnitConns = sampled
                    .filter((u) => u.startsWith(LEGACY_PREFIX))
                    .map((u) => u.slice(LEGACY_PREFIX.length));
                const syncs =
                    identityUnitConns.length === 0
                        ? []
                        : await db.integrationExecution.findMany({
                              where: {
                                  tenantId,
                                  connectionId: { in: identityUnitConns },
                                  automationKey: { in: IDENTITY_PROVIDERS.map((p) => syncAutomationKey(p)) },
                                  status: 'PASSED',
                                  completedAt: { not: null },
                              },
                              select: { connectionId: true, automationKey: true, completedAt: true },
                              orderBy: { completedAt: 'desc' },
                              distinct: ['connectionId'],
                              take: identityUnitConns.length,
                          });
                const latestSync = new Map(
                    syncs
                        .filter((s) => s.automationKey === syncAutomationKey(providerOf.get(s.connectionId ?? '') ?? ''))
                        .map((s) => [s.connectionId as string, s.completedAt as Date] as const),
                );
                const snapshots =
                    legacyUnitConns.length === 0
                        ? []
                        : await db.legacyAccessSnapshot.findMany({
                              where: {
                                  tenantId,
                                  connectionId: { in: legacyUnitConns },
                                  status: 'COMPLETE',
                                  completedAt: { gte: rc.periodStart },
                              },
                              select: { id: true, connectionId: true, completedAt: true },
                              orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
                              take: CAMPAIGN_CAP,
                          });
                // The first COMPLETE snapshot after each legacy campaign's window.
                const observationSnapshot = new Map<string, string>();
                for (const unit of sampled.filter((u) => u.startsWith(LEGACY_PREFIX))) {
                    const camp = covering.get(unit);
                    if (!camp) continue;
                    const connId = unit.slice(LEGACY_PREFIX.length);
                    const after = camp.closedAt.getTime() + windowMs;
                    const snap = snapshots.find(
                        (s) => s.connectionId === connId && s.completedAt !== null && s.completedAt.getTime() > after,
                    );
                    if (snap) observationSnapshot.set(unit, snap.id);
                }
                const revokedKeys = connectedRows
                    .filter((r) => r.decision === 'REVOKE' && coveredConnected.has(r.accessReviewId))
                    .map((r) => accountKeyOf(r.snapshotJson))
                    .filter((k): k is string => !!k);
                const legacyAccounts =
                    observationSnapshot.size === 0 || revokedKeys.length === 0
                        ? []
                        : await db.legacyAccount.findMany({
                              where: {
                                  tenantId,
                                  snapshotId: { in: [...observationSnapshot.values()] },
                                  accountKey: { in: revokedKeys },
                              },
                              select: { snapshotId: true, accountKey: true, status: true },
                              take: revokedKeys.length * observationSnapshot.size,
                          });
                const legacyStatus = new Map(legacyAccounts.map((a) => [`${a.snapshotId}|${a.accountKey}`, a.status] as const));

                let modifyCounted = 0;
                const units: UnitJudgement[] = sampled.map((unitId) => {
                    const camp = covering.get(unitId) ?? null;
                    if (!camp) {
                        return judgeUnit(unitId, [
                            { attribute: 'R1', result: 'EXCEPTION', code: 'NOT_RECERTIFIED_IN_PERIOD' },
                        ]);
                    }
                    const results: AttributeResult[] = [{ attribute: 'R1', result: 'MET' }];
                    const isMemberships = unitId === MEMBERSHIPS_UNIT;
                    const rows = isMemberships ? membershipRows : (rowsByCampaign.get(camp.id) ?? []);
                    const truncatedRows = isMemberships ? membershipRows.length > DECISION_CAP : connectedTruncated;
                    if (truncatedRows) {
                        results.push({ attribute: 'R2', result: 'UNTESTABLE', code: 'DECISION_READ_TRUNCATED' });
                        return judgeUnit(unitId, results);
                    }

                    // R2 — zero is never complete.
                    const subjectCount = rows.length;
                    const decided = rows.filter((r) => r.decision !== null && r.decidedAt !== null).length;
                    results.push(
                        subjectCount > 0 && decided === subjectCount
                            ? { attribute: 'R2', result: 'MET' }
                            : { attribute: 'R2', result: 'EXCEPTION', code: 'CAMPAIGN_INCOMPLETE' },
                    );
                    results.push(
                        camp.snapshotTruncated
                            ? { attribute: 'R3', result: 'EXCEPTION', code: 'CAMPAIGN_TRUNCATED' }
                            : { attribute: 'R3', result: 'MET' },
                    );
                    results.push(
                        camp.dueAt === null || camp.closedAt.getTime() <= camp.dueAt.getTime()
                            ? { attribute: 'R4', result: 'MET' }
                            : { attribute: 'R4', result: 'EXCEPTION', code: 'CLOSED_AFTER_DUE' },
                    );

                    if (isMemberships) {
                        const self = membershipRows.some(
                            (r) => r.decidedByUserId !== null && r.decidedByUserId === r.subjectUserId,
                        );
                        results.push(
                            self
                                ? { attribute: 'R5', result: 'EXCEPTION', code: 'SELF_REVIEW' }
                                : { attribute: 'R5', result: 'MET' },
                        );
                        // R6 — the membership row, never the `executedAt` stamp.
                        const notExecuted = membershipRows.some((r) => {
                            if (r.decision === 'REVOKE') {
                                const m = r.membershipId ? membershipById.get(r.membershipId) : undefined;
                                return m !== undefined && m.status === 'ACTIVE';
                            }
                            if (r.decision === 'MODIFY') {
                                const m = r.membershipId ? membershipById.get(r.membershipId) : undefined;
                                if (!m) return false;
                                if (r.modifiedToRole !== null && m.role !== r.modifiedToRole) return true;
                                return r.modifiedToCustomRoleId !== null && m.customRoleId !== r.modifiedToCustomRoleId;
                            }
                            return false;
                        });
                        results.push(
                            notExecuted
                                ? { attribute: 'R6', result: 'EXCEPTION', code: 'REVOCATION_NOT_EXECUTED' }
                                : { attribute: 'R6', result: 'MET' },
                        );
                    } else {
                        const connRows = rowsByCampaign.get(camp.id) ?? [];
                        const self = connRows.some((r) => {
                            const decider = r.decidedByUserId ? deciderEmail.get(r.decidedByUserId) : null;
                            const subject = emailKey(emailOf(r.snapshotJson));
                            return decider !== null && decider !== undefined && subject !== null && decider === subject;
                        });
                        results.push(
                            self
                                ? { attribute: 'R5', result: 'EXCEPTION', code: 'SELF_REVIEW' }
                                : { attribute: 'R5', result: 'MET' },
                        );
                        modifyCounted += connRows.filter((r) => r.decision === 'MODIFY').length;
                        const revoked = connRows.filter((r) => r.decision === 'REVOKE');
                        if (revoked.length === 0) {
                            results.push({ attribute: 'R6', result: 'MET' });
                        } else if (unitId.startsWith(CONNECTION_PREFIX)) {
                            const connId = unitId.slice(CONNECTION_PREFIX.length);
                            const observed = latestSync.get(connId);
                            if (!observed || observed.getTime() <= camp.closedAt.getTime() + windowMs) {
                                results.push({ attribute: 'R6', result: 'UNTESTABLE', code: 'NO_OBSERVATION_AFTER_CLOSE' });
                            } else {
                                const stillActive = revoked.some(
                                    (r) =>
                                        r.connectedAccountId !== null &&
                                        accountById.get(r.connectedAccountId)?.status === 'ACTIVE',
                                );
                                results.push(
                                    stillActive
                                        ? { attribute: 'R6', result: 'EXCEPTION', code: 'REVOKED_ACCESS_STILL_ACTIVE' }
                                        : { attribute: 'R6', result: 'MET' },
                                );
                            }
                        } else {
                            const snapId = observationSnapshot.get(unitId);
                            if (!snapId) {
                                results.push({ attribute: 'R6', result: 'UNTESTABLE', code: 'NO_OBSERVATION_AFTER_CLOSE' });
                            } else {
                                const stillActive = revoked.some((r) => {
                                    const key = accountKeyOf(r.snapshotJson);
                                    return key !== null && legacyStatus.get(`${snapId}|${key}`) === 'ACTIVE';
                                });
                                results.push(
                                    stillActive
                                        ? { attribute: 'R6', result: 'EXCEPTION', code: 'REVOKED_ACCESS_STILL_ACTIVE' }
                                        : { attribute: 'R6', result: 'MET' },
                                );
                            }
                        }
                    }
                    results.push(
                        camp.evidenceFileRecordId !== null
                            ? { attribute: 'R7', result: 'MET' }
                            : { attribute: 'R7', result: 'EXCEPTION', code: 'EVIDENCE_NOT_GENERATED' },
                    );
                    return judgeUnit(unitId, results);
                });
                facts.push(`connectedOrLegacyModifyDecisions=${modifyCounted}`);
                return { units, facts };
            },
        };
    },
};

function snapshotOf(json: unknown): Record<string, unknown> {
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

function emailOf(json: unknown): string | null {
    const v = snapshotOf(json).email;
    return typeof v === 'string' ? v : null;
}

function accountKeyOf(json: unknown): string | null {
    const v = snapshotOf(json).accountKey;
    return typeof v === 'string' && v.length > 0 ? v : null;
}
