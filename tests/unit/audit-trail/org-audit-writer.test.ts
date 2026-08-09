/**
 * Branch coverage for the org-scoped hash-chained audit writer
 * (`src/lib/audit/org-audit-writer.ts`). Mirrors audit-writer.test.ts
 * but targets the dedicated `OrgAuditLog` table + the per-org
 * advisory lock (`hashtext('org:' || organizationId)`).
 *
 * DB-backed (real Postgres). Branches exercised:
 *   - appendOrgAuditEntry genesis (previousHash=null) → chain link.
 *   - detailsJson present  vs  omitted (the `?? null` canonicalisation).
 *   - targetUserId present vs null.
 *   - actorType / version defaulting.
 *   - verifyOrgAuditChain: valid multi-entry chain, empty chain,
 *     tamper detection.
 *   - immutability trigger: UPDATE / DELETE blocked with
 *     IMMUTABLE_ORG_AUDIT_LOG.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import {
    appendOrgAuditEntry,
    verifyOrgAuditChain,
} from '@/lib/audit/org-audit-writer';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `oaw-${randomUUID().slice(0, 8)}`;

describeFn('appendOrgAuditEntry — org hash chain (real DB)', () => {
    let prisma: PrismaClient;
    let orgId = '';
    let actorUserId = '';
    let targetUserId = '';
    const orgIds: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        const org = await prisma.organization.create({
            data: { name: SUITE, slug: SUITE },
        });
        orgId = org.id;
        orgIds.push(orgId);

        const aEmail = `${SUITE}-actor@example.test`;
        const tEmail = `${SUITE}-target@example.test`;
        const actor = await prisma.user.create({
            data: { email: aEmail, emailHash: hashForLookup(aEmail) },
        });
        actorUserId = actor.id;
        const target = await prisma.user.create({
            data: { email: tEmail, emailHash: hashForLookup(tEmail) },
        });
        targetUserId = target.id;
    });

    afterAll(async () => {
        // OrgAuditLog is append-only — bypass its trigger to clean up.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "OrgAuditLog" WHERE "organizationId" = ANY($1::text[])`,
                orgIds,
            );
        });
        await prisma.user.deleteMany({ where: { id: { in: [actorUserId, targetUserId] } } });
        await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
        await prisma.$disconnect();
    });

    it('first entry has previousHash=null; the second chains off it', async () => {
        const first = await appendOrgAuditEntry(
            {
                organizationId: orgId,
                actorUserId,
                action: 'ORG_MEMBER_ADDED',
                targetUserId,
                detailsJson: { note: 'first' },
            },
            prisma,
        );
        expect(first.previousHash).toBeNull();
        expect(first.entryHash).toMatch(/^[a-f0-9]{64}$/);

        const second = await appendOrgAuditEntry(
            {
                organizationId: orgId,
                actorUserId,
                action: 'ORG_MEMBER_ROLE_CHANGED',
                targetUserId,
                detailsJson: { note: 'second' },
            },
            prisma,
        );
        expect(second.previousHash).toBe(first.entryHash);
        expect(second.entryHash).not.toBe(first.entryHash);

        const verdict = await verifyOrgAuditChain(orgId, prisma);
        expect(verdict.valid).toBe(true);
        expect(verdict.totalEntries).toBeGreaterThanOrEqual(2);
    });

    it('canonicalises omitted detailsJson to null and accepts a null targetUserId + SYSTEM actor', async () => {
        const org = await prisma.organization.create({
            data: { name: `${SUITE}-n`, slug: `${SUITE}-null-${randomUUID().slice(0, 6)}` },
        });
        orgIds.push(org.id);

        const res = await appendOrgAuditEntry(
            {
                organizationId: org.id,
                actorUserId: null,
                actorType: 'SYSTEM',
                action: 'ORG_ADMIN_PROVISIONED_TO_TENANTS',
                version: 3,
                // detailsJson + targetUserId intentionally omitted
            },
            prisma,
        );
        expect(res.previousHash).toBeNull();

        const rows = await prisma.$queryRawUnsafe<
            Array<{
                detailsJson: unknown;
                targetUserId: string | null;
                actorType: string;
                version: number;
                actorUserId: string | null;
            }>
        >(
            `SELECT "detailsJson", "targetUserId", "actorType", "version", "actorUserId"
             FROM "OrgAuditLog" WHERE "id" = $1`,
            res.id,
        );
        const row = rows[0];
        expect(row.detailsJson).toBeNull();
        expect(row.targetUserId).toBeNull();
        expect(row.actorUserId).toBeNull();
        expect(row.actorType).toBe('SYSTEM');
        expect(row.version).toBe(3);

        const verdict = await verifyOrgAuditChain(org.id, prisma);
        expect(verdict.valid).toBe(true);
        expect(verdict.totalEntries).toBe(1);
    });

    it('verifyOrgAuditChain reports an empty chain as valid', async () => {
        const org = await prisma.organization.create({
            data: { name: `${SUITE}-e`, slug: `${SUITE}-empty-${randomUUID().slice(0, 6)}` },
        });
        orgIds.push(org.id);
        const verdict = await verifyOrgAuditChain(org.id, prisma);
        expect(verdict.totalEntries).toBe(0);
        expect(verdict.valid).toBe(true);
        expect(verdict.firstBreakAt).toBeUndefined();
    });

    it('verifyOrgAuditChain detects a tampered entryHash', async () => {
        const org = await prisma.organization.create({
            data: { name: `${SUITE}-t`, slug: `${SUITE}-tamper-${randomUUID().slice(0, 6)}` },
        });
        orgIds.push(org.id);
        const a = await appendOrgAuditEntry(
            { organizationId: org.id, actorUserId, action: 'ORG_MEMBER_ADDED' },
            prisma,
        );
        await appendOrgAuditEntry(
            { organizationId: org.id, actorUserId, action: 'ORG_MEMBER_REMOVED' },
            prisma,
        );

        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `UPDATE "OrgAuditLog" SET "entryHash" = $1 WHERE "id" = $2`,
                'deadbeef'.repeat(8),
                a.id,
            );
        });

        const verdict = await verifyOrgAuditChain(org.id, prisma);
        expect(verdict.valid).toBe(false);
        expect(verdict.firstBreakAt).toBe(0);
        expect(verdict.firstBreakId).toBe(a.id);
    });

    it('UPDATE on a committed org audit row is blocked by the immutability trigger', async () => {
        const res = await appendOrgAuditEntry(
            { organizationId: orgId, actorUserId, action: 'ORG_INVITE_CREATED' },
            prisma,
        );
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "OrgAuditLog" SET "actorType" = 'TAMPER' WHERE "id" = $1`,
                res.id,
            ),
        ).rejects.toThrow(/IMMUTABLE_ORG_AUDIT_LOG/);
    });

    it('DELETE on a committed org audit row is blocked by the immutability trigger', async () => {
        const res = await appendOrgAuditEntry(
            { organizationId: orgId, actorUserId, action: 'ORG_INVITE_REVOKED' },
            prisma,
        );
        await expect(
            prisma.$executeRawUnsafe(`DELETE FROM "OrgAuditLog" WHERE "id" = $1`, res.id),
        ).rejects.toThrow(/IMMUTABLE_ORG_AUDIT_LOG/);
    });
});
