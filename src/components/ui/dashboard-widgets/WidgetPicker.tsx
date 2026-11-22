"use client";

/**
 * Epic 41 — `<WidgetPicker>` modal.
 *
 * Production-grade picker for adding new widgets to the org-level
 * dashboard. Built from existing Inflect primitives — Modal,
 * RadioGroup, FormField, Input, NumberStepper — so the visual
 * language matches every other create flow in the app (no bespoke
 * overlay, no one-off form chrome).
 *
 * Flow:
 *
 *   1. Open the modal via `open` / `onOpenChange` (parent controls
 *      lifecycle so the trigger button + the dialog stay decoupled).
 *
 *   2. The user picks a widget TYPE (radio group: KPI / DONUT / TREND /
 *      TENANT_LIST / DRILLDOWN_CTAS).
 *
 *   3. The form re-derives valid CHART VARIANT options + the per-type
 *      CONFIG inputs (e.g. KPI gets `format` + `chartType` choice; TREND
 *      gets a `days` stepper). The variant set + config defaults match
 *      the Zod schema in `org-dashboard-widget.schemas.ts` exactly so
 *      the POST round-trip never 400s on a default value.
 *
 *   4. The user can optionally set a custom TITLE (defaults to a
 *      human-readable label derived from the variant when blank).
 *
 *   5. Submit → caller's `onSubmit(input)` → modal closes on success
 *      and fires `onCreated(widget)` so the parent can append the new
 *      widget to its grid state.
 *
 * The picker does NOT decide where the new widget goes on the grid —
 * `react-grid-layout`'s vertical compactor places new tiles at the
 * top of the dashboard automatically, and the picker emits a default
 * `(x, y)` of `(0, 0)` plus a per-type sensible `(w, h)`. Re-arrange
 * is the existing drag affordance.
 *
 * Errors surface inline via the standard `<FormError>` slot beneath
 * the submit row; the modal stays open so the user can correct the
 * field that failed.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

import type {
    CreateOrgDashboardWidgetInput,
    OrgDashboardWidgetDto,
    UpdateOrgDashboardWidgetInput,
    WidgetPosition,
    WidgetSize,
} from '@/app-layer/schemas/org-dashboard-widget.schemas';
import { ShadedRow } from '@/components/ui/shaded-row';

const INITIATIVE_STATUSES = [
    'PLANNED',
    'IN_PROGRESS',
    'BLOCKED',
    'COMPLETED',
    'CANCELLED',
] as const;
type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

// ─── Variant catalogues ─────────────────────────────────────────────
//
// Each catalogue mirrors the Zod discriminated union in
// `org-dashboard-widget.schemas.ts`. A dropdown / stepper / checkbox
// here ALWAYS emits a value the schema accepts — that's the picker's
// load-bearing invariant. If the schema gains a new variant, this
// catalogue is the single edit alongside the renderer's switch arm.

type WidgetTypeKey =
    | 'KPI'
    | 'DONUT'
    | 'TREND'
    | 'TENANT_LIST'
    | 'DRILLDOWN_CTAS'
    | 'ORG_THREAT_LEVEL'
    | 'ORG_MATURITY'
    | 'ORG_INITIATIVES';

interface WidgetTypeOption {
    type: WidgetTypeKey;
    label: string;
    description: string;
    /** Default `(w, h)` for newly-created widgets of this type. */
    defaultSize: WidgetSize;
    /** Default chartType for the dropdown initial value. */
    defaultChartType: string;
}

// Locale-independent per-type metadata (sizes + default chart variant).
// The user-facing `label` / `description` are resolved at render time from
// the `widgets.types.*` catalog via `buildWidgetTypes(t)`.
const WIDGET_TYPE_META: Record<
    WidgetTypeKey,
    { defaultSize: WidgetSize; defaultChartType: string }
> = {
    KPI: { defaultSize: { w: 3, h: 2 }, defaultChartType: 'coverage' },
    DONUT: { defaultSize: { w: 4, h: 4 }, defaultChartType: 'rag-distribution' },
    TREND: { defaultSize: { w: 6, h: 3 }, defaultChartType: 'risks-open' },
    TENANT_LIST: { defaultSize: { w: 12, h: 6 }, defaultChartType: 'coverage' },
    DRILLDOWN_CTAS: { defaultSize: { w: 12, h: 2 }, defaultChartType: 'default' },
    // ─── Org-specific widgets (ported) ──────────────────────────────
    // Each locks a single chartType (banner / radar / list) per the Zod
    // discriminated union; the dispatcher renders the bespoke component.
    ORG_THREAT_LEVEL: { defaultSize: { w: 6, h: 2 }, defaultChartType: 'banner' },
    ORG_MATURITY: { defaultSize: { w: 6, h: 4 }, defaultChartType: 'radar' },
    ORG_INITIATIVES: { defaultSize: { w: 6, h: 4 }, defaultChartType: 'list' },
};

// Render order of the type radio group — also the source of truth for
// WIDGET_PICKER_TYPE_KEYS below.
const WIDGET_TYPE_ORDER: ReadonlyArray<WidgetTypeKey> = [
    'KPI',
    'DONUT',
    'TREND',
    'TENANT_LIST',
    'DRILLDOWN_CTAS',
    'ORG_THREAT_LEVEL',
    'ORG_MATURITY',
    'ORG_INITIATIVES',
];

/** i18n factory — resolves the type label + description at render time. */
function buildWidgetTypes(
    t: (key: string) => string,
): ReadonlyArray<WidgetTypeOption> {
    return WIDGET_TYPE_ORDER.map((type) => ({
        type,
        label: t(`types.${type}.label`),
        description: t(`types.${type}.description`),
        defaultSize: WIDGET_TYPE_META[type].defaultSize,
        defaultChartType: WIDGET_TYPE_META[type].defaultChartType,
    }));
}

/**
 * The widget types the "Add widget" picker offers. Exported so a parity test
 * can assert it covers EVERY type in the schema's discriminated union — the
 * check that was missing when the three ORG_* widgets shipped wired into the
 * dispatcher + schema + presets but absent from the picker.
 */
export const WIDGET_PICKER_TYPE_KEYS: ReadonlyArray<string> = WIDGET_TYPE_ORDER;

/** i18n factory — the per-type chart-variant dropdown options. */
function buildChartTypeOptions(
    t: (key: string) => string,
): Record<WidgetTypeKey, ReadonlyArray<{ value: string; label: string }>> {
    return {
        KPI: [
            { value: 'coverage', label: t('chartTypes.coverage') },
            { value: 'critical-risks', label: t('chartTypes.criticalRisks') },
            { value: 'overdue-evidence', label: t('chartTypes.overdueEvidence') },
            { value: 'tenants', label: t('chartTypes.tenants') },
        ],
        DONUT: [
            { value: 'rag-distribution', label: t('chartTypes.ragDistribution') },
        ],
        TREND: [
            { value: 'risks-open', label: t('chartTypes.risksOpen') },
            { value: 'controls-coverage', label: t('chartTypes.controlsCoverage') },
            { value: 'evidence-overdue', label: t('chartTypes.evidenceOverdue') },
        ],
        TENANT_LIST: [
            { value: 'coverage', label: t('chartTypes.coverage') },
        ],
        DRILLDOWN_CTAS: [
            { value: 'default', label: t('chartTypes.drilldownDefault') },
        ],
        // Org widgets each have one fixed visualization; the "Data source"
        // dropdown shows a single, self-describing option.
        ORG_THREAT_LEVEL: [
            { value: 'banner', label: t('chartTypes.postureBanner') },
        ],
        ORG_MATURITY: [
            { value: 'radar', label: t('chartTypes.maturityRadar') },
        ],
        ORG_INITIATIVES: [
            { value: 'list', label: t('chartTypes.initiativeList') },
        ],
    };
}

function defaultConfigFor(
    type: WidgetTypeKey,
    chartType: string,
): Record<string, unknown> {
    switch (type) {
        case 'KPI':
            return { format: chartType === 'coverage' ? 'percent' : 'number' };
        case 'DONUT':
            return { showLegend: true };
        case 'TREND':
            return { days: 90 };
        case 'TENANT_LIST':
            return { sortBy: 'rag' };
        case 'DRILLDOWN_CTAS':
            return {};
        case 'ORG_THREAT_LEVEL':
            return { showHistory: false };
        case 'ORG_MATURITY':
            return { view: 'radar' };
        case 'ORG_INITIATIVES':
            return { topN: 5 };
    }
}

// ─── Component ──────────────────────────────────────────────────────

export interface WidgetPickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /**
     * Caller's persistence callback. Resolves with the persisted
     * widget so the parent can append it to its grid state.
     */
    onSubmit: (
        input: CreateOrgDashboardWidgetInput,
    ) => Promise<OrgDashboardWidgetDto>;
    /**
     * Fired after `onSubmit` resolves successfully. The picker closes
     * itself; the parent can refresh local state from this hook.
     */
    onCreated?: (widget: OrgDashboardWidgetDto) => void;
    /**
     * Default top-left position for the new widget. The vertical
     * compactor will adjust based on existing rows; the picker just
     * provides a sane starting point. Default `(0, 0)`.
     */
    defaultPosition?: WidgetPosition;
    /**
     * When set, the picker opens in EDIT mode pre-filled from this
     * widget: the type is locked (immutable — changing it is delete +
     * recreate), and submit PATCHes title/chartType/config via
     * `onUpdate` instead of creating a new widget.
     */
    editWidget?: OrgDashboardWidgetDto | null;
    /**
     * Persistence callback for EDIT mode. Required when `editWidget`
     * is provided. Resolves with the updated widget.
     */
    onUpdate?: (
        id: string,
        patch: UpdateOrgDashboardWidgetInput,
    ) => Promise<OrgDashboardWidgetDto>;
}

export function WidgetPicker({
    open,
    onOpenChange,
    onSubmit,
    onCreated,
    defaultPosition = { x: 0, y: 0 },
    editWidget,
    onUpdate,
}: WidgetPickerProps) {
    const t = useTranslations('widgets');
    const isEdit = Boolean(editWidget);
    const widgetTypes = useMemo(
        () => buildWidgetTypes((k) => t(k as Parameters<typeof t>[0])),
        [t],
    );
    const chartTypeOptions = useMemo(
        () => buildChartTypeOptions((k) => t(k as Parameters<typeof t>[0])),
        [t],
    );
    const [type, setType] = useState<WidgetTypeKey>('KPI');
    const [chartType, setChartType] = useState<string>('coverage');
    const [title, setTitle] = useState<string>('');
    const [days, setDays] = useState<number>(90);
    const [showLegend, setShowLegend] = useState<boolean>(true);
    const [kpiFormat, setKpiFormat] = useState<'number' | 'percent'>(
        'percent',
    );
    const [tenantSort, setTenantSort] = useState<'rag' | 'name' | 'coverage'>(
        'rag',
    );
    // Org-widget config state.
    const [orgShowHistory, setOrgShowHistory] = useState<boolean>(false);
    const [maturityView, setMaturityView] = useState<'radar' | 'trend'>('radar');
    const [maturityCoverageHint, setMaturityCoverageHint] = useState<boolean>(false);
    const [initiativesTopN, setInitiativesTopN] = useState<number>(5);
    // Item 6 — previously-omitted optional config knobs.
    const [donutMaxSegments, setDonutMaxSegments] = useState<string>('');
    const [tenantLimit, setTenantLimit] = useState<string>('');
    const [initiativesStatus, setInitiativesStatus] = useState<InitiativeStatus[]>([]);
    // Item 1 — TREND target line.
    const [targetEnabled, setTargetEnabled] = useState<boolean>(false);
    const [targetValue, setTargetValue] = useState<string>('');
    const [targetLabel, setTargetLabel] = useState<string>('');
    const [targetPolarity, setTargetPolarity] = useState<'above-good' | 'below-good' | ''>('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Edit-mode hydration guard — hydrate once per (open, widget id) so a
    // user's mid-edit changes aren't clobbered by a re-render.
    const [hydratedFor, setHydratedFor] = useState<string | null>(null);

    const meta = useMemo(
        () => widgetTypes.find((w) => w.type === type) ?? widgetTypes[0],
        [widgetTypes, type],
    );
    const variants = chartTypeOptions[type];

    // Reset form when modal toggles closed → open transitions are
    // discoverable. We don't want a half-filled prior session
    // resurfacing on the next open.
    function resetState() {
        setType('KPI');
        setChartType('coverage');
        setTitle('');
        setDays(90);
        setShowLegend(true);
        setKpiFormat('percent');
        setTenantSort('rag');
        setOrgShowHistory(false);
        setMaturityView('radar');
        setMaturityCoverageHint(false);
        setInitiativesTopN(5);
        setDonutMaxSegments('');
        setTenantLimit('');
        setInitiativesStatus([]);
        setTargetEnabled(false);
        setTargetValue('');
        setTargetLabel('');
        setTargetPolarity('');
        setHydratedFor(null);
        setError(null);
        setSubmitting(false);
    }

    // ── Edit-mode hydration ──
    //
    // Reverse-map the persisted widget's config back into the form
    // state so an operator can reconfigure it (title / chartType /
    // config) without delete + re-add. Runs once per open per widget.
    useEffect(() => {
        if (!open || !editWidget) return;
        if (hydratedFor === editWidget.id) return;
        const w = editWidget;
        const c = (w.config ?? {}) as Record<string, unknown>;
        setType(w.type as WidgetTypeKey);
        setChartType(w.chartType);
        setTitle(w.title ?? '');
        if (typeof c.format === 'string') setKpiFormat(c.format === 'number' ? 'number' : 'percent');
        if (typeof c.days === 'number') setDays(c.days);
        if (typeof c.showLegend === 'boolean') setShowLegend(c.showLegend);
        if (typeof c.sortBy === 'string') setTenantSort(c.sortBy as 'rag' | 'name' | 'coverage');
        if (typeof c.showHistory === 'boolean') setOrgShowHistory(c.showHistory);
        if (typeof c.view === 'string') setMaturityView(c.view as 'radar' | 'trend');
        if (typeof c.showCoverageHint === 'boolean') setMaturityCoverageHint(c.showCoverageHint);
        if (typeof c.topN === 'number') setInitiativesTopN(c.topN);
        setDonutMaxSegments(typeof c.maxSegments === 'number' ? String(c.maxSegments) : '');
        setTenantLimit(typeof c.limit === 'number' ? String(c.limit) : '');
        setInitiativesStatus(
            Array.isArray(c.statusFilter) ? (c.statusFilter as InitiativeStatus[]) : [],
        );
        const target = c.target as
            | { value?: number; label?: string; polarity?: 'above-good' | 'below-good' }
            | undefined;
        setTargetEnabled(Boolean(target && typeof target.value === 'number'));
        setTargetValue(target && typeof target.value === 'number' ? String(target.value) : '');
        setTargetLabel(target?.label ?? '');
        setTargetPolarity(target?.polarity ?? '');
        setHydratedFor(w.id);
        setError(null);
    }, [open, editWidget, hydratedFor]);

    function handleTypeChange(next: string) {
        const nextType = next as WidgetTypeKey;
        setType(nextType);
        const m = widgetTypes.find((w) => w.type === nextType);
        if (m) setChartType(m.defaultChartType);
        setError(null);
    }

    function buildConfig(): Record<string, unknown> {
        const base = defaultConfigFor(type, chartType);
        switch (type) {
            case 'KPI':
                return { ...base, format: kpiFormat };
            case 'TREND': {
                const cfg: Record<string, unknown> = { ...base, days };
                const num = Number.parseFloat(targetValue);
                if (targetEnabled && Number.isFinite(num)) {
                    const target: Record<string, unknown> = { value: num };
                    if (targetLabel.trim()) target.label = targetLabel.trim();
                    if (targetPolarity) target.polarity = targetPolarity;
                    cfg.target = target;
                }
                return cfg;
            }
            case 'DONUT': {
                const cfg: Record<string, unknown> = { ...base, showLegend };
                const max = Number.parseInt(donutMaxSegments, 10);
                if (Number.isFinite(max)) cfg.maxSegments = Math.min(8, Math.max(2, max));
                return cfg;
            }
            case 'TENANT_LIST': {
                const cfg: Record<string, unknown> = { ...base, sortBy: tenantSort };
                const lim = Number.parseInt(tenantLimit, 10);
                if (Number.isFinite(lim)) cfg.limit = Math.min(200, Math.max(1, lim));
                return cfg;
            }
            case 'DRILLDOWN_CTAS':
                return base;
            // Org configs are `.strict()` in the schema — emit ONLY the
            // allowed keys (no `base` spread that could leak a stray field).
            case 'ORG_THREAT_LEVEL':
                return { showHistory: orgShowHistory };
            case 'ORG_MATURITY':
                return { view: maturityView, showCoverageHint: maturityCoverageHint };
            case 'ORG_INITIATIVES': {
                const cfg: Record<string, unknown> = { topN: initiativesTopN };
                if (initiativesStatus.length > 0) cfg.statusFilter = initiativesStatus;
                return cfg;
            }
        }
    }

    async function handleSubmit() {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const trimmedTitle = title.trim().length > 0 ? title.trim() : null;
            let widget: OrgDashboardWidgetDto;
            if (isEdit && editWidget && onUpdate) {
                // Type is immutable; PATCH title + chartType + config.
                widget = await onUpdate(editWidget.id, {
                    title: trimmedTitle,
                    chartType,
                    config: buildConfig(),
                } as UpdateOrgDashboardWidgetInput);
            } else {
                const input = {
                    type,
                    chartType,
                    config: buildConfig(),
                    title: trimmedTitle,
                    position: defaultPosition,
                    size: meta.defaultSize,
                    enabled: true,
                } as CreateOrgDashboardWidgetInput;
                widget = await onSubmit(input);
            }
            onCreated?.(widget);
            onOpenChange(false);
            resetState();
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : isEdit
                        ? t('couldNotUpdate')
                        : t('couldNotCreate'),
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => {
                // Modal's setShowModal accepts SetStateAction<boolean>;
                // resolve the optional updater form into a concrete
                // boolean before forwarding to the controlled callback.
                const resolved = typeof next === 'function' ? next(open) : next;
                onOpenChange(resolved);
                if (!resolved) resetState();
            }}
        >
            <Modal.Header
                title={isEdit ? t('editWidget') : t('addWidget')}
                description={isEdit ? t('editWidgetDescription') : t('addWidgetDescription')}
            />
            <Modal.Body>
                <div className="space-y-section">
                    {/* ── Step 1: type ── */}
                    <FormField
                        label={t('widgetType')}
                        description={t('widgetTypeDescription')}
                    >
                        <RadioGroup
                            value={type}
                            onValueChange={handleTypeChange}
                            data-testid="widget-picker-type"
                            disabled={isEdit}
                        >
                            {widgetTypes.map((opt) => (
                                <ShadedRow
                                    key={opt.type}
                                    interactive={!isEdit}
                                    className={isEdit ? 'flex items-start gap-compact opacity-60' : 'flex items-start gap-compact cursor-default'}
                                >
                                    <RadioGroupItem
                                        value={opt.type}
                                        id={`widget-type-${opt.type}`}
                                        aria-label={opt.label}
                                        disabled={isEdit}
                                    />
                                    <div className="min-w-0">
                                        <Label
                                            htmlFor={`widget-type-${opt.type}`}
                                            className="text-sm font-medium text-content-emphasis cursor-pointer"
                                        >
                                            {opt.label}
                                        </Label>
                                        <p className="text-xs text-content-muted mt-0.5">
                                            {opt.description}
                                        </p>
                                    </div>
                                </ShadedRow>
                            ))}
                        </RadioGroup>
                    </FormField>

                    {/* ── Step 2: chart variant ── */}
                    <FormField
                        label={t('dataSource')}
                        description={
                            type === 'TREND'
                                ? t('dataSourceTrend')
                                : t('dataSourceDefault')
                        }
                    >
                        <select
                            value={chartType}
                            onChange={(e) => setChartType(e.target.value)}
                            data-testid="widget-picker-chart-type"
                            className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                            {variants.map((v) => (
                                <option key={v.value} value={v.value}>
                                    {v.label}
                                </option>
                            ))}
                        </select>
                    </FormField>

                    {/* ── Step 3: per-type config ── */}
                    {type === 'KPI' && (
                        <FormField
                            label={t('format')}
                            description={t('formatDescription')}
                        >
                            <RadioGroup
                                value={kpiFormat}
                                onValueChange={(v) =>
                                    setKpiFormat(v as 'number' | 'percent')
                                }
                                data-testid="widget-picker-kpi-format"
                                className="flex gap-default"
                            >
                                {[
                                    { value: 'number', label: t('number') },
                                    { value: 'percent', label: t('percent') },
                                ].map((opt) => (
                                    <div
                                        key={opt.value}
                                        className="flex items-center gap-tight"
                                    >
                                        <RadioGroupItem
                                            value={opt.value}
                                            id={`kpi-format-${opt.value}`}
                                            aria-label={opt.label}
                                        />
                                        <Label
                                            htmlFor={`kpi-format-${opt.value}`}
                                            className="text-sm cursor-pointer"
                                        >
                                            {opt.label}
                                        </Label>
                                    </div>
                                ))}
                            </RadioGroup>
                        </FormField>
                    )}

                    {type === 'TREND' && (
                        <FormField
                            label={t('window')}
                            description={t('windowDescription')}
                        >
                            <input
                                type="number"
                                min={7}
                                max={365}
                                step={1}
                                value={days}
                                onChange={(e) => {
                                    const next = Number.parseInt(
                                        e.target.value,
                                        10,
                                    );
                                    if (Number.isFinite(next)) setDays(next);
                                }}
                                data-testid="widget-picker-trend-days"
                                className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                        </FormField>
                    )}

                    {type === 'TREND' && (
                        <FormField
                            label={t('targetLine')}
                            description={t('targetLineDescription')}
                        >
                          <div className="space-y-tight">
                            <label className="flex items-center gap-tight text-sm text-content-emphasis">
                                <input
                                    type="checkbox"
                                    checked={targetEnabled}
                                    onChange={(e) => setTargetEnabled(e.target.checked)}
                                    data-testid="widget-picker-target-enabled"
                                    className="size-4 rounded border-border-default focus:ring-ring"
                                />
                                {t('showTargetLine')}
                            </label>
                            {targetEnabled && (
                                <div className="mt-tight space-y-tight">
                                    <input
                                        type="number"
                                        step="any"
                                        value={targetValue}
                                        onChange={(e) => setTargetValue(e.target.value)}
                                        placeholder={t('targetValuePlaceholder')}
                                        aria-label={t('targetValue')}
                                        data-testid="widget-picker-target-value"
                                        className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                                    />
                                    <input
                                        type="text"
                                        value={targetLabel}
                                        onChange={(e) => setTargetLabel(e.target.value)}
                                        maxLength={60}
                                        placeholder={t('targetLabelPlaceholder')}
                                        aria-label={t('targetLabel')}
                                        data-testid="widget-picker-target-label"
                                        className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis placeholder:text-content-subtle focus:outline-none focus:ring-2 focus:ring-ring"
                                    />
                                    <select
                                        value={targetPolarity}
                                        onChange={(e) =>
                                            setTargetPolarity(
                                                e.target.value as 'above-good' | 'below-good' | '',
                                            )
                                        }
                                        aria-label={t('targetPolarity')}
                                        data-testid="widget-picker-target-polarity"
                                        className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                                    >
                                        <option value="">{t('targetPolarityNone')}</option>
                                        <option value="above-good">{t('targetAboveGood')}</option>
                                        <option value="below-good">{t('targetBelowGood')}</option>
                                    </select>
                                </div>
                            )}
                          </div>
                        </FormField>
                    )}

                    {type === 'DONUT' && (
                        <FormField label={t('options')}>
                          <div className="space-y-tight">
                            <label className="flex items-center gap-tight text-sm text-content-emphasis">
                                <input
                                    type="checkbox"
                                    checked={showLegend}
                                    onChange={(e) =>
                                        setShowLegend(e.target.checked)
                                    }
                                    data-testid="widget-picker-donut-legend"
                                    className="size-4 rounded border-border-default focus:ring-ring"
                                />
                                {t('showLegend')}
                            </label>
                            <input
                                type="number"
                                min={2}
                                max={8}
                                step={1}
                                value={donutMaxSegments}
                                onChange={(e) => setDonutMaxSegments(e.target.value)}
                                placeholder={t('maxSegmentsPlaceholder')}
                                aria-label={t('maxSegments')}
                                data-testid="widget-picker-donut-max-segments"
                                className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis placeholder:text-content-subtle focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                          </div>
                        </FormField>
                    )}

                    {type === 'TENANT_LIST' && (
                        <FormField
                            label={t('sortBy')}
                            description={t('sortByDescription')}
                        >
                          <div className="space-y-tight">
                            <select
                                value={tenantSort}
                                onChange={(e) =>
                                    setTenantSort(
                                        e.target.value as
                                            | 'rag'
                                            | 'name'
                                            | 'coverage',
                                    )
                                }
                                data-testid="widget-picker-tenant-sort"
                                className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                            >
                                <option value="rag">{t('sortRag')}</option>
                                <option value="name">{t('sortName')}</option>
                                <option value="coverage">{t('sortCoverage')}</option>
                            </select>
                            <input
                                type="number"
                                min={1}
                                max={200}
                                step={1}
                                value={tenantLimit}
                                onChange={(e) => setTenantLimit(e.target.value)}
                                placeholder={t('rowLimitPlaceholder')}
                                aria-label={t('rowLimit')}
                                data-testid="widget-picker-tenant-limit"
                                className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis placeholder:text-content-subtle focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                          </div>
                        </FormField>
                    )}

                    {type === 'ORG_THREAT_LEVEL' && (
                        <FormField label={t('options')}>
                            <label className="flex items-center gap-tight text-sm text-content-emphasis">
                                <input
                                    type="checkbox"
                                    checked={orgShowHistory}
                                    onChange={(e) => setOrgShowHistory(e.target.checked)}
                                    data-testid="widget-picker-threat-history"
                                    className="size-4 rounded border-border-default focus:ring-ring"
                                />
                                {t('showPostureHistory')}
                            </label>
                        </FormField>
                    )}

                    {type === 'ORG_MATURITY' && (
                        <>
                            <FormField
                                label={t('defaultView')}
                                description={t('defaultViewDescription')}
                            >
                                <select
                                    value={maturityView}
                                    onChange={(e) =>
                                        setMaturityView(e.target.value as 'radar' | 'trend')
                                    }
                                    data-testid="widget-picker-maturity-view"
                                    className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                                >
                                    <option value="radar">{t('radar')}</option>
                                    <option value="trend">{t('trend')}</option>
                                </select>
                            </FormField>
                            <FormField label={t('options')}>
                                <label className="flex items-center gap-tight text-sm text-content-emphasis">
                                    <input
                                        type="checkbox"
                                        checked={maturityCoverageHint}
                                        onChange={(e) => setMaturityCoverageHint(e.target.checked)}
                                        data-testid="widget-picker-maturity-coverage-hint"
                                        className="size-4 rounded border-border-default focus:ring-ring"
                                    />
                                    {t('showCoverageHint')}
                                </label>
                            </FormField>
                        </>
                    )}

                    {type === 'ORG_INITIATIVES' && (
                        <FormField
                            label={t('howManyToShow')}
                            description={t('howManyDescription')}
                        >
                            <input
                                type="number"
                                min={1}
                                max={20}
                                step={1}
                                value={initiativesTopN}
                                onChange={(e) => {
                                    const next = Number.parseInt(e.target.value, 10);
                                    if (Number.isFinite(next)) {
                                        setInitiativesTopN(Math.min(20, Math.max(1, next)));
                                    }
                                }}
                                data-testid="widget-picker-initiatives-topn"
                                className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                        </FormField>
                    )}

                    {type === 'ORG_INITIATIVES' && (
                        <FormField
                            label={t('statusFilter')}
                            description={t('statusFilterDescription')}
                        >
                            <div
                                className="flex flex-wrap gap-default"
                                data-testid="widget-picker-initiatives-status"
                            >
                                {INITIATIVE_STATUSES.map((s) => (
                                    <label
                                        key={s}
                                        className="flex items-center gap-tight text-sm text-content-emphasis"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={initiativesStatus.includes(s)}
                                            onChange={(e) =>
                                                setInitiativesStatus((prev) =>
                                                    e.target.checked
                                                        ? [...prev, s]
                                                        : prev.filter((x) => x !== s),
                                                )
                                            }
                                            data-testid={`widget-picker-initiatives-status-${s}`}
                                            className="size-4 rounded border-border-default focus:ring-ring"
                                        />
                                        {t(`initiativeStatus.${s}`)}
                                    </label>
                                ))}
                            </div>
                        </FormField>
                    )}

                    {/* ── Step 4: title (optional) ── */}
                    <FormField
                        label={t('title')}
                        description={t('titleDescription')}
                    >
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={120}
                            placeholder={meta.label}
                            data-testid="widget-picker-title"
                            className="block w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-emphasis placeholder:text-content-subtle focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                    </FormField>

                    {error && (
                        <div
                            role="alert"
                            data-testid="widget-picker-error"
                            className="rounded-md border border-border-error bg-bg-error/10 px-3 py-2 text-sm text-content-error"
                        >
                            {error}
                        </div>
                    )}
                </div>
            </Modal.Body>
            <Modal.Actions>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                        // The same path as closing the modal (#5309): an
                        // abandoned edit must not leak into the next open.
                        onOpenChange(false);
                        resetState();
                    }}
                    data-testid="widget-picker-cancel"
                    disabled={submitting}
                >
                    {t('cancel')}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                        void handleSubmit();
                    }}
                    data-testid="widget-picker-submit"
                    disabled={submitting}
                >
                    {isEdit
                        ? submitting
                            ? t('saving')
                            : t('saveChanges')
                        : submitting
                            ? t('adding')
                            : t('addWidget')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
