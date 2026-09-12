/**
 * RETIRE'S PRECONDITION (#2448) — refused while proposals await review, and the
 * refusal names the count.
 *
 * Retirement is the only PERMANENT decommission in the register, which is why it
 * is on DELETE rather than a value in the status dropdown: `AGENT_LIFECYCLE_MOVES`
 * deliberately excludes RETIRED because a precondition cannot be expressed as one
 * option among three.
 *
 * ── WHY THE COUNT IS PART OF THE CONTRACT ───────────────────────────
 *
 * The screen states the precondition BEFORE the operator commits, reading the
 * same PENDING count from the detail endpoint. That makes the count a contract
 * between two places rather than an implementation detail of one: if the usecase
 * ever widened the statuses it refuses on, a detail read still counting only
 * PENDING would promise a retirement the server declines. The last test pins
 * them to each other.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    getRegisteredAgent,
    retireRegisteredAgent,
    suspendRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const TENANT = 'retire-tenant';
const EMAIL = 'retire-owner@example.test';

let ownerId = '';
let systemSeq = 0;

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerId });

async function clearProbeRows() {
    await resetDatabase(prisma);
    await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
}

/** One AI system per agent — `RegisteredAgent_aiSystemId_key` is UNIQUE. */
async function makeAgent() {
    const sys = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `retire host ${(systemSeq += 1)}`, ownerUserId: ownerId },
    });
    return prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: sys.id,
            name: 'retire probe',
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: ownerId,
            status: 'ACTIVE',
        },
    });
}

const proposal = (agentId: string, status: 'PENDING' | 'ACCEPTED') =>
    prisma.agentProposal.create({
        data: { tenantId: TENANT, agentId, kind: 'RISK', payloadJson: '{}', status },
    });

beforeAll(async () => {
    await clearProbeRows();
    await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
    const u = await prisma.user.create({ data: { email: EMAIL, name: 'Retire Owner' } });
    ownerId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: ownerId, role: 'ADMIN', status: 'ACTIVE' },
    });
});

afterAll(clearProbeRows);

describe('retirement is refused while proposals await review', () => {
    it('refuses, and the message NAMES the count', async () => {
        const agent = await makeAgent();
        await proposal(agent.id, 'PENDING');
        await proposal(agent.id, 'PENDING');

        // The number matters: it is what lets the screen render the
        // precondition rather than a generic failure.
        await expect(retireRegisteredAgent(ctx(), agent.id)).rejects.toThrow(/2 proposal/);
        expect((await getRegisteredAgent(ctx(), agent.id)).status).toBe('ACTIVE');
    });

    it('SUSPENSION is not refused — the alternative the message offers works', async () => {
        // The refusal tells the operator to suspend instead. If suspension
        // carried the same precondition, that advice would be a dead end, and
        // an operator following it during an incident would be stopped twice.
        const agent = await makeAgent();
        await proposal(agent.id, 'PENDING');

        await suspendRegisteredAgent(ctx(), agent.id);
        expect((await getRegisteredAgent(ctx(), agent.id)).status).toBe('SUSPENDED');
    });

    it('a RESOLVED proposal does not block it', async () => {
        // The paired positive. A usecase counting every proposal regardless of
        // status would pass the refusal above and never permit retirement at
        // all — which reads identically from the failing side.
        const agent = await makeAgent();
        await proposal(agent.id, 'ACCEPTED');

        await retireRegisteredAgent(ctx(), agent.id);
        expect((await getRegisteredAgent(ctx(), agent.id)).status).toBe('RETIRED');
    });
});

describe('the screen can state the precondition before the click', () => {
    it('the detail read counts exactly what the usecase refuses on', async () => {
        // The contract between the pre-check and the refusal. Two PENDING and
        // one APPROVED: a read counting all three would over-report and block a
        // retirement the server would allow; one counting none would promise a
        // retirement the server declines.
        const agent = await makeAgent();
        await proposal(agent.id, 'PENDING');
        await proposal(agent.id, 'PENDING');
        await proposal(agent.id, 'ACCEPTED');

        const detail = await getRegisteredAgent(ctx(), agent.id);
        expect(detail._count.proposals).toBe(2);
        await expect(retireRegisteredAgent(ctx(), agent.id)).rejects.toThrow(/2 proposal/);
    });
});
