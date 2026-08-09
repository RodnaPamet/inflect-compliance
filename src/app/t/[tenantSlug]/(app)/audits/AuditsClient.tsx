'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/hooks/use-toast';
import { Heading } from '@/components/ui/typography';
import { PageHeader } from '@/components/layout/PageHeader';
import { CardHeader } from '@/components/ui/card-header';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { Plus } from '@/components/ui/icons/nucleo';
import { NewAuditModal } from './NewAuditModal';
import { NewFindingModal } from './NewFindingModal';
import { EditAuditModal } from './EditAuditModal';
// #6 — canonical audits status/result → badge-variant maps. The list and
// detail views (and the cycle page) now share one authoritative reading so
// CANCELLED can never disagree again.
import {
    AUDIT_STATUS_VARIANT,
    CHECKLIST_RESULT_VARIANT,
    DEFAULT_STATUS_VARIANT,
} from './_lib/status-variants';
import { useCreateQueryParam } from '@/components/ui/hooks/use-create-query-param';

// listAudits → AuditRepository.list (auditListSelect). The lighter LIST row
// (distinct from the detail AuditDetail). List map callback stays untyped.
interface AuditListRow {
    id: string;
    title: string;
    status: string;
    _count: { checklist: number; findings: number };
}

interface AuditsClientProps {
    initialAudits: AuditListRow[];
    tenantSlug: string;
    /** feat/audit-cycle-unify — when set, the list is scoped to one cycle's
     *  fieldwork audits (?cycleId), and a "viewing cycle" banner shows. */
    cycleId?: string;
    /** True when NIS2 is an installed framework — gates the NIS2 Gap Assessment
     *  entry button (absent, not disabled, when false). */
    hasNis2: boolean;
    /** Gates the "New finding" affordance on the audit detail pane. */
    canWrite: boolean;
    translations: {
        title: string;
        listDescription: string;
        newAudit: string;
        auditTitle: string;
        auditors: string;
        scope: string;
        createAudit: string;
        cancel: string;
        planned: string;
        inProgress: string;
        completed: string;
        cancelled: string;
        notTested: string;
        pass: string;
        fail: string;
        checklist: string;
        findingsTab: string;
        selectAudit: string;
    };
}

// listAuditCycles row — the hub cycle picker only needs id + name to build
// options and name the active-filter banner.
interface CycleRow {
    id: string;
    name: string;
    frameworkKey: string;
    status: string;
}

// getAudit → AuditRepository.getById (full Audit + ordered checklist + findings).
interface AuditChecklistItemRow {
    id: string;
    prompt: string;
    result: string;
    notes: string | null;
}
interface AuditFindingRow {
    id: string;
    title: string;
    severity: string;
}
interface AuditDetail {
    id: string;
    title: string;
    status: string;
    auditScope: string | null;
    // Editable metadata — carried so `<EditAuditModal>` can seed from the
    // audit already on screen instead of re-fetching it.
    criteria?: string | null;
    schedule?: string | null;
    departments?: string | null;
    frameworkKey?: string | null;
    auditCycleId?: string | null;
    checklist: AuditChecklistItemRow[];
    findings: AuditFindingRow[];
}

/**
 * Client island for audits — handles master/detail, create form, checklist interactions.
 * Data is pre-fetched server-side and passed via props.
 */
export function AuditsClient({ initialAudits, tenantSlug, cycleId, hasNis2, canWrite, translations: t }: AuditsClientProps) {
    // `tx` covers strings not threaded through the server `translations` prop
    // (nav links, list counters) — mirrors the assets/risks island pattern.
    const tx = useTranslations('audits');
    const toast = useToast();
    const [selected, setSelected] = useState<AuditDetail | null>(null);
    const [isFindingOpen, setIsFindingOpen] = useState(false);
    const [isEditOpen, setIsEditOpen] = useState(false);

    // Modal-form follow-up — create-audit modal mounted off the list,
    // auto-opening on `?create=1` (the redirect target from
    // `/audits/new`). Mirrors NewVendorModal wiring.
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const searchParams = useSearchParams();
    const router = useRouter();
    useCreateQueryParam(() => setIsCreateOpen(true), `/t/${tenantSlug}/audits`);

    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    // PR-5 — API returns `{ rows, truncated }`; SSR initial wraps
    // with `truncated: false` (SSR cap < backfill cap).
    // feat/audit-cycle-unify — when scoped to a cycle, the SWR key carries
    // ?cycleId so the background revalidation stays filtered (not the whole
    // list); otherwise the static key seeds directly from the SSR payload.
    const auditsQuery = useTenantSWR<CappedList<AuditListRow>>(
        cycleId ? `${CACHE_KEYS.audits.list()}?cycleId=${cycleId}` : CACHE_KEYS.audits.list(),
        { fallbackData: { rows: initialAudits, truncated: false } },
    );
    const audits = auditsQuery.data?.rows ?? [];
    const truncated = auditsQuery.data?.truncated ?? false;

    // feat/audit-cycle-unify — cycle picker. Fetch the cycle list so the
    // hub can scope its fieldwork-audit list to one cycle (?cycleId) and
    // name the selected cycle in the context banner (instead of generic
    // "viewing one cycle" text).
    const cyclesQuery = useTenantSWR<CycleRow[]>(CACHE_KEYS.audits.cycles());
    const cycles = cyclesQuery.data ?? [];
    const selectedCycle = cycleId ? cycles.find((c) => c.id === cycleId) ?? null : null;
    const cycleOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: '', label: tx('hub.cyclePickerAll') },
            ...cycles.map((c) => ({ value: c.id, label: c.name })),
        ],
        [cycles, tx],
    );
    const onCycleChange = (id: string) => {
        router.push(`/t/${tenantSlug}/audits${id ? `?cycleId=${id}` : ''}`, { scroll: false });
    };

    // #4 — a 500 envelope is not an audit. Guard on res.ok so a failed
    // detail fetch surfaces an error instead of blanking the pane with an
    // undefined title + empty checklist.
    const loadAudit = async (id: string) => {
        try {
            const res = await fetch(apiUrl(`/audits/${id}`));
            if (!res.ok) {
                toast.error(tx('detail.loadError'));
                return;
            }
            setSelected(await res.json());
        } catch {
            toast.error(tx('detail.loadError'));
        }
    };

    /**
     * Deep-link into one audit: `/audits?selected=<auditId>` opens that audit
     * in the detail pane on arrival.
     *
     * The hub is a master-detail page, not a route per audit — there is no
     * `/audits/[id]`. Anything that wanted to point AT an audit (the findings
     * register's Source column, most visibly) had nowhere to point, so it
     * linked to a URL that 404s. This is the address that pane never had.
     *
     * Ref-guarded rather than effect-dependency-guarded: `selected` changes on
     * every row click, and re-running on that would drag the pane back to the
     * query param and make the list unclickable. Tracking the last id we
     * consumed means a browser back/forward to a different `?selected=` still
     * re-opens, while local clicks are left alone.
     */
    const consumedSelectedParam = useRef<string | null>(null);
    const selectedParam = searchParams.get('selected');
    useEffect(() => {
        if (!selectedParam || consumedSelectedParam.current === selectedParam) return;
        consumedSelectedParam.current = selectedParam;
        loadAudit(selectedParam);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAudit is
        // re-created every render; the ref guard is what makes this run once.
    }, [selectedParam]);

    /**
     * The audit PUT, once.
     *
     * Both writes below hit the same endpoint with a different body, and both
     * previously hand-rolled the request, the `res.ok` branch, the error toast
     * and (for status) a manual snapshot/restore. That is the shape the whole
     * surface repeated thirty times.
     *
     * The detail pane is component state, not an SWR entry — the pane holds ONE
     * audit chosen by click, which is not a cache key. So `useTenantMutation`
     * owns the request lifecycle and the LIST invalidation, and the pane's own
     * optimistic flip stays local. Pretending the pane were a cache entry would
     * buy a rollback we already have and cost a key that nothing reads.
     */
    const auditWrite = useTenantMutation<
        CappedList<AuditListRow>,
        { auditId: string; body: Record<string, unknown> }
    >({
        key: cycleId ? `${CACHE_KEYS.audits.list()}?cycleId=${cycleId}` : CACHE_KEYS.audits.list(),
        mutationFn: async ({ auditId, body }) => {
            const res = await fetch(apiUrl(`/audits/${auditId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error('audit_write_failed');
            return res.json().catch(() => null);
        },
    });

    // #4 — a failed PUT used to silently drop the result; surface it and
    // only refresh the pane once the write actually succeeded.
    const updateChecklist = async (itemId: string, result: string, notes: string = '') => {
        if (!selected) return;
        try {
            await auditWrite.trigger({
                auditId: selected.id,
                body: { checklistUpdates: [{ id: itemId, result, notes }] },
            });
            toast.success(tx('detail.checklistSaved'));
            loadAudit(selected.id);
        } catch {
            toast.error(tx('detail.checklistError'));
        }
    };

    // #4 — flip the pill optimistically, but reconcile it back to the prior
    // status when the PUT fails so it never sticks on the un-saved value.
    const updateAuditStatus = async (status: string) => {
        if (!selected) return;
        const prevStatus = selected.status;
        setSelected((s) => (s ? { ...s, status } : s));
        try {
            await auditWrite.trigger({ auditId: selected.id, body: { status } });
            toast.success(tx('detail.statusChanged', { status: statusLabel(status) }));
        } catch {
            setSelected((s) => (s ? { ...s, status: prevStatus } : s));
            toast.error(tx('detail.statusError'));
        }
    };

    const statusLabel = (status: string) => {
        const map: Record<string, string> = { PLANNED: t.planned, IN_PROGRESS: t.inProgress, COMPLETED: t.completed, CANCELLED: t.cancelled };
        return map[status] || status;
    };

    const resultLabel = (result: string) => {
        const map: Record<string, string> = { NOT_TESTED: t.notTested, PASS: t.pass, FAIL: t.fail };
        return map[result] || result;
    };

    const resultOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: 'NOT_TESTED', label: t.notTested },
            { value: 'PASS', label: t.pass },
            { value: 'FAIL', label: t.fail },
        ],
        [t.notTested, t.pass, t.fail],
    );

    return (
        <>
            <PageHeader
                // The Internal Audit action row (6 pills + New Audit) is wide
                // enough to wrap onto its own header line; ml-auto keeps it
                // right-aligned there instead of landing left under justify-between.
                actionsClassName="ml-auto"
                breadcrumbs={[
                    { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t.title },
                ]}
                title={t.title}
                description={t.listDescription || undefined}
                actions={
                    <div className="flex flex-wrap items-center gap-tight">
                        {/* PR-O — the actual /audits/* children of Internal Audit
                            (NIS2 Gap, Business Continuity). These live under
                            /audits and are true subpages. */}
                        {hasNis2 && (
                            <Link
                                href={`/t/${tenantSlug}/audits/nis2-gap`}
                                className={cn(buttonVariants({ variant: 'secondary' }))}
                                id="audits-nis2-gap-link"
                            >
                                {tx('nav.nis2Gap')}
                            </Link>
                        )}
                        <Link
                            href={`/t/${tenantSlug}/audits/business-continuity`}
                            className={cn(buttonVariants({ variant: 'secondary' }))}
                            id="audits-business-continuity-link"
                        >
                            {tx('nav.businessContinuity')}
                        </Link>

                        {/* PR-O — "Related" cross-links. These are SEPARATE
                            top-level routes (/frameworks, /security-testing,
                            /findings, /incidents), NOT subpages of Internal Audit
                            — they're surfaced here as useful shortcuts because
                            their data feeds the audit story (framework clauses,
                            scan findings as evidence, findings raised against
                            cycles, NIS2 Art.23 incidents), but they are not
                            /audits children. */}
                        <span className="ml-1 text-xs text-content-subtle">{tx('hub.related')}</span>
                        <Link
                            href={`/t/${tenantSlug}/frameworks`}
                            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                            id="audits-frameworks-link"
                        >
                            {tx('nav.frameworks')}
                        </Link>
                        <Link
                            href={`/t/${tenantSlug}/security-testing`}
                            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                            id="audits-scans-link"
                        >
                            {tx('nav.scans')}
                        </Link>
                        <Link
                            href={`/t/${tenantSlug}/findings`}
                            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                            id="findings-link-btn"
                        >
                            {t.findingsTab}
                        </Link>
                        <Link
                            href={`/t/${tenantSlug}/incidents`}
                            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                            id="audits-incidents-link"
                        >
                            {tx('nav.incidents')}
                        </Link>

                        <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setIsCreateOpen(true)} id="new-audit-btn">{t.newAudit}</Button>
                    </div>
                }
            />

            <TruncationBanner truncated={truncated} />

            {/* Audit lifecycle — the PRIMARY path into the cycle → pack →
                readiness → share → findings → remediate flow. The header's
                "Related" pills (Frameworks / Scans / Findings / Incidents) are
                separate top-level surfaces cross-linked for convenience; this
                band is where an audit actually starts. */}
            <section className={cn(cardVariants(), 'space-y-default')} aria-labelledby="audit-lifecycle-heading" id="audit-lifecycle">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-compact">
                    <div>
                        <Heading level={2} id="audit-lifecycle-heading">{tx('hub.lifecycleTitle')}</Heading>
                        <p className="text-sm text-content-muted">{tx('hub.lifecycleSubtitle')}</p>
                    </div>
                    <div className="flex flex-wrap gap-tight">
                        <Link href={`/t/${tenantSlug}/audits/cycles`} className={cn(buttonVariants({ variant: 'secondary' }))} id="audits-cycles-link">
                            {tx('hub.cycles')}
                        </Link>
                        <Link href={`/t/${tenantSlug}/audits/readiness`} className={cn(buttonVariants({ variant: 'secondary' }))} id="audits-readiness-link">
                            {tx('hub.readiness')}
                        </Link>
                        {/* PR-O — the internal auditor PORTAL was retired (it always
                            returned an empty state for invited auditors). External
                            review runs through the login-less /audit/shared/[token]
                            page; internal reviewers use the pack pages. Only auditor
                            MANAGEMENT (invite/grant/revoke) remains. */}
                        <Link href={`/t/${tenantSlug}/audits/auditors`} className={cn(buttonVariants({ variant: 'secondary' }))} id="audits-auditors-manage-link">
                            {tx('hub.auditorManagement')}
                        </Link>
                    </div>
                </div>

                <div className="space-y-tight">
                    <div>
                        <Heading level={3}>{tx('hub.startTitle')}</Heading>
                        <p className="text-sm text-content-muted">{tx('hub.startSubtitle')}</p>
                    </div>
                    <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-tight">
                        {[
                            { title: tx('hub.step1Title'), desc: tx('hub.step1Desc'), href: `/t/${tenantSlug}/audits/cycles` },
                            { title: tx('hub.step2Title'), desc: tx('hub.step2Desc'), href: `/t/${tenantSlug}/audits/cycles` },
                            { title: tx('hub.step3Title'), desc: tx('hub.step3Desc'), href: `/t/${tenantSlug}/audits/cycles` },
                            { title: tx('hub.step4Title'), desc: tx('hub.step4Desc'), href: `/t/${tenantSlug}/audits/cycles` },
                            { title: tx('hub.step5Title'), desc: tx('hub.step5Desc'), href: `/t/${tenantSlug}/findings` },
                            { title: tx('hub.step6Title'), desc: tx('hub.step6Desc'), href: `/t/${tenantSlug}/tasks` },
                        ].map((step, i) => (
                            <li key={i}>
                                <Link
                                    href={step.href}
                                    id={`audit-step-${i + 1}`}
                                    className={cn(
                                        cardVariants({ density: 'compact' }),
                                        'flex items-start gap-compact hover:bg-bg-muted/50 hover:border-border-emphasis transition h-full',
                                    )}
                                >
                                    <span
                                        className="flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated text-sm font-semibold text-content-default"
                                        aria-label={tx('hub.stepLabel', { n: i + 1 })}
                                    >
                                        {i + 1}
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium text-content-default">{step.title}</span>
                                        <span className="block text-xs text-content-subtle mt-0.5">{step.desc}</span>
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ol>
                </div>
            </section>

            {/* feat/audit-cycle-unify — cycle picker + scoped context banner.
                The picker scopes the fieldwork-audit list to one cycle
                (?cycleId); the banner names the selected cycle so the scope
                is legible, not just "one cycle". */}
            {cycles.length > 0 && (
                <div className="flex flex-col gap-tight sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-compact">
                        <span className="text-xs font-medium text-content-muted">{tx('hub.cyclePickerLabel')}</span>
                        <Combobox
                            options={cycleOptions}
                            selected={cycleOptions.find((o) => o.value === (cycleId ?? '')) ?? cycleOptions[0]}
                            setSelected={(opt) => onCycleChange(opt?.value ?? '')}
                            matchTriggerWidth
                            buttonProps={{ className: 'text-sm min-w-[14rem]', id: 'audits-cycle-picker' }}
                            aria-label={tx('hub.cyclePickerLabel')}
                            caret
                        />
                    </div>
                    {selectedCycle && (
                        <div
                            className="flex items-center justify-between gap-compact rounded-md border border-border-emphasis bg-bg-info/10 px-3 py-2 text-sm"
                            data-testid="audits-cycle-filter-banner"
                        >
                            <span className="text-content-default">{tx('hub.cycleFilterActiveNamed', { name: selectedCycle.name })}</span>
                            <Link href={`/t/${tenantSlug}/audits`} className="text-xs text-content-muted underline underline-offset-2" id="audits-clear-cycle-filter">
                                {tx('hub.clearCycleFilter')}
                            </Link>
                        </div>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-default">
                <div className="space-y-tight">
                    {/* #11a — the master list gets a real empty state instead of a
                        silently-blank column when the tenant (or the cycle filter)
                        has no audits. */}
                    {audits.length === 0 ? (
                        <EmptyState
                            size="sm"
                            title={tx('hub.emptyTitle')}
                            description={tx('hub.emptyDesc')}
                            primaryAction={{ label: t.newAudit, onClick: () => setIsCreateOpen(true) }}
                        />
                    ) : (
                        audits.map((a) => (
                            <button key={a.id} onClick={() => loadAudit(a.id)}
                                className={cn(cardVariants({ density: 'compact' }), 'w-full text-left hover:bg-bg-muted/50 transition', selected?.id === a.id && 'ring-2 ring-[var(--ring)]')}>
                                <div className="flex items-center justify-between">
                                    <span className="font-medium text-sm">{a.title}</span>
                                    <StatusBadge variant={AUDIT_STATUS_VARIANT[a.status] ?? DEFAULT_STATUS_VARIANT}>{statusLabel(a.status)}</StatusBadge>
                                </div>
                                <p className="text-xs text-content-subtle mt-1">{tx('list.itemsCount', { count: a._count?.checklist || 0 })} · {a._count?.findings || 0} {t.findingsTab.toLowerCase()}</p>
                            </button>
                        ))
                    )}
                </div>

                <div className="lg:col-span-2">
                    {selected ? (
                        <div className={cn(cardVariants(), 'animate-fadeIn space-y-default')}>
                                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-compact">
                                <Heading level={2}>{selected.title}</Heading>
                                <div className="flex flex-wrap gap-tight">
                                    {selected.status === 'PLANNED' && <Button variant="secondary" size="sm" onClick={() => updateAuditStatus('IN_PROGRESS')}>{t.inProgress}</Button>}
                                    {selected.status === 'IN_PROGRESS' && <Button variant="secondary" size="sm" onClick={() => updateAuditStatus('COMPLETED')}>{t.completed}</Button>}
                                    {canWrite && (
                                        <Button variant="ghost" size="sm" id="edit-audit-btn" onClick={() => setIsEditOpen(true)}>
                                            {tx('editModal.trigger')}
                                        </Button>
                                    )}
                                </div>
                            </div>
                            {selected.auditScope && <p className="text-sm text-content-muted">{selected.auditScope}</p>}

                            <div>
                                <CardHeader title={`${t.checklist} (${selected.checklist?.length || 0})`} className="mb-3" />
                                <div className="space-y-tight">
                                    {selected.checklist?.map((item) => (
                                        <div key={item.id} className="flex flex-col sm:flex-row items-start gap-compact p-3 border border-border-default/50 rounded-lg">
                                            <Combobox
                                                hideSearch
                                                options={resultOptions}
                                                selected={resultOptions.find(o => o.value === item.result) ?? null}
                                                setSelected={(opt) => opt && updateChecklist(item.id, opt.value)}
                                                matchTriggerWidth
                                                buttonProps={{ className: 'w-full sm:w-auto text-xs' }}
                                                aria-label={tx('list.resultFor', { prompt: item.prompt })}
                                                caret
                                            />
                                            <div className="flex-1">
                                                <p className="text-sm text-content-default">{item.prompt}</p>
                                                {item.notes && <p className="text-xs text-content-subtle mt-1">{item.notes}</p>}
                                            </div>
                                            {/* R8-PR5 — checklist result restates the Combobox above it. Demote to `tone="subtle"` so the row reads as one state signal, not two competing pills. */}
                                            <StatusBadge tone="subtle" variant={CHECKLIST_RESULT_VARIANT[item.result] ?? DEFAULT_STATUS_VARIANT}>{resultLabel(item.result)}</StatusBadge>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <div className="mb-2 flex items-center justify-between gap-compact">
                                    <Heading level={3}>{t.findingsTab} ({selected.findings?.length || 0})</Heading>
                                    {canWrite && (
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                            onClick={() => setIsFindingOpen(true)}
                                            id="new-audit-finding-btn"
                                        >
                                            {tx('findingModal.trigger')}
                                        </Button>
                                    )}
                                </div>
                                {selected.findings?.length > 0 && selected.findings.map((f) => (
                                    <div key={f.id} className="p-3 border border-border-default/50 rounded-lg mb-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-medium">{f.title}</span>
                                            <StatusBadge variant={f.severity === 'CRITICAL' ? 'error' : f.severity === 'HIGH' ? 'warning' : 'info'}>{f.severity}</StatusBadge>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className={cn(cardVariants({ density: 'spacious' }), 'text-center text-content-subtle')}>{t.selectAudit}</div>
                    )}
                </div>
            </div>

            <NewAuditModal
                open={isCreateOpen}
                setOpen={setIsCreateOpen}
                tenantSlug={tenantSlug}
                onCreated={(a) => loadAudit(a.id)}
                labels={{
                    auditTitle: t.auditTitle,
                    auditors: t.auditors,
                    scope: t.scope,
                    cancel: t.cancel,
                    createAudit: t.createAudit,
                    newAudit: t.newAudit,
                }}
            />

            {selected && (
                <NewFindingModal
                    open={isFindingOpen}
                    setOpen={setIsFindingOpen}
                    auditId={selected.id}
                    apiUrl={apiUrl}
                    onCreated={() => {
                        // #8 — reload the detail AND revalidate the list key so the
                        // row's _count.findings stops showing a stale count.
                        loadAudit(selected.id);
                        auditsQuery.mutate();
                    }}
                />
            )}

            {selected && (
                <EditAuditModal
                    open={isEditOpen}
                    setOpen={setIsEditOpen}
                    audit={selected}
                    onSaved={() => {
                        // The title can change, so the list row is stale too.
                        loadAudit(selected.id);
                        auditsQuery.mutate();
                    }}
                />
            )}
        </>
    );
}
