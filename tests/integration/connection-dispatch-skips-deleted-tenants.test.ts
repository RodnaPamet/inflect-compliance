/**
 * A deleted workspace's connections are not dispatched (#5017), against a real database.
 *
 * `tests/guards/connection-reads-skip-deleted-tenants.test.ts` holds the SHAPE
 * of every cross-tenant connection read. This holds the BEHAVIOUR on two of
 * them: two workspaces, each with an enabled Entra connection, one of them
 * soft-deleted. The nightly identity-sync dispatch must enqueue only the live
 * one, and the freshness gauge must report only the live one. Before #5017
 * both read `isEnabled` alone, so the deleted workspace's connection was
 * synced every night and, failing, reported stale every scrape.
 *
 * The database is shared with other suites, so every assertion is about this
 * file's own two connection ids, never about totals.
 */
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));

import type { PrismaClient } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { enqueue } from '@/app-layer/jobs/queue';
import { runIdentitySyncDispatch } from '@/app-layer/jobs/identity-sync';
import { getEnabledConnectionFreshness } from '@/lib/observability/connection-freshness';

const prisma: PrismaClient = prismaTestClient();

const LIVE = 'conn-dispatch-5017-live';
const DELETED = 'conn-dispatch-5017-deleted';
const TENANTS = [LIVE, DELETED];
const CONN: Record<string, string> = { [LIVE]: `${LIVE}-entra`, [DELETED]: `${DELETED}-entra` };

async function clear(): Promise<void> {
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

beforeAll(async () => {
    await clear();
    for (const id of TENANTS) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        await prisma.integrationConnection.create({
            data: { id: CONN[id], tenantId: id, provider: 'entra-id', name: `Entra ${id}`, isEnabled: true },
        });
    }
    await prisma.tenant.update({ where: { id: DELETED }, data: { deletedAt: new Date() } });
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

beforeEach(() => {
    (enqueue as jest.Mock).mockClear();
});

function enqueuedConnectionIds(): string[] {
    return (enqueue as jest.Mock).mock.calls
        .filter(([name]) => name === 'identity-sync')
        .map(([, payload]) => (payload as { connectionId: string }).connectionId);
}

describe('a deleted workspace\'s connections are skipped (#5017)', () => {
    it('the identity-sync dispatch enqueues the live workspace\'s connection and not the deleted one\'s', async () => {
        await runIdentitySyncDispatch();

        const ids = enqueuedConnectionIds();
        expect(ids).toContain(CONN[LIVE]);
        expect(ids).not.toContain(CONN[DELETED]);
    });

    it('the freshness gauge reports the live connection and not the deleted one', async () => {
        const ours = (await getEnabledConnectionFreshness())
            .filter((c) => TENANTS.includes(c.tenantId))
            .map((c) => c.connectionId);

        expect(ours).toEqual([CONN[LIVE]]);
    });

    it('the deleted workspace\'s connection is still enabled, so the filter is what skipped it', async () => {
        // Without this, the two tests above would also pass if something had
        // disabled the connection, and would prove nothing about the filter.
        const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: CONN[DELETED] } });
        expect(row.isEnabled).toBe(true);
    });
});
