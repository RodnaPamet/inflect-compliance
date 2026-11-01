/**
 * Epic O-3 — portfolio drill-down DB-backed lifecycle.
 *
 * Proves the load-bearing security property end-to-end against real
 * Postgres + RLS:
 *
 *   1. CREATE org with 2 child tenants
 *   2. CREATE the CISO + their auto-provisioned ADMIN membership in
 *      both tenants (mirrors what `provisionOrgAdminToTenants` does
 *      at runtime)
 *   3. SEED tenant-scoped Control + Risk + Evidence rows in each
 *      tenant — including some that should be excluded by the
 *      drill-down filter (IMPLEMENTED control, CLOSED risk,
 *      APPROVED evidence)
 *   4. CALL the three drill-down usecases via the OrgContext
 *   5. ASSERT the returned rows are merged across both tenants,
 *      tenant-attributed, and exclude the rows that should be
 *      filtered out
 *
 * Each per-tenant query inside the usecase runs through
 * `withTenantDb(tid, ...)` — `SET LOCAL ROLE app_user` + `SELECT
 * set_config('app.tenant_id', $1)`. RLS evaluates the ADMIN
 * membership and lets the read through. If a future regression
 * introduced a runInGlobalContext bypass somewhere in the drill-down
 * chain, this test would still pass — the load-bearing structural
 * test is `tests/unit/no-direct-prisma.test.ts`'s
 * WITH_TENANT_DB_ALLOWLIST. This integration test complements it by
 * proving the orchestration works against the real schema.
 *
 * Gated by DB_AVAILABLE — skips locally without Postgres + migrations
 * applied; runs in CI.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

import {
    getNonPerformingControls,
    getCriticalRisksAcrossOrg,
    getOverdueEvidenceAcrossOrg,
    getPortfolioSummary,
    getPortfolioTenantHealth,
} from '@/app-layer/usecases/portfolio';
import type { OrgContext } from '@/app-layer/types';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Epic O-3 — portfolio drill-down lifecycle (DB-backed)', () => {
    let prisma: PrismaClient;
    const uniq = `o3-life-${Date.now()}`;
    const orgSlug = `${uniq}-org`;
    let orgId = '';
    let cisoUserId = '';
    const tenantSlugs = [`${uniq}-t1`, `${uniq}-t2`];
    const tenantIds: string[] = [];
    const tenantNames: string[] = [];

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
            canManageAgentSwitches: true,
            canManageOwners: false,
            },
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // ── Org + CISO + 2 tenants ────────────────────────────────
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

        for (let i = 0; i < tenantSlugs.length; i++) {
            const slug = tenantSlugs[i];
            const name = `${uniq} tenant ${i + 1}`;
            const { wrapped } = generateAndWrapDek();
            const tenant = await prisma.tenant.create({
                data: {
                    name,
                    slug,
                    organizationId: org.id,
                    encryptedDek: wrapped,
                },
            });
            tenantIds.push(tenant.id);
            tenantNames.push(name);

            // The CISO's auto-provisioned ADMIN membership in this
            // tenant — what makes the per-tenant withTenantDb read
            // succeed under RLS.
            await prisma.tenantMembership.create({
                data: {
                    tenantId: tenant.id,
                    userId: ciso.id,
                    role: 'ADMIN',
                    provisionedByOrgId: org.id,
                },
            });

            // ── Controls ──
            // One non-performing (NOT_STARTED) + one excluded (IMPLEMENTED).
            await prisma.control.create({
                data: {
                    tenantId: tenant.id,
                    name: `t${i + 1} pending control`,
                    code: `T${i + 1}-PENDING`,
                    status: 'NOT_STARTED',
                    applicability: 'APPLICABLE',
                },
            });
            await prisma.control.create({
                data: {
                    tenantId: tenant.id,
                    name: `t${i + 1} done control`,
                    code: `T${i + 1}-DONE`,
                    status: 'IMPLEMENTED',
                    applicability: 'APPLICABLE',
                },
            });
            await prisma.control.create({
                data: {
                    tenantId: tenant.id,
                    name: `t${i + 1} N/A control`,
                    code: `T${i + 1}-NA`,
                    status: 'NOT_STARTED',
                    applicability: 'NOT_APPLICABLE', // excluded
                },
            });

            // ── Risks ──
            // One critical (score=20, OPEN) + one excluded (score=20 but CLOSED) + one excluded (low score).
            await prisma.risk.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} critical risk`,
                    inherentScore: 20,
                    score: 20,
                    status: 'OPEN',
                    likelihood: 4,
                    impact: 5,
                },
            });
            await prisma.risk.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} closed critical risk`,
                    inherentScore: 20,
                    score: 20,
                    status: 'CLOSED', // excluded
                    likelihood: 4,
                    impact: 5,
                },
            });
            await prisma.risk.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} low risk`,
                    inherentScore: 5, // excluded: below either workspace's top band
                    score: 5,
                    status: 'OPEN',
                    likelihood: 1,
                    impact: 5,
                },
            });
            // ACCEPTED leaves the critical count (#4846): its treatment is
            // decided, as on the workspace's own dashboard.
            await prisma.risk.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} accepted critical risk`,
                    inherentScore: 20,
                    score: 20,
                    status: 'ACCEPTED', // excluded
                    likelihood: 4,
                    impact: 5,
                },
            });
            if (i === 1) {
                // The second workspace runs a 3 x 3 matrix whose top band is
                // 6-9 (#4846): a 6 is critical THERE, and would never reach
                // the old fixed 15.
                await prisma.riskMatrixConfig.create({
                    data: {
                        tenantId: tenant.id,
                        likelihoodLevels: 3,
                        impactLevels: 3,
                        bands: [
                            { name: 'Low', minScore: 1, maxScore: 2, color: '#22c55e' },
                            { name: 'Medium', minScore: 3, maxScore: 5, color: '#f59e0b' },
                            { name: 'High', minScore: 6, maxScore: 9, color: '#ef4444' },
                        ],
                    },
                });
                await prisma.risk.create({
                    data: {
                        tenantId: tenant.id,
                        title: `t${i + 1} band critical risk`,
                        inherentScore: 6,
                        score: 6,
                        status: 'MITIGATING',
                        likelihood: 2,
                        impact: 3,
                    },
                });
            }

            // ── Evidence ──
            // One overdue + one excluded (APPROVED, regardless of date) + one excluded (future review).
            const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
            const fiveDaysFromNow = new Date(Date.now() + 5 * 86400_000);
            await prisma.evidence.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} overdue evidence`,
                    type: 'TEXT',
                    nextReviewDate: tenDaysAgo,
                    status: 'SUBMITTED',
                },
            });
            await prisma.evidence.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} approved evidence`,
                    type: 'TEXT',
                    nextReviewDate: tenDaysAgo,
                    status: 'APPROVED', // excluded
                },
            });
            await prisma.evidence.create({
                data: {
                    tenantId: tenant.id,
                    title: `t${i + 1} future review evidence`,
                    type: 'TEXT',
                    nextReviewDate: fiveDaysFromNow, // excluded
                    status: 'SUBMITTED',
                },
            });
        }
    });

    afterAll(async () => {
        await prisma.evidence.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.risk.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.riskMatrixConfig.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.control.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
        await prisma.orgMembership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
        await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
        await prisma.user.delete({ where: { id: cisoUserId } });
        await prisma.$disconnect();
    });

    // ── Drill-down: controls ──────────────────────────────────────

    it('getNonPerformingControls returns one row per tenant, IMPLEMENTED + N/A excluded', async () => {
        const rows = await getNonPerformingControls(ctxFor());

        // 2 tenants × 1 NOT_STARTED applicable = 2 rows.
        expect(rows).toHaveLength(2);

        // Both tenants represented, attribution intact.
        const slugs = rows.map((r) => r.tenantSlug).sort();
        expect(slugs).toEqual(tenantSlugs.slice().sort());

        for (const r of rows) {
            expect(r.status).toBe('NOT_STARTED');
            expect(r.code).toMatch(/PENDING/);
            expect(r.drillDownUrl).toBe(`/t/${r.tenantSlug}/controls/${r.controlId}`);
        }
    });

    // ── Drill-down: risks ─────────────────────────────────────────

    it("getCriticalRisksAcrossOrg returns each workspace's top-band risks still needing treatment (#4846)", async () => {
        const rows = await getCriticalRisksAcrossOrg(ctxFor());

        // Workspace 1 (default grid, top band 15+): its OPEN 20.
        // Workspace 2 (3 x 3, top band 6+): its OPEN 20 and its MITIGATING 6.
        // Closed, accepted and low-score rows are excluded everywhere.
        expect(rows.map((r) => r.title).sort()).toEqual(
            ['t1 critical risk', 't2 band critical risk', 't2 critical risk'].sort(),
        );
        for (const r of rows) {
            expect(['OPEN', 'MITIGATING']).toContain(r.status);
            expect(r.drillDownUrl).toBe(`/t/${r.tenantSlug}/risks/${r.riskId}`);
        }
        const band = rows.find((r) => r.title === 't2 band critical risk');
        expect(band?.tenantSlug).toBe(tenantSlugs[1]);
        expect(band?.inherentScore).toBe(6);
    });

    // ── Drill-down: evidence ──────────────────────────────────────

    it('getOverdueEvidenceAcrossOrg returns rows with nextReviewDate<now AND status≠APPROVED', async () => {
        const rows = await getOverdueEvidenceAcrossOrg(ctxFor());

        // 2 tenants × 1 SUBMITTED-overdue = 2 rows. APPROVED and
        // future-review rows must be excluded.
        expect(rows).toHaveLength(2);
        for (const r of rows) {
            expect(r.status).not.toBe('APPROVED');
            expect(r.daysOverdue).toBeGreaterThanOrEqual(9);
            expect(r.title).toMatch(/overdue evidence$/);
            expect(r.drillDownUrl).toBe(`/t/${r.tenantSlug}/evidence/${r.evidenceId}`);
        }
    });

    // ── Aggregation: portfolio summary + tenant health ────────────

    it('getPortfolioSummary aggregates only org-linked tenants', async () => {
        const summary = await getPortfolioSummary(ctxFor());

        expect(summary.organizationId).toBe(orgId);
        expect(summary.tenants.total).toBe(tenantIds.length);
        // Snapshots haven't been seeded, so all tenants are pending.
        expect(summary.tenants.pending).toBe(tenantIds.length);
        expect(summary.rag.pending).toBe(tenantIds.length);
    });

    it('getPortfolioTenantHealth emits one row per linked tenant with correct slug + name', async () => {
        const rows = await getPortfolioTenantHealth(ctxFor());

        expect(rows).toHaveLength(tenantIds.length);
        const slugs = rows.map((r) => r.slug).sort();
        expect(slugs).toEqual(tenantSlugs.slice().sort());
        // No snapshots yet → metric fields null, hasSnapshot=false.
        for (const r of rows) {
            expect(r.hasSnapshot).toBe(false);
            expect(r.coveragePercent).toBeNull();
            expect(r.rag).toBeNull();
            expect(r.drillDownUrl).toBe(`/t/${r.slug}/dashboard`);
        }
    });
});
