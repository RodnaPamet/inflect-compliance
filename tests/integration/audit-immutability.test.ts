/**
 * AuditLog Immutability — Integration Tests
 *
 * Proves the DB-level enforcement of append-only semantics:
 *   ✅ INSERT succeeds
 *   ❌ UPDATE is blocked by trigger
 *   ❌ DELETE is blocked by trigger
 *   ✅ Error messages are clear and debuggable
 *
 * These tests run against the real PostgreSQL test database.
 * They are automatically skipped if no DB is available.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { PrismaClient } from '@prisma/client';
import { hashForLookup } from '@/lib/security/encryption';
import { attemptAuditDelete, attemptAuditUpdate, deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('AuditLog Immutability (DB Trigger)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let userId: string;
    const testId = `immutable-test-${Date.now()}`;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        // Ensure the immutability trigger is ENABLED (guard against parallel test suites
        // like audit-hash-chain that temporarily disable it for cleanup)
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_immutable`
            );
        } catch { /* trigger may not exist yet — tests will skip gracefully */ }

        // Ensure we have a tenant and user for FK constraints
        const tenant = await prisma.tenant.upsert({
            where: { slug: 'audit-immutable-test' },
            update: {},
            create: {
                name: 'Audit Immutable Test',
                slug: 'audit-immutable-test',
            },
        });
        tenantId = tenant.id;

        const user = await prisma.user.upsert({
            where: { emailHash: hashForLookup('audit-immutable-test@test.com') },
            update: {},
            create: {
                email: 'audit-immutable-test@test.com',
                name: 'Audit Test User',
            },
        });
        userId = user.id;

        // Insert a test row to use in UPDATE/DELETE tests
        await prisma.$executeRawUnsafe(
            `INSERT INTO "AuditLog" ("id", "tenantId", "userId", "entity", "entityId", "action", "details", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            testId,
            tenantId,
            userId,
            'TestEntity',
            'test-entity-1',
            'TEST_INSERT',
            'Test audit entry for immutability verification',
        );
    });

    afterAll(async () => {
        // Use tenant-scoped DELETE (not TRUNCATE) to avoid nuking entries from
        // parallel test suites (e.g. audit-hash-chain). Set session_replication_role
        // to 'replica' to bypass the immutability trigger for cleanup.
        try {
            await deleteAuditRowsForTenants(prisma, tenantId);
        } catch {
            // Ignore — globalSetup handles reset
        }
        await prisma.$disconnect();
    });

    // ── INSERT works ─────────────────────────────────────────────

    test('INSERT succeeds — audit records can be appended', async () => {
        const newId = `immutable-insert-${Date.now()}`;
        const result = await prisma.$executeRawUnsafe(
            `INSERT INTO "AuditLog" ("id", "tenantId", "userId", "entity", "entityId", "action", "details", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            newId,
            tenantId,
            userId,
            'TestEntity',
            'test-entity-2',
            'TEST_INSERT_2',
            'Another test audit entry',
        );

        expect(result).toBe(1); // 1 row inserted

        // Verify it exists
        const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT "id" FROM "AuditLog" WHERE "id" = $1`,
            newId,
        );
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(newId);
    });

    // ── UPDATE blocked ───────────────────────────────────────────

    test('UPDATE is blocked — trigger raises IMMUTABLE_AUDIT_LOG exception', async () => {
        await expect(
            attemptAuditUpdate(prisma, 'AuditLog', `"details" = 'tampered'`, '"id" = $1', testId),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_LOG/);
    });

    test('UPDATE error message mentions operation type and append-only', async () => {
        let errorMessage = '';
        try {
            await attemptAuditUpdate(prisma, 'AuditLog', `"action" = 'TAMPERED'`, '"id" = $1', testId);
            // Should not reach here
            expect(true).toBe(false);
        } catch (err: unknown) {
            errorMessage = err instanceof Error ? err.message : String(err);
        }
        expect(errorMessage).toContain('IMMUTABLE_AUDIT_LOG');
        expect(errorMessage).toContain('UPDATE');
        expect(errorMessage).toContain('append-only');
    });

    // ── DELETE blocked ───────────────────────────────────────────

    test('DELETE is blocked — trigger raises IMMUTABLE_AUDIT_LOG exception', async () => {
        await expect(
            attemptAuditDelete(prisma, 'AuditLog', '"id" = $1', testId),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_LOG/);
    });

    test('DELETE error message mentions operation type and append-only', async () => {
        let errorMessage = '';
        try {
            await attemptAuditDelete(prisma, 'AuditLog', '"id" = $1', testId);
            expect(true).toBe(false);
        } catch (err: unknown) {
            errorMessage = err instanceof Error ? err.message : String(err);
        }
        expect(errorMessage).toContain('IMMUTABLE_AUDIT_LOG');
        expect(errorMessage).toContain('DELETE');
        expect(errorMessage).toContain('append-only');
    });

    // ── Row integrity preserved ──────────────────────────────────

    test('original row is unchanged after failed UPDATE/DELETE attempts', async () => {
        const rows = await prisma.$queryRawUnsafe<{ id: string; details: string | null; action: string }[]>(
            `SELECT "id", "details", "action" FROM "AuditLog" WHERE "id" = $1`,
            testId,
        );

        expect(rows.length).toBe(1);
        expect(rows[0].details).toBe('Test audit entry for immutability verification');
        expect(rows[0].action).toBe('TEST_INSERT');
    });

    // ── Bulk operations also blocked ─────────────────────────────

    test('bulk UPDATE is blocked', async () => {
        await expect(
            attemptAuditUpdate(prisma, 'AuditLog', `"details" = 'mass tamper'`, '"tenantId" = $1', tenantId),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_LOG/);
    });

    test('bulk DELETE is blocked', async () => {
        await expect(
            attemptAuditDelete(prisma, 'AuditLog', '"tenantId" = $1', tenantId),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_LOG/);
    });
});
