'use client';

/**
 * PER-ESTATE SCHEDULE HEALTH on the harness tab (#3678, step 4a): for each
 * declared estate, the last complete scan and, for each of its sources, the
 * last scan that read it in full — with the source's owner — and whether the
 * estate is FRESH or STALE against its cadence.
 *
 * Read-only. The rules are `computeEstateHealth`'s, run on the server; this
 * renders what it decided and adds none of its own. In particular a STALE
 * estate is never softened here: "no complete scan among those read" and "the
 * last complete scan is too old" are both STALE, and the text says which.
 *
 * No estate declared is said in words, not left as an empty card: until an
 * estate exists, no scan is held to any schedule, which is a gap rather than a
 * clean state.
 */
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type {
    EstateHealthRow,
    EstateHealthStatus,
    EstateSourceHealth,
    HarnessEstateHealthView,
} from '@/lib/agentic/harness-estate-health';

import { COMPLETENESS_VARIANT } from './ScannerSection';

const STATUS_VARIANT: Readonly<Record<EstateHealthStatus, StatusBadgeVariant>> = {
    FRESH: 'success',
    STALE: 'error',
};

function SourceLine({ estateId, source }: { estateId: string; source: EstateSourceHealth }) {
    const t = useTranslations('agents');
    const owner = source.owner.name ?? t('harness.estates.ownerUnnamed');
    const latest = source.latest;
    return (
        <li
            className="flex flex-wrap items-center gap-compact text-xs"
            data-testid={`harness-estate-source-${estateId}-${source.kind}`}
        >
            <span className="font-mono">{source.kind}</span>
            <StatusBadge variant={STATUS_VARIANT[source.status]} size="sm">
                {t(`harness.estates.status.${source.status}`)}
            </StatusBadge>
            <span>
                {t('harness.estates.sourceOwner', { name: owner })}
                {!source.owner.active && (
                    <span className="text-content-error" data-testid={`harness-estate-owner-departed-${estateId}-${source.kind}`}>
                        {' '}({t('harness.estates.ownerDeparted')})
                    </span>
                )}
            </span>
            <span className="text-content-muted">
                {source.lastComplete
                    ? t('harness.estates.sourceLastComplete', { at: formatDateTime(source.lastComplete.at) })
                    : t('harness.estates.sourceNeverComplete')}
            </span>
            {latest && latest.state !== 'COMPLETE' && (
                <span className="text-content-warning">
                    {t('harness.estates.latestState', {
                        state: t(`harness.estates.sourceState.${latest.state}`, {
                            reason: latest.reason ? t(`harness.incompleteReason.${latest.reason}`) : '',
                        }),
                    })}
                </span>
            )}
        </li>
    );
}

function EstateBlock({ row, window }: { row: EstateHealthRow; window: number }) {
    const t = useTranslations('agents');
    return (
        <section className="space-y-compact border-t border-border-subtle pt-default" data-testid={`harness-estate-${row.id}`}>
            <div className="flex flex-wrap items-center gap-compact">
                <Heading level={3}>{row.name}</Heading>
                <StatusBadge variant={STATUS_VARIANT[row.status]} data-testid={`harness-estate-status-${row.id}`}>
                    {t(`harness.estates.status.${row.status}`)}
                </StatusBadge>
                <span className="text-xs text-content-muted">
                    {t('harness.estates.cadence', { cadence: row.cadenceHours, stale: row.staleAfterHours })}
                </span>
                <span className="text-xs text-content-muted">
                    {t('harness.estates.scanner', { name: row.scannerName ?? row.scannerAgentId })}
                </span>
            </div>
            {!row.scannerLive && (
                <InlineNotice variant="error" icon={null} data-testid={`harness-estate-scanner-retired-${row.id}`}>
                    {t('harness.estates.scannerRetired')}
                </InlineNotice>
            )}
            <p className="text-xs" data-testid={`harness-estate-last-complete-${row.id}`}>
                {row.lastComplete
                    ? t('harness.estates.lastComplete', { at: formatDateTime(row.lastComplete.at), scanRef: row.lastComplete.scanRef })
                    : t('harness.estates.lastCompleteMissing', { window })}
            </p>
            <p className="flex flex-wrap items-center gap-compact text-xs">
                {row.latest ? (
                    <>
                        <span>
                            {t('harness.estates.latest', {
                                at: formatDateTime(row.latest.at),
                                completeness: t(`harness.completeness.${row.latest.completeness}`),
                            })}
                        </span>
                        <StatusBadge variant={COMPLETENESS_VARIANT[row.latest.completeness]} size="sm">
                            {t(`harness.completeness.${row.latest.completeness}`)}
                        </StatusBadge>
                    </>
                ) : (
                    <span>{t('harness.estates.latestMissing', { window })}</span>
                )}
            </p>
            <ul className="space-y-tight">
                {row.sources.map((s) => (
                    <SourceLine key={s.kind} estateId={row.id} source={s} />
                ))}
            </ul>
            {row.undeclaredSources.length > 0 && (
                <InlineNotice variant="warning" icon={null} data-testid={`harness-estate-undeclared-${row.id}`}>
                    {t('harness.estates.undeclared', { kinds: row.undeclaredSources.join(', ') })}
                </InlineNotice>
            )}
        </section>
    );
}

export function EstateHealthCard({ view }: { view: HarnessEstateHealthView }) {
    const t = useTranslations('agents');
    return (
        <Card data-testid="harness-estates" className="space-y-default">
            <Heading level={2}>{t('harness.estates.heading')}</Heading>
            <p className="text-xs text-content-muted">{t('harness.estates.intro')}</p>
            {view.estates.rows.length === 0 ? (
                <InlineNotice variant="warning" data-testid="harness-estates-none">
                    {t('harness.estates.none')}
                </InlineNotice>
            ) : (
                view.estates.rows.map((row) => <EstateBlock key={row.id} row={row} window={view.scanWindow} />)
            )}
            {view.windowTruncated && (
                <InlineNotice variant="info" icon={null} data-testid="harness-estates-window-truncated">
                    {t('harness.estates.windowTruncated', { window: view.scanWindow })}
                </InlineNotice>
            )}
            {view.estates.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-estates-truncated">
                    {t('harness.estates.estatesTruncated')}
                </InlineNotice>
            )}
        </Card>
    );
}
