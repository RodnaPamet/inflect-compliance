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
import { makeRequestContext } from '../helpers/make-context';
import {
    createHostConsumer,
    listHostConsumers,
    revokeHostConsumer,
    rotateHostConsumerSecret,
} from '@/app-layer/usecases/a2a-host-consumers';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import {
    generateHostConsumerCredentials,
    mintHostConsumerToken,
} from '@/lib/agentic/a2a/host-consumer';
import { tryAdmitHostConsumer } from '@/app-layer/usecases/a2a-host-consumer-admission';
import { issueHostConsumerToken } from '@/app-layer/usecases/a2a-host-consumer-token';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'hc-tenant-one';
const T2 = 'hc-tenant-two';
const TENANTS = [T1, T2];
// Generated, not written down. A literal here is a "hardcoded password" to
// `detect-secrets.sh` — correctly, since it cannot tell a fixture from a
// credential — and an allowlist pragma would be the weaker fix: this way there
// is no secret-shaped string in the repo at all, and each run signs with its own.
const SECRET = crypto.randomBytes(24).toString('hex');

const world: Record<
    string,
    { consumerId: string; clientId: string; clientSecret: string; agentId: string; ownerUserId: string }
> = {};

/**
 * The SYSTEM context, as `handleInboundA2a` builds for itself — the inbound
 * endpoint has no session behind it, so a test using anything else would be
 * exercising a context production never has.
 *
 * A correction worth keeping, because I recorded the wrong reason for this
 * once: an earlier version of this helper called
 * `makeRequestContext({ tenantId, ... })` and read NOTHING through
 * `runInTenantContext`, and I attributed that to the user having no
 * membership. It was not. `makeRequestContext(role, overrides)` takes TWO
 * POSITIONAL arguments, so passing one object made the object the `role` and
 * left `tenantId` at its default `'tenant-1'` — the reads were scoped to a
 * tenant that does not exist here. Mis-calling a helper looks exactly like an
 * RLS refusal from the outside, and the only tell was that a raw read saw the
 * rows.
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
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
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
        clientSecret: creds.secretPlaintext,
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

describe('the token endpoint (#3861)', () => {
    const exchange = (tenantId: string, over: Partial<{ grantType: string; clientId: string; clientSecret: string }> = {}) =>
        issueHostConsumerToken({
            tenantSlug: tenantId,
            grantType: over.grantType ?? 'client_credentials',
            clientId: over.clientId ?? world[tenantId].clientId,
            clientSecret: over.clientSecret ?? world[tenantId].clientSecret,
        });

    it('ROUND TRIP: a token it issues is one admission accepts', async () => {
        // The assertion that makes the two halves one feature. Either side can
        // be green alone while the pair is broken — a mint the verify refuses.
        const issued = await exchange(T1);
        expect(issued.ok).toBe(true);
        if (!issued.ok) return;
        expect(issued.tokenType).toBe('Bearer');
        expect(issued.expiresIn).toBe(900);

        const admitted = await tryAdmitHostConsumer(ctxFor(T1), {
            authorization: `Bearer ${issued.accessToken}`,
        });
        expect(admitted.kind).toBe('ADMITTED');
        if (admitted.kind !== 'ADMITTED') return;
        expect(admitted.consumer.id).toBe(world[T1].consumerId);
    });

    it('refuses an unknown client and a wrong secret with DIFFERENT audit reasons', async () => {
        // Indistinguishable to the caller by design — both are `invalid_client`
        // at the route — but the usecase names which, so an audit row can.
        expect(await exchange(T1, { clientId: 'ifhc_nosuchclient' })).toMatchObject({
            ok: false,
            reason: 'UNKNOWN_CLIENT',
        });
        // Generated, not written: a literal reads as a hardcoded credential to
        // `detect-secrets.sh`, and a random wrong secret is the better test
        // anyway — it cannot accidentally be the right one.
        expect(await exchange(T1, { clientSecret: crypto.randomBytes(24).toString('hex') })).toMatchObject({
            ok: false,
            reason: 'BAD_CLIENT_SECRET',
        });
    });

    it('names an unsupported grant rather than blaming the client', async () => {
        // A destination misconfigured for `password` should learn that, not be
        // told its credentials are bad.
        expect(await exchange(T1, { grantType: 'password' })).toMatchObject({
            ok: false,
            reason: 'UNSUPPORTED_GRANT_TYPE',
        });
        expect(await exchange(T1, { grantType: '' })).toMatchObject({
            ok: false,
            reason: 'UNSUPPORTED_GRANT_TYPE',
        });
    });

    it('refuses missing credentials without reaching the database', async () => {
        expect(await exchange(T1, { clientId: '' })).toMatchObject({
            ok: false,
            reason: 'MISSING_CLIENT_CREDENTIALS',
        });
        expect(await exchange(T1, { clientSecret: '' })).toMatchObject({
            ok: false,
            reason: 'MISSING_CLIENT_CREDENTIALS',
        });
    });

    it('will not issue a token to a KILLED consumer', async () => {
        // The window property: admission already refuses a killed consumer, so
        // this stops a kill from leaving fifteen minutes in which fresh tokens
        // are still being minted for a principal someone has stopped.
        await prisma.hostConsumerKillSwitch.create({
            data: {
                tenantId: T1,
                hostConsumerId: world[T1].consumerId,
                reason: 'incident 7',
                engagedByUserId: 'someone',
            },
        });
        expect(await exchange(T1)).toMatchObject({ ok: false, reason: 'HOST_CONSUMER_KILLED' });
    });

    it('will not issue a token to a revoked consumer', async () => {
        await prisma.hostConsumer.update({
            where: { id: world[T1].consumerId },
            data: { revokedAt: new Date() },
        });
        expect(await exchange(T1)).toMatchObject({ ok: false, reason: 'HOST_CONSUMER_REVOKED' });
    });

    it('will not issue a token when the tenant has not enabled host consumers', async () => {
        await prisma.tenantSecuritySettings.update({
            where: { tenantId: T1 },
            data: { a2aHostConsumersEnabled: false },
        });
        expect(await exchange(T1)).toMatchObject({ ok: false, reason: 'HOST_CONSUMERS_DISABLED' });
    });

    it('fails closed with no signing secret', async () => {
        envOverride.secret = undefined;
        expect(await exchange(T1)).toMatchObject({ ok: false, reason: 'TOKEN_SECRET_NOT_CONFIGURED' });
    });

    it('refuses an unknown tenant', async () => {
        expect(
            await issueHostConsumerToken({
                tenantSlug: 'no-such-tenant-at-all',
                grantType: 'client_credentials',
                clientId: 'ifhc_x',
                clientSecret: 'y',
            }),
        ).toMatchObject({ ok: false, reason: 'UNKNOWN_TENANT' });
    });

    it("will not mint tenant one's consumer a token from tenant two's slug", async () => {
        expect(await exchange(T2, { clientId: world[T1].clientId, clientSecret: world[T1].clientSecret })).toMatchObject({
            ok: false,
            reason: 'UNKNOWN_CLIENT',
        });
    });
});

describe('managing a host consumer (#3861)', () => {
    const WF = 'host-consumer-management-test-wf';

    /** A person with the register key — what the usecases require. */
    const adminCtx = (tenantId: string) =>
        makeRequestContext('OWNER', { tenantId, userId: world[tenantId].ownerUserId });

    beforeAll(() => {
        registerWorkflow({
            key: WF,
            name: 'Host consumer management test',
            description: 'A workflow a host consumer may be allowed to name.',
            steps: [],
        });
    });

    const create = (tenantId: string, over: Record<string, unknown> = {}) =>
        createHostConsumer(adminCtx(tenantId), {
            name: 'Acme Joule',
            ownerUserId: world[tenantId].ownerUserId,
            receivingAgentId: world[tenantId].agentId,
            workflowKeys: [WF],
            ...over,
        });

    it('hands back the secret ONCE and stores only its hash', async () => {
        const made = await create(T1);
        expect(made.clientSecret).toMatch(/^[0-9a-f]{48}$/);
        expect(made.consumer.clientId.startsWith('ifhc_')).toBe(true);

        const row = await prisma.hostConsumer.findUniqueOrThrow({
            where: { id: made.consumer.id },
            select: { clientSecretHash: true, clientSecretPrefix: true },
        });
        // The row holds a hash, not the secret — and the listing never carries
        // either, only the displayed prefix.
        expect(row.clientSecretHash).not.toBe(made.clientSecret);
        expect(row.clientSecretHash).toMatch(/^[0-9a-f]{64}$/);
        expect(made.consumer.clientSecretPrefix).toBe(row.clientSecretPrefix);
        const listed = await listHostConsumers(adminCtx(T1));
        expect(JSON.stringify(listed)).not.toContain(made.clientSecret);
        expect(JSON.stringify(listed)).not.toContain(row.clientSecretHash);
        await prisma.hostConsumer.delete({ where: { id: made.consumer.id } });
    });

    it('refuses without the register key, and refuses an API key outright', async () => {
        await expect(
            createHostConsumer(
                makeRequestContext('READER', { tenantId: T1, userId: world[T1].ownerUserId }),
                { name: 'x', ownerUserId: world[T1].ownerUserId, receivingAgentId: world[T1].agentId, workflowKeys: [WF] },
            ),
        ).rejects.toThrow(/admin.agent_registry/);

        // A credential that admits an external system is issued by a person who
        // can be named in the audit row, never by a token that cannot.
        await expect(
            createHostConsumer(
                makeRequestContext('OWNER', {
                    tenantId: T1,
                    userId: world[T1].ownerUserId,
                    apiKeyId: 'key-1',
                }),
                { name: 'x', ownerUserId: world[T1].ownerUserId, receivingAgentId: world[T1].agentId, workflowKeys: [WF] },
            ),
        ).rejects.toThrow(/not by an API key/);
    });

    it('refuses an unknown workflow, an unknown agent and a non-member owner', async () => {
        await expect(create(T1, { workflowKeys: ['no-such-workflow-at-all'] })).rejects.toThrow(/Unknown workflow/);
        await expect(create(T1, { receivingAgentId: 'no-such-agent' })).rejects.toThrow(/does not exist in this tenant/);
        // The owner matters because the RUN carries their authority.
        await expect(create(T1, { ownerUserId: world[T2].ownerUserId })).rejects.toThrow(/active member/);
    });

    it('refuses an empty allowlist — deny by default', async () => {
        await expect(create(T1, { workflowKeys: [] })).rejects.toThrow();
    });

    it('ROTATE keeps the client id and kills the old secret at the token endpoint', async () => {
        const made = await create(T1);
        const rotated = await rotateHostConsumerSecret(adminCtx(T1), made.consumer.id);
        // Same id, so a BTP destination changes a secret rather than being rewritten.
        expect(rotated.consumer.clientId).toBe(made.consumer.clientId);
        expect(rotated.clientSecret).not.toBe(made.clientSecret);

        const withOld = await issueHostConsumerToken({
            tenantSlug: T1,
            grantType: 'client_credentials',
            clientId: made.consumer.clientId,
            clientSecret: made.clientSecret,
        });
        expect(withOld).toMatchObject({ ok: false, reason: 'BAD_CLIENT_SECRET' });

        const withNew = await issueHostConsumerToken({
            tenantSlug: T1,
            grantType: 'client_credentials',
            clientId: rotated.consumer.clientId,
            clientSecret: rotated.clientSecret,
        });
        expect(withNew.ok).toBe(true);
        await prisma.hostConsumer.delete({ where: { id: made.consumer.id } });
    });

    it('REVOKE stops new tokens AND a token already issued', async () => {
        const made = await create(T1);
        const issued = await issueHostConsumerToken({
            tenantSlug: T1,
            grantType: 'client_credentials',
            clientId: made.consumer.clientId,
            clientSecret: made.clientSecret,
        });
        if (!issued.ok) throw new Error('expected a token');

        await revokeHostConsumer(adminCtx(T1), made.consumer.id);

        // No new tokens…
        expect(
            await issueHostConsumerToken({
                tenantSlug: T1,
                grantType: 'client_credentials',
                clientId: made.consumer.clientId,
                clientSecret: made.clientSecret,
            }),
        ).toMatchObject({ ok: false, reason: 'HOST_CONSUMER_REVOKED' });

        // …and the one already in the wild stops at the next request, which is
        // the whole argument for a stateless token (R26).
        expect(
            await tryAdmitHostConsumer(ctxFor(T1), { authorization: `Bearer ${issued.accessToken}` }),
        ).toMatchObject({ kind: 'REFUSED', reason: 'HOST_CONSUMER_REVOKED' });

        await expect(revokeHostConsumer(adminCtx(T1), made.consumer.id)).rejects.toThrow(/already revoked/);
        await expect(rotateHostConsumerSecret(adminCtx(T1), made.consumer.id)).rejects.toThrow(/cannot be rotated/);
        await prisma.hostConsumer.delete({ where: { id: made.consumer.id } });
    });

    it("cannot manage another tenant's consumer", async () => {
        await expect(rotateHostConsumerSecret(adminCtx(T2), world[T1].consumerId)).rejects.toThrow(/not found/);
        await expect(revokeHostConsumer(adminCtx(T2), world[T1].consumerId)).rejects.toThrow(/not found/);
    });
});
