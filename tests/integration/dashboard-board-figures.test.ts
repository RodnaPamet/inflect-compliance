/**
 * The Board (executive dashboard)'s figures, against a real database (#4458).
 *
 *   1. Severity counts OPEN risks only (owner decision, 2026-10-29). "N
 *      high/critical" is open risks scoring 10 or more — the Risk
 *      Distribution card's High + Critical — and a closed or accepted risk
 *      leaves every severity figure and the posture radar's Risk axis. The
 *      fixture is the one the decision names: a closed critical risk, an
 *      accepted one, and an open risk scoring 12.
 *   2. The "Evidence status" custom metric counts each row once. An approved
 *      item due in three weeks used to be in both "Due 8–30d" and "Current".
 *   3. Recent Activity is read only by a role that can read the audit log.
 *   4. A MITIGATED risk leaves the severity figures too (owner decision,
 *      2026-10-30): they count the risks still needing treatment, OPEN and
 *      MITIGATING. The same risk is still OPEN to the deadline monitor and
 *      the compliance calendar, which ask a different question (is a review
 *      or acceptance still due?) and keep the wider line.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { DashboardRepository } from '@/app-layer/repositories/DashboardRepository';
import {
    getDashboardKpi,
    getDashboardRecentActivity,
    getExecutiveDashboard,
} from '@/app-layer/usecases/dashboard';
import { ratePostureAxes } from '@/lib/charts/posture-radar';
import { resolveNextBestAction } from '@/components/ui/next-best-action-logic';
import { runInTenantContext } from '@/lib/db-context';
import { runDeadlineMonitor } from '@/app-layer/jobs/deadline-monitor';
import { getComplianceCalendarEvents } from '@/app-layer/usecases/compliance-calendar';
import { takeSnapshot } from '@/app-layer/usecases/risk-snapshot';
import { getAutomationSuggestions } from '@/app-layer/usecases/automation-suggestions';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SUITE_TAG = `board-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let adminUserId = '';

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

function ctxFor(role: Role) {
    return makeRequestContext(role, {
        userId: adminUserId,
        tenantId: TENANT_ID,
        tenantSlug: SUITE_TAG,
    });
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    const email = `${SUITE_TAG}-admin@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    adminUserId = u.id;
    await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId: adminUserId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
}

async function teardown() {
    await globalPrisma.riskSnapshot.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.portfolioSnapshot.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
    await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
    if (adminUserId) await globalPrisma.user.delete({ where: { id: adminUserId } });
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

describeFn('Board figures (#4458)', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    describe('severity counts open risks only', () => {
        beforeAll(async () => {
            const risk = (title: string, score: number, status: 'OPEN' | 'CLOSED' | 'ACCEPTED') =>
                globalPrisma.risk.create({
                    data: { tenantId: TENANT_ID, title, inherentScore: score, score, status },
                });
            await risk('closed critical', 20, 'CLOSED');
            await risk('accepted critical', 16, 'ACCEPTED');
            await risk('open high', 12, 'OPEN');
        });
        afterAll(async () => {
            await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } });
        });

        it('"high/critical" is the open score-12 risk alone', async () => {
            const ctx = ctxFor(Role.ADMIN);
            const stats = await runInTenantContext(ctx, (db) =>
                DashboardRepository.getStats(db, ctx),
            );
            expect(stats.highRisks).toBe(1);
            // The Risks card's headline still counts every risk.
            expect(stats.risks).toBe(3);
        });

        it('the Risk Distribution bands leave out the closed and accepted risks', async () => {
            const ctx = ctxFor(Role.ADMIN);
            const sev = await runInTenantContext(ctx, (db) =>
                DashboardRepository.getRiskBySeverity(db, ctx),
            );
            expect(sev).toEqual({ low: 0, medium: 0, high: 1, critical: 0 });
        });

        it('"high/critical" equals High + Critical, and the radar rates open risks only', async () => {
            const exec = await getExecutiveDashboard(ctxFor(Role.ADMIN));
            expect(exec.stats.highRisks).toBe(
                exec.riskBySeverity.high + exec.riskBySeverity.critical,
            );
            const risk = ratePostureAxes(exec, (a) => a).find((r) => r.key === 'risk');
            // One open risk, and it is severe: 0 of 1 healthy. With the closed
            // and accepted risks counted this read 0 of 3.
            expect(risk).toMatchObject({ measured: 0, total: 1 });
            // The next-step card quotes the same one risk.
            const action = resolveNextBestAction(
                {
                    coveragePercent: 100,
                    overdueEvidence: 0,
                    overdueTasks: 0,
                    highRisks: exec.stats.highRisks,
                },
                (p) => p,
            );
            expect(action).toMatchObject({ id: 'high-risks', count: 1 });
        });
    });

    describe('a mitigated risk leaves the severity figures, and stays open for deadlines', () => {
        let mitigatedId = '';
        beforeAll(async () => {
            const risk = (
                title: string,
                score: number,
                status: 'OPEN' | 'MITIGATING' | 'MITIGATED',
                nextReviewAt: Date | null = null,
            ) =>
                globalPrisma.risk.create({
                    data: { tenantId: TENANT_ID, title, inherentScore: score, score, status, nextReviewAt },
                });
            // The decision's case: a mitigated risk scoring 12, with a review
            // due in three days so both deadline readers can see it.
            mitigatedId = (await risk('mitigated high', 12, 'MITIGATED', days(3))).id;
            await risk('mitigating critical', 16, 'MITIGATING');
            await risk('open high', 12, 'OPEN');
        });
        afterAll(async () => {
            await globalPrisma.riskSnapshot.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.portfolioSnapshot.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } });
        });

        it('"high/critical" and the bands count the open and mitigating risks only', async () => {
            const ctx = ctxFor(Role.ADMIN);
            const [stats, sev] = await runInTenantContext(ctx, (db) =>
                Promise.all([
                    DashboardRepository.getStats(db, ctx),
                    DashboardRepository.getRiskBySeverity(db, ctx),
                ]),
            );
            expect(stats.highRisks).toBe(2);
            expect(sev).toEqual({ low: 0, medium: 0, high: 1, critical: 1 });
            // The Risks card's headline still counts every risk.
            expect(stats.risks).toBe(3);
        });

        it('the radar and the next step leave the mitigated risk out', async () => {
            const exec = await getExecutiveDashboard(ctxFor(Role.ADMIN));
            const risk = ratePostureAxes(exec, (a) => a).find((r) => r.key === 'risk');
            // Two risks still need treatment and both are severe. Counting the
            // mitigated one this read 0 of 3.
            expect(risk).toMatchObject({ measured: 0, total: 2 });
            const action = resolveNextBestAction(
                {
                    coveragePercent: 100,
                    overdueEvidence: 0,
                    overdueTasks: 0,
                    highRisks: exec.stats.highRisks,
                },
                (p) => p,
            );
            expect(action).toMatchObject({
                id: 'high-risks',
                count: 2,
                href: '/risks?score=10|25&status=OPEN,MITIGATING',
            });
        });

        it('the deadline monitor still scans its review as an open risk', async () => {
            const { items } = await runDeadlineMonitor({
                tenantId: TENANT_ID,
                now: new Date(),
                windows: [30, 7, 1],
            });
            expect(items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ entityType: 'RISK', entityId: mitigatedId }),
                ]),
            );
        });

        it('the compliance calendar still shows its review as due, not done', async () => {
            const result = await getComplianceCalendarEvents(ctxFor(Role.ADMIN), {
                from: days(-1),
                to: days(30),
            });
            const review = result.events.find((e) => e.id === `RISK:${mitigatedId}:risk-review`);
            expect(review).toBeDefined();
            expect(review!.status).not.toBe('done');
        });

        it("the risk snapshot's open count was already open and mitigating", async () => {
            // `riskStatusNeedsTreatment` replaced an inline OPEN || MITIGATING
            // here with no change in what it counts.
            await takeSnapshot(globalPrisma, TENANT_ID);
            const portfolio = await globalPrisma.portfolioSnapshot.findFirstOrThrow({
                where: { tenantId: TENANT_ID },
            });
            expect(portfolio.totalRiskCount).toBe(3);
            expect(portfolio.openRiskCount).toBe(2);
        });

        it("the automation suggestions' active-risk count was already open and mitigating", async () => {
            // Likewise an inline `in: ['OPEN', 'MITIGATING']`, now the shared filter.
            const { suggestions } = await getAutomationSuggestions(ctxFor(Role.ADMIN));
            const riskTask = suggestions.find((x) => x.id === 'risk-created-task');
            expect(riskTask?.rationale).toMatch(/^2 risks are active/);
        });
    });

    describe('the Evidence status metric counts each row once', () => {
        beforeAll(async () => {
            const ev = (title: string, status: 'APPROVED' | 'SUBMITTED', nextReviewDate: Date | null) =>
                globalPrisma.evidence.create({
                    data: { tenantId: TENANT_ID, title, type: 'TEXT', status, nextReviewDate },
                });
            await ev('approved, due in three weeks', 'APPROVED', days(21));
            await ev('approved, no review date', 'APPROVED', null);
            await ev('approved, due in two months', 'APPROVED', days(60));
            await ev('submitted, overdue', 'SUBMITTED', days(-3));
            await ev('submitted, due in three days', 'SUBMITTED', days(3));
        });
        afterAll(async () => {
            await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        });

        it('partitions the rows into disjoint buckets', async () => {
            const ctx = ctxFor(Role.ADMIN);
            const b = await runInTenantContext(ctx, (db) =>
                DashboardRepository.getEvidenceReviewBreakdown(db, ctx),
            );
            expect(b).toEqual({ overdue: 1, dueWithin7d: 1, due8to30d: 1, current: 2 });
        });

        it('headlines five rows as five, not six', async () => {
            const dto = await getDashboardKpi(ctxFor(Role.ADMIN), 'evidence');
            expect(dto.headline).toBe(5);
            expect(dto.segments.reduce((n, s) => n + s.value, 0)).toBe(5);
            expect(dto.subtitle).toEqual({ key: 'currentPercent', count: 40 });
        });
    });

    describe('Recent Activity follows the audit log gate', () => {
        it('an Auditor reads it', async () => {
            await expect(getDashboardRecentActivity(ctxFor(Role.AUDITOR))).resolves.toEqual(
                expect.any(Array),
            );
        });

        it('a Reader is refused', async () => {
            await expect(getDashboardRecentActivity(ctxFor(Role.READER))).rejects.toMatchObject({
                status: 403,
            });
        });
    });
});
