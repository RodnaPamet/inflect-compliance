/**
 * The manual joiner-pass trigger has a rate-limit bucket of its own (#5123).
 *
 * Its options named `API_KEY_CREATE_LIMIT` (5 an hour, one-hour lockout) with
 * no scope, so the key fell back to `api-mutation`, the bucket every
 * default-limited route shares. Five ordinary saves in a minute locked the
 * trigger out for an hour, and any other mutation pruned the list to its own
 * 60-second window, so the hourly cap was never enforced either.
 *
 * The wrapper and the limiter are REAL here, with enforcement switched on.
 */
import { NextRequest, NextResponse } from 'next/server';

const enqueue = jest.fn(async () => ({ id: 'job-1' }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueue(...(a as [])) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn(async () => undefined) }));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (_key: string, handler: (r: unknown, p: unknown, c: unknown) => unknown) =>
        async (req: unknown) => handler(req, { tenantSlug: 't' }, { tenantId: 'tenant-1', userId: 'user-1' }),
}));

import { POST } from '@/app/api/t/[tenantSlug]/admin/identity-joiner-passes/run/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

type Post = (req: NextRequest, args: unknown) => Promise<Response>;
const joinerRun = POST as unknown as Post;
/** Any route on the default mutation limit. */
const ordinarySave = withApiErrorHandling(async () => NextResponse.json({ ok: true })) as unknown as Post;

function post(path: string, body: unknown = {}): NextRequest {
    return new NextRequest(`https://app.example.io/api/t/t/${path}`, {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }),
        body: JSON.stringify(body),
    });
}
const runJoiner = () => joinerRun(post('admin/identity-joiner-passes/run', { provider: 'entra-id' }), {});
const save = () => ordinarySave(post('admin/settings'), {});

const ORIGINAL = process.env.RATE_LIMIT_ENABLED;
beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
    clearAllRateLimits();
    enqueue.mockClear();
});
afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = ORIGINAL;
    clearAllRateLimits();
});

it('ordinary saves from the same address do not lock the trigger out', async () => {
    for (let i = 0; i < 5; i++) expect((await save()).status).toBe(200);
    const res = await runJoiner();
    expect(res.status).not.toBe(429);
    expect(enqueue).toHaveBeenCalledTimes(1);
});

it('the hourly cap holds, however many other mutations come between the runs', async () => {
    for (let i = 0; i < 5; i++) {
        expect((await runJoiner()).status).not.toBe(429);
        expect((await save()).status).toBe(200);
    }
    expect((await runJoiner()).status).toBe(429);
    expect(enqueue).toHaveBeenCalledTimes(5);
});
