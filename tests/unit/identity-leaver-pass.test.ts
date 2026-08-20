/**
 * The leaver pass — every gate in front of the batch, and the clamp.
 *
 * The two assertions that carry the weight:
 *   - a tenant configured at PROPOSE or AUTOMATIC gets NOTHING, because it
 *     reached that rung by elapsed days and no pass has ever run;
 *   - an empty candidate set with terminated workers present is reported as its
 *     own refusal, not as a quiet success — a leaver pass that disables nobody
 *     and says "done" is the failure this whole subsystem is most prone to.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/context-system', () => ({
    buildSystemContext: jest.fn((a: { tenantId: string }) => ({ tenantId: a.tenantId, userId: 'system' })),
}));
const getPolicy = jest.fn();
jest.mock('@/app-layer/usecases/identity-write-policy', () => ({
    getIdentityWritePolicy: (...a: unknown[]) => getPolicy(...a),
}));
const findCandidates = jest.fn();
const disableBatch = jest.fn();
jest.mock('@/app-layer/usecases/identity-disable-account', () => ({
    findLeaverCandidates: (...a: unknown[]) => findCandidates(...a),
    disableAccountsForLeaver: (...a: unknown[]) => disableBatch(...a),
}));
const resolveWriter = jest.fn();
jest.mock('@/app-layer/integrations/identity-writer-factory', () => ({
    resolveDirectoryWriter: (...a: unknown[]) => resolveWriter(...a),
}));
const passMetric = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordLeaverPassOutcome: (...a: unknown[]) => passMetric(...a),
}));

import {
    runIdentityLeaverPass,
    LEAVER_MAX_MODE,
    LINK_FRESHNESS_MS,
} from '@/app-layer/usecases/identity-leaver-pass';

const mockDb = {
    employee: { findMany: jest.fn() },
    connectedIdentityAccount: { count: jest.fn() },
};

const NOW = new Date('2026-08-20T09:00:00.000Z');
const close = jest.fn(async () => undefined);

function run(over: Record<string, unknown> = {}) {
    return runIdentityLeaverPass({ tenantId: 't1', provider: 'entra-id', now: NOW, ...over });
}

beforeEach(() => {
    jest.clearAllMocks();
    getPolicy.mockResolvedValue({ leaver: { mode: 'DRY_RUN', dryRunSince: NOW }, joiner: { mode: 'DISABLED' } });
    mockDb.employee.findMany.mockResolvedValue([{ id: 'emp-1' }, { id: 'emp-2' }]);
    findCandidates.mockResolvedValue([{ linkId: 'l1', externalUserId: 'x1', onPremisesSyncEnabled: false }]);
    mockDb.connectedIdentityAccount.count.mockResolvedValue(400);
    resolveWriter.mockResolvedValue({ kind: 'snapshot', writer: { provider: 'entra-id' }, close });
    disableBatch.mockResolvedValue({ results: [{ outcome: 'DRY_RUN' }] });
});

describe('the ladder gate', () => {
    it('does nothing at all when leaver writes are DISABLED', async () => {
        getPolicy.mockResolvedValue({ leaver: { mode: 'DISABLED' }, joiner: { mode: 'DISABLED' } });

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'MODE_DISABLED' });
        expect(mockDb.employee.findMany).not.toHaveBeenCalled();
        expect(resolveWriter).not.toHaveBeenCalled();
    });

    it.each(['PROPOSE', 'AUTOMATIC'])('CLAMPS a tenant configured at %s', async (mode) => {
        // The ladder's gate counts elapsed days since dryRunSince, not observed
        // runs — and no pass has ever executed. So a tenant above DRY_RUN today
        // earned that rung by waiting, not by watching.
        getPolicy.mockResolvedValue({ leaver: { mode, dryRunSince: NOW }, joiner: { mode: 'DISABLED' } });

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'MODE_ABOVE_CLAMP', mode });
        expect(disableBatch).not.toHaveBeenCalled();
        expect(resolveWriter).not.toHaveBeenCalled();
        expect(passMetric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'mode_above_clamp' });
    });

    it('the clamp is DRY_RUN — raising it must be a reviewed diff, not a setting', () => {
        expect(LEAVER_MAX_MODE).toBe('DRY_RUN');
    });
});

describe('who the feed says has left', () => {
    it('reads only workers explicitly marked TERMINATED — never inferred from absence', async () => {
        await run();
        expect(mockDb.employee.findMany.mock.calls[0][0].where).toMatchObject({
            tenantId: 't1',
            status: 'TERMINATED',
        });
    });

    it('stops before touching the directory when nobody has left', async () => {
        mockDb.employee.findMany.mockResolvedValue([]);

        const r = await run();

        expect(r.refusal).toBe('NO_TERMINATED_WORKERS');
        expect(findCandidates).not.toHaveBeenCalled();
        expect(resolveWriter).not.toHaveBeenCalled();
    });
});

describe('link freshness is the completeness gate', () => {
    it('demands links re-observed within the freshness window', async () => {
        await run();
        const staleBefore = findCandidates.mock.calls[0][3] as Date;
        expect(staleBefore.getTime()).toBe(NOW.getTime() - LINK_FRESHNESS_MS);
    });

    it('reports "no fresh links" as its OWN refusal, not as a quiet success', async () => {
        // Terminated workers present but no actable link means the link table is
        // stale or empty. Reporting PASSED here is precisely how an offboarding
        // that disables nobody comes to look like one that works.
        findCandidates.mockResolvedValue([]);

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_FRESH_LINKS', terminatedWorkers: 2 });
        expect(r.detail).toMatch(/terminated worker/i);
        expect(disableBatch).not.toHaveBeenCalled();
    });
});

describe('the batch', () => {
    it('measures the blast radius against the observed account population', async () => {
        await run();
        expect(disableBatch.mock.calls[0][2]).toMatchObject({ population: 400 });
    });

    it('tallies the outcomes it got back', async () => {
        disableBatch.mockResolvedValue({
            results: [{ outcome: 'DRY_RUN' }, { outcome: 'DRY_RUN' }, { outcome: 'REFUSED_TARGET' }],
        });

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect(r.counts).toEqual({ DRY_RUN: 2, REFUSED_TARGET: 1 });
    });

    it('carries a breaker refusal through instead of reporting a clean run', async () => {
        disableBatch.mockResolvedValue({ refused: '200 of 400 is a broken feed', results: [] });

        const r = await run();

        expect(r.batchRefused).toMatch(/broken feed/);
        expect(passMetric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'batch_refused' });
    });
});

describe('disposal', () => {
    it('closes the writer on the happy path', async () => {
        await run();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes the writer even when the batch throws', async () => {
        // The AD writer holds an LDAP socket. A leaked bind outlives the process
        // that made it, so the finally is unconditional.
        disableBatch.mockRejectedValue(new Error('directory went away'));

        const r = await run();

        expect(r.status).toBe('ERROR');
        expect(close).toHaveBeenCalledTimes(1);
    });
});

describe('it never throws', () => {
    it('reports an unexpected failure as ERROR rather than ending the fan-out', async () => {
        getPolicy.mockRejectedValue(new Error('settings read failed'));

        const r = await run();

        expect(r).toMatchObject({ status: 'ERROR', errorMessage: 'settings read failed' });
        expect(passMetric).toHaveBeenCalledWith({ provider: 'entra-id', outcome: 'error' });
    });
});
