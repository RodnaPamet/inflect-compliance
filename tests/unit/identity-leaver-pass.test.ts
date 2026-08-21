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
    logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));
import { logger } from '@/lib/observability/logger';
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
    MAX_REPORTED_DECISIONS,
} from '@/app-layer/usecases/identity-leaver-pass';

const mockDb = {
    employee: { findMany: jest.fn() },
    connectedIdentityAccount: { count: jest.fn() },
    // The pass record. Its write is wrapped in a try/catch so a failed insert
    // cannot turn a completed pass into an ERROR — which means a mock missing
    // this key would leave the whole feature dead with the suite green. The
    // assertions below are positive for exactly that reason.
    integrationExecution: { create: jest.fn() },
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
    disableBatch.mockResolvedValue({ results: [{ outcome: 'DRY_RUN', linkId: 'l1' }] });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
});

describe('the durable record a dry run leaves behind', () => {
    // The seven-day window exists to be COMPARED against what HR and IT actually
    // did — the ladder's own refusal text says so — and until now a dry run
    // decided, logged a histogram, and threw every decision away. The promotion
    // gate counts ELAPSED days, not observed runs, so the window could be
    // satisfied by time passing while nobody watched anything.
    it('writes one execution row carrying a decision per candidate', async () => {
        findCandidates.mockResolvedValue([
            { linkId: 'l1', externalUserId: 'x1', onPremisesSyncEnabled: false },
            { linkId: 'l2', externalUserId: 'x2', onPremisesSyncEnabled: false },
        ]);
        disableBatch.mockResolvedValue({
            results: [
                { outcome: 'DRY_RUN', linkId: 'l1' },
                { outcome: 'REFUSED_TARGET', linkId: 'l2', reason: 'hybrid-synced' },
            ],
        });

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.automationKey).toBe('entra-id.leaver_pass');
        expect(data.status).toBe('PASSED');
        expect(data.resultJson.decisions).toEqual([
            { linkId: 'l1', outcome: 'DRY_RUN' },
            { linkId: 'l2', outcome: 'REFUSED_TARGET', reason: 'hybrid-synced' },
        ]);
        expect(data.resultJson.decisionsTruncated).toBe(false);
    });

    it('keys decisions by link id and never by directory identifier', async () => {
        // IntegrationExecution is not encrypted at rest — the Epic B manifest is
        // String-only, so a Json column cannot join it — and these rows outlive
        // the pass. The identifier that goes in must mean nothing without an
        // authorised read.
        const r = await run();

        expect(r.status).toBe('PASSED');
        const json = JSON.stringify(mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson);
        expect(json).toContain('l1');
        expect(json).not.toContain('x1');
    });

    it('scrubs the account out of a provider reason before persisting it', async () => {
        // `DisableResult.reason` is deliberately un-redacted — it is written for
        // an operator reading a tenant-scoped surface — but provider messages
        // routinely embed the account. Persisting one verbatim would put back
        // exactly what keying by link id takes out.
        // A realistic identifier, not 'x1': the scrubber refuses to remove
        // anything under three characters, because a two-character id matches
        // inside ordinary words and would turn a message into confetti. Real
        // directory ids are GUIDs or DNs, and the fixture has to be one for the
        // assertion to mean anything.
        const guid = '11111111-2222-3333-4444-555555555555';
        findCandidates.mockResolvedValue([
            { linkId: 'l1', externalUserId: guid, onPremisesSyncEnabled: false },
        ]);
        disableBatch.mockResolvedValue({
            results: [
                {
                    outcome: 'FAILED',
                    linkId: 'l1',
                    reason: `No observed directory record for ${guid}. The last complete sync did not see it.`,
                },
            ],
        });

        await run();

        const decisions = mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson.decisions;
        expect(decisions[0].reason).not.toContain('1111');
        expect(decisions[0].reason).toContain('{account}');
    });

    it('marks a truncated report PARTIAL and says so in the row', async () => {
        // Unreachable today — the breaker REFUSES above 50 rather than trimming
        // — but a report that IS cut short must say so rather than quietly end
        // early, which is the failure mode of every cap without a flag.
        const many = Array.from({ length: MAX_REPORTED_DECISIONS + 5 }, (_, i) => ({
            outcome: 'DRY_RUN' as const,
            linkId: `l${i}`,
        }));
        disableBatch.mockResolvedValue({ results: many });

        await run();

        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.status).toBe('PARTIAL');
        expect(data.resultJson.decisions).toHaveLength(MAX_REPORTED_DECISIONS);
        expect(data.resultJson.decisionsTruncated).toBe(true);
    });

    it('records a pass that ran and REFUSED, so silence cannot look like a run', async () => {
        // The distinction the seven-day observation rests on: "the pass ran and
        // found nobody to offboard" and "no pass ran at all" used to be the same
        // absence in the artefact. NO_FRESH_LINKS is the one that matters most —
        // terminated workers present, nobody offboarded, green pass — which is
        // the silent-nothing failure this subsystem is built around.
        findCandidates.mockResolvedValue([]);

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_FRESH_LINKS' });
        expect(mockDb.integrationExecution.create).toHaveBeenCalledTimes(1);
        const data = mockDb.integrationExecution.create.mock.calls[0][0].data;
        expect(data.status).toBe('NOT_APPLICABLE');
        expect(data.resultJson.refusal).toBe('NO_FRESH_LINKS');
        expect(data.resultJson.terminatedWorkers).toBe(2);
    });

    it('does NOT record a tenant that is not observing at all', async () => {
        // A tenant with leaver writes switched off is not in an observation
        // window, and a daily row would imply it was being watched. The ladder
        // refusals are excluded for that reason, not by omission.
        getPolicy.mockResolvedValue({ leaver: { mode: 'DISABLED' }, joiner: { mode: 'DISABLED' } });

        const r = await run();

        expect(r).toMatchObject({ refusal: 'MODE_DISABLED' });
        expect(mockDb.integrationExecution.create).not.toHaveBeenCalled();
    });

    it('a refusal whose record fails is still a refusal, not an ERROR', async () => {
        findCandidates.mockResolvedValue([]);
        mockDb.integrationExecution.create.mockRejectedValue(new Error('db is on fire'));

        const r = await run();

        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_FRESH_LINKS' });
    });

    it('a failed insert does not turn a completed pass into an ERROR', async () => {
        // The directory decisions are already made and already reported. Losing
        // the record of them is worth an alert, not a retry of a pass that ran —
        // and the pass runs with attempts: 1 precisely so nothing re-dispatches.
        mockDb.integrationExecution.create.mockRejectedValue(new Error('db is on fire'));

        const r = await run();

        expect(r.status).toBe('PASSED');
        expect((logger.error as jest.Mock).mock.calls.some(
            (c) => typeof c[0] === 'string' && c[0].includes('record could not be written'),
        )).toBe(true);
    });
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
