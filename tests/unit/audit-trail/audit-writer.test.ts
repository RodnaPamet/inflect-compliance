/**
 * Branch coverage for the hash-chained audit-log writer
 * (`src/lib/audit/audit-writer.ts`).
 *
 * DB-backed (real Postgres via prismaTestClient) — the per-tenant
 * advisory lock, the hash-chain SELECT-latest logic, and the
 * AuditLog immutability trigger only exist on a real DB, so this
 * runs under the node project's globalSetup-provisioned test DB.
 *
 * Branches exercised:
 *   - appendAuditEntry genesis case: first entry's previousHash = null.
 *   - chain link: 2nd entry's previousHash = 1st entry's entryHash.
 *   - detailsJson provided directly  vs  legacy `details` text wrapped
 *     into a `{ category: 'custom', legacyText }` payload (the `??`
 *     branch on detailsForHash).
 *   - actorType / version defaulting (`|| 'USER'`, `?? 1`).
 *   - optional metadata spreads (requestId / recordIds / metadataJson /
 *     diffJson present vs null).
 *   - verifyAuditChain: valid chain (multi-entry), empty chain,
 *     tamper detection (entryHash mutated → valid=false + firstBreak*).
 *   - immutability guard: UPDATE / DELETE on a committed row throws
 *     IMMUTABLE_AUDIT_LOG.
 *
 * Sibling org-scoped writer is covered by org-audit-writer.test.ts.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import {
    appendAuditEntry,
    verifyAuditChain,
} from '@/lib/audit/audit-writer';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `aw-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE}`;
const OTHER_TENANT_ID = `t-${SUITE}-other`;

describeFn('appendAuditEntry — hash chain (real DB)', () => {
    let prisma: PrismaClient;
    // AuditLog.userId has an FK to User — entries with a non-null userId
    // need a real row. Created once and reused across tests.
    let actorUserId = '';

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: SUITE, slug: SUITE },
        });
        await prisma.tenant.upsert({
            where: { id: OTHER_TENANT_ID },
            update: {},
            create: { id: OTHER_TENANT_ID, name: `${SUITE}-o`, slug: `${SUITE}-o` },
        });
        const email = `${SUITE}-actor@example.test`;
        const actor = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        actorUserId = actor.id;
    });

    afterAll(async () => {
        // AuditLog is append-only — bypass the immutability trigger with
        // session_replication_role=replica (same pattern as
        // audit-immutability.test.ts). Then drop the tenants.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
                [TENANT_ID, OTHER_TENANT_ID],
            );
        });
        await prisma.tenant.deleteMany({
            where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } },
        });
        await prisma.user.deleteMany({ where: { id: actorUserId } });
        await prisma.$disconnect();
    });

    it('first entry has previousHash=null (genesis); the second chains off the first', async () => {
        // Isolate the chain to a fresh tenant so prior tests can't add
        // genesis entries (DEK backfill etc.).
        const tenantId = `t-${SUITE}-chain-${randomUUID().slice(0, 6)}`;
        await prisma.tenant.create({
            data: { id: tenantId, name: tenantId, slug: tenantId },
        });

        const first = await appendAuditEntry(
            {
                tenantId,
                userId: null,
                entity: 'Control',
                entityId: 'ctrl-1',
                action: 'CONTROL_CREATED',
                detailsJson: { category: 'control', note: 'first' },
            },
            prisma,
        );
        expect(first.previousHash).toBeNull();
        expect(first.entryHash).toMatch(/^[a-f0-9]{64}$/);

        const second = await appendAuditEntry(
            {
                tenantId,
                userId: actorUserId,
                entity: 'Control',
                entityId: 'ctrl-2',
                action: 'CONTROL_UPDATED',
                detailsJson: { category: 'control', note: 'second' },
            },
            prisma,
        );
        // The second entry links back to the first's hash.
        expect(second.previousHash).toBe(first.entryHash);
        expect(second.entryHash).not.toBe(first.entryHash);

        // The full chain verifies.
        const verdict = await verifyAuditChain(tenantId, prisma);
        expect(verdict.valid).toBe(true);
        expect(verdict.totalEntries).toBe(2);
        expect(verdict.hashedEntries).toBe(2);
        expect(verdict.unhashedEntries).toBe(0);

        await cleanupTenant(prisma, tenantId);
    });

    it('wraps legacy free-text `details` when no detailsJson is given', async () => {
        const tenantId = `t-${SUITE}-legacy-${randomUUID().slice(0, 6)}`;
        await prisma.tenant.create({
            data: { id: tenantId, name: tenantId, slug: tenantId },
        });

        const res = await appendAuditEntry(
            {
                tenantId,
                userId: null,
                entity: 'Asset',
                entityId: 'asset-1',
                action: 'UPDATE',
                details: 'legacy free text',
            },
            prisma,
        );
        expect(res.previousHash).toBeNull();

        const rows = await prisma.$queryRawUnsafe<
            Array<{ details: string | null; detailsJson: unknown }>
        >(`SELECT "details", "detailsJson" FROM "AuditLog" WHERE "id" = $1`, res.id);
        expect(rows[0].details).toBe('legacy free text');
        // detailsForHash wrapped the legacy text.
        expect(rows[0].detailsJson).toEqual({
            category: 'custom',
            legacyText: 'legacy free text',
        });

        await cleanupTenant(prisma, tenantId);
    });

    it('persists optional metadata (actorType, version, requestId, recordIds, metadataJson, diffJson)', async () => {
        const tenantId = `t-${SUITE}-meta-${randomUUID().slice(0, 6)}`;
        await prisma.tenant.create({
            data: { id: tenantId, name: tenantId, slug: tenantId },
        });

        const res = await appendAuditEntry(
            {
                tenantId,
                userId: actorUserId,
                actorType: 'SYSTEM',
                version: 2,
                entity: 'Risk',
                entityId: 'risk-1',
                action: 'RISK_UPDATED',
                detailsJson: { category: 'risk' },
                requestId: 'req-abc',
                recordIds: ['r1', 'r2'],
                metadataJson: { source: 'job' },
                diffJson: { before: 1, after: 2 },
            },
            prisma,
        );

        const rows = await prisma.$queryRawUnsafe<
            Array<{
                actorType: string;
                version: number;
                requestId: string | null;
                recordIds: unknown;
                metadataJson: unknown;
                diffJson: unknown;
            }>
        >(
            `SELECT "actorType", "version", "requestId", "recordIds", "metadataJson", "diffJson"
             FROM "AuditLog" WHERE "id" = $1`,
            res.id,
        );
        const row = rows[0];
        expect(row.actorType).toBe('SYSTEM');
        expect(row.version).toBe(2);
        expect(row.requestId).toBe('req-abc');
        expect(row.recordIds).toEqual(['r1', 'r2']);
        expect(row.metadataJson).toEqual({ source: 'job' });
        expect(row.diffJson).toEqual({ before: 1, after: 2 });

        await cleanupTenant(prisma, tenantId);
    });

    // ── verifyAuditChain edge branches ───────────────────────────────

    it('verifyAuditChain reports an empty chain as valid with zero entries', async () => {
        const tenantId = `t-${SUITE}-empty-${randomUUID().slice(0, 6)}`;
        await prisma.tenant.create({
            data: { id: tenantId, name: tenantId, slug: tenantId },
        });
        const verdict = await verifyAuditChain(tenantId, prisma);
        expect(verdict.totalEntries).toBe(0);
        expect(verdict.hashedEntries).toBe(0);
        expect(verdict.valid).toBe(true);
        expect(verdict.firstBreakAt).toBeUndefined();
        await prisma.tenant.delete({ where: { id: tenantId } });
    });

    it('verifyAuditChain detects a tampered entryHash', async () => {
        const tenantId = `t-${SUITE}-tamper-${randomUUID().slice(0, 6)}`;
        await prisma.tenant.create({
            data: { id: tenantId, name: tenantId, slug: tenantId },
        });
        const a = await appendAuditEntry(
            { tenantId, userId: null, entity: 'Control', entityId: 'c1', action: 'A', detailsJson: { category: 'x' } },
            prisma,
        );
        await appendAuditEntry(
            { tenantId, userId: null, entity: 'Control', entityId: 'c2', action: 'B', detailsJson: { category: 'x' } },
            prisma,
        );

        // Tamper with the first row's entryHash (bypass the immutability
        // trigger via session_replication_role=replica).
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `UPDATE "AuditLog" SET "entryHash" = $1 WHERE "id" = $2`,
                'deadbeef'.repeat(8),
                a.id,
            );
        });

        const verdict = await verifyAuditChain(tenantId, prisma);
        expect(verdict.valid).toBe(false);
        expect(verdict.firstBreakAt).toBe(0);
        expect(verdict.firstBreakId).toBe(a.id);

        await cleanupTenant(prisma, tenantId);
    });

    // ── immutability guard ───────────────────────────────────────────

    it('UPDATE on a committed audit row is blocked by the immutability trigger', async () => {
        const res = await appendAuditEntry(
            { tenantId: TENANT_ID, userId: null, entity: 'X', entityId: 'x1', action: 'IMM_U', detailsJson: { category: 'x' } },
            prisma,
        );
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "AuditLog" SET "details" = 'tamper' WHERE "id" = $1`,
                res.id,
            ),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_LOG/);
    });

    it('DELETE on a committed audit row is blocked by the immutability trigger', async () => {
        const res = await appendAuditEntry(
            { tenantId: TENANT_ID, userId: null, entity: 'X', entityId: 'x2', action: 'IMM_D', detailsJson: { category: 'x' } },
            prisma,
        );
        await expect(
            prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "id" = $1`, res.id),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_LOG/);
    });
});

/** Drop a per-test tenant: bypass the AuditLog trigger, then delete the tenant. */
async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
            tenantId,
        );
    });
    await prisma.tenant.delete({ where: { id: tenantId } });
}
