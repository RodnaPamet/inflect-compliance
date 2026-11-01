/**
 * `readQueuePeople` — the reconciliation queue's candidates by name (#4871).
 *
 * The queue names candidates by `employeeId`. This resolves them to the name
 * and work email HR holds, under the queue's own view gate, reading only the
 * ids on the page and writing nothing.
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));

import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { MAX_QUEUE_PEOPLE, readQueuePeople } from '@/app-layer/usecases/legacy-queue-people';

const mockRun = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

function withEmployees(rows: Array<{ id: string; fullName: string | null; workEmail: string | null }>) {
    const findMany = jest.fn(async () => rows);
    mockRun.mockImplementation(async (_ctx, fn) => fn({ employee: { findMany } } as never));
    return findMany;
}

const queue = (...ids: string[][]) => ids.map((c) => ({ candidates: c.map((employeeId) => ({ employeeId })) }));

beforeEach(() => mockRun.mockReset());

it('maps each candidate id to its HR name and work email', async () => {
    const findMany = withEmployees([
        { id: 'emp-1', fullName: 'Ana Petrova', workEmail: 'ana@acme.test' },
        { id: 'emp-2', fullName: 'Ivan Kolev', workEmail: '' },
    ]);
    const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });

    const people = await readQueuePeople(ctx, queue(['emp-1', 'emp-2'], ['emp-1']));

    expect(people).toEqual({
        'emp-1': { name: 'Ana Petrova', email: 'ana@acme.test' },
        'emp-2': { name: 'Ivan Kolev', email: null },
    });
    // One read, of the distinct ids on the page, in this tenant, bounded.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', id: { in: ['emp-1', 'emp-2'] } },
        select: { id: true, fullName: true, workEmail: true },
        take: 2,
    });
});

it('leaves out an id HR no longer holds, so the page names it as unknown', async () => {
    withEmployees([{ id: 'emp-1', fullName: 'Ana Petrova', workEmail: null }]);
    const people = await readQueuePeople(makeRequestContext('ADMIN'), queue(['emp-1', 'emp-gone']));
    expect(Object.keys(people)).toEqual(['emp-1']);
});

it('reads nothing for a page with no candidates', async () => {
    const findMany = withEmployees([]);
    expect(await readQueuePeople(makeRequestContext('ADMIN'), queue([], []))).toEqual({});
    expect(findMany).not.toHaveBeenCalled();
});

it('reads at most MAX_QUEUE_PEOPLE ids', async () => {
    const findMany = withEmployees([]);
    const ids = Array.from({ length: MAX_QUEUE_PEOPLE + 3 }, (_, i) => `emp-${i}`);
    await readQueuePeople(makeRequestContext('ADMIN'), queue(ids));
    const arg = (findMany.mock.calls[0] as unknown[])[0] as { where: { id: { in: string[] } }; take: number };
    expect(arg.where.id.in).toHaveLength(MAX_QUEUE_PEOPLE);
    expect(arg.take).toBe(MAX_QUEUE_PEOPLE);
});

it('refuses a caller without the queue view key, before any read', async () => {
    const findMany = withEmployees([]);
    const ctx = makeRequestContext('READER');
    ctx.appPermissions = {
        ...ctx.appPermissions,
        identity_reconciliation: { view: false, confirm: false },
    };
    await expect(readQueuePeople(ctx, queue(['emp-1']))).rejects.toThrow(/identity_reconciliation\.view/);
    expect(findMany).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
});
