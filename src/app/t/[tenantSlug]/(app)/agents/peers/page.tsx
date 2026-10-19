import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { listPeerAgents } from '@/app-layer/usecases/peer-agents';
import { getTenantA2aSigningKeys } from '@/app-layer/usecases/a2a-signing-key';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity } from '@/lib/permissions';

import { PeersClient, type PeerRow } from './PeersClient';
import type { SigningKeyView } from './SigningKeyPanel';

export const dynamic = 'force-dynamic';

/**
 * A2A PEERS (#3679) — Server Component.
 *
 * `/agents/peers`, reached from the agents "Views" menu. Gated on
 * `admin.agent_registry`, the key every peer route takes (owner decision
 * 2026-10-18, threat-model R3): which other organisation's agent the tenant
 * talks to is configuration. Refused here as well as in the usecases, so a
 * caller without the key gets the ForbiddenPage every agent surface shows and
 * no data fetch starts.
 *
 * The signing key is read through the same usecase the API uses, which selects
 * the public half only. Whether the reader may ROTATE it (`admin.tenant_lifecycle`,
 * OWNER) comes back with it, so the panel offers the button only to an owner.
 */
export default async function PeersPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    if (!ctx.appPermissions?.admin?.agent_registry) {
        const t = await getTranslations('agents');
        return <ForbiddenPage title={t('register.accessTitle')} message={t('register.accessMessage')} />;
    }

    const [peers, keys] = await Promise.all([listPeerAgents(ctx), getTenantA2aSigningKeys(ctx)]);

    const rows: PeerRow[] = peers.map((p) => ({
        id: p.id,
        name: p.name,
        cardUrl: p.cardUrl,
        status: p.status,
        pinnedCardHash: p.pinnedCardHash,
        pinRevision: p.pinRevision,
        observedCardHash: p.observedCardHash,
        inboundMessagesPerHour: p.inboundMessagesPerHour,
    }));
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    const toPublic = (k: NonNullable<typeof keys.current>) => ({
        id: k.id,
        publicKey: k.publicKey,
        fingerprint: k.fingerprint,
        createdAt: k.createdAt.toISOString(),
        retiredAt: iso(k.retiredAt),
    });
    const signingKey: SigningKeyView = {
        current: keys.current ? toPublic(keys.current) : null,
        retired: keys.retired.map(toPublic),
        canRotate: keys.canRotate,
    };

    return (
        <PeersClient
            tenantSlug={resolved.tenantSlug}
            initialRows={rows}
            signingKey={signingKey}
            canReviewProposals={mayReadAgentActivity(ctx.appPermissions?.admin)}
            canCompose={Boolean(ctx.appPermissions?.admin?.view)}
        />
    );
}
