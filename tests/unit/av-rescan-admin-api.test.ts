/**
 * Unit test: the `av-rescan` admin trigger route.
 *
 * The job it enqueues has its own suites (`av-rescan-job`,
 * `av-rescan-backoff`). What is proved here is the thing that did not
 * exist until this route did — that there IS a production path which
 * starts a run, and that the path cannot be talked into more than the
 * job allows:
 *
 *   - OWNER may fire it; ADMIN may NOT. The route sits at
 *     `admin.tenant_lifecycle`, the OWNER-only key the AV subsystem's
 *     other admin route (clear-quarantine) uses. An ADMIN passing would
 *     be the regression, so ADMIN is asserted explicitly rather than
 *     leaning on a READER case that any gate would refuse.
 *   - The payload's `tenantId` / `initiatedByUserId` come from ctx and
 *     cannot be supplied by the caller — the strict schema turns the
 *     attempt into a 400 instead of a silent strip.
 *   - `limit` is bounded at the JOB's own ceiling, asserted against the
 *     imported `AV_RESCAN_MAX_LIMIT` so the two cannot drift apart
 *     without this failing.
 *   - Enqueue goes through the typed `enqueue()` wrapper, which is what
 *     applies `JOB_DEFAULTS['av-rescan']` (`attempts: 1`). The hand-run
 *     that motivated this route used a raw `queue.add` and had to
 *     restate those defaults by hand.
 *   - `AV_SCAN_MODE=disabled` is refused HERE, with a reason. The job
 *     also refuses, but it does so by returning all-zero counters, which
 *     from the caller's side is indistinguishable from "already drained".
 */

// Rate limits auto-bypass in NODE_ENV=test; turn them on so the
// preset override is actually exercised.
const savedRateEnv = process.env.RATE_LIMIT_ENABLED;
beforeAll(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
});
afterAll(() => {
    if (savedRateEnv === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = savedRateEnv;
});

// ── Mocks (declared before the imports that consume them) ───────────

// `requirePermission` resolves the caller's context through this, so
// handing back a role is how each authz case is set up.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on a denial must not
// reach a real database from a unit test.
jest.mock('@/lib/audit', () => ({
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

// Mutated per test; the route reads `env.AV_SCAN_MODE` at call time.
const mockEnv: { AV_SCAN_MODE: string } = { AV_SCAN_MODE: 'strict' };
jest.mock('@/env', () => ({ env: mockEnv }));

// The route imports the two bounds from the job module. Stubbing the
// module would let the route's cap drift from the job's, which is the
// exact failure the `.max()` is there to prevent — so the real values
// are used, with the heavy scan machinery stubbed out beneath them.
jest.mock('@/lib/storage', () => ({ getProviderByName: jest.fn() }));
jest.mock('@/lib/storage/av-scan', () => ({ scanBuffer: jest.fn() }));

// ── Imports after mocks ─────────────────────────────────────────────

import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/api/t/[tenantSlug]/admin/av-rescan/route';
import {
    clearAllRateLimits,
    API_KEY_CREATE_LIMIT,
} from '@/lib/security/rate-limit-middleware';
import { getPermissionsForRole } from '@/lib/permissions';
import {
    AV_RESCAN_DEFAULT_LIMIT,
    AV_RESCAN_MAX_LIMIT,
} from '@/app-layer/jobs/av-rescan';
import type { Role } from '@prisma/client';

// ── Helpers ─────────────────────────────────────────────────────────

function ctxFor(role: Role, overrides: { tenantId?: string; userId?: string } = {}) {
    const perms = getPermissionsForRole(role);
    return {
        requestId: 'req-1',
        userId: overrides.userId ?? `${role.toLowerCase()}-1`,
        tenantId: overrides.tenantId ?? 'tenant-A',
        role,
        permissions: {
            canRead: true,
            canWrite: role !== 'READER',
            canAdmin: perms.admin.manage,
            canAudit: true,
            canExport: true,
        },
        appPermissions: perms,
    };
}

function req(
    method: string,
    opts: { url?: string; body?: string; ip?: string } = {},
): NextRequest {
    const headers = new Headers();
    headers.set('x-forwarded-for', opts.ip ?? '1.2.3.4');
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    return new NextRequest(
        opts.url ?? 'http://localhost/api/t/acme/admin/av-rescan',
        { method, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) },
    );
}

const ROUTE_ARGS = { params: { tenantSlug: 'acme' } };

beforeEach(() => {
    jest.clearAllMocks();
    clearAllRateLimits();
    mockEnv.AV_SCAN_MODE = 'strict';
});

// ── Authorisation ───────────────────────────────────────────────────

describe('POST /api/t/:tenantSlug/admin/av-rescan — authorisation', () => {
    test('OWNER is accepted — the positive half of the gate', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        enqueueMock.mockResolvedValueOnce({ id: 'job-1' });

        const res = await POST(req('POST'), ROUTE_ARGS);

        expect(res.status).toBe(202);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    test.each(['ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const)(
        '%s is refused with 403 and nothing is enqueued',
        async (role) => {
            getTenantCtxMock.mockResolvedValueOnce(ctxFor(role));

            const res = await POST(req('POST'), ROUTE_ARGS);

            expect(res.status).toBe(403);
            expect(enqueueMock).not.toHaveBeenCalled();
            expect(logEventMock).not.toHaveBeenCalled();
        },
    );

    test('ADMIN genuinely lacks the key this route uses (not a stale role model)', () => {
        // Pins WHY the ADMIN case above is a 403. If a future change
        // granted ADMIN `tenant_lifecycle`, that test would still pass
        // for the wrong reason unless this one fails alongside it.
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
    });
});

// ── Payload construction ────────────────────────────────────────────

describe('POST /api/t/:tenantSlug/admin/av-rescan — payload', () => {
    test('no body → enqueues with ctx identity and no limit key at all', async () => {
        getTenantCtxMock.mockResolvedValueOnce(
            ctxFor('OWNER', { tenantId: 'tenant-A', userId: 'owner-7' }),
        );
        enqueueMock.mockResolvedValueOnce({ id: 'job-2' });

        const res = await POST(req('POST'), ROUTE_ARGS);
        expect(res.status).toBe(202);

        // Job name and payload exactly — an absent `limit` must not be
        // sent as `undefined`, so the job applies its own default.
        expect(enqueueMock).toHaveBeenCalledWith('av-rescan', {
            tenantId: 'tenant-A',
            initiatedByUserId: 'owner-7',
            requestId: 'req-1',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                status: 'queued',
                jobId: 'job-2',
                tenantId: 'tenant-A',
                limit: AV_RESCAN_DEFAULT_LIMIT,
                maxLimit: AV_RESCAN_MAX_LIMIT,
            }),
        );
    });

    test('explicit limit is forwarded to the job', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        enqueueMock.mockResolvedValueOnce({ id: 'job-3' });

        const res = await POST(req('POST', { body: JSON.stringify({ limit: 50 }) }), ROUTE_ARGS);

        expect(res.status).toBe(202);
        expect(enqueueMock).toHaveBeenCalledWith(
            'av-rescan',
            expect.objectContaining({ limit: 50 }),
        );
    });

    test('a limit at the job ceiling is accepted; one past it is a 400', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('OWNER'));
        enqueueMock.mockResolvedValue({ id: 'job-4' });

        const atCap = await POST(
            req('POST', { body: JSON.stringify({ limit: AV_RESCAN_MAX_LIMIT }) }),
            ROUTE_ARGS,
        );
        expect(atCap.status).toBe(202);
        expect(enqueueMock).toHaveBeenCalledWith(
            'av-rescan',
            expect.objectContaining({ limit: AV_RESCAN_MAX_LIMIT }),
        );

        enqueueMock.mockClear();

        const overCap = await POST(
            req('POST', { body: JSON.stringify({ limit: AV_RESCAN_MAX_LIMIT + 1 }) }),
            ROUTE_ARGS,
        );
        expect(overCap.status).toBe(400);
        // Refused, not silently clamped — the caller learns the ceiling.
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    test.each([
        ['tenantId', { tenantId: 'tenant-VICTIM' }],
        ['initiatedByUserId', { initiatedByUserId: 'someone-else' }],
    ])('a body naming %s is refused rather than silently ignored', async (_label, extra) => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        const res = await POST(
            req('POST', { body: JSON.stringify(extra) }),
            ROUTE_ARGS,
        );

        expect(res.status).toBe(400);
        expect(enqueueMock).not.toHaveBeenCalled();
    });

    test('malformed JSON is a 400, not a silently-defaulted run', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        const res = await POST(req('POST', { body: '{"limit": ' }), ROUTE_ARGS);

        expect(res.status).toBe(400);
        expect(enqueueMock).not.toHaveBeenCalled();
    });
});

// ── Audit ───────────────────────────────────────────────────────────

describe('POST /api/t/:tenantSlug/admin/av-rescan — audit', () => {
    test('writes AV_RESCAN_INITIATED carrying the job id and the limit', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER', { userId: 'owner-9' }));
        enqueueMock.mockResolvedValueOnce({ id: 'job-5' });

        await POST(req('POST', { body: JSON.stringify({ limit: 25 }) }), ROUTE_ARGS);

        expect(logEventMock).toHaveBeenCalledTimes(1);
        const [, , payload] = logEventMock.mock.calls[0];
        expect(payload).toMatchObject({
            action: 'AV_RESCAN_INITIATED',
            entityType: 'Tenant',
            entityId: 'tenant-A',
            metadata: { jobId: 'job-5', limit: 25, limitExplicit: true },
        });
    });

    test('records the effective default when the caller named no limit', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        enqueueMock.mockResolvedValueOnce({ id: 'job-6' });

        await POST(req('POST'), ROUTE_ARGS);

        const [, , payload] = logEventMock.mock.calls[0];
        expect(payload.metadata).toMatchObject({
            limit: AV_RESCAN_DEFAULT_LIMIT,
            limitExplicit: false,
        });
    });
});

// ── Disabled-scanner refusal ────────────────────────────────────────

describe('POST /api/t/:tenantSlug/admin/av-rescan — AV_SCAN_MODE', () => {
    test('disabled → 409 with a stated reason, and no job is queued', async () => {
        mockEnv.AV_SCAN_MODE = 'disabled';
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        const res = await POST(req('POST'), ROUTE_ARGS);

        expect(res.status).toBe(409);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        expect(body.error.message).toMatch(/AV_SCAN_MODE is disabled/);
        expect(enqueueMock).not.toHaveBeenCalled();
        expect(logEventMock).not.toHaveBeenCalled();
    });

    test.each(['strict', 'permissive'])('%s is allowed through', async (mode) => {
        mockEnv.AV_SCAN_MODE = mode;
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        enqueueMock.mockResolvedValueOnce({ id: 'job-7' });

        const res = await POST(req('POST'), ROUTE_ARGS);

        expect(res.status).toBe(202);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
});

// ── Rate limit ──────────────────────────────────────────────────────

describe('POST /api/t/:tenantSlug/admin/av-rescan — rate limit', () => {
    test('applies API_KEY_CREATE_LIMIT under the av-rescan-initiate scope', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor('OWNER'));
        enqueueMock.mockResolvedValue({ id: 'job-x' });

        for (let i = 0; i < API_KEY_CREATE_LIMIT.maxAttempts; i++) {
            const res = await POST(req('POST'), ROUTE_ARGS);
            expect(res.status).toBe(202);
        }

        const blocked = await POST(req('POST'), ROUTE_ARGS);
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await blocked.json();
        expect(body.error.scope).toBe('av-rescan-initiate');
    });
});

// ── GET — reading the outcome without a shell ───────────────────────

describe('GET /api/t/:tenantSlug/admin/av-rescan', () => {
    test('returns state + the counters the operator re-runs against', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        getQueueMock.mockReturnValueOnce({
            getJob: jest.fn(async () => ({
                data: { tenantId: 'tenant-A' },
                getState: jest.fn(async () => 'completed'),
                progress: 100,
                returnvalue: {
                    jobName: 'av-rescan',
                    itemsScanned: 12,
                    itemsActioned: 9,
                    details: { clean: 8, infected: 1, leftPending: 3 },
                },
                failedReason: null,
            })),
        });

        const res = await GET(
            req('GET', {
                url: 'http://localhost/api/t/acme/admin/av-rescan?jobId=job-8',
            }),
            ROUTE_ARGS,
        );

        expect(res.status).toBe(200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        expect(body).toEqual(
            expect.objectContaining({ jobId: 'job-8', state: 'completed' }),
        );
        expect(body.result.itemsScanned).toBe(12);
        expect(body.result.details).toMatchObject({ clean: 8, infected: 1 });
    });

    test('missing jobId → 400', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        const res = await GET(req('GET'), ROUTE_ARGS);
        expect(res.status).toBe(400);
    });

    test("another tenant's job reads as absent, not as forbidden", async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER', { tenantId: 'tenant-A' }));
        getQueueMock.mockReturnValueOnce({
            getJob: jest.fn(async () => ({
                data: { tenantId: 'tenant-B' },
                getState: jest.fn(),
            })),
        });

        const res = await GET(
            req('GET', {
                url: 'http://localhost/api/t/acme/admin/av-rescan?jobId=foreign',
            }),
            ROUTE_ARGS,
        );

        expect(res.status).toBe(404);
    });

    test('unknown jobId → 404', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        getQueueMock.mockReturnValueOnce({ getJob: jest.fn(async () => null) });

        const res = await GET(
            req('GET', {
                url: 'http://localhost/api/t/acme/admin/av-rescan?jobId=missing',
            }),
            ROUTE_ARGS,
        );

        expect(res.status).toBe(404);
    });

    test('ADMIN cannot read a run either, and the queue is never consulted', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));

        const res = await GET(
            req('GET', {
                url: 'http://localhost/api/t/acme/admin/av-rescan?jobId=x',
            }),
            ROUTE_ARGS,
        );

        expect(res.status).toBe(403);
        expect(getQueueMock).not.toHaveBeenCalled();
    });
});
