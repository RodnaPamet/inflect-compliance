/**
 * An agent-bound credential may not exceed the human it speaks for — at EITHER
 * door.
 *
 * ── What this pins, and why one door was not enough ───────────────────
 *
 * The narrowing (principal ∧ credential) originally had a single caller,
 * `buildMcpInvocation`, so it applied only to `/api/mcp`. But an `iflk_` bearer
 * is admitted at `/api/t/**` too (#2224), and that path built its context from
 * the KEY'S SCOPES ALONE. Measured on this branch before the fix, with ONE key
 * created by a READER and bound to an ACTIVE agent:
 *
 *   tools/call propose_risks  →  refused          (the door that was closed)
 *   POST /api/t/<slug>/risks  →  201, Risk created (the door that was open)
 *
 * The open door was strictly the worse of the two: it COMMITS the entity rather
 * than queueing a proposal, so it bypasses propose-not-commit entirely. With a
 * `*`-scoped key the same principal could issue an ADMIN invite.
 *
 * So the assertions below are deliberately paired. Testing only the MCP door
 * would have passed throughout the period the REST door was open, which is the
 * precise failure this file exists to prevent.
 *
 * ── Why the scopes matter ─────────────────────────────────────────────
 *
 * The key is minted with `risks:write`. A key whose scopes confer no write
 * cannot write regardless of narrowing, so such a test passes for the wrong
 * reason and stays green when the narrowing is reverted. The credential here is
 * deliberately capable; only the PRINCIPAL is not.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { generateApiKey, verifyApiKey } from '@/lib/auth/api-key-auth';
import { hashForLookup } from '@/lib/security/encryption';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `xprin-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const READER = `u-reader-${SUITE}`;
const OWNER = `u-owner-${SUITE}`;

let readerKey = '';
let agentId = '';

describeFn('an agent-bound key cannot exceed its principal', () => {
    beforeAll(async () => {
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        for (const [id, role] of [
            [OWNER, 'OWNER'],
            [READER, 'READER'],
        ] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({
                data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }

        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: 'host', ownerUserId: OWNER },
        });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: 'escalation-probe',
                autonomyLevel: 6,
                dataAccessScope: 'WRITE_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: OWNER,
                status: 'ACTIVE',
            },
        });
        agentId = agent.id;

        // Created BY THE READER, bound to the agent, and scoped to write.
        const { plaintext, keyHash, keyPrefix } = generateApiKey();
        await prisma.tenantApiKey.create({
            data: {
                tenantId: TENANT,
                name: 'reader-principal-write-scoped',
                keyPrefix,
                keyHash,
                scopes: ['mcp:read', 'mcp:propose', 'risks:read', 'risks:write'],
                createdById: READER,
                agentId,
            },
        });
        readerKey = plaintext;
    });

    afterAll(async () => {
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } });
        // Memberships and audit rows are guarded by triggers that a teardown
        // has no business arguing with: `LAST_OWNER_GUARD` refuses to leave a
        // tenant ownerless, and the audit log is append-only. Both are correct
        // in production and both make an ordinary `deleteMany` here fail the
        // whole suite with "failed to run" — a broken-suite signal for what is
        // really just cleanup. Replica mode suspends triggers for the
        // transaction, which is the shape the other integration suites use.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.user.deleteMany({ where: { id: { in: [OWNER, READER] } } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('resolves the credential to the PRINCIPAL role, not the scope-derived one', async () => {
        const result = await verifyApiKey(readerKey, null);
        expect(result.valid).toBe(true);
        if (!result.valid) return;

        // `risks:write` alone would derive EDITOR. The principal is a READER,
        // and the intersection is what the context must carry.
        expect(result.ctx.role).toBe('READER');
        expect(result.ctx.appPermissions?.risks?.create ?? false).toBe(false);
    });

    it('the REST door refuses the write its scopes alone would allow', async () => {
        const { POST } = await import('@/app/api/t/[tenantSlug]/risks/route');
        const req = new NextRequest(`http://localhost/api/t/${TENANT}/risks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${readerKey}` },
            body: JSON.stringify({ title: 'escalation attempt', description: 'should not exist' }),
        });

        const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT }) });
        expect(res.status).toBeGreaterThanOrEqual(400);

        // The status alone is not the claim — a route can 4xx for many reasons.
        // Nothing may have been WRITTEN.
        const created = await prisma.risk.count({ where: { tenantId: TENANT } });
        expect(created).toBe(0);
    });

    it('a credential whose principal is removed stops working entirely', async () => {
        // Distinct from revocation: the credential is fine, the human is gone.
        // Falling back to the key's own scopes here would restore exactly the
        // authority the narrowing removes.
        await prisma.tenantMembership.updateMany({
            where: { tenantId: TENANT, userId: READER },
            data: { status: 'DEACTIVATED' },
        });
        try {
            const result = await verifyApiKey(readerKey, null);
            expect(result.valid).toBe(false);
        } finally {
            await prisma.tenantMembership.updateMany({
                where: { tenantId: TENANT, userId: READER },
                data: { status: 'ACTIVE' },
            });
        }
    });
});
