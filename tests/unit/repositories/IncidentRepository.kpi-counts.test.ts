/**
 * `IncidentRepository.kpiCounts` — the Incidents register's three KPI cards
 * plus the header count (#4463). They are counted over the tenant's whole
 * incident population, so they stay right when the list read is capped.
 */
import { IncidentRepository } from '@/app-layer/repositories/IncidentRepository';
import { makeRequestContext } from '../../helpers/make-context';
import type { PrismaTx } from '@/lib/db-context';

function fakeDb(answers: number[]) {
    const calls: unknown[] = [];
    const count = jest.fn(async (args: unknown) => {
        calls.push(args);
        return answers[calls.length - 1];
    });
    return { db: { incident: { count } } as unknown as PrismaTx, calls };
}

describe('IncidentRepository.kpiCounts', () => {
    const ctx = makeRequestContext('READER', { tenantId: 'tenant-A' });

    it('counts total, open (not CLOSED), reportable, and due-or-overdue, each in the tenant', async () => {
        const { db, calls } = fakeDb([40, 31, 9, 4]);
        const counts = await IncidentRepository.kpiCounts(db, ctx);

        expect(counts).toEqual({ total: 40, open: 31, reportable: 9, deadlinesDueOrOverdue: 4 });
        expect(calls).toEqual([
            { where: { tenantId: 'tenant-A' } },
            { where: { tenantId: 'tenant-A', phase: { not: 'CLOSED' } } },
            { where: { tenantId: 'tenant-A', reportable: true } },
            {
                where: {
                    tenantId: 'tenant-A',
                    notifications: { some: { status: { in: ['DUE', 'OVERDUE'] } } },
                },
            },
        ]);
    });
});
