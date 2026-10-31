/**
 * #4773 — the loss-event register names the risk each loss is attributed to,
 * so the list read selects the risk's id and title beside the row.
 */
const findMany = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({ lossEvent: { findMany } })),
}));

import { listLossEvents } from '@/app-layer/usecases/loss-event';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => findMany.mockReset());

describe('listLossEvents', () => {
    it('selects the attributed risk with each row', async () => {
        findMany.mockResolvedValue([{ id: 'le1', risk: { id: 'r1', title: 'Ransomware' } }]);
        const out = await listLossEvents(makeRequestContext('READER'), { take: 10 });
        expect(findMany.mock.calls[0][0].select.risk).toEqual({ select: { id: true, title: true } });
        expect(out.events[0]).toMatchObject({ risk: { id: 'r1', title: 'Ransomware' } });
        expect(out.nextCursor).toBeNull();
    });

    it('reports a next cursor when there is more than a page', async () => {
        findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        const out = await listLossEvents(makeRequestContext('READER'), { take: 2 });
        expect(out.events.map((e) => e.id)).toEqual(['a', 'b']);
        expect(out.nextCursor).toBe('b');
    });
});
