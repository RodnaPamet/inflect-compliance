'use client';

/**
 * ONE A2A PEER (#3679): what admits it, what stops it, how it may reach this
 * organisation, and what it has exchanged with it.
 *
 *   Overview     pin and card state, reading and approving the live card, the
 *                peer's own key id, its risk tier and the inbound quota
 *   Kill switch  stop or resume traffic in both directions, with a reason
 *   Credential   the one live inbound credential: issue (token shown once) and revoke
 *
 * Stop, lift and issue are forms inline in their tab's card rather than
 * dialogs: each is the one action of its card, and a dialog's last button must
 * be a primary, which the product-wide primary ceiling has no slot for. The
 * destructive acts that need a second look — revoking the credential, rotating
 * the signing key — are confirmed with a `ConfirmDialog`.
 *   Messages     every task and answer, with whether its receipt re-verifies
 *
 * Every action is gated as its route is: the quota and the credential by the
 * register key (`canManage`), the kill by the kill key (`canKill`). A control a
 * reader cannot use is not rendered, and a sentence says who can use it.
 *
 * The Overview also names who answers for the peer and its supplier, and
 * carries the acts `UpdatePeerAgentSchema` took and no page offered (#4902):
 * rename, move to another accountable owner, suspend, resume and retire.
 * Retiring is permanent, so it is confirmed.
 */
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyText } from '@/components/ui/copy-text';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { MetaStrip, type MetaItem } from '@/components/ui/meta-strip';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { PEER_CARD_LABEL_KEY, PEER_CARD_VARIANT, peerCardState, peerPinState } from '../peer-state';
import { PeerCardReview } from './PeerCardReview';

/** `UpdatePeerAgentSchema`'s risk tiers; `null` withdraws a score. */
const PEER_RISK_TIERS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
type PeerRiskTier = (typeof PEER_RISK_TIERS)[number];
const UNSCORED = 'UNSCORED';

/** The quota's bounds, as `UpdatePeerAgentSchema` and the CHECK hold them. */
const QUOTA_MIN = 1;
const QUOTA_MAX = 1000;

type TabKey = 'overview' | 'kill' | 'credential' | 'messages';

export interface PeerDetail {
    peer: {
        id: string;
        name: string;
        cardUrl: string;
        status: 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
        signingKeyFingerprint: string;
        pinnedCardHash: string | null;
        pinRevision: number;
        pinnedAt: string | null;
        observedCardHash: string | null;
        observedAt: string | null;
        inboundMessagesPerHour: number;
        /** `null` is unscored, which admission refuses. Optional for a caller that predates it. */
        riskTier?: PeerRiskTier | null;
        /** Who answers for the peer, and its supplier (#4902). Optional for a caller that predates them. */
        ownerUserId?: string;
        ownerName?: string | null;
        vendorId?: string;
        vendorName?: string | null;
    };
    credential: {
        live: {
            id: string;
            keyPrefix: string;
            receivingAgentId: string;
            workflowKeys: string[];
            createdAt: string;
        } | null;
        revoked: { id: string; keyPrefix: string; receivingAgentId: string; revokedAt: string }[];
        handover: { inflectIdentity: string | null; endpointPath: string | null; signingPublicKey: string | null };
    };
    messages: {
        id: string;
        direction: 'INBOUND' | 'OUTBOUND';
        kind: string;
        method: string | null;
        messageId: string;
        signerKeyFingerprint: string;
        createdAt: string;
        verifies: boolean | null;
    }[];
    /** The cap when more messages exist than are listed, else `null` (#4902). */
    messagesCapped?: number | null;
    /** `null` when the reader does not hold the kill key, so it was not read. */
    kills: { id: string; reason: string; engagedAt: string; liftedAt: string | null; liftReason: string | null }[] | null;
    agents: { id: string; name: string }[];
    /** The cap when more agents exist than the picker lists, else `null`. */
    agentsCapped?: number | null;
    workflows: { key: string; name: string }[];
    /** Members who may own the peer; `null` when they could not be read. */
    owners?: { id: string; label: string }[] | null;
}

/** A message's kind and JSON-RPC method, in words (#4902). */
const MESSAGE_KIND_KEY: Readonly<Record<string, string>> = {
    TASK: 'peers.messages.kind.TASK',
    RESULT: 'peers.messages.kind.RESULT',
};
const MESSAGE_METHOD_KEY: Readonly<Record<string, string>> = {
    'message/send': 'peers.messages.method.send',
    'tasks/get': 'peers.messages.method.status',
};

type MessageRow = PeerDetail['messages'][number];
type KillRow = NonNullable<PeerDetail['kills']>[number];

const STATUS_VARIANT: Record<PeerDetail['peer']['status'], StatusBadgeVariant> = {
    ACTIVE: 'success',
    SUSPENDED: 'warning',
    RETIRED: 'neutral',
};

const STATUS_LABEL_KEY = {
    ACTIVE: 'peers.statusActive',
    SUSPENDED: 'peers.statusSuspended',
    RETIRED: 'peers.statusRetired',
} as const;

interface Props {
    tenantSlug: string;
    detail: PeerDetail;
    canManage: boolean;
    canKill: boolean;
}

export function PeerDetailClient({ tenantSlug, detail, canManage, canKill }: Props) {
    const t = useTranslations('agents');
    const [tab, setTab] = useState<TabKey>('overview');
    const { peer } = detail;
    const pin = peerPinState(peer);
    const card = peerCardState(peer);
    const killInForce = detail.kills?.find((k) => k.liftedAt === null) ?? null;

    const meta: MetaItem[] = [
        {
            kind: 'status',
            label: t('peers.detail.metaStatus'),
            value: t(STATUS_LABEL_KEY[peer.status]),
            variant: STATUS_VARIANT[peer.status],
        },
        pin.kind === 'none'
            ? { kind: 'status', label: t('peers.detail.metaPin'), value: t('peers.pinNone'), variant: 'error' }
            : { kind: 'text', label: t('peers.detail.metaPin'), value: t('peers.pinRevision', { revision: pin.revision }) },
        {
            kind: 'status',
            label: t('peers.detail.metaCard'),
            value: t(PEER_CARD_LABEL_KEY[card]),
            variant: PEER_CARD_VARIANT[card],
        },
        {
            kind: 'text',
            label: t('peers.detail.metaQuota'),
            value: t('peers.quotaValue', { count: peer.inboundMessagesPerHour }),
        },
    ];
    if (detail.kills !== null) {
        meta.push({
            kind: 'status',
            label: t('peers.detail.metaKill'),
            value: killInForce ? t('peers.detail.killStopped') : t('peers.detail.killClear'),
            variant: killInForce ? 'error' : 'neutral',
        });
    }

    return (
        <EntityDetailLayout<TabKey>
            back={{ smart: true }}
            breadcrumbs={[
                { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: t('register.breadcrumb'), href: `/t/${tenantSlug}/agents` },
                { label: t('peers.detail.crumbPeers'), href: `/t/${tenantSlug}/agents/peers` },
                { label: peer.name },
            ]}
            title={peer.name}
            meta={<MetaStrip items={meta} />}
            tabs={[
                { key: 'overview', label: t('peers.detail.tabOverview') },
                { key: 'kill', label: t('peers.detail.tabKill') },
                { key: 'credential', label: t('peers.detail.tabCredential') },
                {
                    key: 'messages',
                    label: t('peers.detail.tabMessages'),
                    // A capped list is not a count of the history.
                    count: detail.messagesCapped ? undefined : detail.messages.length,
                },
            ]}
            activeTab={tab}
            onTabChange={setTab}
        >
            {tab === 'overview' && <OverviewTab detail={detail} canManage={canManage} tenantSlug={tenantSlug} />}
            {tab === 'kill' && <KillTab detail={detail} canKill={canKill} />}
            {tab === 'credential' && <CredentialTab detail={detail} canManage={canManage} />}
            {tab === 'messages' && <MessagesTab detail={detail} />}
        </EntityDetailLayout>
    );
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ detail, canManage, tenantSlug }: { detail: PeerDetail; canManage: boolean; tenantSlug: string }) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const { peer } = detail;
    const [quota, setQuota] = useState(peer.inboundMessagesPerHour);
    const storedTier = peer.riskTier ?? UNSCORED;
    const [tier, setTier] = useState<string>(storedTier);
    const [busy, setBusy] = useState(false);
    const card = peerCardState(peer);
    const tierOptions: ComboboxOption[] = [UNSCORED, ...PEER_RISK_TIERS].map((v) => ({
        value: v,
        label: t(`peers.detail.riskTierValue.${v}`),
    }));

    /** One PATCH, for the quota or the risk tier: the route takes either. */
    const patch = async (body: Record<string, unknown>, saved: string, failed: string) => {
        setBusy(true);
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${peer.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                toast.error(apiErrorMessage(json, failed));
                return;
            }
            toast.success(saved);
            router.refresh();
        } catch {
            toast.error(failed);
        } finally {
            setBusy(false);
        }
    };

    const saveQuota = () =>
        patch({ inboundMessagesPerHour: quota }, t('peers.detail.quotaSaved'), t('peers.detail.quotaFailed'));
    const saveTier = () =>
        patch(
            { riskTier: tier === UNSCORED ? null : tier },
            t('peers.detail.riskTierSaved'),
            t('peers.detail.riskTierFailed'),
        );

    return (
        <div className="space-y-section" data-testid="peer-overview">
            {card === 'changed' && (
                <InlineNotice variant="error" data-testid="peer-card-changed">
                    {t('peers.detail.cardChangedNotice')}
                </InlineNotice>
            )}
            {card === 'unapproved' && peer.status !== 'RETIRED' && (
                <InlineNotice variant="warning" data-testid="peer-card-unapproved">
                    {t('peers.detail.cardUnapprovedNotice')}
                </InlineNotice>
            )}
            <PeerDetailsCard detail={detail} canManage={canManage} tenantSlug={tenantSlug} />
            <Card className="space-y-default">
                <dl className="grid grid-cols-1 gap-default text-sm md:grid-cols-2">
                    <Fact label={t('peers.detail.cardUrl')}>
                        <span className="font-mono text-xs break-all">{peer.cardUrl}</span>
                    </Fact>
                    <Fact label={t('peers.detail.peerKey')}>
                        <span className="font-mono text-xs break-all">{peer.signingKeyFingerprint}</span>
                    </Fact>
                    <Fact label={t('peers.detail.pinnedHash')}>
                        <span className="font-mono text-xs break-all" data-testid="peer-pinned-hash">
                            {peer.pinnedCardHash ?? t('peers.pinNone')}
                        </span>
                        {peer.pinnedAt && (
                            <span className="block text-xs text-content-muted">
                                {t('peers.detail.pinnedAt', { date: formatDateTime(peer.pinnedAt) })}
                            </span>
                        )}
                    </Fact>
                    <Fact label={t('peers.detail.observedHash')}>
                        <span className="font-mono text-xs break-all" data-testid="peer-observed-hash">
                            {peer.observedCardHash ?? t('peers.detail.never')}
                        </span>
                        {peer.observedAt && (
                            <span className="block text-xs text-content-muted">
                                {t('peers.detail.observedAt', { date: formatDateTime(peer.observedAt) })}
                            </span>
                        )}
                    </Fact>
                </dl>
            </Card>
            <PeerCardReview peerId={peer.id} retired={peer.status === 'RETIRED'} canManage={canManage} />
            <Card className="space-y-default" data-testid="peer-risk-tier">
                <FormField label={t('peers.detail.riskTierLabel')} description={t('peers.detail.riskTierHint')}>
                    <Combobox
                        hideSearch
                        id="peer-risk-tier-select"
                        options={tierOptions}
                        selected={tierOptions.find((o) => o.value === tier) ?? null}
                        setSelected={(o) => o && setTier(o.value)}
                        disabled={!canManage || busy}
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full max-w-xs' }}
                        caret
                    />
                </FormField>
                {canManage ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void saveTier()}
                        disabled={busy || tier === storedTier}
                        data-testid="peer-risk-tier-save"
                    >
                        {t('peers.detail.riskTierSave')}
                    </Button>
                ) : (
                    <p className="text-xs text-content-muted">{t('peers.detail.riskTierReadOnly')}</p>
                )}
            </Card>
            <Card className="space-y-default" data-testid="peer-quota">
                <FormField
                    label={t('peers.detail.quotaLabel')}
                    description={t('peers.detail.quotaHint', { min: QUOTA_MIN, max: QUOTA_MAX })}
                >
                    <NumberStepper
                        id="peer-quota-input"
                        value={quota}
                        onChange={setQuota}
                        min={QUOTA_MIN}
                        max={QUOTA_MAX}
                        disabled={!canManage || busy}
                        ariaLabel={t('peers.detail.quotaLabel')}
                        className="max-w-xs"
                    />
                </FormField>
                {canManage ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void saveQuota()}
                        disabled={busy || quota === peer.inboundMessagesPerHour}
                        data-testid="peer-quota-save"
                    >
                        {t('peers.detail.quotaSave')}
                    </Button>
                ) : (
                    <p className="text-xs text-content-muted">{t('peers.detail.quotaReadOnly')}</p>
                )}
            </Card>
        </div>
    );
}

/**
 * Who answers for the peer, its supplier, and the acts on the peer itself
 * (#4902): rename, move to another accountable owner, suspend, resume and
 * retire — each one PATCH to the route `UpdatePeerAgentSchema` already took.
 * Retiring is confirmed: a retired peer is refused for good and cannot be
 * resumed or approved again, which the server enforces.
 */
function PeerDetailsCard({ detail, canManage, tenantSlug }: { detail: PeerDetail; canManage: boolean; tenantSlug: string }) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const { peer } = detail;
    const retired = peer.status === 'RETIRED';
    const [name, setName] = useState(peer.name);
    const ownerOptions: ComboboxOption[] = (detail.owners ?? []).map((o) => ({ value: o.id, label: o.label }));
    const [owner, setOwner] = useState<ComboboxOption | null>(
        ownerOptions.find((o) => o.value === peer.ownerUserId) ?? null,
    );
    const [busy, setBusy] = useState(false);
    const [retiring, setRetiring] = useState(false);
    const [retireError, setRetireError] = useState<string | null>(null);

    /** One PATCH; returns the refusal sentence, or `null` when it saved. */
    const send = async (body: Record<string, unknown>, failed: string): Promise<string | null> => {
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${peer.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                return apiErrorMessage(json, failed);
            }
            return null;
        } catch {
            return failed;
        }
    };

    const act = async (body: Record<string, unknown>, saved: string, failed: string) => {
        setBusy(true);
        const refusal = await send(body, failed);
        setBusy(false);
        if (refusal !== null) {
            toast.error(refusal);
            return;
        }
        toast.success(saved);
        router.refresh();
    };

    const retire = async () => {
        setRetireError(null);
        const refusal = await send({ status: 'RETIRED' }, t('peers.detail.statusFailed'));
        if (refusal !== null) {
            setRetireError(refusal);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(refusal);
        }
        toast.success(t('peers.detail.retired'));
        setRetiring(false);
        router.refresh();
    };

    const trimmed = name.trim();

    return (
        <Card className="space-y-default" data-testid="peer-details">
            <Heading level={2}>{t('peers.detail.detailsHeading')}</Heading>
            <dl className="grid grid-cols-1 gap-default text-sm md:grid-cols-2">
                <Fact label={t('peers.detail.owner')}>
                    <span data-testid="peer-owner">{peer.ownerName ?? t('peers.detail.ownerUnknown')}</span>
                </Fact>
                <Fact label={t('peers.detail.vendor')}>
                    {peer.vendorId && peer.vendorName ? (
                        <Link
                            href={`/t/${tenantSlug}/vendors/${peer.vendorId}`}
                            className="text-content-info hover:underline"
                            data-testid="peer-vendor"
                        >
                            {peer.vendorName}
                        </Link>
                    ) : (
                        <span data-testid="peer-vendor">{t('peers.detail.vendorUnknown')}</span>
                    )}
                </Fact>
            </dl>

            {canManage && !retired && (
                <div className="grid grid-cols-1 gap-default md:grid-cols-2">
                    <form
                        className="space-y-compact"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (trimmed && trimmed !== peer.name) {
                                void act({ name: trimmed }, t('peers.detail.renamed'), t('peers.detail.renameFailed'));
                            }
                        }}
                    >
                        <FormField label={t('peers.detail.nameLabel')}>
                            <Input
                                id="peer-name-input"
                                value={name}
                                maxLength={200}
                                onChange={(e) => setName(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <Button
                            type="submit"
                            variant="secondary"
                            size="sm"
                            disabled={busy || trimmed === '' || trimmed === peer.name}
                            data-testid="peer-rename-save"
                        >
                            {t('peers.detail.renameSave')}
                        </Button>
                    </form>
                    <div className="space-y-compact">
                        <FormField label={t('peers.detail.ownerLabel')} description={t('peers.detail.ownerHint')}>
                            <Combobox
                                id="peer-owner-select"
                                options={ownerOptions}
                                selected={owner}
                                setSelected={setOwner}
                                placeholder={t('peers.detail.ownerPlaceholder')}
                                disabled={busy || detail.owners === null}
                                matchTriggerWidth
                                forceDropdown
                            />
                        </FormField>
                        {detail.owners === null && (
                            <p className="text-xs text-content-muted" data-testid="peer-owners-unavailable">
                                {t('peers.detail.ownersUnavailable')}
                            </p>
                        )}
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={busy || owner === null || owner.value === peer.ownerUserId}
                            onClick={() =>
                                owner &&
                                void act({ ownerUserId: owner.value }, t('peers.detail.ownerSaved'), t('peers.detail.ownerFailed'))
                            }
                            data-testid="peer-owner-save"
                        >
                            {t('peers.detail.ownerSave')}
                        </Button>
                    </div>
                </div>
            )}

            <div className="space-y-compact" data-testid="peer-status-actions">
                <Heading level={3}>{t('peers.detail.statusHeading')}</Heading>
                <p className="text-sm text-content-muted">
                    {retired
                        ? t('peers.detail.retiredNote')
                        : peer.status === 'SUSPENDED'
                          ? t('peers.detail.suspendedNote')
                          : t('peers.detail.activeNote')}
                </p>
                {canManage && !retired && (
                    <div className="flex flex-wrap gap-compact">
                        {peer.status === 'ACTIVE' ? (
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                    void act({ status: 'SUSPENDED' }, t('peers.detail.suspended'), t('peers.detail.statusFailed'))
                                }
                                data-testid="peer-suspend"
                            >
                                {t('peers.detail.suspend')}
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                    void act({ status: 'ACTIVE' }, t('peers.detail.resumed'), t('peers.detail.statusFailed'))
                                }
                                data-testid="peer-resume"
                            >
                                {t('peers.detail.resume')}
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                                setRetireError(null);
                                setRetiring(true);
                            }}
                            data-testid="peer-retire"
                        >
                            {t('peers.detail.retire')}
                        </Button>
                    </div>
                )}
                {!canManage && <p className="text-xs text-content-muted">{t('peers.detail.manageReadOnly')}</p>}
            </div>

            <ConfirmDialog
                showModal={retiring}
                setShowModal={(next) => {
                    const value = typeof next === 'function' ? next(retiring) : next;
                    if (!value) setRetiring(false);
                }}
                tone="warning"
                title={t('peers.detail.retireTitle', { name: peer.name })}
                description={
                    <>
                        {t('peers.detail.retireBody')}
                        {retireError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="peer-retire-error">
                                {retireError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('peers.detail.retire')}
                cancelLabel={t('peers.cardReview.cancel')}
                onConfirm={retire}
            />
        </Card>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0 space-y-tight">
            <dt className="text-content-muted">{label}</dt>
            <dd>{children}</dd>
        </div>
    );
}

// ─── Kill switch ─────────────────────────────────────────────────────────────

function KillTab({ detail, canKill }: { detail: PeerDetail; canKill: boolean }) {
    const t = useTranslations('agents');
    const kills = detail.kills;

    const columns = useMemo(
        () =>
            createColumns<KillRow>([
                {
                    id: 'engaged',
                    header: t('peers.kill.colEngaged'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.engagedAt)}</span>,
                },
                {
                    id: 'reason',
                    header: t('peers.kill.colReason'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-sm">{row.original.reason}</span>,
                },
                {
                    id: 'lifted',
                    header: t('peers.kill.colLifted'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-xs">{row.original.liftedAt ? formatDateTime(row.original.liftedAt) : '—'}</span>
                    ),
                },
                {
                    id: 'liftReason',
                    header: t('peers.kill.colLiftReason'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-sm">{row.original.liftReason ?? '—'}</span>,
                },
            ]),
        [t],
    );

    if (!canKill || kills === null) {
        return (
            <InlineNotice variant="info" data-testid="peer-kill-permission-required">
                {t('peers.kill.permissionRequired')}
            </InlineNotice>
        );
    }
    const inForce = kills.find((k) => k.liftedAt === null) ?? null;

    return (
        <div className="space-y-section" data-testid="peer-kill">
            <Card className="space-y-default">
                {inForce ? (
                    <InlineNotice variant="error" data-testid="peer-kill-in-force">
                        {t('peers.kill.inForce', { date: formatDateTime(inForce.engagedAt) })}{' '}
                        {t('peers.kill.inForceReason', { reason: inForce.reason })}
                    </InlineNotice>
                ) : (
                    <p className="text-sm text-content-muted" data-testid="peer-kill-clear">
                        {t('peers.kill.notInForce')}
                    </p>
                )}
                <KillForm mode={inForce ? 'lift' : 'engage'} peerId={detail.peer.id} />
            </Card>
            <Card className="space-y-default">
                <Heading level={2}>{t('peers.kill.history')}</Heading>
                {kills.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('peers.kill.historyEmpty')}</p>
                ) : (
                    <DataTable<KillRow>
                        data={kills}
                        columns={columns}
                        getRowId={(r) => r.id}
                        selectionEnabled={false}
                        resourceName={(plural) => (plural ? t('peers.kill.resourcePlural') : t('peers.kill.resourceSingular'))}
                        emptyState={t('peers.kill.historyEmpty')}
                        data-testid="peer-kill-history-table"
                    />
                )}
            </Card>
        </div>
    );
}

/**
 * Stop or resume, inline in the kill card. A reason is required either way —
 * the API refuses a blank one, and the button stays disabled until there is
 * one. Stopping is `destructive`; resuming is `secondary`, because the card's
 * only action is not a page's primary call to action (the product-wide primary
 * ceiling in `primary-secondary-ratio` has no slot to give a tab's form).
 */
function KillForm({ mode, peerId }: { mode: 'engage' | 'lift'; peerId: string }) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const engage = mode === 'engage';

    const submit = async () => {
        if (reason.trim() === '' || busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${peerId}/kill`), {
                method: engage ? 'POST' : 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(engage ? { reason: reason.trim() } : { liftReason: reason.trim() }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                const message = apiErrorMessage(body, t('peers.kill.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(engage ? t('peers.kill.engaged') : t('peers.kill.lifted'));
            setReason('');
            router.refresh();
        } catch {
            setError(t('peers.kill.failed'));
            toast.error(t('peers.kill.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className="space-y-default"
            data-testid="peer-kill-form"
            onSubmit={(e) => {
                e.preventDefault();
                void submit();
            }}
        >
            <p className="text-sm text-content-muted">
                {engage ? t('peers.kill.engageDescription') : t('peers.kill.liftDescription')}
            </p>
            {error && <InlineNotice variant="error">{error}</InlineNotice>}
            <FormField label={engage ? t('peers.kill.reasonLabel') : t('peers.kill.liftReasonLabel')} required>
                <Textarea
                    id="peer-kill-reason"
                    rows={3}
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={busy}
                />
            </FormField>
            <Button
                type="submit"
                variant={engage ? 'destructive' : 'secondary'}
                size="sm"
                disabled={busy || reason.trim() === ''}
                data-testid={engage ? 'peer-kill-engage' : 'peer-kill-lift'}
            >
                {engage ? t('peers.kill.engage') : t('peers.kill.lift')}
            </Button>
        </form>
    );
}

// ─── Inbound credential ──────────────────────────────────────────────────────

interface IssuedHandover {
    token: string;
    inflectIdentity: string | null;
    endpointPath: string | null;
    inflectSigningPublicKey: string | null;
}

function CredentialTab({ detail, canManage }: { detail: PeerDetail; canManage: boolean }) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const [revoking, setRevoking] = useState(false);
    const [issued, setIssued] = useState<IssuedHandover | null>(null);
    const { live, revoked, handover } = detail.credential;
    const agentName = (id: string) => detail.agents.find((a) => a.id === id)?.name ?? id;
    // A workflow by its name; a key the registry no longer knows stays as it is.
    const workflowName = (key: string) => detail.workflows.find((w) => w.key === key)?.name ?? key;

    const revoke = async () => {
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${detail.peer.id}/inbound-credential`), { method: 'DELETE' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('peers.credential.failed'));
            }
        } catch {
            message = t('peers.credential.failed');
        }
        if (message !== null) {
            toast.error(message);
            throw new Error(message);
        }
        toast.success(t('peers.credential.revoked'));
        router.refresh();
    };

    return (
        <div className="space-y-section" data-testid="peer-credential">
            {issued && (
                <IssuedTokenPanel
                    issued={issued}
                    onDone={() => {
                        setIssued(null);
                        router.refresh();
                    }}
                />
            )}
            <Card className="space-y-default">
                <Heading level={2}>{t('peers.credential.live')}</Heading>
                {live ? (
                    <dl className="grid grid-cols-1 gap-default text-sm md:grid-cols-2" data-testid="peer-credential-live">
                        <Fact label={t('peers.credential.prefix')}>
                            <span className="font-mono text-xs">{live.keyPrefix}…</span>
                        </Fact>
                        <Fact label={t('peers.credential.receivingAgent')}>
                            <span>{agentName(live.receivingAgentId)}</span>
                        </Fact>
                        <Fact label={t('peers.credential.workflows')}>
                            <span data-testid="peer-credential-workflows">
                                {live.workflowKeys.map((k) => workflowName(k)).join(', ')}
                            </span>
                        </Fact>
                        <Fact label={t('peers.credential.issuedLabel')}>
                            <span data-testid="peer-credential-issued">{formatDate(live.createdAt)}</span>
                        </Fact>
                    </dl>
                ) : (
                    issued === null && (
                        <InlineNotice variant="warning" data-testid="peer-credential-none">
                            {t('peers.credential.none')}
                        </InlineNotice>
                    )
                )}
                {!canManage && <p className="text-xs text-content-muted">{t('peers.credential.readOnly')}</p>}
                {canManage && live && (
                    <div>
                        <Button type="button" variant="secondary" size="sm" onClick={() => setRevoking(true)} data-testid="peer-credential-revoke">
                            {t('peers.credential.revoke')}
                        </Button>
                    </div>
                )}
                {canManage && !live && issued === null && <IssueCredentialForm detail={detail} onIssued={setIssued} />}
                {!handover.signingPublicKey && (
                    <InlineNotice variant="warning" data-testid="peer-credential-key-missing">
                        {t('peers.credential.keyMissing')}
                    </InlineNotice>
                )}
                {!handover.inflectIdentity && (
                    <InlineNotice variant="warning" data-testid="peer-credential-origin-missing">
                        {t('peers.credential.originMissing')}
                    </InlineNotice>
                )}
            </Card>
            {revoked.length > 0 && (
                <Card className="space-y-default" data-testid="peer-credential-revoked">
                    <Heading level={2}>{t('peers.credential.revokedHistory')}</Heading>
                    <ul className="space-y-tight text-sm">
                        {revoked.map((c) => (
                            <li key={c.id}>
                                <span className="font-mono text-xs">{c.keyPrefix}…</span>{' '}
                                <span className="text-content-muted">
                                    {agentName(c.receivingAgentId)} · {t('peers.credential.revokedOn', { date: formatDate(c.revokedAt) })}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
            <ConfirmDialog
                showModal={revoking}
                setShowModal={setRevoking}
                tone="danger"
                title={t('peers.credential.revokeTitle')}
                description={t('peers.credential.revokeDescription')}
                confirmLabel={t('peers.credential.revoke')}
                onConfirm={revoke}
            />
        </div>
    );
}

/**
 * Issue the peer's one live credential, inline in the credential card. The
 * receiving agent and the workflow allowlist are picked from the register and
 * the workflow registry, never typed. `secondary`, as a card action inside a
 * tab, for the reason `KillForm` gives.
 */
function IssueCredentialForm({ detail, onIssued }: { detail: PeerDetail; onIssued: (h: IssuedHandover) => void }) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const agentOptions: ComboboxOption[] = detail.agents.map((a) => ({ value: a.id, label: a.name }));
    const workflowOptions: ComboboxOption[] = detail.workflows.map((w) => ({ value: w.key, label: w.name }));
    const [agent, setAgent] = useState<ComboboxOption | null>(null);
    const [workflows, setWorkflows] = useState<ComboboxOption[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canSubmit = agent !== null && workflows.length > 0 && !busy;

    const submit = async () => {
        if (!canSubmit || !agent) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/peers/${detail.peer.id}/inbound-credential`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ receivingAgentId: agent.value, workflowKeys: workflows.map((w) => w.value) }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                const message = apiErrorMessage(body, t('peers.credential.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(t('peers.credential.issued'));
            const b = body as IssuedHandover;
            onIssued({
                token: b.token,
                inflectIdentity: b.inflectIdentity,
                endpointPath: b.endpointPath,
                inflectSigningPublicKey: b.inflectSigningPublicKey,
            });
        } catch {
            setError(t('peers.credential.failed'));
            toast.error(t('peers.credential.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className="space-y-default"
            data-testid="peer-credential-issue-form"
            onSubmit={(e) => {
                e.preventDefault();
                void submit();
            }}
        >
            <Heading level={3}>{t('peers.credential.issueTitle')}</Heading>
            <p className="text-sm text-content-muted">{t('peers.credential.issueDescription')}</p>
            {error && <InlineNotice variant="error">{error}</InlineNotice>}
            {detail.agentsCapped ? (
                <p className="text-xs text-content-muted" data-testid="peer-credential-agents-capped">
                    {t('peers.credential.agentsCapped', { count: detail.agentsCapped })}
                </p>
            ) : null}
            <FormField label={t('peers.credential.agentLabel')} required>
                <Combobox
                    id="peer-credential-agent"
                    options={agentOptions}
                    selected={agent}
                    setSelected={setAgent}
                    placeholder={t('peers.credential.agentPlaceholder')}
                    matchTriggerWidth
                    forceDropdown
                />
            </FormField>
            <FormField label={t('peers.credential.workflowsLabel')} required>
                <Combobox
                    id="peer-credential-workflows"
                    multiple
                    options={workflowOptions}
                    selected={workflows}
                    setSelected={setWorkflows}
                    placeholder={t('peers.credential.workflowsPlaceholder')}
                    matchTriggerWidth
                    forceDropdown
                />
            </FormField>
            <Button type="submit" variant="secondary" size="sm" disabled={!canSubmit} data-testid="peer-credential-issue">
                {t('peers.credential.submitIssue')}
            </Button>
        </form>
    );
}

/**
 * The token, ONCE. Shown in place after an issue and gone on Done or on
 * leaving the page: it lives only in this component's state, never in a URL,
 * a store or the page data.
 */
function IssuedTokenPanel({ issued, onDone }: { issued: IssuedHandover; onDone: () => void }) {
    const t = useTranslations('agents');
    return (
        <Card className="space-y-default" data-testid="peer-credential-token-panel">
            <Heading level={2}>{t('peers.credential.tokenTitle')}</Heading>
            <InlineNotice variant="warning">{t('peers.credential.tokenNotice')}</InlineNotice>
            <dl className="space-y-default text-sm">
                <Fact label={t('peers.credential.token')}>
                    <CopyText value={issued.token} label={t('peers.credential.copyToken')}>
                        <span className="font-mono text-xs break-all" data-testid="peer-credential-token">
                            {issued.token}
                        </span>
                    </CopyText>
                </Fact>
                {issued.endpointPath && (
                    <Fact label={t('peers.credential.endpoint')}>
                        <span className="font-mono text-xs break-all">{issued.endpointPath}</span>
                    </Fact>
                )}
                <Fact label={t('peers.credential.identity')}>
                    {issued.inflectIdentity ? (
                        <span className="font-mono text-xs break-all">{issued.inflectIdentity}</span>
                    ) : (
                        <span className="text-content-muted">{t('peers.credential.originMissing')}</span>
                    )}
                </Fact>
                <Fact label={t('peers.credential.publicKey')}>
                    {issued.inflectSigningPublicKey ? (
                        <span className="font-mono text-xs break-all">{issued.inflectSigningPublicKey}</span>
                    ) : (
                        <span className="text-content-muted">{t('peers.credential.keyMissing')}</span>
                    )}
                </Fact>
            </dl>
            <Button type="button" variant="secondary" size="sm" onClick={onDone} data-testid="peer-credential-token-done">
                {t('peers.credential.done')}
            </Button>
        </Card>
    );
}

// ─── Messages ────────────────────────────────────────────────────────────────

function MessagesTab({ detail }: { detail: PeerDetail }) {
    const t = useTranslations('agents');
    const columns = useMemo(
        () =>
            createColumns<MessageRow>([
                {
                    id: 'time',
                    header: t('peers.messages.colTime'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.createdAt)}</span>,
                },
                {
                    id: 'direction',
                    header: t('peers.messages.colDirection'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-sm">
                            {row.original.direction === 'INBOUND'
                                ? t('peers.messages.directionInbound')
                                : t('peers.messages.directionOutbound')}
                        </span>
                    ),
                },
                {
                    id: 'kind',
                    header: t('peers.messages.colKind'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const kindKey = MESSAGE_KIND_KEY[row.original.kind];
                        const methodKey = row.original.method ? MESSAGE_METHOD_KEY[row.original.method] : undefined;
                        return (
                            <span className="text-sm">
                                {kindKey ? t(kindKey) : row.original.kind}
                                {row.original.method ? ` · ${methodKey ? t(methodKey) : row.original.method}` : ''}
                            </span>
                        );
                    },
                },
                {
                    id: 'message',
                    header: t('peers.messages.colMessage'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="font-mono text-xs break-all">{row.original.messageId}</span>,
                },
                {
                    id: 'key',
                    header: t('peers.messages.colKey'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="font-mono text-xs">{row.original.signerKeyFingerprint.slice(0, 16)}…</span>
                    ),
                },
                {
                    id: 'receipt',
                    header: t('peers.messages.colReceipt'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const v = row.original.verifies;
                        return (
                            <StatusBadge
                                variant={v === true ? 'success' : v === false ? 'error' : 'neutral'}
                                size="sm"
                                data-testid={`peer-message-verifies-${row.original.id}`}
                            >
                                {v === true
                                    ? t('peers.messages.verifiesYes')
                                    : v === false
                                      ? t('peers.messages.verifiesNo')
                                      : t('peers.messages.verifiesUnknown')}
                            </StatusBadge>
                        );
                    },
                },
            ]),
        [t],
    );
    return (
        <div className="space-y-default">
            {detail.messagesCapped ? (
                <InlineNotice variant="info" data-testid="peer-messages-capped">
                    {t('peers.messages.capped', { count: detail.messagesCapped })}
                </InlineNotice>
            ) : null}
            <DataTable<MessageRow>
            data={detail.messages}
            columns={columns}
            getRowId={(r) => r.id}
            selectionEnabled={false}
            resourceName={(plural) => (plural ? t('peers.messages.resourcePlural') : t('peers.messages.resourceSingular'))}
            emptyState={
                <EmptyState title={t('peers.messages.emptyTitle')} description={t('peers.messages.emptyDesc')} />
            }
            data-testid="peer-messages-table"
            />
        </div>
    );
}
