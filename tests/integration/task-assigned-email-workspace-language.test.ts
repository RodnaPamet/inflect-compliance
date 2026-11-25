/**
 * The task-assigned email reads its workspace's language on real rows, inside
 * the tenant's own RLS-bound transaction, as the task usecases enqueue it.
 *
 *   - TWO TENANTS: a Bulgarian workspace's outbox row is Bulgarian, and the
 *     English workspace beside it gets the English email, in the same run.
 *   - The read happens under `app_user`, so the workspace row is reachable
 *     where the email is enqueued (a refused read would abort the caller's
 *     transaction and roll back the assignment).
 */
import type { PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

describeFn('the task-assigned email in the workspace language, on real rows', () => {
    let prisma: PrismaClient;
    const SUITE = randomUUID().slice(0, 8);
    const BG = `task-mail-bg-${SUITE}`;
    const EN = `task-mail-en-${SUITE}`;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: BG, name: BG, slug: BG, defaultLocale: 'bg' } });
        await prisma.tenant.create({ data: { id: EN, name: EN, slug: EN } });
    });

    afterAll(async () => {
        await prisma.notificationOutbox.deleteMany({ where: { tenantId: { in: [BG, EN] } } });
        await deleteAuditRowsForTenants(prisma, [BG, EN]);
        await prisma.tenant.deleteMany({ where: { id: { in: [BG, EN] } } });
        await prisma.$disconnect();
    });

    const enqueueIn = (tenantId: string) =>
        runInTenantContext(makeRequestContext('ADMIN' as Role, { tenantId, tenantSlug: tenantId }), (db) =>
            enqueueEmail(db, {
                tenantId,
                type: 'TASK_ASSIGNED',
                toEmail: `dana@${tenantId}.test`,
                entityId: 'task-1',
                payload: {
                    taskTitle: 'Rotate the edge certificates',
                    taskKey: 'TSK-7',
                    taskType: 'INCIDENT',
                    assigneeName: 'Дана Лий',
                    assignerName: 'Sam Ray',
                    tenantSlug: tenantId,
                },
            }),
        );

    it('each workspace gets its own language, under its own tenant context', async () => {
        expect(await enqueueIn(BG)).not.toBeNull();
        expect(await enqueueIn(EN)).not.toBeNull();

        const bg = await prisma.notificationOutbox.findFirstOrThrow({ where: { tenantId: BG } });
        expect(bg.subject).toBe('Възложена ви е задача: [TSK-7] Rotate the edge certificates');
        expect(bg.bodyText).toContain('Здравейте, Дана Лий,');
        expect(bg.bodyText).toContain('Sam Ray ви възложи задача от вид „инцидент“:');
        expect(bg.bodyHtml).toContain('Към задачите</a>');

        const en = await prisma.notificationOutbox.findFirstOrThrow({ where: { tenantId: EN } });
        expect(en.subject).toBe('Task assigned to you: [TSK-7] Rotate the edge certificates');
        expect(en.bodyText).toContain('You have been assigned a incident task by Sam Ray:');
        expect(en.bodyHtml).toContain('View Tasks</a>');
    });
});
