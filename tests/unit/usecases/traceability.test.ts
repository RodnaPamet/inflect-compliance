/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks +
 * fakeDb shims mirror runtime Prisma contracts; per-line typing has
 * poor cost/benefit in test files (codebase convention). */
/**
 * Unit tests for src/app-layer/usecases/traceability.ts
 *
 * The traceability usecase wires the Control ↔ Risk ↔ Asset mapping
 * graph. The branch-dense, highest-risk paths:
 *
 *   - assertCanManage — only OWNER / ADMIN / EDITOR can mutate
 *     mappings; READER + AUDITOR are denied. A regression here lets
 *     an auditor rewrite the control coverage graph.
 *   - mapAssetToRisk's three-way emit logic: a brand-new link emits
 *     ASSET_RISK_LINKED; an existing link with changed
 *     exposureLevel/rationale emits ASSET_RISK_UPDATED; a no-op
 *     re-link emits NOTHING (audit-noise suppression).
 *   - coverageSummary's percentage maths — every `* / total` has a
 *     `total > 0 ? … : 0` divide-by-zero guard.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/TraceabilityRepository', () => ({
    ControlRiskRepository: {
        listByControl: jest.fn(),
        listByRisk: jest.fn(),
        link: jest.fn(),
        unlink: jest.fn(),
    },
    AssetControlRepository: {
        listByAsset: jest.fn(),
        listByControl: jest.fn(),
        link: jest.fn(),
        unlink: jest.fn(),
    },
    AssetRiskRepository: {
        listByAsset: jest.fn(),
        listByRisk: jest.fn(),
        findLink: jest.fn(),
        link: jest.fn(),
        unlink: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/ProcessMapRepository', () => ({
    ProcessMapRepository: {
        listMapsByControl: jest.fn().mockResolvedValue([]),
        listMapsByLinkedEntity: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    mapControlToRisk,
    unmapControlFromRisk,
    mapAssetToControl,
    mapAssetToRisk,
    getControlTraceability,
    coverageSummary,
} from '@/app-layer/usecases/traceability';
import {
    ControlRiskRepository,
    AssetControlRepository,
    AssetRiskRepository,
} from '@/app-layer/repositories/TraceabilityRepository';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockCtrlRisk = ControlRiskRepository as jest.Mocked<typeof ControlRiskRepository>;
const mockAssetCtrl = AssetControlRepository as jest.Mocked<typeof AssetControlRepository>;
const mockAssetRisk = AssetRiskRepository as jest.Mocked<typeof AssetRiskRepository>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

// mapAssetToControl/mapAssetToRisk verify the asset + target exist in the
// tenant before linking; a tx whose asset/control/risk findFirst return a row
// so the existence checks pass and the emit logic under test is reached.
const linkTx = {
    asset: { findFirst: jest.fn().mockResolvedValue({ id: 'a1' }) },
    control: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
    risk: { findFirst: jest.fn().mockResolvedValue({ id: 'r1' }) },
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('assertCanManage — mutation RBAC gate', () => {
    it('rejects a READER from mapping a control to a risk', async () => {
        await expect(
            mapControlToRisk(makeRequestContext('READER'), 'c1', 'r1'),
        ).rejects.toThrow(/Only OWNER, ADMIN, or EDITOR/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('rejects an AUDITOR from mapping an asset to a control', async () => {
        await expect(
            mapAssetToControl(makeRequestContext('AUDITOR'), 'a1', 'c1'),
        ).rejects.toThrow(/Only OWNER, ADMIN, or EDITOR/);
    });

    it('rejects a READER from unmapping a control from a risk', async () => {
        await expect(
            unmapControlFromRisk(makeRequestContext('READER'), 'c1', 'r1'),
        ).rejects.toThrow(/Only OWNER, ADMIN, or EDITOR/);
    });

    it('allows an EDITOR to map a control to a risk and emits a relationship event', async () => {
        mockCtrlRisk.link.mockResolvedValueOnce({ id: 'link-1' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(linkTx as never));

        const result = await mapControlToRisk(
            makeRequestContext('EDITOR'),
            'c1',
            'r1',
            'mitigates the exposure',
        );

        expect(result).toEqual({ id: 'link-1' });
        const logArg = mockLog.mock.calls[0][2] as any;
        expect(logArg.action).toBe('CONTROL_RISK_LINKED');
        expect(logArg.detailsJson.category).toBe('relationship');
    });

    it('allows an OWNER to map a control to a risk (OWNER is a superset of ADMIN)', async () => {
        mockCtrlRisk.link.mockResolvedValueOnce({ id: 'link-2' } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(linkTx as never));

        await expect(
            mapControlToRisk(makeRequestContext('OWNER'), 'c1', 'r1'),
        ).resolves.toEqual({ id: 'link-2' });
    });
});

describe('mapAssetToRisk — link / update / no-op emit logic', () => {
    it('emits ASSET_RISK_LINKED when the link did not previously exist', async () => {
        mockAssetRisk.findLink.mockResolvedValueOnce(null as never);
        mockAssetRisk.link.mockResolvedValueOnce({
            id: 'al-1',
            exposureLevel: 'DIRECT',
            rationale: 'r',
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(linkTx as never));

        await mapAssetToRisk(makeRequestContext('EDITOR'), 'a1', 'r1', 'DIRECT', 'r');

        expect(mockLog).toHaveBeenCalledTimes(1);
        expect((mockLog.mock.calls[0][2] as any).action).toBe('ASSET_RISK_LINKED');
    });

    it('emits ASSET_RISK_UPDATED when an existing link changes exposureLevel', async () => {
        mockAssetRisk.findLink.mockResolvedValueOnce({
            exposureLevel: 'INDIRECT',
            rationale: 'r',
        } as never);
        mockAssetRisk.link.mockResolvedValueOnce({
            id: 'al-1',
            exposureLevel: 'DIRECT', // changed
            rationale: 'r',
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(linkTx as never));

        await mapAssetToRisk(makeRequestContext('EDITOR'), 'a1', 'r1', 'DIRECT', 'r');

        expect(mockLog).toHaveBeenCalledTimes(1);
        expect((mockLog.mock.calls[0][2] as any).action).toBe('ASSET_RISK_UPDATED');
    });

    it('emits NOTHING when re-linking with identical exposureLevel + rationale (no-op suppression)', async () => {
        mockAssetRisk.findLink.mockResolvedValueOnce({
            exposureLevel: 'DIRECT',
            rationale: 'same',
        } as never);
        mockAssetRisk.link.mockResolvedValueOnce({
            id: 'al-1',
            exposureLevel: 'DIRECT',
            rationale: 'same',
        } as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(linkTx as never));

        await mapAssetToRisk(makeRequestContext('EDITOR'), 'a1', 'r1', 'DIRECT', 'same');

        // identical link → no audit noise
        expect(mockLog).not.toHaveBeenCalled();
    });
});

describe('getControlTraceability — read path', () => {
    it('does not gate reads by role and fans out the repo queries (incl. process placement)', async () => {
        mockCtrlRisk.listByControl.mockResolvedValueOnce([{ id: 'r1' }] as never);
        mockAssetCtrl.listByControl.mockResolvedValueOnce([{ id: 'a1' }] as never);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(linkTx as never));

        // even a READER can read the traceability graph
        const result = await getControlTraceability(makeRequestContext('READER'), 'c1');

        // Now includes process-map placement (edge + node control links, both
        // mocked empty here) so "sits on map X" surfaces inline.
        expect(result).toEqual({
            controlId: 'c1',
            risks: [{ id: 'r1' }],
            assets: [{ id: 'a1' }],
            processMaps: [],
        });
    });
});

describe('coverageSummary — divide-by-zero guards', () => {
    function emptyCountsDb() {
        return {
            risk: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
            control: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
            asset: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
            policy: { count: jest.fn().mockResolvedValue(0) },
            policyControlLink: { findMany: jest.fn().mockResolvedValue([]) },
            riskControl: {
                findMany: jest.fn().mockResolvedValue([]),
                groupBy: jest.fn().mockResolvedValue([]),
            },
            controlAsset: { findMany: jest.fn().mockResolvedValue([]) },
            // PR-D — process-coverage inputs (empty by default).
            processEdgeControl: { findMany: jest.fn().mockResolvedValue([]) },
            processNode: { findMany: jest.fn().mockResolvedValue([]) },
        };
    }

    it('returns 0% for every coverage ratio when there are no risks/controls/assets', async () => {
        const db = emptyCountsDb();
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const summary = await coverageSummary(makeRequestContext('READER'));

        expect(summary.risksWithControlsPct).toBe(0);
        expect(summary.controlsWithRisksPct).toBe(0);
        expect(summary.assetsWithControlsPct).toBe(0);
        // no NaN may leak through any ratio
        expect(Number.isNaN(summary.risksWithControlsPct)).toBe(false);
        expect(summary.hotControls).toEqual([]);
    });

    it('computes rounded coverage percentages and joins hot-control details', async () => {
        const db = emptyCountsDb();
        db.risk.count.mockResolvedValue(4);
        db.control.count.mockResolvedValue(8);
        db.asset.count.mockResolvedValue(2);
        // riskControl.findMany is called 3x in coverageSummary:
        //   1) distinct riskId, 2) distinct controlId, 3) (none — controlAsset)
        db.riskControl.findMany
            .mockResolvedValueOnce([{ riskId: 'r1' }, { riskId: 'r2' }]) // 2 of 4 risks mapped
            .mockResolvedValueOnce([{ controlId: 'c1' }]); // 1 of 8 controls mapped
        db.controlAsset.findMany.mockResolvedValueOnce([{ assetId: 'a1' }]); // 1 of 2 assets
        db.riskControl.groupBy.mockResolvedValue([{ controlId: 'c1', _count: { riskId: 3 } }]);
        db.control.findMany.mockResolvedValue([{ id: 'c1', code: 'AC-2', name: 'Access' }]);
        // unmappedRisks query
        db.risk.findMany.mockResolvedValue([]);
        db.asset.findMany.mockResolvedValue([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const summary = await coverageSummary(makeRequestContext('READER'));

        expect(summary.totalRisks).toBe(4);
        // 2/4 → 50 %
        expect(summary.risksWithControlsPct).toBe(50);
        // 1/8 → 13 % (rounded)
        expect(summary.controlsWithRisksPct).toBe(13);
        // 1/2 → 50 %
        expect(summary.assetsWithControlsPct).toBe(50);
        expect(summary.hotControls).toHaveLength(1);
        expect(summary.hotControls[0]).toMatchObject({ id: 'c1', riskCount: 3 });
    });
});
