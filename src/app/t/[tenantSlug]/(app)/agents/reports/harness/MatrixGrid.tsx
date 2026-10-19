'use client';

/**
 * Agents × criteria for one scan. One row per agent the scan found (worst rung
 * first, as the server chose them), one column per criterion of the ladder in
 * rung order, each cell carrying its evidence reference.
 *
 * The level is the scan item's — what THIS scan derived. When a scan received
 * later reads the agent differently, the row says so, because the accept
 * action follows that later reading (it is what the acceptance usecase reads).
 *
 * THE ACCEPT ACTION IS THE OWNER'S. It renders only where the server computed
 * `ACCEPT` or `RENEW` — the acceptance usecase's own rule, over the same
 * columns — so it is never shown and then refused, and never hidden from the
 * one person entitled to it. A short row that is not this viewer's to accept
 * carries a note saying why, and no control.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataTable, createColumns, type ColumnDef } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { formatDate } from '@inflect/ui/lib/format-date';
import { ALL_HARNESS_CRITERIA } from '@/lib/agentic/harness-ladder';
import type { MatrixRow } from '@/lib/agentic/harness-read-model';

import { MatrixCell } from './MatrixCell';

function AgentCell({ scanId, row }: { scanId: string; row: MatrixRow }) {
    const t = useTranslations('agents');
    return (
        <div className="flex flex-col items-start gap-tight">
            <span className="font-medium text-content-emphasis">{row.registered?.name ?? row.discoveredId}</span>
            {row.registered && <span className="font-mono text-xs text-content-muted">{row.discoveredId}</span>}
            {!row.registered && (
                <StatusBadge variant="warning" size="sm" data-testid={`harness-shadow-badge-${scanId}-${row.discoveredAgentId}`}>
                    {t('harness.shadowBadge')}
                </StatusBadge>
            )}
            {row.verdictsUnreadable && (
                <span
                    className="text-xs text-content-error"
                    data-testid={`harness-verdicts-unreadable-${scanId}-${row.discoveredAgentId}`}
                >
                    {t('harness.verdictsUnreadable')}
                </span>
            )}
        </div>
    );
}

function LevelCell({ scanId, row }: { scanId: string; row: MatrixRow }) {
    const t = useTranslations('agents');
    return (
        <div className="flex flex-col items-start gap-tight" data-testid={`harness-level-${scanId}-${row.discoveredAgentId}`}>
            <StatusBadge variant={row.belowBar ? 'error' : 'neutral'}>{t(`harness.level.${row.level}`)}</StatusBadge>
            {row.belowBar && <span className="text-xs text-content-error">{t('harness.belowBar', { bar: row.bar })}</span>}
            {row.latestIngestedLevel !== null && (
                <span
                    className="text-xs text-content-warning"
                    data-testid={`harness-latest-differs-${scanId}-${row.discoveredAgentId}`}
                >
                    {t('harness.latestIngestedDiffers', { level: row.latestIngestedLevel })}
                </span>
            )}
        </div>
    );
}

/**
 * The model endpoints this scan reported for the agent (#3759). Text only:
 * an endpoint is a reference the scanner chose, so it is never a link, and a
 * row that reported nothing, reported none, or could not be re-read each says
 * so in its own words — never one shown as another.
 */
function ModelsCell({ scanId, row }: { scanId: string; row: MatrixRow }) {
    const t = useTranslations('agents');
    const testId = `harness-models-${scanId}-${row.discoveredAgentId}`;
    const models = row.models;
    if (models.state === 'UNREADABLE') {
        return (
            <span className="text-xs text-content-error" data-testid={testId} data-state="UNREADABLE">
                {t('harness.models.unreadable')}
            </span>
        );
    }
    if (models.state === 'NOT_REPORTED') {
        return (
            <Tooltip content={t('harness.models.notReportedHint')}>
                <span className="text-xs text-content-muted" data-testid={testId} data-state="NOT_REPORTED">
                    {t('harness.models.notReported')}
                </span>
            </Tooltip>
        );
    }
    if (models.endpoints.length === 0) {
        return (
            <Tooltip content={t('harness.models.reportedEmptyHint')}>
                <span className="text-xs" data-testid={testId} data-state="REPORTED_EMPTY">
                    {t('harness.models.reportedEmpty')}
                </span>
            </Tooltip>
        );
    }
    return (
        <ul className="flex flex-col gap-tight" data-testid={testId} data-state="REPORTED">
            {models.endpoints.map((m, i) => (
                <li key={`${i}:${m.endpoint}`} className="flex flex-col">
                    <span className="break-all font-mono text-xs">{m.endpoint}</span>
                    <span className="font-mono text-xs text-content-muted">
                        {m.model ?? t('harness.models.modelAbsent')}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function AcceptanceCell({
    scanId,
    row,
    onAccept,
}: {
    scanId: string;
    row: MatrixRow;
    onAccept: (row: MatrixRow) => void;
}) {
    const t = useTranslations('agents');
    const id = row.discoveredAgentId;
    return (
        <div className="flex flex-col items-start gap-tight">
            {row.acceptance && (
                <span className="text-xs" data-testid={`harness-acceptance-expiry-${scanId}-${id}`}>
                    {t('harness.acceptedUntil', { date: formatDate(row.acceptance.expiresAt) })}
                </span>
            )}
            {(row.acceptAffordance === 'ACCEPT' || row.acceptAffordance === 'RENEW') && (
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onAccept(row)}
                    data-testid={`harness-accept-${scanId}-${id}`}
                >
                    {row.acceptAffordance === 'RENEW' ? t('harness.renew') : t('harness.accept')}
                </Button>
            )}
            {(row.acceptAffordance === 'OWNER_ONLY' || row.acceptAffordance === 'REGISTER_FIRST') && (
                <span className="text-xs text-content-muted" data-testid={`harness-accept-note-${scanId}-${id}`}>
                    {row.acceptAffordance === 'OWNER_ONLY' ? t('harness.ownerOnly') : t('harness.registerFirst')}
                </span>
            )}
        </div>
    );
}

export function MatrixGrid({
    scanId,
    rows,
    onAccept,
}: {
    scanId: string;
    rows: readonly MatrixRow[];
    onAccept: (row: MatrixRow) => void;
}) {
    const t = useTranslations('agents');

    const columns = useMemo(
        () =>
            createColumns<MatrixRow>([
                {
                    id: 'agent',
                    header: t('harness.colAgent'),
                    enableSorting: false,
                    cell: ({ row }) => <AgentCell scanId={scanId} row={row.original} />,
                },
                {
                    id: 'level',
                    header: t('harness.colLevel'),
                    enableSorting: false,
                    cell: ({ row }) => <LevelCell scanId={scanId} row={row.original} />,
                },
                {
                    id: 'reach',
                    header: t('harness.colReach'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{t(`harness.reach.${row.original.reach}`)}</span>,
                },
                {
                    id: 'models',
                    header: t('harness.colModels'),
                    enableSorting: false,
                    cell: ({ row }) => <ModelsCell scanId={scanId} row={row.original} />,
                },
                {
                    id: 'acceptance',
                    header: t('harness.colAcceptance'),
                    enableSorting: false,
                    cell: ({ row }) => <AcceptanceCell scanId={scanId} row={row.original} onAccept={onAccept} />,
                },
                ...ALL_HARNESS_CRITERIA.map(
                    (criterion): ColumnDef<MatrixRow> => ({
                        id: criterion,
                        header: () => (
                            <Tooltip content={t(`harness.criterion.${criterion}`)}>
                                <span className="font-mono text-xs">{criterion}</span>
                            </Tooltip>
                        ),
                        enableSorting: false,
                        cell: ({ row }) => <MatrixCell scanId={scanId} row={row.original} criterion={criterion} />,
                    }),
                ),
            ]),
        [t, scanId, onAccept],
    );

    return (
        <DataTable<MatrixRow>
            data={[...rows]}
            columns={columns}
            getRowId={(r) => r.discoveredAgentId}
            selectionEnabled={false}
            resourceName={(plural) => (plural ? t('harness.resourceAgents') : t('harness.resourceAgent'))}
            emptyState={t('harness.matrixEmpty')}
            data-testid={`harness-matrix-${scanId}`}
        />
    );
}
