'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { useToast } from '@/components/ui/hooks';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import {
    useEntityListIds,
    usePublishDisplayedOrder,
} from '@/lib/hooks/use-entity-list-ids';
import { MetaStrip } from '@/components/ui/meta-strip';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import {
    AUDIT_CYCLE_STATUS_VARIANT,
    AUDIT_PACK_STATUS_VARIANT,
    AUDIT_STATUS_VARIANT,
    DEFAULT_STATUS_VARIANT,
} from '../../_lib/status-variants';

const FW_META: Record<string, { icon: AppIconName; label: string }> = {
    ISO27001: { icon: 'shield', label: 'ISO/IEC 27001:2022' },
    NIS2: { icon: 'globe', label: 'NIS2 Directive' },
};

// cycle   → getAuditCycle (audit-readiness/cycles.ts)
// preview → previewDefaultPack (audit-readiness/packs.ts)
interface AuditCyclePack {
    id: string;
    name: string;
    status: string;
}
interface AuditCycleAudit {
    id: string;
    title: string;
    status: string;
    frameworkKey: string | null;
}
interface AuditCycleDetail {
    id: string;
    name: string;
    frameworkKey: string;
    frameworkVersion: string;
    status: string;
    packs: AuditCyclePack[];
    audits: AuditCycleAudit[];
}

const CYCLE_STATUSES = ['PLANNING', 'IN_PROGRESS', 'READY', 'COMPLETE'] as const;
interface DefaultPackSelectionBucket {
    count: number;
    ids: string[];
}
interface DefaultPackPreview {
    frameworkKey: string;
    selection: {
        controls: DefaultPackSelectionBucket;
        policies: DefaultPackSelectionBucket;
        evidence: DefaultPackSelectionBucket;
        issues: DefaultPackSelectionBucket;
    };
    totalItems: number;
}

export default function CycleDetailPage() {
    const tx = useTranslations('audits');
    const params = useParams();
    const router = useRouter();
    const tenantSlug = params.tenantSlug as string;
    const cycleId = params.cycleId as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const toast = useToast();

    const [creating, setCreating] = useState(false);

    // fix/audits-surface — a network blip on the initial load must surface a
    // real error+retry state, not the "cycle not found" empty state. Without a
    // .catch the rejected promise left `cycle` null and the !cycle branch
    // masqueraded as a 404. `load` is re-callable so the retry button can
    // re-fetch in place.
    // Two hand-rolled fetches became two SWR keys. The distinction the old
    // code fought for is kept and made structural: SWR's `error` is the
    // network blip (retryable), `data === null` is the genuine 404 — before,
    // an un-caught rejection left `cycle` null and the !cycle branch
    // masqueraded as "not found".
    const cycleQuery = useTenantSWR<AuditCycleDetail | null>(CACHE_KEYS.audits.cycle(cycleId));
    const cycle = cycleQuery.data ?? null;

    // The preview is advisory — it only populates the "what would a default
    // pack contain" panel, so a failure must not gate the page.
    const previewQuery = useTenantSWR<DefaultPackPreview | null>(
        `${CACHE_KEYS.audits.cycle(cycleId)}?action=default-pack-preview`,
    );
    const preview = previewQuery.data ?? null;

    // #97 — this page is BOTH sides of the stepper contract.
    //
    // READ: the cycles list publishes the order it rendered under
    // `audits.cycles()`; step that order beside the cycle name.
    const cycleIds = useEntityListIds(CACHE_KEYS.audits.cycles());
    // PUBLISH: audit packs have no list route of their own — the pack cards
    // at the bottom of this page are the only surface that renders a pack
    // list, so this is where the pack detail page's stepper order comes from.
    // It reads `useEntityListIds(null, { orderKey: audits.packs() })`, i.e.
    // published-order-or-nothing, so a pack opened without passing through a
    // cycle correctly shows no arrows.
    usePublishDisplayedOrder(CACHE_KEYS.audits.packs(), cycle?.packs);

    const loading = cycleQuery.isLoading;
    // See the sibling comment in `packs/[packId]/page.tsx`: a failed BACKGROUND
    // revalidation (focus / reconnect) must not replace a page that still holds
    // good data, and the guard is `data === undefined` rather than `!data`
    // because `null` is this endpoint's SUCCESSFUL "no such cycle" answer.
    const loadError = Boolean(cycleQuery.error) && cycleQuery.data === undefined;
    const load = useCallback(() => {
        void cycleQuery.mutate();
        void previewQuery.mutate();
    }, [cycleQuery, previewQuery]);

    const createDefaultPack = async () => {
        if (!cycle) return;
        setCreating(true);
        try {
            // 1) Create pack
            const packRes = await fetch(apiUrl('/audits/packs'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auditCycleId: cycleId, name: tx('cycleDetail.defaultPackName', { framework: cycle.frameworkKey }) }),
            });
            if (!packRes.ok) {
                const err = await packRes.json().catch(() => null);
                toast.error(err?.message || tx('cycleDetail.createPackError'));
                setCreating(false);
                return;
            }
            const pack = await packRes.json();

            // 2) Add all items from preview
            if (preview?.selection) {
                const items: { entityType: string; entityId: string; sortOrder: number }[] = [];
                const sel = preview.selection;
                sel.controls?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'CONTROL', entityId: id, sortOrder: i }));
                sel.policies?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'POLICY', entityId: id, sortOrder: 100 + i }));
                sel.evidence?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'EVIDENCE', entityId: id, sortOrder: 200 + i }));
                sel.issues?.ids?.forEach((id: string, i: number) => items.push({ entityType: 'ISSUE', entityId: id, sortOrder: 300 + i }));

                if (items.length > 0) {
                    const itemsRes = await fetch(apiUrl(`/audits/packs/${pack.id}?action=items`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items }),
                    });
                    if (!itemsRes.ok) toast.error(tx('cycleDetail.addItemsError'));
                }
            }
            router.push(`/t/${tenantSlug}/audits/packs/${pack.id}`);
        } catch {
            toast.error(tx('cycleDetail.createPackError'));
        } finally { setCreating(false); }
    };

    // feat/audit-cycle-unify — advance the cycle through its lifecycle
    // (PLANNING → IN_PROGRESS → READY → COMPLETE) so it can be closed.
    const statusMutation = useTenantMutation<AuditCycleDetail | null, string>({
        key: CACHE_KEYS.audits.cycle(cycleId),
        // A single-field flip we can predict exactly, and worth predicting —
        // the whole header re-chromes on the new status. Rollback is what
        // makes it safe: the old code set the state only AFTER `res.ok`, so a
        // failure left the pill correct but the user waiting; an optimistic
        // flip without rollback would have been worse.
        optimisticUpdate: (current, status) => current && { ...current, status },
        mutationFn: async (status) => {
            const res = await fetch(apiUrl(`/audits/cycles/${cycleId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            if (!res.ok) throw new Error(tx('cycleDetail.statusError'));
            return res.json().catch(() => null);
        },
        // The cycle list shows each cycle's status badge.
        invalidate: [CACHE_KEYS.audits.cycles()],
    });
    const savingStatus = statusMutation.isMutating;

    const changeStatus = async (status: string) => {
        if (!cycle || status === cycle.status) return;
        try {
            await statusMutation.trigger(status);
            toast.success(tx('cycleDetail.statusChanged', { status }));
        } catch {
            toast.error(tx('cycleDetail.statusError'));
        }
    };

    const breadcrumbs = [
        { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
        { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
        { label: tx('crumb.cycles'), href: `/t/${tenantSlug}/audits/cycles` },
        { label: cycle?.name ?? tx('cycleDetail.cycleFallback') },
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
                <div className="p-12 text-center space-y-default" role="alert" data-testid="cycle-load-error">
                    <p className="text-content-error">{tx('cycleDetail.loadError')}</p>
                    <Button variant="secondary" onClick={() => load()} id="cycle-load-retry-btn">
                        {tx('cycleDetail.retry')}
                    </Button>
                </div>
            </EntityDetailLayout>
        );
    }
    if (!cycle) {
        return (
            <EntityDetailLayout empty={{ message: tx('cycleDetail.notFound') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const fw = FW_META[cycle.frameworkKey] || { icon: 'shield' as AppIconName, label: cycle.frameworkKey };

    // Localize the fieldwork-audit status enum (PLANNED/IN_PROGRESS/COMPLETED/
    // CANCELLED) via the flat audit-status keys, so the badge isn't a raw enum.
    const AUDIT_STATUS_KEY: Record<string, string> = {
        PLANNED: 'planned', IN_PROGRESS: 'inProgress', COMPLETED: 'completed', CANCELLED: 'cancelled',
    };
    const auditStatusLabel = (status: string) =>
        AUDIT_STATUS_KEY[status] ? tx(AUDIT_STATUS_KEY[status] as Parameters<typeof tx>[0]) : status;

    return (
        <EntityDetailLayout
            id="cycle-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}

            title={
                <span className="inline-flex items-center gap-compact" id="cycle-name">
                    <AppIcon name={fw.icon} size={28} />
                    {cycle.name}
                </span>
            }
            prevNext={{
                ids: cycleIds,
                currentId: cycleId,
                hrefFor: (id) => `/t/${tenantSlug}/audits/cycles/${id}`,
                labelSingular: 'cycle',
            }}
            meta={
                <MetaStrip
                    items={[
                        { label: tx('cycleDetail.framework'), value: fw.label },
                        { label: tx('cycleDetail.version'), value: `v${cycle.frameworkVersion}` },
                        { kind: 'status' as const, label: tx('cycleDetail.status'), value: tx(`cycleStatus.${cycle.status}` as Parameters<typeof tx>[0]), variant: AUDIT_CYCLE_STATUS_VARIANT[cycle.status] ?? DEFAULT_STATUS_VARIANT },
                    ]}
                />
            }
            actions={
                <>
                    {/* feat/audit-cycle-unify — advance/close the cycle. */}
                    <Combobox
                        id="cycle-status-select"
                        hideSearch
                        options={CYCLE_STATUSES.map((s): ComboboxOption => ({ value: s, label: tx(`cycleStatus.${s}` as Parameters<typeof tx>[0]) }))}
                        selected={{ value: cycle.status, label: tx(`cycleStatus.${cycle.status}` as Parameters<typeof tx>[0]) }}
                        setSelected={(opt) => { if (opt) void changeStatus(opt.value); }}
                        disabled={savingStatus}
                        buttonProps={{ variant: 'secondary', className: 'text-sm' }}
                    />
                    <Link
                        href={`/t/${tenantSlug}/audits/cycles/${cycleId}/readiness`}
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                        id="cycle-readiness-link"
                    >
                        {tx('cycles.viewReadiness')}
                    </Link>
                </>
            }
        >
            {/* Default Pack Preview */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div className="flex items-center justify-between">
                    <Heading level={2}>{tx('cycleDetail.defaultPackPreview')}</Heading>
                    <Button variant="primary" onClick={createDefaultPack} disabled={creating || preview === null} id="create-default-pack-btn" icon={<AppIcon name="package" size={16} />}>
                        {creating ? tx('cycleDetail.creating') : tx('cycleDetail.pack')}
                    </Button>
                </div>

                {preview ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-default" id="preview-counts">
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-controls" value={preview.selection?.controls?.count || 0} label={tx('cycleDetail.controls')} />
                        </div>
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-policies" value={preview.selection?.policies?.count || 0} label={tx('cycleDetail.policies')} />
                        </div>
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-evidence" value={preview.selection?.evidence?.count || 0} label={tx('cycleDetail.evidence')} tone="success" />
                        </div>
                        <div className="p-4 rounded-lg bg-bg-default border border-border-default">
                            <KPIStat id="preview-issues" value={preview.selection?.issues?.count || 0} label={tx('cycleDetail.issues')} tone="attention" />
                        </div>
                    </div>
                ) : (
                    <p className="text-content-muted text-sm">{tx('cycleDetail.previewError')}</p>
                )}

                <p className="text-xs text-content-subtle">
                    {tx('cycleDetail.totalItems', { count: preview?.totalItems || 0 })}
                </p>
            </div>

            {/* feat/audit-cycle-unify — fieldwork audits attached to this cycle. */}
            <div className="space-y-compact">
                <div className="flex items-center justify-between">
                    <Heading level={2}>{tx('cycleDetail.fieldworkAudits')}</Heading>
                    <Link
                        href={`/t/${tenantSlug}/audits?cycleId=${cycleId}`}
                        className="text-xs text-content-muted underline underline-offset-2"
                        id="cycle-audits-hub-link"
                    >
                        {tx('cycleDetail.viewInHub')}
                    </Link>
                </div>
                {cycle.audits?.length > 0 ? (
                    cycle.audits.map((a) => (
                        <Link key={a.id} href={`/t/${tenantSlug}/audits?cycleId=${cycleId}`}
                            className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between hover:bg-bg-muted/50 transition block')} id={`cycle-audit-link-${a.id}`}>
                            <span className="font-medium text-sm">{a.title}</span>
                            <StatusBadge variant={AUDIT_STATUS_VARIANT[a.status] ?? DEFAULT_STATUS_VARIANT} className="ml-2">{auditStatusLabel(a.status)}</StatusBadge>
                        </Link>
                    ))
                ) : (
                    <p className="text-content-muted text-sm" data-testid="cycle-no-audits">{tx('cycleDetail.noFieldwork')}</p>
                )}
            </div>

            {/* Existing Packs */}
            {cycle.packs?.length > 0 && (
                <div className="space-y-compact">
                    <Heading level={2}>{tx('cycleDetail.packs')}</Heading>
                    {cycle.packs.map((p) => (
                        <Link key={p.id} href={`/t/${tenantSlug}/audits/packs/${p.id}`}
                            className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between hover:bg-bg-muted/50 transition block')} id={`pack-link-${p.id}`}>
                            <div>
                                <span className="font-medium text-sm">{p.name}</span>
                                <StatusBadge variant={AUDIT_PACK_STATUS_VARIANT[p.status] ?? DEFAULT_STATUS_VARIANT} className="ml-2">{p.status}</StatusBadge>
                            </div>
                            <span className="text-xs text-content-subtle">→</span>
                        </Link>
                    ))}
                </div>
            )}
        </EntityDetailLayout>
    );
}
