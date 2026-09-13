/**
 * Branch coverage for the per-tenant DEK rotation sweep
 * (`src/app-layer/jobs/tenant-dek-rotation.ts` — runTenantDekRotation).
 *
 * DB-backed: the executor drives `@/lib/prisma` directly. We seed real
 * Tenant + Risk rows (Risk.threat is in the encrypted-fields manifest
 * and Risk carries a tenantId column, so the sweep walks it).
 *
 * Cross-link / NON-duplication: the full happy-path lifecycle
 * (pre-rotation ciphertext stays readable via the dual-DEK fallback,
 * post-sweep all v2 under the new DEK, the starting→sweeping→
 * finalising→complete progress sequence) is already covered by
 * `tests/integration/tenant-dek-rotation.test.ts`. This file
 * deliberately focuses on the executor BRANCHES that test doesn't:
 *   - noop branch: previousEncryptedDek already null → phase 'noop',
 *     previousEncryptedDekCleared=false, zero counters.
 *   - tenant-not-found → throws.
 *   - no `onProgress` callback supplied (the `if (!onProgress) return`
 *     short-circuit) — the sweep still runs to completion.
 *   - idempotency / skip: re-running after rows are already under the
 *     new DEK counts them as skipped (decrypt-under-previous fails),
 *     not errors, and still clears previousEncryptedDek.
 *   - batchSize clamp (Math.max(1, ...)) via batchSize: 0.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { generateDek, wrapDek } from '@/lib/security/tenant-keys';
import { encryptWithKey } from '@/lib/security/encryption';
import { hashForLookup } from '@/lib/security/encryption';
import {
    runTenantDekRotation,
    _resetTenantDekRotationForTests,
} from '@/app-layer/jobs/tenant-dek-rotation';
import { _resetTenantDekCache } from '@/lib/security/tenant-key-manager';
import { deleteAuditRowsForTenants } from '../../helpers/audit-cleanup';

// Mock the BullMQ queue boundary so no Redis is required (matches the
// integration test's mock). The job itself doesn't enqueue, but
// tenant-key-manager (imported transitively) does.
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'unit-test-job' }),
}));

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `dek-${randomUUID().slice(0, 8)}`;

describeFn('runTenantDekRotation — executor branches (real DB)', () => {
    let prisma: PrismaClient;
    let actorUserId = '';

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const email = `${SUITE}@example.test`;
        const u = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        actorUserId = u.id;
    });

    afterAll(async () => {
        await prisma.user.deleteMany({ where: { id: actorUserId } });
        await prisma.$disconnect();
    });

    beforeEach(() => {
        _resetTenantDekRotationForTests();
        _resetTenantDekCache();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
        await deleteAuditRowsForTenants(prisma, tenantId);
        await prisma.risk.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }

    it('noop branch: previousEncryptedDek already null → phase noop, nothing cleared', async () => {
        const slug = `${SUITE}-noop-${randomUUID().slice(0, 6)}`;
        const tenant = await prisma.tenant.create({
            data: { name: slug, slug, encryptedDek: wrapDek(generateDek()) },
            // previousEncryptedDek left null
        });
        try {
            const progress: string[] = [];
            const res = await runTenantDekRotation({
                tenantId: tenant.id,
                initiatedByUserId: actorUserId,
                onProgress: async (p) => { progress.push(p.phase); },
            });
            expect(res.previousEncryptedDekCleared).toBe(false);
            expect(res.totalScanned).toBe(0);
            expect(res.totalRewritten).toBe(0);
            expect(res.totalErrors).toBe(0);
            expect(res.perField).toEqual([]);
            // starting → noop
            expect(progress).toContain('starting');
            expect(progress).toContain('noop');
        } finally {
            await cleanupTenant(tenant.id);
        }
    });

    it('rejects for a non-existent tenant (the START audit FK fires before the in-code not-found guard)', async () => {
        // The executor's `throw new Error('tenant not found')` guard is
        // effectively unreachable on a real Postgres: the
        // TENANT_DEK_ROTATION_STARTED audit insert at the top of the job
        // references AuditLog.tenantId, which FKs to Tenant ON DELETE
        // RESTRICT — so a missing tenant rejects at the audit write
        // first. Either way the job throws; we just assert it does not
        // silently succeed.
        await expect(
            runTenantDekRotation({
                tenantId: `missing-${randomUUID()}`,
                initiatedByUserId: actorUserId,
            }),
        ).rejects.toThrow();
    });

    it('runs to completion with no onProgress callback and clears the previous DEK', async () => {
        const slug = `${SUITE}-noprog-${randomUUID().slice(0, 6)}`;
        // Seed a tenant mid-rotation: previousEncryptedDek populated with a
        // DIFFERENT wrapped DEK than encryptedDek (CHECK constraint requires
        // they differ). Seed one Risk row encrypted under the previous DEK so
        // the sweep rewrites it.
        const previousDek = generateDek();
        const newDek = generateDek();
        const tenant = await prisma.tenant.create({
            data: {
                name: slug,
                slug,
                encryptedDek: wrapDek(newDek),
                previousEncryptedDek: wrapDek(previousDek),
            },
        });
        try {
            await prisma.risk.create({
                data: {
                    tenantId: tenant.id,
                    title: 'seed',
                    threat: encryptWithKey(previousDek, 'secret threat'),
                },
            });

            // No onProgress → the reportProgress `if (!onProgress) return`
            // short-circuit is exercised on every call site.
            const res = await runTenantDekRotation({
                tenantId: tenant.id,
                initiatedByUserId: actorUserId,
            });
            expect(res.totalErrors).toBe(0);
            expect(res.previousEncryptedDekCleared).toBe(true);
            expect(res.totalRewritten).toBeGreaterThanOrEqual(1);

            const after = await prisma.tenant.findUnique({
                where: { id: tenant.id },
                select: { previousEncryptedDek: true },
            });
            expect(after?.previousEncryptedDek).toBeNull();
        } finally {
            await cleanupTenant(tenant.id);
        }
    });

    it('idempotency: rows already under the new DEK are SKIPPED, not errors (batchSize clamp via 0)', async () => {
        const slug = `${SUITE}-idem-${randomUUID().slice(0, 6)}`;
        const previousDek = generateDek();
        const newDek = generateDek();
        const tenant = await prisma.tenant.create({
            data: {
                name: slug,
                slug,
                encryptedDek: wrapDek(newDek),
                previousEncryptedDek: wrapDek(previousDek),
            },
        });
        try {
            // One row under the PREVIOUS DEK (will be rewritten) and one
            // ALREADY under the NEW DEK (decrypt-under-previous fails →
            // counted as skipped, never an error).
            await prisma.risk.create({
                data: { tenantId: tenant.id, title: 'old', threat: encryptWithKey(previousDek, 'old plaintext') },
            });
            await prisma.risk.create({
                data: { tenantId: tenant.id, title: 'already-new', threat: encryptWithKey(newDek, 'new plaintext') },
            });

            // batchSize: 0 → clamped to Math.max(1, 0) = 1, exercising the
            // clamp branch + per-batch cursor pagination.
            const res = await runTenantDekRotation({
                tenantId: tenant.id,
                initiatedByUserId: actorUserId,
                batchSize: 0,
            });
            expect(res.totalErrors).toBe(0);
            expect(res.totalRewritten).toBeGreaterThanOrEqual(1);
            expect(res.totalSkipped).toBeGreaterThanOrEqual(1);
            expect(res.previousEncryptedDekCleared).toBe(true);
        } finally {
            await cleanupTenant(tenant.id);
        }
    });
});
