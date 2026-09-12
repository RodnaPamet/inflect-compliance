/**
 * Integration tests for the platform-admin `verifyPlatformApiKey` helper
 * and the key behaviours expected at the route layer.
 *
 * These tests exercise the auth helper directly (no HTTP server needed).
 * The happy-path tenant-creation behaviour is covered by
 * `tenant-lifecycle.test.ts`.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

const VALID_KEY = 'test-key-that-is-at-least-32-chars-long-xx';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('platform-admin tenant creation', () => {
    let prisma: PrismaClient;
    const tenantSlugs: string[] = [];
    const userEmails: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        try {
            const tenants = await prisma.tenant.findMany({
                where: { slug: { in: tenantSlugs } },
                select: { id: true },
            });
            const ids = tenants.map((t) => t.id);
            if (ids.length > 0) {
                await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
            }
        } catch { /* best effort */ }
        try {
            await prisma.tenant.deleteMany({ where: { slug: { in: tenantSlugs } } });
        } catch { /* best effort */ }
        try {
            await prisma.user.deleteMany({ where: { email: { in: userEmails } } });
        } catch { /* best effort */ }
        await prisma.$disconnect();
    });

    // ── verifyPlatformApiKey unit-style assertions ─────────────────────

    describe('verifyPlatformApiKey', () => {
        // We import the module inside each test so env mutations are
        // visible (SKIP_ENV_VALIDATION=1 is already set by jest.setup.js).

        function makeRequest(key: string | null): { headers: { get: (h: string) => string | null } } {
            return {
                headers: {
                    get: (h: string) => h === 'x-platform-admin-key' ? key : null,
                },
            };
        }

        it('returns void (no throw) for a correct key', async () => {
            process.env.PLATFORM_ADMIN_API_KEY = VALID_KEY;
            // Re-require so env snapshot is fresh.
            jest.resetModules();
            const { verifyPlatformApiKey } = await import('@/lib/auth/platform-admin');
            const { env } = await import('@/env');
            void env; // ensure loaded

            expect(() =>
                verifyPlatformApiKey(makeRequest(VALID_KEY) as never),
            ).not.toThrow();

            delete process.env.PLATFORM_ADMIN_API_KEY;
        });

        it('throws PlatformAdminError(401) for a wrong key', async () => {
            process.env.PLATFORM_ADMIN_API_KEY = VALID_KEY;
            jest.resetModules();
            const { verifyPlatformApiKey, PlatformAdminError } = await import(
                '@/lib/auth/platform-admin'
            );

            let threw: unknown;
            try {
                verifyPlatformApiKey(makeRequest('wrong-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx') as never);
            } catch (e) {
                threw = e;
            }
            expect(threw).toBeInstanceOf(PlatformAdminError);
            expect((threw as InstanceType<typeof PlatformAdminError>).status).toBe(401);

            delete process.env.PLATFORM_ADMIN_API_KEY;
        });

        it('throws PlatformAdminError(401) for a missing header', async () => {
            process.env.PLATFORM_ADMIN_API_KEY = VALID_KEY;
            jest.resetModules();
            const { verifyPlatformApiKey, PlatformAdminError } = await import(
                '@/lib/auth/platform-admin'
            );

            let threw: unknown;
            try {
                verifyPlatformApiKey(makeRequest(null) as never);
            } catch (e) {
                threw = e;
            }
            expect(threw).toBeInstanceOf(PlatformAdminError);
            expect((threw as InstanceType<typeof PlatformAdminError>).status).toBe(401);

            delete process.env.PLATFORM_ADMIN_API_KEY;
        });

        it('throws PlatformAdminError(503) when env var is unset', async () => {
            delete process.env.PLATFORM_ADMIN_API_KEY;
            jest.resetModules();
            const { verifyPlatformApiKey, PlatformAdminError } = await import(
                '@/lib/auth/platform-admin'
            );

            let threw: unknown;
            try {
                verifyPlatformApiKey(makeRequest(VALID_KEY) as never);
            } catch (e) {
                threw = e;
            }
            expect(threw).toBeInstanceOf(PlatformAdminError);
            expect((threw as InstanceType<typeof PlatformAdminError>).status).toBe(503);
        });
    });

    // ── createTenantWithOwner via the usecase ──────────────────────────

    it('valid call → tenant + OWNER membership created', async () => {
        process.env.PLATFORM_ADMIN_API_KEY = VALID_KEY;

        jest.resetModules();
        const { createTenantWithOwner } = await import(
            '@/app-layer/usecases/tenant-lifecycle'
        );

        const slug = `padmin-${Date.now()}`;
        tenantSlugs.push(slug);
        const email = `padmin-owner-${Date.now()}@example.com`;
        userEmails.push(email);

        const result = await createTenantWithOwner({
            name: 'Platform admin test tenant',
            slug,
            ownerEmail: email,
            requestId: 'padmin-test',
        });

        expect(result.tenant.slug).toBe(slug);
        expect(typeof result.ownerUserId).toBe('string');

        const membership = await prisma.tenantMembership.findFirst({
            where: { tenantId: result.tenant.id, userId: result.ownerUserId },
            select: { role: true, status: true },
        });
        expect(membership?.role).toBe('OWNER');
        expect(membership?.status).toBe('ACTIVE');

        delete process.env.PLATFORM_ADMIN_API_KEY;
    });
});
