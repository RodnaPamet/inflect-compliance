/**
 * #4823 — `listRiskLevelsInUse` reads the live risks of the caller's workspace
 * only, as one bounded group-by, and folds each group to the higher of its
 * current and residual levels.
 */
const groupBy = jest.fn();
const db = { risk: { groupBy } };

jest.mock('@/lib/db/rls-middleware', () => ({
    withRlsTripwireExtension: <T,>(client: T): T => client,
    runInTenantContext: (_ctx: unknown, fn: (d: unknown) => unknown) => fn(db),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({ bumpEntityCacheVersion: jest.fn() }));

import { listRiskLevelsInUse } from '@/app-layer/usecases/risk-matrix-config';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => groupBy.mockReset());

it('reads only live risks in the caller\'s workspace, grouped by their four levels', async () => {
    groupBy.mockResolvedValue([]);
    await listRiskLevelsInUse(makeRequestContext('ADMIN'));
    expect(groupBy).toHaveBeenCalledWith({
        by: ['likelihood', 'impact', 'residualLikelihood', 'residualImpact'],
        where: { tenantId: 'tenant-1', deletedAt: null },
        _count: { _all: true },
    });
});

it('returns each group at the higher of its current and residual levels', async () => {
    groupBy.mockResolvedValue([
        { likelihood: 2, impact: 2, residualLikelihood: 5, residualImpact: null, _count: { _all: 3 } },
        { likelihood: 1, impact: 4, residualLikelihood: null, residualImpact: null, _count: { _all: 1 } },
    ]);
    await expect(listRiskLevelsInUse(makeRequestContext('ADMIN'))).resolves.toEqual([
        { likelihood: 1, impact: 4, count: 1 },
        { likelihood: 5, impact: 2, count: 3 },
    ]);
});

it('refuses a caller who cannot read, before any read', async () => {
    const ctx = makeRequestContext('READER', {
        permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
    });
    await expect(listRiskLevelsInUse(ctx)).rejects.toThrow();
    expect(groupBy).not.toHaveBeenCalled();
});
