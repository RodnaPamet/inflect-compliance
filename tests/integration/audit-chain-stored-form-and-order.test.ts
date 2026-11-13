/**
 * A verified chain stays valid for what real callers write (#5069, #5180).
 *
 * #5069: a `Date` in `detailsJson` hashed as `{}` but stored as its ISO
 * string, so the verifier, which recomputes from the stored row, reported a
 * mismatch on a lawful row and every later row went unverified.
 *
 * #5180: appends inside one millisecond shared a timestamp; the predecessor
 * was then picked by a random id tie-break, and the verifier could walk the
 * tied rows in the opposite order to the one they were chained in.
 *
 * Both writers are covered: the tenant AuditLog and the OrgAuditLog.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { appendAuditEntry, verifyAuditChain } from '@/lib/audit/audit-writer';
import { appendOrgAuditEntry, verifyOrgAuditChain } from '@/lib/audit/org-audit-writer';
import { deleteAuditRowsForTenants, deleteOrgAuditRowsForOrganizations } from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SUFFIX = `chain-${Date.now()}`;

/** Freeze `new Date()` (and only it) so every append lands in one millisecond. */
function freezeClock(at: string) {
    jest.useFakeTimers({
        now: new Date(at),
        doNotFake: [
            'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
            'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance',
        ],
    });
}

describeFn('audit chain — stored form and append order', () => {
    let prisma: PrismaClient;
    let tenantId = '';
    let organizationId = '';

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const tenant = await prisma.tenant.create({ data: { name: 'Chain', slug: `${SUFFIX}-t` } });
        tenantId = tenant.id;
        const org = await prisma.organization.create({ data: { name: 'Chain', slug: `${SUFFIX}-o` } });
        organizationId = org.id;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    afterAll(async () => {
        if (tenantId) {
            await deleteAuditRowsForTenants(prisma, tenantId);
            await prisma.tenant.deleteMany({ where: { id: tenantId } });
        }
        if (organizationId) {
            await deleteOrgAuditRowsForOrganizations(prisma, organizationId);
            await prisma.organization.deleteMany({ where: { id: organizationId } });
        }
        await prisma.$disconnect();
    });

    it('a Date in the details verifies (tenant chain, #5069)', async () => {
        await appendAuditEntry({
            tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'WorkflowRun',
            entityId: 'run-1',
            action: 'AGENT_RUN_REAPED',
            detailsJson: {
                category: 'access',
                stalledSince: new Date('2026-11-10T08:00:00.000Z'),
                after: { revokedAt: new Date('2026-11-10T09:00:00.000Z') },
            },
        }, prisma);
        const result = await verifyAuditChain(tenantId, prisma);
        expect(result.valid).toBe(true);
    });

    it('a Date in the details verifies (org chain, #5069)', async () => {
        await appendOrgAuditEntry({
            organizationId,
            actorUserId: null,
            action: 'ORG_MEMBER_ADDED',
            detailsJson: { at: new Date('2026-11-10T08:00:00.000Z') },
        }, prisma);
        expect((await verifyOrgAuditChain(organizationId, prisma)).valid).toBe(true);
    });

    it('appends in one millisecond chain in a walkable order (tenant chain, #5180)', async () => {
        freezeClock('2026-11-12T10:00:00.000Z');
        for (let i = 0; i < 8; i++) {
            await appendAuditEntry({
                tenantId,
                userId: null,
                actorType: 'SYSTEM',
                entity: 'Test',
                entityId: `same-ms-${i}`,
                action: 'TEST_SAME_MS',
                detailsJson: { category: 'custom', i },
            }, prisma);
        }
        jest.useRealTimers();

        const rows: Array<{ ts: string }> = await prisma.$queryRawUnsafe(
            `SELECT to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS ts
             FROM "AuditLog" WHERE "tenantId" = $1 AND "action" = 'TEST_SAME_MS'`,
            tenantId,
        );
        expect(new Set(rows.map((r) => r.ts)).size).toBe(8);
        expect((await verifyAuditChain(tenantId, prisma)).valid).toBe(true);
    });

    it('appends in one millisecond chain in a walkable order (org chain, #5180)', async () => {
        freezeClock('2026-11-12T11:00:00.000Z');
        for (let i = 0; i < 8; i++) {
            await appendOrgAuditEntry({
                organizationId,
                actorUserId: null,
                action: 'ORG_MEMBER_ADDED',
                detailsJson: { i },
            }, prisma);
        }
        jest.useRealTimers();
        expect((await verifyOrgAuditChain(organizationId, prisma)).valid).toBe(true);
    });
});
