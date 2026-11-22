/**
 * #5061 — a duplicate email must not abort the caller's transaction.
 *
 * `enqueueEmail` is called with the caller's interactive transaction (task
 * assignment, policy approval request). Its dedupe key is unique per
 * recipient, entity and day, so a re-assignment back to the same person the
 * same day meets an existing row. A unique violation that is caught still
 * aborts the transaction in Postgres: the caller's next statement then fails
 * with 25P02 and the assignment rolls back. The insert must therefore never
 * fail on a duplicate.
 */
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('enqueueEmail inside a transaction (#5061)', () => {
    let prisma: PrismaClient;
    let tenantId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const slug = `outbox-dup-${randomUUID().slice(0, 8)}`;
        tenantId = (await prisma.tenant.create({ data: { name: slug, slug } })).id;
    });

    afterAll(async () => {
        if (tenantId) {
            await prisma.notificationOutbox.deleteMany({ where: { tenantId } }).catch(() => undefined);
            await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
        }
        await prisma.$disconnect();
    });

    it('a second enqueue of the same email the same day is skipped, and the transaction still commits', async () => {
        const email = {
            tenantId,
            type: 'TASK_ASSIGNED' as const,
            toEmail: 'dana@example.com',
            entityId: 'task-1',
            payload: {
                taskTitle: 'Rotate the edge certificates',
                taskKey: 'TSK-7',
                taskType: 'TASK',
                assigneeName: 'Dana Lee',
                tenantSlug: 'acme',
            },
        };

        const [first, second] = await prisma.$transaction(async (tx) => {
            const a = await enqueueEmail(tx, email);
            const b = await enqueueEmail(tx, email);
            // The caller's own write after the duplicate: an aborted
            // transaction fails this statement with 25P02.
            await tx.tenant.update({ where: { id: tenantId }, data: { name: 'renamed-after-duplicate' } });
            return [a, b];
        });

        expect(first).not.toBeNull();
        expect(second).toBeNull();
        expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name).toBe(
            'renamed-after-duplicate',
        );
        expect(await prisma.notificationOutbox.count({ where: { tenantId } })).toBe(1);
    });
});
