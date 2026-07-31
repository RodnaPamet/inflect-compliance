'use client';

import { useTranslations } from 'next-intl';
import type { SoAReportDTO, SoAEntryDTO } from '@/lib/dto/soa';
import { formatDate } from '@/lib/format-date';
import { Heading } from '@/components/ui/typography';

interface SoAPrintViewProps {
    /** Where to go when there is no history to go back to (fresh tab). */
    backHref: string;
    report: SoAReportDTO;
    tenantName: string;
}

/**
 * Print-optimized SoA view — clean multi-page document with CSS print styles.
 * No nav, no interactive elements. Users use browser print (Ctrl+P / Cmd+P).
 *
 * Print styles are in globals.css (moved there for CSP compliance — no inline <style> tags).
 */
export function SoAPrintView({ report, tenantName, backHref }: SoAPrintViewProps) {
    const t = useTranslations('reports');
    const { summary, entries } = report;
    // Epic 58 — canonical app-wide formatter so the printed SoA's
    // "Generated on" line reads identically to every other date in
    // the product ("16 Apr 2026").
    const generatedDate = formatDate(report.generatedAt);

    // Group entries by section
    const sections = [...new Set(entries.map(e => e.section || 'Other'))];
    const bySection = sections.map(s => ({
        name: s,
        entries: entries.filter(e => (e.section || 'Other') === s),
    }));

    return (
        <div className="soa-print-body bg-bg-page text-content-default min-h-screen text-sm">
            {/* ─── Print toolbar (screen only) ─── */}
            <div className="no-print flex items-center justify-between mb-6 p-4 bg-bg-muted rounded-lg">
                <div>
                    <Heading level={2}>{t('soaPrint.printPreview')}</Heading>
                    <p className="text-xs text-content-muted">{t('soaPrint.printHint')}</p>
                </div>
                <div className="flex gap-tight">
                    <button
                        onClick={() => window.print()}
                        className="px-4 py-2 bg-bg-info-emphasis text-content-emphasis rounded-lg text-sm font-medium hover:bg-bg-info-emphasis transition-colors"
                    >
                        {t('soaPrint.printBtn')}
                    </button>
                    {/* `history.back()` is a NO-OP in the tab this page opens in.
                        The SoA "Print" affordance opens this in a NEW TAB, so the
                        fresh tab has no history to go back to and the button
                        did nothing at all — the one control on an
                        otherwise-chrome-less page. Fall back to the reports hub
                        when there is nowhere to return to. */}
                    <button
                        onClick={() => {
                            if (window.history.length > 1) window.history.back();
                            else window.location.assign(backHref);
                        }}
                        className="px-4 py-2 bg-bg-default text-content-default rounded-lg text-sm font-medium hover:bg-bg-muted transition-colors"
                    >
                        {t('soaPrint.back')}
                    </button>
                </div>
            </div>

            {/* ─── Cover section ─── */}
            <div className="print-page">
                <div className="border-b-2 border-border-emphasis pb-4 mb-6">
                    <Heading level={1} className="text-content-emphasis">{t('soa')}</Heading>
                    <p className="text-sm text-content-muted mt-1">{report.frameworkName}</p>
                </div>

                <table className="w-full text-sm mb-8">
                    <tbody>
                        <tr><td className="py-1 pr-4 font-semibold text-content-default w-48">{t('soaPrint.organization')}</td><td className="py-1">{tenantName}</td></tr>
                        <tr><td className="py-1 pr-4 font-semibold text-content-default">{t('soaPrint.framework')}</td><td className="py-1">{report.frameworkName}</td></tr>
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
                        {t('soaPrint.sectionControls', { section: section.name })}
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
    );
}

// ─── Print Row ───

function PrintRow({ entry }: { entry: SoAEntryDTO }) {
    const t = useTranslations('reports');
    const applicable = entry.applicable === true ? t('soaPrint.yes')
        : entry.applicable === false ? t('soaPrint.no')
        : t('soaPrint.unmappedVal');

    const applicableClass = entry.applicable === true ? 'text-content-success'
        : entry.applicable === false ? 'text-content-muted'
        : 'text-content-error font-semibold';

    const controlRefs = entry.mappedControls
        .map(c => `${c.code || '—'} — ${c.title}`)
        .join('\n');

    return (
        <tr className={entry.applicable === null ? 'bg-bg-error-emphasis' : ''}>
            <td className="border border-border-default px-2 py-1.5 font-mono text-xs">{entry.requirementCode}</td>
            <td className="border border-border-default px-2 py-1.5">{entry.requirementTitle}</td>
            <td className={`border border-border-default px-2 py-1.5 font-medium ${applicableClass}`}>{applicable}</td>
            <td className="border border-border-default px-2 py-1.5">
                {/* R2-P5 — an excepted requirement is labelled as excepted (with
                    the expiry) on the auditor artifact, never as implemented. */}
                {entry.verdict === 'excepted'
                    ? (entry.exceptedUntil
                        ? t('soaPrint.exceptedUntil', { date: new Date(entry.exceptedUntil).toISOString().slice(0, 10) })
                        : t('soaPrint.excepted'))
                    : (entry.implementationStatus?.replace(/_/g, ' ') || '—')}
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
