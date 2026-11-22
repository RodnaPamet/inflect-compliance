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
 *
 * TWO LISTS, ONE COMPONENT (owner decisions, 2026-11-13). A principal with no
 * live register row and no sign of a model is an UNREGISTERED AUTOMATED
 * IDENTITY, not a shadow agent, and is listed in a section of its own
 * (`UnregisteredIdentityList`). The server decides which list a row is on —
 * each list arrives already split — and both lists hold the same rules: the
 * same honest emptiness, the same Register action. Only the words differ, and
 * every one of them is a literal key in `listCopy`.
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

type ListKind = 'shadow' | 'identity';

/** The slice of the view either list renders: the shadow list's shape, shared by both. */
type UnregisteredList = HarnessMatrixView['shadow'];

/**
 * Each list's own words and test-id prefix. Every key is a literal, so a
 * missing message is a missing line here and not a template nobody can grep.
 */
function listCopy(t: (key: string, values?: Record<string, string | number>) => string, kind: ListKind) {
    return kind === 'identity'
        ? {
            testId: 'harness-identity',
            heading: t('harness.identityHeading'),
            intro: t('harness.identityIntro'),
            none: (asOf: string) => t('harness.identityNone', { asOf }),
            unstated: t('harness.identityUnstated'),
            mayBeIncomplete: t('harness.identityMayBeIncomplete'),
            truncated: (count: number) => t('harness.identityTruncated', { count }),
            noFinding: t('harness.identityNoFinding'),
        }
        : {
            testId: 'harness-shadow',
            heading: t('harness.shadowHeading'),
            intro: t('harness.shadowIntro'),
            none: (asOf: string) => t('harness.shadowNone', { asOf }),
            unstated: t('harness.shadowUnstated'),
            mayBeIncomplete: t('harness.shadowMayBeIncomplete'),
            truncated: (count: number) => t('harness.shadowTruncated', { count }),
            noFinding: t('harness.shadowNoFinding'),
        };
}

function RegistrationCell({
    row,
    kind,
    onRegister,
}: {
    row: ShadowRow;
    kind: ListKind;
    onRegister: ((row: ShadowRow) => void) | null;
}) {
    const t = useTranslations('agents');
    const copy = listCopy(t, kind);
    if (row.intake) {
        return (
            <span className="text-xs text-content-muted" data-testid={`${copy.testId}-intake-${row.discoveredAgentId}`}>
                {row.intake.linkable
                    ? t('harness.shadowIntakePending', { name: row.intake.name ?? row.intake.agentId })
                    : t('harness.shadowIntakeRetired')}
            </span>
        );
    }
    if (row.findingId === null) {
        return (
            <span className="text-xs text-content-muted" data-testid={`${copy.testId}-no-finding-${row.discoveredAgentId}`}>
                {copy.noFinding}
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
            data-testid={`${copy.testId}-register-${row.discoveredAgentId}`}
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
    return <UnregisteredPrincipalList kind="shadow" list={shadow} onRegister={onRegister} />;
}

/**
 * Principals a scan found with no live register row AND no sign that they run
 * a model: service accounts, build workflows holding a credential, directory
 * applications. Not shadow agents, held to no bar, and registrable exactly as
 * a shadow agent is — the scan cannot show that one runs no model.
 */
export function UnregisteredIdentityList({
    identities,
    onRegister = null,
}: {
    identities: HarnessMatrixView['unregisteredIdentities'];
    /** Opens the intake dialog; `null` when the caller may not run the intake. */
    onRegister?: ((row: ShadowRow) => void) | null;
}) {
    return <UnregisteredPrincipalList kind="identity" list={identities} onRegister={onRegister} />;
}

function UnregisteredPrincipalList({
    kind,
    list: shadow,
    onRegister,
}: {
    kind: ListKind;
    list: UnregisteredList;
    onRegister: ((row: ShadowRow) => void) | null;
}) {
    const t = useTranslations('agents');
    const copy = listCopy(t, kind);

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
                        <StatusBadge variant={kind === 'identity' ? 'neutral' : 'warning'} size="sm">
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
                    cell: ({ row }) => <RegistrationCell row={row.original} kind={kind} onRegister={onRegister} />,
                },
            ]),
        [t, kind, onRegister],
    );

    return (
        <Card data-testid={copy.testId} className="space-y-default">
            <Heading level={2}>{copy.heading}</Heading>
            <p className="text-sm text-content-muted">{copy.intro}</p>
            {shadow.rows.length === 0 ? (
                shadow.basis === 'EVIDENCED' ? (
                    <p className="text-sm" data-testid={`${copy.testId}-none`}>
                        {copy.none(formatDateTime(shadow.basisAsOf))}
                    </p>
                ) : (
                    <InlineNotice variant="warning" data-testid={`${copy.testId}-unstated`}>
                        {copy.unstated}
                    </InlineNotice>
                )
            ) : (
                <>
                    {shadow.basis === 'NOT_EVIDENCED' && (
                        <InlineNotice variant="warning" icon={null} data-testid={`${copy.testId}-may-be-incomplete`}>
                            {copy.mayBeIncomplete}
                        </InlineNotice>
                    )}
                    <DataTable<ShadowRow>
                        data={[...shadow.rows]}
                        columns={columns}
                        getRowId={(r) => r.discoveredAgentId}
                        selectionEnabled={false}
                        resourceName={(plural) => (plural ? t('harness.resourceAgents') : t('harness.resourceAgent'))}
                        emptyState={copy.unstated}
                        data-testid={`${copy.testId}-table`}
                    />
                </>
            )}
            {shadow.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid={`${copy.testId}-truncated`}>
                    {copy.truncated(shadow.rows.length)}
                </InlineNotice>
            )}
        </Card>
    );
}
