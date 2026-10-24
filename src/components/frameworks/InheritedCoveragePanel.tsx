'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { KPIStat } from '@/components/ui/metric';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, textLinkVariants } from '@/components/ui/typography';
import { cn } from '@inflect/ui/lib/cn';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

/**
 * "Coverage from your other frameworks" — the framework Coverage tab's second
 * half, reading `computeInheritedCoverage` (usecases/framework/inherited-coverage.ts).
 *
 * It lists the requirements with no control of their own that the tenant's
 * controls on ANOTHER framework reach through a curated mapping, and which
 * controls those are. It sits under the direct-coverage figures and never adds
 * to them: the description says so, because a reader who took an inherited
 * route for coverage would stop looking at a requirement nobody has assessed.
 *
 * Requirements that DO have their own control are left out of the list even
 * when routes reach them — the direct figures above already account for them,
 * and listing them here would bury the requirements this panel is for.
 */

type MappingStrength = 'EQUAL' | 'SUPERSET' | 'SUBSET' | 'INTERSECT' | 'RELATED';

interface CoveringControl {
    id: string;
    code: string | null;
    name: string;
    status: string;
}

interface InheritedRoute {
    frameworkKey: string;
    frameworkName: string;
    requirementCode: string;
    requirementTitle: string;
    strength: MappingStrength;
    controls: CoveringControl[];
}

interface InheritedRequirement {
    code: string;
    title: string;
    section: string | null;
    status: 'DIRECT' | 'PARTIALLY_COVERED' | 'REVIEW_NEEDED' | 'NOT_COVERED' | string;
    routes: InheritedRoute[];
}

export interface InheritedCoveragePayload {
    framework: { key: string; name: string };
    total: number;
    summary: { direct: number; partiallyCovered: number; reviewNeeded: number; notCovered: number };
    sourceFrameworks: { key: string; name: string; requirements: number }[];
    requirements: InheritedRequirement[];
    truncated: boolean;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    PARTIALLY_COVERED: 'warning',
    REVIEW_NEEDED: 'info',
};

export function InheritedCoveragePanel({
    tenantSlug,
    frameworkKey,
}: {
    tenantSlug: string;
    frameworkKey: string;
}) {
    const t = useTranslations('frameworks');
    const { data, error, isLoading, mutate } = useTenantSWR<InheritedCoveragePayload>(
        `/frameworks/${encodeURIComponent(frameworkKey)}?action=inherited-coverage`,
    );

    if (error) {
        return (
            <ErrorState
                title={t('detail.inherited.errorTitle')}
                description={t('detail.inherited.errorLoad')}
                onRetry={() => void mutate()}
                retryLabel={t('detail.inherited.retry')}
            />
        );
    }
    // An absent report is not a report of nothing reached.
    if (isLoading || !data) return <SkeletonCard lines={4} />;

    const statusLabels: Record<string, string> = {
        PARTIALLY_COVERED: t('detail.inherited.statusPartial'),
        REVIEW_NEEDED: t('detail.inherited.statusReview'),
    };
    const strengthLabels: Record<MappingStrength, string> = {
        EQUAL: t('detail.inherited.strength.equal'),
        SUPERSET: t('detail.inherited.strength.superset'),
        SUBSET: t('detail.inherited.strength.subset'),
        INTERSECT: t('detail.inherited.strength.intersect'),
        RELATED: t('detail.inherited.strength.related'),
    };

    const open = data.requirements.filter((r) => r.status !== 'DIRECT');

    return (
        <Card density="compact" id="inherited-coverage-panel" data-testid="inherited-coverage-panel">
            <div className="space-y-default">
                <div className="space-y-tight">
                    <Heading level={3}>{t('detail.inherited.heading')}</Heading>
                    <p className="text-sm text-content-muted">{t('detail.inherited.description')}</p>
                </div>

                {data.truncated && (
                    <InlineNotice variant="warning" data-testid="inherited-coverage-truncated">
                        <p>{t('detail.inherited.truncated')}</p>
                    </InlineNotice>
                )}

                {open.length === 0 ? (
                    // Two different absences: nothing reached at all, and
                    // everything reached already has its own control.
                    data.requirements.length > 0 ? (
                        <InlineEmptyState title={t('detail.inherited.allDirect')} />
                    ) : (
                        <InlineEmptyState
                            title={t('detail.inherited.emptyTitle')}
                            description={t('detail.inherited.emptyDescription')}
                        />
                    )
                ) : (
                    <>
                        <div className="grid grid-cols-1 gap-compact sm:grid-cols-3">
                            <KPIStat
                                value={data.summary.partiallyCovered}
                                label={t('detail.inherited.countPartial')}
                            />
                            <KPIStat
                                value={data.summary.reviewNeeded}
                                label={t('detail.inherited.countReview')}
                            />
                            <KPIStat
                                value={data.summary.notCovered}
                                label={t('detail.inherited.countNone')}
                                tone={data.summary.notCovered > 0 ? 'attention' : 'default'}
                            />
                        </div>

                        {data.sourceFrameworks.length > 0 && (
                            <div className="flex flex-wrap items-center gap-compact text-xs" data-testid="inherited-coverage-sources">
                                <span className="text-content-subtle">{t('detail.inherited.reachedFrom')}</span>
                                {data.sourceFrameworks.map((s) => (
                                    <StatusBadge key={s.key} variant="neutral" size="sm" icon={null}>
                                        {t('detail.inherited.sourceCount', { name: s.name, count: s.requirements })}
                                    </StatusBadge>
                                ))}
                            </div>
                        )}

                        <ul className="space-y-compact" data-testid="inherited-coverage-list">
                            {open.map((requirement) => (
                                <li
                                    key={requirement.code}
                                    className="space-y-tight border-t border-border-subtle pt-3"
                                    data-testid={`inherited-requirement-${requirement.code}`}
                                >
                                    <div className="flex flex-wrap items-baseline gap-compact">
                                        <code className="font-mono text-xs text-content-subtle">{requirement.code}</code>
                                        <span className="text-sm text-content-default">{requirement.title}</span>
                                        <StatusBadge
                                            variant={STATUS_VARIANT[requirement.status] ?? 'neutral'}
                                            size="sm"
                                            icon={null}
                                        >
                                            {statusLabels[requirement.status] ?? requirement.status}
                                        </StatusBadge>
                                    </div>
                                    <ul className="space-y-tight pl-4">
                                        {requirement.routes.map((route) => (
                                            <li
                                                key={`${route.frameworkKey}:${route.requirementCode}`}
                                                className="space-y-tight"
                                            >
                                                <div className="flex flex-wrap items-baseline gap-compact text-xs">
                                                    <span className="text-content-default">{route.frameworkName}</span>
                                                    <code className="font-mono text-content-subtle">{route.requirementCode}</code>
                                                    <span className="text-content-muted">{route.requirementTitle}</span>
                                                    <StatusBadge variant="neutral" size="sm" icon={null}>
                                                        {strengthLabels[route.strength] ?? route.strength}
                                                    </StatusBadge>
                                                </div>
                                                <ul className="flex flex-wrap gap-compact text-xs">
                                                    {route.controls.map((control) => (
                                                        <li key={control.id}>
                                                            <Link
                                                                href={`/t/${tenantSlug}/controls/${control.id}`}
                                                                className={cn(textLinkVariants({ tone: 'link' }), 'truncate')}
                                                            >
                                                                {control.code ? `${control.code} · ${control.name}` : control.name}
                                                            </Link>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </li>
                                        ))}
                                    </ul>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </Card>
    );
}
