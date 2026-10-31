/**
 * The framework-updates page's read model (#4736): each delta with its
 * framework's name, its requirements' titles and the controls it flagged,
 * read in bounded batches rather than once per delta.
 */
const prismaMock = {
    framework: { findMany: jest.fn() },
    frameworkRequirement: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

const tenantDb = {
    tenantFrameworkDelta: { findMany: jest.fn(), count: jest.fn() },
    control: { findMany: jest.fn() },
};
jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: typeof tenantDb) => unknown) => fn(tenantDb)),
}));
jest.mock('@/lib/db-context', () => ({ withTenantDb: jest.fn() }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: jest.fn() }));

import { listTenantFrameworkUpdateViews, countNewTenantFrameworkDeltas } from '@/app-layer/usecases/framework-delta';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('READER');

const delta = (over: Record<string, unknown> = {}) => ({
    id: 'd1',
    tenantId: ctx.tenantId,
    frameworkKey: 'ISO27001',
    fromVersion: '2013',
    toVersion: '2022',
    newGapCount: 1,
    flaggedControlCount: 2,
    flaggedControlIdsJson: JSON.stringify(['c1', 'c-gone']),
    status: 'NEW',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    diff: {
        addedCodesJson: JSON.stringify(['5.7']),
        changedCodesJson: JSON.stringify(['5.1']),
        removedCodesJson: JSON.stringify(['A.6.1.5']),
        changelog: 'Threat intelligence added.',
    },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.framework.findMany.mockResolvedValue([{ id: 'fw1', key: 'ISO27001', name: 'ISO/IEC 27001' }]);
    prismaMock.frameworkRequirement.findMany.mockResolvedValue([
        { frameworkId: 'fw1', code: '5.7', title: 'Threat intelligence' },
        { frameworkId: 'fw1', code: '5.1', title: 'Policies for information security' },
    ]);
    tenantDb.control.findMany.mockResolvedValue([{ id: 'c1', code: 'A.5.1', name: 'Information security policy' }]);
});

describe('listTenantFrameworkUpdateViews', () => {
    it('names the framework, titles the requirements, carries the changelog and lists the flagged controls', async () => {
        tenantDb.tenantFrameworkDelta.findMany.mockResolvedValue([delta()]);

        const [view] = await listTenantFrameworkUpdateViews(ctx);

        expect(view.frameworkName).toBe('ISO/IEC 27001');
        expect(view.changelog).toBe('Threat intelligence added.');
        expect(view.added).toEqual([{ code: '5.7', title: 'Threat intelligence' }]);
        expect(view.changed).toEqual([{ code: '5.1', title: 'Policies for information security' }]);
        // No catalogue row for a removed code reads as no title, not a guess.
        expect(view.removed).toEqual([{ code: 'A.6.1.5', title: null }]);
        // A flagged control the workspace no longer has is left out.
        expect(view.flaggedControls).toEqual([{ id: 'c1', code: 'A.5.1', name: 'Information security policy' }]);
        expect(view.createdAt).toBe('2026-10-01T00:00:00.000Z');
    });

    it('reads each catalogue and control table once, however many deltas there are', async () => {
        tenantDb.tenantFrameworkDelta.findMany.mockResolvedValue([delta(), delta({ id: 'd2' }), delta({ id: 'd3' })]);

        await listTenantFrameworkUpdateViews(ctx);

        expect(prismaMock.framework.findMany).toHaveBeenCalledTimes(1);
        expect(prismaMock.frameworkRequirement.findMany).toHaveBeenCalledTimes(1);
        expect(tenantDb.control.findMany).toHaveBeenCalledTimes(1);
        const controlWhere = tenantDb.control.findMany.mock.calls[0][0].where;
        expect(controlWhere).toMatchObject({ tenantId: ctx.tenantId, deletedAt: null, id: { in: ['c1', 'c-gone'] } });
    });

    it('treats an unreadable stored list as empty rather than failing the page', async () => {
        tenantDb.tenantFrameworkDelta.findMany.mockResolvedValue([
            delta({ flaggedControlIdsJson: 'not json', diff: { addedCodesJson: '{"a":1}', changedCodesJson: null, removedCodesJson: '[]', changelog: null } }),
        ]);

        const [view] = await listTenantFrameworkUpdateViews(ctx);

        expect(view.added).toEqual([]);
        expect(view.flaggedControls).toEqual([]);
        expect(tenantDb.control.findMany).not.toHaveBeenCalled();
    });

    it('reads nothing more when there is no delta', async () => {
        tenantDb.tenantFrameworkDelta.findMany.mockResolvedValue([]);
        await expect(listTenantFrameworkUpdateViews(ctx)).resolves.toEqual([]);
        expect(prismaMock.framework.findMany).not.toHaveBeenCalled();
    });
});

describe('countNewTenantFrameworkDeltas', () => {
    it('counts the NEW deltas of this workspace', async () => {
        tenantDb.tenantFrameworkDelta.count.mockResolvedValue(2);
        await expect(countNewTenantFrameworkDeltas(ctx)).resolves.toBe(2);
        expect(tenantDb.tenantFrameworkDelta.count).toHaveBeenCalledWith({ where: { tenantId: ctx.tenantId, status: 'NEW' } });
    });
});
