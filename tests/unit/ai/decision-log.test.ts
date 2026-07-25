/**
 * Coverage wave E — `src/app-layer/ai/decision-log/index.ts`.
 *
 * The EU AI Act Art 12 record-keeping path. The assertions that matter are
 * the PRIVACY ones: the raw provider input must never reach the row (only a
 * SHA-256 digest), and the output summary must be sanitised AND bounded
 * before it is persisted. The Art 14 outcome stamp is one-way, so the
 * `humanOutcome: 'PENDING'` predicate on the update is pinned too — losing it
 * would let a terminal outcome be overwritten.
 *
 * `sanitizePlainText` is mocked to a marker-producing stub so the test can
 * prove the call happens (rather than re-testing the sanitiser itself).
 */
import { makeRequestContext } from '../../helpers/make-context';

const sanitizePlainText = jest.fn((s: string) => `SANITISED(${s})`);
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => sanitizePlainText(s),
}));

const recordAiDecisionLogged = jest.fn();
const recordAiDecisionOutcome = jest.fn();
jest.mock('@/lib/observability/metrics', () => ({
    recordAiDecisionLogged: (...a: unknown[]) => recordAiDecisionLogged(...a),
    recordAiDecisionOutcome: (...a: unknown[]) => recordAiDecisionOutcome(...a),
}));

import { createHash } from 'node:crypto';
import {
    computeInputDigest,
    logAiDecision,
    recordDecisionOutcome,
} from '@/app-layer/ai/decision-log';

const ctx = makeRequestContext('ADMIN', { tenantId: 't-1', userId: 'u-1' });

const db = {
    aiDecisionLog: { create: jest.fn(), updateMany: jest.fn() },
};

const baseInput = {
    feature: 'risk-suggestions',
    provider: 'anthropic',
    sanitizedInput: { q: 'aggregate signals only' },
};

beforeEach(() => {
    jest.clearAllMocks();
    sanitizePlainText.mockImplementation((s: string) => `SANITISED(${s})`);
    db.aiDecisionLog.create.mockResolvedValue({ id: 'log-1' });
    db.aiDecisionLog.updateMany.mockResolvedValue({ count: 0 });
});

describe('computeInputDigest', () => {
    it('produces a prefixed sha256 of the JSON form', () => {
        const value = { a: 1 };
        const expected =
            'sha256:' +
            createHash('sha256').update(JSON.stringify(value)).digest('hex');
        expect(computeInputDigest(value)).toBe(expected);
    });

    it('is stable for equal values and differs for different ones', () => {
        expect(computeInputDigest({ a: 1 })).toBe(computeInputDigest({ a: 1 }));
        expect(computeInputDigest({ a: 1 })).not.toBe(computeInputDigest({ a: 2 }));
    });

    it('treats undefined and null identically (both hash the literal null)', () => {
        const nullDigest =
            'sha256:' + createHash('sha256').update('null').digest('hex');
        expect(computeInputDigest(undefined)).toBe(nullDigest);
        expect(computeInputDigest(null)).toBe(nullDigest);
    });
});

describe('logAiDecision', () => {
    it('writes a tenant-scoped row and returns its id', async () => {
        const id = await logAiDecision(db as never, ctx, baseInput);

        expect(id).toBe('log-1');
        const { data, select } = db.aiDecisionLog.create.mock.calls[0][0];
        expect(data.tenantId).toBe('t-1');
        expect(data.userId).toBe('u-1');
        expect(data.feature).toBe('risk-suggestions');
        expect(data.provider).toBe('anthropic');
        expect(select).toEqual({ id: true });
    });

    it('stores a digest of the input, never the input itself', async () => {
        await logAiDecision(db as never, ctx, baseInput);

        const { data } = db.aiDecisionLog.create.mock.calls[0][0];
        expect(data.inputDigest).toBe(computeInputDigest(baseInput.sanitizedInput));
        // The raw prompt must appear nowhere in the persisted row.
        expect(JSON.stringify(data)).not.toContain('aggregate signals only');
    });

    it('sanitises the output summary before persisting it', async () => {
        await logAiDecision(db as never, ctx, {
            ...baseInput,
            outputSummary: '<script>alert(1)</script>ok',
        });

        expect(sanitizePlainText).toHaveBeenCalledWith('<script>alert(1)</script>ok');
        expect(db.aiDecisionLog.create.mock.calls[0][0].data.outputSummary).toBe(
            'SANITISED(<script>alert(1)</script>ok)',
        );
    });

    it('bounds the summary to 500 characters', async () => {
        sanitizePlainText.mockImplementation((s: string) => s);
        await logAiDecision(db as never, ctx, {
            ...baseInput,
            outputSummary: 'x'.repeat(5000),
        });
        expect(
            db.aiDecisionLog.create.mock.calls[0][0].data.outputSummary,
        ).toHaveLength(500);
    });

    it('nulls the summary when absent or empty', async () => {
        await logAiDecision(db as never, ctx, baseInput);
        expect(db.aiDecisionLog.create.mock.calls[0][0].data.outputSummary).toBeNull();

        jest.clearAllMocks();
        db.aiDecisionLog.create.mockResolvedValue({ id: 'log-2' });
        await logAiDecision(db as never, ctx, { ...baseInput, outputSummary: '' });
        expect(db.aiDecisionLog.create.mock.calls[0][0].data.outputSummary).toBeNull();
        expect(sanitizePlainText).not.toHaveBeenCalled();
    });

    it('defaults every optional column to null', async () => {
        await logAiDecision(db as never, ctx, baseInput);
        const { data } = db.aiDecisionLog.create.mock.calls[0][0];
        expect(data.aiSystemId).toBeNull();
        expect(data.model).toBeNull();
        expect(data.latencyMs).toBeNull();
        expect(data.tokensIn).toBeNull();
        expect(data.tokensOut).toBeNull();
        expect(data.guardVerdict).toBeNull();
        expect(data.sessionRef).toBeNull();
    });

    it('passes every supplied optional column through', async () => {
        await logAiDecision(db as never, ctx, {
            ...baseInput,
            model: 'claude-haiku-4-5',
            aiSystemId: 'sys-1',
            latencyMs: 1200,
            tokensIn: 900,
            tokensOut: 120,
            guardVerdict: 'ALLOW',
            sessionRef: 'sess-1',
        });
        const { data } = db.aiDecisionLog.create.mock.calls[0][0];
        expect(data).toMatchObject({
            model: 'claude-haiku-4-5',
            aiSystemId: 'sys-1',
            latencyMs: 1200,
            tokensIn: 900,
            tokensOut: 120,
            guardVerdict: 'ALLOW',
            sessionRef: 'sess-1',
        });
    });

    it('preserves a zero latency rather than nulling it', async () => {
        await logAiDecision(db as never, ctx, { ...baseInput, latencyMs: 0 });
        expect(db.aiDecisionLog.create.mock.calls[0][0].data.latencyMs).toBe(0);
    });

    it('emits the logged metric with the guard flag', async () => {
        await logAiDecision(db as never, ctx, { ...baseInput, guardBlocked: true });
        expect(recordAiDecisionLogged).toHaveBeenCalledWith({
            provider: 'anthropic',
            feature: 'risk-suggestions',
            guardBlocked: true,
        });
    });
});

describe('recordDecisionOutcome', () => {
    it('stamps only PENDING rows for the tenant + session', async () => {
        db.aiDecisionLog.updateMany.mockResolvedValue({ count: 2 });

        const n = await recordDecisionOutcome(db as never, ctx, 'sess-1', 'ACCEPTED');

        expect(n).toBe(2);
        expect(db.aiDecisionLog.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 't-1', sessionRef: 'sess-1', humanOutcome: 'PENDING' },
            data: { humanOutcome: 'ACCEPTED' },
        });
    });

    it.each(['ACCEPTED', 'EDITED', 'REJECTED'] as const)(
        'records the %s outcome metric when rows were stamped',
        async (outcome) => {
            db.aiDecisionLog.updateMany.mockResolvedValue({ count: 1 });
            await recordDecisionOutcome(db as never, ctx, 'sess-1', outcome);
            expect(recordAiDecisionOutcome).toHaveBeenCalledWith({ outcome });
        },
    );

    it('emits no metric when nothing was stamped', async () => {
        db.aiDecisionLog.updateMany.mockResolvedValue({ count: 0 });
        const n = await recordDecisionOutcome(db as never, ctx, 'sess-1', 'REJECTED');
        expect(n).toBe(0);
        expect(recordAiDecisionOutcome).not.toHaveBeenCalled();
    });
});
