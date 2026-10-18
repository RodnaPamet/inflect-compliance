'use client';

/**
 * What changed since the SAME scanner's previous scan — computed on the server
 * from stored rows only (`computeHarnessDrift`).
 *
 * Every list is stated, including the empty ones: "no level fell" is a claim,
 * and leaving the list out would make it impossible to tell from a list that
 * was never computed. Each side's completeness is stated too, because an agent
 * an incomplete baseline missed shows up here as "newly seen".
 */
import { useTranslations } from 'next-intl';

import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type { HarnessScannerSection } from '@/lib/agentic/harness-read-model';

/** Entries shown per list before "+N more". */
const LIST_LIMIT = 50;

interface Line {
    key: string;
    text: string;
}

function DriftList({ testId, heading, empty, lines }: { testId: string; heading: string; empty: string; lines: Line[] }) {
    const t = useTranslations('agents');
    return (
        <div className="space-y-tight text-sm" data-testid={testId}>
            <p className="font-medium text-content-emphasis">{heading}</p>
            {lines.length === 0 ? (
                <p className="text-content-muted" data-testid={`${testId}-none`}>
                    {empty}
                </p>
            ) : (
                <ul className="space-y-tight">
                    {lines.slice(0, LIST_LIMIT).map((l) => (
                        <li key={l.key}>{l.text}</li>
                    ))}
                    {lines.length > LIST_LIMIT && (
                        <li className="text-content-muted">{t('harness.driftMore', { count: lines.length - LIST_LIMIT })}</li>
                    )}
                </ul>
            )}
        </div>
    );
}

export function DriftPanel({ section, scanWindow }: { section: HarnessScannerSection; scanWindow: number }) {
    const t = useTranslations('agents');
    const id = section.latest.id;
    const { drift } = section;

    if (drift === null) {
        const reason = section.driftUnavailableReason;
        return (
            <section className="space-y-compact" data-testid={`harness-drift-${id}`}>
                <Heading level={3}>{t('harness.driftHeadingNone')}</Heading>
                <p className="text-sm text-content-muted" data-testid={`harness-drift-${id}-unavailable`}>
                    {reason === 'OUTSIDE_WINDOW'
                        ? t('harness.driftOutsideWindow', { count: scanWindow })
                        : reason === 'POPULATION_OVER_BOUND'
                            ? t('harness.driftOverBound')
                            : t('harness.driftFirstScan')}
                </p>
            </section>
        );
    }

    const reasonOf = (reason: string | null) => (reason ? t(`harness.incompleteReason.${reason}`) : '');
    const sourceLines: Line[] = [
        ...drift.sourcesGoneIncomplete.map((s) => ({
            key: `gone:${s.kind}`,
            text: t('harness.sourceGoneIncompleteLine', { kind: s.kind, reason: reasonOf(s.reason) }),
        })),
        ...drift.sourcesDropped.map((kind) => ({ key: `dropped:${kind}`, text: t('harness.sourceDropped', { kind }) })),
    ];

    return (
        <section className="space-y-compact" data-testid={`harness-drift-${id}`}>
            <Heading level={3}>{t('harness.driftHeading', { scanRef: drift.baselineScanRef })}</Heading>
            <p className="text-sm text-content-muted">
                {t('harness.driftBaseline', {
                    scanRef: drift.baselineScanRef,
                    asOf: formatDateTime(drift.baselineAsOf),
                    completeness: t(`harness.completeness.${drift.baselineCompleteness}`),
                })}
            </p>
            {drift.baselineCompleteness !== 'COMPLETE' && (
                <InlineNotice variant="warning" icon={null} data-testid={`harness-drift-${id}-baseline-incomplete`}>
                    {t('harness.driftBaselineIncomplete')}
                </InlineNotice>
            )}
            {section.latest.completeness !== 'COMPLETE' && (
                <InlineNotice variant="warning" icon={null} data-testid={`harness-drift-${id}-latest-incomplete`}>
                    {t('harness.driftLatestIncomplete')}
                </InlineNotice>
            )}
            <div className="grid grid-cols-1 gap-default md:grid-cols-3">
                <DriftList
                    testId={`harness-drift-${id}-drops`}
                    heading={t('harness.levelDrops', { count: drift.levelDrops.length })}
                    empty={t('harness.noLevelDrops')}
                    lines={drift.levelDrops.map((d) => ({
                        key: d.discoveredAgentId,
                        text: t('harness.levelDropLine', { agent: d.discoveredId, from: d.from, to: d.to }),
                    }))}
                />
                <DriftList
                    testId={`harness-drift-${id}-new`}
                    heading={t('harness.newlySeen', { count: drift.newlySeen.length })}
                    empty={t('harness.noNewlySeen')}
                    lines={drift.newlySeen.map((n) => ({ key: n.discoveredAgentId, text: n.discoveredId }))}
                />
                {drift.sourceDriftUnknown ? (
                    <div className="space-y-tight text-sm" data-testid={`harness-drift-${id}-sources`}>
                        <p className="font-medium text-content-emphasis">
                            {t('harness.sourceDriftHeading')}
                        </p>
                        <p className="text-content-warning" data-testid={`harness-drift-${id}-sources-unknown`}>
                            {t('harness.sourceDriftUnknown')}
                        </p>
                    </div>
                ) : (
                    <DriftList
                        testId={`harness-drift-${id}-sources`}
                        heading={t('harness.sourcesLost', { count: sourceLines.length })}
                        empty={t('harness.noSourceDrift')}
                        lines={sourceLines}
                    />
                )}
            </div>
        </section>
    );
}
