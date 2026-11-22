/**
 * A POLICY CARD CAN PERMIT THE AGENT'S GRANTED EXTERNAL TOOLS (found in the A2A
 * production pilot, 2026-11-22, #3752).
 *
 * The boundary holds every tool call, external ones included, to the card's
 * `permittedTools`. The card writer refused every name outside this build's
 * static catalogue (NOT_IN_CATALOGUE) and the editor offered none, so no card
 * could permit an external tool (a tool server's tool or an A2A send) and no
 * agent with a card could call one: the pilot's run settled "no tools", its
 * send withheld as not permitted by the card.
 *
 * Real usecases against Postgres. The grant row is inserted directly because
 * granting an external tool is not what is under test (it needs an accepted
 * definition on a live connection); everything about the CARD goes through the
 * real create, read and update.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { completeAgentRiskAssessment } from '@/app-layer/usecases/agent-risk-assessment';
import {
    createAgentPolicyCard,
    getAgentPolicyCard,
    updateAgentPolicyCard,
} from '@/app-layer/usecases/agent-policy-card';
import { ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';
import { a2aSendToolName } from '@/lib/agentic/a2a/send-tool';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `pcext-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

const owner = () => makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });
const reader = () => makeRequestContext('READER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

type CardValue = {
    permittedTools: string[];
    maxDataScope: string;
    maxAutonomyLevel: number;
    maxActionsPerRun: number;
    maxActionsPerDay: number;
    escalationTriggers: string[];
    approvalRung: string;
};

describeFn("a policy card can permit the agent's granted external tools (real DB)", () => {
    let agentId = '';
    let send = '';
    let connectionName = '';

    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });

        const aiSystem = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: `host ${SUITE}`, ownerUserId: USER } });
        const created = await createRegisteredAgent(owner(), {
            aiSystemId: aiSystem.id,
            name: `sender ${SUITE}`,
            autonomyLevel: 2,
            dataAccessScope: 'EXTERNAL_EGRESS',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
        });
        agentId = created.id;
        await completeAgentRiskAssessment(owner(), agentId);

        connectionName = `A2A → Peer ${SUITE}`;
        const connection = await prisma.integrationConnection.create({
            data: { tenantId: TENANT, provider: 'a2a-peer', name: connectionName },
        });
        send = a2aSendToolName(connection.id);
        await prisma.registeredAgentTool.create({
            data: { tenantId: TENANT, agentId, toolName: send, grantedByUserId: USER },
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('a new card seeds the granted external tool when its ceilings reach it, and withholds nothing', async () => {
        const tier = (
            await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId }, select: { riskTier: true } })
        ).riskTier;
        // The external tool needs autonomy 2; the test is only meaningful for a
        // tier whose cap reaches it.
        expect(ceilingForRiskTier(tier)).toBeGreaterThanOrEqual(2);

        const result = await createAgentPolicyCard(owner(), agentId);
        expect(result.value.permittedTools).toEqual([send]);
        expect(result.withheld).toEqual([]);
    });

    it('the read names the granted external tool, labelled, to a caller who may edit the card, and to nobody else', async () => {
        const forOwner = await getAgentPolicyCard(owner(), agentId);
        expect('permittableExternalTools' in forOwner && forOwner.permittableExternalTools).toEqual([
            { name: send, label: `${connectionName}: a2a_send_task` },
        ]);

        const forReader = await getAgentPolicyCard(reader(), agentId);
        expect('permittableExternalTools' in forReader && forReader.permittableExternalTools).toBeNull();
    });

    it('an edit may drop the external tool and add it back, and may not add one the agent is not granted', async () => {
        const read = await getAgentPolicyCard(owner(), agentId);
        if (!read.card || !read.card.inForce) throw new Error('card expected');
        const v = read.card.inForce as unknown as CardValue & { version: number };
        const body = (version: number, permittedTools: string[]) => ({
            expectedVersion: version,
            card: {
                permittedTools,
                maxDataScope: v.maxDataScope,
                maxAutonomyLevel: v.maxAutonomyLevel,
                maxActionsPerRun: v.maxActionsPerRun,
                maxActionsPerDay: v.maxActionsPerDay,
                escalationTriggers: v.escalationTriggers,
                approvalRung: v.approvalRung,
            },
        });

        const dropped = await updateAgentPolicyCard(owner(), agentId, body(v.version, []));
        const restored = await updateAgentPolicyCard(owner(), agentId, body(dropped.version, [send]));
        expect(restored.value.permittedTools).toEqual([send]);

        const ungranted = 'mcp__someoneelse__a2a_send_task';
        const err = await updateAgentPolicyCard(owner(), agentId, body(restored.version, [send, ungranted])).catch(
            (e: Error) => e,
        );
        expect((err as Error).message).toMatch(/is not granted to this agent/);
    });
});
