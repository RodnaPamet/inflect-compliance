/**
 * THE REGISTER, AS A HARNESS SCANNER READS IT, END TO END (#3686, part c).
 *
 * Driven through the REAL `/api/mcp` route with REAL `TenantApiKey` rows, so the
 * whole funnel is in the path: the `mcp:read` capability, the deny-by-default
 * grant list, the `admin:harness_ingest` scope, the principal's own permission,
 * and the provenance label.
 *
 *   1. A SCANNER'S KEY READS WHAT THE REGISTER SOURCE CARRIES — the live agents
 *      with the register's own flags, their live keys by id, and the principals
 *      a person confirmed — and nothing else: no names, no retired, deleted or
 *      placeholder agent, no revoked or expired key, no invalidated link.
 *   2. EVERY OTHER KEY IS REFUSED, each with one `AUTHZ_DENIED` row: no ingest
 *      scope, an agent not granted the tool, a principal without the key.
 *   3. TWO TENANTS: one tenant's key reads its own register and none of the
 *      other's.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { readHarnessRegisterForScanner, type HarnessRegisterView } from '@/app-layer/usecases/agent-harness-register-read';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `hreg-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ra-${SUITE}`;
const TENANT_B = `rb-${SUITE}`;
const TOOL = 'get_harness_register';
const INGEST_SCOPES = ['mcp:read', 'admin:harness_ingest'];
const DAY = 86_400_000;

interface Seeded {
    owner: string;
    reader: string;
    scanner: string;
    target: string;
    retired: string;
    deleted: string;
    placeholder: string;
    ungranted: string;
    liveKey: string;
    revokedKey: string;
    expiredKey: string;
    confirmed: string;
    invalidated: string;
}
const ids: Record<string, Seeded> = {};
const keys: Record<string, string> = {};

async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, json };
}

const callTool = (token: string) =>
    rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: {} } });

function contentOf(json: unknown): Array<{ text: string }> | undefined {
    return (json as { result?: { content?: Array<{ text: string }> } })?.result?.content;
}
const errorOf = (json: unknown) => (json as { error?: { message?: string } })?.error?.message;

async function denials(tenantId: string) {
    return prisma.auditLog.count({ where: { tenantId, action: 'AUTHZ_DENIED' } });
}

async function mintKey(
    tenantId: string,
    userId: string,
    scopes: string[],
    agentId: string | null,
    extra: { revokedAt?: Date; expiresAt?: Date } = {},
): Promise<{ plaintext: string; id: string }> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    const row = await prisma.tenantApiKey.create({
        data: { tenantId, name: `k-${randomUUID().slice(0, 6)}`, keyPrefix, keyHash, scopes, createdById: userId, agentId, ...extra },
    });
    return { plaintext, id: row.id };
}

async function seedUser(suffix: string): Promise<string> {
    const userId = `u-${suffix}`;
    const email = `${suffix}@example.test`;
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email, emailHash: hashForLookup(email) } });
    return userId;
}

async function seedAgent(
    tenantId: string,
    ownerUserId: string,
    name: string,
    over: { status?: 'ACTIVE' | 'RETIRED'; deletedAt?: Date; isLegacyPlaceholder?: boolean } = {},
): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: `${name} host`, ownerUserId } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status: over.status ?? 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            deletedAt: over.deletedAt,
            isLegacyPlaceholder: over.isLegacyPlaceholder ?? false,
        },
    });
    return agent.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const owner = await seedUser(`${tenantId}-owner`);
    const reader = await seedUser(`${tenantId}-reader`);
    await prisma.tenantMembership.create({ data: { tenantId, userId: owner, role: 'OWNER', status: 'ACTIVE' } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: reader, role: 'READER', status: 'ACTIVE' } });

    const scanner = await seedAgent(tenantId, owner, `Scanner ${tenantId}`);
    const target = await seedAgent(tenantId, owner, `Sales bot ${tenantId}`);
    const retired = await seedAgent(tenantId, owner, `Retired ${tenantId}`, { status: 'RETIRED' });
    const deleted = await seedAgent(tenantId, owner, `Deleted ${tenantId}`, { deletedAt: new Date() });
    const placeholder = await seedAgent(tenantId, owner, `Placeholder ${tenantId}`, { isLegacyPlaceholder: true });
    const ungranted = await seedAgent(tenantId, owner, `Ungranted ${tenantId}`);
    await prisma.registeredAgentTool.create({ data: { tenantId, agentId: scanner, toolName: TOOL, grantedByUserId: owner } });

    // The target: a policy card, a fresh completed assessment, three keys of
    // which one is live, and two confirmed links of which one still holds.
    await prisma.agentPolicyCard.create({ data: { tenantId, agentId: target } });
    await prisma.agentRiskAssessment.create({ data: { tenantId, agentId: target, status: 'COMPLETED', completedAt: new Date(Date.now() - DAY) } });
    const liveKey = (await mintKey(tenantId, owner, ['controls:read'], target)).id;
    const revokedKey = (await mintKey(tenantId, owner, ['controls:read'], target, { revokedAt: new Date() })).id;
    const expiredKey = (await mintKey(tenantId, owner, ['controls:read'], target, { expiresAt: new Date(Date.now() - DAY) })).id;
    const now = new Date();
    const discovered = (n: string) =>
        prisma.discoveredAgent.create({
            data: {
                tenantId,
                discoveredId: `entra:sp:${n}-${tenantId}`,
                discoveredVia: ['entra-sp'],
                registeredAgentId: target,
                firstSeenAt: now,
                lastSeenAt: now,
                lastScanId: `scan-${tenantId}`,
                lastLevel: 'H1',
                lastReach: 'READ_ONLY',
            },
        });
    const confirmedRow = await discovered('confirmed');
    const invalidatedRow = await discovered('invalidated');
    await prisma.agentServicePrincipalConfirmation.create({
        data: { tenantId, discoveredAgentId: confirmedRow.id, registeredAgentId: target, discoveredId: confirmedRow.discoveredId, confirmedByUserId: owner },
    });
    await prisma.agentServicePrincipalConfirmation.create({
        data: {
            tenantId,
            discoveredAgentId: invalidatedRow.id,
            registeredAgentId: target,
            discoveredId: invalidatedRow.discoveredId,
            confirmedByUserId: owner,
            invalidatedAt: now,
            invalidatedReason: 'PRINCIPAL_RELINKED',
        },
    });

    ids[tenantId] = {
        owner,
        reader,
        scanner,
        target,
        retired,
        deleted,
        placeholder,
        ungranted,
        liveKey,
        revokedKey,
        expiredKey,
        confirmed: confirmedRow.discoveredId,
        invalidated: invalidatedRow.discoveredId,
    };
}

describeFn('get_harness_register, end to end', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await seedTenant(TENANT_A);
        await seedTenant(TENANT_B);
        const a = ids[TENANT_A];
        keys.scanner = (await mintKey(TENANT_A, a.owner, INGEST_SCOPES, a.scanner)).plaintext;
        keys.scannerB = (await mintKey(TENANT_B, ids[TENANT_B].owner, INGEST_SCOPES, ids[TENANT_B].scanner)).plaintext;
        keys.noIngest = (await mintKey(TENANT_A, a.owner, ['mcp:read', 'admin:read'], a.scanner)).plaintext;
        keys.noGrant = (await mintKey(TENANT_A, a.owner, INGEST_SCOPES, a.ungranted)).plaintext;
        keys.readerPrincipal = (await mintKey(TENANT_A, a.reader, INGEST_SCOPES, a.scanner)).plaintext;
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await deleteAuditRowsForTenants(prisma, t).catch(() => {});
            await prisma
                .$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                    await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t);
                })
                .catch(() => {});
            await prisma.agentServicePrincipalConfirmation.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.discoveredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentRiskAssessment.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.agentPolicyCard.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgentTool.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } });
        }
        await prisma.user.deleteMany({ where: { id: { contains: SUITE } } });
        await prisma.$disconnect();
    });

    describe('1. a scanner key reads what the register source carries', () => {
        /** The scanner key's payload, as text: what the scanner receives. */
        async function payloadText(): Promise<string> {
            const { json } = await callTool(keys.scanner);
            expect(errorOf(json)).toBeUndefined();
            return contentOf(json)![0].text;
        }

        it('the live agents only — never a retired, deleted or placeholder one', async () => {
            const raw = await payloadText();
            const view = JSON.parse(raw) as HarnessRegisterView;
            const a = ids[TENANT_A];
            expect(view.truncated).toBe(false);
            expect(view.agents.map((x) => x.registeredAgentId).sort()).toEqual([a.scanner, a.target, a.ungranted].sort());
            for (const gone of [a.retired, a.deleted, a.placeholder]) expect(raw).not.toContain(gone);
        });

        it('the register\'s own flags, live keys by id, and only the links a person confirmed that still hold', async () => {
            const raw = await payloadText();
            const view = JSON.parse(raw) as HarnessRegisterView;
            const a = ids[TENANT_A];
            const target = view.agents.find((x) => x.registeredAgentId === a.target)!;
            expect(target).toMatchObject({
                status: 'ACTIVE',
                ownerUserId: a.owner,
                axesDeclared: true,
                tierFresh: true,
                policyCardInForce: true,
                confirmedPrincipals: [a.confirmed],
            });
            expect(target.apiKeys.map((k) => k.id)).toEqual([a.liveKey]);
            for (const gone of [a.revokedKey, a.expiredKey, a.invalidated]) expect(raw).not.toContain(gone);

            // Never assessed: scored, but not fresh. No card, no links.
            const scanner = view.agents.find((x) => x.registeredAgentId === a.scanner)!;
            expect(scanner).toMatchObject({ tierFresh: false, policyCardInForce: false, confirmedPrincipals: [] });
            // The scanner's own key is the agent's own live key.
            expect(scanner.apiKeys).toHaveLength(3);
        });

        it('carries no name and no key material', async () => {
            const raw = await payloadText();
            expect(raw).not.toContain(`Sales bot ${TENANT_A}`);
            expect(raw).not.toContain(`Scanner ${TENANT_A}`);
            expect(raw).not.toContain(keys.scanner);
            expect(raw).not.toMatch(/keyPrefix|keyHash|scopes/);
        });

        it('rides with the provenance block, labelled untrusted', async () => {
            const { json } = await callTool(keys.scanner);
            expect(JSON.parse(contentOf(json)![1].text)).toMatchObject({
                kind: 'content-provenance',
                tool: TOOL,
                provenance: 'THIRD_PARTY_INGESTED',
                mayCarryInstruction: false,
            });
        });
    });

    describe('2. every other key is refused, with one AUTHZ_DENIED row', () => {
        it.each([
            ['a key without admin:harness_ingest', 'noIngest'],
            ['an agent not granted the tool', 'noGrant'],
            ['a principal who does not hold admin.agent_harness_ingest', 'readerPrincipal'],
        ])('%s', async (_label, key) => {
            const before = await denials(TENANT_A);
            const { json } = await callTool(keys[key]);
            expect(contentOf(json)).toBeUndefined();
            expect(errorOf(json)).toBeDefined();
            expect((await denials(TENANT_A)) - before).toBe(1);
        });

        it('the usecase refuses a READER and admits an OWNER', async () => {
            const a = ids[TENANT_A];
            await expect(
                readHarnessRegisterForScanner(makeRequestContext('READER', { tenantId: TENANT_A, tenantSlug: TENANT_A, userId: a.reader })),
            ).rejects.toThrow('admin.agent_harness_ingest');
            const owner = await readHarnessRegisterForScanner(
                makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: TENANT_A, userId: a.owner }),
            );
            expect(owner.agents.length).toBe(3);
        });
    });

    describe('3. two tenants', () => {
        it('each tenant\'s scanner key reads its own register and none of the other\'s', async () => {
            const a = await callTool(keys.scanner);
            const b = await callTool(keys.scannerB);
            const textA = contentOf(a.json)![0].text;
            const textB = contentOf(b.json)![0].text;
            for (const id of Object.values(ids[TENANT_B])) expect(textA).not.toContain(id);
            for (const id of Object.values(ids[TENANT_A])) expect(textB).not.toContain(id);
            expect(textB).toContain(ids[TENANT_B].target);
        });
    });
});
