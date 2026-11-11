/**
 * PEER INVITATIONS (#3752; owner decisions 2026-11-11). The only writer of
 * `PeerInvitation`.
 *
 * Connecting two workspaces over A2A used to take eight manual acts, four on
 * each side. With an invitation it takes three:
 *
 *   1. INVITE, in A (`createPeerInvitation`): a person picks who answers for
 *      the peer that accepts, its supplier and tier, and the one receiving agent
 *      and workflows it may reach. A gets one code to hand over.
 *   2. ACCEPT, in B (`previewPeerInvitation`, then `acceptPeerInvitation`): a
 *      person pastes the code, reads A's card and approves it. That one act
 *      registers A, pins A's card, issues A a token, sends B's acceptance to A,
 *      and stores the token A answers with as B's outbound connection to A.
 *   3. CONFIRM, in A: the acceptance (`acceptPeerInvitationAtInviter`)
 *      registered B UNPINNED, issued B its token and stored B's token as A's
 *      outbound connection. A person approves B's card on its peer page, with
 *      the existing approval, and nothing flows until they do.
 *
 * Every existing rule holds, because every step is the existing usecase:
 *
 *   · NO TRUST ON FIRST USE. Nothing is pinned without a person reading the
 *     card. B pins A in step 2, by its person; A pins B in step 3, by its
 *     person. The acceptance pins nothing on A's side (owner decision 1).
 *   · AUTHORITY ONLY NARROWS. The tokens bind one receiving agent and its
 *     workflows; a peer still reaches only what that agent is granted.
 *   · BOTH OUTBOUND CONNECTIONS START AT DISABLED. Sending is still an external
 *     write, widened one rung at a time by an owner.
 *
 * And the invitation's own:
 *
 *   · The code is single-use, expires in 7 days and is stored only as a hash.
 *   · An acceptance must be signed by the key the acceptor's OWN card names, so
 *     a leaked code cannot make A register a card whose key the sender lacks.
 *   · Where B sends its acceptance comes from A's card as B's person pinned it,
 *     never from the code.
 *   · A acts as the person who created the invitation, re-read when the
 *     acceptance arrives: one who has since left, or lost the register key,
 *     refuses the acceptance (`INVITER_NOT_AUTHORISED`) rather than lending the
 *     write an authority nobody holds.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInGlobalContext, runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { logEvent } from '../events/audit';
import { assertOwnerInTenant } from './vendor-link-targets';
import { buildSystemContext, resolveMemberContext } from '../context-system';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { cardSigningKey } from '@/lib/agentic/a2a/own-card';
import { fetchAgentCard, type AgentCardFetchOptions } from '@/lib/agentic/peer-agent-card-fetch';
import { safeFetch } from '@/app-layer/automation/webhook-safety';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { tenantPageLink } from '@/app-layer/notifications/tenant-link';
import {
    PEER_INVITATION_ACCEPT_MAX_AGE_MS,
    PEER_INVITATION_ACCEPT_VERSION,
    PEER_INVITATION_SIGNATURE_HEADER,
    PEER_INVITATION_TTL_MS,
    PeerInvitationAcceptAnswerSchema,
    PeerInvitationAcceptBodySchema,
    formatPeerInvitation,
    hashPeerInvitationCode,
    mintPeerInvitationCode,
    parsePeerInvitation,
    peerInvitationAcceptUrl,
    signPeerInvitationAcceptance,
    verifyPeerInvitationAcceptance,
} from '@/lib/agentic/a2a/invitation';
import { approvePeerAgentCard, registerPeerAgent } from './peer-agents';
import { issuePeerInboundCredential, revokePeerInboundCredential } from './a2a-peer-credentials';
import { ownA2aIdentity } from './a2a-agent-card';
import { resolveTenantA2aSigningKey } from './a2a-signing-key';
import { upsertIntegrationConnection } from './integrations';
import { A2A_PEER_PROVIDER_ID } from '@/app-layer/integrations/providers/a2a-peer-provider';

const RISK_TIERS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;

/** How long the acceptance POST may take before B gives up and undoes its half. */
const ACCEPT_TIMEOUT_MS = 15_000;
/** The largest answer B reads back from A. It is one token. */
const ACCEPT_ANSWER_MAX_BYTES = 4096;

export type PeerInvitationRefusal =
    | 'NOT_A_PERSON'
    | 'NEEDS_ADMIN'
    | 'NO_SIGNING_KEY'
    | 'NO_PUBLIC_ORIGIN'
    | 'WORKFLOW_UNKNOWN'
    | 'WORKFLOW_NEEDS_INPUT'
    | 'AGENT_NOT_USABLE'
    | 'INVITATION_MALFORMED'
    | 'INVITATION_TO_SELF'
    | 'CARD_UNREADABLE'
    | 'CARD_NAMES_NO_KEY'
    | 'CARD_NAMES_NO_ENDPOINT'
    | 'PEER_RETIRED'
    | 'ALREADY_CONNECTED'
    | 'INVITER_UNREACHABLE'
    | 'INVITER_REFUSED';

export const CreatePeerInvitationSchema = z
    .object({
        ownerUserId: z.string().min(1).max(64),
        vendorId: z.string().min(1).max(64),
        riskTier: z.enum(RISK_TIERS),
        receivingAgentId: z.string().min(1).max(64),
        workflowKeys: z.array(z.string().min(1).max(128)).min(1).max(16),
    })
    .strict();

export const PreviewPeerInvitationSchema = z.object({ invitation: z.string().min(1).max(4096) }).strict();

export const AcceptPeerInvitationSchema = z
    .object({
        invitation: z.string().min(1).max(4096),
        reviewedCardHash: z.string().regex(/^[0-9a-f]{64}$/),
        name: z.string().min(1).max(200),
        ownerUserId: z.string().min(1).max(64),
        vendorId: z.string().min(1).max(64),
        riskTier: z.enum(RISK_TIERS),
        receivingAgentId: z.string().min(1).max(64),
        workflowKeys: z.array(z.string().min(1).max(128)).min(1).max(16),
    })
    .strict();

function refuse(message: string, reason: PeerInvitationRefusal): never {
    throw badRequest(message, { reason });
}

/** A person holding the register key: an invitation is never issued or accepted by a credential. */
function assertMayInvite(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Inviting or accepting an A2A peer requires admin.agent_registry');
    }
    if (ctx.apiKeyId) throw forbidden('An A2A peer invitation is created and accepted by a person, not by an API key');
    // The flow also stores an outbound connection, which `upsertIntegrationConnection`
    // gates on the coarse admin tier. Asked first, so nothing is half-written.
    if (!ctx.permissions?.canAdmin) {
        throw forbidden('Connecting a peer also creates its outbound connection, which needs an owner or admin', {
            reason: 'NEEDS_ADMIN' satisfies PeerInvitationRefusal,
        });
    }
}

/**
 * The workflows a peer may be granted through an invitation. A task carries
 * text only, so a workflow that declares a required input could never start.
 */
function checkWorkflows(keys: readonly string[]): string[] {
    const unique = [...new Set(keys.map((k) => k.trim()))];
    for (const key of unique) {
        const def = getWorkflowDefinition(key);
        if (!def) refuse(`Unknown workflow: ${key}`, 'WORKFLOW_UNKNOWN');
        if ((def.requiredInput ?? []).length > 0) {
            refuse(
                `The workflow ${key} needs inputs a peer's task cannot carry, so a peer could never start it.`,
                'WORKFLOW_NEEDS_INPUT',
            );
        }
    }
    return unique;
}

async function assertAgentUsable(ctx: RequestContext, agentId: string): Promise<void> {
    const agent = await runInTenantContext(ctx, (db) =>
        db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { status: true },
        }),
    );
    if (!agent || agent.status === 'RETIRED') {
        refuse('The receiving agent does not exist in this workspace, or is retired.', 'AGENT_NOT_USABLE');
    }
}

async function assertVendor(ctx: RequestContext, vendorId: string): Promise<void> {
    const vendor = await runInTenantContext(ctx, (db) =>
        db.vendor.findFirst({ where: { id: vendorId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } }),
    );
    if (!vendor) throw badRequest('The selected supplier does not exist in this workspace');
}

const INVITATION_SELECT = {
    id: true,
    codePrefix: true,
    ownerUserId: true,
    vendorId: true,
    riskTier: true,
    receivingAgentId: true,
    workflowKeys: true,
    status: true,
    expiresAt: true,
    createdByUserId: true,
    createdAt: true,
    acceptedAt: true,
    acceptedPeerId: true,
    acceptedCardUrl: true,
    revokedAt: true,
} as const;

// ─── 1. INVITE ─────────────────────────────────────────────────────────

export async function createPeerInvitation(ctx: RequestContext, input: unknown) {
    assertMayInvite(ctx);
    const parsed = CreatePeerInvitationSchema.parse(input);
    const workflowKeys = checkWorkflows(parsed.workflowKeys);
    await assertAgentUsable(ctx, parsed.receivingAgentId);
    await assertVendor(ctx, parsed.vendorId);

    const identity = await ownA2aIdentity(ctx);
    if (!identity) refuse('This deployment has no public https address, so it has no A2A identity to invite from.', 'NO_PUBLIC_ORIGIN');
    if (!(await resolveTenantA2aSigningKey(ctx))) {
        refuse('Generate this workspace\'s signing key on the peers page before inviting a peer.', 'NO_SIGNING_KEY');
    }

    const minted = mintPeerInvitationCode();
    const expiresAt = new Date(Date.now() + PEER_INVITATION_TTL_MS);
    const row = await runInTenantContext(ctx, async (db) => {
        await assertOwnerInTenant(db, ctx, parsed.ownerUserId);
        const created = await db.peerInvitation.create({
            data: {
                tenantId: ctx.tenantId,
                codeHash: minted.codeHash,
                codePrefix: minted.codePrefix,
                ownerUserId: parsed.ownerUserId,
                vendorId: parsed.vendorId,
                riskTier: parsed.riskTier,
                receivingAgentId: parsed.receivingAgentId,
                workflowKeys,
                expiresAt,
                createdByUserId: ctx.userId,
            },
            select: INVITATION_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'PEER_INVITATION_CREATED',
            entityType: 'PeerInvitation',
            entityId: created.id,
            details: `Created A2A peer invitation ${created.id}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerInvitation',
                operation: 'created',
                // Never the code and never its hash.
                after: {
                    codePrefix: created.codePrefix,
                    ownerUserId: created.ownerUserId,
                    vendorId: created.vendorId,
                    riskTier: created.riskTier,
                    receivingAgentId: created.receivingAgentId,
                    workflowKeys,
                    expiresAt: expiresAt.toISOString(),
                },
            },
        });
        return created;
    });
    // Shown once: the code is not recoverable after this response.
    return { invitation: row, code: formatPeerInvitation(identity, minted.code) };
}

export async function listPeerInvitations(ctx: RequestContext) {
    if (!ctx.appPermissions.admin.agent_registry) throw forbidden('Reading A2A peer invitations requires admin.agent_registry');
    return runInTenantContext(ctx, (db) =>
        db.peerInvitation.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: INVITATION_SELECT,
        }),
    );
}

export async function revokePeerInvitation(ctx: RequestContext, invitationId: string) {
    if (!ctx.appPermissions.admin.agent_registry) throw forbidden('Revoking an A2A peer invitation requires admin.agent_registry');
    if (ctx.apiKeyId) throw forbidden('An A2A peer invitation is revoked by a person, not by an API key');
    return runInTenantContext(ctx, async (db) => {
        const moved = await db.peerInvitation.updateMany({
            where: { id: invitationId, tenantId: ctx.tenantId, status: 'PENDING' },
            data: { status: 'REVOKED', revokedAt: new Date(), revokedByUserId: ctx.userId },
        });
        if (moved.count === 0) throw notFound('No pending invitation with that id');
        await logEvent(db, ctx, {
            action: 'PEER_INVITATION_REVOKED',
            entityType: 'PeerInvitation',
            entityId: invitationId,
            details: `Revoked A2A peer invitation ${invitationId}`,
            detailsJson: { category: 'access', entityName: 'PeerInvitation', operation: 'revoked' },
        });
        return { id: invitationId, status: 'REVOKED' as const };
    });
}

// ─── 2. ACCEPT, on the invited side ────────────────────────────────────

/** Read the inviter's card for a person to review. Writes nothing. */
export async function previewPeerInvitation(ctx: RequestContext, input: unknown, opts: AgentCardFetchOptions = {}) {
    assertMayInvite(ctx);
    const { invitation } = PreviewPeerInvitationSchema.parse(input);
    const parsed = parsePeerInvitation(invitation);
    if (!parsed) refuse('That is not an A2A peer invitation. Paste the whole code you were sent.', 'INVITATION_MALFORMED');
    const own = await ownA2aIdentity(ctx);
    if (own && own === parsed.cardUrl) refuse('That invitation is from this workspace.', 'INVITATION_TO_SELF');

    const read = await fetchAgentCard(parsed.cardUrl, opts);
    if (!read.ok) refuse(`The inviting workspace's card could not be read (${read.reason}).`, 'CARD_UNREADABLE');
    const key = cardSigningKey(read.card);
    if (!key) refuse('The inviting workspace\'s card names no signing key it was signed with.', 'CARD_NAMES_NO_KEY');
    if (!peerInvitationAcceptUrl(read.card.url)) refuse('The inviting workspace\'s card names no https endpoint.', 'CARD_NAMES_NO_ENDPOINT');
    return {
        cardUrl: parsed.cardUrl,
        card: read.card,
        cardHash: read.hashes.cardHash,
        keyFingerprint: key.fingerprint,
    };
}

async function findPeerByCardUrl(ctx: RequestContext, cardUrl: string) {
    return runInTenantContext(ctx, (db) =>
        db.peerAgent.findFirst({ where: { tenantId: ctx.tenantId, cardUrl }, select: { id: true, status: true } }),
    );
}

/** Register the peer, or reuse the one already registered at that card URL. */
async function registerOrReuse(
    ctx: RequestContext,
    input: { name: string; cardUrl: string; ownerUserId: string; vendorId: string; riskTier: (typeof RISK_TIERS)[number] },
    opts: AgentCardFetchOptions,
): Promise<string> {
    const existing = await findPeerByCardUrl(ctx, input.cardUrl);
    if (existing) {
        if (existing.status === 'RETIRED') {
            refuse('That workspace was registered here before and retired. A retired peer is not reconnected.', 'PEER_RETIRED');
        }
        return existing.id;
    }
    const { peer } = await registerPeerAgent(ctx, input, opts);
    return peer.id;
}

/** Issue the peer a fresh inbound token, replacing a live one it already holds. */
async function issueFreshToken(ctx: RequestContext, peerId: string, receivingAgentId: string, workflowKeys: string[]) {
    const live = await runInTenantContext(ctx, (db) =>
        db.peerAgentInboundCredential.findFirst({ where: { tenantId: ctx.tenantId, peerId, revokedAt: null }, select: { id: true } }),
    );
    if (live) await revokePeerInboundCredential(ctx, peerId);
    const issued = await issuePeerInboundCredential(ctx, peerId, { receivingAgentId, workflowKeys });
    return issued.token;
}

/**
 * Where a card lives, short enough for a name: its host, and the workspace slug
 * when it is an Inflect card. Every Inflect workspace's card is named
 * "Inflect", so the card's own name alone tells two of them apart for nobody.
 */
export function peerCardLabel(cardUrl: string): string {
    try {
        const url = new URL(cardUrl);
        const slug = /^\/api\/a2a\/([^/]+)\/agent-card\.json$/.exec(url.pathname)?.[1];
        return slug ? `${url.host}/${slug}` : url.host;
    } catch {
        return cardUrl.slice(0, 80);
    }
}

/** Store the outbound route to a peer, or update the existing one with the new token. */
async function storeOutboundConnection(ctx: RequestContext, peerId: string, peerName: string, cardUrl: string, token: string) {
    const existing = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { tenantId: ctx.tenantId, provider: A2A_PEER_PROVIDER_ID, configJson: { path: ['peerId'], equals: peerId } },
            select: { id: true },
        }),
    );
    const saved = await upsertIntegrationConnection(ctx, {
        ...(existing ? { id: existing.id } : {}),
        provider: A2A_PEER_PROVIDER_ID,
        // Connection names are unique per provider in a tenant; the card's
        // address makes this one unique, because one peer is registered per card.
        name: `A2A → ${peerName} (${peerCardLabel(cardUrl)})`.slice(0, 200),
        configJson: { peerId },
        secrets: { authorization: `Bearer ${token}` },
    });
    return (saved as { id: string }).id;
}

async function readCapped(res: Response, cap: number): Promise<string | null> {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cap) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** POST the signed acceptance and read back the one token the inviter answers with. */
async function postAcceptance(
    acceptUrl: string,
    body: string,
    signature: string,
    postImpl: typeof fetch | undefined,
): Promise<{ ok: true; token: string } | { ok: false; reason: 'INVITER_UNREACHABLE' | 'INVITER_REFUSED' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCEPT_TIMEOUT_MS);
    let res: Response;
    let text: string | null;
    try {
        const init: RequestInit = {
            method: 'POST',
            headers: { 'content-type': 'application/json', [PEER_INVITATION_SIGNATURE_HEADER]: signature },
            body,
            signal: controller.signal,
            redirect: 'manual',
        };
        res = postImpl ? await postImpl(acceptUrl, init) : await safeFetch(acceptUrl, init);
        text = await readCapped(res, ACCEPT_ANSWER_MAX_BYTES);
    } catch {
        return { ok: false, reason: 'INVITER_UNREACHABLE' };
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok || text === null) return { ok: false, reason: 'INVITER_REFUSED' };
    let answer: unknown;
    try {
        answer = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'INVITER_REFUSED' };
    }
    const parsed = PeerInvitationAcceptAnswerSchema.safeParse(answer);
    return parsed.success ? { ok: true, token: parsed.data.token } : { ok: false, reason: 'INVITER_REFUSED' };
}

/**
 * Accept an invitation: one act by a person in the invited workspace. Pins the
 * inviter's card (the person reviewed `reviewedCardHash`), issues it a token,
 * sends the signed acceptance, and stores the token it answers with.
 */
export async function acceptPeerInvitation(
    ctx: RequestContext,
    input: unknown,
    opts: AgentCardFetchOptions & { postImpl?: typeof fetch } = {},
) {
    assertMayInvite(ctx);
    const parsed = AcceptPeerInvitationSchema.parse(input);
    const invitation = parsePeerInvitation(parsed.invitation);
    if (!invitation) refuse('That is not an A2A peer invitation. Paste the whole code you were sent.', 'INVITATION_MALFORMED');
    const workflowKeys = checkWorkflows(parsed.workflowKeys);
    await assertAgentUsable(ctx, parsed.receivingAgentId);

    const own = await ownA2aIdentity(ctx);
    if (!own) refuse('This deployment has no public https address, so it has no A2A identity to accept with.', 'NO_PUBLIC_ORIGIN');
    if (own === invitation.cardUrl) refuse('That invitation is from this workspace.', 'INVITATION_TO_SELF');
    const signingKey = await resolveTenantA2aSigningKey(ctx);
    if (!signingKey) refuse('Generate this workspace\'s signing key on the peers page before accepting.', 'NO_SIGNING_KEY');

    const name = sanitizePlainText(parsed.name).trim();
    if (!name) throw badRequest('A peer needs a name');

    // A workspace this one already exchanges tokens with is not reconnected by
    // an invitation: a refused acceptance would otherwise have taken back the
    // working token. Revoke it on the peer's page first, deliberately.
    const known = await findPeerByCardUrl(ctx, invitation.cardUrl);
    if (known) {
        const live = await runInTenantContext(ctx, (db) =>
            db.peerAgentInboundCredential.count({ where: { tenantId: ctx.tenantId, peerId: known.id, revokedAt: null } }),
        );
        if (live > 0) {
            refuse(
                'This workspace is already connected to the inviting one. Revoke its access token on its peer page before accepting a new invitation.',
                'ALREADY_CONNECTED',
            );
        }
    }

    // 1. Register (or reuse) and pin the inviter's card: the person reviewed
    //    this hash, and the approval reads the card again and refuses a move.
    const peerId = await registerOrReuse(
        ctx,
        { name, cardUrl: invitation.cardUrl, ownerUserId: parsed.ownerUserId, vendorId: parsed.vendorId, riskTier: parsed.riskTier },
        opts,
    );
    await approvePeerAgentCard(ctx, peerId, { expectedCardHash: parsed.reviewedCardHash }, opts);

    // Where the acceptance goes: the endpoint of the card just pinned.
    const read = await fetchAgentCard(invitation.cardUrl, opts);
    if (!read.ok) refuse(`The inviting workspace's card could not be read (${read.reason}).`, 'CARD_UNREADABLE');
    const acceptUrl = peerInvitationAcceptUrl(read.card.url);
    if (!acceptUrl) refuse('The inviting workspace\'s card names no https endpoint.', 'CARD_NAMES_NO_ENDPOINT');

    // 2. Issue the inviter its token to this workspace.
    const ourToken = await issueFreshToken(ctx, peerId, parsed.receivingAgentId, workflowKeys);

    // 3. Send the signed acceptance. On any failure, take the token back, so
    //    nothing is left issued to a workspace that never heard of it.
    const body = JSON.stringify({
        v: PEER_INVITATION_ACCEPT_VERSION,
        code: invitation.code,
        cardUrl: own,
        token: ourToken,
        issuedAt: new Date().toISOString(),
    });
    const signature = signPeerInvitationAcceptance(body, signingKey.privateKey);
    const answerToken = await postAcceptance(acceptUrl, body, signature, opts.postImpl);
    if (!answerToken.ok) {
        // Take the token back, so nothing is left issued to a workspace that
        // never recorded this workspace as its peer.
        await revokePeerInboundCredential(ctx, peerId).catch(() => undefined);
        if (answerToken.reason === 'INVITER_UNREACHABLE') {
            refuse('The inviting workspace could not be reached. Nothing was connected; try again.', 'INVITER_UNREACHABLE');
        }
        refuse('The inviting workspace refused the acceptance. Ask it for a new invitation.', 'INVITER_REFUSED');
    }

    // 4. Store the token the inviter issued this workspace as the outbound route.
    const connectionId = await storeOutboundConnection(ctx, peerId, name, invitation.cardUrl, answerToken.token);
    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'PEER_INVITATION_ACCEPTED',
            entityType: 'PeerAgent',
            entityId: peerId,
            details: `Accepted an A2A peer invitation from peer agent ${peerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgent',
                operation: 'connected',
                after: { peerId, connectionId, receivingAgentId: parsed.receivingAgentId, workflowKeys },
            },
        }),
    );
    return { peerId, connectionId };
}

// ─── 3. THE ACCEPTANCE ARRIVES, on the inviting side ───────────────────

export type InviterAcceptOutcome =
    | { readonly ok: true; readonly answer: string }
    | { readonly ok: false; readonly status: number; readonly reason: string };

/**
 * Handle an acceptance POSTed to `/api/a2a/:slug/invitations`. No session
 * stands behind it: the code, the expiry, the acceptor's signature by its own
 * card's key, and the inviter's own standing decide everything.
 */
export async function acceptPeerInvitationAtInviter(
    input: { tenantSlug: string; body: string; signature: string | null; requestId: string },
    opts: AgentCardFetchOptions = {},
): Promise<InviterAcceptOutcome> {
    const no = (status: number, reason: string): InviterAcceptOutcome => {
        logger.warn('a2a peer invitation acceptance refused', {
            component: 'peer-invitations',
            tenantSlug: input.tenantSlug,
            reason,
        });
        return { ok: false, status, reason };
    };

    let raw: unknown;
    try {
        raw = JSON.parse(input.body);
    } catch {
        return no(400, 'BODY_MALFORMED');
    }
    const body = PeerInvitationAcceptBodySchema.safeParse(raw);
    if (!body.success) return no(400, 'BODY_MALFORMED');
    const issued = Date.parse(body.data.issuedAt);
    if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > PEER_INVITATION_ACCEPT_MAX_AGE_MS) {
        return no(403, 'ACCEPTANCE_STALE');
    }

    const tenant = await runInGlobalContext((db) =>
        db.tenant.findFirst({ where: { slug: input.tenantSlug, deletedAt: null }, select: { id: true, slug: true } }),
    );
    if (!tenant) return no(404, 'TENANT_UNKNOWN');
    const sys = buildSystemContext({ tenantId: tenant.id, tenantSlug: tenant.slug, job: 'peer-invitation-accept' });

    const invitation = await runInTenantContext(sys, (db) =>
        db.peerInvitation.findFirst({
            where: { tenantId: tenant.id, codeHash: hashPeerInvitationCode(body.data.code) },
            select: { ...INVITATION_SELECT },
        }),
    );
    if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt.getTime() <= Date.now()) {
        return no(403, 'INVITATION_NOT_PENDING');
    }

    // The acceptor proves it holds the key its own card names.
    const acceptorCardUrl = body.data.cardUrl;
    const own = await ownA2aIdentity(sys);
    if (own && own === acceptorCardUrl) return no(403, 'INVITATION_TO_SELF');
    const read = await fetchAgentCard(acceptorCardUrl, opts);
    if (!read.ok) return no(403, 'ACCEPTOR_CARD_UNREADABLE');
    const key = cardSigningKey(read.card);
    if (!key) return no(403, 'ACCEPTOR_CARD_NAMES_NO_KEY');
    if (!verifyPeerInvitationAcceptance(input.body, input.signature, key.publicKey)) return no(403, 'SIGNATURE_INVALID');

    // Act as the person who invited, as they stand now.
    const inviter = await resolveMemberContext({
        tenantId: tenant.id,
        userId: invitation.createdByUserId,
        job: 'peer-invitation-accept',
        discriminator: invitation.id,
    });
    if (!inviter || !inviter.appPermissions.admin.agent_registry || !inviter.permissions?.canAdmin) {
        return no(403, 'INVITER_NOT_AUTHORISED');
    }
    const ctx: RequestContext = { ...inviter, requestId: input.requestId };

    try {
        const cardName = sanitizePlainText(read.card.name).trim() || 'A2A peer';
        const name = `${cardName} (${peerCardLabel(acceptorCardUrl)})`.slice(0, 200);
        const peerId = await registerOrReuse(
            ctx,
            {
                name,
                cardUrl: acceptorCardUrl,
                ownerUserId: invitation.ownerUserId,
                vendorId: invitation.vendorId,
                riskTier: invitation.riskTier,
            },
            opts,
        );
        const ourToken = await issueFreshToken(ctx, peerId, invitation.receivingAgentId, invitation.workflowKeys);
        await storeOutboundConnection(ctx, peerId, name, acceptorCardUrl, body.data.token);

        // Claim the invitation last, and only from PENDING, so a second
        // acceptance racing this one cannot also succeed.
        const claimed = await runInTenantContext(ctx, async (db) => {
            const moved = await db.peerInvitation.updateMany({
                where: { id: invitation.id, tenantId: tenant.id, status: 'PENDING' },
                data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedPeerId: peerId, acceptedCardUrl: acceptorCardUrl },
            });
            if (moved.count === 0) return false;
            await logEvent(db, ctx, {
                action: 'PEER_INVITATION_ACCEPTED',
                entityType: 'PeerInvitation',
                entityId: invitation.id,
                details: `A2A peer invitation ${invitation.id} accepted; peer agent ${peerId} awaits card approval`,
                detailsJson: {
                    category: 'access',
                    entityName: 'PeerInvitation',
                    operation: 'accepted',
                    after: { peerId, cardOrigin: new URL(acceptorCardUrl).origin, cardHash: read.hashes.cardHash },
                },
            });
            await db.notification.create({
                data: {
                    tenantId: tenant.id,
                    userId: invitation.ownerUserId,
                    type: 'GENERAL',
                    title: `${name} accepted your A2A invitation`,
                    message: 'Read its agent card and approve it to start exchanging tasks. Nothing is exchanged until you do.',
                    linkUrl: tenantPageLink(tenant.slug, `/agents/peers/${peerId}`),
                },
            });
            return true;
        });
        if (!claimed) {
            await revokePeerInboundCredential(ctx, peerId).catch(() => undefined);
            return no(409, 'INVITATION_NOT_PENDING');
        }
        return { ok: true, answer: JSON.stringify({ v: PEER_INVITATION_ACCEPT_VERSION, token: ourToken }) };
    } catch (err) {
        logger.error('a2a peer invitation acceptance failed', {
            component: 'peer-invitations',
            tenantId: tenant.id,
            invitationId: invitation.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return no(409, 'ACCEPTANCE_FAILED');
    }
}

