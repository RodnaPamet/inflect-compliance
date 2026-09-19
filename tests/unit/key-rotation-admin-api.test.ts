/**
 * Unit Test: Epic B.3 admin key-rotation API route.
 *
 * Focus: route wiring, authz, and rate-limit preset. The actual
 * rotation logic is covered by `key-rotation-job.test.ts`; here we
 * just prove the endpoint:
 *
 *   - Requires ADMIN (rejected with 403 for non-admins).
 *   - Enqueues the 'key-rotation' job with payload carrying the
 *     caller's tenantId + userId.
 *   - Returns 202 + jobId on success.
 *   - Writes an audit entry at initiation time.
 *   - Applies the tighter API_KEY_CREATE_LIMIT rate-limit override
 *     (verified by the 6th call in a short window being 429'd).
 *   - GET returns job state; non-own-tenant jobs return 404.
 *   - POST route uses the withApiErrorHandling rate-limit option;
 *     verified by triggering the limit boundary.
 */

// Enable rate limits inside this test (withApiErrorHandling
// auto-bypasses in NODE_ENV=test otherwise).
const savedRateEnv = process.env.RATE_LIMIT_ENABLED;
beforeAll(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
});
afterAll(() => {
    if (savedRateEnv === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = savedRateEnv;
});

// ── Mocks ───────────────────────────────────────────────────────────

// Epic D.3 — the route migrated from `requireAdminCtx` to
// `requirePermission('admin.manage', …)`, which resolves the context
// via `@/app-layer/context.getTenantCtx`. Mock at the resolver layer:
// returning a non-ADMIN ctx triggers the same 403 path the legacy
// `requireAdminCtx` would have produced.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({

    getTenantCtx: (params: unknown, req: unknown) =>
        getTenantCtxMock(params, req),
}));

// Stub the audit writer so the AUTHZ_DENIED row that
// `requirePermission` writes on denial doesn't try to hit the real DB
// during the denied-path tests.
jest.mock('@/lib/audit', () => ({
    // #2657 — `permission-middleware` now records AUTHZ_DENIED through
    // `appendAuditEntryOrQueue`, which falls back to a durable AuditOutbox
    // row instead of swallowing a failed write. Routed to the SAME spy as
    // `appendAuditEntry` on purpose: these tests assert the ENTRY'S SHAPE,
    // which the change does not alter, so they keep testing what they tested.
    appendAuditEntryOrQueue: jest.fn(async () => ({
        recorded: 'chain' as const,
        auditId: 'audit-x',
    })),
    appendAuditEntry: jest.fn(async () => ({
        id: 'audit-x',
        entryHash: 'hash-x',
        previousHash: null,
    })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enqueueMock = jest.fn<any, [string, unknown]>();
const getQueueMock = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (name: string, payload: unknown) => enqueueMock(name, payload),
    getQueue: () => getQueueMock(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logEventMock = jest.fn<Promise<void>, [unknown, unknown, any]>(
    async () => undefined,
);
jest.mock('@/app-layer/events/audit', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logEvent: (db: unknown, ctx: unknown, payload: any) =>
        logEventMock(db, ctx, payload),
}));

// ─── Imports after mocks ────────────────────────────────────────────

import { NextRequest } from 'next/server';
import {
    POST,
    GET,
} from '@/app/api/t/[tenantSlug]/admin/key-rotation/route';
import {
    clearAllRateLimits,
    API_KEY_CREATE_LIMIT,
} from '@/lib/security/rate-limit-middleware';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Helpers ────────────────────────────────────────────────────────

function adminCtx(overrides: Partial<{
    tenantId: string;
    userId: string;
    requestId: string;
}> = {}) {
    return {
        requestId: overrides.requestId ?? 'req-1',
        userId: overrides.userId ?? 'admin-1',
        tenantId: overrides.tenantId ?? 'tenant-A',
        role: 'ADMIN' as const,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Reader context for the denied-path test. With Epic D.3,
 * `requirePermission('admin.manage', …)` denies based on the
 * resolved `appPermissions` rather than the resolver throwing — so
 * we hand back a non-admin ctx and let the middleware produce 403.
 */
function readerCtx() {
    return {
        requestId: 'req-1',
        userId: 'reader-1',
        tenantId: 'tenant-A',
        role: 'READER' as const,
        permissions: {
            canRead: true,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: getPermissionsForRole('READER'),
    };
}

function req(
    method: string,
    opts: { url?: string; ip?: string } = {},
): NextRequest {
    const headers = new Headers();
    headers.set('x-forwarded-for', opts.ip ?? '1.2.3.4');
    return new NextRequest(
        opts.url ?? 'http://localhost/api/t/acme/admin/key-rotation',
        { method, headers },
    );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('POST /api/t/:tenantSlug/admin/key-rotation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearAllRateLimits();
    });

    test('non-admin is rejected with 403 before any queue interaction', async () => {
        getTenantCtxMock.mockResolvedValueOnce(readerCtx());

        const res = await POST(req('POST'), { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(403);
        expect(enqueueMock).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });

    test('admin → enqueues job + writes audit entry + returns 202', async () => {
        getTenantCtxMock.mockResolvedValueOnce(adminCtx());
        enqueueMock.mockResolvedValueOnce({ id: 'bullmq-job-42' });

        const res = await POST(req('POST'), { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(202);

        // Job enqueued with the right payload shape.
        expect(enqueueMock).toHaveBeenCalledWith('key-rotation', {
            tenantId: 'tenant-A',
            initiatedByUserId: 'admin-1',
            requestId: 'req-1',
        });

        // Audit entry at initiation — lets auditors see who fired it
        // even if the job is later purged from BullMQ.
        expect(logEventMock).toHaveBeenCalledTimes(1);
        const [, , payload] = logEventMock.mock.calls[0];
        expect(payload).toMatchObject({
            action: 'KEY_ROTATION_INITIATED',
            entityType: 'TenantKey',
            entityId: 'tenant-A',
            metadata: { jobId: 'bullmq-job-42' },
        });

        // Response carries the jobId so operators can poll via GET.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                status: 'queued',
                jobId: 'bullmq-job-42',
                tenantId: 'tenant-A',
            }),
        );
    });

    test('applies API_KEY_CREATE_LIMIT (tighter than default)', async () => {
        getTenantCtxMock.mockImplementation(async () => adminCtx());
        enqueueMock.mockResolvedValue({ id: 'job-x' });

        const maxAttempts = API_KEY_CREATE_LIMIT.maxAttempts; // 5
        for (let i = 0; i < maxAttempts; i++) {
            const res = await POST(req('POST'), { params: { tenantSlug: 'acme' } });
            expect(res.status).toBe(202);
        }
        // (max+1)-th request blocked by rate-limit wrapper.
        const blocked = await POST(req('POST'), { params: { tenantSlug: 'acme' } });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await blocked.json();
        expect(body.error.scope).toBe('key-rotation-initiate');
    });
});

describe('GET /api/t/:tenantSlug/admin/key-rotation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearAllRateLimits();
    });

    test('admin + valid jobId → returns state + progress + result', async () => {
        getTenantCtxMock.mockResolvedValueOnce(adminCtx());
        const fakeJob = {
            data: { tenantId: 'tenant-A' },
            getState: jest.fn(async () => 'completed'),
            progress: 100,
            returnvalue: {
                totalScanned: 7,
                totalRewritten: 7,
                totalErrors: 0,
            },
            failedReason: null,
        };
        getQueueMock.mockReturnValueOnce({
            getJob: jest.fn(async () => fakeJob),
        });

        const r = req('GET', {
            url: 'http://localhost/api/t/acme/admin/key-rotation?jobId=job-7',
        });
        const res = await GET(r, { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                jobId: 'job-7',
                state: 'completed',
                progress: 100,
                result: expect.objectContaining({ totalScanned: 7 }),
            }),
        );
    });

    test('missing jobId parameter → 400', async () => {
        getTenantCtxMock.mockResolvedValueOnce(adminCtx());
        const res = await GET(req('GET'), { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(400);
    });

    test('job-from-another-tenant → 404 (no cross-tenant leak)', async () => {
        getTenantCtxMock.mockResolvedValueOnce(adminCtx({ tenantId: 'tenant-A' }));
        getQueueMock.mockReturnValueOnce({
            getJob: jest.fn(async () => ({
                data: { tenantId: 'tenant-B' }, // different tenant
                getState: jest.fn(),
            })),
        });
        const r = req('GET', {
            url: 'http://localhost/api/t/acme/admin/key-rotation?jobId=foreign',
        });
        const res = await GET(r, { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(404);
    });

    test('non-existent jobId → 404', async () => {
        getTenantCtxMock.mockResolvedValueOnce(adminCtx());
        getQueueMock.mockReturnValueOnce({
            getJob: jest.fn(async () => null),
        });
        const r = req('GET', {
            url: 'http://localhost/api/t/acme/admin/key-rotation?jobId=missing',
        });
        const res = await GET(r, { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(404);
    });

    test('non-admin rejected with 403 even before the queue is consulted', async () => {
        getTenantCtxMock.mockResolvedValueOnce(readerCtx());
        const r = req('GET', {
            url: 'http://localhost/api/t/acme/admin/key-rotation?jobId=x',
        });
        const res = await GET(r, { params: { tenantSlug: 'acme' } });
        expect(res.status).toBe(403);
        expect(getQueueMock).not.toHaveBeenCalled();
    });
});
