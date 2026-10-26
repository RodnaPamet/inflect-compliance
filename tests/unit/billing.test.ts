/**
 * Billing state transition and constraint tests.
 * Verifies BillingAccount model behavior, state transitions, and idempotency.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

// Prisma 7 — adapter is required to instantiate PrismaClient.
const prisma = new PrismaClient({
    adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL ?? '',
    }),
    transactionOptions: TENANT_TX_OPTIONS,
});

// ─── Track test tenants for cleanup ───
const testTenantIds: string[] = [];
let dbAvailable = false;

async function setupTestTenant() {
    const tenant = await prisma.tenant.create({
        data: {
            name: 'Billing Test Tenant',
            slug: `billing-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        },
    });
    testTenantIds.push(tenant.id);

    const billingAccount = await prisma.billingAccount.create({
        data: {
            tenantId: tenant.id,
            stripeCustomerId: `cus_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            plan: 'FREE',
            status: 'ACTIVE',
        },
    });

    return { tenant, billingAccount };
}

describe('Billing State Transitions', () => {
    beforeAll(async () => {
        try {
            // Prisma 7 — `$connect()` no longer fails fast when the DB
            // is unreachable (the adapter connects lazily on the first
            // query). Probe with a real query so the skip works as
            // intended in offline / no-DB environments.
            await prisma.$queryRawUnsafe('SELECT 1');
            dbAvailable = true;
        } catch {
            console.warn('[billing.test] Database not reachable — skipping integration tests');
        }
    });

    afterAll(async () => {
        if (!dbAvailable) return;
        // Cleanup in correct order (events → accounts → tenants)
        for (const tenantId of testTenantIds) {
            await prisma.billingEvent.deleteMany({ where: { tenantId } });
            await prisma.billingAccount.deleteMany({ where: { tenantId } });
            await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    test('subscription created → updates plan and status to PRO ACTIVE', async () => {
        if (!dbAvailable) return;
        const { tenant, billingAccount } = await setupTestTenant();

        // Simulate webhook processing: update billing account
        await prisma.billingAccount.update({
            where: { stripeCustomerId: billingAccount.stripeCustomerId },
            data: {
                stripeSubscriptionId: `sub_${Date.now()}`,
                plan: 'PRO',
                status: 'ACTIVE',
                currentPeriodEnd: new Date(Date.now() + 30 * 86400 * 1000),
            },
        });

        // Log event
        await prisma.billingEvent.create({
            data: {
                tenantId: tenant.id,
                type: 'customer.subscription.created',
                stripeEventId: `evt_created_${Date.now()}`,
                payloadJson: { status: 'active', plan: 'PRO' },
            },
        });

        const updated = await prisma.billingAccount.findUnique({
            where: { tenantId: tenant.id },
        });

        expect(updated?.plan).toBe('PRO');
        expect(updated?.status).toBe('ACTIVE');
        expect(updated?.stripeSubscriptionId).toBeTruthy();
        expect(updated?.currentPeriodEnd).toBeTruthy();
    });

    test('subscription updated → status changes to PAST_DUE', async () => {
        if (!dbAvailable) return;
        const { tenant, billingAccount } = await setupTestTenant();

        // First activate
        await prisma.billingAccount.update({
            where: { tenantId: tenant.id },
            data: { plan: 'PRO', status: 'ACTIVE', stripeSubscriptionId: `sub_${Date.now()}` },
        });

        // Then mark past_due
        await prisma.billingAccount.update({
            where: { stripeCustomerId: billingAccount.stripeCustomerId },
            data: { status: 'PAST_DUE' },
        });

        const updated = await prisma.billingAccount.findUnique({
            where: { tenantId: tenant.id },
        });

        expect(updated?.plan).toBe('PRO');
        expect(updated?.status).toBe('PAST_DUE');
    });

    test('subscription deleted → status CANCELED, subscription cleared', async () => {
        if (!dbAvailable) return;
        const { tenant, billingAccount } = await setupTestTenant();

        // First activate
        await prisma.billingAccount.update({
            where: { tenantId: tenant.id },
            data: { plan: 'PRO', status: 'ACTIVE', stripeSubscriptionId: `sub_${Date.now()}` },
        });

        // Cancel
        await prisma.billingAccount.update({
            where: { stripeCustomerId: billingAccount.stripeCustomerId },
            data: { status: 'CANCELED', stripeSubscriptionId: null },
        });

        const updated = await prisma.billingAccount.findUnique({
            where: { tenantId: tenant.id },
        });

        expect(updated?.status).toBe('CANCELED');
        expect(updated?.stripeSubscriptionId).toBeNull();
    });

    test('idempotency: duplicate stripeEventId is rejected', async () => {
        if (!dbAvailable) return;
        const { tenant } = await setupTestTenant();
        const eventId = `evt_idempotent_${Date.now()}`;

        await prisma.billingEvent.create({
            data: {
                tenantId: tenant.id,
                type: 'customer.subscription.created',
                stripeEventId: eventId,
                payloadJson: { test: true },
            },
        });

        await expect(
            prisma.billingEvent.create({
                data: {
                    tenantId: tenant.id,
                    type: 'customer.subscription.created',
                    stripeEventId: eventId,
                    payloadJson: { test: 'duplicate' },
                },
            })
        ).rejects.toThrow();
    });

    test('BillingAccount has unique tenantId constraint', async () => {
        if (!dbAvailable) return;
        const { tenant } = await setupTestTenant();

        await expect(
            prisma.billingAccount.create({
                data: {
                    tenantId: tenant.id,
                    stripeCustomerId: `cus_dup_${Date.now()}`,
                    plan: 'FREE',
                    status: 'ACTIVE',
                },
            })
        ).rejects.toThrow();
    });
});
