/**
 * The leaver fan-out: what it reads, what it dedupes, and what it refuses.
 *
 * The dispatcher crosses tenant boundaries, so what it SELECTS is part of the
 * contract, not an implementation detail — ids and provider only, never
 * configJson or secrets.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { integrationConnection: { findMany: jest.fn() } },
}));
const enqueued = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueued(...a) }));
const passRan = jest.fn();
jest.mock('@/app-layer/usecases/identity-leaver-pass', () => ({
    runIdentityLeaverPass: (...a: unknown[]) => passRan(...a),
}));

import prisma from '@/lib/prisma';
import {
    runIdentityLeaverDispatch,
    runIdentityLeaverPassJob,
} from '@/app-layer/jobs/identity-leaver';

const findMany = (prisma as unknown as { integrationConnection: { findMany: jest.Mock } })
    .integrationConnection.findMany;

function conn(id: string, tenantId: string, provider: string) {
    return { id, tenantId, provider };
}

beforeEach(() => {
    jest.clearAllMocks();
    enqueued.mockResolvedValue({ id: 'job-1' });
    passRan.mockResolvedValue({ status: 'PASSED', mode: 'DRY_RUN', counts: {} });
    findMany.mockResolvedValue([]);
});

describe('what the cross-tenant read is allowed to see', () => {
    it('selects ids and provider only — no configJson, no secrets', async () => {
        await runIdentityLeaverDispatch();
        expect(findMany.mock.calls[0][0].select).toEqual({ id: true, tenantId: true, provider: true });
    });

    it('reads only writable providers, and only enabled connections', async () => {
        await runIdentityLeaverDispatch();
        const where = findMany.mock.calls[0][0].where;
        expect(where.isEnabled).toBe(true);
        expect(where.provider.in).toEqual(expect.arrayContaining(['entra-id', 'active-directory']));
        expect(where.provider.in).not.toContain('okta');
    });
});

describe('the unit is (tenant, provider)', () => {
    it('dedupes two connections for one provider into ONE pass', async () => {
        // The writer factory refuses an ambiguous (tenant, provider) by name.
        // Dispatching twice would produce the same refusal twice and nothing
        // else.
        findMany.mockResolvedValue([
            conn('c1', 't1', 'active-directory'),
            conn('c2', 't1', 'active-directory'),
        ]);

        const r = await runIdentityLeaverDispatch();

        expect(r.units).toBe(1);
        expect(enqueued).toHaveBeenCalledTimes(1);
    });

    it('keeps two providers in one tenant as two passes', async () => {
        findMany.mockResolvedValue([
            conn('c1', 't1', 'entra-id'),
            conn('c2', 't1', 'active-directory'),
        ]);

        const r = await runIdentityLeaverDispatch();

        expect(r.units).toBe(2);
        expect(enqueued.mock.calls.map((c) => (c[1] as { provider: string }).provider).sort()).toEqual([
            'active-directory',
            'entra-id',
        ]);
    });

    it('passes the provider, never the connection id, in the payload', async () => {
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);

        await runIdentityLeaverDispatch();

        expect(enqueued.mock.calls[0][1]).toEqual({ tenantId: 't1', provider: 'entra-id' });
    });
});

describe('a re-dispatch inside the same day is a no-op', () => {
    it('keys the job id on (tenant, provider, day), not on the connection', async () => {
        // A second pass in one day would mint a second set of journal rows, so
        // the determinism matters more here than it does for a sync.
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);

        await runIdentityLeaverDispatch();

        const opts = enqueued.mock.calls[0][2] as { jobId: string };
        expect(opts.jobId).toContain('t1:entra-id');
        expect(opts.jobId).not.toContain('c1');
    });
});

describe('failure handling', () => {
    it('throws when every enqueue failed — a silent zero would read as a clean run', async () => {
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);
        enqueued.mockRejectedValue(new Error('queue is down'));

        await expect(runIdentityLeaverDispatch()).rejects.toThrow(/all 1 enqueues failed/);
    });

    it('reports a clean zero when there is simply nothing to dispatch', async () => {
        const r = await runIdentityLeaverDispatch();
        expect(r).toEqual({ units: 0, dispatched: 0, failed: 0 });
    });
});

describe('the per-unit job', () => {
    it('refuses a payload with no provider rather than passing undefined down', async () => {
        await expect(
            runIdentityLeaverPassJob({ tenantId: 't1' } as unknown as { tenantId: string; provider: string }),
        ).rejects.toThrow(/requires tenantId \+ provider/);
        expect(passRan).not.toHaveBeenCalled();
    });

    it('delegates to the usecase with exactly what it was given', async () => {
        await runIdentityLeaverPassJob({ tenantId: 't1', provider: 'entra-id' });
        expect(passRan).toHaveBeenCalledWith({ tenantId: 't1', provider: 'entra-id' });
    });
});
