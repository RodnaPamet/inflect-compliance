/**
 * A cached aggregation route answers from Redis on a hit without running its
 * usecase, so the usecase's read check must also run on the hit. Here an
 * authorised caller fills the vendor-metrics cache, then a caller whose role
 * withholds `vendors.view` asks for the same metrics: refused, not served.
 */
jest.mock('ioredis', () => require('ioredis-mock'));
process.env.REDIS_URL = 'redis://localhost:6379';

const mockGetTenantCtx = jest.fn();
const mockGetVendorMetrics = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));
jest.mock('@/app-layer/usecases/vendor', () => ({
    getVendorMetrics: (...args: unknown[]) => mockGetVendorMetrics(...args),
}));

import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/vendors/metrics/route';
import { getRedis, disconnectRedis } from '@/lib/redis';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';

type Handler = (req: NextRequest, args: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;
const handler = GET as unknown as Handler;
const req = () => {
    const path = '/api/t/acme/vendors/metrics';
    return {
        method: 'GET',
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: { pathname: path, protocol: 'https:', host: 'app.example.com', searchParams: new URLSearchParams() },
    } as unknown as NextRequest;
};
const args = () => ({ params: Promise.resolve({ tenantSlug: 'acme' }) });

beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.flushall();
    mockGetTenantCtx.mockReset();
    mockGetVendorMetrics.mockReset();
    mockGetVendorMetrics.mockResolvedValue({ total: 7 });
});
afterAll(async () => {
    await disconnectRedis();
});

it('serves an authorised caller, then refuses a caller without vendors.view on the cache hit', async () => {
    mockGetTenantCtx.mockResolvedValue(makeRequestContext('EDITOR', { tenantId: 'tenant-1' }));
    const first = await handler(req(), args());
    expect(first.status).toBe(200);
    expect(mockGetVendorMetrics).toHaveBeenCalledTimes(1);

    const editor = getPermissionsForRole('EDITOR');
    mockGetTenantCtx.mockResolvedValue(
        makeRequestContext('EDITOR', {
            tenantId: 'tenant-1',
            appPermissions: { ...editor, vendors: { ...editor.vendors, view: false } },
        }),
    );
    const second = await handler(req(), args());
    expect(second.status).toBe(403);
    expect(mockGetVendorMetrics).toHaveBeenCalledTimes(1);
});
