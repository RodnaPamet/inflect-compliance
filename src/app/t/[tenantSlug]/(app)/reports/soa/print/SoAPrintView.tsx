'use client';

import { useTranslations } from 'next-intl';
import type { SoAReportDTO, SoAEntryDTO } from '@/lib/dto/soa';
import { formatDate } from '@inflect/ui/lib/format-date';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { Monitor } from 'lucide-react';
import { useSoASectionLabel } from '@/app/t/[tenantSlug]/(app)/reports/soa/section-label';
import { useContentText } from '@/lib/content-i18n/use-content-text';
import { frameworkDisplayName } from '@/app/t/[tenantSlug]/(app)/reports/framework-name';

interface SoAPrintViewProps {
    /** Where to go when there is no history to go back to (fresh tab). */
    backHref: string;
    /** The interactive SoA for this framework — what a phone reads instead. */
    soaHref: string;
    report: SoAReportDTO;
}

/** The `ControlStatus` values `soaView.controlStatus.*` words (#4927). */
const CONTROL_STATUSES = [
    'NOT_STARTED', 'PLANNED', 'IN_PROGRESS', 'IMPLEMENTING', 'IMPLEMENTED', 'NEEDS_REVIEW', 'NOT_APPLICABLE',
] as const;
type ControlStatusValue = (typeof CONTROL_STATUSES)[number];

/**
 * Print-optimized SoA view — clean multi-page document with CSS print styles.
 * No nav, no interactive elements. Users use browser print (Ctrl+P / Cmd+P).
 *
 * Print styles are in globals.css (moved there for CSP compliance — no inline <style> tags).
 */
export function SoAPrintView({ report, backHref, soaHref }: SoAPrintViewProps) {
    const t = useTranslations('reports');
    const tc = useContentText();
    const { tenantName } = useTenantContext();
    const sectionLabel = useSoASectionLabel();
    const { summary, entries } = report;
    // Epic 58 — canonical app-wide formatter so the printed SoA's
    // "Generated on" line reads identically to every other date in
    // the product ("16 Apr 2026").
    const generatedDate = formatDate(report.generatedAt);

    // Group entries by section. A requirement with no section is grouped
    // under a translated "Other", not the English word (#4927).
    const other = t('soaPrint.otherSection');
    const sections = [...new Set(entries.map(e => e.section || other))];
    const bySection = sections.map(s => ({
        name: s,
        entries: entries.filter(e => (e.section || other) === s),
    }));

    // `history.back()` is a NO-OP in the tab this page opens in. The SoA
    // "Print" affordance opens this in a NEW TAB, so the fresh tab has no
    // history to go back to and the button did nothing at all — the one
    // control on an otherwise-chrome-less page. Fall back to the reports hub
    // when there is nowhere to return to.
    const goBack = () => {
        if (window.history.length > 1) window.history.back();
        else window.location.assign(backHref);
    };

    return (
        <div className="soa-print-body bg-bg-page text-content-default min-h-screen text-sm">
            {/* ─── A phone's screen: a notice, not the document ───
                The print view is a page for the printer: fixed-width tables
                and a summary grid that a phone screen clipped on both sides.
                On a phone SCREEN (owner decision, 2026-11-23) it says so and
                offers what the reader came for: print or save the PDF, the
                readable SoA, or the way back. Both gates are
                `@media screen`, never a bare breakpoint: a printed page is
                narrower than `md` too, and printing — from a phone or a
                desktop — must still lay out the whole document. */}
            <div
                className="no-print hidden [@media_screen_and_(max-width:767.98px)]:block"
                data-testid="soa-print-phone-notice"
            >
                <EmptyState
                    icon={Monitor}
                    title={t('soaPrintMobile.title')}
                    description={t('soaPrintMobile.description')}
                    primaryAction={{
                        label: t('soaPrint.printBtn'),
                        onClick: () => window.print(),
                        'data-testid': 'soa-print-phone-print',
                    }}
                    secondaryAction={{
                        label: t('soaPrintMobile.openSoa'),
                        href: soaHref,
                        'data-testid': 'soa-print-phone-open-soa',
                    }}
                    data-testid="soa-print-phone-empty-state"
                >
                    <Button variant="ghost" onClick={goBack} id="soa-print-phone-back">
                        {t('soaPrint.back')}
                    </Button>
                </EmptyState>
            </div>

            <div className="[@media_screen_and_(max-width:767.98px)]:hidden" data-testid="soa-print-document">
                {/* ─── Print toolbar (screen only) ─── */}
                <div className="no-print flex items-center justify-between mb-6 p-4 bg-bg-muted rounded-lg">
                    <div>
                        <Heading level={2}>{t('soaPrint.printPreview')}</Heading>
                        <p className="text-xs text-content-muted">{t('soaPrint.printHint')}</p>
                    </div>
                    <div className="flex gap-tight">
                        <Button variant="secondary" onClick={() => window.print()} id="soa-print-button">
                            {t('soaPrint.printBtn')}
                        </Button>
                        {/* Not `history.back()` alone: see `goBack`. */}
                        <Button variant="ghost" onClick={goBack}>
                            {t('soaPrint.back')}
                        </Button>
                    </div>
                </div>

                {/* ─── Cover section ─── */}
                <div className="print-page">
                    <div className="border-b-2 border-border-emphasis pb-4 mb-6">
                        <Heading level={1} className="text-content-emphasis">{t('soa')}</Heading>
                        <p className="text-sm text-content-muted mt-1">{frameworkDisplayName(report.frameworkName, tc)}</p>
                    </div>

                    <table className="w-full text-sm mb-8">
                        <tbody>
                            <tr><td className="py-1 pr-4 font-semibold text-content-default w-48">{t('soaPrint.organization')}</td><td className="py-1">{tenantName}</td></tr>
                            <tr><td className="py-1 pr-4 font-semibold text-content-default">{t('soaPrint.framework')}</td><td className="py-1">{frameworkDisplayName(report.frameworkName, tc)}</td></tr>
                            <tr><td className="py-1 pr-4 font-semibold text-content-default">{t('soaPrint.generated')}</td><td className="py-1">{generatedDate}</td></tr>
                            <tr><td className="py-1 pr-4 font-semibold text-content-default">{t('soaPrint.totalControls')}</td><td className="py-1">{summary.total}</td></tr>
                        </tbody>
                    </table>

                    {/* Summary */}
                    <Heading level={2} className="mb-3 border-b border-border-default pb-1">{t('soaPrint.summary')}</Heading>
                    <div className="grid grid-cols-3 gap-default mb-8">
                        <SummaryBox label={t('soaPrint.applicable')} value={summary.applicable} total={summary.total} color="green" />
                        <SummaryBox label={t('soaPrint.notApplicable')} value={summary.notApplicable} total={summary.total} color="gray" />
                        <SummaryBox label={t('soaPrint.unmapped')} value={summary.unmapped} total={summary.total} color="red" />
                        <SummaryBox label={t('soaPrint.implemented')} value={summary.implemented} total={summary.total} color="green" />
                        <SummaryBox label={t('soaPrint.excepted')} value={summary.excepted} total={summary.total} color="amber" />
                        <SummaryBox label={t('soaPrint.missingJustification')} value={summary.missingJustification} total={summary.total} color="amber" />
                    </div>
                </div>

                {/* ─── Detail tables per section ─── */}
                {bySection.map(section => (
                    <div key={section.name} className="print-page">
                        <Heading level={2} className="mb-3 border-b border-border-default pb-1">
                            {t('soaPrint.sectionControls', {
                                section: sectionLabel(section.name),
                            })}
                            <span className="text-sm font-normal text-content-muted ml-2">({section.entries.length})</span>
                        </Heading>

                        <table className="print-table w-full text-xs border-collapse mb-6">
                            <thead>
                                <tr className="bg-bg-muted">
                                    <th className="border border-border-default px-2 py-1.5 text-left font-semibold w-16">{t('soaPrint.colCode')}</th>
                                    <th className="border border-border-default px-2 py-1.5 text-left font-semibold">{t('soaPrint.colRequirement')}</th>
                                    <th className="border border-border-default px-2 py-1.5 text-left font-semibold w-20">{t('soaPrint.colApplicable')}</th>
                                    <th className="border border-border-default px-2 py-1.5 text-left font-semibold w-28">{t('soaPrint.colStatus')}</th>
                                    <th className="border border-border-default px-2 py-1.5 text-left font-semibold">{t('soaPrint.colControlRefs')}</th>
                                    <th className="border border-border-default px-2 py-1.5 text-left font-semibold">{t('soaPrint.colJustification')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {section.entries.map(entry => (
                                    <PrintRow key={entry.requirementId} entry={entry} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                ))}

                {/* ─── Footer ─── */}
                <div className="text-xs text-content-subtle border-t border-border-subtle pt-4 mt-8">
                    <p>{t('soaPrint.footer', { date: generatedDate })}</p>
                </div>
            </div>
        </div>
    );
}

// ─── Print Row ───

function PrintRow({ entry }: { entry: SoAEntryDTO }) {
    const t = useTranslations('reports');
    const tc = useContentText();
    const applicable = entry.applicable === true ? t('soaPrint.yes')
        : entry.applicable === false ? t('soaPrint.no')
        : t('soaPrint.unmappedVal');

    const applicableClass = entry.applicable === true ? 'text-content-success'
        : entry.applicable === false ? 'text-content-muted'
        : 'text-content-error font-semibold';

    const controlRefs = entry.mappedControls
        .map(c => `${c.code || '—'} — ${tc(c.title)}`)
        .join('\n');

    return (
        <tr className={entry.applicable === null ? 'bg-bg-error-emphasis' : ''}>
            <td className="border border-border-default px-2 py-1.5 font-mono text-xs">{entry.requirementCode}</td>
            <td className="border border-border-default px-2 py-1.5">{tc(entry.requirementTitle)}</td>
            <td className={`border border-border-default px-2 py-1.5 font-medium ${applicableClass}`}>{applicable}</td>
            <td className="border border-border-default px-2 py-1.5">
                {/* R2-P5 — an excepted requirement is labelled as excepted (with
                    the expiry) on the auditor artifact, never as implemented. */}
                {entry.verdict === 'excepted'
                    ? (entry.exceptedUntil
                        ? t('soaPrint.exceptedUntil', { date: formatDate(entry.exceptedUntil) })
                        : t('soaPrint.excepted'))
                    : entry.implementationStatus
                        ? (CONTROL_STATUSES as readonly string[]).includes(entry.implementationStatus)
                            ? t(`soaView.controlStatus.${entry.implementationStatus as ControlStatusValue}`)
                            : entry.implementationStatus
                        : '—'}
            </td>
            <td className="border border-border-default px-2 py-1.5 whitespace-pre-line">{controlRefs || '—'}</td>
            <td className="border border-border-default px-2 py-1.5 text-content-muted">{entry.justification || '—'}</td>
        </tr>
    );
}

// ─── Summary Box ───

function SummaryBox({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
    const percent = total > 0 ? Math.round((value / total) * 100) : 0;
    const colorMap: Record<string, string> = {
        green: 'border-border-success bg-bg-success-emphasis',
        gray: 'border-border-default bg-bg-default',
        red: 'border-border-error bg-bg-error-emphasis',
        amber: 'border-border-warning bg-bg-warning-emphasis',
    };

    return (
        <div className={`border-l-4 ${colorMap[color] || 'border-border-default'} px-3 py-2`}>
            <div className="text-xl font-bold text-content-emphasis">{value} <span className="text-xs font-normal text-content-muted">({percent}%)</span></div>
            <div className="text-xs text-content-muted">{label}</div>
        </div>
    );
}
