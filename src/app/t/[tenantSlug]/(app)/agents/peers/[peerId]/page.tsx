import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { getPeerAgent } from '@/app-layer/usecases/peer-agents';
import { getPeerInboundCredential } from '@/app-layer/usecases/a2a-peer-credentials';
import { listPeerKills } from '@/app-layer/usecases/a2a-peer-kill';
import { listPeerMessages } from '@/app-layer/usecases/a2a-messages';
import { listRegisteredAgents } from '@/app-layer/usecases/agent-registry';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { NotFoundError } from '@/lib/errors/types';

import { PeerDetailClient, type PeerDetail } from './PeerDetailClient';

export const dynamic = 'force-dynamic';

/**
 * ONE A2A PEER (#3679) — Server Component.
 *
 * Every read the page needs, each through the usecase the API uses, so the
 * page can show nothing the routes would not:
 *
 *   the peer, its pin and card state, its quota   `admin.agent_registry`
 *   its inbound credential (live and revoked)     `admin.agent_registry`
 *   its signed receipts, re-verified              `admin.agent_registry`
 *   its kill history and the toggle               `admin.agent_kill_switch`
 *
 * The kill read is made only for a holder of the kill key — the same rule
 * its route applies — and the tab says why it is empty for anybody else.
 *
 * Each capped list is read ONE PAST its cap (#4902), so the page can say it is
 * showing the latest N rather than a count that reads as the whole history.
 * The member list (for moving the peer to another accountable owner) is read
 * fail-soft: a failed read says so beside the owner, rather than taking the
 * page down.
 */
const MESSAGE_CAP = 100;
const AGENT_CAP = 200;

export default async function PeerDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; peerId: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const admin = ctx.appPermissions?.admin;

    if (!admin?.agent_registry) {
        const t = await getTranslations('agents');
        return <ForbiddenPage title={t('register.accessTitle')} message={t('register.accessMessage')} />;
    }

    let peer;
    try {
        peer = await getPeerAgent(ctx, resolved.peerId);
    } catch (err) {
        if (err instanceof NotFoundError) notFound();
        throw err;
    }
    const canKill = Boolean(admin.agent_kill_switch);
    const [credential, messagesRead, kills, agentsRead, members] = await Promise.all([
        getPeerInboundCredential(ctx, peer.id),
        listPeerMessages(ctx, peer.id, { take: MESSAGE_CAP + 1 }),
        canKill ? listPeerKills(ctx, peer.id) : Promise.resolve(null),
        listRegisteredAgents(ctx, { take: AGENT_CAP + 1 }),
        listAssignableUsers(ctx).catch(() => null),
    ]);
    const messages = messagesRead.slice(0, MESSAGE_CAP);
    const agents = agentsRead.slice(0, AGENT_CAP);

    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    const detail: PeerDetail = {
        peer: {
            id: peer.id,
            name: peer.name,
            cardUrl: peer.cardUrl,
            status: peer.status,
            signingKeyFingerprint: peer.signingKeyFingerprint,
            pinnedCardHash: peer.pinnedCardHash,
            pinRevision: peer.pinRevision,
            pinnedAt: iso(peer.pinnedAt),
            observedCardHash: peer.observedCardHash,
            observedAt: iso(peer.observedAt),
            inboundMessagesPerHour: peer.inboundMessagesPerHour,
            riskTier: peer.riskTier,
            ownerUserId: peer.ownerUserId,
            ownerName: peer.owner?.name || peer.owner?.email || null,
            vendorId: peer.vendorId,
            vendorName: peer.vendor?.name ?? null,
        },
        credential: {
            live: credential.credential
                ? {
                      id: credential.credential.id,
                      keyPrefix: credential.credential.keyPrefix,
                      receivingAgentId: credential.credential.receivingAgentId,
                      workflowKeys: credential.credential.workflowKeys,
                      createdAt: iso(credential.credential.createdAt)!,
                  }
                : null,
            revoked: credential.revoked.map((c) => ({
                id: c.id,
                keyPrefix: c.keyPrefix,
                receivingAgentId: c.receivingAgentId,
                revokedAt: iso(c.revokedAt)!,
            })),
            handover: {
                inflectIdentity: credential.inflectIdentity,
                endpointPath: credential.endpointPath,
                signingPublicKey: credential.inflectSigningPublicKey,
            },
        },
        messages: messages.map((m) => ({
            id: m.id,
            direction: m.direction as 'INBOUND' | 'OUTBOUND',
            kind: m.kind,
            method: m.method,
            messageId: m.messageId,
            signerKeyFingerprint: m.signerKeyFingerprint,
            createdAt: iso(m.createdAt)!,
            verifies: m.verifies,
        })),
        kills: kills
            ? kills.map((k) => ({
                  id: k.id,
                  reason: k.reason,
                  engagedAt: iso(k.engagedAt)!,
                  liftedAt: iso(k.liftedAt),
                  liftReason: k.liftReason,
              }))
            : null,
        messagesCapped: messagesRead.length > MESSAGE_CAP ? MESSAGE_CAP : null,
        agents: agents
            .filter((a) => a.status !== 'RETIRED')
            .map((a) => ({ id: a.id, name: a.name })),
        agentsCapped: agentsRead.length > AGENT_CAP ? AGENT_CAP : null,
        workflows: listWorkflowDefinitions().map((w) => ({ key: w.key, name: w.name })),
        owners:
            members === null
                ? null
                : members.map((m: { id: string; name: string | null; email: string }) => ({
                      id: m.id,
                      label: m.name ?? m.email,
                  })),
    };

    return (
        <PeerDetailClient
            tenantSlug={resolved.tenantSlug}
            detail={detail}
            canManage
            canKill={canKill}
        />
    );
}
