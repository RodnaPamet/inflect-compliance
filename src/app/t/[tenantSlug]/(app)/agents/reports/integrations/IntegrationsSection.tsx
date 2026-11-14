'use client';

/**
 * One trusted scanner's latest third-party application scan: its COVERAGE
 * first — which sources it read, in full or not, and whether it read sign-in
 * activity — and then its applications, worst first.
 *
 * Coverage comes first because it says how far the rows below can be read. An
 * INCOMPLETE source's rows are what was seen, never the whole; an EMPTY scan
 * is a finding, not a clean bill. A member the product does not expose (an
 * Okta application's or a GitHub App's owner, publisher and sign-in) reads
 * "not exposed", and one the read did not establish reads "not known": neither
 * is ever shown as "none".
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type {
    ThirdPartyAppRow,
    ThirdPartyAppSourceView,
    ThirdPartyScanCompleteness,
    ThirdPartyScanSection,
} from '@/lib/agentic/third-party-app-read-model';

const COMPLETENESS_VARIANT: Readonly<Record<ThirdPartyScanCompleteness, StatusBadgeVariant>> = {
    COMPLETE: 'success',
    INCOMPLETE: 'warning',
    EMPTY: 'error',
};

const PRIVILEGE_VARIANT: Readonly<Record<ThirdPartyAppRow['privilege'], StatusBadgeVariant>> = {
    HIGH: 'error',
    NOT_CONCLUDED: 'warning',
    NOT_HIGH: 'neutral',
};

const SEVERITY_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

function SourceLine({ source }: { source: ThirdPartyAppSourceView }) {
    const t = useTranslations('agents');
    const read =
        source.status === 'COMPLETE'
            ? t('reports.integrations.sourceComplete', { product: source.product, rows: source.rows })
            : t('reports.integrations.sourceIncomplete', {
                product: source.product,
                rows: source.rows,
                reason: source.reason ? t(`harness.incompleteReason.${source.reason}`) : '',
            });
    const signIn =
        source.signIn === 'COMPLETE'
            ? t('reports.integrations.signInComplete')
            : source.signIn === 'INCOMPLETE'
                ? t('reports.integrations.signInIncomplete', {
                    reason: source.signInReason ? t(`harness.incompleteReason.${source.signInReason}`) : '',
                })
                : t('reports.integrations.signInNotRead');
    return (
        <li
            className={source.status === 'INCOMPLETE' || source.signIn === 'INCOMPLETE' ? 'text-content-warning' : undefined}
            data-testid={`integrations-source-${source.kind}`}
        >
            {read} {signIn}
            {source.openFindings.map((f) => (
                <StatusBadge
                    key={f.findingId}
                    variant={SEVERITY_VARIANT[f.severity] ?? 'neutral'}
                    size="sm"
                    className="ml-1"
                    data-testid={`integrations-source-finding-${source.kind}-${f.code}`}
                >
                    {t(`reports.integrations.findingCode.${f.code}`)}
                </StatusBadge>
            ))}
        </li>
    );
}

function PrivilegeCell({ row }: { row: ThirdPartyAppRow }) {
    const t = useTranslations('agents');
    return (
        <div className="space-y-tight text-xs" data-testid={`integrations-privilege-${row.appId}`}>
            <StatusBadge variant={PRIVILEGE_VARIANT[row.privilege]} size="sm">
                {t(`reports.integrations.privilege.${row.privilege}`)}
            </StatusBadge>
            {row.classes.length > 0 && (
                <p>{row.classes.map((c) => t(`reports.integrations.class.${c}`)).join(', ')}</p>
            )}
            {row.highPermissions.length > 0 && (
                <p className="font-mono text-content-muted">
                    {row.highPermissions.join(', ')}
                    {row.highPermissionCount > row.highPermissions.length &&
                        ` ${t('reports.integrations.morePermissions', { count: row.highPermissionCount - row.highPermissions.length })}`}
                </p>
            )}
            {row.unknownPermissionCount > 0 && (
                <p className="text-content-warning">
                    {t('reports.integrations.unknownPermissions', { count: row.unknownPermissionCount })}
                </p>
            )}
        </div>
    );
}

export function IntegrationsSection({ section }: { section: ThirdPartyScanSection }) {
    const t = useTranslations('agents');
    const { scan } = section;

    const columns = useMemo(
        () =>
            createColumns<ThirdPartyAppRow>([
                {
                    id: 'application',
                    header: t('reports.integrations.colApplication'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <div className="text-xs">
                            <p className="text-content-emphasis">
                                {row.original.name ?? t('reports.integrations.unnamed')}
                            </p>
                            <p className="text-content-muted">{row.original.product}</p>
                            <p className="font-mono text-content-subtle">{row.original.applicationId}</p>
                        </div>
                    ),
                },
                {
                    id: 'privilege',
                    header: t('reports.integrations.colPrivilege'),
                    enableSorting: false,
                    cell: ({ row }) => <PrivilegeCell row={row.original} />,
                },
                {
                    id: 'publisher',
                    header: t('reports.integrations.colPublisher'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const p = row.original.publisher;
                        const label =
                            p.state === 'NOT_EXPOSED'
                                ? t('reports.integrations.notExposed')
                                : p.state === 'NOT_KNOWN'
                                    ? t('reports.integrations.notKnown')
                                    : p.verified
                                        ? t('reports.integrations.publisherVerified')
                                        : t('reports.integrations.publisherUnverified');
                        return (
                            <span className="text-xs" data-testid={`integrations-publisher-${row.original.appId}`}>
                                {label}
                            </span>
                        );
                    },
                },
                {
                    id: 'owners',
                    header: t('reports.integrations.colOwners'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const o = row.original.owners;
                        const label =
                            o.state === 'NOT_EXPOSED'
                                ? t('reports.integrations.notExposed')
                                : o.state === 'NOT_KNOWN' || o.count === null
                                    ? t('reports.integrations.notKnown')
                                    : o.count === 0
                                        ? t('reports.integrations.noOwner')
                                        : t('reports.integrations.ownerCount', { count: o.count });
                        return (
                            <span className="text-xs" data-testid={`integrations-owners-${row.original.appId}`}>
                                {label}
                            </span>
                        );
                    },
                },
                {
                    id: 'signIn',
                    header: t('reports.integrations.colSignIn'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const r = row.original;
                        const label =
                            r.signIn === 'NOT_EXPOSED'
                                ? t('reports.integrations.notExposed')
                                : r.usage === 'NOT_CONCLUDED'
                                    ? t('reports.integrations.notConcluded')
                                    : r.daysSinceSignIn === null
                                        ? t('reports.integrations.noSignIn')
                                        : t('reports.integrations.daysSinceSignIn', { days: r.daysSinceSignIn });
                        return (
                            <span
                                className={r.usage === 'UNUSED' ? 'text-xs text-content-warning' : 'text-xs'}
                                data-testid={`integrations-sign-in-${r.appId}`}
                            >
                                {label}
                            </span>
                        );
                    },
                },
                {
                    id: 'findings',
                    header: t('reports.integrations.colFindings'),
                    enableSorting: false,
                    cell: ({ row }) =>
                        row.original.openFindings.length === 0 ? (
                            <span className="text-xs text-content-muted">{t('reports.integrations.noOpenFindings')}</span>
                        ) : (
                            <div className="flex flex-wrap gap-tight" data-testid={`integrations-findings-${row.original.appId}`}>
                                {row.original.openFindings.map((f) => (
                                    <StatusBadge key={f.findingId} variant={SEVERITY_VARIANT[f.severity] ?? 'neutral'} size="sm">
                                        {t(`reports.integrations.findingCode.${f.code}`)}
                                    </StatusBadge>
                                ))}
                            </div>
                        ),
                },
            ]),
        [t],
    );

    return (
        <Card data-testid={`integrations-section-${scan.id}`} className="space-y-default">
            <div className="flex flex-wrap items-center gap-compact">
                <Heading level={2}>
                    {t('reports.integrations.sectionHeading', {
                        scanner: scan.scannerName ?? scan.scannerAgentId,
                        asOf: formatDateTime(scan.asOf),
                    })}
                </Heading>
                <StatusBadge
                    variant={COMPLETENESS_VARIANT[scan.completeness]}
                    data-testid={`integrations-completeness-${scan.id}`}
                >
                    {t(`harness.completeness.${scan.completeness}`)}
                </StatusBadge>
            </div>
            <p className="text-xs text-content-muted">
                {t('reports.integrations.scanLine', {
                    scanRef: scan.scanRef,
                    version: scan.scannerVersion,
                    received: formatDateTime(scan.ingestedAt),
                    count: scan.applicationCount,
                    days: scan.unusedDays,
                })}
            </p>

            {/* COVERAGE FIRST: it says how far the rows below can be read. */}
            <div>
                <Heading level={3}>{t('reports.integrations.coverageHeading')}</Heading>
                {section.sources === null ? (
                    <InlineNotice variant="error" icon={null} data-testid={`integrations-sources-unreadable-${scan.id}`}>
                        {t('reports.integrations.sourcesUnreadable')}
                    </InlineNotice>
                ) : (
                    <ul className="space-y-tight text-xs" data-testid={`integrations-coverage-${scan.id}`}>
                        {section.sources.map((s) => (
                            <SourceLine key={s.kind} source={s} />
                        ))}
                    </ul>
                )}
            </div>

            {scan.completeness === 'EMPTY' && (
                <InlineNotice variant="error" data-testid={`integrations-empty-${scan.id}`}>
                    {t('reports.integrations.emptyScan')}
                </InlineNotice>
            )}
            {scan.completeness === 'INCOMPLETE' && (
                <InlineNotice variant="warning" data-testid={`integrations-incomplete-${scan.id}`}>
                    {t('reports.integrations.incompleteScan')}
                </InlineNotice>
            )}

            {section.rowsUnread ? (
                <InlineNotice variant="error" icon={null} data-testid={`integrations-rows-unread-${scan.id}`}>
                    {t('reports.integrations.rowsUnread')}
                </InlineNotice>
            ) : (
                section.rows.length > 0 && (
                    <DataTable<ThirdPartyAppRow>
                        data={[...section.rows]}
                        columns={columns}
                        getRowId={(r) => r.appId}
                        selectionEnabled={false}
                        resourceName={(plural) =>
                            plural ? t('reports.integrations.resourceApps') : t('reports.integrations.resourceApp')
                        }
                        emptyState={t('reports.integrations.emptyScan')}
                        data-testid={`integrations-apps-table-${scan.id}`}
                    />
                )
            )}
            {section.rowsTruncated && (
                <InlineNotice variant="warning" icon={null} data-testid={`integrations-rows-truncated-${scan.id}`}>
                    {t('reports.integrations.rowsTruncated', { shown: section.rows.length, count: scan.applicationCount })}
                </InlineNotice>
            )}
        </Card>
    );
}
