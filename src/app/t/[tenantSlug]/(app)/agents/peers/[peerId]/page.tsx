import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { getPeerAgent } from '@/app-layer/usecases/peer-agents';
import { getPeerInboundCredential } from '@/app-layer/usecases/a2a-peer-credentials';
import { listPeerKills } from '@/app-layer/usecases/a2a-peer-kill';
import { listPeerMessages } from '@/app-layer/usecases/a2a-messages';
import { listRegisteredAgents } from '@/app-layer/usecases/agent-registry';
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
 */
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
    const [credential, messages, kills, agents] = await Promise.all([
        getPeerInboundCredential(ctx, peer.id),
        listPeerMessages(ctx, peer.id, { take: 100 }),
        canKill ? listPeerKills(ctx, peer.id) : Promise.resolve(null),
        listRegisteredAgents(ctx, { take: 200 }),
    ]);

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
        agents: agents
            .filter((a) => a.status !== 'RETIRED')
            .map((a) => ({ id: a.id, name: a.name })),
        workflows: listWorkflowDefinitions().map((w) => ({ key: w.key, name: w.name })),
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
