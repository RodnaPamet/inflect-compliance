'use client';
import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
    ShieldCheck,
    TrendingUp,
    ListChecks,
    ScrollText,
    Download,
    ArrowRight,
} from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { KPIStat } from '@/components/ui/metric';
import { ProgressBar } from '@/components/ui/progress-bar';
import { cardVariants } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { PdfExportButton } from '@/components/PdfExportButton';
import { RequirePermission } from '@/components/require-permission';
import { UpgradeGate } from '@/components/UpgradeGate';
import useSWR from 'swr';
import { Tooltip } from '@/components/ui/tooltip';
import { buttonVariants } from '@/components/ui/button-variants';
import { LoadingSpinner } from '@/components/ui/icons/loading-spinner';
import { InlineNotice } from '@/components/ui/inline-notice';

// ─── Types (mirror generateReadinessReport's payload) ───
interface InstalledFramework {
    key: string;
    name: string;
    isIsoFamily: boolean;
}
interface ReadinessReport {
    framework: { key: string; name: string; version: string | null };
    generatedAt: string;
    coverage: { total: number; mapped: number; unmapped: number; coveragePercent: number };
    bySection: { section: string; total: number; mapped: number; coveragePercent: number }[];
    unmappedRequirements: { code: string; title: string; section: string }[];
    controlsMissingEvidence: { code: string; name: string; status: string }[];
    overdueTasks: {
        taskTitle: string;
        taskStatus: string;
        dueDate: string;
        controlCode: string | null;
        controlName: string;
    }[];
    summary: {
        totalRequirements: number;
        mappedRequirements: number;
        coveragePercent: number;
        implementedRequirements: number;
        gapRequirements: number;
        exceptedRequirements: number;
        notApplicableCount: number;
        missingEvidenceCount: number;
        overdueTaskCount: number;
        readinessScore: number;
    };
}

interface ReportsClientProps {
    installedFrameworks: InstalledFramework[];
    defaultFrameworkKey: string;
    initialReadiness: ReadinessReport;
    tenantSlug: string;
    canEdit: boolean;
}

/**
 * Reports catalog (PR-G). A framework selector scopes every framework-dependent
 * report; the universal default is an on-screen per-framework Coverage/Readiness
 * view. SoA is an ISO-family-only entry in the catalog.
 */
export function ReportsClient({
    installedFrameworks,
    defaultFrameworkKey,
    initialReadiness,
    tenantSlug,
    canEdit,
}: ReportsClientProps) {
    const tx = useTranslations('reports');
    // The hub's risk-report card lists what the tenant ACTUALLY has, including
    // custom templates. Read-only and non-blocking: the card renders without it
    // and shows nothing until it arrives.
    //
    // Plain `useSWR` over the `tenantSlug` prop rather than `useTenantSWR`:
    // this component is handed its slug explicitly and is rendered in tests
    // without a TenantProvider, so reaching for tenant context here would add a
    // provider dependency the component does not otherwise have — for one
    // read-only list.
    const { data: riskReports } = useSWR<{ templates: { id: string; name: string }[] }>(
        `/api/t/${tenantSlug}/risks/reports`,
        async (url: string) => {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`templates ${r.status}`);
            return r.json();
        },
    );
    const riskTemplates = riskReports?.templates;
    const [selectedKey, setSelectedKey] = useState(defaultFrameworkKey);
    const [readiness, setReadiness] = useState<ReadinessReport>(initialReadiness);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const selectedFw =
        installedFrameworks.find((f) => f.key === selectedKey) ?? null;
    const isIso = selectedFw?.isIsoFamily ?? false;
    const frameworkLabel = selectedFw?.name ?? readiness.framework.name;

    const switchFramework = useCallback(
        async (key: string) => {
            setSelectedKey(key);
            // The default framework's report was computed server-side — reuse it.
            if (key === defaultFrameworkKey) {
                setReadiness(initialReadiness);
                setError(null);
                return;
            }
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(
                    `/api/t/${tenantSlug}/reports/readiness?framework=${encodeURIComponent(key)}`,
                );
                if (!res.ok) throw new Error(`status ${res.status}`);
                setReadiness((await res.json()) as ReadinessReport);
            } catch {
                setError(tx('readinessLoadError'));
            } finally {
                setLoading(false);
            }
        },
        [tenantSlug, defaultFrameworkKey, initialReadiness, tx],
    );

    const frameworkOptions: ComboboxOption[] = installedFrameworks.map((f) => ({
        value: f.key,
        label: f.name,
    }));
    const selectedOption =
        frameworkOptions.find((o) => o.value === selectedKey) ?? null;

    const s = readiness.summary;
    const implementedPct =
        s.totalRequirements > 0
            ? Math.round((s.implementedRequirements / s.totalRequirements) * 100)
            : 0;

    return (
        <div className="space-y-section">
            {/* ── Header + framework selector ── */}
            <div className="flex flex-col gap-compact">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-compact">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: tx('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: tx('title') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1} id="reports-heading">{tx('title')}</Heading>
                        <p className="text-sm text-content-muted mt-1">{tx('catalogSubtitle')}</p>
                    </div>
                    <RequirePermission resource="admin" action="manage">
                        <Tooltip content={tx('trustCenter')}>
                            <Link
                                href={`/t/${tenantSlug}/admin/trust-center`}
                                aria-label={tx('trustCenter')}
                                id="reports-trust-center-link"
                                className={buttonVariants({ variant: 'secondary', size: 'icon' })}
                            >
                                <ShieldCheck className="w-3.5 h-3.5" />
                            </Link>
                        </Tooltip>
                    </RequirePermission>
                </div>
                <FormField label={tx('frameworkLabel')} orientation="horizontal">
                    <div className="w-full sm:w-64" id="reports-framework-select">
                        <Combobox
                            options={frameworkOptions}
                            selected={selectedOption}
                            setSelected={(o) => o && switchFramework(o.value)}
                            disabled={installedFrameworks.length <= 1}
                            aria-label={tx('frameworkLabel')}
                            forceDropdown
                            matchTriggerWidth
                        />
                    </div>
                </FormField>
            </div>

            {/* ── Report catalog ── */}
            <div
                className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-default"
                data-testid="report-catalog"
            >
                <ReportCard
                    icon={<TrendingUp className="w-4 h-4" />}
                    title={tx('cardCoverageTitle')}
                    description={tx('cardCoverageDesc', { framework: frameworkLabel })}
                    testid="report-card-coverage"
                    action={
                        <a
                            href="#readiness-report"
                            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                        >
                            {tx('viewOnPage')}
                        </a>
                    }
                />
                <ReportCard
                    icon={<ListChecks className="w-4 h-4" />}
                    title={tx('cardGapTitle')}
                    description={tx('cardGapDesc', { framework: frameworkLabel })}
                    testid="report-card-gap"
                    action={
                        <RequirePermission resource="reports" action="export">
                            <UpgradeGate feature="PDF_EXPORTS">
                                <PdfExportButton
                                    tenantSlug={tenantSlug}
                                    reportType="GAP_ANALYSIS"
                                    framework={selectedKey}
                                    label={tx('exportPdf')}
                                    allowSave={canEdit}
                                />
                            </UpgradeGate>
                        </RequirePermission>
                    }
                />
                <ReportCard
                    icon={<ScrollText className="w-4 h-4" />}
                    title={tx('cardRiskTitle')}
                    description={tx('cardRiskDesc')}
                    testid="report-card-risk"
                    action={
                        <div className="flex flex-col gap-tight w-full">
                            {/* PR-I — surface the mature risk-report engine's
                                templates on the hub (PDF/CSV/PPTX + ReportRun
                                lifecycle + schedules live at /risks/reports).
                                The hub no longer offers a thin duplicate. */}
                            {/* The real list, not three hardcoded strings.
                                These duplicated SYSTEM_TEMPLATES, so a tenant's
                                CUSTOM template — creatable at /risks/reports —
                                never appeared here. Worse, the hub TRANSLATED
                                the names while /risks/reports renders the raw
                                English DB value, so in bg the same template had
                                two different names one click apart. Reading the
                                DB makes the hub agree with the page by
                                construction. */}
                            <ul
                                className="text-xs text-content-subtle space-y-0.5"
                                data-testid="risk-report-templates"
                            >
                                {(riskTemplates ?? []).slice(0, 5).map((tpl) => (
                                    <li key={tpl.id}>• {tpl.name}</li>
                                ))}
                                {(riskTemplates?.length ?? 0) > 5 && (
                                    <li className="text-content-subtle">
                                        {tx('riskTplMore', { count: (riskTemplates?.length ?? 0) - 5 })}
                                    </li>
                                )}
                            </ul>
                            <Link
                                href={`/t/${tenantSlug}/risks/reports`}
                                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                                id="report-card-risk-link"
                            >
                                {tx('openRiskReports')} <ArrowRight className="w-3.5 h-3.5" />
                            </Link>
                        </div>
                    }
                />
                {isIso && (
                    <ReportCard
                        icon={<ShieldCheck className="w-4 h-4" />}
                        title={tx('cardSoaTitle')}
                        description={tx('cardSoaDesc', { framework: frameworkLabel })}
                        testid="report-card-soa"
                        action={
                            <div className="flex items-center gap-tight">
                                <Link
                                    href={`/t/${tenantSlug}/reports/soa?framework=${encodeURIComponent(selectedKey)}`}
                                    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                                    id="report-card-soa-link"
                                >
                                    {tx('openSoa')} <ArrowRight className="w-3.5 h-3.5" />
                                </Link>
                                <RequirePermission resource="reports" action="export">
                                    <a
                                        href={`/api/t/${tenantSlug}/reports/soa/export.csv?framework=${encodeURIComponent(selectedKey)}`}
                                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                                        download
                                        id="export-soa-btn"
                                    >
                                        <Download className="w-3.5 h-3.5" /> {tx('exportCsv')}
                                    </a>
                                </RequirePermission>
                            </div>
                        }
                    />
                )}
            </div>

            {/* ── On-screen Coverage/Readiness report (universal default) ── */}
            <section id="readiness-report" className="space-y-default scroll-mt-4">
                <div className="flex items-center justify-between">
                    <Heading level={2}>{tx('readinessHeading', { framework: frameworkLabel })}</Heading>
                    <RequirePermission resource="reports" action="export">
                        <UpgradeGate feature="PDF_EXPORTS">
                            <PdfExportButton
                                tenantSlug={tenantSlug}
                                reportType="AUDIT_READINESS"
                                    framework={selectedKey}
                                label={tx('exportPdf')}
                                allowSave={canEdit}
                            />
                        </UpgradeGate>
                    </RequirePermission>
                </div>

                {error && <InlineNotice variant="error">{error}</InlineNotice>}

                {loading ? (
                    <div className="flex items-center gap-tight text-sm text-content-muted py-8">
                        <LoadingSpinner /> {tx('loadingReadiness')}
                    </div>
                ) : (
                    <div className="space-y-default" data-testid="readiness-report-body">
                        {/* Metrics — mapping density AND implementation, side by side,
                            so "coverage %" isn't misread as "done %". */}
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-default">
                            <div className={cardVariants({ density: 'none' })}>
                                <KPIStat
                                    value={`${readiness.coverage.coveragePercent}%`}
                                    label={tx('mappedPct')}
                                    tone="default"
                                />
                            </div>
                            <div className={cardVariants({ density: 'none' })}>
                                <KPIStat
                                    value={`${implementedPct}%`}
                                    label={tx('implementedPct')}
                                    tone={implementedPct === 100 ? 'success' : 'attention'}
                                />
                            </div>
                            <div className={cardVariants({ density: 'none' })}>
                                <KPIStat
                                    value={`${s.readinessScore}/100`}
                                    label={tx('readinessScore')}
                                    tone="default"
                                />
                            </div>
                            <div className={cardVariants({ density: 'none' })}>
                                <KPIStat
                                    value={s.gapRequirements}
                                    label={tx('gapsMappedNotImplemented')}
                                    tone={s.gapRequirements > 0 ? 'attention' : 'success'}
                                />
                            </div>
                            <div className={cardVariants({ density: 'none' })}>
                                <KPIStat value={s.exceptedRequirements} label={tx('excepted')} />
                            </div>
                        </div>

                        <div className={cardVariants({ density: 'none' })}>
                            <p className="text-xs text-content-muted">
                                {tx('mappedVsImplementedHint', {
                                    mapped: readiness.coverage.mapped,
                                    total: readiness.coverage.total,
                                    implemented: s.implementedRequirements,
                                })}
                            </p>
                        </div>

                        {/* Section breakdown (mapping density per section) */}
                        {readiness.bySection.length > 0 && (
                            <div className={cardVariants({ density: 'none' })}>
                                <Heading level={3} className="mb-3">{tx('coverageBySection')}</Heading>
                                <div className="space-y-compact">
                                    {readiness.bySection.map((sec) => (
                                        <div key={sec.section}>
                                            <div className="flex items-center justify-between text-xs mb-1">
                                                <span className="text-content-default">{sec.section}</span>
                                                <span className="text-content-muted">
                                                    {sec.mapped}/{sec.total} ({sec.coveragePercent}%)
                                                </span>
                                            </div>
                                            <ProgressBar
                                                value={sec.coveragePercent}
                                                size="sm"
                                                variant={
                                                    sec.coveragePercent === 100
                                                        ? 'success'
                                                        : sec.coveragePercent > 0
                                                          ? 'brand'
                                                          : 'neutral'
                                                }
                                                aria-label={`${sec.section} coverage`}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Gap Analysis — the unmapped requirements list (on-screen home) */}
                        <div className={cardVariants({ density: 'none' })} data-testid="gap-list">
                            <Heading level={3} className="text-content-warning mb-3">
                                {tx('gapAnalysisHeading', { count: readiness.unmappedRequirements.length })}
                            </Heading>
                            {readiness.unmappedRequirements.length === 0 ? (
                                <p className="text-sm text-content-muted">{tx('noGaps')}</p>
                            ) : (
                                <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {readiness.unmappedRequirements.map((r, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center gap-compact px-3 py-1.5 rounded-md hover:bg-bg-muted/50 text-sm"
                                        >
                                            <span className="w-2 h-2 rounded-full bg-border-emphasis flex-shrink-0" />
                                            <code className="text-xs text-content-subtle font-mono w-16 sm:w-28 flex-shrink-0 truncate">
                                                {r.code}
                                            </code>
                                            <span className="text-content-muted">{r.title}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Controls missing evidence */}
                        {readiness.controlsMissingEvidence.length > 0 && (
                            <div className={cardVariants({ density: 'none' })}>
                                <Heading level={3} className="mb-3">
                                    {tx('missingEvidenceHeading', { count: readiness.controlsMissingEvidence.length })}
                                </Heading>
                                <div className="space-y-1 max-h-48 overflow-y-auto">
                                    {readiness.controlsMissingEvidence.map((c, i) => (
                                        <div key={i} className="flex items-center gap-compact px-3 py-1.5 text-sm">
                                            <code className="text-xs text-content-subtle font-mono w-16 sm:w-28 flex-shrink-0 truncate">
                                                {c.code}
                                            </code>
                                            <span className="text-content-muted">{c.name}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* The overdue-tasks list was removed from this report.
                            Tasks have their own surface with filtering, sorting
                            and assignment; a flat read-only list here answered
                            a question the reader could not act on.

                            `readiness.overdueTasks` DELIBERATELY REMAINS on the
                            payload. It has a second consumer — the readiness
                            CSV emits one "Overdue Task" row per entry
                            (`framework/coverage.ts`) — so deleting the field
                            would silently drop a column from an auditor-facing
                            export. Same for `summary.overdueTaskCount`, which
                            the readiness PDF still reads. */}
                    </div>
                )}
            </section>
        </div>
    );
}

function ReportCard({
    icon,
    title,
    description,
    action,
    testid,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
    action: React.ReactNode;
    testid: string;
}) {
    return (
        <div
            className={`${cardVariants({ density: 'comfortable' })} flex flex-col gap-tight`}
            data-testid={testid}
        >
            <div className="flex items-center gap-tight text-content-emphasis">
                <span className="text-[var(--brand-default)]">{icon}</span>
                <Heading level={3} className="text-base">{title}</Heading>
            </div>
            <p className="text-sm text-content-muted flex-1">{description}</p>
            <div className="pt-1">{action}</div>
        </div>
    );
}
