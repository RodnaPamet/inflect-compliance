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
 *   - every member's context, built-in roles included, is what a request from
 *     them resolves to (owner decision 2026-10-26, as #4375 did for initiator
 *     jobs). Against the old builder that moved only `canAudit` for EDITOR,
 *     READER and AI_ADMIN, which the OWNER/ADMIN query never returns.
 *
 * `findFirst` answers as the old query did (the oldest of the same rows), so
 * every test here also runs meaningfully against the code before the fix.
 */
const prismaMock = {
    tenant: { findUnique: jest.fn() },
    riskAppetiteConfig: { findMany: jest.fn() },
    tenantMembership: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
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
import { resolveTenantContext } from '@/lib/tenant-context';
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

const REQUEST_ID = 'risk-appetite-tenant-A';

/** What a request from this member resolves to (`resolveTenantContext`). */
async function requestAuthority(m: ReturnType<typeof member>) {
    prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-A', slug: 'acme', deletedAt: null });
    prismaMock.tenantMembership.findUnique.mockResolvedValue({
        id: 'm-1',
        tenantId: 'tenant-A',
        userId: m.userId,
        role: m.role,
        status: 'ACTIVE',
        customRoleId: m.customRole ? 'cr-1' : null,
        customRole: m.customRole
            ? { id: 'cr-1', tenantId: 'tenant-A', name: 'Custom', isActive: true, ...m.customRole }
            : null,
    });
    const t = await resolveTenantContext({ tenantId: 'tenant-A' }, m.userId);
    return { role: t.role, permissions: t.permissions, appPermissions: t.appPermissions };
}

/** The context the job should act as: what a request from this member gets. */
async function requestContext(m: ReturnType<typeof member>) {
    return { requestId: REQUEST_ID, userId: m.userId, tenantId: 'tenant-A', ...(await requestAuthority(m)) };
}

/** Each coarse flag that differs from the old builder, as `ROLE.flag:before->now`. */
function movedFrom4388(role: Role, ctx: { permissions: Record<string, boolean> }) {
    const before = contextBefore4388('tenant-A', { userId: 'member-1', role }).permissions as Record<string, boolean>;
    return Object.keys(before)
        .filter((flag) => ctx.permissions[flag] !== before[flag])
        .map((flag) => `${role}.${flag}:${before[flag]}->${ctx.permissions[flag]}`);
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

        expect(scannedAs()).toEqual(await requestContext(member('next-admin', 'ADMIN')));
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

        expect(scannedAs()).toEqual(await requestContext(readerBased));
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

describe('a built-in role’s context is what a request from that member gets', () => {
    // The query reads OWNER and ADMIN only; the other four are pinned too, so a
    // change to the rule cannot hide behind the query.
    it.each(BUILT_IN)('%s', async (role) => {
        admins([member('member-1', role)]);

        await runRiskAppetiteMonitor({} as never);

        expect(scannedAs()).toEqual(await requestContext(member('member-1', role)));
    });
});

describe('what moved for a built-in role, against the context the monitor built before #4388', () => {
    it('only canAudit, for EDITOR, READER and AI_ADMIN, from true to a request’s false; nothing for OWNER or ADMIN', async () => {
        const moved: string[] = [];
        for (const role of BUILT_IN) {
            jest.clearAllMocks();
            usecase.checkPortfolioAppetite.mockResolvedValue({ breaches: [] });
            admins([member('member-1', role)]);
            await runRiskAppetiteMonitor({} as never);
            const ctx = scannedAs();
            const before = contextBefore4388('tenant-A', member('member-1', role));
            // The role and the granular set did not move; only coarse flags can.
            expect({ ...ctx, permissions: null }).toEqual({ ...before, permissions: null });
            moved.push(...movedFrom4388(role, ctx));
        }
        expect(moved).toEqual([
            'EDITOR.canAudit:true->false',
            'READER.canAudit:true->false',
            'AI_ADMIN.canAudit:true->false',
        ]);
    });
});
