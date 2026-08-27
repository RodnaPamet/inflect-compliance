/**
 * Each destructive org route refuses through the gate, so the refusal is
 * RECORDED — not merely returned.
 *
 * The middleware's own suite proves `requireOrgPermission` writes the row.
 * This proves each route actually goes through it, by invoking the real route
 * export and asserting on what reached the audit writer. The census guard
 * pins the same fact structurally; this is the behavioural half, and it is the
 * one that would fail if a route kept its inline check while still importing
 * the gate.
 */
import type { NextRequest } from 'next/server';

const mockAppendOrgAuditEntry = jest.fn();
jest.mock('@/lib/audit/org-audit-writer', () => ({
    appendOrgAuditEntry: (...a: unknown[]) => mockAppendOrgAuditEntry(...a),
}));

const mockGetOrgCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({ getOrgCtx: (...a: unknown[]) => mockGetOrgCtx(...a) }));

jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Usecases must never be reached on a denial — mocked so a leak is visible.
const mockDeleteWidget = jest.fn();
const mockResetWidgets = jest.fn();
jest.mock('@/app-layer/usecases/org-dashboard-widgets', () => ({
    deleteOrgDashboardWidget: (...a: unknown[]) => mockDeleteWidget(...a),
    resetOrgDashboardToPreset: (...a: unknown[]) => mockResetWidgets(...a),
    updateOrgDashboardWidget: jest.fn(),
    listOrgDashboardWidgets: jest.fn(),
}));
const mockDeleteInitiative = jest.fn();
const mockUnlinkWork = jest.fn();
jest.mock('@/app-layer/usecases/org-security-initiative', () => ({
    deleteInitiative: (...a: unknown[]) => mockDeleteInitiative(...a),
    unlinkWork: (...a: unknown[]) => mockUnlinkWork(...a),
    getInitiative: jest.fn(),
    updateInitiative: jest.fn(),
    getInitiativeProgress: jest.fn(),
}));
const mockRevokeInvite = jest.fn();
jest.mock('@/app-layer/usecases/org-invites', () => ({
    revokeOrgInvite: (...a: unknown[]) => mockRevokeInvite(...a),
}));
const mockRemoveMember = jest.fn();
jest.mock('@/app-layer/usecases/org-members', () => ({
    removeOrgMember: (...a: unknown[]) => mockRemoveMember(...a),
    addOrgMember: jest.fn(),
    changeOrgMemberRole: jest.fn(),
    listOrgMembers: jest.fn(),
}));
const mockDeleteTenant = jest.fn();
jest.mock('@/app-layer/usecases/org-tenants', () => ({
    deleteTenantUnderOrg: (...a: unknown[]) => mockDeleteTenant(...a),
}));

import { DELETE as widgetDelete } from '@/app/api/org/[orgSlug]/dashboard/widgets/[widgetId]/route';
import { POST as widgetReset } from '@/app/api/org/[orgSlug]/dashboard/widgets/reset/route';
import { DELETE as initiativeDelete } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/route';
import { DELETE as linkDelete } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/links/[linkId]/route';
import { DELETE as inviteDelete } from '@/app/api/org/[orgSlug]/invites/[inviteId]/route';
import { DELETE as memberDelete } from '@/app/api/org/[orgSlug]/members/route';
import { DELETE as tenantDelete } from '@/app/api/org/[orgSlug]/tenants/[tenantId]/route';

type Handler = (req: NextRequest, args: { params: unknown }) => Promise<Response>;
const asHandler = (h: unknown): Handler => h as Handler;

const ALL_FALSE = {
    canViewPortfolio: false, canDrillDown: false, canExportReports: false,
    canManageTenants: false, canManageMembers: false, canConfigureDashboard: false,
    canSetThreatLevel: false, canSetMaturity: false,
};

const ctxWith = (flags: Partial<typeof ALL_FALSE>) => ({
    requestId: 'req-1', userId: 'user-1', organizationId: 'org-1',
    orgSlug: 'acme', orgRole: 'ORG_READER',
    permissions: { ...ALL_FALSE, ...flags },
});

/**
 * `withApiErrorHandling` reads `req.headers.get('x-request-id')` before the
 * inner handler runs, so a bare `{ method, nextUrl }` stub is not enough — the
 * wrapper is part of the route export under test.
 */
const req = (url: string, method = 'DELETE'): NextRequest =>
    ({
        method,
        nextUrl: new URL(`https://app.example.com${url}`),
        headers: new Headers(),
    }) as unknown as NextRequest;

const denialRows = () =>
    mockAppendOrgAuditEntry.mock.calls
        .map((c) => c[0] as { action?: string })
        .filter((e) => e?.action === 'ORG_AUTHZ_DENIED');

const ROUTES: Array<{
    name: string; handler: Handler; url: string; params: Record<string, string>;
    flag: keyof typeof ALL_FALSE; usecase: jest.Mock;
}> = [
    { name: 'DELETE /dashboard/widgets/[widgetId]', handler: asHandler(widgetDelete),
      url: '/api/org/acme/dashboard/widgets/w-1', params: { orgSlug: 'acme', widgetId: 'w-1' },
      flag: 'canConfigureDashboard', usecase: mockDeleteWidget },
    { name: 'POST /dashboard/widgets/reset', handler: asHandler(widgetReset),
      url: '/api/org/acme/dashboard/widgets/reset', params: { orgSlug: 'acme' },
      flag: 'canConfigureDashboard', usecase: mockResetWidgets },
    { name: 'DELETE /initiatives/[initiativeId]', handler: asHandler(initiativeDelete),
      url: '/api/org/acme/initiatives/i-1', params: { orgSlug: 'acme', initiativeId: 'i-1' },
      flag: 'canConfigureDashboard', usecase: mockDeleteInitiative },
    { name: 'DELETE /initiatives/[initiativeId]/links/[linkId]', handler: asHandler(linkDelete),
      url: '/api/org/acme/initiatives/i-1/links/l-1',
      params: { orgSlug: 'acme', initiativeId: 'i-1', linkId: 'l-1' },
      flag: 'canConfigureDashboard', usecase: mockUnlinkWork },
    { name: 'DELETE /invites/[inviteId]', handler: asHandler(inviteDelete),
      url: '/api/org/acme/invites/inv-1', params: { orgSlug: 'acme', inviteId: 'inv-1' },
      flag: 'canManageMembers', usecase: mockRevokeInvite },
    { name: 'DELETE /members', handler: asHandler(memberDelete),
      url: '/api/org/acme/members?userId=u-2', params: { orgSlug: 'acme' },
      flag: 'canManageMembers', usecase: mockRemoveMember },
    { name: 'DELETE /tenants/[tenantId]', handler: asHandler(tenantDelete),
      url: '/api/org/acme/tenants/t-1', params: { orgSlug: 'acme', tenantId: 't-1' },
      flag: 'canManageTenants', usecase: mockDeleteTenant },
];

beforeEach(() => {
    [mockAppendOrgAuditEntry, mockGetOrgCtx, mockDeleteWidget, mockResetWidgets,
     mockDeleteInitiative, mockUnlinkWork, mockRevokeInvite, mockRemoveMember,
     mockDeleteTenant].forEach((m) => m.mockReset());
    mockAppendOrgAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
});

describe.each(ROUTES)('$name', (route) => {
    it('records ORG_AUTHZ_DENIED and never reaches the usecase', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxWith({}));

        // The route export is wrapped in `withApiErrorHandling`, which turns a
        // thrown AppError into an HTTP response — so this RESOLVES with a 403
        // rather than rejecting. The middleware's own suite asserts the throw;
        // here the observable contract is the response.
        const res = await route.handler(req(route.url), {
            params: Promise.resolve(route.params),
        });
        expect(res.status).toBe(403);

        expect(route.usecase).not.toHaveBeenCalled();
        const rows = denialRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ organizationId: 'org-1', actorUserId: 'user-1' });
    });

    it('an authorized caller reaches the usecase and nothing is recorded', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxWith({ [route.flag]: true }));
        route.usecase.mockResolvedValue({ ok: true, tenant: {}, deprovision: null });

        await route.handler(req(route.url), { params: Promise.resolve(route.params) });

        expect(route.usecase).toHaveBeenCalled();
        expect(denialRows()).toHaveLength(0);
    });
});
