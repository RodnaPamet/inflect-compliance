/**
 * `DataSubjectRequest` RLS behavioural tests.
 *
 * The static guardrail (`tests/guardrails/rls-coverage.test.ts`) confirms the
 * policies and the FORCE flag exist, now that the model is listed in
 * `OWNERSHIP_CHAINED_MODELS`. These tests exercise the actual SEMANTICS against
 * a live Postgres, because the policy's correctness turns on one subtle detail
 * that a structural check cannot see.
 *
 * ## Why the cross-tenant assertion is the load-bearing one
 *
 * The policy joins through `TenantMembership`, which has its own `userId`
 * column. Writing the subquery's join condition unqualified —
 * `m."userId" = "userId"` instead of `m."userId" = "DataSubjectRequest"."userId"`
 * — resolves the bare name to the INNER relation, making the condition
 * `m."userId" = m."userId"`: true for every membership row.
 *
 * That broken policy is NOT obviously broken. `EXISTS` then succeeds for any
 * tenant holding at least one ACTIVE membership and fails for a tenant holding
 * none — so **"an unknown tenant sees nothing" still passes** while every
 * tenant reads every subject's request. Measured, not assumed: with the
 * unqualified form, tenant A and tenant B each saw BOTH requests.
 *
 * So a test that only asserts fail-closed behaviour would certify a
 * cross-tenant leak. The assertion that discriminates is the positive one —
 * tenant A sees its own row AND NOT tenant B's.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUFFIX = randomUUID().slice(0, 8);
const TENANT_A = `t-dsar-a-${SUFFIX}`;
const TENANT_B = `t-dsar-b-${SUFFIX}`;
const USER_A = `u-dsar-a-${SUFFIX}`;
const USER_B = `u-dsar-b-${SUFFIX}`;
const DSAR_A = `d-dsar-a-${SUFFIX}`;
const DSAR_B = `d-dsar-b-${SUFFIX}`;

async function mkUser(id: string) {
    const email = `${id}@example.test`;
    await globalPrisma.user.create({
        data: { id, email, emailHash: hashForLookup(email) },
    });
}

async function mkTenant(id: string) {
    await globalPrisma.tenant.create({
        data: { id, name: id, slug: id },
    });
}

/** ADMIN, never OWNER — an OWNER row would arm the last-OWNER guard on cleanup. */
async function mkMembership(tenantId: string, userId: string, status: 'ACTIVE' | 'DEACTIVATED' = 'ACTIVE') {
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: 'ADMIN', status },
    });
}

async function mkDsar(id: string, userId: string) {
    await globalPrisma.dataSubjectRequest.create({
        data: { id, userId, type: 'EXPORT', status: 'RECEIVED' },
    });
}

/** Read every DSAR visible to `tenantId` under the app_user role. */
async function visibleTo(tenantId: string): Promise<string[]> {
    return withTenantDb(tenantId, async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "DataSubjectRequest" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
            [DSAR_A, DSAR_B],
        );
        return rows.map((r) => r.id);
    });
}

describeFn('DataSubjectRequest RLS', () => {
    beforeAll(async () => {
        await mkUser(USER_A);
        await mkUser(USER_B);
        await mkTenant(TENANT_A);
        await mkTenant(TENANT_B);
        await mkMembership(TENANT_A, USER_A);
        await mkMembership(TENANT_B, USER_B);
        await mkDsar(DSAR_A, USER_A);
        await mkDsar(DSAR_B, USER_B);
    });

    afterAll(async () => {
        await globalPrisma.dataSubjectRequest.deleteMany({ where: { id: { in: [DSAR_A, DSAR_B] } } });
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await globalPrisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
        await globalPrisma.$disconnect();
    });

    it('a tenant sees its own subject request AND NOT the other tenant\'s', async () => {
        // THE discriminating assertion. Both halves matter: the positive half
        // proves the policy is not simply denying everything, and the negative
        // half is the one the unqualified-join bug breaks.
        await expect(visibleTo(TENANT_A)).resolves.toEqual([DSAR_A]);
        await expect(visibleTo(TENANT_B)).resolves.toEqual([DSAR_B]);
    });

    it('a tenant with no membership for either subject sees nothing', async () => {
        const empty = `t-dsar-empty-${SUFFIX}`;
        await mkTenant(empty);
        try {
            await expect(visibleTo(empty)).resolves.toEqual([]);
        } finally {
            await globalPrisma.tenant.deleteMany({ where: { id: empty } });
        }
    });

    it('a DEACTIVATED membership stops the request surfacing', async () => {
        // Mirrors the application predicate, which requires status ACTIVE.
        await globalPrisma.tenantMembership.updateMany({
            where: { tenantId: TENANT_A, userId: USER_A },
            data: { status: 'DEACTIVATED' },
        });
        try {
            await expect(visibleTo(TENANT_A)).resolves.toEqual([]);
        } finally {
            await globalPrisma.tenantMembership.updateMany({
                where: { tenantId: TENANT_A, userId: USER_A },
                data: { status: 'ACTIVE' },
            });
        }
        // Positive companion: restoring ACTIVE brings it back, so the empty
        // result above was the policy acting and not the row vanishing.
        await expect(visibleTo(TENANT_A)).resolves.toEqual([DSAR_A]);
    });

    it('a subject in BOTH tenants is visible to both', async () => {
        // Correct by design: their request is legitimately each tenant's
        // business, and this matches `scopedToTenantMembers()` exactly.
        await mkMembership(TENANT_B, USER_A);
        try {
            await expect(visibleTo(TENANT_B)).resolves.toEqual([DSAR_A, DSAR_B]);
        } finally {
            await globalPrisma.tenantMembership.deleteMany({
                where: { tenantId: TENANT_B, userId: USER_A },
            });
        }
    });

    it('INSERT under app_user is refused for a non-member subject (WITH CHECK)', async () => {
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "DataSubjectRequest"("id","userId","type","status","updatedAt")
                     VALUES ($1, $2, 'EXPORT', 'RECEIVED', now())`,
                    `d-illegal-${SUFFIX}`,
                    USER_B,
                );
            }),
        ).rejects.toThrow();
        // Positive companion: the same INSERT for its OWN subject succeeds,
        // so the rejection above is the policy and not a broken statement.
        const ok = `d-legal-${SUFFIX}`;
        await withTenantDb(TENANT_A, async (tx) => {
            await tx.$executeRawUnsafe(
                `INSERT INTO "DataSubjectRequest"("id","userId","type","status","updatedAt")
                 VALUES ($1, $2, 'EXPORT', 'RECEIVED', now())`,
                ok,
                USER_A,
            );
        });
        await globalPrisma.dataSubjectRequest.deleteMany({ where: { id: ok } });
    });

    it('the superuser client reads across tenants (migrations, admin paths)', async () => {
        const rows = await globalPrisma.dataSubjectRequest.findMany({
            where: { id: { in: [DSAR_A, DSAR_B] } },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        expect(rows.map((r) => r.id)).toEqual([DSAR_A, DSAR_B]);
    });
});
