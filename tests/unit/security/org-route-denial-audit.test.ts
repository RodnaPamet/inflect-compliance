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
const mockCreateWidget = jest.fn();
const mockUpdateWidget = jest.fn();
jest.mock('@/app-layer/usecases/org-dashboard-widgets', () => ({
    deleteOrgDashboardWidget: (...a: unknown[]) => mockDeleteWidget(...a),
    resetOrgDashboardToPreset: (...a: unknown[]) => mockResetWidgets(...a),
    createOrgDashboardWidget: (...a: unknown[]) => mockCreateWidget(...a),
    updateOrgDashboardWidget: (...a: unknown[]) => mockUpdateWidget(...a),
    listOrgDashboardWidgets: jest.fn(),
}));
const mockDeleteInitiative = jest.fn();
const mockUnlinkWork = jest.fn();
const mockCreateInitiative = jest.fn();
const mockUpdateInitiative = jest.fn();
const mockChangeStatus = jest.fn();
const mockLinkWork = jest.fn();
jest.mock('@/app-layer/usecases/org-security-initiative', () => ({
    deleteInitiative: (...a: unknown[]) => mockDeleteInitiative(...a),
    unlinkWork: (...a: unknown[]) => mockUnlinkWork(...a),
    createInitiative: (...a: unknown[]) => mockCreateInitiative(...a),
    updateInitiative: (...a: unknown[]) => mockUpdateInitiative(...a),
    changeInitiativeStatus: (...a: unknown[]) => mockChangeStatus(...a),
    linkWork: (...a: unknown[]) => mockLinkWork(...a),
    getInitiative: jest.fn(),
    getInitiativeProgress: jest.fn(),
    listInitiatives: jest.fn(),
    // Enum consts the route modules import at load time. Omit one and the
    // route's `z.enum(...)` throws on import, which surfaces as a mystery
    // failure in a file that never mentions initiatives.
    INITIATIVE_STATUSES: ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'DONE'],
    INITIATIVE_LINK_TYPES: ['RISK', 'CONTROL', 'TASK'],
}));
const mockSetThreatLevel = jest.fn();
jest.mock('@/app-layer/usecases/org-threat-level', () => ({
    setOrgThreatLevel: (...a: unknown[]) => mockSetThreatLevel(...a),
    getCurrentOrgThreatLevel: jest.fn(),
    ORG_THREAT_TIERS: ['LOW', 'MODERATE', 'ELEVATED', 'SEVERE'],
}));
const mockSetMaturity = jest.fn();
jest.mock('@/app-layer/usecases/org-maturity', () => ({
    setOrgMaturityRating: (...a: unknown[]) => mockSetMaturity(...a),
    getCurrentOrgMaturity: jest.fn(),
    MATURITY_DOMAINS: ['GOVERNANCE'],
    MATURITY_LEVELS: ['INITIAL'],
}));
const mockRevokeInvite = jest.fn();
const mockCreateInvite = jest.fn();
jest.mock('@/app-layer/usecases/org-invites', () => ({
    revokeOrgInvite: (...a: unknown[]) => mockRevokeInvite(...a),
    // Listed because the POST route imports it. This factory names exports one
    // by one, so a route that reaches for one not listed here gets `undefined`
    // and fails somewhere unrelated — adding a row to ROUTES means checking
    // this block too.
    createOrgInviteToken: (...a: unknown[]) => mockCreateInvite(...a),
    listPendingOrgInvites: jest.fn(),
}));
// The invite POST mails the recipient on the AUTHORIZED path. Unmocked it would
// attempt real delivery from a unit test.
jest.mock('@/lib/email/invite-email', () => ({ sendInviteEmail: jest.fn(async () => ({ sent: true })) }));
const mockRemoveMember = jest.fn();
const mockAddMember = jest.fn();
const mockChangeRole = jest.fn();
jest.mock('@/app-layer/usecases/org-members', () => ({
    removeOrgMember: (...a: unknown[]) => mockRemoveMember(...a),
    addOrgMember: (...a: unknown[]) => mockAddMember(...a),
    changeOrgMemberRole: (...a: unknown[]) => mockChangeRole(...a),
    listOrgMembers: jest.fn(),
}));
const mockDeleteTenant = jest.fn();
const mockCreateTenant = jest.fn();
jest.mock('@/app-layer/usecases/org-tenants', () => ({
    deleteTenantUnderOrg: (...a: unknown[]) => mockDeleteTenant(...a),
    createTenantUnderOrg: (...a: unknown[]) => mockCreateTenant(...a),
}));

import { DELETE as widgetDelete } from '@/app/api/org/[orgSlug]/dashboard/widgets/[widgetId]/route';
import { POST as widgetReset } from '@/app/api/org/[orgSlug]/dashboard/widgets/reset/route';
import { DELETE as initiativeDelete } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/route';
import { DELETE as linkDelete } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/links/[linkId]/route';
import { DELETE as inviteDelete } from '@/app/api/org/[orgSlug]/invites/[inviteId]/route';
import {
    DELETE as memberDelete,
    POST as memberAdd,
    PUT as memberRoleChange,
} from '@/app/api/org/[orgSlug]/members/route';
import { POST as inviteCreate } from '@/app/api/org/[orgSlug]/invites/route';
import { POST as tenantCreate } from '@/app/api/org/[orgSlug]/tenants/route';
import { PUT as threatLevelSet } from '@/app/api/org/[orgSlug]/threat-level/route';
import { PUT as maturitySet } from '@/app/api/org/[orgSlug]/maturity/route';
import { POST as initiativeCreate } from '@/app/api/org/[orgSlug]/initiatives/route';
import { PATCH as initiativeUpdate } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/route';
import { PUT as initiativeStatus } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/status/route';
import { POST as initiativeLink } from '@/app/api/org/[orgSlug]/initiatives/[initiativeId]/links/route';
import { POST as widgetCreate } from '@/app/api/org/[orgSlug]/dashboard/widgets/route';
import { PATCH as widgetUpdate } from '@/app/api/org/[orgSlug]/dashboard/widgets/[widgetId]/route';
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
const req = (url: string, method = 'DELETE', body?: unknown): NextRequest =>
    ({
        method,
        nextUrl: new URL(`https://app.example.com${url}`),
        headers: new Headers(),
        // The DENIAL path never calls this — the gate refuses before the body is
        // read, which is itself part of the contract. The paired authorized case
        // does, so the stub has to be real.
        json: async () => body ?? {},
    }) as unknown as NextRequest;

const denialRows = () =>
    mockAppendOrgAuditEntry.mock.calls
        .map((c) => c[0] as { action?: string })
        .filter((e) => e?.action === 'ORG_AUTHZ_DENIED');

const ROUTES: Array<{
    name: string; handler: Handler; url: string; params: Record<string, string>;
    flag: keyof typeof ALL_FALSE; usecase: jest.Mock;
    method?: string; body?: unknown;
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

    // The four the destructive-verb census could never see. `members` is the
    // reason granularity matters: its DELETE above satisfied a whole-file gate
    // check while these two authorized inline.
    { name: 'POST /members', handler: asHandler(memberAdd), method: 'POST',
      body: { userEmail: 'new@corp.example', role: 'ORG_READER' },
      url: '/api/org/acme/members', params: { orgSlug: 'acme' },
      flag: 'canManageMembers', usecase: mockAddMember },
    { name: 'PUT /members (role change — the escalation path)', handler: asHandler(memberRoleChange),
      method: 'PUT', body: { userId: 'u-2', role: 'ORG_ADMIN' },
      url: '/api/org/acme/members', params: { orgSlug: 'acme' },
      flag: 'canManageMembers', usecase: mockChangeRole },
    { name: 'POST /invites', handler: asHandler(inviteCreate), method: 'POST',
      body: { email: 'new@corp.example', role: 'ORG_READER' },
      url: '/api/org/acme/invites', params: { orgSlug: 'acme' },
      flag: 'canManageMembers', usecase: mockCreateInvite },
    { name: 'POST /tenants', handler: asHandler(tenantCreate), method: 'POST',
      body: { name: 'New Co', slug: 'new-co' },
      url: '/api/org/acme/tenants', params: { orgSlug: 'acme' },
      flag: 'canManageTenants', usecase: mockCreateTenant },

    // The eight that had NO route check at all — the usecase assert was the
    // only gate, so a refusal threw an unaudited ForbiddenError. These rows are
    // the whole evidence for that change: nothing else in the suite fails if a
    // gate here is dropped, because the usecase would still refuse.
    { name: 'PUT /threat-level', handler: asHandler(threatLevelSet), method: 'PUT',
      body: { level: 'SEVERE', summary: 'x' },
      url: '/api/org/acme/threat-level', params: { orgSlug: 'acme' },
      flag: 'canSetThreatLevel', usecase: mockSetThreatLevel },
    { name: 'PUT /maturity', handler: asHandler(maturitySet), method: 'PUT',
      body: { domain: 'GOVERNANCE', level: 'INITIAL' },
      url: '/api/org/acme/maturity', params: { orgSlug: 'acme' },
      flag: 'canSetMaturity', usecase: mockSetMaturity },
    { name: 'POST /initiatives', handler: asHandler(initiativeCreate), method: 'POST',
      body: { title: 'Harden SSO' },
      url: '/api/org/acme/initiatives', params: { orgSlug: 'acme' },
      flag: 'canConfigureDashboard', usecase: mockCreateInitiative },
    { name: 'PATCH /initiatives/[initiativeId]', handler: asHandler(initiativeUpdate), method: 'PATCH',
      body: { title: 'Renamed' },
      url: '/api/org/acme/initiatives/i-1', params: { orgSlug: 'acme', initiativeId: 'i-1' },
      flag: 'canConfigureDashboard', usecase: mockUpdateInitiative },
    { name: 'PUT /initiatives/[initiativeId]/status', handler: asHandler(initiativeStatus), method: 'PUT',
      body: { status: 'IN_PROGRESS' },
      url: '/api/org/acme/initiatives/i-1/status', params: { orgSlug: 'acme', initiativeId: 'i-1' },
      flag: 'canConfigureDashboard', usecase: mockChangeStatus },
    { name: 'POST /initiatives/[initiativeId]/links', handler: asHandler(initiativeLink), method: 'POST',
      body: { tenantId: 't-1', entityType: 'RISK', entityId: 'r-1' },
      url: '/api/org/acme/initiatives/i-1/links', params: { orgSlug: 'acme', initiativeId: 'i-1' },
      flag: 'canConfigureDashboard', usecase: mockLinkWork },
    { name: 'POST /dashboard/widgets', handler: asHandler(widgetCreate), method: 'POST',
      // A REAL body: CreateOrgDashboardWidgetInput is the typed shape
      // intersected with the layout fields, so an invented one fails the
      // authorized case while the denial case passes — the gate refuses before
      // parsing, which is exactly the ordering under test.
      body: {
          type: 'ORG_THREAT_LEVEL', chartType: 'banner', config: {},
          position: { x: 0, y: 0 }, size: { w: 4, h: 2 },
      },
      url: '/api/org/acme/dashboard/widgets', params: { orgSlug: 'acme' },
      flag: 'canConfigureDashboard', usecase: mockCreateWidget },
    { name: 'PATCH /dashboard/widgets/[widgetId]', handler: asHandler(widgetUpdate), method: 'PATCH',
      body: { enabled: true },
      url: '/api/org/acme/dashboard/widgets/w-1', params: { orgSlug: 'acme', widgetId: 'w-1' },
      flag: 'canConfigureDashboard', usecase: mockUpdateWidget },
];

beforeEach(() => {
    [mockAppendOrgAuditEntry, mockGetOrgCtx, mockDeleteWidget, mockResetWidgets,
     mockDeleteInitiative, mockUnlinkWork, mockRevokeInvite, mockRemoveMember,
     mockDeleteTenant, mockAddMember, mockChangeRole, mockCreateInvite,
     mockCreateTenant, mockSetThreatLevel, mockSetMaturity, mockCreateInitiative,
     mockUpdateInitiative, mockChangeStatus, mockLinkWork, mockCreateWidget,
     mockUpdateWidget].forEach((m) => m.mockReset());
    mockAppendOrgAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
});

describe.each(ROUTES)('$name', (route) => {
    it('records ORG_AUTHZ_DENIED and never reaches the usecase', async () => {
        mockGetOrgCtx.mockResolvedValue(ctxWith({}));

        // The route export is wrapped in `withApiErrorHandling`, which turns a
        // thrown AppError into an HTTP response — so this RESOLVES with a 403
        // rather than rejecting. The middleware's own suite asserts the throw;
        // here the observable contract is the response.
        const res = await route.handler(req(route.url, route.method, route.body), {
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

        await route.handler(req(route.url, route.method, route.body), {
            params: Promise.resolve(route.params),
        });

        expect(route.usecase).toHaveBeenCalled();
        expect(denialRows()).toHaveLength(0);
    });
});
