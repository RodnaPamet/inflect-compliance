'use client';

/**
 * Agents × criteria for one scan. One row per agent the scan found, in the
 * SHARED TABLE MODEL's order as the server chose them (not judged, then below
 * the bar, then at it; within each the lowest level first), one column per
 * criterion of the ladder in rung order, each cell carrying its evidence
 * reference. Every row, cell, level and bar is the model's
 * (`@rodnapamet/scanent-contract/harness-matrix-model`); the grid renders them
 * and adds Inflect's own columns, joined to the row on the server.
 *
 * The level is what THIS scan derived, or none when the model does not judge
 * the agent. When a scan received
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
import type { MatrixRow } from '@/lib/agentic/harness-read-model';
import { HARNESS_MATRIX_COLUMNS, SOURCE_NOT_LISTED } from '@rodnapamet/scanent-contract/harness-matrix-model';

import { MatrixCell } from './MatrixCell';
import { sourceKindLabel } from './source-kind-label';

/** The `agents` translator, narrowed to the calls the reason sentences need. */
type AgentsTranslator = (key: string, values?: Record<string, string>) => string;

/**
 * A sentence for one of the model's judgement codes — `SOURCE_INCOMPLETE:<kind>:<reason>`,
 * `VERDICT_SOURCE_INCOMPLETE:<kind>:<reason>`, `OTHER_SOURCE_INCOMPLETE:<kind>`,
 * `SOURCES_UNREADABLE`, `VERDICTS_UNREADABLE` — in the words scanent's page uses.
 * The code itself is shown beside it, so a code this client does not know is
 * still stated rather than dropped.
 */
export function judgementCodeSentence(t: AgentsTranslator, code: string): string {
    const [head, kind, reason] = code.split(':');
    const reasonText = (r: string | undefined) =>
        r === undefined || r === 'UNKNOWN' ? t('harness.notJudged.reasonUnstated') : t(`harness.incompleteReason.${r}`);
    if (head === 'SOURCE_INCOMPLETE' && kind !== undefined) {
        return reason === SOURCE_NOT_LISTED
            ? t('harness.notJudged.code.SOURCE_NOT_LISTED', { kind: sourceKindLabel(t, kind) })
            : t('harness.notJudged.code.SOURCE_INCOMPLETE', { kind: sourceKindLabel(t, kind), reason: reasonText(reason) });
    }
    if (head === 'VERDICT_SOURCE_INCOMPLETE' && kind !== undefined) {
        return t('harness.notJudged.code.VERDICT_SOURCE_INCOMPLETE', {
            kind: sourceKindLabel(t, kind),
            reason: reasonText(reason),
        });
    }
    if (head === 'OTHER_SOURCE_INCOMPLETE' && kind !== undefined) {
        return t('harness.notJudged.code.OTHER_SOURCE_INCOMPLETE', { kind: sourceKindLabel(t, kind) });
    }
    if (head === 'SOURCES_UNREADABLE') return t('harness.notJudged.code.SOURCES_UNREADABLE');
    if (head === 'VERDICTS_UNREADABLE') return t('harness.notJudged.code.VERDICTS_UNREADABLE');
    return t('harness.notJudged.code.UNKNOWN');
}

function AgentCell({ scanId, row }: { scanId: string; row: MatrixRow }) {
    const t = useTranslations('agents');
    const { classification, discoveredId } = row.matrix;
    return (
        <div className="flex flex-col items-start gap-tight">
            <span className="font-medium text-content-emphasis">{row.registered?.name ?? discoveredId}</span>
            {row.registered && <span className="font-mono text-xs text-content-muted">{discoveredId}</span>}
            {/* Which of the two an unregistered row is comes from the server
                (the class on record, handed to the model); the grid never
                works it out. */}
            {classification === 'SHADOW_AGENT' && (
                <StatusBadge variant="warning" size="sm" data-testid={`harness-shadow-badge-${scanId}-${row.discoveredAgentId}`}>
                    {t('harness.shadowBadge')}
                </StatusBadge>
            )}
            {classification === 'UNREGISTERED_IDENTITY' && (
                <StatusBadge variant="neutral" size="sm" data-testid={`harness-identity-badge-${scanId}-${row.discoveredAgentId}`}>
                    {t('harness.identityBadge')}
                </StatusBadge>
            )}
        </div>
    );
}

/**
 * The row's level, as the shared model states it. NOT JUDGED states NO level —
 * not H0, not the stored one — and says why, code by code: a source that was
 * not read in full closes nothing, so it cannot leave a level standing either.
 * An unregistered automated identity is held to no bar (`heldToBar`), so it is
 * never shown below one; only `countsAsShortfall` is.
 */
function LevelCell({ scanId, row }: { scanId: string; row: MatrixRow }) {
    const t = useTranslations('agents');
    const m = row.matrix;
    const id = row.discoveredAgentId;
    return (
        <div
            className="flex flex-col items-start gap-tight"
            data-testid={`harness-level-${scanId}-${id}`}
            data-judgement={m.judgement.kind}
        >
            {m.judgement.kind === 'NOT_JUDGED' || m.level === null ? (
                <>
                    <StatusBadge variant="warning">{t('harness.notJudged.badge')}</StatusBadge>
                    <span className="text-xs text-content-muted">
                        {m.heldToBar ? t('harness.notJudged.levelUnstated', { bar: m.bar }) : t('harness.notJudged.levelUnstatedNoBar')}
                    </span>
                    {m.judgement.kind === 'NOT_JUDGED' && (
                        <ul className="flex flex-col gap-tight" data-testid={`harness-not-judged-reasons-${scanId}-${id}`}>
                            {m.judgement.reasons.map((code) => (
                                <li key={code} className="text-xs text-content-warning" data-code={code}>
                                    {judgementCodeSentence(t, code)}{' '}
                                    <span className="font-mono text-content-muted">({code})</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            ) : (
                <>
                    <StatusBadge variant={m.countsAsShortfall ? 'error' : 'neutral'}>{t(`harness.level.${m.level}`)}</StatusBadge>
                    {m.countsAsShortfall && (
                        <span className="text-xs text-content-error">{t('harness.belowBar', { bar: m.bar })}</span>
                    )}
                    {m.judgement.caveats.map((code) => (
                        <span key={code} className="text-xs text-content-muted" data-code={code}>
                            {judgementCodeSentence(t, code)}
                        </span>
                    ))}
                </>
            )}
            {!m.heldToBar && (
                <span className="text-xs text-content-muted" data-testid={`harness-no-bar-${scanId}-${id}`}>
                    {t('harness.identityNoBar')}
                </span>
            )}
            {row.latestIngestedLevel !== null && (
                <span
                    className="text-xs text-content-warning"
                    data-testid={`harness-latest-differs-${scanId}-${id}`}
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
                    cell: ({ row }) => <span className="text-xs">{t(`harness.reach.${row.original.matrix.reach}`)}</span>,
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
                // The model's columns, in ladder order; each cell is found by
                // its criterion rather than by position.
                ...HARNESS_MATRIX_COLUMNS.flatMap((group) => group.criteria).map(
                    (criterion): ColumnDef<MatrixRow> => ({
                        id: criterion,
                        header: () => (
                            <Tooltip content={t(`harness.criterion.${criterion}`)}>
                                <span className="font-mono text-xs">{criterion}</span>
                            </Tooltip>
                        ),
                        enableSorting: false,
                        cell: ({ row }) => {
                            const cell = row.original.matrix.cells.find((c) => c.criterion === criterion);
                            return cell ? (
                                <MatrixCell scanId={scanId} discoveredAgentId={row.original.discoveredAgentId} cell={cell} />
                            ) : null;
                        },
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
