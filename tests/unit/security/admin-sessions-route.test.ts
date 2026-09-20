/**
 * Epic C.3 — admin sessions route end-to-end test.
 *
 * Drives `GET` and `DELETE` through `withApiErrorHandling` +
 * `requirePermission` so the wiring is exercised exactly as the
 * pre-commit-hook + CI guardrail would catch a regression. Mocks
 * `getTenantCtx`, `prisma`, the audit writer, and the session-tracker
 * helpers; asserts behavior + tenant isolation + denial path.
 */

// ─── Mocks (declared before route imports — Jest hoists `jest.mock`) ───

const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();
const mockListActiveSessionsForTenant = jest.fn();
const mockListActiveSessionsForUserInTenant = jest.fn();
const mockRevokeSessionById = jest.fn();
const mockFindOwnTenantSession = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));

jest.mock('@/lib/audit', () => ({
    // #2657 — `permission-middleware` now records AUTHZ_DENIED through
    // `appendAuditEntryOrQueue`, which falls back to a durable AuditOutbox
    // row instead of swallowing a failed write. Routed to the SAME spy as
    // `appendAuditEntry` on purpose: these tests assert the ENTRY'S SHAPE,
    // which the change does not alter, so they keep testing what they tested.
    appendAuditEntryOrQueue: (...args: unknown[]) => mockAppendAuditEntry(...args),
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));

jest.mock('@/lib/security/session-tracker', () => ({
    listActiveSessionsForTenant: (...args: unknown[]) =>
        mockListActiveSessionsForTenant(...args),
    listActiveSessionsForUserInTenant: (...args: unknown[]) =>
        mockListActiveSessionsForUserInTenant(...args),
    revokeSessionById: (...args: unknown[]) => mockRevokeSessionById(...args),
    // Epic D — the route now delegates the tenant-scope recheck to
    // `findOwnTenantSession` instead of touching prisma directly
    // (no-prisma-in-routes guardrail).
    findOwnTenantSession: (...args: unknown[]) => mockFindOwnTenantSession(...args),
}));

// Stub prisma in case the audit path tries to reach it.
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {},
    prisma: {},
}));

import { GET, DELETE } from '@/app/api/t/[tenantSlug]/admin/sessions/route';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

// ── Fixtures ──

function makeCtx(
    role: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER',
    overrides: Partial<RequestContext> = {},
): RequestContext {
    return {
        requestId: 'req-test',
        userId: 'admin-user',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role,
        permissions: {
            canRead: true,
            canWrite: role === 'ADMIN' || role === 'EDITOR',
            canAdmin: role === 'ADMIN',
            canAudit: role === 'AUDITOR' || role === 'ADMIN',
            canExport: role !== 'READER',
        },
        appPermissions: getPermissionsForRole(role),
        ...overrides,
    };
}

function makeReq(method: string, opts: { body?: unknown; userId?: string } = {}) {
    const sp = new URLSearchParams();
    if (opts.userId) sp.set('userId', opts.userId);
    return {
        method,
        url: `https://app.example.com/api/t/acme/admin/sessions${sp.toString() ? '?' + sp.toString() : ''}`,
        headers: new Headers(),
        nextUrl: {
            pathname: '/api/t/acme/admin/sessions',
            protocol: 'https:',
            host: 'app.example.com',
            searchParams: sp,
        },
        json: async () => opts.body ?? {},
    } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
    mockGetTenantCtx.mockReset();
    mockAppendAuditEntry.mockReset();
    mockListActiveSessionsForTenant.mockReset();
    mockListActiveSessionsForUserInTenant.mockReset();
    mockRevokeSessionById.mockReset();
    mockFindOwnTenantSession.mockReset();
});

// ─── GET /admin/sessions ───────────────────────────────────────────

describe('GET /api/t/:slug/admin/sessions', () => {
    it('returns the tenant active sessions for an ADMIN', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockListActiveSessionsForTenant.mockResolvedValue([
            { sessionId: 's1', userId: 'u1', tenantId: 'tenant-1' },
            { sessionId: 's2', userId: 'u2', tenantId: 'tenant-1' },
        ]);

        const res = await GET(makeReq('GET'), { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(200);
        const body = await res.json() as { sessions: unknown[]; count: number };
        expect(body.count).toBe(2);
        expect(mockListActiveSessionsForTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('returns 403 + audit entry for a READER', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });

        const res = await GET(makeReq('GET'), { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(403);
        expect(mockListActiveSessionsForTenant).not.toHaveBeenCalled();
        const audit = mockAppendAuditEntry.mock.calls[0][0];
        expect(audit.entityId).toBe('admin.members');
        expect(audit.action).toBe('AUTHZ_DENIED');
    });

    it('narrows to a single user when ?userId= is supplied', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockListActiveSessionsForUserInTenant.mockResolvedValue([
            { sessionId: 's1', userId: 'target-user', tenantId: 'tenant-1' },
        ]);

        const res = await GET(
            makeReq('GET', { userId: 'target-user' }),
            { params: { tenantSlug: 'acme' } },
        );
        expect(res.status).toBe(200);
        // The per-user lookup must be tenant-scoped — never a bare
        // userId lookup that could leak cross-tenant rows.
        expect(mockListActiveSessionsForUserInTenant).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            userId: 'target-user',
        });
        expect(mockListActiveSessionsForTenant).not.toHaveBeenCalled();
    });
});

// ─── DELETE /admin/sessions ────────────────────────────────────────

describe('DELETE /api/t/:slug/admin/sessions', () => {
    it('revokes a tenant-scoped session, audits, and returns the affected userId', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        // The route now delegates the tenant-scope recheck to
        // findOwnTenantSession, which only returns the row when it
        // belongs to the calling tenant.
        mockFindOwnTenantSession.mockResolvedValue({
            id: 'row-1',
            userId: 'target-user',
            revokedAt: null,
        });
        mockRevokeSessionById.mockResolvedValue({
            revoked: true,
            sessionId: 'sid-1',
            userId: 'target-user',
        });
        mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });

        const res = await DELETE(
            makeReq('DELETE', { body: { sessionId: 'sid-1', reason: 'stolen device' } }),
            { params: { tenantSlug: 'acme' } },
        );

        expect(res.status).toBe(200);
        const body = await res.json() as { ok: boolean; sessionId: string; userId: string };
        expect(body).toEqual({ ok: true, sessionId: 'sid-1', userId: 'target-user' });

        // Audit shape — the SESSION_REVOKED_BY_ADMIN action carries
        // both target user + revoking user so an auditor can trace
        // who acted on whom.
        const audit = mockAppendAuditEntry.mock.calls.find(
            (c) => c[0]?.action === 'SESSION_REVOKED_BY_ADMIN',
        )?.[0];
        expect(audit).toBeDefined();
        // logEvent maps `entityType` → `entity` on appendAuditEntry.
        expect(audit.entity).toBe('UserSession');
        expect(audit.entityId).toBe('sid-1');
        expect(audit.detailsJson).toMatchObject({
            category: 'access',
            event: 'session_revoked_by_admin',
            targetUserId: 'target-user',
        });
    });

    it('returns 404 when the session belongs to a different tenant (no leak)', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        // findOwnTenantSession returns null when the row's tenantId
        // doesn't match — the route then 404s without leaking whether
        // the id exists in another tenant.
        mockFindOwnTenantSession.mockResolvedValue(null);

        const res = await DELETE(
            makeReq('DELETE', { body: { sessionId: 'sid-foreign' } }),
            { params: { tenantSlug: 'acme' } },
        );
        expect(res.status).toBe(404);
        expect(mockRevokeSessionById).not.toHaveBeenCalled();
    });

    it('returns 404 when the session is already revoked', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));
        mockFindOwnTenantSession.mockResolvedValue({
            id: 'row-1',
            userId: 'target',
            revokedAt: new Date(),
        });

        const res = await DELETE(
            makeReq('DELETE', { body: { sessionId: 'sid-1' } }),
            { params: { tenantSlug: 'acme' } },
        );
        expect(res.status).toBe(404);
        expect(mockRevokeSessionById).not.toHaveBeenCalled();
    });

    it('returns 400 when sessionId is missing', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('ADMIN'));

        const res = await DELETE(
            makeReq('DELETE', { body: {} }),
            { params: { tenantSlug: 'acme' } },
        );
        expect(res.status).toBe(400);
        expect(mockFindOwnTenantSession).not.toHaveBeenCalled();
    });

    it('returns 403 + audit for a READER', async () => {
        mockGetTenantCtx.mockResolvedValue(makeCtx('READER'));
        mockAppendAuditEntry.mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });

        const res = await DELETE(
            makeReq('DELETE', { body: { sessionId: 'sid-1' } }),
            { params: { tenantSlug: 'acme' } },
        );
        expect(res.status).toBe(403);
        expect(mockFindOwnTenantSession).not.toHaveBeenCalled();
        expect(mockRevokeSessionById).not.toHaveBeenCalled();
    });
});
