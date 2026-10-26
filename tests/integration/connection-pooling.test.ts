/**
 * Connection Pooling Integration Test
 *
 * Validates that the database connection can handle high concurrency
 * by running 60+ parallel queries simultaneously. When PgBouncer is
 * configured correctly, this should complete without connection exhaustion.
 *
 * This test uses the actual Prisma client and DATABASE_URL.
 * In CI, DATABASE_URL should point to PgBouncer.
 *
 * ⚠️  Requires a live database. Automatically skipped if the DB is unreachable.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const CONCURRENCY_LEVEL = 60;

describe('Connection pooling: concurrent query handling', () => {
    let prisma: PrismaClient;
    let dbAvailable = false;

    beforeAll(async () => {
        prisma = new PrismaClient({
            adapter: new PrismaPg({
                connectionString: process.env.DATABASE_URL!,
            }),
            transactionOptions: TENANT_TX_OPTIONS,
        });

        // Probe DB connectivity — skip all tests if unreachable
        try {
            await prisma.$queryRawUnsafe('SELECT 1');
            dbAvailable = true;
        } catch {
            console.warn(
                '[connection-pooling] Database not reachable — skipping integration tests.\n' +
                '  To run: docker compose up -d && set DATABASE_URL appropriately.'
            );
        }
    }, 15000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    test(`handles ${CONCURRENCY_LEVEL} concurrent queries without connection exhaustion`, async () => {
        if (!dbAvailable) {
            console.log('[skipped] DB not available');
            return;
        }

        const queries = Array.from({ length: CONCURRENCY_LEVEL }, (_, i) =>
            prisma.$queryRawUnsafe<[{ result: number }]>(`SELECT ${i + 1} as result`)
                .then((rows) => ({
                    index: i,
                    result: Number(rows[0]?.result),
                    ok: true,
                }))
                .catch((err) => ({
                    index: i,
                    result: -1,
                    ok: false,
                    error: (err as Error).message,
                })),
        );

        const results = await Promise.all(queries);

        const successes = results.filter((r) => r.ok);
        const failures = results.filter((r) => !r.ok);

        if (failures.length > 0) {
            console.error(
                `${failures.length} queries failed:`,
                failures.slice(0, 5).map((f) => (f as { error: string }).error),
            );
        }

        expect(successes.length).toBe(CONCURRENCY_LEVEL);
        expect(failures.length).toBe(0);

        for (const result of successes) {
            expect(result.result).toBe(result.index + 1);
        }
    }, 30000);

    test('sequential queries work after concurrent burst', async () => {
        if (!dbAvailable) {
            console.log('[skipped] DB not available');
            return;
        }

        const result = await prisma.$queryRawUnsafe<[{ one: number }]>('SELECT 1 as one');
        expect(Number(result[0]?.one)).toBe(1);
    });
});
