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
import { cn } from '@inflect/ui/lib/cn';
import {
    AUDIT_CYCLE_STATUS_VARIANT,
    AUDIT_PACK_STATUS_VARIANT,
    AUDIT_STATUS_VARIANT,
    DEFAULT_STATUS_VARIANT,
} from '../../_lib/status-variants';
import { isNotFoundError, useAuditReadinessAccess } from '../../_lib/use-audit-access';
import { apiErrorMessage } from '@/lib/api-error';
import { auditPackRefusal } from '@/lib/audit-pack-refusals';
import { relianceRefusal } from '@/lib/agentic/audit-reliance-refusals';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { DateRangePicker } from '@/components/ui/date-picker/date-range-picker';
import type { DateRangeValue } from '@/components/ui/date-picker/types';
import { formatDate } from '@inflect/ui/lib/format-date';
import { AUDIT_PERIOD_PRESETS } from '../../_lib/audit-period-presets';

// The icon only. The framework's name comes from the catalogue
// (`frameworkName`): this table used to carry English labels for two
// frameworks and show every other one by its key (#4727).
const FW_ICON: Record<string, AppIconName> = { ISO27001: 'shield', NIS2: 'globe' };

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
    /** The catalogue's name, or null when the catalogue has no such framework. */
    frameworkName: string | null;
    frameworkVersion: string;
    periodStartAt: string | null;
    periodEndAt: string | null;
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
    const access = useAuditReadinessAccess();

    const [creating, setCreating] = useState(false);
    // #3681 — the agent-audit reliance pack is assembled and frozen in one
    // call; a refusal (`NO_WORKPAPERS_IN_PERIOD`, …) is shown inline, by
    // name, rather than as a toast that disappears.
    const [assemblingReliance, setAssemblingReliance] = useState(false);
    const [relianceRefusalText, setRelianceRefusalText] = useState<string | null>(null);
    // #4727 — the name and the audit period were set once, at creation, and
    // never shown or changeable after it; the reliance pack refuses a cycle
    // without a period, and its refusal said to "narrow the cycle".
    const [editOpen, setEditOpen] = useState(false);
    const [editName, setEditName] = useState('');
    const [editPeriod, setEditPeriod] = useState<DateRangeValue>({ from: null, to: null });
    const [savingEdit, setSavingEdit] = useState(false);

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
    //
    // #4129 — but the server never answers a missing cycle with `null`: it
    // throws `notFound`, `apiGet` throws on the 404, and the error branch won,
    // so "not found" was unreachable. A 404 is now latched as `missing` (a
    // later blip must not turn it into a retry screen); any other error is
    // still the outage.
    const [missing, setMissing] = useState(false);
    const cycleQuery = useTenantSWR<AuditCycleDetail | null>(CACHE_KEYS.audits.cycle(cycleId), {
        onError: (e) => { if (isNotFoundError(e)) setMissing(true); },
        onSuccess: () => setMissing(false),
    });
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
    const loadError = Boolean(cycleQuery.error) && cycleQuery.data === undefined && !missing;
    const load = useCallback(() => {
        void cycleQuery.mutate();
        void previewQuery.mutate();
    }, [cycleQuery, previewQuery]);

    /** A refusal the pack API names, in the reader's language (#4727). */
    const packRefusalText = (body: unknown, fallback: string): string => {
        const code = auditPackRefusal(body);
        return code ? tx(`packs.refused.${code}` as Parameters<typeof tx>[0]) : apiErrorMessage(body, fallback);
    };

    const openEdit = () => {
        if (!cycle) return;
        setEditName(cycle.name);
        setEditPeriod({
            from: cycle.periodStartAt ? new Date(cycle.periodStartAt) : null,
            to: cycle.periodEndAt ? new Date(cycle.periodEndAt) : null,
        });
        setEditOpen(true);
    };

    const saveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!cycle || !editName.trim()) return;
        setSavingEdit(true);
        try {
            const res = await fetch(apiUrl(`/audits/cycles/${cycleId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                // '' clears a side of the period; the route stores it as null.
                body: JSON.stringify({
                    name: editName.trim(),
                    periodStartAt: editPeriod.from ? editPeriod.from.toISOString() : '',
                    periodEndAt: editPeriod.to ? editPeriod.to.toISOString() : '',
                }),
            });
            if (!res.ok) {
                if (res.status === 404) throw new Error(tx('cycleDetail.notFound'));
                const body = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(body, tx('cycleDetail.saveError')));
            }
            await cycleQuery.mutate();
            void previewQuery.mutate();
            setEditOpen(false);
            toast.success(tx('cycleDetail.saved'));
        } catch (err) {
            toast.error(err instanceof Error && err.message ? err.message : tx('cycleDetail.saveError'));
        } finally {
            setSavingEdit(false);
        }
    };

    const createDefaultPack = async () => {
        if (!cycle) return;
        setCreating(true);
        try {
            // 1) Create pack
            const packRes = await fetch(apiUrl('/audits/packs'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auditCycleId: cycleId, name: tx('cycleDetail.defaultPackName', { framework: cycle.frameworkName ?? cycle.frameworkKey }) }),
            });
            if (!packRes.ok) {
                // `apiErrorMessage`, not `err.message`: the API puts the reason
                // under `error.message`, so the old read always fell back.
                const err = await packRes.json().catch(() => null);
                toast.error(packRefusalText(err, tx('cycleDetail.createPackError')));
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
                    if (!itemsRes.ok) {
                        const err = await itemsRes.json().catch(() => null);
                        toast.error(packRefusalText(err, tx('cycleDetail.addItemsError')));
                    }
                }
            }
            router.push(`/t/${tenantSlug}/audits/packs/${pack.id}`);
        } catch {
            toast.error(tx('cycleDetail.createPackError'));
        } finally { setCreating(false); }
    };

    const assembleReliancePack = async () => {
        setAssemblingReliance(true);
        setRelianceRefusalText(null);
        try {
            const res = await fetch(apiUrl(`/audits/cycles/${cycleId}/reliance-pack`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                // A named refusal (`NO_WORKPAPERS_IN_PERIOD`, …) travels in
                // `error.details.reason`; the page words it (#4727). Anything
                // else keeps the server's message.
                const code = relianceRefusal(body);
                setRelianceRefusalText(code
                    ? tx(`cycleDetail.relianceRefused.${code}` as Parameters<typeof tx>[0])
                    : apiErrorMessage(body, tx('cycleDetail.relianceError')));
                return;
            }
            router.push(`/t/${tenantSlug}/audits/packs/${body.packId}`);
        } catch {
            setRelianceRefusalText(tx('cycleDetail.relianceError'));
        } finally {
            setAssemblingReliance(false);
        }
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
            if (!res.ok) {
                // The route's refusals are a missing cycle and the role gate,
                // and the picker is offered only to roles it admits, so a 404
                // is the one a person can meet: say it in their language.
                if (res.status === 404) throw new Error(tx('cycleDetail.notFound'));
                const body = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(body, tx('cycleDetail.statusError')));
            }
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
            // The label, not the stored value (`IN_PROGRESS`) — #4129.
            toast.success(tx('cycleDetail.statusChanged', { status: tx(`cycleStatus.${status}` as Parameters<typeof tx>[0]) }));
        } catch (e) {
            toast.error(e instanceof Error && e.message ? e.message : tx('cycleDetail.statusError'));
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
    if (missing) {
        return (
            <EntityDetailLayout empty={{ message: tx('cycleDetail.notFound') }} title="" breadcrumbs={breadcrumbs}>
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

    const fw = { icon: FW_ICON[cycle.frameworkKey] ?? ('shield' as AppIconName), label: cycle.frameworkName ?? cycle.frameworkKey };
    const periodText = cycle.periodStartAt || cycle.periodEndAt
        ? `${cycle.periodStartAt ? formatDate(cycle.periodStartAt) : '…'} – ${cycle.periodEndAt ? formatDate(cycle.periodEndAt) : '…'}`
        : tx('cycleDetail.periodNotSet');

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
                        { label: tx('cycleDetail.period'), value: periodText },
                        { kind: 'status' as const, label: tx('cycleDetail.status'), value: tx(`cycleStatus.${cycle.status}` as Parameters<typeof tx>[0]), variant: AUDIT_CYCLE_STATUS_VARIANT[cycle.status] ?? DEFAULT_STATUS_VARIANT },
                    ]}
                />
            }
            actions={
                <>
                    {/* feat/audit-cycle-unify — advance/close the cycle. Only
                        for the roles the server lets change it (#4129); the
                        status itself is in the meta strip for everyone. */}
                    {access.manageCycles && (
                        <Button variant="secondary" size="sm" onClick={openEdit} id="cycle-edit-btn">
                            {tx('cycleDetail.edit')}
                        </Button>
                    )}
                    {access.manageCycles && (
                        <Combobox
                            id="cycle-status-select"
                            hideSearch
                            options={CYCLE_STATUSES.map((s): ComboboxOption => ({ value: s, label: tx(`cycleStatus.${s}` as Parameters<typeof tx>[0]) }))}
                            selected={{ value: cycle.status, label: tx(`cycleStatus.${cycle.status}` as Parameters<typeof tx>[0]) }}
                            setSelected={(opt) => { if (opt) void changeStatus(opt.value); }}
                            disabled={savingStatus}
                            buttonProps={{ variant: 'secondary', className: 'text-sm' }}
                        />
                    )}
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
                    {/* Creating the pack and adding its items: Owner, Admin,
                        Editor — the server's rule, now the page's (#4129). */}
                    {access.managePacks && (
                        <Button variant="primary" onClick={createDefaultPack} disabled={creating || preview === null} id="create-default-pack-btn" icon={<AppIcon name="package" size={16} />}>
                            {creating ? tx('cycleDetail.creating') : tx('cycleDetail.pack')}
                        </Button>
                    )}
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

            {/* #3681 — the agent-audit reliance pack. Shown only to who can
                assemble it: its route takes audits.manage AND admin.manage, and
                assembling freezes the pack (Owner, Admin) — #4129. */}
            {access.assembleReliancePack && (
            <div className={cn(cardVariants(), 'space-y-default')} id="cycle-reliance-card">
                <div className="flex items-center justify-between">
                    <Heading level={2}>{tx('cycleDetail.relianceTitle')}</Heading>
                    <Button
                        variant="secondary"
                        onClick={assembleReliancePack}
                        disabled={assemblingReliance}
                        id="assemble-reliance-pack-btn"
                        icon={<AppIcon name="package" size={16} />}
                    >
                        {assemblingReliance ? tx('cycleDetail.relianceAssembling') : tx('cycleDetail.reliancePack')}
                    </Button>
                </div>
                <p className="text-sm text-content-muted">{tx('cycleDetail.relianceHelp')}</p>
                {relianceRefusalText && (
                    <p className="text-sm text-content-error" role="alert" id="reliance-refusal">
                        {relianceRefusalText}
                    </p>
                )}
            </div>
            )}

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
                        // Opens this audit in the hub's detail pane: every row
                        // used to open the same filtered list (#4727).
                        <Link key={a.id} href={`/t/${tenantSlug}/audits?cycleId=${cycleId}&selected=${a.id}`}
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
                                <StatusBadge variant={AUDIT_PACK_STATUS_VARIANT[p.status] ?? DEFAULT_STATUS_VARIANT} className="ml-2">{tx(`packStatus.${p.status}` as Parameters<typeof tx>[0])}</StatusBadge>
                            </div>
                            <span className="text-xs text-content-subtle">→</span>
                        </Link>
                    ))}
                </div>
            )}

            <Modal showModal={editOpen} setShowModal={setEditOpen} size="md" title={tx('cycleDetail.editTitle')} preventDefaultClose={savingEdit}>
                <Modal.Header title={tx('cycleDetail.editTitle')} />
                <Modal.Form id="cycle-edit-form" onSubmit={saveEdit}>
                    <Modal.Body>
                        <fieldset disabled={savingEdit} className="m-0 p-0 border-0 space-y-default">
                            <FormField label={tx('cycleDetail.nameLabel')} required>
                                <Input id="cycle-edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={200} required />
                            </FormField>
                            <FormField label={tx('cycleDetail.period')} hint={tx('cycleDetail.periodHint')}>
                                <DateRangePicker
                                    id="cycle-edit-period"
                                    className="w-full"
                                    align="start"
                                    placeholder={tx('cycles.selectAuditPeriod')}
                                    value={editPeriod}
                                    onChange={setEditPeriod}
                                    presets={AUDIT_PERIOD_PRESETS}
                                    showYearNavigation
                                />
                            </FormField>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button type="button" variant="secondary" size="sm" onClick={() => setEditOpen(false)} disabled={savingEdit}>
                            {tx('cycleDetail.cancel')}
                        </Button>
                        <Button type="submit" variant="primary" size="sm" disabled={savingEdit || !editName.trim()} id="cycle-edit-save">
                            {savingEdit ? tx('cycleDetail.saving') : tx('cycleDetail.save')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </EntityDetailLayout>
    );
}
