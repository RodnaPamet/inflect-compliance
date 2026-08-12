/**
 * The calendar shows nothing from another tenant.
 *
 * The unit suite asserts every loader's `where` carries `tenantId`, which is a
 * claim about the QUERY. It cannot be a claim about isolation, because the
 * mocked client returns whatever the fixture says regardless of the predicate —
 * a loader that dropped its tenant filter entirely would still "pass" there if
 * the mock returned only same-tenant rows.
 *
 * This runs the real usecase against a real database with two tenants holding
 * deliberately similar data, and asserts tenant B's rows never appear in tenant
 * A's calendar.
 *
 * WHAT IT PROVES, precisely: that the two layers TOGETHER isolate — which is
 * the user-facing guarantee. It cannot attribute isolation to either one.
 *
 * That is not a hypothetical limitation. Deleting `tenantId: ctx.tenantId` from
 * the policy loader and re-running this suite leaves it GREEN, because
 * `runInTenantReadContext` binds the `app_user` role and the RLS policy filters
 * the rows the application layer stopped filtering. Defence in depth is doing
 * real work here rather than sitting behind a passing test — but it also means
 * a reviewer must not read a green run as "every loader still carries its
 * tenant predicate". The unit suite's `where`-shape sweep is what asserts that,
 * across all nineteen sources.
 *
 * A representative spread of sources rather than all nineteen — seeding every
 * entity graph would be a fixture larger than the thing under test, and these
 * four cover the distinct shapes: a plain tenant-scoped model, one reached
 * through a soft-deletable parent, one with two date columns unioned by
 * `fetchNearest`, and one whose owner is inherited.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { getComplianceCalendarEvents } from '@/app-layer/usecases/compliance-calendar';
import { makeRequestContext } from '../helpers/make-context';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SUITE = `cti-${randomUUID().slice(0, 8)}`;
const TENANT_A = `t-${SUITE}-a`;
const TENANT_B = `t-${SUITE}-b`;

const NOW = new Date('2026-06-01T00:00:00Z');
const IN_RANGE = new Date('2026-06-15T00:00:00Z');
const FROM = new Date('2026-05-01T00:00:00Z');
const TO = new Date('2026-08-01T00:00:00Z');

let userA: string;

async function seedTenant(tenantId: string, tag: string): Promise<string> {
    await globalPrisma.tenant.upsert({
        where: { id: tenantId },
        update: {},
        create: { id: tenantId, name: `t ${tag}`, slug: tag },
    });
    const email = `${tag}@example.test`;
    const user = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });

    // 1. Plain tenant-scoped model.
    await globalPrisma.policy.create({
        data: {
            tenantId,
            slug: `${tag}-policy`,
            title: `${tag} policy`,
            status: 'PUBLISHED',
            nextReviewAt: IN_RANGE,
            ownerUserId: user.id,
        },
    });

    // 2. Two date columns unioned by `fetchNearest`.
    await globalPrisma.risk.create({
        data: {
            tenantId,
            title: `${tag} risk`,
            status: 'OPEN',
            nextReviewAt: IN_RANGE,
            targetDate: IN_RANGE,
            ownerUserId: user.id,
        },
    });

    // 3. Reached through a soft-deletable parent, owner inherited from it.
    const vendor = await globalPrisma.vendor.create({
        data: { tenantId, name: `${tag} vendor`, ownerUserId: user.id },
    });
    await globalPrisma.vendorDocument.create({
        data: {
            tenantId,
            vendorId: vendor.id,
            type: 'SOC2',
            validTo: IN_RANGE,
            uploadedByUserId: user.id,
        },
    });

    // 4. The badge's model, and the one with the most write paths.
    await globalPrisma.task.create({
        data: {
            tenantId,
            title: `${tag} task`,
            createdByUserId: user.id,
            status: 'OPEN',
            dueAt: IN_RANGE,
            assigneeUserId: user.id,
        },
    });

    return user.id;
}

async function teardown() {
    const ids = [TENANT_A, TENANT_B];
    for (const model of [
        'vendorDocument', 'vendor', 'task', 'risk', 'policy',
    ] as const) {
        // @ts-expect-error — indexed model access is the point of the loop
        await globalPrisma[model].deleteMany({ where: { tenantId: { in: ids } } });
    }
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ids,
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, ids,
        );
    });
    await globalPrisma.user.deleteMany({
        where: { email: { in: [`${SUITE}-a@example.test`, `${SUITE}-b@example.test`] } },
    });
    await globalPrisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

describeFn('calendar — cross-tenant isolation', () => {
    beforeAll(async () => {
        userA = await seedTenant(TENANT_A, `${SUITE}-a`);
        await seedTenant(TENANT_B, `${SUITE}-b`);
    }, 60_000);
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    it('shows tenant A its own deadlines', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, userId: userA });
        const res = await getComplianceCalendarEvents(ctx as never, {
            from: FROM, to: TO, now: NOW,
        });
        // The positive half: without it, an empty result would satisfy the
        // isolation assertion below while proving nothing.
        expect(res.events.length).toBeGreaterThan(0);
        expect(res.events.some((e) => e.entityName?.includes(`${SUITE}-a`))).toBe(true);
    });

    it('never leaks tenant B rows into tenant A’s calendar', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, userId: userA });
        const res = await getComplianceCalendarEvents(ctx as never, {
            from: FROM, to: TO, now: NOW,
        });
        const foreign = res.events.filter(
            (e) =>
                e.entityName?.includes(`${SUITE}-b`) ||
                e.title?.includes(`${SUITE}-b`),
        );
        expect(foreign).toEqual([]);
    });

    it('reports no failed sources — isolation must not come from errors', async () => {
        // A loader that threw would produce an empty, "isolated"-looking
        // result for the wrong reason. This is what distinguishes working
        // isolation from a broken query.
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_A, userId: userA });
        const res = await getComplianceCalendarEvents(ctx as never, {
            from: FROM, to: TO, now: NOW,
        });
        expect(res.failedSources).toEqual([]);
    });
});
