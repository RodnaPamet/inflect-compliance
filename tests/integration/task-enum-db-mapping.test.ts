/**
 * B3-6 — the Task subsystem's five enums are named `Task*` in Prisma but
 * are pinned to their original `WorkItem*` physical Postgres type names
 * via `@@map`. That pin is load-bearing, not cosmetic:
 *
 *   • Dropping it makes `prisma migrate dev` emit
 *     `ALTER TYPE "WorkItemStatus" RENAME TO "TaskStatus"` ×5. The rename
 *     itself is metadata-only, but Prisma emits explicit enum casts
 *     (`$1::"WorkItemStatus"`) in generated SQL — so during a rolling
 *     deploy the still-running old image would query a type that no
 *     longer exists and every task read/write would fail with 42704.
 *
 * These assertions hit a real DB and fail if either half of the pin
 * breaks: the physical type is renamed, or the Prisma-side enum stops
 * resolving to it.
 */
import { PrismaClient, TaskStatus, TaskType, TaskSeverity, TaskPriority, TaskSource } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

/** column on "Task" → the physical Postgres enum type it must still use. */
const PINNED: ReadonlyArray<readonly [string, string]> = [
    ['status', 'WorkItemStatus'],
    ['type', 'WorkItemType'],
    ['severity', 'WorkItemSeverity'],
    ['priority', 'WorkItemPriority'],
    ['source', 'WorkItemSource'],
];

describeFn('Task enums keep their WorkItem* physical Postgres types', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    it.each(PINNED)('Task.%s is backed by the "%s" pg type', async (column, pgType) => {
        const rows = await prisma.$queryRaw<Array<{ typname: string }>>`
            SELECT t.typname
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_type t ON t.oid = a.atttypid
            WHERE c.relname = 'Task'
              AND n.nspname = 'public'
              AND a.attname = ${column}
              AND a.attnum > 0
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].typname).toBe(pgType);
    });

    it('the renamed Prisma enums still bind at query time', async () => {
        // Each predicate makes Prisma emit a real cast to the physical
        // type. A broken @@map surfaces here as 42704 (undefined_object),
        // not as a silent empty result.
        await expect(
            prisma.task.findMany({
                where: {
                    status: TaskStatus.IN_REVIEW,
                    type: TaskType.AUDIT_FINDING,
                    severity: TaskSeverity.CRITICAL,
                    priority: TaskPriority.P0,
                    source: TaskSource.RISK_MONITOR,
                },
                take: 1,
            }),
        ).resolves.toEqual([]);
    });
});
