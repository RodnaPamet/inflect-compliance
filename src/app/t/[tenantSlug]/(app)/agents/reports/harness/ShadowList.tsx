'use client';

/**
 * Agents a scan found with no live register row — never registered, or whose
 * row was deleted after a scan linked it.
 *
 * AN EMPTY LIST IS QUALIFIED BY ITS EVIDENCE. "No shadow agent" is said only
 * when EVERY trusted scanner's latest scan is COMPLETE, and then as of the
 * oldest of them. Otherwise the list cannot be read as "none", and says so: a
 * shadow agent only an incomplete (or silent) scanner's sources would reveal
 * never becomes a row, so an empty list then is the absence of an answer.
 *
 * THE REGISTER ACTION (#3712) takes a row's SHADOW_AGENT finding into the
 * register through the intake. It is offered only where the intake would take
 * it: the caller may run the intake (`onRegister` is null otherwise), the row
 * has a finding to register from, and no intake row was made from this agent
 * before — the intake refuses a second whatever the first one's status, so the
 * row says what became of the first instead.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type { HarnessMatrixView, ShadowRow } from '@/lib/agentic/harness-read-model';

import { sourceKindLabel } from './source-kind-label';

function RegistrationCell({
    row,
    onRegister,
}: {
    row: ShadowRow;
    onRegister: ((row: ShadowRow) => void) | null;
}) {
    const t = useTranslations('agents');
    if (row.intake) {
        return (
            <span className="text-xs text-content-muted" data-testid={`harness-shadow-intake-${row.discoveredAgentId}`}>
                {row.intake.linkable
                    ? t('harness.shadowIntakePending', { name: row.intake.name ?? row.intake.agentId })
                    : t('harness.shadowIntakeRetired')}
            </span>
        );
    }
    if (row.findingId === null) {
        return (
            <span className="text-xs text-content-muted" data-testid={`harness-shadow-no-finding-${row.discoveredAgentId}`}>
                {t('harness.shadowNoFinding')}
            </span>
        );
    }
    if (!onRegister) return null;
    return (
        <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onRegister(row)}
            data-testid={`harness-shadow-register-${row.discoveredAgentId}`}
        >
            {t('harness.register')}
        </Button>
    );
}

export function ShadowList({
    shadow,
    onRegister = null,
}: {
    shadow: HarnessMatrixView['shadow'];
    /** Opens the intake dialog; `null` when the caller may not run the intake. */
    onRegister?: ((row: ShadowRow) => void) | null;
}) {
    const t = useTranslations('agents');

    const columns = useMemo(
        () =>
            createColumns<ShadowRow>([
                {
                    id: 'discoveredId',
                    header: t('harness.colDiscoveredId'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="font-mono text-xs">{row.original.discoveredId}</span>,
                },
                {
                    id: 'via',
                    header: t('harness.colVia'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-xs">
                            {row.original.discoveredVia.map((k) => sourceKindLabel(t, k)).join(', ')}
                        </span>
                    ),
                },
                {
                    id: 'reason',
                    header: t('harness.colReason'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <StatusBadge variant="warning" size="sm">
                            {t(`harness.shadowReason.${row.original.reason}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'lastLevel',
                    header: t('harness.colLastLevel'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{t(`harness.level.${row.original.lastLevel}`)}</span>,
                },
                {
                    id: 'firstSeen',
                    header: t('harness.colFirstSeen'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.firstSeenAt)}</span>,
                },
                {
                    id: 'lastSeen',
                    header: t('harness.colLastSeen'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.lastSeenAt)}</span>,
                },
                {
                    id: 'registration',
                    header: t('harness.colRegistration'),
                    enableSorting: false,
                    cell: ({ row }) => <RegistrationCell row={row.original} onRegister={onRegister} />,
                },
            ]),
        [t, onRegister],
    );

    return (
        <Card data-testid="harness-shadow" className="space-y-default">
            <Heading level={2}>{t('harness.shadowHeading')}</Heading>
            <p className="text-sm text-content-muted">{t('harness.shadowIntro')}</p>
            {shadow.rows.length === 0 ? (
                shadow.basis === 'EVIDENCED' ? (
                    <p className="text-sm" data-testid="harness-shadow-none">
                        {t('harness.shadowNone', { asOf: formatDateTime(shadow.basisAsOf) })}
                    </p>
                ) : (
                    <InlineNotice variant="warning" data-testid="harness-shadow-unstated">
                        {t('harness.shadowUnstated')}
                    </InlineNotice>
                )
            ) : (
                <>
                    {shadow.basis === 'NOT_EVIDENCED' && (
                        <InlineNotice variant="warning" icon={null} data-testid="harness-shadow-may-be-incomplete">
                            {t('harness.shadowMayBeIncomplete')}
                        </InlineNotice>
                    )}
                    <DataTable<ShadowRow>
                        data={[...shadow.rows]}
                        columns={columns}
                        getRowId={(r) => r.discoveredAgentId}
                        selectionEnabled={false}
                        resourceName={(plural) => (plural ? t('harness.resourceAgents') : t('harness.resourceAgent'))}
                        emptyState={t('harness.shadowUnstated')}
                        data-testid="harness-shadow-table"
                    />
                </>
            )}
            {shadow.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-shadow-truncated">
                    {t('harness.shadowTruncated', { count: shadow.rows.length })}
                </InlineNotice>
            )}
        </Card>
    );
}
