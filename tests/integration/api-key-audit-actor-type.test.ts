/**
 * #5786 — an API key's writes are audited as the KEY, never as its creator.
 *
 * `verifyApiKey` builds the request context of every key-authenticated call,
 * REST and `/api/mcp` alike, with `userId` set to the key's creator. Before the
 * fix it left `actorType` unset, `logEvent` forwarded that, and
 * `appendAuditEntry` defaulted it to 'USER': the hash-chained trail claimed the
 * creator did by hand every write the key made. Seen in production on
 * 2026-11-22 on a harness scan's ingest rows.
 *
 * The test drives the real REST route with a real key against a real database,
 * then reads back every audit row the tenant gained: none may claim a person,
 * and the usecase's own row must name the key. A session-shaped context writes
 * 'USER' as before, through the same `logEvent`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { generateApiKey, verifyApiKey } from '@/lib/auth/api-key-auth';
import { hashForLookup } from '@/lib/security/encryption';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

jest.setTimeout(60_000);

const SUITE = `akactor-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const CREATOR = `u-creator-${SUITE}`;

let key = '';

describeFn('#5786 an API key is audited as API_KEY, not as its creator', () => {
    beforeAll(async () => {
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${CREATOR}@example.test`;
        await prisma.user.create({ data: { id: CREATOR, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: TENANT, userId: CREATOR, role: 'OWNER', status: 'ACTIVE' },
        });
        const { plaintext, keyHash, keyPrefix } = generateApiKey();
        await prisma.tenantApiKey.create({
            data: {
                tenantId: TENANT,
                name: 'integration-write',
                keyPrefix,
                keyHash,
                scopes: ['risks:read', 'risks:write'],
                createdById: CREATOR,
            },
        });
        key = plaintext;
    });

    afterAll(async () => {
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } });
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.user.deleteMany({ where: { id: CREATOR } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('the context verifyApiKey builds says a credential acted', async () => {
        const result = await verifyApiKey(key, null);
        expect(result.valid).toBe(true);
        if (!result.valid) return;
        expect(result.ctx.actorType).toBe('API_KEY');
        // The creator is still named: the row says WHOSE key, and that a key did it.
        expect(result.ctx.userId).toBe(CREATOR);
    });

    it('a REST write with the key leaves no audit row claiming a person', async () => {
        const before = new Date();
        const { POST } = await import('@/app/api/t/[tenantSlug]/risks/route');
        const req = new NextRequest(`http://localhost/api/t/${TENANT}/risks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ title: 'written by a key', description: 'audit attribution' }),
        });
        const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT }) });
        expect(res.status).toBeLessThan(300);
        expect(await prisma.risk.count({ where: { tenantId: TENANT } })).toBe(1);

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, createdAt: { gte: before } },
            select: { action: true, entity: true, actorType: true, userId: true },
        });
        // Non-empty first: an empty set satisfies "none says USER" vacuously.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => r.actorType === 'USER')).toEqual([]);
        expect(rows.some((r) => r.actorType === 'API_KEY' && r.entity === 'Risk')).toBe(true);
    });

    it('a session-shaped context still writes USER through the same logEvent', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT, userId: CREATOR });
        const entityId = `probe-${SUITE}`;
        await logEvent(prisma, ctx, { action: 'PROBE', entityType: 'Probe', entityId });
        const row = await prisma.auditLog.findFirst({
            where: { tenantId: TENANT, entityId },
            select: { actorType: true },
        });
        expect(row?.actorType).toBe('USER');
    });
});
