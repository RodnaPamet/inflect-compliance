/**
 * The Prisma `MappingStore` (#5937 step 2): every query names the person's
 * tenant, user and provider, each call is its own short transaction, and a
 * patch never overwrites the client id an insert recorded.
 *
 * The integration suite `tests/integration/calendar-push-writer.test.ts` runs
 * the same store against a real database under RLS.
 */
import { createPrismaMappingStore, MAPPING_READ_CAP } from '@/app-layer/usecases/calendar-mapping-store';
import type { CalendarTenantRun } from '@/app-layer/usecases/user-calendar-connection';

const NOW = new Date('2026-11-25T03:00:00.000Z');
const OWNER = { tenantId: 't1', userId: 'u1', provider: 'outlook-calendar' as const };

function harness() {
    const m = {
        findMany: jest.fn(async () => []),
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
        deleteMany: jest.fn(async () => ({ count: 1 })),
    };
    let transactions = 0;
    const run: CalendarTenantRun = (cb) => {
        transactions += 1;
        return cb({ userCalendarEventMapping: m } as never);
    };
    return { m, run, transactions: () => transactions, store: createPrismaMappingStore(run, OWNER, () => NOW) };
}

describe('the mapping store', () => {
    it('reads only this person\'s rows for this provider, bounded', async () => {
        const h = harness();
        await h.store.list();
        expect(h.m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: OWNER, take: MAPPING_READ_CAP }));
    });

    it('records an insert with its client id, PUSHED, stamped', async () => {
        const h = harness();
        await h.store.upsertPushed({ sourceKey: 'task-due', sourceEntityId: 'x', remoteEventId: 'r1', clientEventId: 'c1', contentHash: 'h1' });
        const arg = (h.m.upsert.mock.calls[0] as unknown as [Record<string, Record<string, unknown>>])[0];
        expect(arg.where).toEqual({ tenantId_userId_provider_sourceKey_sourceEntityId: { ...OWNER, sourceKey: 'task-due', sourceEntityId: 'x' } });
        expect(arg.create).toMatchObject({ ...OWNER, remoteEventId: 'r1', clientEventId: 'c1', state: 'PUSHED', lastPushedAt: NOW });
        expect(arg.update).toMatchObject({ clientEventId: 'c1', state: 'PUSHED', lastError: null });
    });

    it('a patch (empty client id) keeps the client id the insert recorded', async () => {
        const h = harness();
        await h.store.upsertPushed({ sourceKey: 'task-due', sourceEntityId: 'x', remoteEventId: 'r2', clientEventId: '', contentHash: 'h2' });
        const arg = (h.m.upsert.mock.calls[0] as unknown as [Record<string, Record<string, unknown>>])[0];
        expect(arg.update).not.toHaveProperty('clientEventId');
        expect(arg.update).toMatchObject({ remoteEventId: 'r2', contentHash: 'h2' });
    });

    it('a failed removal keeps the row, PENDING_DELETE, with a bounded error', async () => {
        const h = harness();
        await h.store.markPendingDelete({ sourceKey: 'task-due', sourceEntityId: 'x', error: 'e'.repeat(1000) });
        const arg = (h.m.updateMany.mock.calls[0] as unknown as [{ where: unknown; data: { state: string; lastError: string } }])[0];
        expect(arg.where).toEqual({ ...OWNER, sourceKey: 'task-due', sourceEntityId: 'x' });
        expect(arg.data.state).toBe('PENDING_DELETE');
        expect(arg.data.lastError.length).toBe(300);
        expect(h.m.deleteMany).not.toHaveBeenCalled();
    });

    it('drops exactly one row, scoped to the person', async () => {
        const h = harness();
        await h.store.drop({ sourceKey: 'task-due', sourceEntityId: 'x' });
        expect(h.m.deleteMany).toHaveBeenCalledWith({ where: { ...OWNER, sourceKey: 'task-due', sourceEntityId: 'x' } });
    });

    it('opens one transaction per call, so none is held across a provider request', async () => {
        const h = harness();
        await h.store.list();
        await h.store.markFailed({ sourceKey: 'task-due', sourceEntityId: 'x', error: 'boom' });
        await h.store.drop({ sourceKey: 'task-due', sourceEntityId: 'x' });
        expect(h.transactions()).toBe(3);
    });
});
