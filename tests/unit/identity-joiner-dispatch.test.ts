/**
 * The joiner fan-out: what it reads, what it dedupes, and what it refuses.
 *
 * The dispatcher crosses tenant boundaries, so what it SELECTS is part of the
 * contract rather than an implementation detail — ids and provider only, never
 * configJson or secrets.
 *
 * #2687 acceptance 2 asks that removing the dispatcher's PROVIDER SCOPING redden
 * a test. The scoping is two separate things and both are asserted here,
 * because losing either one turns a scoped run into a wider one and neither
 * failure announces itself:
 *
 *   · the READ is `provider: { in: WRITABLE_IDENTITY_PROVIDERS }` — without it
 *     the fan-out enqueues a joiner pass for every Okta and Google Workspace
 *     connection in the estate, directories this product has no joiner story
 *     about and whose enumeration means something else;
 *   · the PAYLOAD carries the tenant AND the provider — without the provider,
 *     the pass's two directory-derived inputs (link freshness, the collision
 *     read) are answered from a union of directories, and the executor's own
 *     guard throws rather than letting that happen quietly.
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
jest.mock('@/app-layer/usecases/identity-joiner-run', () => ({
    runIdentityJoinerPass: (...a: unknown[]) => passRan(...a),
}));

import prisma from '@/lib/prisma';
import {
    runIdentityJoinerDispatch,
    runIdentityJoinerPassJob,
} from '@/app-layer/jobs/identity-joiner';

const findMany = (prisma as unknown as { integrationConnection: { findMany: jest.Mock } })
    .integrationConnection.findMany;

function conn(id: string, tenantId: string, provider: string) {
    return { id, tenantId, provider };
}

beforeEach(() => {
    jest.clearAllMocks();
    enqueued.mockResolvedValue({ id: 'job-1' });
    passRan.mockResolvedValue({
        status: 'NOT_APPLICABLE',
        mode: 'DRY_RUN',
        refusal: 'NO_DEPARTMENT_MAP',
        detail: 'x',
        starters: 0,
        wouldCreate: 0,
        decisions: 0,
    });
    findMany.mockResolvedValue([]);
});

describe('what the cross-tenant read is allowed to see', () => {
    it('selects ids and provider only — no configJson, no secrets', async () => {
        await runIdentityJoinerDispatch();
        expect(findMany.mock.calls[0][0].select).toEqual({
            id: true,
            tenantId: true,
            provider: true,
        });
    });

    it('reads only writable providers, and only enabled connections', async () => {
        await runIdentityJoinerDispatch();
        const where = findMany.mock.calls[0][0].where;
        expect(where.isEnabled).toBe(true);
        expect(where.provider.in).toEqual(expect.arrayContaining(['entra-id', 'active-directory']));
        // The negative half, and it is the one that matters. `arrayContaining`
        // passes on a SUPERSET, so it would stay green on an unscoped read that
        // swept Okta and Google Workspace in as well.
        expect(where.provider.in).not.toContain('okta');
        expect(where.provider.in).not.toContain('google-workspace');
        expect(where.provider.in).toHaveLength(2);
    });

    it('control — the WHERE predicate is the WHOLE scope; nothing filters again in code', async () => {
        // Deliberately handing the fake an `okta` row the real predicate would
        // never have returned, and asserting it IS forwarded.
        //
        // That is not a licence for an unscoped read — it is what makes the
        // assertion above the genuine detector for #2687 acceptance 2. A second,
        // in-code filter would keep this suite green through a deleted `where`
        // predicate and then drift from it; with none, deleting the predicate
        // has exactly one observable consequence and exactly one test watching
        // it. If this case ever goes red, the scope has been duplicated and the
        // duplicate now needs its own test.
        findMany.mockResolvedValue([
            conn('c1', 't1', 'entra-id'),
            conn('c2', 't2', 'okta'),
        ]);

        const r = await runIdentityJoinerDispatch();

        expect(r.units).toBe(2);
        expect(
            enqueued.mock.calls.map((c) => (c[1] as { provider: string }).provider).sort(),
        ).toEqual(['entra-id', 'okta']);
    });
});

describe('the unit is (tenant, provider)', () => {
    it('dedupes two connections for one provider into ONE pass', async () => {
        findMany.mockResolvedValue([
            conn('c1', 't1', 'active-directory'),
            conn('c2', 't1', 'active-directory'),
        ]);

        const r = await runIdentityJoinerDispatch();

        expect(r.units).toBe(1);
        expect(enqueued).toHaveBeenCalledTimes(1);
    });

    it('keeps two providers in one tenant as two passes', async () => {
        findMany.mockResolvedValue([
            conn('c1', 't1', 'entra-id'),
            conn('c2', 't1', 'active-directory'),
        ]);

        const r = await runIdentityJoinerDispatch();

        expect(r.units).toBe(2);
        expect(
            enqueued.mock.calls.map((c) => (c[1] as { provider: string }).provider).sort(),
        ).toEqual(['active-directory', 'entra-id']);
    });

    it('passes the tenant AND the provider, never the connection id, in the payload', async () => {
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);

        await runIdentityJoinerDispatch();

        expect(enqueued.mock.calls[0][1]).toEqual({ tenantId: 't1', provider: 'entra-id' });
    });

    it('enqueues the joiner job, never the leaver one', async () => {
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);

        await runIdentityJoinerDispatch();

        expect(enqueued.mock.calls[0][0]).toBe('identity-joiner-pass');
    });
});

describe('a re-dispatch inside the same day is a no-op', () => {
    it('keys the job id on (tenant, provider, day), not on the connection', async () => {
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);

        await runIdentityJoinerDispatch();

        const opts = enqueued.mock.calls[0][2] as { jobId: string };
        expect(opts.jobId).toContain('t1');
        expect(opts.jobId).toContain('entra-id');
        expect(opts.jobId).not.toContain('c1');
        // BullMQ rejects a custom id whose colons do not split it into exactly
        // three parts — the leaver's own test was green for weeks on an id every
        // enqueue threw on, because it checked the key material and not validity.
        expect(opts.jobId.split(':')).toHaveLength(3);
    });
});

describe('the pass job refuses an unscoped payload', () => {
    it('throws when the provider is missing', async () => {
        await expect(
            runIdentityJoinerPassJob({ tenantId: 't1' } as unknown as {
                tenantId: string;
                provider: string;
            }),
        ).rejects.toThrow(/provider/);
        expect(passRan).not.toHaveBeenCalled();
    });

    it('throws when the tenant is missing', async () => {
        await expect(
            runIdentityJoinerPassJob({ provider: 'entra-id' } as unknown as {
                tenantId: string;
                provider: string;
            }),
        ).rejects.toThrow(/tenantId/);
        expect(passRan).not.toHaveBeenCalled();
    });

    it('forwards both fields to the pass', async () => {
        await runIdentityJoinerPassJob({ tenantId: 't1', provider: 'entra-id' });
        expect(passRan).toHaveBeenCalledWith({ tenantId: 't1', provider: 'entra-id' });
    });
});

describe('one bad enqueue does not cancel the rest', () => {
    it('reports the failure and still dispatches the others', async () => {
        findMany.mockResolvedValue([
            conn('c1', 't1', 'entra-id'),
            conn('c2', 't2', 'entra-id'),
        ]);
        enqueued.mockRejectedValueOnce(new Error('redis blip')).mockResolvedValue({ id: 'job-2' });

        const r = await runIdentityJoinerDispatch();

        expect(r.units).toBe(2);
        expect(r.dispatched).toBe(1);
        expect(r.failed).toBe(1);
    });

    it('throws when EVERY enqueue failed, so a dead fan-out is not a clean run', async () => {
        findMany.mockResolvedValue([conn('c1', 't1', 'entra-id')]);
        enqueued.mockRejectedValue(new Error('redis down'));

        await expect(runIdentityJoinerDispatch()).rejects.toThrow(/all 1 enqueues failed/);
    });
});
