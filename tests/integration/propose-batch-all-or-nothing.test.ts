/**
 * A propose batch is all or nothing, and is charged only when it succeeds
 * (#5304, item 15).
 *
 * `runProposeTool` used to write each item as it went. A content-guard block on
 * the third item failed the call after the first two were already PENDING: the
 * agent saw a failure with no ids, resent all three, and reviewers got the
 * first two twice. The policy card was charged an action for that failed call
 * as well, because the budget was spent at the gate.
 *
 * The block needs a guard slice that disagrees with the regex pass the output
 * guard runs (otherwise the item is QUARANTINED rather than refused), which is
 * what a second provider such as NeMo does in production. The provider list is
 * replaced with the real patterns provider plus a local slice that calls one
 * marker a secret; everything else here is real: the gate, the policy card's
 * counter, the guards' composition and the rows.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { createAgentProposal, prepareAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const BLOCK_MARKER = 'BATCH-BLOCK-MARKER';

jest.mock('@/app-layer/ai/guard/providers/registry', () => {
    const actual = jest.requireActual('@/app-layer/ai/guard/providers/registry');
    const { patternsProvider } = jest.requireActual('@/app-layer/ai/guard/providers/patterns-provider');
    const secondSlice = {
        id: 'second-slice',
        remote: false,
        scan: async (kind: string, content: unknown) =>
            kind === 'egress' && JSON.stringify(content ?? null).includes('BATCH-BLOCK-MARKER')
                ? { verdict: 'malicious', ruleIds: ['test.batch_block'], maxSeverity: 'high' }
                : { verdict: 'clean', ruleIds: [] },
    };
    return { ...actual, activeGuardProviders: () => [patternsProvider, secondSlice] };
});

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const TENANT = 'pbaon-tenant';

let agentId = '';
let ownerId = '';
let cardId = '';

function agentCtx(): RequestContext {
    return makeRequestContext('OWNER', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: ownerId,
        agentId,
    });
}

const risk = (title: string) => ({ title, description: 'proposed in a batch' });
// An AWS access key id, built at run time so no secret-shaped literal sits in
// the source. The regex guard calls it malicious, so its item is QUARANTINED.
const quarantinedRisk = () => risk(`leaks ${'AKIA'}${'Q'.repeat(16)}`);

async function proposals() {
    return prisma.agentProposal.findMany({
        where: { tenantId: TENANT },
        select: { status: true },
    });
}

async function actionsCharged(): Promise<number> {
    const card = await prisma.agentPolicyCard.findUnique({
        where: { id: cardId },
        select: { actionsInWindow: true },
    });
    return card?.actionsInWindow ?? 0;
}

describeFn('a propose batch is all or nothing, and charged only when it succeeds (#5304)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentPolicyCardVersion.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentPolicyCard.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });

        ownerId = `${TENANT}-owner`;
        const email = `${ownerId}@example.test`;
        await prisma.user.upsert({
            where: { id: ownerId },
            update: {},
            create: { id: ownerId, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: ownerId } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
        });

        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: 'batch host', ownerUserId: ownerId },
        });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: 'batch agent',
                autonomyLevel: 4,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: ownerId,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        agentId = agent.id;
        await prisma.registeredAgentTool.create({
            data: { tenantId: TENANT, agentId, toolName: 'propose_risks', grantedByUserId: ownerId },
        });

        const card = await prisma.agentPolicyCard.create({
            data: { tenantId: TENANT, agentId, currentVersion: 1, createdByUserId: ownerId },
        });
        cardId = card.id;
        await prisma.agentPolicyCardVersion.create({
            data: {
                tenantId: TENANT,
                cardId,
                version: 1,
                permittedTools: ['propose_risks'],
                maxDataScope: 'WRITE_TENANT_DATA',
                maxAutonomyLevel: 4,
                maxActionsPerRun: 25,
                maxActionsPerDay: 100,
                escalationTriggers: [],
                approvalRung: 'SINGLE_APPROVER',
                createdByUserId: ownerId,
            },
        });
    });

    beforeEach(async () => {
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await prisma.agentPolicyCard.update({
            where: { id: cardId },
            data: { actionsInWindow: 0, usageWindowDate: null },
        });
    });

    afterAll(async () => {
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await deleteAuditRowsForTenants(prisma, [TENANT]);
        await prisma.$disconnect();
    });

    it('the positive control: a clean batch of three queues three and is charged one action', async () => {
        const inv = await resolveMcpInvocation(agentCtx());
        await runProposeTool(inv, 'propose_risks', {
            items: [risk('one'), risk('two'), risk('three')],
        });

        expect((await proposals()).map((p) => p.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
        expect(await actionsCharged()).toBe(1);
    });

    it('a content-guard block on the third item queues none of them and charges nothing', async () => {
        const inv = await resolveMcpInvocation(agentCtx());
        await expect(
            runProposeTool(inv, 'propose_risks', {
                items: [risk('one'), risk('two'), risk(`three ${BLOCK_MARKER}`)],
            }),
        ).rejects.toThrow(/ai_guard_blocked/);

        expect(await proposals()).toEqual([]);
        expect(await actionsCharged()).toBe(0);
    });

    it('an earlier QUARANTINED item is still written as evidence; nothing reaches the queue', async () => {
        const inv = await resolveMcpInvocation(agentCtx());
        await expect(
            runProposeTool(inv, 'propose_risks', {
                items: [quarantinedRisk(), risk('two'), risk(`three ${BLOCK_MARKER}`)],
            }),
        ).rejects.toThrow(/ai_guard_blocked/);

        expect((await proposals()).map((p) => p.status)).toEqual(['QUARANTINED']);
        expect(await actionsCharged()).toBe(0);
    });

    it('a prepared item is written once, and an object that only looks prepared is not one', async () => {
        const ctx = agentCtx();
        const prepared = await prepareAgentProposal(ctx, {
            kind: 'RISK',
            payload: risk('once'),
            policyCardVersion: 0,
        });
        await createAgentProposal(ctx, prepared);
        await expect(createAgentProposal(ctx, prepared)).rejects.toThrow(/written once/);

        // Shaped like a handle, not issued as one: it is read as an input and
        // refused by the schema, never written past the guards.
        await expect(
            createAgentProposal(ctx, { kind: 'RISK', quarantined: false } as unknown as Parameters<
                typeof createAgentProposal
            >[1]),
        ).rejects.toThrow(/invalid/);

        expect((await proposals()).map((p) => p.status)).toEqual(['PENDING']);
    });
});
