/**
 * The notification-settings routes carry a route-level permission gate (#4469).
 *
 * `GET`/`PUT /api/t/:slug/notification-settings` called `assertCanAdmin`
 * inline and `POST …/run-job` compared `ctx.role` to OWNER/ADMIN by hand. None
 * used `requirePermission`, so a refusal wrote no AUTHZ_DENIED row; and the
 * paths sit outside `/api/t/:slug/admin/`, so the edge admin gate never ran.
 *
 * What is asserted, per verb:
 *   - every built-in role gets exactly what it got before — OWNER and ADMIN in,
 *     everyone else out — so the gate moved no built-in role;
 *   - a refusal is a 403 that writes AUTHZ_DENIED naming `admin.manage`, and
 *     never reaches the settings read, the write or the job;
 *   - the coarse check still stands behind the key: a custom role that holds
 *     `admin.manage` on a base below ADMIN is still refused.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

const appendAuditEntryOrQueue = jest.fn(async (..._a: unknown[]) => ({ recorded: 'chain' as const, auditId: 'a1' }));
jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: (...a: unknown[]) => appendAuditEntryOrQueue(...a),
    appendAuditEntry: jest.fn(async () => ({ id: 'a1', entryHash: 'h', previousHash: null })),
}));

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})),
}));

const SETTINGS = {
    enabled: true,
    defaultFromName: 'Acme',
    defaultFromEmail: 'grc@acme.test',
    complianceMailbox: null,
    mutedInAppTypes: [],
};
const getSettings = jest.fn(async (..._a: unknown[]) => SETTINGS);
const updateSettings = jest.fn(async (..._a: unknown[]) => SETTINGS);
const getStats = jest.fn(async (..._a: unknown[]) => ({
    last24h: { pending: 0, sent: 0, failed: 0 },
    last7d: { pending: 0, sent: 0, failed: 0 },
    last30d: { pending: 0, sent: 0, failed: 0 },
}));
jest.mock('@/app-layer/notifications/settings', () => ({
    getTenantNotificationSettings: (...a: unknown[]) => getSettings(...a),
    updateTenantNotificationSettings: (...a: unknown[]) => updateSettings(...a),
    getOutboxStats: (...a: unknown[]) => getStats(...a),
}));

const processOutbox = jest.fn(async (..._a: unknown[]) => ({ sent: 1, failed: 0, skipped: 0 }));
jest.mock('@/app-layer/notifications/processOutbox', () => ({
    processOutbox: (...a: unknown[]) => processOutbox(...a),
}));
const runDailySweep = jest.fn(async (..._a: unknown[]) => ({
    sweeps: {
        days30: { scanned: 0, tasksCreated: 0, skippedDuplicate: 0 },
        days7: { scanned: 0, tasksCreated: 0, skippedDuplicate: 0 },
        days1: { scanned: 0, tasksCreated: 0, skippedDuplicate: 0 },
    },
    outbox: { sent: 0, failed: 0, skipped: 0 },
}));
jest.mock('@/app-layer/jobs/dailyEvidenceExpiry', () => ({
    runDailyEvidenceExpiryNotifications: (...a: unknown[]) => runDailySweep(...a),
}));

import { NextRequest } from 'next/server';
import type { Role } from '@prisma/client';
import { GET, PUT } from '@/app/api/t/[tenantSlug]/notification-settings/route';
import { POST } from '@/app/api/t/[tenantSlug]/notification-settings/run-job/route';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';

const ADMIN_TIER: readonly Role[] = ['OWNER', 'ADMIN'];
const BUILT_IN_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'];

/** A context as `getTenantCtx` builds it: the coarse tier from the effective role. */
function ctxFor(role: Role, appPermissions: PermissionSet = getPermissionsForRole(role)) {
    return {
        requestId: 'req-1',
        userId: `${role.toLowerCase()}-1`,
        tenantId: 'tenant-A',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: ['OWNER', 'ADMIN', 'EDITOR'].includes(role),
            canAdmin: ADMIN_TIER.includes(role),
            canAudit: role === 'AUDITOR' || ADMIN_TIER.includes(role),
            canExport: true,
        },
        appPermissions,
    };
}

const args = { params: Promise.resolve({ tenantSlug: 'acme' }) };
const URL_SETTINGS = 'http://localhost/api/t/acme/notification-settings';
const URL_RUN = 'http://localhost/api/t/acme/notification-settings/run-job';

type Call = { name: string; call: () => Promise<Response>; reached: () => jest.Mock };
const CALLS: Call[] = [
    {
        name: 'GET notification-settings',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        call: () => GET(new NextRequest(URL_SETTINGS, { method: 'GET' }), args as any),
        reached: () => getSettings,
    },
    {
        name: 'PUT notification-settings',
        call: () => PUT(
            new NextRequest(URL_SETTINGS, { method: 'PUT', body: JSON.stringify({ enabled: false }) }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args as any,
        ),
        reached: () => updateSettings,
    },
    {
        name: 'POST run-job',
        call: () => POST(
            new NextRequest(URL_RUN, { method: 'POST', body: JSON.stringify({ jobType: 'processOutbox' }) }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args as any,
        ),
        reached: () => processOutbox,
    },
];

beforeEach(() => jest.clearAllMocks());

function authzDeniedRows() {
    return appendAuditEntryOrQueue.mock.calls
        .map(([entry]) => entry as { action: string; entityId: string })
        .filter((e) => e.action === 'AUTHZ_DENIED');
}

describe.each(CALLS)('$name', ({ call, reached }) => {
    it.each(BUILT_IN_ROLES)('built-in %s: admitted exactly when it is OWNER or ADMIN', async (role) => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor(role));

        const res = await call();

        if (ADMIN_TIER.includes(role)) {
            expect(res.status).toBe(200);
            expect(reached()).toHaveBeenCalledTimes(1);
            expect(authzDeniedRows()).toHaveLength(0);
        } else {
            expect(res.status).toBe(403);
            expect(reached()).not.toHaveBeenCalled();
            // The route-level gate's own record — the reason it exists.
            expect(authzDeniedRows()).toEqual([expect.objectContaining({ entityId: 'admin.manage' })]);
        }
    });

    it('a custom role holding admin.manage on an EDITOR base is still refused', async () => {
        const editor = getPermissionsForRole('EDITOR');
        getTenantCtxMock.mockResolvedValueOnce(
            ctxFor('EDITOR', { ...editor, admin: { ...editor.admin, manage: true } }),
        );

        const res = await call();

        expect(res.status).toBe(403);
        expect(reached()).not.toHaveBeenCalled();
    });

    it('a custom role on an ADMIN base with admin.manage switched off is refused, and audited', async () => {
        const admin = getPermissionsForRole('ADMIN');
        getTenantCtxMock.mockResolvedValueOnce(
            ctxFor('ADMIN', { ...admin, admin: { ...admin.admin, manage: false } }),
        );

        const res = await call();

        expect(res.status).toBe(403);
        expect(reached()).not.toHaveBeenCalled();
        expect(authzDeniedRows()).toHaveLength(1);
    });
});

describe('POST run-job', () => {
    it('runs the daily sweep for this workspace only', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));
        const res = await POST(
            new NextRequest(URL_RUN, { method: 'POST', body: JSON.stringify({ jobType: 'dailySweep' }) }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args as any,
        );
        expect(res.status).toBe(200);
        expect(runDailySweep).toHaveBeenCalledWith({ tenantId: 'tenant-A' });
    });

    it('refuses an unknown job with a 400 and runs nothing', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));
        const res = await POST(
            new NextRequest(URL_RUN, { method: 'POST', body: JSON.stringify({ jobType: 'dropTables' }) }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args as any,
        );
        expect(res.status).toBe(400);
        expect(processOutbox).not.toHaveBeenCalled();
        expect(runDailySweep).not.toHaveBeenCalled();
    });
});

describe('ROUTE_PERMISSIONS agrees with the handlers', () => {
    it.each([
        ['/api/t/acme/notification-settings', 'GET'],
        ['/api/t/acme/notification-settings', 'PUT'],
        ['/api/t/acme/notification-settings/run-job', 'POST'],
    ])('%s %s → admin.manage', (path, method) => {
        expect(resolveRoutePermission(path, method)?.permission).toBe('admin.manage');
    });
});
