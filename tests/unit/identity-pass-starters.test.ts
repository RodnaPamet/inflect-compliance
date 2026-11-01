/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/** #4876 — who each joiner-pass decision is about. */
const mockDb = { employee: { findMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));

import { decisionEmployeeIds, resolveStarterNames } from '@/app-layer/usecases/identity-pass-starters';

const ctx = { tenantId: 't1', userId: 'u1' } as any;

beforeEach(() => jest.clearAllMocks());

it('collects distinct employee ids across passes', () => {
    expect(
        decisionEmployeeIds([
            { resultJson: { decisions: [{ employeeId: 'e1' }, { employeeId: 'e2' }] } },
            { resultJson: { decisions: [{ employeeId: 'e1' }] } },
            { resultJson: { refusal: 'NO_STARTERS' } },
            { resultJson: null },
        ]).sort(),
    ).toEqual(['e1', 'e2']);
});

it('reads nothing for no ids', async () => {
    expect(await resolveStarterNames(ctx, [])).toEqual({});
    expect(mockDb.employee.findMany).not.toHaveBeenCalled();
});

it('names the starters it finds, in this tenant only, and leaves the rest absent', async () => {
    mockDb.employee.findMany.mockResolvedValue([{ id: 'e1', fullName: 'Ada Lovelace' }]);
    expect(await resolveStarterNames(ctx, ['e1', 'gone'])).toEqual({ e1: 'Ada Lovelace' });
    expect(mockDb.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 't1', id: { in: ['e1', 'gone'] } }, take: 2 }),
    );
});
