/**
 * #5102 — the deadline job's status write is conditional on the status the
 * row was read in, and only rows the write moved are announced.
 *
 * Between the job's read and its write a person can file the report
 * (SUBMITTED) or mark the incident not reportable (NOT_REQUIRED). The write
 * used to be unconditional, so a filed Article 23 report became OVERDUE and
 * every admin was told the regulatory deadline had been missed.
 */
import type { PrismaClient } from '@prisma/client';
import { processIncidentNotificationDeadlines } from '@/app-layer/jobs/incident-notification-deadlines';

const now = new Date('2026-06-03T00:00:00.000Z');

function candidate(status: 'PENDING' | 'DUE') {
    return {
        id: 'n-1',
        tenantId: 't-1',
        incidentId: 'inc-1',
        kind: 'EARLY_WARNING_24H',
        dueAt: new Date('2026-06-02T00:00:00.000Z'), // a day past due
        status,
        incident: { reference: 'INC-2026-001', ownerUserId: 'owner-1', tenant: { slug: 'acme' } },
    };
}

function fakeDb(movedIds: string[]) {
    const updateManyAndReturn = jest.fn(async () => movedIds.map((id) => ({ id })));
    const createMany = jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const db = {
        incidentNotification: {
            findMany: jest.fn(async () => [candidate('PENDING')]),
            updateManyAndReturn,
        },
        tenantMembership: { findMany: jest.fn(async () => [{ tenantId: 't-1', userId: 'admin-1' }]) },
        notification: { createMany },
    };
    return { db: db as unknown as PrismaClient, updateManyAndReturn, createMany };
}

describe('incident deadline job — conditional status write (#5102)', () => {
    it('writes OVERDUE only over a row still PENDING or DUE', async () => {
        const { db, updateManyAndReturn } = fakeDb(['n-1']);
        await processIncidentNotificationDeadlines(db, { now });
        expect(updateManyAndReturn).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ['n-1'] }, status: { in: ['PENDING', 'DUE'] } },
                data: { status: 'OVERDUE' },
            }),
        );
    });

    it('announces nothing for a row that was filed between the read and the write', async () => {
        // The conditional write matched no row: somebody submitted it.
        const { db, createMany } = fakeDb([]);
        const result = await processIncidentNotificationDeadlines(db, { now });
        expect(createMany).not.toHaveBeenCalled();
        expect(result.becameOverdue).toBe(0);
    });

    it('announces the row the write did move', async () => {
        const { db, createMany } = fakeDb(['n-1']);
        const result = await processIncidentNotificationDeadlines(db, { now });
        expect(result.becameOverdue).toBe(1);
        expect(createMany).toHaveBeenCalledTimes(1);
    });
});
