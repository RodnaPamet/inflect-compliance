/**
 * Integration tests for the TaskKeySequence atomic key counter
 * (#102 item 2).
 *
 * The previous `TaskRepository.create` derived `TSK-N` keys from
 * `db.task.count()` — which raced the unique `[tenantId, key]` index
 * under concurrent creates. The replacement is an `upsert` with an
 * atomic `increment`. This proves 20 fully-concurrent creates produce
 * a contiguous, collision-free key range.
 */
import { randomUUID } from 'node:crypto';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import {
    createTenant,
    createUser,
    buildRequestContext,
} from '../helpers/factories';
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';

// The `beforeEach` resets ~30 tables via `resetDatabase` + a raw
// TRUNCATE. Under a loaded CI run that reset can transiently block
// on lock contention past Jest's 5 s hook default — raise the
// per-file budget so a slow reset doesn't flake the suite.
jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('TaskKeySequence — atomic TSK-N key generation (#102 item 2)', () => {
    const prisma = prismaTestClient() as PrismaClient;

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await resetDatabase(prisma);
        // TaskKeySequence is not in resetDatabase's table list.
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "TaskKeySequence" CASCADE');
    });

    async function seed() {
        const tenant = await createTenant(prisma, {
            id: randomUUID(),
            slug: `t-${randomUUID().slice(0, 8)}`,
        });
        const user = await createUser(prisma, {
            id: randomUUID(),
            email: `${randomUUID()}@test.local`,
        });
        const ctx = buildRequestContext({ tenantId: tenant.id, userId: user.id });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { tenant, user, ctx: ctx as any };
    }

    test('20 concurrent creates produce contiguous TSK-1 … TSK-20', async () => {
        const { ctx } = await seed();

        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                TaskRepository.create(prisma, ctx, { title: `Task ${i + 1}` }),
            ),
        );

        const keys = results
            .map((r) => r.key as string)
            .sort(
                (a, b) =>
                    Number(a.replace('TSK-', '')) - Number(b.replace('TSK-', '')),
            );

        expect(keys).toEqual(
            Array.from({ length: 20 }, (_, i) => `TSK-${i + 1}`),
        );
        // No two creates minted the same key.
        expect(new Set(keys).size).toBe(20);
    });

    test('the sequence continues from a backfilled lastValue', async () => {
        const { tenant, ctx } = await seed();
        // Simulate a tenant whose counter was backfilled at TSK-7.
        await prisma.taskKeySequence.create({
            data: { tenantId: tenant.id, lastValue: 7 },
        });

        const task = await TaskRepository.create(prisma, ctx, {
            title: 'next',
        });

        expect(task.key).toBe('TSK-8');
    });

    test('a fresh tenant starts its sequence at TSK-1', async () => {
        const { ctx } = await seed();
        const task = await TaskRepository.create(prisma, ctx, {
            title: 'first',
        });
        expect(task.key).toBe('TSK-1');
    });
});
