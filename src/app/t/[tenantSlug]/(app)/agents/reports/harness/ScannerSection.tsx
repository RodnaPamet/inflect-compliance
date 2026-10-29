'use client';

/**
 * One scanner's LATEST scan: when it describes, whether it is complete, what
 * changed since the same scanner's previous scan, and the matrix.
 *
 * An EMPTY scan renders a finding and no matrix — an empty grid with a "no
 * rows" message would read as a clean estate. An INCOMPLETE scan names the
 * sources it could not read, so nothing below it is mistaken for the whole.
 */
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type { HarnessScanCompleteness, HarnessScannerSection, MatrixRow } from '@/lib/agentic/harness-read-model';

import { DriftPanel } from './DriftPanel';
import { sourceKindLabel } from './source-kind-label';
import { MatrixGrid } from './MatrixGrid';

export const COMPLETENESS_VARIANT: Readonly<Record<HarnessScanCompleteness, StatusBadgeVariant>> = {
    COMPLETE: 'success',
    INCOMPLETE: 'warning',
    EMPTY: 'error',
};

export function ScannerSection({
    section,
    scanWindow,
    onAccept,
}: {
    section: HarnessScannerSection;
    scanWindow: number;
    onAccept: (row: MatrixRow) => void;
}) {
    const t = useTranslations('agents');
    const { latest } = section;
    const incomplete = (latest.sources ?? []).filter((s) => s.status === 'INCOMPLETE');

    return (
        <Card data-testid={`harness-section-${latest.id}`} className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <Heading level={2}>
                    {t('harness.sectionHeading', { name: section.scannerName ?? section.scannerAgentId })}
                </Heading>
                <StatusBadge
                    variant={COMPLETENESS_VARIANT[latest.completeness]}
                    data-testid={`harness-completeness-${latest.id}`}
                >
                    {t(`harness.completeness.${latest.completeness}`)}
                </StatusBadge>
            </div>
            <p className="text-sm text-content-muted">
                {t('harness.scanMeta', {
                    scanRef: latest.scanRef,
                    asOf: formatDateTime(latest.asOf),
                    ingestedAt: formatDateTime(latest.ingestedAt),
                })}
            </p>

            {latest.completeness === 'EMPTY' && (
                <InlineNotice
                    variant="error"
                    title={t('harness.emptyScanTitle')}
                    data-testid={`harness-empty-scan-${latest.id}`}
                >
                    {t('harness.emptyScanBody')}
                </InlineNotice>
            )}
            {latest.completeness === 'INCOMPLETE' && (
                <InlineNotice variant="warning" data-testid={`harness-incomplete-scan-${latest.id}`}>
                    {latest.sources === null
                        ? t('harness.sourcesUnreadable')
                        : incomplete.length === 0
                            ? t('harness.incompleteScanGeneric')
                            : t('harness.incompleteScan', {
                                kinds: incomplete
                                    .map((s) =>
                                        t('harness.incompleteSourceLine', {
                                            kind: sourceKindLabel(t, s.kind),
                                            reason: s.reason ? t(`harness.incompleteReason.${s.reason}`) : '',
                                        }),
                                    )
                                    .join(', '),
                            })}
                </InlineNotice>
            )}

            <DriftPanel section={section} scanWindow={scanWindow} />

            {latest.completeness !== 'EMPTY' && section.rows.length > 0 && (
                <MatrixGrid scanId={latest.id} rows={section.rows} onAccept={onAccept} />
            )}
            {section.rowsUnread && (
                <InlineNotice variant="warning" data-testid={`harness-rows-unread-${latest.id}`}>
                    {t('harness.rowsUnread', { total: latest.agentCount })}
                </InlineNotice>
            )}
            {section.rowsTruncated && (
                <InlineNotice variant="warning" icon={null} data-testid={`harness-rows-truncated-${latest.id}`}>
                    {t('harness.rowsTruncated', { shown: section.rows.length, total: latest.agentCount })}
                </InlineNotice>
            )}
        </Card>
    );
}
