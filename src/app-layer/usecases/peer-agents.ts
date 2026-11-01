/**
 * A2A peer agents: register, score, pin, admit (#3673, step 2e; UC5).
 *
 * The ONLY writer of `PeerAgent` (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * ## Whose authority
 *
 * Registering a peer and approving its card take `admin.agent_registry`, by
 * owner decision (2026-10-18, threat-model residual R3): they decide which
 * other organisation's agent this tenant will talk to, which is configuration,
 * and the register is where that sits. `admin.agent_external_tools` stays the
 * key for an agent's call leaving the tenant (step 4b). The two are kept apart
 * so the authority that acts is never the authority that configures.
 *
 * ## The card
 *
 * There is no trust on first use. Registration reads the card and records what
 * it saw; it pins nothing. A person then reads the live card, and approves the
 * hash they reviewed: the approval re-reads the card and refuses when it no
 * longer matches (`docs/a2a-threat-model.md`, pinning rule 5). Card TEXT is
 * returned to that reviewer and to nobody else: it is never stored, logged,
 * audited or put in a notification (rule 8). Audit rows carry hashes.
 *
 * Every network read happens OUTSIDE a database transaction, so a slow peer
 * never holds a connection.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { assertOwnerInTenant } from './vendor-link-targets';
import { checkWebhookUrl } from '@/app-layer/automation/webhook-safety';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import {
    compareAgentCard,
    evaluatePeerAdmission,
    type AgentCardHashes,
    type CardVerdict,
    type PeerAdmission,
    type PinnedCardHashes,
} from '@/lib/agentic/peer-agent-card';
import { fetchAgentCard, type AgentCardFetchOptions, type AgentCardFetchResult } from '@/lib/agentic/peer-agent-card-fetch';
import { recordPeerCardCheck } from '@/lib/observability/integration-metrics';
import { recentAgentCard, type RecentCardOptions } from '@/lib/agentic/a2a/card-cache';
import { sanitizePlainText } from '@/lib/security/sanitize';

const RISK_TIERS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
const PEER_STATUSES = ['ACTIVE', 'SUSPENDED', 'RETIRED'] as const;

export const RegisterPeerAgentSchema = z
    .object({
        name: z.string().min(1).max(200),
        cardUrl: z.string().min(1).max(2048),
        ownerUserId: z.string().min(1).max(64),
        vendorId: z.string().min(1).max(64),
        signingPublicKey: z.string().min(1).max(256),
        riskTier: z.enum(RISK_TIERS).optional(),
    })
    .strict();

/** The per-peer inbound quota's bounds, as the CHECK in the 4b migration holds them. */
export const PEER_INBOUND_QUOTA_MIN = 1;
export const PEER_INBOUND_QUOTA_MAX = 1000;

export const UpdatePeerAgentSchema = z
    .object({
        name: z.string().min(1).max(200).optional(),
        ownerUserId: z.string().min(1).max(64).optional(),
        /** `null` withdraws a score: the peer is UNSCORED, and refused, again. */
        riskTier: z.enum(RISK_TIERS).nullable().optional(),
        status: z.enum(PEER_STATUSES).optional(),
        /**
         * Inbound messages per hour (#3679). A limit that only narrows, held to
         * 1..1000 here and by a CHECK; the kill, not a zero, is how a peer is
         * stopped.
         */
        inboundMessagesPerHour: z.number().int().min(PEER_INBOUND_QUOTA_MIN).max(PEER_INBOUND_QUOTA_MAX).optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const ApprovePeerCardSchema = z
    .object({
        /** The card hash the approver reviewed, as the card read returned it. */
        expectedCardHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();

/** The columns any surface may show. No card text exists to select. */
const PEER_SELECT = {
    id: true,
    name: true,
    cardUrl: true,
    ownerUserId: true,
    vendorId: true,
    riskTier: true,
    riskTierScoredAt: true,
    signingKeyFingerprint: true,
    status: true,
    observedCardHash: true,
    observedAt: true,
    pinnedCardHash: true,
    pinRevision: true,
    pinnedByUserId: true,
    pinnedAt: true,
    previousCardHash: true,
    inboundMessagesPerHour: true,
    createdByUserId: true,
    createdAt: true,
    updatedAt: true,
    // WHO answers for the peer and WHICH supplier it belongs to, by name, so
    // the peers list and a peer's page can say so (#4901, #4902).
    owner: { select: { name: true, email: true } },
    vendor: { select: { name: true } },
} as const;

function assertMayManagePeers(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Managing A2A peer agents requires admin.agent_registry');
    }
}

/**
 * Validate an operator-typed card URL. `checkWebhookUrl` settles https and the
 * named and private hosts at save time; `safeFetch` re-resolves at every read,
 * which is the half that closes DNS rebinding. Userinfo is refused outright: a
 * credential in a URL would be stored, shown and copied wherever the URL is.
 */
function normaliseCardUrl(raw: string): string {
    const verdict = checkWebhookUrl(raw.trim());
    if (!verdict.ok) throw badRequest('The card URL must be a public https address');
    const url = new URL(raw.trim());
    if (url.username || url.password) throw badRequest('The card URL must not carry credentials');
    url.hash = '';
    return url.href;
}

async function assertVendorInTenant(db: PrismaTx, ctx: RequestContext, vendorId: string): Promise<void> {
    const vendor = await db.vendor.findFirst({
        where: { id: vendorId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
    });
    if (!vendor) throw badRequest('The selected vendor does not exist in this tenant');
}

function pinOf(row: {
    pinnedCardHash: string | null;
    pinnedTextHash: string | null;
    pinnedEndpointHash: string | null;
    pinnedOtherHash: string | null;
    pinRevision: number;
}): PinnedCardHashes | null {
    if (!row.pinnedCardHash || !row.pinnedTextHash || !row.pinnedEndpointHash || !row.pinnedOtherHash) return null;
    return {
        cardHash: row.pinnedCardHash,
        textHash: row.pinnedTextHash,
        endpointHash: row.pinnedEndpointHash,
        otherHash: row.pinnedOtherHash,
        revision: row.pinRevision,
    };
}

function outcomeOf(read: AgentCardFetchResult, verdict: CardVerdict | null): string {
    if (!read.ok) return read.reason;
    return verdict ? verdict.status : 'READ';
}

export async function registerPeerAgent(
    ctx: RequestContext,
    input: z.infer<typeof RegisterPeerAgentSchema>,
    opts: AgentCardFetchOptions = {},
) {
    assertMayManagePeers(ctx);
    const parsed = RegisterPeerAgentSchema.parse(input);
    const cardUrl = normaliseCardUrl(parsed.cardUrl);
    const fingerprint = harnessKeyFingerprint(parsed.signingPublicKey);
    if (!fingerprint) throw badRequest('signingPublicKey is not an Ed25519 public key (raw 32 bytes, hex or base64)');
    const name = sanitizePlainText(parsed.name).trim();
    if (!name) throw badRequest('A peer needs a name');

    // Read the card first, outside any transaction. A card that cannot be read
    // does not stop the registration: the peer is unpinned, and so refused,
    // until somebody reads and approves it.
    const read = await fetchAgentCard(cardUrl, opts);
    recordPeerCardCheck({ outcome: outcomeOf(read, null), context: 'register' });

    const peer = await runInTenantContext(ctx, async (db) => {
        await assertOwnerInTenant(db, ctx, parsed.ownerUserId);
        await assertVendorInTenant(db, ctx, parsed.vendorId);
        const existing = await db.peerAgent.findFirst({
            where: { tenantId: ctx.tenantId, cardUrl },
            select: { id: true },
        });
        if (existing) throw conflict('A peer with this card URL is already registered');

        const now = new Date();
        const created = await db.peerAgent.create({
            data: {
                tenantId: ctx.tenantId,
                name,
                cardUrl,
                ownerUserId: parsed.ownerUserId,
                vendorId: parsed.vendorId,
                signingPublicKey: parsed.signingPublicKey.trim(),
                signingKeyFingerprint: fingerprint,
                ...(parsed.riskTier ? { riskTier: parsed.riskTier, riskTierScoredAt: now } : {}),
                ...(read.ok ? { observedCardHash: read.hashes.cardHash, observedAt: now } : {}),
                createdByUserId: ctx.userId,
            },
            select: PEER_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_REGISTERED',
            entityType: 'PeerAgent',
            entityId: created.id,
            details: `Registered A2A peer agent ${created.id}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgent',
                operation: 'created',
                after: {
                    cardOrigin: new URL(cardUrl).origin,
                    ownerUserId: created.ownerUserId,
                    vendorId: created.vendorId,
                    riskTier: created.riskTier,
                    signingKeyFingerprint: created.signingKeyFingerprint,
                    observedCardHash: created.observedCardHash,
                },
            },
        });
        return created;
    });

    return { peer, card: read.ok ? { readable: true as const, hashes: read.hashes } : { readable: false as const, reason: read.reason } };
}

export async function listPeerAgents(ctx: RequestContext) {
    assertMayManagePeers(ctx);
    return runInTenantContext(ctx, (db) =>
        db.peerAgent.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: PEER_SELECT,
        }),
    );
}

export async function getPeerAgent(ctx: RequestContext, peerId: string) {
    assertMayManagePeers(ctx);
    const peer = await runInTenantContext(ctx, (db) =>
        db.peerAgent.findFirst({ where: { id: peerId, tenantId: ctx.tenantId }, select: PEER_SELECT }),
    );
    if (!peer) throw notFound('Peer agent not found');
    return peer;
}

export async function updatePeerAgent(ctx: RequestContext, peerId: string, input: z.infer<typeof UpdatePeerAgentSchema>) {
    assertMayManagePeers(ctx);
    const parsed = UpdatePeerAgentSchema.parse(input);
    return runInTenantContext(ctx, async (db) => {
        const before = await db.peerAgent.findFirst({
            where: { id: peerId, tenantId: ctx.tenantId },
            select: { id: true, name: true, ownerUserId: true, riskTier: true, status: true, inboundMessagesPerHour: true },
        });
        if (!before) throw notFound('Peer agent not found');
        // One-way, here and in the database trigger behind it.
        if (before.status === 'RETIRED' && parsed.status !== undefined && parsed.status !== 'RETIRED') {
            throw badRequest('A retired peer agent cannot be reactivated');
        }
        if (parsed.ownerUserId !== undefined) await assertOwnerInTenant(db, ctx, parsed.ownerUserId);

        const data: Record<string, unknown> = {};
        if (parsed.name !== undefined) {
            const name = sanitizePlainText(parsed.name).trim();
            if (!name) throw badRequest('A peer needs a name');
            data.name = name;
        }
        if (parsed.ownerUserId !== undefined) data.ownerUserId = parsed.ownerUserId;
        if (parsed.riskTier !== undefined) {
            data.riskTier = parsed.riskTier;
            data.riskTierScoredAt = parsed.riskTier === null ? null : new Date();
        }
        if (parsed.status !== undefined) data.status = parsed.status;
        if (parsed.inboundMessagesPerHour !== undefined) data.inboundMessagesPerHour = parsed.inboundMessagesPerHour;

        const after = await db.peerAgent.update({
            where: { id_tenantId: { id: before.id, tenantId: ctx.tenantId } },
            data,
            select: PEER_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_UPDATED',
            entityType: 'PeerAgent',
            entityId: after.id,
            details: `Updated A2A peer agent ${after.id}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgent',
                operation: 'updated',
                before: {
                    ownerUserId: before.ownerUserId,
                    riskTier: before.riskTier,
                    status: before.status,
                    inboundMessagesPerHour: before.inboundMessagesPerHour,
                },
                after: {
                    ownerUserId: after.ownerUserId,
                    riskTier: after.riskTier,
                    status: after.status,
                    inboundMessagesPerHour: after.inboundMessagesPerHour,
                },
            },
        });
        return after;
    });
}

/**
 * Read the live card for review, compare it with the pin, and say whether the
 * peer would be admitted now. The card's content is in the response because a
 * person cannot approve a hash of text they were not shown; it goes nowhere
 * else.
 */
export async function readPeerAgentCard(ctx: RequestContext, peerId: string, opts: AgentCardFetchOptions = {}) {
    assertMayManagePeers(ctx);
    const peer = await loadForAdmission(ctx, peerId);
    const read = await fetchAgentCard(peer.cardUrl, opts);
    const pin = pinOf(peer);
    const verdict = read.ok ? compareAgentCard(read.hashes, pin) : null;
    recordPeerCardCheck({ outcome: outcomeOf(read, verdict), context: 'read' });

    if (read.ok) {
        await runInTenantContext(ctx, (db) =>
            db.peerAgent.updateMany({
                where: { id: peer.id, tenantId: ctx.tenantId },
                data: { observedCardHash: read.hashes.cardHash, observedAt: new Date() },
            }),
        );
    }
    const admission = evaluatePeerAdmission({
        status: peer.status,
        ownerActive: peer.ownerActive,
        riskTier: peer.riskTier,
        pin,
        live: read.ok ? read.hashes : null,
    });
    return {
        peerId: peer.id,
        live: read.ok ? { readable: true as const, hashes: read.hashes, card: read.card } : { readable: false as const, reason: read.reason },
        verdict,
        admission: admission.admitted ? { admitted: true as const } : { admitted: false as const, reason: admission.reason },
    };
}

/**
 * Approve the live card as the peer's pin. The approver names the hash they
 * reviewed; the card is read again, and the approval is refused if it no
 * longer matches. The pin moves only from the revision the approver started
 * from, so two concurrent approvals cannot both land.
 */
export async function approvePeerAgentCard(
    ctx: RequestContext,
    peerId: string,
    input: z.infer<typeof ApprovePeerCardSchema>,
    opts: AgentCardFetchOptions = {},
) {
    assertMayManagePeers(ctx);
    // A pin is a named person accepting a hash they reviewed (rule 5), so a
    // machine credential never approves one, whatever scopes it carries.
    if (ctx.apiKeyId) throw forbidden('A card pin is approved by a person, not by an API key');
    const { expectedCardHash } = ApprovePeerCardSchema.parse(input);
    const peer = await loadForAdmission(ctx, peerId);
    if (peer.status === 'RETIRED') throw badRequest('A retired peer agent cannot be given a card pin');

    const read = await fetchAgentCard(peer.cardUrl, opts);
    if (!read.ok) {
        recordPeerCardCheck({ outcome: read.reason, context: 'approve' });
        throw badRequest(`The peer's card could not be read (${read.reason}); nothing was approved`);
    }
    if (read.hashes.cardHash !== expectedCardHash) {
        recordPeerCardCheck({ outcome: 'CHANGED_SINCE_REVIEW', context: 'approve' });
        throw conflict('The live card differs from the one reviewed. Read it again before approving');
    }
    const pin = pinOf(peer);
    const verdict = compareAgentCard(read.hashes, pin);
    recordPeerCardCheck({ outcome: verdict.status, context: 'approve' });
    if (verdict.status === 'MATCH') {
        return { peerId: peer.id, revision: verdict.revision, cardHash: read.hashes.cardHash, alreadyPinned: true as const };
    }

    return runInTenantContext(ctx, async (db) => {
        const now = new Date();
        const revision = peer.pinRevision + 1;
        const moved = await db.peerAgent.updateMany({
            where: { id: peer.id, tenantId: ctx.tenantId, pinRevision: peer.pinRevision, status: { not: 'RETIRED' } },
            data: pinData(read.hashes, revision, pin?.cardHash ?? null, ctx.userId, now),
        });
        if (moved.count === 0) throw conflict('The pin changed while this approval was in progress. Read the card again');
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_CARD_APPROVED',
            entityType: 'PeerAgent',
            entityId: peer.id,
            details: `Approved revision ${revision} of the card for A2A peer agent ${peer.id}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgent',
                operation: 'approved',
                // Hashes and the components that moved, never the card's text
                // (pinning rules 7 and 8).
                after: {
                    revision,
                    cardHash: read.hashes.cardHash,
                    previousCardHash: pin?.cardHash ?? null,
                    moved: verdict.status === 'CHANGED' ? verdict.moved : [],
                },
            },
        });
        return { peerId: peer.id, revision, cardHash: read.hashes.cardHash, alreadyPinned: false as const };
    });
}

function pinData(h: AgentCardHashes, revision: number, previous: string | null, userId: string, at: Date) {
    return {
        pinnedCardHash: h.cardHash,
        pinnedTextHash: h.textHash,
        pinnedEndpointHash: h.endpointHash,
        pinnedOtherHash: h.otherHash,
        pinRevision: revision,
        pinnedByUserId: userId,
        pinnedAt: at,
        previousCardHash: previous,
        observedCardHash: h.cardHash,
        observedAt: at,
    };
}

/**
 * Whether a peer may exchange a task NOW, read against its live card.
 *
 * The gate step 4b calls before every message, built here so the rule exists
 * before the traffic does. It checks no permission of its own: it is a gate a
 * caller passes through, never the whole of a route's authorization. The
 * refusal it returns names a reason for the caller's audit row; what is sent
 * back to a peer or an agent must say only that re-approval is required
 * (pinning rule 7).
 */
export async function checkPeerAdmission(
    ctx: RequestContext,
    peerId: string,
    opts: AgentCardFetchOptions = {},
): Promise<PeerAdmission> {
    const peer = await loadForAdmission(ctx, peerId);
    const pin = pinOf(peer);
    // Nothing to compare against: refuse without dialling the peer at all.
    const read = pin && peer.status === 'ACTIVE' ? await fetchAgentCard(peer.cardUrl, opts) : null;
    const admission = evaluatePeerAdmission({
        status: peer.status,
        ownerActive: peer.ownerActive,
        riskTier: peer.riskTier,
        pin,
        live: read && read.ok ? read.hashes : null,
    });
    recordPeerCardCheck({
        outcome: admission.admitted ? 'ADMITTED' : admission.reason,
        context: 'admission',
    });
    return admission;
}

/**
 * The gate step 4b calls before EVERY message, in both directions (#3679).
 *
 * `checkPeerAdmission` above reads the live card, which is right for the admin
 * surface and wrong per message: it would put a third party's latency in front
 * of every task. This reads a copy of the card at most fifteen minutes old
 * (owner decision 2026-10-17, threat-model R18; `recentAgentCard`), fetching one
 * when none is held — and a fetch that fails refuses, as the rule requires. The
 * PIN is read from the database every time, so a re-approval or a retirement
 * takes effect on the next message, not the next fetch.
 *
 * Returns what the caller needs to act on an admission and nothing more: the
 * peer's registered signing key, its registered identity, its owner, the pin,
 * and the endpoint from the pinned card. The verdict on a refusal is for the
 * caller's audit row only; it must never reach the peer or an agent (rule 7).
 */
export async function admitPeerMessage(ctx: RequestContext, peerId: string, opts: RecentCardOptions = {}) {
    const peer = await loadForAdmission(ctx, peerId);
    const pin = pinOf(peer);
    const read =
        pin && peer.status === 'ACTIVE'
            ? await recentAgentCard({ tenantId: ctx.tenantId, peerId: peer.id, cardUrl: peer.cardUrl }, opts)
            : null;
    const admission = evaluatePeerAdmission({
        status: peer.status,
        ownerActive: peer.ownerActive,
        riskTier: peer.riskTier,
        pin,
        live: read && read.ok ? read.hashes : null,
    });
    recordPeerCardCheck({ outcome: admission.admitted ? 'ADMITTED' : admission.reason, context: 'message' });
    return {
        admission,
        peer: {
            id: peer.id,
            cardUrl: peer.cardUrl,
            ownerUserId: peer.ownerUserId,
            signingPublicKey: peer.signingPublicKey,
            signingKeyFingerprint: peer.signingKeyFingerprint,
        },
        pin,
        /** The service endpoint of the card that was admitted. Null on any refusal. */
        endpoint: admission.admitted && read && read.ok ? read.card.url : null,
    };
}

async function loadForAdmission(ctx: RequestContext, peerId: string) {
    return runInTenantContext(ctx, async (db) => {
        const peer = await db.peerAgent.findFirst({
            where: { id: peerId, tenantId: ctx.tenantId },
            select: {
                id: true,
                cardUrl: true,
                status: true,
                riskTier: true,
                ownerUserId: true,
                signingPublicKey: true,
                signingKeyFingerprint: true,
                pinnedCardHash: true,
                pinnedTextHash: true,
                pinnedEndpointHash: true,
                pinnedOtherHash: true,
                pinRevision: true,
            },
        });
        if (!peer) throw notFound('Peer agent not found');
        const owner = await db.tenantMembership.findFirst({
            where: { userId: peer.ownerUserId, tenantId: ctx.tenantId, status: 'ACTIVE' },
            select: { id: true },
        });
        return { ...peer, ownerActive: owner !== null };
    });
}
