'use client';
import { formatDate } from '@/lib/format-date';
import { useTranslations } from 'next-intl';
import { SkeletonCard } from '@/components/ui/skeleton';
import { useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { ClipboardCheck } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { RequirePermission } from '@/components/require-permission';
import { buttonVariants } from '@/components/ui/button-variants';
import { Plus } from '@/components/ui/icons/nucleo';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { FieldGroup } from '@/components/ui/field-group';
import { DateRangePicker } from '@/components/ui/date-picker/date-range-picker';
import { selectDateRangePresets } from '@/components/ui/date-picker/presets-catalogue';
import type { DateRangeValue } from '@/components/ui/date-picker/types';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { InfoTooltip } from '@/components/ui/tooltip';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { useToast } from '@/components/ui/hooks';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { AUDIT_CYCLE_STATUS_VARIANT, DEFAULT_STATUS_VARIANT } from '../_lib/status-variants';
import { ReadinessScoreRing, ReadinessLegend } from './ReadinessScoreRing';

// Epic 58 — audit periods are reporting windows. The curated preset
// subset favours periods auditors actually request ("the most recent
// completed quarter", "this fiscal year so far") over day-level
// presets like "Today" that don't map to an audit scope.
const AUDIT_PERIOD_PRESETS = selectDateRangePresets([
    'quarter-to-date',
    'year-to-date',
    'last-quarter',
    'last-year',
    'last-90-days',
    'last-30-days',
]);

const FW_META: Record<string, { icon: AppIconName; label: string; color: string }> = {
    ISO27001: { icon: 'shield', label: 'ISO/IEC 27001:2022', color: 'from-indigo-500 to-purple-600' },
    NIS2: { icon: 'globe', label: 'NIS2 Directive', color: 'from-blue-500 to-cyan-600' },
};
// Custom-framework cycles (any key scored via computeGenericReadiness) get a
// generic-but-branded chip — a real gradient + a certificate icon, not the
// flat gray "unknown" look. The label falls back to the framework key itself.
const FW_FALLBACK = { icon: 'shield' as AppIconName, color: 'from-violet-500 to-fuchsia-600' };
const fwMeta = (frameworkKey: string) =>
    FW_META[frameworkKey] ?? { ...FW_FALLBACK, label: frameworkKey };

// Epic 55 — framework picker options. Labels are intentionally verbose
// (include the version / full regulation name) because the Combobox
// search index benefits from the extra tokens ("ISO", "27001", "NIS2",
// "EU 2022/2555" all become fuzzy-matchable).
// PR-O — fallback options until the installed-framework catalog loads. A
// cycle can be created for ANY installed framework now (non-ISO/NIS2 keys
// score via computeGenericReadiness), so the picker is data-driven; these
// two just seed the control before the /frameworks fetch resolves.
const DEFAULT_FW_OPTIONS: ComboboxOption<{ version: string }>[] = [
    { value: 'ISO27001', label: 'ISO/IEC 27001:2022', meta: { version: '2022' } },
    { value: 'NIS2', label: 'NIS2 Directive (EU 2022/2555)', meta: { version: 'EU_2022_2555' } },
];

// The readiness overview endpoint returns the cycle list joined with a
// per-cycle readiness score (`scoresByCycleId`). One call gives the
// unified list everything it needs: framework meta, pack counts, AND
// the score ring — collapsing what used to be two near-duplicate pages
// (/audits/cycles + /audits/readiness) into this single surface.
interface CycleRow {
    id: string;
    name: string;
    frameworkKey: string;
    frameworkVersion: string;
    status: string;
    createdAt: string;
    packs?: { id: string }[];
}
interface ScoreEntry {
    score: number;
    recommendations?: string[];
}
/** The overview payload — the page's single read. */
interface ReadinessOverview {
    cycles: CycleRow[];
    scoresByCycleId: Record<string, ScoreEntry>;
}
/** `/frameworks` rows — the installed-framework catalog behind the picker. */
interface FrameworkRow {
    key: string;
    name: string;
    version: string | null;
}
/** The create-cycle request body. Both period sides are optional. */
interface CreateCycleInput {
    frameworkKey: string;
    frameworkVersion: string;
    name: string;
    periodStartAt?: string;
    periodEndAt?: string;
}

export default function AuditCyclesPage() {
    const tx = useTranslations('audits');
    const toast = useToast();
    const params = useParams();
    const router = useRouter();
    const tenantSlug = params.tenantSlug as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ frameworkKey: 'ISO27001', frameworkVersion: '2022', name: '' });
    // Epic 58 — the period is stored as a nullable DateRangeValue so
    // half-open ranges ("from X, open-ended") are representable. The
    // backend accepts both `periodStartAt` / `periodEndAt` as
    // optional, so we submit whichever side the user has set.
    const [period, setPeriod] = useState<DateRangeValue>({ from: null, to: null });

    // ─── Reads ───
    //
    // Single call: the overview orchestrator fans out per-cycle
    // readiness server-side (no 1+N waterfall) and returns the
    // cycle list joined with `scoresByCycleId`. The hand-rolled
    // fetch + useEffect + useState triple became one SWR key, named
    // in CACHE_KEYS so the create mutation below targets the same
    // string by construction.
    const overviewQuery = useTenantSWR<ReadinessOverview>(
        CACHE_KEYS.audits.readinessOverview(),
    );
    const cycles = overviewQuery.data?.cycles ?? [];
    const scores = overviewQuery.data?.scoresByCycleId ?? {};
    const loading = overviewQuery.isLoading;
    // A failed load must NOT fall through to the "create your first cycle"
    // empty state — that misreads an outage as a first-run. The two stay
    // structurally distinct: SWR's `error` is the outage (retryable), an
    // empty `cycles` on a SUCCESSFUL read is the genuine first-run.
    //
    // `&& !data` is load-bearing, not defensive. Unlike the hand-rolled
    // loader this replaced — which ran once on mount — `useTenantSWR`
    // revalidates on focus and on reconnect, and SWR keeps the cached data
    // when a revalidation fails. Without the guard, a tab-away-and-back over
    // a blip would set `error` while `data` is still good and `isLoading` is
    // false, and the branch at the bottom of this file would replace a
    // fully-rendered page — including an open create-cycle modal — with the
    // Retry empty state. Suppressing the error while there is still something
    // readable on screen is the repo's idiom (cf. `TasksClient`).
    const loadError = Boolean(overviewQuery.error) && !overviewQuery.data;
    // Hoisted so the error state's Retry re-invokes the same read in place.
    const loadCycles = useCallback(() => {
        void overviewQuery.mutate();
    }, [overviewQuery]);

    // PR-O — installed frameworks drive the picker (custom-framework cycles),
    // not just ISO27001/NIS2. Fail-soft: on error the query yields no data and
    // the picker keeps the two defaults, exactly as the old `.catch` did.
    const frameworksQuery = useTenantSWR<FrameworkRow[]>(CACHE_KEYS.frameworks.list());
    const frameworkRows = frameworksQuery.data;
    const fwOptions = useMemo<ComboboxOption<{ version: string }>[]>(() => {
        if (!Array.isArray(frameworkRows) || frameworkRows.length === 0) {
            return DEFAULT_FW_OPTIONS;
        }
        return frameworkRows.map((f) => ({
            value: f.key,
            label: f.version ? `${f.name} (${f.version})` : f.name,
            meta: { version: f.version ?? '' },
        }));
    }, [frameworkRows]);

    // ─── Write ───
    const createMutation = useTenantMutation<ReadinessOverview, CreateCycleInput, { id: string }>({
        key: CACHE_KEYS.audits.readinessOverview(),
        // No optimistic prediction, deliberately. The server mints the id and
        // `createdAt`, and the card's ring reads a `scoresByCycleId` entry
        // only the server can compute — a guessed card would shift on
        // revalidation. The flow also navigates to the new cycle on success,
        // so a predicted row would never be seen.
        mutationFn: async (input) => {
            const res = await fetch(apiUrl('/audits/cycles'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            if (!res.ok) throw new Error(tx('cycles.createError'));
            return res.json();
        },
        // The bare cycle list backs the audits hub's cycle picker and the
        // readiness overview page — a new cycle belongs in both.
        invalidate: [CACHE_KEYS.audits.cycles()],
    });

    // The POST's in-flight state comes from the mutation. `navigating` is a
    // separate latch for the window AFTER it resolves, while the router
    // transition runs: `isMutating` flips back to false the moment the
    // response lands, and re-enabling the submit button mid-navigation would
    // re-open the double-submit the original guard closed.
    const [navigating, setNavigating] = useState(false);
    const creating = createMutation.isMutating || navigating;

    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        // Guard double-submit + empty required fields (the modal form is
        // rendered with `noValidate`, so native `required` won't block it).
        if (creating || !form.frameworkKey || !form.name.trim()) return;
        // The version rides the selected framework option (no hardcoded ternary).
        const input: CreateCycleInput = {
            ...form,
            frameworkVersion: form.frameworkVersion,
        };
        // Submit the audit period only when the user picked one.
        // Either side may be open-ended; the backend already accepts
        // both fields as optional and validates them as strings.
        if (period.from) input.periodStartAt = period.from.toISOString();
        if (period.to) input.periodEndAt = period.to.toISOString();
        try {
            const cycle = await createMutation.trigger(input);
            // Navigating away — latch the disabled state through the
            // transition (no double-submit).
            setNavigating(true);
            router.push(`/t/${tenantSlug}/audits/cycles/${cycle.id}`);
        } catch {
            // Previously a silent no-op — a failed create left the form
            // untouched with no signal. Surface the failure; the mutation
            // has already re-enabled the form.
            toast.error(tx('cycles.createError'));
        }
    };

    if (loading) return (
        <div className="p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-section">
                {[1, 2, 3].map(i => <SkeletonCard key={i} lines={3} />)}
            </div>
        </div>
    );

    if (loadError) return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <div className={cardVariants({ density: 'none' })}>
                <EmptyState
                    variant="missing-prereqs"
                    title={tx('cycles.loadErrorTitle')}
                    description={tx('cycles.loadError')}
                    primaryAction={{
                        label: tx('cycles.retry'),
                        onClick: loadCycles,
                    }}
                />
            </div>
        </div>
    );

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <div className="flex items-center justify-between">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                            { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
                            { label: tx('crumb.cycles') },
                        ]}
                        className="mb-1"
                    />
                    <div className="flex items-center gap-tight">
                        <Heading level={1}>{tx('cycles.title')}</Heading>
                        <InfoTooltip
                            aria-label={tx('readinessLegend.aria')}
                            content={<ReadinessLegend labels={{
                                title: tx('readinessLegend.title'),
                                green: tx('readinessLegend.green'),
                                amber: tx('readinessLegend.amber'),
                                red: tx('readinessLegend.red'),
                            }} />}
                        />
                    </div>
                    <p className="text-content-muted text-sm">{tx('cycles.cycleCount', { count: cycles.length })}</p>
                </div>
                <RequirePermission resource="audits" action="manage">
                    <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setShowForm(true)} id="create-cycle-btn">
                        {tx('cycles.cycle')}
                    </Button>
                </RequirePermission>
            </div>

            <Modal
                showModal={showForm}
                setShowModal={setShowForm}
                size="lg"
                title={tx('cycles.newCycleTitle')}
                preventDefaultClose={creating}
            >
                <Modal.Header
                    title={tx('cycles.newCycleTitle')}
                    description={tx('cycles.newCycleDesc')}
                />
                <Modal.Form id="cycle-form" onSubmit={create}>
                    <Modal.Body>
                        <fieldset disabled={creating} className="m-0 p-0 border-0 space-y-default">
                            <FieldGroup columns={2} gap="md">
                                <FormField
                                    label={tx('cycles.frameworkLabel')}
                                    required
                                    hint={tx('cycles.frameworkHint')}
                                >
                                    <Combobox<false, { version: string }>
                                        id="fw-select"
                                        name="frameworkKey"
                                        options={fwOptions}
                                        selected={
                                            fwOptions.find(
                                                (o) => o.value === form.frameworkKey,
                                            ) ?? null
                                        }
                                        setSelected={(option) => {
                                            if (!option) return;
                                            setForm((f) => ({
                                                ...f,
                                                frameworkKey: option.value,
                                                // Carry the framework's version from the picker.
                                                frameworkVersion: option.meta?.version ?? '',
                                            }));
                                        }}
                                        placeholder={tx('cycles.selectFramework')}
                                        searchPlaceholder={tx('cycles.searchFrameworks')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'w-full' }}
                                        caret
                                    />
                                </FormField>
                                <FormField label={tx('cycles.cycleName')} required>
                                    <Input
                                        id="cycle-name-input"
                                        required
                                        value={form.name}
                                        onChange={(e) =>
                                            setForm((f) => ({ ...f, name: e.target.value }))
                                        }
                                        placeholder={tx('cycles.cycleNamePlaceholder')}
                                    />
                                </FormField>
                            </FieldGroup>
                            {/*
                              Epic 58 — Audit period. Optional. The shared
                              DateRangePicker handles presets (Quarter to date,
                              Last year, …) + custom ranges in one surface, so
                              auditors don't need two date inputs or a spreadsheet
                              to figure out what "Q2 2026" maps to.
                            */}
                            <div className="mt-4">
                                <FormField
                                    label={tx('cycles.auditPeriod')}
                                    hint={tx('cycles.auditPeriodHint')}
                                >
                                    <DateRangePicker
                                        id="cycle-period-range"
                                        className="w-full"
                                        align="start"
                                        placeholder={tx('cycles.selectAuditPeriod')}
                                        value={period}
                                        onChange={setPeriod}
                                        presets={AUDIT_PERIOD_PRESETS}
                                        showYearNavigation
                                    />
                                </FormField>
                            </div>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setShowForm(false)}
                            disabled={creating}
                            id="cancel-cycle-btn"
                        >
                            {tx('cycles.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            size="sm"
                            loading={creating}
                            disabled={creating || !form.frameworkKey || !form.name.trim()}
                            id="submit-cycle-btn"
                        >
                            {creating ? tx('cycles.creating') : tx('cycles.createCycle')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

            {cycles.length === 0 ? (
                <div className={cardVariants({ density: 'none' })}>
                    <EmptyState
                        icon={ClipboardCheck}
                        title={tx('cycles.emptyTitle')}
                        description={tx('cycles.emptyDesc')}
                        primaryAction={{
                            label: tx('cycles.addCycle'),
                            onClick: () => setShowForm(true),
                        }}
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    {cycles.map(c => {
                        const meta = fwMeta(c.frameworkKey);
                        const sc = scores[c.id];
                        return (
                            <div key={c.id} className={cardVariants()} id={`cycle-card-${c.id}`}>
                                <div className="flex items-start gap-default">
                                    <div className="flex-shrink-0">
                                        <ReadinessScoreRing score={sc?.score} noScoreLabel={tx('cycles.noScore')} ariaLabel={sc ? tx('cycles.scoreAria', { score: sc.score }) : tx('cycles.noScore')} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-tight mb-1">
                                            <span className={`w-10 h-10 rounded-lg bg-gradient-to-br ${meta.color} flex items-center justify-center text-lg flex-shrink-0`}>
                                                <AppIcon name={meta.icon} size={20} />
                                            </span>
                                            <StatusBadge variant={AUDIT_CYCLE_STATUS_VARIANT[c.status] || DEFAULT_STATUS_VARIANT}>{tx(`cycleStatus.${c.status}` as Parameters<typeof tx>[0])}</StatusBadge>
                                        </div>
                                        <Heading level={3} className="truncate">{c.name}</Heading>
                                        <p className="text-xs text-content-muted mt-1">{meta.label} · v{c.frameworkVersion}</p>
                                        <div className="flex items-center gap-tight mt-1 text-xs text-content-subtle">
                                            <span>{tx('cycles.packCount', { count: c.packs?.length || 0 })}</span>
                                            <span>·</span>
                                            <span>{formatDate(c.createdAt)}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-tight">
                                    <Link
                                        href={`/t/${tenantSlug}/audits/cycles/${c.id}`}
                                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                                        id={`cycle-link-${c.id}`}
                                    >
                                        {tx('cycles.openCycle')}
                                    </Link>
                                    <Link
                                        href={`/t/${tenantSlug}/audits/cycles/${c.id}/readiness`}
                                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                                        id={`readiness-link-${c.id}`}
                                    >
                                        {tx('cycles.viewReadiness')}
                                    </Link>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
