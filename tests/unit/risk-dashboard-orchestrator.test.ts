
/**
 * RQ3-9 — risk-dashboard orchestrator suite. Pins the contract
 * that one mount = one batched fan-out, that failure-soft is
 * preserved per slot, and that a thrown matrix branch is fatal
 * (the heatmap can't render bandless).
 */

jest.mock('@/app-layer/usecases/risk', () => ({
    listRisks: jest.fn(),
}));
jest.mock('@/app-layer/usecases/risk-analytics', () => ({
    getRiskQuantitativeAnalytics: jest.fn(),
    getRiskCoherence: jest.fn(),
}));
jest.mock('@/app-layer/usecases/risk-staleness', () => ({
    getRiskStaleness: jest.fn(),
}));
jest.mock('@/app-layer/usecases/risk-appetite', () => ({
    getAppetiteConfig: jest.fn(),
    getAppetiteStatus: jest.fn(),
}));
jest.mock('@/app-layer/usecases/monte-carlo', () => ({
    getLatestSimulation: jest.fn(),
}));
jest.mock('@/app-layer/usecases/risk-matrix-config', () => ({
    getRiskMatrixConfig: jest.fn(),
}));

import { listRisks } from '@/app-layer/usecases/risk';
import {
    getRiskQuantitativeAnalytics,
    getRiskCoherence,
} from '@/app-layer/usecases/risk-analytics';
import { getRiskStaleness } from '@/app-layer/usecases/risk-staleness';
import { getAppetiteConfig, getAppetiteStatus } from '@/app-layer/usecases/risk-appetite';
import { getLatestSimulation } from '@/app-layer/usecases/monte-carlo';
import { getRiskMatrixConfig } from '@/app-layer/usecases/risk-matrix-config';
import { getRiskDashboard } from '@/app-layer/usecases/risk-dashboard';
import { makeRequestContext } from '../helpers/make-context';

const readerCtx = makeRequestContext('READER');

const MATRIX = {
    likelihoodLevels: 5,
    impactLevels: 5,
    axisLikelihoodLabel: 'Likelihood',
    axisImpactLabel: 'Impact',
    levelLabels: { likelihood: ['1', '2', '3', '4', '5'], impact: ['1', '2', '3', '4', '5'] },
    bands: [{ name: 'Low', minScore: 1, maxScore: 25, color: '#22c55e' }],
};

beforeEach(() => {
    jest.clearAllMocks();
    (listRisks as jest.Mock).mockResolvedValue([{ id: 'r-1' }]);
    (getRiskQuantitativeAnalytics as jest.Mock).mockResolvedValue({ totals: { totalCount: 1, quantifiedCount: 0 } });
    (getRiskCoherence as jest.Mock).mockResolvedValue({ flags: [], quantifiedCount: 0, minRequired: 5 });
    (getRiskStaleness as jest.Mock).mockResolvedValue({ staleRisks: [], staleCount: 0, totalCount: 1 });
    (getAppetiteConfig as jest.Mock).mockResolvedValue({ totalAleThreshold: 100_000 });
    (getAppetiteStatus as jest.Mock).mockResolvedValue({ status: 'WITHIN', portfolioAle: 50_000, activeBreaches: 0 });
    (getLatestSimulation as jest.Mock).mockResolvedValue(null);
    (getRiskMatrixConfig as jest.Mock).mockResolvedValue(MATRIX);
});

describe('getRiskDashboard', () => {
    it('fans out to all seven data sources + the matrix config in a single call', async () => {
        await getRiskDashboard(readerCtx);
        expect(listRisks).toHaveBeenCalledTimes(1);
        expect(getRiskQuantitativeAnalytics).toHaveBeenCalledTimes(1);
        expect(getRiskCoherence).toHaveBeenCalledTimes(1);
        expect(getRiskStaleness).toHaveBeenCalledTimes(1);
        expect(getAppetiteConfig).toHaveBeenCalledTimes(1);
        expect(getAppetiteStatus).toHaveBeenCalledTimes(1);
        expect(getLatestSimulation).toHaveBeenCalledTimes(1);
        expect(getRiskMatrixConfig).toHaveBeenCalledTimes(1);
    });

    it('returns every slot in one payload, with appetite as a config+status envelope', async () => {
        const payload = await getRiskDashboard(readerCtx);
        expect(payload.risks).toEqual([{ id: 'r-1' }]);
        expect(payload.analytics).toEqual({ totals: { totalCount: 1, quantifiedCount: 0 } });
        expect(payload.coherence).toMatchObject({ flags: [] });
        expect(payload.staleness).toMatchObject({ staleCount: 0 });
        expect(payload.appetite).toEqual({
            config: { totalAleThreshold: 100_000 },
            status: { status: 'WITHIN', portfolioAle: 50_000, activeBreaches: 0 },
        });
        expect(payload.simulation).toBeNull();
        expect(payload.matrix).toBe(MATRIX);
    });

    it('failure-soft: a thrown analytics branch becomes null, the rest survives', async () => {
        (getRiskQuantitativeAnalytics as jest.Mock).mockRejectedValue(new Error('boom'));
        const payload = await getRiskDashboard(readerCtx);
        expect(payload.analytics).toBeNull();
        expect(payload.risks).toEqual([{ id: 'r-1' }]); // unaffected
        expect(payload.matrix).toBe(MATRIX);
    });

    it('failure-soft: thrown coherence + staleness + appetite-config branches collapse to null independently', async () => {
        (getRiskCoherence as jest.Mock).mockRejectedValue(new Error('coh'));
        (getRiskStaleness as jest.Mock).mockRejectedValue(new Error('stale'));
        (getAppetiteConfig as jest.Mock).mockRejectedValue(new Error('app'));
        const payload = await getRiskDashboard(readerCtx);
        expect(payload.coherence).toBeNull();
        expect(payload.staleness).toBeNull();
        // Appetite collapses on EITHER side failing — the envelope
        // is all-or-nothing.
        expect(payload.appetite).toBeNull();
        // Risks + analytics + matrix still resolve.
        expect(payload.risks).toEqual([{ id: 'r-1' }]);
        expect(payload.analytics).toEqual({ totals: { totalCount: 1, quantifiedCount: 0 } });
    });

    it('failure-soft: a thrown appetite-status alone also nulls the envelope (the panel needs both)', async () => {
        (getAppetiteStatus as jest.Mock).mockRejectedValue(new Error('status'));
        const payload = await getRiskDashboard(readerCtx);
        expect(payload.appetite).toBeNull();
    });

    it('failure-soft: a thrown simulation branch becomes null (the page already handles null)', async () => {
        (getLatestSimulation as jest.Mock).mockRejectedValue(new Error('sim'));
        const payload = await getRiskDashboard(readerCtx);
        expect(payload.simulation).toBeNull();
    });

    it('throws when the matrix branch fails — the heatmap cannot render bandless', async () => {
        (getRiskMatrixConfig as jest.Mock).mockRejectedValue(new Error('matrix down'));
        await expect(getRiskDashboard(readerCtx)).rejects.toThrow('matrix down');
    });
});
