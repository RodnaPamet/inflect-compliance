'use client';
import { formatDateTime } from '@/lib/format-date';
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { RequirePermission } from '@/components/require-permission';
import { IconAction } from '@/components/ui/icon-action';
import { Tooltip } from '@/components/ui/tooltip';
import { buttonVariants } from '@/components/ui/button-variants';
import { UpgradeGate } from '@/components/UpgradeGate';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { useCelebration, useToast } from '@/components/ui/hooks';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { scopedMilestone } from '@/lib/celebrations';
import { Package, MessageSquare } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { SharePointExportButton } from './SharePointExportButton';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { AUDIT_PACK_STATUS_VARIANT, DEFAULT_STATUS_VARIANT } from '../../_lib/status-variants';
import { humanizeSnakeCase } from '@/lib/audit/activity-humanize';

const ENTITY_ICON: Record<string, AppIconName> = {
    CONTROL: 'controls', POLICY: 'policies', EVIDENCE: 'evidence', FILE: 'overview', ISSUE: 'warning',
    READINESS_REPORT: 'dashboard', FRAMEWORK_COVERAGE: 'frameworks',
};

// #3 — a generated share link is an UNAUTHENTICATED URL to a full evidence
// pack. Default the expiry to a bounded window so the modal never pre-selects
// a permanent link; the user can still opt into a longer/no expiry explicitly.
const SHARE_EXPIRY_DEFAULT_DAYS = 30;
const defaultShareExpiry = () => new Date(Date.now() + SHARE_EXPIRY_DEFAULT_DAYS * 86_400_000);

// getAuditPack (audit-readiness/packs.ts) — fields this page reads.
interface PackItem {
    id: string;
    entityType: string;
    entityId: string;
    snapshotJson: string | null;
}
interface PackDetail {
    name: string;
    status: string;
    frozenAt: string | null;
    cycle?: { frameworkKey: string } | null;
    frozenBy?: { name: string | null; email: string } | null;
    _count?: { items: number };
    items: PackItem[];
}

interface PackShare {
    id: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
}

// The entity kinds the add-to-pack picker can source from a list API.
type AddableType = 'CONTROL' | 'POLICY' | 'EVIDENCE';

type ShareCommentKind = 'COMMENT' | 'EVIDENCE_REQUEST' | 'FINDING' | 'QUESTION';
interface ShareComment {
    id: string;
    kind: ShareCommentKind;
    body: string;
    authorLabel: string;
    status: 'OPEN' | 'RESOLVED';
    auditPackItemId: string | null;
    createdAt: string;
    resolvedAt: string | null;
}

export default function PackDetailPage() {
    const params = useParams();
    const tenantSlug = params.tenantSlug as string;
    const packId = params.packId as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const tx = useTranslations('audits');
    const toast = useToast();

    // #10 — localize a raw enum value through the audits catalog, falling back
    // to a humanized form for any value not (yet) in the catalog (mirrors the
    // AutomationSuggestionsRail pattern). Keeps status / type badges readable
    // even for enum members we haven't explicitly mapped.
    const localizeEnum = (prefix: string, value: string): string =>
        tx.has(`${prefix}.${value}`) ? tx(`${prefix}.${value}`) : humanizeSnakeCase(value);

    const [resolvingId, setResolvingId] = useState<string | null>(null);
    const [freezeConfirmOpen, setFreezeConfirmOpen] = useState(false);
    const [shareLink, setShareLink] = useState<string | null>(null);
    const router = useRouter();

    // Part B — share lifecycle: shares list, expiry-picker modal, revoke.
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [shareExpiry, setShareExpiry] = useState<Date | null>(() => defaultShareExpiry());
    const [revokeShareTarget, setRevokeShareTarget] = useState<string | null>(null);

    // Part C — add-to-pack picker.
    const [addModalOpen, setAddModalOpen] = useState(false);
    const [addType, setAddType] = useState<AddableType>('CONTROL');
    const [addOptions, setAddOptions] = useState<Array<{ id: string; label: string }>>([]);
    const [addOptionsLoading, setAddOptionsLoading] = useState(false);
    const [addSelected, setAddSelected] = useState('');

    // ─── Reads ───
    //
    // Three hand-rolled `fetch` + `useEffect` + `useState` triples became three
    // SWR keys. The keys are the same strings the mutations below target, which
    // is the property that makes an optimistic update land: a mutation keyed on
    // a near-miss string silently updates nothing and the UI just waits for the
    // revalidation.
    //
    // #5 — a network blip must surface as a retryable error, NOT the "pack not
    // found" empty state (which reads as a genuine 404). SWR's `error` keeps
    // that distinction: `error` is the blip, `data === null` is the 404.
    const packQuery = useTenantSWR<PackDetail | null>(CACHE_KEYS.audits.pack(packId));
    const pack = packQuery.data ?? null;
    const loading = packQuery.isLoading;
    const loadError = Boolean(packQuery.error);

    // Both sub-feeds are supplementary: a failure leaves the pack usable, so
    // neither gates the page.
    const commentsQuery = useTenantSWR<{ comments?: ShareComment[]; openCount?: number }>(
        CACHE_KEYS.audits.packShareComments(packId),
    );
    const comments = commentsQuery.data?.comments ?? [];
    const openCount = commentsQuery.data?.openCount ?? 0;

    const sharesQuery = useTenantSWR<PackShare[]>(CACHE_KEYS.audits.packShares(packId));
    const shares = sharesQuery.data ?? [];

    const loadPack = useCallback(() => { void packQuery.mutate(); }, [packQuery]);
    const loadComments = useCallback(() => { void commentsQuery.mutate(); }, [commentsQuery]);
    const loadShares = useCallback(() => { void sharesQuery.mutate(); }, [sharesQuery]);

    // ─── Writes ───
    //
    // Seven POSTs that each re-decided their own error handling, cache
    // invalidation and (absent) rollback. They now share one lifecycle:
    // optimistic prediction → request → rollback on throw → revalidate. The
    // freeze/export flows are why this matters most here — a failed freeze that
    // left the badge reading FROZEN was the worst available outcome, because
    // FROZEN is the state the whole export path keys off.
    //
    // `postJson` is the one place the wire format lives. Every one of these
    // endpoints is `POST` + JSON + an `{ message }` error envelope, and seven
    // copies of that is how the error handling drifted apart in the first place.
    const postJson = useCallback(
        async (path: string, body: unknown, fallbackMessage: string) => {
            const res = await fetch(apiUrl(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                throw new Error(err?.message || fallbackMessage);
            }
            return res.json().catch(() => null);
        },
        [apiUrl],
    );

    const resolveMutation = useTenantMutation<
        { comments?: ShareComment[]; openCount?: number },
        string
    >({
        key: CACHE_KEYS.audits.packShareComments(packId),
        // Resolving is a single-field flip we can predict exactly, and the open
        // counter has to move with it or the tab badge lies until revalidation.
        optimisticUpdate: (current, id) =>
            current && {
                ...current,
                comments: (current.comments ?? []).map((c) =>
                    c.id === id ? { ...c, status: 'RESOLVED' } : c,
                ),
                openCount: Math.max(0, (current.openCount ?? 0) - 1),
            },
        mutationFn: (id) =>
            postJson(
                `/audits/packs/${packId}/share-comments/${id}/resolve`,
                {},
                tx('packs.auditorActivity.resolveError'),
            ),
    });

    const resolveComment = async (id: string) => {
        setResolvingId(id);
        try {
            await resolveMutation.trigger(id);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.auditorActivity.resolveError'));
        } finally { setResolvingId(null); }
    };

    // feat/audit-cycle-unify — turn a FINDING / EVIDENCE_REQUEST into a real
    // Finding (+ remediation Task) tied to the cycle, then resolve it.
    const [materializingId, setMaterializingId] = useState<string | null>(null);
    const materializeMutation = useTenantMutation<
        { comments?: ShareComment[]; openCount?: number },
        string
    >({
        key: CACHE_KEYS.audits.packShareComments(packId),
        // No optimistic prediction: the server mints a Finding and a Task, so
        // the resulting row is not derivable client-side. The honest answer is
        // to wait rather than paint a guess.
        mutationFn: (id) =>
            postJson(
                `/audits/packs/${packId}/share-comments/${id}/materialize`,
                {},
                tx('packs.auditorActivity.materializeError'),
            ),
        invalidate: [CACHE_KEYS.findings.list()],
    });

    const materializeComment = async (id: string) => {
        setMaterializingId(id);
        try {
            await materializeMutation.trigger(id);
            toast.success(tx('packs.auditorActivity.findingCreated'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.auditorActivity.materializeError'));
        } finally { setMaterializingId(null); }
    };

    const freezeMutation = useTenantMutation<PackDetail | null, void>({
        key: CACHE_KEYS.audits.pack(packId),
        // The optimistic flip is the reason this one is worth predicting: the
        // whole page re-chromes on FROZEN. Rollback is what makes it safe —
        // before, a failed freeze left the badge claiming a state the server
        // had refused.
        optimisticUpdate: (current) => current && { ...current, status: 'FROZEN' },
        mutationFn: () =>
            postJson(`/audits/packs/${packId}?action=freeze`, {}, tx('packs.failedFreeze')),
        invalidate: [CACHE_KEYS.audits.packs()],
    });
    const freezing = freezeMutation.isMutating;

    const freeze = async () => {
        try {
            await freezeMutation.trigger();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.failedFreeze'));
        }
    };

    const shareMutation = useTenantMutation<PackShare[], { expiresAt?: string }, { token: string }>({
        key: CACHE_KEYS.audits.packShares(packId),
        // The share row's id and token are server-minted, so there is nothing
        // to predict — the list refreshes when the response lands.
        mutationFn: (input) =>
            postJson(`/audits/packs/${packId}?action=share`, input, tx('packs.shareError')),
    });
    const sharing = shareMutation.isMutating;

    const submitShare = async () => {
        try {
            const data = await shareMutation.trigger({
                expiresAt: shareExpiry ? shareExpiry.toISOString() : undefined,
            });
            setShareLink(`${window.location.origin}/audit/shared/${data.token}`);
            setShareModalOpen(false);
            setShareExpiry(defaultShareExpiry());
            toast.success(tx('packs.shareCreated'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.shareError'));
        }
    };

    const revokeShareMutation = useTenantMutation<PackShare[], string>({
        key: CACHE_KEYS.audits.packShares(packId),
        optimisticUpdate: (current, shareId) =>
            current?.filter((sh) => sh.id !== shareId),
        mutationFn: (shareId) =>
            postJson(
                `/audits/packs/${packId}?action=revoke-share`,
                { shareId },
                tx('packs.shareRevokeError'),
            ),
    });

    const revokeShareById = async (shareId: string) => {
        try {
            await revokeShareMutation.trigger(shareId);
            // #3 — clear the freshly-generated "Share Link Generated" card so it
            // can't keep displaying a live token URL for a share that's now
            // revoked (the raw token is never retrievable again anyway).
            setShareLink(null);
            toast.success(tx('packs.shareRevoked'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.shareRevokeError'));
        }
    };

    const cloneMutation = useTenantMutation<PackDetail | null, void, { id: string }>({
        // A clone mints a NEW pack, so it belongs to the LIST cache — keying it
        // on this pack's detail entry would optimistically corrupt the pack the
        // user is still looking at.
        key: CACHE_KEYS.audits.packs(),
        mutationFn: () =>
            postJson(`/audits/packs/${packId}?action=clone`, {}, tx('packs.cloneError')),
    });
    const cloning = cloneMutation.isMutating;

    const clone = async () => {
        try {
            const cloned = await cloneMutation.trigger();
            router.push(`/t/${tenantSlug}/audits/packs/${cloned.id}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.cloneError'));
        }
    };

    // Part C — add-to-pack: fetch candidate entities for the chosen type.
    const ADD_TYPE_ENDPOINT: Record<AddableType, string> = {
        CONTROL: '/controls', POLICY: '/policies', EVIDENCE: '/evidence',
    };
    const loadAddOptions = useCallback((type: AddableType) => {
        setAddOptionsLoading(true);
        setAddOptions([]);
        setAddSelected('');
        fetch(apiUrl(ADD_TYPE_ENDPOINT[type]))
            .then(r => r.ok ? r.json() : null)
            .then((d) => {
                const rows: Array<Record<string, unknown>> = Array.isArray(d) ? d : (d?.rows ?? []);
                setAddOptions(rows.map((row) => ({
                    id: String(row.id),
                    label: String(row.code || row.title || row.name || row.id),
                })));
            })
            .catch(() => toast.error(tx('packs.addPicker.loadError')))
            .finally(() => setAddOptionsLoading(false));
    // ADD_TYPE_ENDPOINT is a stable inline literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiUrl, toast, tx]);

    const openAddModal = () => {
        setAddModalOpen(true);
        setAddType('CONTROL');
        loadAddOptions('CONTROL');
    };

    const addItemMutation = useTenantMutation<
        PackDetail | null,
        { entityType: AddableType; entityId: string; label: string }
    >({
        key: CACHE_KEYS.audits.pack(packId),
        // No optimistic prediction: a pack item carries a server-assigned id and
        // sortOrder, and inventing them would make the row jump on revalidation.
        mutationFn: ({ entityType, entityId, label }) =>
            postJson(
                `/audits/packs/${packId}?action=items`,
                { items: [{ entityType, entityId, snapshotJson: JSON.stringify({ title: label }) }] },
                tx('packs.addPicker.addError'),
            ),
    });
    const addBusy = addItemMutation.isMutating;

    const submitAddItem = async () => {
        if (!addSelected) return;
        const label = addOptions.find((o) => o.id === addSelected)?.label ?? addSelected;
        try {
            await addItemMutation.trigger({ entityType: addType, entityId: addSelected, label });
            setAddModalOpen(false);
            setAddSelected('');
            toast.success(tx('packs.addPicker.added'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : tx('packs.addPicker.addError'));
        }
    };

    // Epic 62 — celebrate when the pack reaches its "complete" state
    // (FROZEN or its downstream EXPORTED). Per-pack dedupe key so a
    // user managing several packs in the same session gets one
    // celebration per pack, not one per session globally.
    //
    // The effect must sit BEFORE the early returns above so React's
    // hook order stays stable across loading → loaded transitions.
    const { celebrate } = useCelebration();
    const packStatus: string | undefined = pack?.status;
    const packComplete = packStatus === 'FROZEN' || packStatus === 'EXPORTED';
    const packName: string | undefined = pack?.name;
    useEffect(() => {
        if (!packComplete) return;
        celebrate(
            scopedMilestone('audit-pack-complete', packId, {
                descriptionOverride: packName
                    ? tx('packs.celebrateDesc', { name: packName })
                    : undefined,
            }),
        );
    }, [packComplete, packId, packName, celebrate]);

    const breadcrumbs = [
        { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
        { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
        { label: tx('crumb.cycles'), href: `/t/${tenantSlug}/audits/cycles` },
        { label: pack?.name ?? tx('packs.crumbFallback') },
    ];
    if (loading) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (loadError) {
        return (
            <EntityDetailLayout title="" back={{ smart: true }} breadcrumbs={breadcrumbs}>
                <div className={cardVariants({ density: 'none' })}>
                    <EmptyState
                        icon={Package}
                        title={tx('packs.loadError')}
                        description={tx('packs.loadErrorDesc')}
                    >
                        <Button variant="secondary" size="sm" onClick={loadPack} id="pack-retry-btn">
                            {tx('packs.retry')}
                        </Button>
                    </EmptyState>
                </div>
            </EntityDetailLayout>
        );
    }
    if (!pack) {
        return (
            <EntityDetailLayout empty={{ message: tx('packs.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const isDraft = pack.status === 'DRAFT';
    const isFrozen = pack.status === 'FROZEN' || pack.status === 'EXPORTED';

    // Group items by entity type
    const grouped: Record<string, PackItem[]> = {};
    (pack.items || []).forEach((item) => {
        if (!grouped[item.entityType]) grouped[item.entityType] = [];
        grouped[item.entityType].push(item);
    });

    return (
        <EntityDetailLayout
            id="pack-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}

            title={<span id="pack-name">{pack.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        ...(pack.cycle?.frameworkKey
                            ? [
                                  {
                                      label: tx('packs.framework'),
                                      value: pack.cycle.frameworkKey,
                                  } as const,
                              ]
                            : []),
                        {
                            label: tx('packs.items'),
                            value: pack._count?.items || 0,
                        },
                        {
                            kind: 'status',
                            id: 'pack-status',
                            label: tx('packs.status'),
                            value: localizeEnum('packStatus', pack.status),
                            variant: AUDIT_PACK_STATUS_VARIANT[pack.status] ?? DEFAULT_STATUS_VARIANT,
                        },
                        ...(pack.frozenAt
                            ? [
                                  {
                                      label: tx('packs.frozen'),
                                      value: `${formatDateTime(pack.frozenAt)} · ${pack.frozenBy?.name || pack.frozenBy?.email || tx('packs.adminFallback')}`,
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
            actions={
                <>
                    {isDraft && (
                        <RequirePermission resource="audits" action="manage">
                            <IconAction variant="secondary" onClick={openAddModal} id="add-pack-items-btn" icon={<AppIcon name="package" size={16} />} label={tx('packs.addItems')} />
                        </RequirePermission>
                    )}
                    {isDraft && (
                        <RequirePermission resource="audits" action="freeze">
                            {/* #2 — freeze is one-way (there is no server un-freeze), so
                                gate the irreversible write behind a ConfirmDialog instead
                                of firing on a single click. The trigger stays icon-only
                                (locked by icon-only-action-discipline); the confirm surface
                                below carries the visible label + irreversibility warning. */}
                            <IconAction variant="primary" onClick={() => setFreezeConfirmOpen(true)} loading={freezing} id="freeze-pack-btn" icon={<AppIcon name="lock" size={16} />} label={tx('packs.freezePack')} />
                        </RequirePermission>
                    )}
                    {isFrozen && (
                        <RequirePermission resource="audits" action="share">
                            <UpgradeGate feature="AUDIT_PACK_SHARING">
                                <IconAction variant="primary" onClick={() => { setShareExpiry(defaultShareExpiry()); setShareModalOpen(true); }} loading={sharing} id="share-pack-btn" icon={<AppIcon name="share" size={16} />} label={tx('packs.generateShareLink')} />
                            </UpgradeGate>
                        </RequirePermission>
                    )}
                    {isFrozen && (
                        <RequirePermission resource="audits" action="manage">
                            <IconAction
                                variant="secondary"
                                onClick={clone}
                                loading={cloning}
                                id="clone-pack-btn"
                                icon={<AppIcon name="refresh" size={16} />}
                                label={tx('packs.cloneForRetest')}
                            />
                        </RequirePermission>
                    )}
                    {isFrozen && (
                        <RequirePermission resource="audits" action="manage">
                            <SharePointExportButton packId={packId} />
                        </RequirePermission>
                    )}
                </>
            }
        >
            {/* Share Link */}
            {shareLink && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-success bg-bg-success animate-fadeIn')} id="share-link-card">
                    <div className="flex items-center justify-between gap-compact">
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-content-success">{tx('packs.shareLinkGenerated')}</p>
                            <p className="text-xs text-content-muted mt-1 break-all" id="share-link-url">{shareLink}</p>
                            {/* #3 — the raw token is returned EXACTLY once; make the
                                one-shot nature explicit right where the Copy button lives. */}
                            <p className="text-xs text-content-warning mt-2 inline-flex items-start gap-tight" id="share-link-once-warning">
                                <AppIcon name="warning" size={14} className="shrink-0 mt-px" />
                                <span>{tx('packs.shareLinkOnceWarning')}</span>
                            </p>
                        </div>
                        <CopyButton
                            value={shareLink}
                            label={tx('packs.copyShareLink')}
                            successMessage={tx('packs.shareLinkCopied')}
                            size="sm"
                        />
                    </div>
                </div>
            )}

            {/* Share links — active + revoked (Part B) */}
            {isFrozen && (
                <div className={cardVariants()} id="pack-shares">
                    <Heading level={3} className="mb-1 inline-flex items-center gap-tight">
                        <AppIcon name="share" size={16} /> {tx('packs.sharesTitle')}
                    </Heading>
                    <p className="text-xs text-content-subtle mb-1">{tx('packs.sharesDesc')}</p>
                    {/* #3 — active links carry no copy affordance because the raw token
                        is shown only once at creation; say so instead of leaving a
                        silent gap. */}
                    <p className="text-xs text-content-warning mb-3 inline-flex items-start gap-tight">
                        <AppIcon name="warning" size={14} className="shrink-0 mt-px" />
                        <span>{tx('packs.sharesOnceNote')}</span>
                    </p>
                    {shares.length === 0 ? (
                        <p className="text-sm text-content-subtle">{tx('packs.sharesEmpty')}</p>
                    ) : (
                        <ul className="divide-y divide-border-default/50">
                            {shares.map((s) => {
                                const expired = !s.revokedAt && s.expiresAt && new Date(s.expiresAt) < new Date();
                                const active = !s.revokedAt && !expired;
                                return (
                                    <li key={s.id} className="py-3 flex items-center justify-between gap-compact">
                                        <div className="min-w-0 text-sm">
                                            <div className="flex flex-wrap items-center gap-tight">
                                                <StatusBadge variant={s.revokedAt ? 'warning' : expired ? 'neutral' : 'success'}>
                                                    {s.revokedAt ? tx('packs.shareStateRevoked') : expired ? tx('packs.shareStateExpired') : tx('packs.shareStateActive')}
                                                </StatusBadge>
                                                <span className="text-xs text-content-subtle">{tx('packs.shareCreatedOn', { date: formatDateTime(s.createdAt) })}</span>
                                            </div>
                                            <p className="text-xs text-content-subtle mt-1">
                                                {s.expiresAt ? tx('packs.shareExpiresOn', { date: formatDateTime(s.expiresAt) }) : tx('packs.shareNoExpiry')}
                                            </p>
                                        </div>
                                        {active && (
                                            <RequirePermission resource="audits" action="share">
                                                <Button variant="secondary" size="sm" onClick={() => setRevokeShareTarget(s.id)} id={`revoke-share-${s.id}`}>
                                                    {tx('packs.revokeShare')}
                                                </Button>
                                            </RequirePermission>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}

            {/* Items grouped by type */}
            {Object.keys(grouped).length === 0 ? (
                <div className={cardVariants({ density: 'none' })}>
                    <EmptyState
                        icon={Package}
                        title={tx('packs.itemsEmptyTitle')}
                        description={tx('packs.itemsEmptyDesc')}
                    >
                        {isDraft && (
                            <RequirePermission resource="audits" action="manage">
                                <Button variant="secondary" size="sm" onClick={openAddModal} id="add-pack-items-empty-btn">
                                    {tx('packs.addItems')}
                                </Button>
                            </RequirePermission>
                        )}
                    </EmptyState>
                </div>
            ) : (
                Object.entries(grouped).map(([type, items]) => (
                    <div key={type} className="space-y-tight">
                        <Heading level={3} className="flex items-center gap-tight">
                            <AppIcon name={ENTITY_ICON[type] || 'overview'} size={16} />
                            <span>{localizeEnum('packs.entityType', type)}</span>
                            <span className="text-content-subtle">({items.length})</span>
                        </Heading>
                        <div className={cn(cardVariants({ density: 'none' }), 'divide-y divide-border-default/50')}>
                            {items.slice(0, 50).map((item) => {
                                let snap: { code?: string; title?: string; name?: string; description?: string; status?: string; taskCompletion?: { done: number; total: number }; evidenceCount?: number } = {};
                                try { snap = JSON.parse(item.snapshotJson || '{}'); } catch { /* */ }
                                const name = snap.code || snap.title || snap.name || item.entityId;
                                const status = snap.status || '';
                                return (
                                    <div key={item.id} className="p-3 flex items-center justify-between text-sm">
                                        <div className="flex-1 min-w-0">
                                            <span className="font-medium truncate block">{name}</span>
                                            {snap.description && <span className="text-xs text-content-subtle truncate block">{snap.description}</span>}
                                        </div>
                                        <div className="flex items-center gap-tight ml-4">
                                            {status && <StatusBadge variant="neutral">{localizeEnum('packs.itemStatus', status)}</StatusBadge>}
                                            {snap.taskCompletion && (
                                                <span className="text-xs text-content-subtle">
                                                    {tx('packs.tasks', { done: snap.taskCompletion.done, total: snap.taskCompletion.total })}
                                                </span>
                                            )}
                                            {snap.evidenceCount !== undefined && (
                                                <span className="text-xs text-content-subtle">
                                                    {tx('packs.evidence', { count: snap.evidenceCount })}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))
            )}

            {/* Auditor activity — the return channel from shared packs */}
            <div className={cardVariants()} id="auditor-activity">
                <div className="flex items-center justify-between mb-1">
                    <Heading level={3} className="inline-flex items-center gap-tight">
                        <MessageSquare size={16} /> {tx('packs.auditorActivity.title')}
                        {openCount > 0 && (
                            <StatusBadge variant="warning">{tx('packs.auditorActivity.openBadge', { count: openCount })}</StatusBadge>
                        )}
                    </Heading>
                </div>
                <p className="text-xs text-content-subtle mb-3">{tx('packs.auditorActivity.desc')}</p>
                {comments.length === 0 ? (
                    <EmptyState
                        icon={MessageSquare}
                        title={tx('packs.auditorActivity.empty')}
                        description={tx('packs.auditorActivity.emptyDesc')}
                    />
                ) : (
                    <ul className="divide-y divide-border-default/50">
                        {comments.map((c) => {
                            const item = c.auditPackItemId
                                ? (pack.items || []).find((i) => i.id === c.auditPackItemId)
                                : undefined;
                            let itemName: string | undefined;
                            if (item) {
                                try {
                                    const snap = JSON.parse(item.snapshotJson || '{}');
                                    itemName = snap.code || snap.title || snap.name || item.entityId;
                                } catch { itemName = item.entityId; }
                            }
                            const actionable = c.kind !== 'COMMENT';
                            return (
                                <li key={c.id} className="py-3">
                                    <div className="flex items-start justify-between gap-compact">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-tight mb-1">
                                                <StatusBadge variant={c.kind === 'FINDING' ? 'error' : c.kind === 'EVIDENCE_REQUEST' ? 'warning' : 'info'}>
                                                    {tx(`packs.auditorActivity.kind.${c.kind}`)}
                                                </StatusBadge>
                                                {actionable && (
                                                    <StatusBadge variant={c.status === 'OPEN' ? 'neutral' : 'success'}>
                                                        {tx(`packs.auditorActivity.status${c.status}`)}
                                                    </StatusBadge>
                                                )}
                                                <span className="text-xs text-content-subtle">{c.authorLabel}</span>
                                                <span className="text-xs text-content-subtle">· {formatDateTime(c.createdAt)}</span>
                                                {itemName && <span className="text-xs text-content-subtle truncate">· {tx('packs.auditorActivity.onItem', { item: itemName })}</span>}
                                            </div>
                                            <p className="text-sm whitespace-pre-wrap break-words">{c.body}</p>
                                        </div>
                                        {actionable && c.status === 'OPEN' && (
                                            <RequirePermission resource="audits" action="share">
                                                <div className="flex gap-tight shrink-0">
                                                    {/* FINDING / EVIDENCE_REQUEST get a remediation lifecycle,
                                                        not just a status flip. */}
                                                    {(c.kind === 'FINDING' || c.kind === 'EVIDENCE_REQUEST') && (
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={() => materializeComment(c.id)}
                                                            loading={materializingId === c.id}
                                                            disabled={materializingId === c.id || resolvingId === c.id}
                                                            data-testid={`materialize-comment-${c.id}`}
                                                        >
                                                            {/* Label per kind — a FINDING becomes a nonconformity
                                                                finding; an EVIDENCE_REQUEST becomes an observation
                                                                finding + follow-up task. */}
                                                            {c.kind === 'FINDING'
                                                                ? tx('packs.auditorActivity.createFinding')
                                                                : tx('packs.auditorActivity.createObservation')}
                                                        </Button>
                                                    )}
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => resolveComment(c.id)}
                                                        loading={resolvingId === c.id}
                                                        disabled={resolvingId === c.id || materializingId === c.id}
                                                    >
                                                        {resolvingId === c.id ? tx('packs.auditorActivity.resolving') : tx('packs.auditorActivity.resolve')}
                                                    </Button>
                                                </div>
                                            </RequirePermission>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {/* Export area (placeholder) */}
            {isFrozen && (
                <div className={cardVariants()}>
                    <Heading level={3} className="mb-2 inline-flex items-center gap-tight"><AppIcon name="export" size={16} /> {tx('packs.exports')}</Heading>
                    <div className="flex gap-tight">
                        <Tooltip content={tx('packs.exportJson')}>
                            <a href={apiUrl(`/audits/packs/${packId}?action=export&format=json`)}
                                target="_blank" rel="noopener" aria-label={tx('packs.exportJson')} className={buttonVariants({ variant: 'secondary', size: 'icon' })}><AppIcon name="fileJson" size={16} /></a>
                        </Tooltip>
                        <Tooltip content={tx('packs.exportCsv')}>
                            <a href={apiUrl(`/audits/packs/${packId}?action=export&format=csv`)}
                                target="_blank" rel="noopener" aria-label={tx('packs.exportCsv')} className={buttonVariants({ variant: 'secondary', size: 'icon' })}><AppIcon name="fileSpreadsheet" size={16} /></a>
                        </Tooltip>
                    </div>
                </div>
            )}

            {/* Share-with-expiry modal (Part B) */}
            <Modal showModal={shareModalOpen} setShowModal={setShareModalOpen} size="md" title={tx('packs.shareModal.title')} preventDefaultClose={sharing}>
                <Modal.Header title={tx('packs.shareModal.title')} description={tx('packs.shareModal.desc')} />
                <Modal.Body>
                    <div className="space-y-default">
                        <div className="flex flex-wrap gap-tight">
                            {[7, 30, 90].map((days) => (
                                <Button
                                    key={days}
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setShareExpiry(new Date(Date.now() + days * 86400000))}
                                    id={`share-preset-${days}`}
                                >
                                    {tx('packs.shareModal.presetDays', { days })}
                                </Button>
                            ))}
                            <Button variant="secondary" size="sm" onClick={() => setShareExpiry(null)} id="share-preset-none">
                                {tx('packs.shareModal.noExpiry')}
                            </Button>
                        </div>
                        <FormField label={tx('packs.shareModal.expiryLabel')}>
                            <DatePicker
                                id="share-expiry-date"
                                placeholder={tx('packs.shareModal.expiryPlaceholder')}
                                clearable
                                align="start"
                                value={shareExpiry}
                                onChange={(next) => setShareExpiry(next)}
                                disabledDays={{ before: new Date() }}
                                aria-label={tx('packs.shareModal.expiryLabel')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" onClick={() => setShareModalOpen(false)} disabled={sharing} id="share-modal-cancel">
                        {tx('packs.shareModal.cancel')}
                    </Button>
                    <Button variant="primary" size="sm" onClick={submitShare} loading={sharing} disabled={sharing} id="share-modal-submit">
                        {tx('packs.shareModal.submit')}
                    </Button>
                </Modal.Actions>
            </Modal>

            {/* Add-to-pack modal (Part C) */}
            <Modal showModal={addModalOpen} setShowModal={setAddModalOpen} size="md" title={tx('packs.addPicker.title')} preventDefaultClose={addBusy}>
                <Modal.Header title={tx('packs.addPicker.title')} description={tx('packs.addPicker.desc')} />
                <Modal.Body>
                    <div className="space-y-default">
                        <FormField label={tx('packs.addPicker.typeLabel')}>
                            <Combobox
                                options={[
                                    { value: 'CONTROL', label: tx('packs.addPicker.typeControl') },
                                    { value: 'POLICY', label: tx('packs.addPicker.typePolicy') },
                                    { value: 'EVIDENCE', label: tx('packs.addPicker.typeEvidence') },
                                ]}
                                selected={{ value: addType, label: tx(`packs.addPicker.type${addType.charAt(0) + addType.slice(1).toLowerCase()}` as 'packs.addPicker.typeControl') }}
                                setSelected={(opt) => { if (opt) { const t = opt.value as AddableType; setAddType(t); loadAddOptions(t); } }}
                                hideSearch
                                matchTriggerWidth
                                aria-label={tx('packs.addPicker.typeLabel')}
                            />
                        </FormField>
                        <FormField label={tx('packs.addPicker.itemLabel')}>
                            <Combobox
                                options={addOptions.map((o): ComboboxOption => ({ value: o.id, label: o.label }))}
                                selected={addOptions.filter((o) => o.id === addSelected).map((o) => ({ value: o.id, label: o.label }))[0] ?? null}
                                setSelected={(opt) => setAddSelected(opt?.value ?? '')}
                                placeholder={addOptionsLoading ? tx('packs.addPicker.loading') : tx('packs.addPicker.itemPlaceholder')}
                                disabled={addOptionsLoading || addOptions.length === 0}
                                matchTriggerWidth
                                aria-label={tx('packs.addPicker.itemLabel')}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" onClick={() => setAddModalOpen(false)} disabled={addBusy} id="add-item-cancel">
                        {tx('packs.addPicker.cancel')}
                    </Button>
                    <Button variant="primary" size="sm" onClick={submitAddItem} loading={addBusy} disabled={addBusy || !addSelected} id="add-item-submit">
                        {tx('packs.addPicker.submit')}
                    </Button>
                </Modal.Actions>
            </Modal>

            {/* Revoke-share confirmation (Part B) */}
            <ConfirmDialog
                showModal={revokeShareTarget !== null}
                setShowModal={(open) => { if (!open) setRevokeShareTarget(null); }}
                tone="danger"
                title={tx('packs.revokeShareModal.title')}
                description={tx('packs.revokeShareModal.desc')}
                confirmLabel={tx('packs.revokeShareModal.confirm')}
                cancelLabel={tx('packs.shareModal.cancel')}
                onConfirm={async () => {
                    if (revokeShareTarget) await revokeShareById(revokeShareTarget);
                    setRevokeShareTarget(null);
                }}
            />

            {/* Freeze confirmation (#2) — freeze is a one-way, irreversible write
                (no server un-freeze). `warning` tone (significant consequence),
                not `danger` — freeze locks rather than destroys. */}
            <ConfirmDialog
                showModal={freezeConfirmOpen}
                setShowModal={setFreezeConfirmOpen}
                tone="warning"
                title={tx('packs.freezeConfirm.title')}
                description={tx('packs.freezeConfirm.desc')}
                confirmLabel={tx('packs.freezeConfirm.confirm')}
                cancelLabel={tx('packs.shareModal.cancel')}
                onConfirm={async () => { await freeze(); setFreezeConfirmOpen(false); }}
            />
        </EntityDetailLayout>
    );
}
