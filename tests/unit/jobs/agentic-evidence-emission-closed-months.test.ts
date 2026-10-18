/**
 * The scheduled emission tick re-asserts the harness months it has moved past
 * (#3687).
 *
 * `emitAgenticEvidence` without `asOf` evidences the CURRENT month only, so a
 * month is last recomputed by its final 06:30 tick. The scan a daily scanner
 * sends later that day — the month's true latest — and every report backfilled
 * into a closed month reach the artefact only because the job ALSO calls
 * `reconcileClosedHarnessPeriods`. The usecase's own behaviour is pinned against
 * a real database in `tests/integration/agent-harness-evidence-emission.test.ts`;
 * this file pins the wiring the integration suite cannot reach without a clock:
 * the scheduled tick (no `asOf`) reconciles, a backfill of one named month does
 * not, and what the reconciliation emitted and demoted is counted, not dropped.
 */
const emitAgenticEvidence = jest.fn();
const reconcileClosedHarnessPeriods = jest.fn();
const withdrawStaleAgenticEvidence = jest.fn();

jest.mock('@/app-layer/usecases/agentic-evidence-emission', () => ({
    __esModule: true,
    emitAgenticEvidence: (...a: unknown[]) => emitAgenticEvidence(...a),
    reconcileClosedHarnessPeriods: (...a: unknown[]) => reconcileClosedHarnessPeriods(...a),
    withdrawStaleAgenticEvidence: (...a: unknown[]) => withdrawStaleAgenticEvidence(...a),
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: {
        tenantMembership: { findFirst: jest.fn(async () => ({ userId: 'user-1' })) },
    },
}));

jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { runAgenticEvidenceEmission } from '@/app-layer/jobs/agentic-evidence-emission';

const artefact = (outcome: 'created' | 'updated' | 'unchanged') => ({ outcome });

beforeEach(() => {
    jest.clearAllMocks();
    emitAgenticEvidence.mockResolvedValue({ artefacts: [artefact('unchanged')], perAgentRefused: 1 });
    reconcileClosedHarnessPeriods.mockResolvedValue({
        periodLabels: ['2026-09'],
        artefacts: [artefact('updated'), artefact('updated')],
        demotedEvidenceIds: ['ev-1'],
    });
    withdrawStaleAgenticEvidence.mockResolvedValue([]);
});

describe('the scheduled tick re-asserts closed harness months', () => {
    it('reconciles the closed months when the payload names no month, and counts what that emitted and demoted', async () => {
        const before = Date.now();
        const result = await runAgenticEvidenceEmission({ tenantId: 'tenant-1' }, 'run-1');

        expect(emitAgenticEvidence).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), {});
        expect(reconcileClosedHarnessPeriods).toHaveBeenCalledTimes(1);
        const [ctx, options] = reconcileClosedHarnessPeriods.mock.calls[0] as [{ tenantId: string }, { now: Date }];
        expect(ctx.tenantId).toBe('tenant-1');
        // The tick's own clock, not a fixed month.
        expect(options.now.getTime()).toBeGreaterThanOrEqual(before);

        // `perAgentRefused`: a per-agent artefact refused for an agent retired
        // between the plan and the write (#3700) — counted, not dropped.
        expect(result).toMatchObject({ unchanged: 1, updated: 2, demoted: 1, perAgentRefused: 1, skipped: 0 });
    });

    it('does not reconcile on a backfill of one named month', async () => {
        await runAgenticEvidenceEmission({ tenantId: 'tenant-1', asOf: '2026-07-15T00:00:00.000Z' }, 'run-2');
        expect(emitAgenticEvidence).toHaveBeenCalledWith(expect.anything(), { asOf: new Date('2026-07-15T00:00:00.000Z') });
        expect(reconcileClosedHarnessPeriods).not.toHaveBeenCalled();
    });

    it('counts a tenant whose reconciliation fails as skipped, and does not stop the sweep', async () => {
        reconcileClosedHarnessPeriods.mockRejectedValueOnce(new Error('boom'));
        const result = await runAgenticEvidenceEmission({ tenantId: 'tenant-1' }, 'run-3');
        expect(result.skipped).toBe(1);
    });
});
