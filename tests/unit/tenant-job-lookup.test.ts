/**
 * findTenantJob (src/app-layer/jobs/tenant-job-lookup.ts) is the one lookup
 * the tenant job-status routes use. Every job type shares one queue, so a
 * job is reported only when it is the route's own kind AND its payload names
 * the caller's tenant. Everything else is absent.
 */
const getJob = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ getQueue: () => ({ getJob }) }));

import { findTenantJob } from '@/app-layer/jobs/tenant-job-lookup';

beforeEach(() => getJob.mockReset());

describe('findTenantJob', () => {
    it("returns the tenant's own job of the named kind", async () => {
        const job = { name: 'evidence-import', data: { tenantId: 't1' } };
        getJob.mockResolvedValue(job);
        await expect(findTenantJob('7', 't1', 'evidence-import')).resolves.toBe(job);
        expect(getJob).toHaveBeenCalledWith('7');
    });

    it.each([
        ['no such job', null],
        ['another tenant', { name: 'evidence-import', data: { tenantId: 't2' } }],
        ['another kind of job', { name: 'key-rotation', data: { tenantId: 't1' } }],
        ['no tenant in the payload', { name: 'evidence-import', data: {} }],
        ['no payload', { name: 'evidence-import', data: undefined }],
        ['a non-string tenant', { name: 'evidence-import', data: { tenantId: ['t1'] } }],
    ])('is absent for %s', async (_label, job) => {
        getJob.mockResolvedValue(job);
        await expect(findTenantJob('7', 't1', 'evidence-import')).resolves.toBeNull();
    });
});
