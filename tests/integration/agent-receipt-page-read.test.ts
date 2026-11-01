/**
 * The receipts page's read (#4897), against a real database.
 *
 *   1. THE AGENT IS OUR BINDING: a row names the registered agent the
 *      submitting key is bound to, never the receipt's own `agent_id`.
 *   2. THE RECEIPT'S CLAIM is carried only on a VERIFIED receipt, where it is
 *      at least the mediator's signed word; on an unverified one it is
 *      whatever the sender wrote, so it is dropped.
 *   3. AN OUTSIDE TOOL is named by its own name and its connection's name.
 *   4. THE WINDOW IS READ ONE PAST ITS BOUND, so a cut list knows it is cut;
 *      and it narrows to unverified receipts, or to one tool.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes, randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { RECEIPT_PAGE_SIZE, readReceiptPage } from '@/app-layer/usecases/agent-action-receipt';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { makeRequestContext } from '../helpers/make-context';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rcpt-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const BUSY = `b-${SUITE}`;
const USER = `u-${SUITE}`;

const ctx = (tenantId = TENANT) => makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: USER });

let AGENT = '';
let BOUND_KEY = '';
let CONNECTION = '';

async function seedTenant(id: string) {
    await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: id, userId: USER } },
        update: { role: 'OWNER', status: 'ACTIVE' },
        create: { tenantId: id, userId: USER, role: 'OWNER', status: 'ACTIVE' },
    });
}

async function receipt(tenantId: string, over: Record<string, unknown>) {
    return prisma.agentActionReceipt.create({
        data: {
            tenantId,
            toolName: 'list_risks',
            decisionVerdict: 'allow',
            signature: 'sig',
            signingKeyId: 'key',
            occurredAt: new Date(),
            ...over,
        },
        select: { id: true },
    });
}

describeFn('the receipts page read (#4897)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const email = `${USER}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });
        await seedTenant(TENANT);
        await seedTenant(BUSY);
        const aiSystem = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `${SUITE} host`, ownerUserId: USER } });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: `${SUITE} reviewer`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: USER,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        AGENT = agent.id;
        const key = await prisma.tenantApiKey.create({
            data: {
                tenantId: TENANT,
                name: `${SUITE} bound`,
                keyPrefix: 'iflk_rc',
                keyHash: `${SUITE}-${randomBytes(12).toString('hex')}`,
                createdById: USER,
                agentId: AGENT,
            },
        });
        BOUND_KEY = key.id;
        const connection = await prisma.integrationConnection.create({
            data: { tenantId: TENANT, provider: 'mcp-server', name: 'Entra (production)', configJson: {} },
        });
        CONNECTION = connection.id;
    }, 120_000);

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('names the agent the key is bound to, and the receipt’s own claim only when verified', async () => {
        const verified = await receipt(TENANT, { mcpKeyId: BOUND_KEY, agentId: 'pipelock-run-42', verified: true });
        const unverified = await receipt(TENANT, { mcpKeyId: BOUND_KEY, agentId: 'whatever-the-sender-wrote', verified: false });

        const { rows } = await readReceiptPage(ctx());
        const byId = new Map(rows.map((r) => [r.id, r]));

        expect(byId.get(verified.id)).toMatchObject({
            agent: { id: AGENT, name: `${SUITE} reviewer` },
            claimedAgentId: 'pipelock-run-42',
        });
        expect(byId.get(unverified.id)).toMatchObject({
            agent: { id: AGENT, name: `${SUITE} reviewer` },
            claimedAgentId: null,
        });
    });

    it('names an outside tool by its own name and its connection', async () => {
        const row = await receipt(TENANT, { toolName: externalToolName(CONNECTION, 'grant_role') });
        const { rows } = await readReceiptPage(ctx());
        expect(rows.find((r) => r.id === row.id)).toMatchObject({
            toolName: 'grant_role',
            connectionName: 'Entra (production)',
            agent: null,
        });
    });

    it('narrows to unverified receipts, and to one tool', async () => {
        await receipt(TENANT, { toolName: 'get_compliance_posture', verified: false });
        const unverified = await readReceiptPage(ctx(), { verified: false });
        expect(unverified.rows.length).toBeGreaterThan(0);
        expect(unverified.rows.every((r) => !r.verified)).toBe(true);
        const oneTool = await readReceiptPage(ctx(), { toolName: 'get_compliance_posture' });
        expect(oneTool.rows.map((r) => r.toolName)).toEqual(['get_compliance_posture']);
    });

    it('knows when it is cut, and says nothing when it is not', async () => {
        await prisma.agentActionReceipt.createMany({
            data: Array.from({ length: RECEIPT_PAGE_SIZE + 1 }, (_, i) => ({
                tenantId: BUSY,
                toolName: 'list_risks',
                decisionVerdict: 'allow',
                signature: `sig-${i}`,
                signingKeyId: 'key',
                occurredAt: new Date(Date.now() - i * 1000),
            })),
        });
        const busy = await readReceiptPage(ctx(BUSY));
        expect(busy.rows).toHaveLength(RECEIPT_PAGE_SIZE);
        expect(busy.capped).toBe(RECEIPT_PAGE_SIZE);
        expect((await readReceiptPage(ctx())).capped).toBeNull();
    });
});
