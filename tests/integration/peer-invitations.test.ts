/**
 * A2A PEER INVITATIONS through the real usecases and the real database (#3752;
 * owner decisions 2026-11-11). Two workspaces, A and B, on one deployment.
 *
 *   1. THE FLOW. A invites; B reads A's card and accepts in one act, which
 *      pins A, exchanges tokens with A and stores B's outbound connection; A
 *      holds B registered UNPINNED with its own outbound connection, and one
 *      approval by a person in A admits B. Both connections start DISABLED.
 *   2. SINGLE USE. A code works once; an expired or revoked one does not; a
 *      failed acceptance leaves nothing issued on the accepting side.
 *   3. THE ACCEPTANCE ITSELF. Signed by the key the acceptor's own card names,
 *      fresh, and acted on as the inviting person as they stand now.
 *   4. WHO MAY. A person with the register key and the admin tier; never an
 *      API key; a workflow that needs inputs is never offered.
 *   5. ISOLATION. Under `app_user` a workspace sees only its own invitations,
 *      and cannot delete one.
 *
 * The network is the seam: both cards are served by the real card usecase,
 * and B's acceptance POST is handed straight to A's machine handler.
 */
let mockA2aOrigin: string | null = 'https://inflect.test';
jest.mock('@/lib/agentic/a2a/origin', () => ({ inflectA2aOrigin: () => mockA2aOrigin }));

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { inflectA2aIdentity } from '@/lib/agentic/a2a/own-card';
import {
    PEER_INVITATION_ACCEPT_VERSION,
    hashPeerInvitationCode,
    mintPeerInvitationCode,
    signPeerInvitationAcceptance,
} from '@/lib/agentic/a2a/invitation';
import { getTenantA2aAgentCard } from '@/app-layer/usecases/a2a-agent-card';
import { resolveTenantA2aSigningKey, rotateTenantA2aSigningKey } from '@/app-layer/usecases/a2a-signing-key';
import { approvePeerAgentCard, checkPeerAdmission, readPeerAgentCard } from '@/app-layer/usecases/peer-agents';
import { revokePeerInboundCredential } from '@/app-layer/usecases/a2a-peer-credentials';
import {
    acceptPeerInvitation,
    acceptPeerInvitationAtInviter,
    createPeerInvitation,
    listPeerInvitations,
    previewPeerInvitation,
    revokePeerInvitation,
} from '@/app-layer/usecases/peer-invitations';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const ORIGIN = 'https://inflect.test';
const A = 'peer-invite-a';
const B = 'peer-invite-b';
const C = 'peer-invite-c';
const TENANTS = [A, B, C];
const NEEDS_INPUT_WF = 'peer-invite-needs-input';

interface World {
    ownerUserId: string;
    vendorId: string;
    agentId: string;
}
const world: Record<string, World> = {};

const ownerCtx = (t: string, extra: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext('OWNER', { tenantId: t, tenantSlug: t, userId: world[t].ownerUserId, ...extra });

/** Serve every tenant's real, signed card at its identity; anything else is a 404. */
const fetchImpl = jest.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const t of TENANTS) {
        if (url === inflectA2aIdentity(ORIGIN, t)) {
            const card = await getTenantA2aAgentCard({ tenantSlug: t, requestId: 'test' });
            return card ? new Response(JSON.stringify(card), { status: 200 }) : new Response('', { status: 404 });
        }
    }
    return new Response('', { status: 404 });
}) as unknown as typeof fetch;

/** B's acceptance POST, handed to the inviting tenant's own machine handler. */
let lastInviterOutcome: Awaited<ReturnType<typeof acceptPeerInvitationAtInviter>> | null = null;
const postImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/a2a\/([^/]+)\/invitations$/.exec(url.pathname);
    if (url.origin !== ORIGIN || !m) return new Response('', { status: 404 });
    const headers = new Headers(init?.headers);
    lastInviterOutcome = await acceptPeerInvitationAtInviter(
        {
            tenantSlug: m[1],
            body: String(init?.body ?? ''),
            signature: headers.get('x-inflect-invitation-signature'),
            requestId: 'test-accept',
        },
        { fetchImpl },
    );
    return lastInviterOutcome.ok
        ? new Response(lastInviterOutcome.answer, { status: 200 })
        : new Response(JSON.stringify({ error: 'refused' }), { status: lastInviterOutcome.status });
}) as unknown as typeof fetch;

const seam = { fetchImpl, postImpl };

async function clearAll(): Promise<void> {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        const tables = await tx.$queryRawUnsafe<{ table_name: string }[]>(
            `SELECT table_name FROM information_schema.columns
              WHERE table_schema = 'public' AND column_name = 'tenantId'`,
        );
        for (const { table_name } of tables) {
            await tx.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
        }
        await tx.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: TENANTS.map((t) => hashForLookup(`owner@${t}.test`)) } } });
}

async function seed(t: string): Promise<void> {
    await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    const email = `owner@${t}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId: t, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
    const vendor = await prisma.vendor.create({ data: { tenantId: t, name: `Partner of ${t}` } });
    const sys = await prisma.aiSystem.create({ data: { tenantId: t, name: `A2A host ${t}`, ownerUserId: user.id } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: t,
            aiSystemId: sys.id,
            name: `A2A receiver ${t}`,
            autonomyLevel: 2,
            dataAccessScope: 'EXTERNAL_EGRESS',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    world[t] = { ownerUserId: user.id, vendorId: vendor.id, agentId: agent.id };
    await rotateTenantA2aSigningKey(ownerCtx(t));
}

const grant = (t: string) => ({
    ownerUserId: world[t].ownerUserId,
    vendorId: world[t].vendorId,
    riskTier: 'MODERATE' as const,
    receivingAgentId: world[t].agentId,
    workflowKeys: ['diagnostic'],
});

async function invite(from: string): Promise<string> {
    return (await createPeerInvitation(ownerCtx(from), grant(from))).code;
}

async function accept(by: string, code: string) {
    const preview = await previewPeerInvitation(ownerCtx(by), { invitation: code }, seam);
    return acceptPeerInvitation(
        ownerCtx(by),
        { invitation: code, reviewedCardHash: preview.cardHash, name: `Peer from ${by}`, ...grant(by) },
        seam,
    );
}

async function asTenant<T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    registerWorkflow({
        key: NEEDS_INPUT_WF,
        name: 'Needs an input a peer cannot send',
        description: 'invitation test',
        requiredInput: ['riskId'],
        steps: [{ kind: 'READ', label: 'posture', tool: 'get_compliance_posture' }],
    });
    await clearAll();
    for (const t of TENANTS) await seed(t);
});

afterAll(async () => {
    await clearAll();
    await prisma.$disconnect();
});

describe('1. invite in A, accept in B, approve in A', () => {
    it('connects both workspaces with three acts, and nothing flows to A until a person in A approves', async () => {
        const code = await invite(A);
        expect(code.startsWith(`${inflectA2aIdentity(ORIGIN, A)}#iflinv_`)).toBe(true);
        // Stored as a hash only.
        const stored = await prisma.peerInvitation.findFirstOrThrow({ where: { tenantId: A } });
        expect(stored.status).toBe('PENDING');
        expect(stored.codeHash).toBe(hashPeerInvitationCode(code.split('#')[1]));
        expect(JSON.stringify(stored)).not.toContain(code.split('#')[1]);

        // B reads A's card, then accepts.
        const preview = await previewPeerInvitation(ownerCtx(B), { invitation: code }, seam);
        expect(preview.cardUrl).toBe(inflectA2aIdentity(ORIGIN, A));
        const aKey = await resolveTenantA2aSigningKey(ownerCtx(A));
        expect(preview.keyFingerprint).toBe(aKey!.fingerprint);
        expect(await prisma.peerAgent.count({ where: { tenantId: B } })).toBe(0);

        const accepted = await acceptPeerInvitation(
            ownerCtx(B),
            { invitation: code, reviewedCardHash: preview.cardHash, name: 'Workspace A', ...grant(B) },
            seam,
        );

        // In B: A is registered with its card's key and PINNED, B issued A a
        // token, and B's outbound connection to A holds the token A issued.
        const aInB = await prisma.peerAgent.findUniqueOrThrow({ where: { id: accepted.peerId } });
        expect(aInB.cardUrl).toBe(inflectA2aIdentity(ORIGIN, A));
        expect(aInB.signingKeyFingerprint).toBe(aKey!.fingerprint);
        expect(aInB.pinnedCardHash).toBe(preview.cardHash);
        expect(await prisma.peerAgentInboundCredential.count({ where: { tenantId: B, peerId: aInB.id, revokedAt: null } })).toBe(1);
        const bConn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: accepted.connectionId } });
        expect(bConn.provider).toBe('a2a-peer');
        expect(bConn.configJson).toEqual({ peerId: aInB.id });
        // No stored rung reads as DISABLED (`coerceStoredMode`): sending stays off.
        expect(bConn.externalWriteMode).toBeNull();

        // In A: the invitation is ACCEPTED and names B; B is registered
        // UNPINNED with the invitation's owner, supplier, tier and grant.
        const used = await prisma.peerInvitation.findUniqueOrThrow({ where: { id: stored.id } });
        expect(used.status).toBe('ACCEPTED');
        expect(used.acceptedCardUrl).toBe(inflectA2aIdentity(ORIGIN, B));
        const bInA = await prisma.peerAgent.findUniqueOrThrow({ where: { id: used.acceptedPeerId! } });
        expect(bInA.tenantId).toBe(A);
        expect(bInA.pinnedCardHash).toBeNull();
        expect(bInA.ownerUserId).toBe(world[A].ownerUserId);
        expect(bInA.vendorId).toBe(world[A].vendorId);
        expect(bInA.riskTier).toBe('MODERATE');
        const aCred = await prisma.peerAgentInboundCredential.findFirstOrThrow({
            where: { tenantId: A, peerId: bInA.id, revokedAt: null },
        });
        expect(aCred.receivingAgentId).toBe(world[A].agentId);
        expect(aCred.workflowKeys).toEqual(['diagnostic']);
        const aConns = await prisma.integrationConnection.findMany({ where: { tenantId: A, provider: 'a2a-peer' } });
        expect(aConns).toHaveLength(1);
        expect(aConns[0].configJson).toEqual({ peerId: bInA.id });
        expect(aConns[0].externalWriteMode).toBeNull();
        expect(bInA.name).toBe(`Inflect (inflect.test/${B})`);
        // The owner is told.
        expect(
            await prisma.notification.count({ where: { tenantId: A, userId: world[A].ownerUserId, linkUrl: `/t/${A}/agents/peers/${bInA.id}` } }),
        ).toBe(1);

        // B admits A now; A does not admit B until a person in A approves B's card.
        expect((await checkPeerAdmission(ownerCtx(B), aInB.id, seam)).admitted).toBe(true);
        expect((await checkPeerAdmission(ownerCtx(A), bInA.id, seam)).admitted).toBe(false);
        const read = await readPeerAgentCard(ownerCtx(A), bInA.id, seam);
        if (!read.live.readable) throw new Error('card unreadable');
        await approvePeerAgentCard(ownerCtx(A), bInA.id, { expectedCardHash: read.live.hashes.cardHash }, seam);
        expect((await checkPeerAdmission(ownerCtx(A), bInA.id, seam)).admitted).toBe(true);
    });
});

describe('2. single use', () => {
    it('a used code is refused, and the refused attempt leaves no token issued in the accepting workspace', async () => {
        const code = await invite(A);
        await accept(C, code);
        const cPeer = await prisma.peerAgent.findFirstOrThrow({ where: { tenantId: C, cardUrl: inflectA2aIdentity(ORIGIN, A) } });
        // Already connected: refused before anything is written or sent, so a
        // working token is never put at risk by a second acceptance.
        lastInviterOutcome = null;
        await expect(accept(C, code)).rejects.toMatchObject({ details: { reason: 'ALREADY_CONNECTED' } });
        expect(lastInviterOutcome).toBeNull();
        expect(await prisma.peerAgentInboundCredential.count({ where: { tenantId: C, peerId: cPeer.id, revokedAt: null } })).toBe(1);

        // Disconnected, the same code is refused by A, and the token C issued
        // for the attempt is taken back.
        await revokePeerInboundCredential(ownerCtx(C), cPeer.id);
        await expect(accept(C, code)).rejects.toMatchObject({ details: { reason: 'INVITER_REFUSED' } });
        expect(lastInviterOutcome).toMatchObject({ ok: false, reason: 'INVITATION_NOT_PENDING' });
        expect(await prisma.peerAgentInboundCredential.count({ where: { tenantId: C, peerId: cPeer.id, revokedAt: null } })).toBe(0);
    });

    it('an expired invitation is refused', async () => {
        const minted = mintPeerInvitationCode();
        await prisma.peerInvitation.create({
            data: {
                tenantId: A,
                codeHash: minted.codeHash,
                codePrefix: minted.codePrefix,
                ...grant(A),
                expiresAt: new Date(Date.now() - 1000),
                createdByUserId: world[A].ownerUserId,
            },
        });
        await expect(accept(C, `${inflectA2aIdentity(ORIGIN, A)}#${minted.code}`)).rejects.toMatchObject({
            details: { reason: 'INVITER_REFUSED' },
        });
        expect(lastInviterOutcome).toMatchObject({ ok: false, reason: 'INVITATION_NOT_PENDING' });
    });

    it('a revoked invitation is refused, and a revoked invitation does not change again', async () => {
        const created = await createPeerInvitation(ownerCtx(A), grant(A));
        await revokePeerInvitation(ownerCtx(A), created.invitation.id);
        await expect(accept(C, created.code)).rejects.toMatchObject({ details: { reason: 'INVITER_REFUSED' } });
        await expect(
            prisma.peerInvitation.update({ where: { id: created.invitation.id }, data: { status: 'PENDING', revokedAt: null, revokedByUserId: null } }),
        ).rejects.toThrow(/PEER_INVITATION_FINAL/);
        await expect(revokePeerInvitation(ownerCtx(A), created.invitation.id)).rejects.toThrow(/No pending invitation/);
    });

    it('what an invitation grants cannot be changed after it is created', async () => {
        const created = await createPeerInvitation(ownerCtx(A), grant(A));
        await expect(
            prisma.peerInvitation.update({ where: { id: created.invitation.id }, data: { workflowKeys: ['diagnostic', 'other'] } }),
        ).rejects.toThrow(/PEER_INVITATION_FROZEN/);
        await revokePeerInvitation(ownerCtx(A), created.invitation.id);
    });
});

describe('3. the acceptance', () => {
    async function signedBody(code: string, signer: string, overrides: Record<string, unknown> = {}) {
        const body = JSON.stringify({
            v: PEER_INVITATION_ACCEPT_VERSION,
            code,
            cardUrl: inflectA2aIdentity(ORIGIN, signer),
            token: `iflp_${'x'.repeat(40)}`,
            issuedAt: new Date().toISOString(),
            ...overrides,
        });
        const key = await resolveTenantA2aSigningKey(ownerCtx(signer));
        return { body, signature: signPeerInvitationAcceptance(body, key!.privateKey) };
    }
    const atA = (body: string, signature: string | null) =>
        acceptPeerInvitationAtInviter({ tenantSlug: A, body, signature, requestId: 'test' }, { fetchImpl });

    it('is refused when signed by a key other than the one the named card carries', async () => {
        const code = (await invite(A)).split('#')[1];
        // Names C's card, signed by B's key.
        const { body } = await signedBody(code, C);
        const forged = await signedBody(code, B);
        expect(await atA(body, forged.signature)).toMatchObject({ ok: false, reason: 'SIGNATURE_INVALID' });
        expect(await atA(body, null)).toMatchObject({ ok: false, reason: 'SIGNATURE_INVALID' });
        expect((await prisma.peerInvitation.findFirstOrThrow({ where: { tenantId: A, codeHash: hashPeerInvitationCode(code) } })).status).toBe(
            'PENDING',
        );
    });

    it('is refused when it is stale, or names the inviting workspace itself', async () => {
        const code = (await invite(A)).split('#')[1];
        const stale = await signedBody(code, B, { issuedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
        expect(await atA(stale.body, stale.signature)).toMatchObject({ ok: false, reason: 'ACCEPTANCE_STALE' });
        const self = await signedBody(code, A);
        expect(await atA(self.body, self.signature)).toMatchObject({ ok: false, reason: 'INVITATION_TO_SELF' });
    });

    it('acts as the inviting person as they stand now: one who has since left refuses it', async () => {
        // A second owner invites, then is deactivated before the acceptance arrives.
        const email = `second-owner@${A}.test`;
        const second = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId: A, userId: second.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
        try {
            const created = await createPeerInvitation(ownerCtx(A, { userId: second.id }), grant(A));
            await prisma.tenantMembership.updateMany({ where: { tenantId: A, userId: second.id }, data: { status: 'DEACTIVATED' } });
            const { body, signature } = await signedBody(created.code.split('#')[1], B);
            expect(await atA(body, signature)).toMatchObject({ ok: false, reason: 'INVITER_NOT_AUTHORISED' });
        } finally {
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "PeerInvitation" WHERE "createdByUserId" = $1`, second.id);
                await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "userId" = $1`, second.id);
            });
            await deleteAuditRowsForTenants(prisma, [A]);
            await prisma.user.delete({ where: { id: second.id } });
        }
    });

    it('the accepting side refuses a moved card, and connects nothing', async () => {
        const code = await invite(A);
        const before = await prisma.peerAgentInboundCredential.count({ where: { tenantId: C } });
        await expect(
            acceptPeerInvitation(ownerCtx(C), { invitation: code, reviewedCardHash: 'f'.repeat(64), name: 'A', ...grant(C) }, seam),
        ).rejects.toThrow(/differs from the one reviewed/);
        expect(await prisma.peerAgentInboundCredential.count({ where: { tenantId: C } })).toBe(before);
    });
});

describe('4. who may', () => {
    it('refuses a reader, an API key, and a workflow that needs inputs', async () => {
        const reader = makeRequestContext('READER', { tenantId: A, tenantSlug: A, userId: world[A].ownerUserId });
        await expect(createPeerInvitation(reader, grant(A))).rejects.toThrow(/admin.agent_registry/);
        await expect(createPeerInvitation(ownerCtx(A, { apiKeyId: 'key_1' }), grant(A))).rejects.toThrow(/not by an API key/);
        await expect(createPeerInvitation(ownerCtx(A), { ...grant(A), workflowKeys: [NEEDS_INPUT_WF] })).rejects.toMatchObject({
            details: { reason: 'WORKFLOW_NEEDS_INPUT' },
        });
        await expect(previewPeerInvitation(ownerCtx(B), { invitation: 'not a code' }, seam)).rejects.toMatchObject({
            details: { reason: 'INVITATION_MALFORMED' },
        });
    });
});

describe('5. isolation', () => {
    it('a workspace lists only its own invitations, and app_user can neither read across nor delete', async () => {
        expect((await listPeerInvitations(ownerCtx(B))).every((i) => i.receivingAgentId === world[B].agentId)).toBe(true);
        const aIds = (await listPeerInvitations(ownerCtx(A))).map((i) => i.id);
        expect(aIds.length).toBeGreaterThan(0);
        const seenByB = await asTenant(B, (tx) => tx.peerInvitation.findMany({ select: { id: true } }));
        expect(seenByB.map((r) => r.id).filter((id) => aIds.includes(id))).toEqual([]);
        await expect(asTenant(null, (tx) => tx.peerInvitation.count())).resolves.toBe(0);
        await expect(asTenant(A, (tx) => tx.peerInvitation.deleteMany({ where: { id: aIds[0] } }))).rejects.toThrow();
        await expect(revokePeerInvitation(ownerCtx(B), aIds[0])).rejects.toThrow(/No pending invitation/);
    });
});
