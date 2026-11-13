/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ2-1 — per-mutation score provenance.
 *
 * Three layers:
 *   1. `recordScoreEvent` / `listScoreEvents` behavior (mocked db).
 *   2. Wiring — createRisk / createRiskFromTemplate / updateRisk
 *      append the right ledger entries with the right
 *      kind/source/values, inside the SAME transaction handle.
 *   3. The both-or-neither residual contract + derived rollup.
 *
 * The structural pairing ratchet lives in
 * tests/guardrails/risk-score-provenance.test.ts.
 */

const mockDb = {
    tenant: { findUnique: jest.fn() },
    riskMatrixConfig: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    risk: { findFirst: jest.fn(), findMany: jest.fn() },
    riskScoreEvent: { create: jest.fn(), findMany: jest.fn() },
    taskLink: { findMany: jest.fn().mockResolvedValue([]) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (opts: any) => opts.loader()),
    bumpEntityCacheVersion: jest.fn(),
}));

jest.mock('@/app-layer/repositories/RiskRepository', () => ({
    RiskRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        linkControl: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/RiskTemplateRepository', () => ({
    RiskTemplateRepository: { getById: jest.fn() },
}));

jest.mock('@/lib/risk-scoring', () => ({
    calculateRiskScore: jest.fn((l: number, i: number) => l * i),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s),
}));

jest.mock('@/app-layer/notifications/assignment', () => ({
    createAssignmentNotification: jest.fn(),
}));

jest.mock('@/app-layer/usecases/soft-delete-operations', () => ({
    restoreEntity: jest.fn(),
    purgeEntity: jest.fn(),
}));

jest.mock('@/lib/soft-delete', () => ({
    withDeleted: jest.fn((args: any) => args),
}));

jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { RiskTemplateRepository } from '@/app-layer/repositories/RiskTemplateRepository';
import { createRisk, createRiskFromTemplate, updateRisk } from '@/app-layer/usecases/risk';
import { recordScoreEvent, listScoreEvents } from '@/app-layer/usecases/risk-score-events';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.riskMatrixConfig.findUnique as jest.Mock).mockResolvedValue(null);
    (mockDb.riskScoreEvent.create as jest.Mock).mockResolvedValue({ id: 'ev-1' });
});

const editorCtx = makeRequestContext('EDITOR', { tenantSlug: 'acme' });
const readerCtx = makeRequestContext('READER');

// ─── recordScoreEvent — direct seam ────────────────────────────────

describe('recordScoreEvent', () => {
    it('writes the full provenance row on the SAME db handle it was given', async () => {
        await recordScoreEvent(mockDb, 'tenant-1', {
            riskId: 'r-1',
            kind: 'RESIDUAL',
            likelihood: 2,
            impact: 3,
            score: 6,
            source: 'DERIVED',
            justification: 'control suggestion accepted',
            createdByUserId: 'u-1',
        });

        const args = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0];
        expect(args.data).toEqual({
            tenantId: 'tenant-1',
            riskId: 'r-1',
            kind: 'RESIDUAL',
            likelihood: 2,
            impact: 3,
            score: 6,
            source: 'DERIVED',
            justification: 'control suggestion accepted',
            createdByUserId: 'u-1',
        });
    });

    it('normalises absent justification/actor to null (PLAN-style writes)', async () => {
        await recordScoreEvent(mockDb, 'tenant-1', {
            riskId: 'r-1', kind: 'RESIDUAL', likelihood: 0, impact: 0, score: 2, source: 'PLAN',
        });
        const args = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0];
        expect(args.data.justification).toBeNull();
        expect(args.data.createdByUserId).toBeNull();
    });
});

// ─── createRisk wiring ──────────────────────────────────────────────

describe('createRisk → INHERENT ledger entry', () => {
    it('appends one USER-source INHERENT event matching the computed score', async () => {
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X' });

        await createRisk(editorCtx, { title: 'X', likelihood: 4, impact: 5 });

        expect(mockDb.riskScoreEvent.create).toHaveBeenCalledTimes(1);
        const args = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0].data;
        expect(args).toMatchObject({
            riskId: 'r-1',
            kind: 'INHERENT',
            likelihood: 4,
            impact: 5,
            score: 20,
            source: 'USER',
            createdByUserId: editorCtx.userId,
        });
    });

    it('records the 3/3 defaults when dimensions are omitted', async () => {
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X' });
        await createRisk(editorCtx, { title: 'X' });
        const args = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0].data;
        expect(args).toMatchObject({ likelihood: 3, impact: 3, score: 9 });
    });
});

describe('createRiskFromTemplate → INHERENT ledger entry', () => {
    it('appends a USER-source event carrying the template provenance in the justification', async () => {
        (RiskTemplateRepository.getById as jest.Mock).mockResolvedValue({
            id: 't-1', title: 'Tmpl', description: null, category: null,
            defaultLikelihood: 4, defaultImpact: 2,
        });
        (RiskRepository.create as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'Tmpl' });

        await createRiskFromTemplate(editorCtx, 't-1');

        const args = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0].data;
        expect(args).toMatchObject({
            kind: 'INHERENT', likelihood: 4, impact: 2, score: 8, source: 'USER',
        });
        expect(args.justification).toMatch(/template: Tmpl/);
    });
});

// ─── updateRisk wiring ──────────────────────────────────────────────

describe('updateRisk → ledger entries', () => {
    beforeEach(() => {
        (RiskRepository.getById as jest.Mock).mockResolvedValue({ id: 'r-1', ownerUserId: null });
        (RiskRepository.update as jest.Mock).mockResolvedValue({ id: 'r-1', title: 'X', ownerUserId: null });
    });

    it('L/I edit appends exactly one INHERENT event', async () => {
        await updateRisk(editorCtx, 'r-1', { likelihood: 5, impact: 5 });

        expect(mockDb.riskScoreEvent.create).toHaveBeenCalledTimes(1);
        const args = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0].data;
        expect(args).toMatchObject({ kind: 'INHERENT', likelihood: 5, impact: 5, score: 25, source: 'USER' });
    });

    it('non-score edits append NO events', async () => {
        await updateRisk(editorCtx, 'r-1', { title: 'renamed' });
        expect(mockDb.riskScoreEvent.create).not.toHaveBeenCalled();
    });

    it('residual pair derives the rollup, persists all three fields, and appends a RESIDUAL event', async () => {
        await updateRisk(editorCtx, 'r-1', {
            residualLikelihood: 2, residualImpact: 3, scoreJustification: 'post-controls view',
        });

        // Derived rollup persisted on the row.
        const updateArgs = (RiskRepository.update as jest.Mock).mock.calls[0][3];
        expect(updateArgs.residualLikelihood).toBe(2);
        expect(updateArgs.residualImpact).toBe(3);
        expect(updateArgs.residualScore).toBe(6);
        expect(updateArgs.residualScoreSetAt).toBeInstanceOf(Date);

        // Ledger entry with the justification.
        expect(mockDb.riskScoreEvent.create).toHaveBeenCalledTimes(1);
        const ev = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls[0][0].data;
        expect(ev).toMatchObject({
            kind: 'RESIDUAL', likelihood: 2, impact: 3, score: 6, source: 'USER',
            justification: 'post-controls view',
        });
    });

    it('L/I + residual pair in one call appends BOTH events', async () => {
        await updateRisk(editorCtx, 'r-1', {
            likelihood: 4, impact: 4, residualLikelihood: 2, residualImpact: 2,
        });
        expect(mockDb.riskScoreEvent.create).toHaveBeenCalledTimes(2);
        const kinds = (mockDb.riskScoreEvent.create as jest.Mock).mock.calls.map((c) => c[0].data.kind);
        expect(kinds.sort()).toEqual(['INHERENT', 'RESIDUAL']);
    });

    it('rejects an incomplete residual pair with badRequest (no write, no event)', async () => {
        await expect(updateRisk(editorCtx, 'r-1', { residualLikelihood: 2 }))
            .rejects.toThrow(/must be supplied together/);
        expect(RiskRepository.update).not.toHaveBeenCalled();
        expect(mockDb.riskScoreEvent.create).not.toHaveBeenCalled();
    });
});

// ─── listScoreEvents — read path ───────────────────────────────────

describe('listScoreEvents', () => {
    it('returns newest-first, clamped take, with batched actor attach', async () => {
        (mockDb.riskScoreEvent.findMany as jest.Mock).mockResolvedValue([
            { id: 'e-2', createdByUserId: 'u-1' },
            { id: 'e-1', createdByUserId: null },
        ]);
        (mockDb.user.findMany as jest.Mock).mockResolvedValue([{ id: 'u-1', name: 'Alice' }]);

        const rows = (await listScoreEvents(readerCtx, 'r-1', { take: 999 })) as any[];

        const q = (mockDb.riskScoreEvent.findMany as jest.Mock).mock.calls[0][0];
        expect(q.orderBy).toEqual({ createdAt: 'desc' });
        expect(q.take).toBe(200); // clamp ceiling
        expect(q.where).toEqual({ tenantId: readerCtx.tenantId, riskId: 'r-1' });

        expect(rows[0].actor).toEqual({ id: 'u-1', name: 'Alice' });
        expect(rows[1].actor).toBeNull();
        expect(mockDb.user.findMany).toHaveBeenCalledTimes(1); // batched
    });

    it('zero-actor fast path skips the user lookup', async () => {
        (mockDb.riskScoreEvent.findMany as jest.Mock).mockResolvedValue([
            { id: 'e-1', createdByUserId: null },
        ]);
        const rows = (await listScoreEvents(readerCtx, 'r-1')) as any[];
        expect(rows[0].actor).toBeNull();
        expect(mockDb.user.findMany).not.toHaveBeenCalled();
    });
});
