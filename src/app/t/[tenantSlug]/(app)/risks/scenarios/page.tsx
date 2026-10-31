'use client';

/* RQ-4 — Risk scenarios: list, create, simulate, compare baseline vs scenario. */
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@inflect/ui/components/ui/hooks/use-toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { InfoTooltip } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useToastWithUndo } from '@/components/ui/hooks';
import { useTenantApiUrl, useTenantHref, useMoneyFormatter, useTenantContext, useCurrencySymbol } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { apiRefusalMessage } from '@/lib/api-error';
import {
    SCENARIO_FAIR_FIELDS,
    SCENARIO_FIELD_UNIT,
    scenarioValueRefusal,
    type ScenarioFairField,
    type ScenarioValueRefusal,
} from '@/lib/risk-scenario-fields';
import { useTranslations } from 'next-intl';
import { RiskPicker } from '../_shared/RiskPicker';
import { AnalyticsState } from '../_shared/AnalyticsState';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';

interface Scenario { id: string; name: string; status: string; investmentCost: number | null; computedRoi: number | null; createdAt: string }

// P2 — a per-risk override the engine can act on: patch one FAIR field of
// one risk, re-run, compare. Without these the what-if had nothing to model.
interface OverrideDraft { riskId: string; field: ScenarioFairField; newValue: number; label: string }
interface Comparison {
    baseline: { portfolioAle: { mean: number; p95: number; p99: number }; correlationsDropped?: boolean };
    scenario: { portfolioAle: { mean: number; p95: number; p99: number }; correlationsDropped?: boolean };
    delta: { meanAleDelta: number; varP95Delta: number; varP99Delta: number; roi: number | null };
    perRiskDeltas: Array<{ riskId: string; title: string; baselineAle: number; scenarioAle: number; deltaPercent: number }>;
}
/** #4770 — a comparison remembers which scenario it is about. */
interface ShownComparison { scenarioId: string; scenarioName: string; comparison: Comparison }

const STATUSES = new Set(['DRAFT', 'SIMULATED', 'ARCHIVED']);

/**
 * #4770 — the message for a refused request: the server's reason for a 4xx,
 * the fallback for a 5xx or a network failure.
 */
async function refusalOf(res: Response | null, fallback: string): Promise<string> {
    if (!res || res.status >= 500) return fallback;
    const body: unknown = await res.json().catch(() => null);
    return apiRefusalMessage(body, fallback);
}
const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// RQ3-OB-A — money speaks the tenant's currency (useMoneyFormatter).

export default function RiskScenariosPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const money = useMoneyFormatter();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    /**
     * create / clone / simulate assert canWrite. Simulate is the surprising
     * one — it LOOKS like a read, but `simulateScenario` writes the computed
     * result back onto the scenario row, so it is gated with the rest.
     * Archive goes through `DELETE /risks/scenarios/:id`, whose route takes
     * `risks.edit` on top (#4770).
     */
    const { permissions, appPermissions } = useTenantContext();
    const canWrite = permissions.canWrite;
    const canArchive = canWrite && (appPermissions?.risks?.edit ?? false);
    const currency = useCurrencySymbol();
    const signed = (n: number) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;
    const tenantHref = useTenantHref();
    const triggerUndoToast = useToastWithUndo();
    const toast = useToast();
    const scenariosQuery = useTenantSWR<{ scenarios: Scenario[] }>('/risks/scenarios');
    const scenarios = scenariosQuery.data?.scenarios ?? [];
    const [name, setName] = useState('');
    const [investment, setInvestment] = useState('');
    const [cmp, setCmp] = useState<ShownComparison | null>(null);
    const [busy, setBusy] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    // #4770 — a failed Simulate, Clone or Show comparison is reported on its
    // own row, with the server's reason, not beside the create form.
    const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    // Override builder.
    const [overrides, setOverrides] = useState<OverrideDraft[]>([]);
    const [ovRiskId, setOvRiskId] = useState<string | null>(null);
    const [ovRiskLabel, setOvRiskLabel] = useState<string>('');
    const [ovField, setOvField] = useState<ScenarioFairField>('primaryLossMagnitude');
    const [ovValue, setOvValue] = useState<string>('');
    const [ovError, setOvError] = useState<string | null>(null);

    const fieldOptions: ComboboxOption[] = SCENARIO_FAIR_FIELDS.map((f) => ({ value: f, label: t(`scenarios.field_${f}` as Parameters<typeof t>[0]) }));
    const fieldLabel = (f: string) => t(`scenarios.field_${f}` as Parameters<typeof t>[0]);
    const statusLabel = (s: string) => (STATUSES.has(s) ? t(`scenarios.status_${s}` as Parameters<typeof t>[0]) : s);

    /** #4770 — what the number for a field means, beside the input. */
    const unitHint = (f: ScenarioFairField) => {
        switch (SCENARIO_FIELD_UNIT[f]) {
            case 'perYear': return t('scenarios.unit_perYear');
            case 'probability': return t('scenarios.unit_probability');
            case 'scale': return t(`scenarios.unit_scale_${f}` as Parameters<typeof t>[0]);
            default: return t('scenarios.unit_money', { currency });
        }
    };
    const valuePlaceholder = (f: ScenarioFairField) => {
        switch (SCENARIO_FIELD_UNIT[f]) {
            case 'perYear': return t('scenarios.overrideValuePlaceholder_perYear');
            case 'probability': return t('scenarios.overrideValuePlaceholder_probability');
            case 'scale': return t('scenarios.overrideValuePlaceholder_scale');
            default: return t('scenarios.overrideValuePlaceholder');
        }
    };
    /** An override's value as the reader expects it: money as money, a frequency per year. */
    const formatValue = (f: ScenarioFairField, v: number) => {
        switch (SCENARIO_FIELD_UNIT[f]) {
            case 'money': return money(v);
            case 'perYear': return t('scenarios.valuePerYear', { value: v });
            default: return String(v);
        }
    };
    const refusalText: Record<ScenarioValueRefusal, string> = {
        NOT_A_NUMBER: t('scenarios.valueNotNumber'),
        NEGATIVE: t('scenarios.valueNegative'),
        PROBABILITY_RANGE: t('scenarios.valueProbability'),
    };

    const addOverride = () => {
        if (!ovRiskId) return;
        const raw = ovValue.trim();
        const v = Number(raw);
        // #4770 — a value the engine cannot use is refused with a reason,
        // not dropped without a word.
        const refusal = raw === '' ? 'NOT_A_NUMBER' : scenarioValueRefusal(ovField, v);
        if (refusal) { setOvError(refusalText[refusal]); return; }
        setOvError(null);
        setOverrides((prev) => [
            ...prev.filter((o) => !(o.riskId === ovRiskId && o.field === ovField)),
            { riskId: ovRiskId, field: ovField, newValue: v, label: ovRiskLabel },
        ]);
        setOvValue('');
    };
    const removeOverride = (i: number) => setOverrides((prev) => prev.filter((_, idx) => idx !== i));

    /** #4770 — the comparison on screen is named in the URL, so a reload shows it again. */
    const setCompareParam = (id: string | null) => {
        const params = new URLSearchParams(searchParams?.toString() ?? '');
        if (id) params.set('compare', id); else params.delete('compare');
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : (pathname ?? ''), { scroll: false });
    };
    const showComparison = (s: Pick<Scenario, 'id' | 'name'>, comparison: Comparison) => {
        setCmp({ scenarioId: s.id, scenarioName: s.name, comparison });
        setCompareParam(s.id);
    };
    const closeComparison = () => { setCmp(null); setCompareParam(null); };

    // B2-1 — the former `load()` helper is gone: every write now goes
    // through a mutation keyed on this same path, so SWR revalidates it.

    /**
     * B2-1 — the scenario writes go through `useTenantMutation` on the
     * scenarios key. `mutationFn` throws on a non-ok response, so every
     * handler clears state only AFTER the write lands — a failed create
     * keeps the name, the investment and every override on screen.
     *
     * #4770 — the error it throws carries the server's reason for a refusal,
     * and each handler shows it where its action is.
     */
    const writeMutation = useTenantMutation<unknown, { path: string; method: string; body?: unknown; fallback: string }, unknown>({
        key: '/risks/scenarios',
        mutationFn: async ({ path, method, body, fallback }) => {
            const res = await fetch(apiUrl(path), {
                method,
                ...(body === undefined
                    ? {}
                    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            }).catch(() => null);
            if (!res || !res.ok) throw new Error(await refusalOf(res, fallback));
            return res.json().catch(() => ({}));
        },
    });

    const create = async () => {
        if (!name.trim()) return;
        const investmentCost = investment.trim() ? Number(investment) : null;
        if (investmentCost != null && (!Number.isFinite(investmentCost) || investmentCost < 0)) {
            setCreateError(t('scenarios.investmentInvalid'));
            return;
        }
        setBusy(true); setCreateError(null);
        try {
            await writeMutation.trigger({
                path: '/risks/scenarios',
                method: 'POST',
                body: {
                    name: name.trim(),
                    investmentCost,
                    overrides: overrides.map((o) => ({ riskId: o.riskId, field: o.field, newValue: o.newValue })),
                },
                fallback: t('scenarios.saveError'),
            });
            // Only now — a failed create must not discard the operator's
            // name, investment and overrides.
            setName(''); setInvestment(''); setOverrides([]);
        } catch (e) {
            setCreateError(messageOf(e, t('scenarios.saveError')));
        } finally { setBusy(false); }
    };

    const simulate = async (s: Scenario) => {
        setBusy(true); setRowError(null);
        try {
            const out = (await writeMutation.trigger({
                path: `/risks/scenarios/${s.id}/simulate`,
                method: 'POST',
                fallback: t('scenarios.simulateError'),
            })) as { comparison?: Comparison };
            if (out?.comparison) showComparison(s, out.comparison);
        } catch (e) {
            setRowError({ id: s.id, message: messageOf(e, t('scenarios.simulateError')) });
        } finally { setBusy(false); }
    };

    /** #4770 — reopen a simulated scenario's comparison. A read: it stores nothing. */
    const loadComparison = async (s: Pick<Scenario, 'id' | 'name'>) => {
        setBusy(true); setRowError(null);
        try {
            const res = await fetch(apiUrl(`/risks/scenarios/${s.id}/comparison`)).catch(() => null);
            if (!res || !res.ok) throw new Error(await refusalOf(res, t('scenarios.compareError')));
            const out = (await res.json()) as { comparison?: Comparison };
            if (out.comparison) showComparison(s, out.comparison);
        } catch (e) {
            setRowError({ id: s.id, message: messageOf(e, t('scenarios.compareError')) });
        } finally { setBusy(false); }
    };

    // #4770 — a reload with `?compare=<id>` shows that scenario's comparison
    // again: it is read from the comparison route once the list has loaded,
    // and stands until the person opens another one or closes it.
    const compareParam = searchParams?.get('compare') ?? null;
    const reopenTarget = !cmp && compareParam
        ? scenarios.find((x) => x.id === compareParam && x.status !== 'ARCHIVED') ?? null
        : null;
    const reopenQuery = useTenantSWR<{ comparison: Comparison }>(
        reopenTarget ? `/risks/scenarios/${reopenTarget.id}/comparison` : null,
        { revalidateOnFocus: false },
    );

    /**
     * #4770 — archive takes the undo window (Epic 67). The row leaves the list
     * at once, and the DELETE is sent only when the window closes; Undo or a
     * refusal puts it back.
     */
    const archiveScenario = (s: Scenario) => {
        const previous = scenariosQuery.data;
        void scenariosQuery.mutate(
            { scenarios: scenarios.map((x) => (x.id === s.id ? { ...x, status: 'ARCHIVED' } : x)) },
            { revalidate: false },
        );
        if (cmp?.scenarioId === s.id || compareParam === s.id) closeComparison();
        triggerUndoToast({
            message: t('scenarios.archivedToast', { name: s.name }),
            undoMessage: t('scenarios.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/risks/scenarios/${s.id}`), { method: 'DELETE' }).catch(() => null);
                if (!res || !res.ok) throw new Error(await refusalOf(res, t('scenarios.archiveError')));
                await scenariosQuery.mutate();
            },
            undoAction: () => { if (previous) void scenariosQuery.mutate(previous, { revalidate: false }); },
            onError: (e) => {
                toast.error(messageOf(e, t('scenarios.archiveError')));
                if (previous) void scenariosQuery.mutate(previous, { revalidate: false });
            },
        });
    };

    // PR-L — clone a scenario (name + overrides) so a mis-created what-if is
    // recoverable without rebuilding it from scratch.
    const clone = async (s: Scenario) => {
        setBusy(true); setRowError(null);
        try {
            await writeMutation.trigger({
                path: `/risks/scenarios/${s.id}/clone`,
                method: 'POST',
                body: { name: t('scenarios.cloneName', { name: s.name }) },
                fallback: t('scenarios.cloneError'),
            });
        } catch (e) {
            setRowError({ id: s.id, message: messageOf(e, t('scenarios.cloneError')) });
        } finally { setBusy(false); }
    };

    const archivedCount = scenarios.filter((s) => s.status === 'ARCHIVED').length;
    const visible = showArchived ? scenarios : scenarios.filter((s) => s.status !== 'ARCHIVED');
    const displayed: ShownComparison | null = cmp
        ?? (reopenTarget && reopenQuery.data?.comparison
            ? { scenarioId: reopenTarget.id, scenarioName: reopenTarget.name, comparison: reopenQuery.data.comparison }
            : null);
    const shown = displayed?.comparison ?? null;
    const errorFor = (id: string) =>
        rowError?.id === id ? rowError.message
            : reopenTarget?.id === id && reopenQuery.error ? t('scenarios.compareError')
                : null;

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('scenarios.breadcrumb') }]} />
            <Heading level={1}>{t('scenarios.title')}</Heading>

            {canWrite && (
            <Card className="space-y-default p-6">
                <Heading level={2}>{t('scenarios.newScenario')}</Heading>
                <p className="text-sm text-content-muted">{t('scenarios.intro')}</p>
                <div className="flex flex-wrap items-end gap-default">
                    <label className="block flex-1"><span className="text-xs text-content-muted">{t('scenarios.name')}</span><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('scenarios.namePlaceholder')} /></label>
                    <label className="block"><span className="text-xs text-content-muted">{t('scenarios.investment', { currency })}</span><Input type="text" inputMode="decimal" value={investment} onChange={(e) => setInvestment(e.target.value)} placeholder={t('scenarios.investmentPlaceholder')} /></label>
                </div>

                {/* P2 — per-risk override builder. Each override patches one FAIR
                    field of one risk; the engine re-runs and compares. */}
                <div className="space-y-tight border-t border-border-subtle pt-default">
                    <span className="inline-flex items-center gap-tight text-xs font-medium text-content-muted">
                        {t('scenarios.overridesTitle')}
                        <InfoTooltip title={t('scenarios.conceptTitle')} content={t('scenarios.conceptHelp')} />
                    </span>
                    <div className="flex flex-wrap items-end gap-default">
                        <label className="block flex-1"><span className="text-xs text-content-muted">{t('scenarios.overrideRisk')}</span>
                            <RiskPicker id="scenario-override-risk" value={ovRiskId} onChange={(id, label) => { setOvRiskId(id); setOvRiskLabel(label ?? ''); }} placeholder={t('scenarios.overrideRiskPlaceholder')} />
                        </label>
                        <label className="block w-full sm:w-56"><span className="text-xs text-content-muted">{t('scenarios.overrideField')}</span>
                            <Combobox id="scenario-override-field" options={fieldOptions} selected={fieldOptions.find((o) => o.value === ovField) ?? null} setSelected={(opt) => { if (opt) { setOvField(opt.value as ScenarioFairField); setOvError(null); } }} />
                        </label>
                        <label className="block w-full sm:w-40"><span className="text-xs text-content-muted">{t('scenarios.overrideValue')}</span>
                            <Input type="text" inputMode="decimal" value={ovValue} onChange={(e) => { setOvValue(e.target.value); setOvError(null); }} placeholder={valuePlaceholder(ovField)} aria-describedby="scenario-override-unit" aria-invalid={ovError ? true : undefined} />
                        </label>
                        <Button variant="secondary" onClick={addOverride} disabled={!ovRiskId || !ovValue.trim()}>{t('scenarios.addOverride')}</Button>
                    </div>
                    <p id="scenario-override-unit" className="text-xs text-content-subtle" data-testid="scenario-override-unit">{unitHint(ovField)}</p>
                    {ovError && (
                        <p className="text-xs text-content-error" role="alert" data-testid="scenario-override-error">{ovError}</p>
                    )}
                    {overrides.length > 0 && (
                        <ul className="space-y-tight" data-testid="scenario-overrides">
                            {overrides.map((o, i) => (
                                <li key={`${o.riskId}-${o.field}`} className="flex items-center justify-between gap-default rounded-md border border-border-subtle px-3 py-1.5 text-sm">
                                    <span className="truncate text-content-emphasis">{o.label || o.riskId}</span>
                                    <span className="tabular-nums text-content-muted">{fieldLabel(o.field)} → {formatValue(o.field, o.newValue)}</span>
                                    <Button size="sm" variant="ghost" onClick={() => removeOverride(i)}>{t('scenarios.removeOverride')}</Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="flex items-center justify-end gap-default">
                    {/* The failure is shown here, next to the action that
                        produced it, with the server's reason when it gave one. */}
                    {createError && (
                        <span className="text-xs text-content-error" role="alert" data-testid="scenario-save-error">
                            {createError}
                        </span>
                    )}
                    <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>{t('scenarios.create')}</Button>
                </div>
            </Card>
            )}

            <Card className="space-y-default p-6">
                <div className="flex flex-wrap items-center justify-between gap-default">
                    <Heading level={2}>{t('scenarios.breadcrumb')}</Heading>
                    {/* #4770 — archived scenarios are kept, out of the way. */}
                    {archivedCount > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)} data-testid="scenario-archived-toggle" aria-pressed={showArchived}>
                            {showArchived ? t('scenarios.hideArchived') : t('scenarios.showArchived', { count: archivedCount })}
                        </Button>
                    )}
                </div>
                <AnalyticsState
                    isLoading={scenariosQuery.isLoading}
                    error={scenariosQuery.error}
                    isEmpty={visible.length === 0}
                    emptyText={archivedCount > 0 ? t('scenarios.noActive') : t('scenarios.empty')}
                    errorText={t('scenarios.loadError')}
                >
                    <ul className="divide-y divide-border-subtle">
                        {visible.map((s) => (
                            <li key={s.id} className="py-default text-sm" data-testid={`scenario-row-${s.id}`}>
                                <div className="flex flex-wrap items-center gap-default">
                                    <StatusBadge variant={s.status === 'SIMULATED' ? 'success' : s.status === 'ARCHIVED' ? 'neutral' : 'info'}>{statusLabel(s.status)}</StatusBadge>
                                    <span className="font-medium text-content-emphasis">{s.name}</span>
                                    {s.investmentCost != null && <span className="text-content-muted">{t('scenarios.invest', { money: money(s.investmentCost) })}</span>}
                                    {s.computedRoi != null && <span className="text-content-muted">{t('scenarios.roi', { roi: s.computedRoi.toFixed(1) })}</span>}
                                    <span className="ml-auto flex gap-tight">
                                        {s.status === 'SIMULATED' && (
                                            <Button size="sm" variant="secondary" onClick={() => loadComparison(s)} disabled={busy} data-testid={`scenario-show-comparison-${s.id}`}>{t('scenarios.showComparison')}</Button>
                                        )}
                                        {canWrite && s.status !== 'ARCHIVED' && (
                                            <Button size="sm" variant={s.status === 'SIMULATED' ? 'ghost' : 'secondary'} onClick={() => simulate(s)} disabled={busy} data-testid={`scenario-simulate-${s.id}`}>
                                                {s.status === 'SIMULATED' ? t('scenarios.runAgain') : t('scenarios.simulate')}
                                            </Button>
                                        )}
                                        {canWrite && <Button size="sm" variant="ghost" onClick={() => clone(s)} disabled={busy} data-testid={`scenario-clone-${s.id}`}>{t('scenarios.clone')}</Button>}
                                        {canArchive && s.status !== 'ARCHIVED' && <Button size="sm" variant="ghost" onClick={() => archiveScenario(s)} data-testid={`scenario-archive-${s.id}`}>{t('scenarios.archive')}</Button>}
                                    </span>
                                </div>
                                {errorFor(s.id) && (
                                    <p className="mt-tight text-xs text-content-error" role="alert" data-testid={`scenario-row-error-${s.id}`}>{errorFor(s.id)}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </AnalyticsState>
            </Card>

            {displayed && shown && (
                <Card className="space-y-default p-6" data-testid="scenario-comparison">
                    <div className="flex flex-wrap items-start justify-between gap-default">
                        <div>
                            <Heading level={2}>{t('scenarios.baselineVsScenario')}</Heading>
                            <p className="text-sm font-medium text-content-emphasis" data-testid="scenario-comparison-name">{t('scenarios.comparisonFor', { name: displayed.scenarioName })}</p>
                            <p className="text-xs text-content-subtle">{t('scenarios.comparisonBasis')}</p>
                        </div>
                        <Button size="sm" variant="ghost" onClick={closeComparison} data-testid="scenario-comparison-close">{t('scenarios.closeComparison')}</Button>
                    </div>
                    {/* Match the dashboard MonteCarloPanel's honesty: if either
                        sim dropped its correlation matrix (Cholesky failed →
                        independent sampling), the VaR figures understate tail
                        co-movement — tell the operator. */}
                    {(shown.baseline.correlationsDropped || shown.scenario.correlationsDropped) && (
                        <div
                            className="rounded-md border border-border-warning bg-bg-warning/15 p-3 text-sm text-content-warning"
                            role="alert"
                            data-testid="scenario-correlations-dropped"
                        >
                            {t('scenarios.correlationsDropped')}
                        </div>
                    )}
                    <table className="w-full text-sm">
                        <thead><tr className="text-content-muted"><th className="text-left">{t('scenarios.colMetric')}</th><th className="text-right">{t('scenarios.colBaseline')}</th><th className="text-right">{t('scenarios.colScenario')}</th><th className="text-right">{t('scenarios.colDelta')}</th></tr></thead>
                        <tbody className="tabular-nums">
                            <tr><td>{t('scenarios.meanAle')}</td><td className="text-right">{money(shown.baseline.portfolioAle.mean)}</td><td className="text-right">{money(shown.scenario.portfolioAle.mean)}</td><td className="text-right">{signed(shown.delta.meanAleDelta)}</td></tr>
                            <tr><td>{t('scenarios.var95')}</td><td className="text-right">{money(shown.baseline.portfolioAle.p95)}</td><td className="text-right">{money(shown.scenario.portfolioAle.p95)}</td><td className="text-right">{signed(shown.delta.varP95Delta)}</td></tr>
                            <tr><td>{t('scenarios.var99')}</td><td className="text-right">{money(shown.baseline.portfolioAle.p99)}</td><td className="text-right">{money(shown.scenario.portfolioAle.p99)}</td><td className="text-right">{signed(shown.delta.varP99Delta)}</td></tr>
                            {shown.delta.roi != null && <tr><td>{t('scenarios.roiLabel')}</td><td /><td /><td className="text-right">{shown.delta.roi.toFixed(1)}×</td></tr>}
                        </tbody>
                    </table>
                    {shown.perRiskDeltas.length > 0 && (
                        <div>
                            <Heading level={3} className="mb-2">{t('scenarios.perRiskImpact')}</Heading>
                            <ul className="space-y-tight">
                                {shown.perRiskDeltas.map((d) => (
                                    <li key={d.riskId} className="flex justify-between gap-default text-sm">
                                        <Link href={tenantHref(`/risks/${d.riskId}`)} className="truncate text-content-emphasis hover:underline" data-testid={`scenario-risk-link-${d.riskId}`}>{d.title}</Link>
                                        <span className="tabular-nums text-content-muted">{money(d.baselineAle)} → {money(d.scenarioAle)} ({d.deltaPercent.toFixed(0)}%)</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </Card>
            )}
        </div>
    );
}
