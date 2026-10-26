/**
 * The daily compliance-posture summary is generated as the tenant's most
 * senior active member whose RESOLVED authority, custom role included, passes
 * the reads the summary makes (#4388, owner decision 2026-10-26).
 *
 * It took the most senior member by built-in role and gave them that role's
 * permissions, so a custom role on that member was ignored, and one withholding
 * `frameworks.view` made the job throw at its framework read. Now:
 *   - such a member is passed over for the next one;
 *   - nobody qualifying is a named reason in the job's result and a warn log;
 *   - every member's context, built-in roles included, is what a request from
 *     them resolves to (owner decision 2026-10-26, as #4375 did for initiator
 *     jobs). This job can pick any role, and its old projection gave EDITOR,
 *     READER and AI_ADMIN a `canAudit` a request does not; that is the one
 *     thing that moved, and nothing on this job's path reads it.
 *
 * `findFirst` answers as the old query did (the first of the same rows), so
 * every test here also runs meaningfully against the code before the fix.
 */
const prismaMock = {
    tenant: { findMany: jest.fn(), findUnique: jest.fn() },
    tenantMembership: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const posture = { generateCompliancePostureSummary: jest.fn() };
jest.mock('@/app-layer/usecases/compliance-posture', () => posture);

jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

const warnMock = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: (...a: unknown[]) => warnMock(...a), error: jest.fn(), debug: jest.fn() },
}));

import type { Role } from '@prisma/client';
import { runCompliancePostureSummary } from '@/app-layer/jobs/compliance-posture-summary';
import { resolveTenantContext } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';

const BUILT_IN: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'];
const ADMIN = getPermissionsForRole('ADMIN');
const EDITOR = getPermissionsForRole('EDITOR');

/** An ADMIN-based custom role that withholds `frameworks.view`. */
const withoutFrameworksView = {
    baseRole: 'ADMIN' as Role,
    permissionsJson: { frameworks: { ...ADMIN.frameworks, view: false } },
};

const member = (userId: string, role: Role, customRole: { baseRole: Role; permissionsJson: unknown } | null = null) => ({
    userId,
    role,
    customRole,
});

/** The tenant's active members, most senior first, as the query returns them. */
function members(rows: ReturnType<typeof member>[]) {
    prismaMock.tenantMembership.findMany.mockResolvedValue(rows);
    prismaMock.tenantMembership.findFirst.mockResolvedValue(rows[0] ?? null);
}

/** The context the summary was generated as. */
const generatedAs = () => posture.generateCompliancePostureSummary.mock.calls[0]?.[0];

/** The context the job built before #4388, for a membership with no custom role. */
function contextBefore4388(tenantId: string, m: { userId: string; role: Role }) {
    const appPermissions = getPermissionsForRole(m.role);
    return {
        requestId: `compliance-posture-${tenantId}`,
        userId: m.userId,
        tenantId,
        role: m.role,
        permissions: {
            canRead: appPermissions.controls.view,
            canWrite: appPermissions.controls.create,
            canAdmin: appPermissions.admin.manage,
            canAudit: appPermissions.audits.view,
            canExport: appPermissions.reports.export,
        },
        appPermissions,
    };
}

const REQUEST_ID = 'compliance-posture-tenant-A';

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

const run = () => runCompliancePostureSummary({ tenantId: 'tenant-A' } as never);

beforeEach(() => {
    jest.clearAllMocks();
    posture.generateCompliancePostureSummary.mockResolvedValue({
        provider: 'stub',
        postureLabel: 'DEVELOPING',
        isFallback: false,
    });
});

describe('the summary is generated as the most senior member whose resolved permissions pass its reads', () => {
    it('passes over a most senior member whose custom role withholds frameworks.view, for the next one', async () => {
        members([member('senior-custom-admin', 'ADMIN', withoutFrameworksView), member('next-editor', 'EDITOR')]);

        await expect(run()).resolves.toMatchObject({ generated: true });

        expect(generatedAs()).toEqual(await requestContext(member('next-editor', 'EDITOR')));
        expect(prismaMock.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 'tenant-A', status: 'ACTIVE' }, orderBy: { role: 'asc' } }),
        );
    });

    it('acts with the custom role a request from that member would carry', async () => {
        const narrowed = member('custom-editor', 'EDITOR', {
            baseRole: 'EDITOR',
            permissionsJson: { controls: { ...EDITOR.controls, create: false } },
        });
        members([narrowed]);

        await run();

        expect(generatedAs()).toEqual(await requestContext(narrowed));
        expect(generatedAs().appPermissions.controls.create).toBe(false);
    });
});

describe('nobody to generate the summary as is a named reason, never a silent skip', () => {
    it('NO_MEMBER_WITH_POSTURE_READS when every member’s custom role withholds a read', async () => {
        members([member('custom-admin', 'ADMIN', withoutFrameworksView)]);

        await expect(run()).resolves.toEqual({
            tenantId: 'tenant-A',
            generated: false,
            reason: 'NO_MEMBER_WITH_POSTURE_READS',
        });

        expect(posture.generateCompliancePostureSummary).not.toHaveBeenCalled();
        expect(warnMock).toHaveBeenCalledWith(
            'compliance-posture-summary: no member to generate the summary as, skipping',
            expect.objectContaining({ tenantId: 'tenant-A', reason: 'NO_MEMBER_WITH_POSTURE_READS' }),
        );
    });

    it('NO_ACTIVE_MEMBER when the tenant has no active member', async () => {
        members([]);

        await expect(run()).resolves.toEqual({ tenantId: 'tenant-A', generated: false, reason: 'NO_ACTIVE_MEMBER' });
        expect(warnMock).toHaveBeenCalledWith(
            'compliance-posture-summary: no member to generate the summary as, skipping',
            expect.objectContaining({ reason: 'NO_ACTIVE_MEMBER' }),
        );
    });
});

describe('a built-in role’s context is what a request from that member gets', () => {
    it.each(BUILT_IN)('%s', async (role) => {
        members([member('member-1', role)]);

        await run();

        expect(generatedAs()).toEqual(await requestContext(member('member-1', role)));
    });
});

describe('what moved for a built-in role, against the context the job built before #4388', () => {
    it('only canAudit, for EDITOR, READER and AI_ADMIN, from true to a request’s false (owner decision 2026-10-26)', async () => {
        const moved: string[] = [];
        for (const role of BUILT_IN) {
            jest.clearAllMocks();
            posture.generateCompliancePostureSummary.mockResolvedValue({ provider: 'stub', postureLabel: 'DEVELOPING' });
            members([member('member-1', role)]);
            await run();
            const ctx = generatedAs();
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
