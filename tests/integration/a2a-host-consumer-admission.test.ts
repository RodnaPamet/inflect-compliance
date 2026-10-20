/**
 * Admission for a host consumer — the principal SAP Joule arrives as (#3861).
 *
 * The assertions that matter are the pairs. A Joule-shaped request is admitted;
 * the SAME request presented as a PEER is still refused without a receipt. A
 * consumer is admitted; the same consumer revoked, killed, over quota, or in
 * another tenant is refused with its OWN named reason, because one generic
 * refusal would make these five indistinguishable in an audit row.
 */
import crypto from 'node:crypto';

import { PrismaClient } from '@prisma/client';

// `env` is validated once at import, so setting `process.env` in a hook comes
// too late. The repo's shape for this is a Proxy over the real module, which
// keeps every other variable genuine and lets these two move per test.
const envOverride: { flag: string | undefined; secret: string | undefined } = {
    flag: '1',
    secret: undefined,
};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        ...actual,
        env: new Proxy(actual.env as Record<string, unknown>, {
            get: (target, prop) => {
                if (prop === 'A2A_HOST_CONSUMERS') return envOverride.flag;
                if (prop === 'A2A_HOST_CONSUMER_TOKEN_SECRET') return envOverride.secret;
                return Reflect.get(target, prop);
            },
        }),
    };
});

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { buildSystemContext } from '@/app-layer/context-system';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import {
    generateHostConsumerCredentials,
    mintHostConsumerToken,
} from '@/lib/agentic/a2a/host-consumer';
import { tryAdmitHostConsumer } from '@/app-layer/usecases/a2a-host-consumer-admission';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'hc-tenant-one';
const T2 = 'hc-tenant-two';
const TENANTS = [T1, T2];
// Generated, not written down. A literal here is a "hardcoded password" to
// `detect-secrets.sh` — correctly, since it cannot tell a fixture from a
// credential — and an allowlist pragma would be the weaker fix: this way there
// is no secret-shaped string in the repo at all, and each run signs with its own.
const SECRET = crypto.randomBytes(24).toString('hex');

const world: Record<string, { consumerId: string; clientId: string; agentId: string; ownerUserId: string }> = {};

/**
 * The SYSTEM context, as `handleInboundA2a` builds for itself.
 *
 * Not `makeRequestContext`: a request context for a user with no membership in
 * the tenant reads NOTHING through `runInTenantContext` — measured, both the
 * settings row and the consumer came back null while a raw read saw them. The
 * inbound endpoint has no session behind it and builds a system context for
 * exactly this reason, so the test has to use the same one or it is testing a
 * context the production path never has.
 */
function ctxFor(tenantId: string) {
    return buildSystemContext({ tenantId, tenantSlug: tenantId, job: 'a2a-inbound-test' });
}

async function seed(tenantId: string, enabled: boolean): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const user = await prisma.user.create({
        data: { email: `owner@${tenantId}.test`, name: 'Owner', passwordHash: 'x' },
    });
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: 'sys' } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: 'receiver',
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
        },
    });
    await prisma.tenantSecuritySettings.create({
        data: { tenantId, a2aHostConsumersEnabled: enabled },
    });
    const creds = generateHostConsumerCredentials();
    const consumer = await prisma.hostConsumer.create({
        data: {
            tenantId,
            name: 'Joule',
            clientId: creds.clientId,
            clientSecretHash: creds.secretHash,
            clientSecretPrefix: creds.secretPrefix,
            receivingAgentId: agent.id,
            workflowKeys: ['sap-transaction-review'],
            ownerUserId: user.id,
            createdByUserId: user.id,
        },
    });
    world[tenantId] = {
        consumerId: consumer.id,
        clientId: creds.clientId,
        agentId: agent.id,
        ownerUserId: user.id,
    };
}

function tokenFor(tenantId: string, over: Partial<{ hostConsumerId: string; tenantId: string }> = {}) {
    const w = world[tenantId];
    const minted = mintHostConsumerToken(
        {
            tenantId: over.tenantId ?? tenantId,
            hostConsumerId: over.hostConsumerId ?? w.consumerId,
            receivingAgentId: w.agentId,
            workflowKeys: ['sap-transaction-review'],
        },
        { secret: SECRET },
    );
    if (!minted.ok) throw new Error('mint failed');
    return minted.token;
}

beforeAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await resetDatabase(prisma);
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    // `User` and `Tenant` deliberately SURVIVE a reset so fixtures can, so a
    // second run of this file collides on `User_emailHash_key` unless its own
    // users are cleared by hand. That is the #3801 class, and it bit this
    // fixture on its first re-run. Deleted by the lookup hash because the
    // column is hashed, not by the address.
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.map((t) => hashForLookup(`owner@${t}.test`)) } },
    });
    await seed(T1, true);
    await seed(T2, true);
});

afterAll(async () => {
    await prisma.$disconnect();
});

beforeEach(() => {
    envOverride.flag = '1';
    envOverride.secret = SECRET;
});

afterEach(async () => {
    await prisma.hostConsumerKillSwitch.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.hostConsumerMessage.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.hostConsumer.updateMany({
        where: { tenantId: { in: TENANTS } },
        data: { revokedAt: null, status: 'ACTIVE', inboundMessagesPerHour: 60 },
    });
    await prisma.tenantSecuritySettings.updateMany({
        where: { tenantId: { in: TENANTS } },
        data: { a2aHostConsumersEnabled: true },
    });
});

describe('a Joule-shaped request is admitted', () => {
    it('admits a bearer with NO receipt header and nothing Inflect-specific', async () => {
        const got = await tryAdmitHostConsumer(ctxFor(T1), {
            authorization: `Bearer ${tokenFor(T1)}`,
        });
        expect(got.kind).toBe('ADMITTED');
        if (got.kind !== 'ADMITTED') return;
        expect(got.consumer.id).toBe(world[T1].consumerId);
        expect(got.consumer.receivingAgentId).toBe(world[T1].agentId);
        // The accountable person a run will carry the authority of.
        expect(got.consumer.ownerUserId).toBe(world[T1].ownerUserId);
    });

    it('decides on the ROW, not on the token claims', async () => {
        // The token says one allowlist; the row is narrowed after it was
        // minted. The narrowing must take effect at once rather than at the
        // token's expiry — which is the reason the token is not trusted for
        // authorization.
        const token = tokenFor(T1);
        await prisma.hostConsumer.update({
            where: { id: world[T1].consumerId },
            data: { workflowKeys: [] },
        });
        const got = await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${token}` });
        expect(got.kind).toBe('ADMITTED');
        if (got.kind !== 'ADMITTED') return;
        expect(got.consumer.workflowKeys).toEqual([]);
        expect(got.claims.workflowKeys).toEqual(['sap-transaction-review']);
        await prisma.hostConsumer.update({
            where: { id: world[T1].consumerId },
            data: { workflowKeys: ['sap-transaction-review'] },
        });
    });
});

describe('a non-token bearer is left to the peer path', () => {
    it.each([
        ['a peer credential', 'iflp_deadbeefdeadbeefdeadbeef'],
        ['an api key', 'iflk_deadbeefdeadbeef'],
        ['empty', ''],
        ['two segments', 'aaa.bbb'],
    ])('%s is NOT_A_HOST_TOKEN', async (_label, bearer) => {
        const got = await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${bearer}` });
        expect(got.kind).toBe('NOT_A_HOST_TOKEN');
    });

    it('is NOT_A_HOST_TOKEN with no header at all', async () => {
        expect((await tryAdmitHostConsumer(ctxFor(T1), { authorization: null })).kind).toBe('NOT_A_HOST_TOKEN');
        expect((await tryAdmitHostConsumer(ctxFor(T1), { authorization: undefined })).kind).toBe('NOT_A_HOST_TOKEN');
    });

    it('leaves a peer credential alone even with NO token secret configured', async () => {
        // The reason `looksLikeAToken` exists. Without it, a deployment with
        // the flag on and no secret would answer TOKEN_SECRET_NOT_CONFIGURED
        // to every bearer and break peer traffic that has nothing to do with
        // host consumers.
        envOverride.secret = undefined;
        const got = await tryAdmitHostConsumer(ctxFor(T1), {
            authorization: 'Bearer iflp_deadbeefdeadbeefdeadbeef',
        });
        expect(got.kind).toBe('NOT_A_HOST_TOKEN');
    });
});

describe('each refusal is its own named reason', () => {
    it('refuses an unknown consumer', async () => {
        const got = await tryAdmitHostConsumer(ctxFor(T1), {
            authorization: `Bearer ${tokenFor(T1, { hostConsumerId: 'no-such-consumer' })}`,
        });
        expect(got).toMatchObject({ kind: 'REFUSED', reason: 'UNKNOWN_HOST_CONSUMER' });
    });

    it('refuses an expired token', async () => {
        const token = tokenFor(T1);
        const got = await tryAdmitHostConsumer(ctxFor(T1), {
            authorization: `Bearer ${token}`,
            now: new Date(Date.now() + 60 * 60 * 1000),
        });
        expect(got).toMatchObject({ kind: 'REFUSED', reason: 'TOKEN_EXPIRED' });
    });

    it('refuses a revoked consumer', async () => {
        const token = tokenFor(T1);
        await prisma.hostConsumer.update({
            where: { id: world[T1].consumerId },
            data: { revokedAt: new Date() },
        });
        const got = await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${token}` });
        expect(got).toMatchObject({ kind: 'REFUSED', reason: 'HOST_CONSUMER_REVOKED' });
    });

    it('refuses a killed consumer, and admits again once lifted', async () => {
        const token = tokenFor(T1);
        const kill = await prisma.hostConsumerKillSwitch.create({
            data: {
                tenantId: T1,
                hostConsumerId: world[T1].consumerId,
                reason: 'incident 42',
                engagedByUserId: 'someone',
            },
        });
        expect(await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${token}` })).toMatchObject({
            kind: 'REFUSED',
            reason: 'HOST_CONSUMER_KILLED',
        });
        // The SAME token works again after the kill is lifted — which is the
        // evidence that the kill is read per request rather than at mint.
        await prisma.hostConsumerKillSwitch.update({
            where: { id: kill.id },
            data: { liftedAt: new Date(), liftedByUserId: 'someone', liftReason: 'resolved' },
        });
        expect((await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${token}` })).kind).toBe('ADMITTED');
    });

    it('refuses over quota, counting only the last hour', async () => {
        await prisma.hostConsumer.update({
            where: { id: world[T1].consumerId },
            data: { inboundMessagesPerHour: 2 },
        });
        const mk = (createdAt: Date, n: string) =>
            prisma.hostConsumerMessage.create({
                data: {
                    tenantId: T1,
                    hostConsumerId: world[T1].consumerId,
                    clientId: world[T1].clientId,
                    tokenJti: n,
                    body: 'v1:x',
                    bodyDigest: 'a'.repeat(64),
                },
            });
        await mk(new Date(), 'j1');
        expect((await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${tokenFor(T1)}` })).kind).toBe(
            'ADMITTED',
        );
        await mk(new Date(), 'j2');
        expect(await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${tokenFor(T1)}` })).toMatchObject({
            kind: 'REFUSED',
            reason: 'HOST_CONSUMER_QUOTA',
        });
    });

    it('refuses when the tenant has not enabled host consumers', async () => {
        const token = tokenFor(T1);
        await prisma.tenantSecuritySettings.update({
            where: { tenantId: T1 },
            data: { a2aHostConsumersEnabled: false },
        });
        expect(await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${token}` })).toMatchObject({
            kind: 'REFUSED',
            reason: 'HOST_CONSUMERS_DISABLED',
        });
    });
});

describe('two tenants', () => {
    it("admits nothing in another tenant with tenant one's token", async () => {
        const token = tokenFor(T1);
        const got = await tryAdmitHostConsumer(ctxFor(T2), { authorization: `Bearer ${token}` });
        expect(got).toMatchObject({ kind: 'REFUSED', reason: 'UNKNOWN_HOST_CONSUMER' });
    });

    it("refuses a token naming tenant two's id but tenant one's consumer", async () => {
        const forged = tokenFor(T1, { tenantId: T2 });
        expect(await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${forged}` })).toMatchObject({
            kind: 'REFUSED',
            reason: 'UNKNOWN_HOST_CONSUMER',
        });
    });
});
