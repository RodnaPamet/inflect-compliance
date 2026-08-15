'use client';

/**
 * Control health synthesis card (R2-P2).
 *
 * The control detail page was 8 self-fetching tabs the user had to assemble
 * into a judgement. This card sits at the top of the Overview and answers
 * "is this control implemented and operating?" in one place: implementation
 * status + applicability + latest manual-test result + latest automated-check
 * status + effectiveness (pass rate) + how much posture the control carries.
 *
 * Backed by GET /controls/{id}/health (getControlHealth). Skeleton while
 * loading, an inline "couldn't load" on error (never a permanent skeleton).
 */
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { cardVariants } from '@/components/ui/card';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { InfoTooltip } from '@/components/ui/tooltip';
import { SkeletonCard } from '@/components/ui/skeleton';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@/lib/format-date';
import { cn } from '@/lib/cn';
import { CONTROL_STATUS_VARIANT } from '@/app-layer/domain/entity-status-mapping';
import {
    CONTROL_HEALTH_VERDICT_VARIANT,
    type ControlHealthVerdict,
} from '@/lib/controls/control-health';

interface ControlHealthDTO {
    verdict: ControlHealthVerdict;
    status: string;
    applicability: string;
    lastTested: string | null;
    latestTestResult: string | null;
    latestTestAt: string | null;
    latestCheckStatus: string | null;
    latestCheckAt: string | null;
    openExceptions: number;
    effectiveness: { passRate: number | null; total: number; passes: number; fails: number; inconclusive: number; windowDays: number };
    coverage: { requirementCount: number; frameworkCount: number; frameworks: string[] };
}

// Was a byte-identical private copy of the shared map.
const STATUS_VARIANT: Record<string, StatusBadgeVariant> = CONTROL_STATUS_VARIANT;
const TEST_RESULT_VARIANT: Record<string, StatusBadgeVariant> = {
    PASS: 'success', FAIL: 'error', INCONCLUSIVE: 'warning',
};
const CHECK_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    PASSED: 'success', FAILED: 'error', ERROR: 'error', NOT_APPLICABLE: 'neutral',
    PENDING: 'info', RUNNING: 'info',
};

function Vital({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <span className="text-xs text-content-subtle uppercase">{label}</span>
            <div className="text-sm text-content-default mt-1">{children}</div>
        </div>
    );
}

export function ControlHealthCard({ controlId }: { controlId: string }) {
    const t = useTranslations('controls');
    const { data, isLoading, error, mutate } = useTenantSWR<ControlHealthDTO>(
        CACHE_KEYS.controls.health(controlId),
    );

    if (isLoading && !data) return <SkeletonCard lines={3} />;
    if (error || !data) {
        return (
            <InlineNotice variant="error">
                {t('health.loadError')}{' '}
                <button
                    type="button"
                    className="underline hover:no-underline"
                    onClick={() => void mutate()}
                >
                    {t('health.retry')}
                </button>
            </InlineNotice>
        );
    }

    const eff = data.effectiveness;
    return (
        <div className={cn(cardVariants(), 'space-y-default')}>
            <div className="flex items-center gap-1.5">
                <Heading level={3}>{t('health.title')}</Heading>
                <InfoTooltip aria-label={t('health.titleHelp')} content={t('health.titleTooltip')} iconClassName="h-3.5 w-3.5" />
                {/* Composite verdict — ONE gate over the measured signals,
                    surfaced prominently so "is this control healthy?" reads
                    at a glance without assembling the tiles below. */}
                <StatusBadge
                    variant={CONTROL_HEALTH_VERDICT_VARIANT[data.verdict]}
                    tone="solid"
                    className="ml-auto"
                    id="control-health-verdict"
                >
                    {t(`health.verdict.${data.verdict}` as Parameters<typeof t>[0])}
                </StatusBadge>
            </div>
            <div className="grid grid-cols-2 gap-default md:grid-cols-3">
                <Vital label={t('health.status')}>
                    <StatusBadge variant={STATUS_VARIANT[data.status] ?? 'neutral'}>
                        {t(`filterEnums.status.${data.status}` as Parameters<typeof t>[0])}
                    </StatusBadge>
                </Vital>
                <Vital label={t('health.applicability')}>
                    <StatusBadge variant={data.applicability === 'APPLICABLE' ? 'info' : 'neutral'}>
                        {t(`filterEnums.applicability.${data.applicability}` as Parameters<typeof t>[0])}
                    </StatusBadge>
                </Vital>
                <Vital label={t('health.coverage')}>
                    {data.coverage.requirementCount > 0
                        ? t('health.coverageValue', {
                              reqs: data.coverage.requirementCount,
                              frameworks: data.coverage.frameworkCount,
                          })
                        : t('health.coverageNone')}
                </Vital>
                <Vital label={t('health.latestTest')}>
                    {data.latestTestResult ? (
                        <span className="inline-flex items-center gap-1.5">
                            <StatusBadge variant={TEST_RESULT_VARIANT[data.latestTestResult] ?? 'neutral'}>
                                {t(`health.testResult.${data.latestTestResult}` as Parameters<typeof t>[0])}
                            </StatusBadge>
                            {data.latestTestAt && (
                                <span className="text-xs text-content-subtle">{formatDate(data.latestTestAt)}</span>
                            )}
                        </span>
                    ) : (
                        <span className="text-content-subtle">{t('health.never')}</span>
                    )}
                </Vital>
                <Vital label={t('health.latestCheck')}>
                    {data.latestCheckStatus ? (
                        <span className="inline-flex items-center gap-1.5">
                            <StatusBadge variant={CHECK_STATUS_VARIANT[data.latestCheckStatus] ?? 'neutral'}>
                                {t(`health.checkStatus.${data.latestCheckStatus}` as Parameters<typeof t>[0])}
                            </StatusBadge>
                            {data.latestCheckAt && (
                                <span className="text-xs text-content-subtle">{formatDate(data.latestCheckAt)}</span>
                            )}
                        </span>
                    ) : (
                        <span className="text-content-subtle">{t('health.never')}</span>
                    )}
                </Vital>
                <Vital label={t('health.effectiveness')}>
                    {eff.passRate !== null ? (
                        <span>
                            <span className="font-medium text-content-emphasis">{eff.passRate}%</span>{' '}
                            <span className="text-xs text-content-subtle">
                                {t('health.effectivenessMetaFull', { passes: eff.passes, inconclusive: eff.inconclusive, total: eff.total, days: eff.windowDays })}
                            </span>
                        </span>
                    ) : (
                        <span className="text-content-subtle">{t('health.never')}</span>
                    )}
                </Vital>
            </div>
        </div>
    );
}
