/**
 * Portfolio overview orchestrator — DB-backed integration test.
 *
 * Spies on `PortfolioRepository` to count actual fetches against a
 * real DB and proves:
 *
 *   - The orchestrator fetches each upstream EXACTLY ONCE per call
 *     (no per-DTO refetch even though three DTOs are projected).
 *   - The standalone `getPortfolioSummary + getPortfolioTenantHealth +
 *     getPortfolioTrends` triple still works (backward compat) but
 *     fires 3× tenant lookups + 2× snapshot lookups + 1× trends —
 *     the previous behaviour the orchestrator replaces.
 *   - The DTOs returned by both paths are equivalent.
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import {
    getPortfolioOverview,
    getPortfolioSummary,
    getPortfolioTenantHealth,
    getPortfolioTrends,
} from '@/app-layer/usecases/portfolio';
import { PortfolioRepository } from '@/app-layer/repositories/PortfolioRepository';
import type { OrgContext } from '@/app-layer/types';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Portfolio overview orchestrator — single-fetch (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `overview-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    let orgId = '';
    let cisoUserId = '';
    const tenantIds: string[] = [];

    function ctxFor(): OrgContext {
        return {
            requestId: 'req-test',
            userId: cisoUserId,
            organizationId: orgId,
            orgSlug,
            orgRole: 'ORG_ADMIN',
            permissions: {
                canViewPortfolio: true,
                canDrillDown: true,
                canExportReports: true,
                canManageTenants: true,
                canManageMembers: true,
            canConfigureDashboard: true,
            canSetThreatLevel: true,
            canSetMaturity: true,
            },
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const org = await prisma.organization.create({
            data: { name: `${uniq} corp`, slug: orgSlug },
        });
        orgId = org.id;

        const ciso = await prisma.user.create({
            data: { email: `${uniq}-ciso@example.com`, name: 'CISO Test' },
        });
        cisoUserId = ciso.id;

        await prisma.orgMembership.create({
            data: { organizationId: org.id, userId: ciso.id, role: 'ORG_ADMIN' },
        });

        // Two tenants, no snapshots — the loader still runs both
        // queries; the projections handle empty/partial gracefully.
        for (let i = 0; i < 2; i++) {
            const slug = `${uniq}-t${i + 1}`;
            const { wrapped } = generateAndWrapDek();
            const tenant = await prisma.tenant.create({
                data: {
                    name: `${uniq} tenant ${i + 1}`,
                    slug,
                    organizationId: org.id,
                    encryptedDek: wrapped,
                },
            });
            tenantIds.push(tenant.id);
        }
    });

    afterAll(async () => {
        await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
        await prisma.orgMembership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
        await prisma.user.delete({ where: { id: cisoUserId } });
        await prisma.$disconnect();
    });

    // Spies wrap the static repo methods. `jest.spyOn` against a
    // class method is non-destructive — `spy.mockRestore()` returns
    // the original implementation when the test ends.

    it('orchestrator fires exactly one tenant lookup, one snapshot fetch, one trends fetch', async () => {
        const tenantsSpy = jest.spyOn(PortfolioRepository, 'getOrgTenantIds');
        const snapshotsSpy = jest.spyOn(PortfolioRepository, 'getLatestSnapshots');
        const trendsSpy = jest.spyOn(PortfolioRepository, 'getSnapshotTrends');
        try {
            await getPortfolioOverview(ctxFor());
            expect(tenantsSpy).toHaveBeenCalledTimes(1);
            expect(snapshotsSpy).toHaveBeenCalledTimes(1);
            expect(trendsSpy).toHaveBeenCalledTimes(1);
        } finally {
            tenantsSpy.mockRestore();
            snapshotsSpy.mockRestore();
            trendsSpy.mockRestore();
        }
    });

    it('parallel-usecase pattern fires the OLD duplicated query count (regression baseline)', async () => {
        // This codifies what we replaced: three independent usecases
        // each running their own fetches. If a future refactor
        // changes one of the standalone usecases to share state
        // implicitly, this test fails and the change has to be made
        // explicit.
        const tenantsSpy = jest.spyOn(PortfolioRepository, 'getOrgTenantIds');
        const snapshotsSpy = jest.spyOn(PortfolioRepository, 'getLatestSnapshots');
        const trendsSpy = jest.spyOn(PortfolioRepository, 'getSnapshotTrends');
        try {
            await Promise.all([
                getPortfolioSummary(ctxFor()),
                getPortfolioTenantHealth(ctxFor()),
                getPortfolioTrends(ctxFor(), 90),
            ]);
            expect(tenantsSpy).toHaveBeenCalledTimes(3); // once per usecase
            expect(snapshotsSpy).toHaveBeenCalledTimes(2); // summary + health
            expect(trendsSpy).toHaveBeenCalledTimes(1); // trends only
        } finally {
            tenantsSpy.mockRestore();
            snapshotsSpy.mockRestore();
            trendsSpy.mockRestore();
        }
    });

    it('orchestrator DTOs match what the standalone usecases produce', async () => {
        const overview = await getPortfolioOverview(ctxFor());
        const [standaloneSummary, standaloneHealth, standaloneTrends] = await Promise.all([
            getPortfolioSummary(ctxFor()),
            getPortfolioTenantHealth(ctxFor()),
            getPortfolioTrends(ctxFor(), 90),
        ]);

        // `generatedAt` and `rangeEnd` are fresh-Date strings — strip
        // before equality.
        const stripVolatile = <T extends { generatedAt?: string }>(s: T): T => ({
            ...s,
            generatedAt: 'IGNORED',
        });
        expect(stripVolatile(overview.summary)).toEqual(
            stripVolatile(standaloneSummary),
        );
        expect(overview.tenantHealth).toEqual(standaloneHealth);
        // Trends rangeStart/rangeEnd are derived from `now`; strip them.
        expect(overview.trends.dataPoints).toEqual(standaloneTrends.dataPoints);
        expect(overview.trends.tenantsAggregated).toEqual(standaloneTrends.tenantsAggregated);
        expect(overview.trends.daysRequested).toEqual(standaloneTrends.daysRequested);
    });
});
