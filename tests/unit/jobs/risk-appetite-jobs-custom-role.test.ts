/**
 * The risk-appetite monitor scans each tenant as its oldest active OWNER/ADMIN
 * whose RESOLVED authority, custom role included, lets it read the risk
 * register (#4388, owner decision 2026-10-26).
 *
 * It took the oldest OWNER/ADMIN by built-in role and gave them that role's
 * permissions, so a custom role on that admin was ignored. Now:
 *   - an admin whose custom role withholds `risks.view` is passed over for the
 *     next one;
 *   - a tenant with nobody qualifying is not scanned, and is returned and
 *     logged with a named reason (it was skipped in silence);
 *   - a built-in role's context is exactly the one the monitor built before.
 *
 * `findFirst` answers as the old query did (the oldest of the same rows), so
 * every test here also runs meaningfully against the code before the fix.
 */
const prismaMock = {
    riskAppetiteConfig: { findMany: jest.fn() },
    tenantMembership: { findMany: jest.fn(), findFirst: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const usecase = {
    checkPortfolioAppetite: jest.fn(),
    recordBreaches: jest.fn(),
    resolveStaleBreaches: jest.fn(),
};
jest.mock('@/app-layer/usecases/risk-appetite', () => usecase);

const warnMock = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: (...a: unknown[]) => warnMock(...a), error: jest.fn(), debug: jest.fn() },
}));

import type { Role } from '@prisma/client';
import { runRiskAppetiteMonitor } from '@/app-layer/jobs/risk-appetite-jobs';
import { initiatorAuthority } from '@/app-layer/context-system';
import { getPermissionsForRole } from '@/lib/permissions';

const BUILT_IN: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'];
const ADMIN = getPermissionsForRole('ADMIN');

/** An ADMIN-based custom role that withholds `risks.view`. */
const withoutRiskView = { baseRole: 'ADMIN' as Role, permissionsJson: { risks: { ...ADMIN.risks, view: false } } };

const member = (userId: string, role: Role, customRole: { baseRole: Role; permissionsJson: unknown } | null = null) => ({
    userId,
    role,
    customRole,
});

/** The tenant's active OWNER/ADMIN rows, oldest first, as the query returns them. */
function admins(rows: ReturnType<typeof member>[]) {
    prismaMock.tenantMembership.findMany.mockResolvedValue(rows);
    prismaMock.tenantMembership.findFirst.mockResolvedValue(rows[0] ?? null);
}

/** The context the monitor scanned as. */
const scannedAs = () => usecase.checkPortfolioAppetite.mock.calls[0]?.[0];

/** The context the monitor built before #4388, for a membership with no custom role. */
function contextBefore4388(tenantId: string, m: { userId: string; role: Role }) {
    const appPermissions = getPermissionsForRole(m.role);
    return {
        requestId: `risk-appetite-${tenantId}`,
        userId: m.userId,
        tenantId,
        role: m.role,
        permissions: {
            canRead: appPermissions.risks.view,
            canWrite: appPermissions.risks.edit,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.riskAppetiteConfig.findMany.mockResolvedValue([{ tenantId: 'tenant-A' }]);
    usecase.checkPortfolioAppetite.mockResolvedValue({ breaches: [] });
    usecase.recordBreaches.mockResolvedValue(0);
    usecase.resolveStaleBreaches.mockResolvedValue(0);
});

describe('the monitor acts as the oldest OWNER/ADMIN whose resolved permissions hold risks.view', () => {
    it('passes over an oldest ADMIN whose custom role withholds risks.view, for the next one', async () => {
        admins([member('oldest-custom-admin', 'ADMIN', withoutRiskView), member('next-admin', 'ADMIN')]);

        const r = await runRiskAppetiteMonitor({} as never);

        expect(scannedAs()).toEqual(contextBefore4388('tenant-A', member('next-admin', 'ADMIN')));
        expect(r).toMatchObject({ tenants: 1, scanned: 1, unroutable: [] });
        expect(prismaMock.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-A', status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
                orderBy: { createdAt: 'asc' },
            }),
        );
    });

    it('acts with the custom role a request from that admin would carry', async () => {
        // A READER-based role on an ADMIN membership: it reads the register, so
        // it qualifies, and it carries READER's tier and its own set.
        const readerBased = member('custom-admin', 'ADMIN', { baseRole: 'READER', permissionsJson: {} });
        admins([readerBased]);

        await runRiskAppetiteMonitor({} as never);

        expect(scannedAs()).toEqual({
            requestId: 'risk-appetite-tenant-A',
            userId: 'custom-admin',
            tenantId: 'tenant-A',
            ...initiatorAuthority(readerBased),
        });
        expect(scannedAs().role).toBe('READER');
    });
});

describe('a tenant with nobody to act as is reported with a named reason, never skipped in silence', () => {
    it('NO_ADMIN_WITH_RISK_VIEW when every admin’s custom role withholds the read', async () => {
        admins([member('custom-admin', 'ADMIN', withoutRiskView)]);

        const r = await runRiskAppetiteMonitor({} as never);

        expect(usecase.checkPortfolioAppetite).not.toHaveBeenCalled();
        expect(r).toMatchObject({
            scanned: 0,
            unroutable: [{ tenantId: 'tenant-A', reason: 'NO_ADMIN_WITH_RISK_VIEW' }],
        });
        expect(warnMock).toHaveBeenCalledWith(
            'risk-appetite-monitor: tenant not scanned',
            expect.objectContaining({ tenantId: 'tenant-A', reason: 'NO_ADMIN_WITH_RISK_VIEW' }),
        );
    });

    it('NO_ACTIVE_ADMIN when the tenant has no active OWNER or ADMIN', async () => {
        admins([]);

        const r = await runRiskAppetiteMonitor({} as never);

        expect(usecase.checkPortfolioAppetite).not.toHaveBeenCalled();
        expect(r.unroutable).toEqual([{ tenantId: 'tenant-A', reason: 'NO_ACTIVE_ADMIN' }]);
        expect(warnMock).toHaveBeenCalledWith(
            'risk-appetite-monitor: tenant not scanned',
            expect.objectContaining({ reason: 'NO_ACTIVE_ADMIN' }),
        );
    });
});

describe('a built-in role’s context is the one the monitor built before #4388', () => {
    // The query reads OWNER and ADMIN only, so the other four never reach the
    // builder; they are pinned too, so a change to the rule cannot hide behind
    // the query.
    it.each(BUILT_IN)('%s', async (role) => {
        admins([member('member-1', role)]);

        await runRiskAppetiteMonitor({} as never);

        expect(scannedAs()).toEqual(contextBefore4388('tenant-A', member('member-1', role)));
    });
});
