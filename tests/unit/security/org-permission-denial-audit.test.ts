/**
 * A refused org request must leave evidence.
 *
 * Before `requireOrgPermission`, the seven destructive `/api/org/**` routes
 * resolved `getOrgCtx`, checked a flag inline, and threw `forbidden(...)` —
 * recording nothing. A blocked attempt to remove an org member or detach a
 * tenant was invisible (#2147).
 *
 * These are BEHAVIOURAL: they invoke the gate and assert on what reached the
 * audit writer, rather than checking that the source contains a string. A
 * structural test would pass while no row is written, which is the exact
 * defect under repair.
 */
import type { NextRequest } from 'next/server';

const mockAppendOrgAuditEntry = jest.fn();
jest.mock('@/lib/audit/org-audit-writer', () => ({
    appendOrgAuditEntry: (...a: unknown[]) => mockAppendOrgAuditEntry(...a),
}));

const mockGetOrgCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getOrgCtx: (...a: unknown[]) => mockGetOrgCtx(...a),
}));

jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { requireOrgPermission } from '@/lib/security/org-permission-middleware';

type Flags = Record<string, boolean>;

const ALL_FALSE: Flags = {
    canViewPortfolio: false,
    canDrillDown: false,
    canExportReports: false,
    canManageTenants: false,
    canManageMembers: false,
    canConfigureDashboard: false,
    canSetThreatLevel: false,
    canSetMaturity: false,
};

const orgCtx = (overrides: Flags = {}) => ({
    requestId: 'req-1',
    userId: 'user-1',
    organizationId: 'org-1',
    orgSlug: 'acme',
    orgRole: 'ORG_READER',
    permissions: { ...ALL_FALSE, ...overrides },
});

const req = (method = 'DELETE'): NextRequest =>
    ({
        method,
        nextUrl: new URL('https://app.example.com/api/org/acme/members'),
    }) as unknown as NextRequest;

const routeArgs = { params: Promise.resolve({ orgSlug: 'acme' }) };

/** Rows the gate actually wrote. */
const deniedRows = () =>
    mockAppendOrgAuditEntry.mock.calls
        .map((c) => c[0] as { action?: string })
        .filter((e) => e?.action === 'ORG_AUTHZ_DENIED');

beforeEach(() => {
    mockAppendOrgAuditEntry.mockReset();
    mockAppendOrgAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
    mockGetOrgCtx.mockReset();
});

describe('requireOrgPermission records refusals', () => {
    it('a caller WITHOUT the flag is refused and the denial is recorded', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtx({ canManageMembers: false }));
        const handler = jest.fn();
        const route = requireOrgPermission('canManageMembers', handler);

        await expect(route(req(), routeArgs)).rejects.toMatchObject({ name: 'ForbiddenError', status: 403 });

        expect(handler).not.toHaveBeenCalled();
        const rows = deniedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            organizationId: 'org-1',
            actorUserId: 'user-1',
            action: 'ORG_AUTHZ_DENIED',
        });
    });

    it('the recorded row carries the flag, role, method and path', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtx());
        const route = requireOrgPermission('canManageTenants', jest.fn());
        await expect(route(req('DELETE'), routeArgs)).rejects.toBeDefined();

        const details = (deniedRows()[0] as { detailsJson?: Record<string, unknown> })?.detailsJson;
        expect(details).toMatchObject({
            permissionKeys: ['canManageTenants'],
            orgRole: 'ORG_READER',
            method: 'DELETE',
            path: '/api/org/acme/members',
        });
    });

    it('an authorized caller reaches the handler and NOTHING is recorded', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtx({ canManageMembers: true }));
        const handler = jest.fn().mockResolvedValue(new Response('ok'));
        const route = requireOrgPermission('canManageMembers', handler);

        await route(req(), routeArgs);

        expect(handler).toHaveBeenCalled();
        // A denial row on a permitted request would be worse than none: it
        // would make the audit trail assert something that did not happen.
        expect(deniedRows()).toHaveLength(0);
    });

    it('the 403 does not echo which permission was missing', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtx());
        const route = requireOrgPermission('canSetThreatLevel', jest.fn());
        await expect(route(req(), routeArgs)).rejects.toMatchObject({
            message: expect.not.stringContaining('canSetThreatLevel'),
        });
    });

    it('a failed audit write does not turn a correct 403 into a 500', async () => {
        // The caller is being denied either way. Failing the request because
        // the audit write failed would convert a correct refusal into an
        // error — the tenant gate is best-effort for the same reason.
        mockGetOrgCtx.mockResolvedValue(orgCtx());
        mockAppendOrgAuditEntry.mockRejectedValue(new Error('db down'));
        const route = requireOrgPermission('canManageMembers', jest.fn());
        await expect(route(req(), routeArgs)).rejects.toMatchObject({ name: 'ForbiddenError', status: 403 });
    });

    it('every required flag must be held, not just one', async () => {
        mockGetOrgCtx.mockResolvedValue(orgCtx({ canManageMembers: true }));
        const route = requireOrgPermission(['canManageMembers', 'canManageTenants'], jest.fn());
        await expect(route(req(), routeArgs)).rejects.toMatchObject({ name: 'ForbiddenError', status: 403 });
        expect(deniedRows()).toHaveLength(1);
    });
});
