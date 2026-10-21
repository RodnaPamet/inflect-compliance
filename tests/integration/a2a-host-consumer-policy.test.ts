/**
 * THE POLICY LINE, against the real grant tables (#3864).
 *
 * The A2A route's whole policy argument (#3860) is that Inflect calls no SAP
 * API, and on this platform that is a property of what the receiving agent is
 * GRANTED. So this suite grants things and checks what the guard says.
 *
 * The assertions that carry weight are the pair:
 *
 *  - granting an EXTERNAL tool to a host consumer's receiving agent IS a
 *    violation — the mutation proof, without which a guard returning `[]`
 *    unconditionally would satisfy every other test here;
 *  - granting an INTERNAL tool to the same agent is NOT. A guard that flagged
 *    every grant would pass the first assertion and be useless, and it would
 *    refuse every correctly-configured tenant.
 *
 * And the scoping one: a REVOKED consumer's agent is out of scope, because a
 * revoked consumer receives no traffic and holding its grants against the
 * tenant would be a false alarm about a principal that cannot call.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { buildSystemContext } from '@/app-layer/context-system';
import { generateHostConsumerCredentials } from '@/lib/agentic/a2a/host-consumer';
import { EXTERNAL_TOOL_PREFIX, externalToolName } from '@/lib/mcp/external-tool-name';
import {
    agentHoldsExternalToolGrant,
    findHostConsumerExternalGrants,
} from '@/app-layer/usecases/a2a-host-consumer-policy';

const prisma: PrismaClient = prismaTestClient();

const T = 'hcpol1';
const TENANTS = [T];
const CONNECTION_ID = 'cmconn000000000000000001';

const world: { agentId: string; otherAgentId: string; userId: string; consumerId: string; revokedConsumerId: string } = {
    agentId: '',
    otherAgentId: '',
    userId: '',
    consumerId: '',
    revokedConsumerId: '',
};

const ctx = () => buildSystemContext({ tenantId: T, tenantSlug: T, job: 'a2a-policy-test' });

/**
 * One AiSystem PER AGENT: `RegisteredAgent_aiSystemId_key` is unique, so a
 * second agent on the same system fails the insert. Found the hard way.
 */
async function makeAgent(name: string, ownerUserId: string): Promise<string> {
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `sys-${name}` } });
    const a = await prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        },
    });
    return a.id;
}

async function makeConsumer(receivingAgentId: string, revoked: boolean): Promise<string> {
    const creds = generateHostConsumerCredentials();
    const c = await prisma.hostConsumer.create({
        data: {
            tenantId: T,
            name: revoked ? 'Joule (revoked)' : 'Joule',
            clientId: creds.clientId,
            clientSecretHash: creds.secretHash,
            clientSecretPrefix: creds.secretPrefix,
            receivingAgentId,
            workflowKeys: ['sap-transaction-review'],
            ownerUserId: world.userId,
            createdByUserId: world.userId,
            // There is no REVOKED status — the enum is ACTIVE | SUSPENDED | RETIRED and
            // revocation is `revokedAt`, which is why the guard filters on BOTH.
            ...(revoked ? { status: 'RETIRED' as const, revokedAt: new Date(), revokedByUserId: world.userId } : {}),
        },
    });
    return c.id;
}

beforeAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await resetDatabase(prisma);
    await prisma.user.deleteMany({ where: { email: `owner@${T}.test` } });
    await prisma.tenant.deleteMany({ where: { id: T } });

    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const user = await prisma.user.create({
        data: { email: `owner@${T}.test`, name: 'Owner', passwordHash: 'x' },
    });
    world.userId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: T, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
    });
    world.agentId = await makeAgent('receiver', user.id);
    world.otherAgentId = await makeAgent('unrelated', user.id);
    world.consumerId = await makeConsumer(world.agentId, false);
}, 120_000);

afterAll(async () => {
    await prisma.$disconnect();
});

afterEach(async () => {
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: T } });
    await prisma.hostConsumer.deleteMany({ where: { tenantId: T, id: { not: world.consumerId } } });
});

async function grant(agentId: string, toolName: string): Promise<void> {
    await prisma.registeredAgentTool.create({
        data: { tenantId: T, agentId, toolName, grantedByUserId: world.userId },
    });
}

describe('the policy line holds, and the guard can tell', () => {
    it('is clean when the receiving agent holds nothing', async () => {
        expect(await findHostConsumerExternalGrants(ctx())).toEqual([]);
        expect(await agentHoldsExternalToolGrant(ctx(), world.agentId)).toBe(false);
    });

    it('is clean when the receiving agent holds only INFLECT read tools', async () => {
        // The discriminating control. A guard that flagged any grant would pass
        // the violation test below and refuse every correct tenant.
        await grant(world.agentId, 'list_controls');
        await grant(world.agentId, 'list_risks');
        expect(await findHostConsumerExternalGrants(ctx())).toEqual([]);
        expect(await agentHoldsExternalToolGrant(ctx(), world.agentId)).toBe(false);
    });

    it('FAILS when an external tool is granted to the receiving agent', async () => {
        // The mutation proof, at the call site the policy is about.
        const ext = externalToolName(CONNECTION_ID, 'sap_read_document');
        await grant(world.agentId, ext);

        const violations = await findHostConsumerExternalGrants(ctx());
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({
            hostConsumerId: world.consumerId,
            receivingAgentId: world.agentId,
            toolName: ext,
            connectionId: CONNECTION_ID,
        });
        expect(await agentHoldsExternalToolGrant(ctx(), world.agentId)).toBe(true);
    });

    it('fails for ANY external tool, not only SAP-looking ones — there is no allowlist', async () => {
        // The reason the guard reads the name SHAPE rather than a provider
        // list: a connection to a system nobody has heard of still produces a
        // grant that reads as external.
        await grant(world.agentId, externalToolName(CONNECTION_ID, 'some_unheard_of_tool'));
        expect(await findHostConsumerExternalGrants(ctx())).toHaveLength(1);
    });

    it('ignores an external grant held by an agent NO host consumer receives on', async () => {
        await grant(world.otherAgentId, externalToolName(CONNECTION_ID, 'sap_read_document'));
        expect(await findHostConsumerExternalGrants(ctx())).toEqual([]);
    });

    it('ignores a REVOKED consumer’s receiving agent', async () => {
        const deadAgent = await makeAgent('revoked-receiver', world.userId);
        await makeConsumer(deadAgent, true);
        await grant(deadAgent, externalToolName(CONNECTION_ID, 'sap_read_document'));
        // A revoked consumer receives nothing, so this is not a live violation.
        expect(await findHostConsumerExternalGrants(ctx())).toEqual([]);
    });

    it('counts a malformed external name as a violation rather than as "not external"', async () => {
        // The prefix is `mcp__`, and `mcp__broken` carries no separator so it
        // parses to null. Treating that as "not external after all" would make
        // a corrupt row the way through. (My first draft of this case used
        // `ext__broken`, which is not external at all — the test passed
        // nothing and reported zero violations, correctly.)
        await prisma.registeredAgentTool.create({
            data: {
                tenantId: T,
                agentId: world.agentId,
                toolName: `${EXTERNAL_TOOL_PREFIX}broken`,
                grantedByUserId: world.userId,
            },
        });
        const violations = await findHostConsumerExternalGrants(ctx());
        expect(violations).toHaveLength(1);
        expect(violations[0].connectionId).toBeNull();
    });

    it('the per-request form agrees with the broad audit on the same data', async () => {
        // A narrow fast path that disagreed with the audit would be worse than
        // either alone, so the two are checked against each other.
        await grant(world.agentId, externalToolName(CONNECTION_ID, 'sap_read_document'));
        const broad = await findHostConsumerExternalGrants(ctx());
        const narrow = await agentHoldsExternalToolGrant(ctx(), world.agentId);
        expect(narrow).toBe(broad.length > 0);

        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: T } });
        const broadAfter = await findHostConsumerExternalGrants(ctx());
        const narrowAfter = await agentHoldsExternalToolGrant(ctx(), world.agentId);
        expect(narrowAfter).toBe(broadAfter.length > 0);
    });
});
