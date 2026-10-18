'use client';

/**
 * Every scan in the window, newest `asOf` first: who scanned, which sources it
 * read and whether in full, and how many agents it found. A scan whose stored
 * sources cannot be re-read says so rather than listing nothing, and is
 * counted INCOMPLETE.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type { HarnessMatrixView, HarnessScanRow } from '@/lib/agentic/harness-read-model';

import { COMPLETENESS_VARIANT } from './ScannerSection';

function SourcesCell({ scan }: { scan: HarnessScanRow }) {
    const t = useTranslations('agents');
    if (scan.sources === null) {
        return (
            <span className="text-xs text-content-error" data-testid={`harness-scan-sources-unreadable-${scan.id}`}>
                {t('harness.sourcesUnreadable')}
            </span>
        );
    }
    return (
        <ul className="space-y-tight text-xs" data-testid={`harness-scan-sources-${scan.id}`}>
            {scan.sources.map((s) => (
                <li key={s.kind} className={s.status === 'INCOMPLETE' ? 'text-content-warning' : undefined}>
                    {s.status === 'INCOMPLETE'
                        ? t('harness.sourceLineIncomplete', {
                            kind: s.kind,
                            reason: s.reason ? t(`harness.incompleteReason.${s.reason}`) : '',
                            rows: s.rows,
                        })
                        : t('harness.sourceLine', { kind: s.kind, rows: s.rows })}
                </li>
            ))}
        </ul>
    );
}

export function ScanHistory({ scans, scanWindow }: { scans: HarnessMatrixView['scans']; scanWindow: number }) {
    const t = useTranslations('agents');

    const columns = useMemo(
        () =>
            createColumns<HarnessScanRow>([
                {
                    id: 'asOf',
                    header: t('harness.colAsOf'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.asOf)}</span>,
                },
                {
                    id: 'received',
                    header: t('harness.colReceived'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.ingestedAt)}</span>,
                },
                {
                    id: 'scanner',
                    header: t('harness.colScanner'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-xs">{row.original.scannerName ?? row.original.scannerAgentId}</span>
                    ),
                },
                {
                    id: 'version',
                    header: t('harness.colVersion'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="font-mono text-xs">{row.original.scannerVersion}</span>,
                },
                {
                    id: 'scanRef',
                    header: t('harness.colScanRef'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="font-mono text-xs">{row.original.scanRef}</span>,
                },
                {
                    id: 'completeness',
                    header: t('harness.colCompleteness'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={COMPLETENESS_VARIANT[row.original.completeness]}
                            size="sm"
                            data-testid={`harness-scan-completeness-${row.original.id}`}
                        >
                            {t(`harness.completeness.${row.original.completeness}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'agents',
                    header: t('harness.colAgents'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{row.original.agentCount}</span>,
                },
                {
                    id: 'sources',
                    header: t('harness.colSources'),
                    enableSorting: false,
                    cell: ({ row }) => <SourcesCell scan={row.original} />,
                },
            ]),
        [t],
    );

    return (
        <Card data-testid="harness-scans" className="space-y-default">
            <Heading level={2}>{t('harness.scansHeading')}</Heading>
            <DataTable<HarnessScanRow>
                data={[...scans.rows]}
                columns={columns}
                getRowId={(r) => r.id}
                selectionEnabled={false}
                resourceName={(plural) => (plural ? t('harness.resourceScans') : t('harness.resourceScan'))}
                emptyState={t('harness.noScansTitle')}
                data-testid="harness-scans-table"
            />
            {scans.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-scans-truncated">
                    {t('harness.scansTruncated', { count: scanWindow })}
                </InlineNotice>
            )}
        </Card>
    );
}
