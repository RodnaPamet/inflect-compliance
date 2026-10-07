import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { formatDateTime } from '@inflect/ui/lib/format-date';
import { getTenantCtx } from '@/app-layer/context';
import { runInTenantContext } from '@/lib/db-context';
import { DashboardRepository } from '@/app-layer/repositories/DashboardRepository';
import {
    activityEntityMeta,
    activityVerbToken,
    humanizeSnakeCase,
} from '@/lib/audit/activity-humanize';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';

interface RecentActivityCardProps {
    tenantSlug: string;
    label: string;
    noActivityLabel: string;
}

/**
 * Async server component that independently fetches and renders recent
 * activity. Designed to be wrapped in <Suspense> so the rest of the
 * dashboard streams immediately while this potentially slower query
 * completes.
 *
 * Each row is humanised (localized verb + entity noun instead of raw
 * lowercased enums), identified (the changed entity's resolved title),
 * and linked to the changed item when it has a navigable surface.
 */
export default async function RecentActivityCard({
    tenantSlug,
    label,
    noActivityLabel,
}: RecentActivityCardProps) {
    const ctx = await getTenantCtx({ tenantSlug });
    const t = await getTranslations('dashboard.activity');

    const recentActivity = await runInTenantContext(ctx, async (db) => {
        return DashboardRepository.getRecentActivityDetailed(db, ctx);
    });

    return (
        <Card>
            <Heading level={3} className="mb-3" id="recent-activity-heading">
                {label}
            </Heading>
            {/*
              tabIndex=0 + role=region + aria-labelledby satisfies axe's
              `scrollable-region-focusable` rule (WCAG 2.1.1 Keyboard).
              Without these, keyboard-only users cannot scroll the
              activity list — the rule is "serious" because the
              content is hidden behind the overflow.
            */}
            <div
                className="space-y-tight max-h-40 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded"
                tabIndex={0}
                role="region"
                aria-labelledby="recent-activity-heading"
            >
                {recentActivity.map((log) => {
                    const meta = activityEntityMeta(log.entity);
                    const verb = activityVerbToken(log.action);
                    const verbText = verb.token
                        ? t(`verb.${verb.token}`)
                        : verb.fallback;
                    const nounText = meta
                        ? t(`entity.${meta.nounKey}`)
                        : humanizeSnakeCase(log.entity);
                    const href =
                        meta?.path && log.entityId
                            ? `/t/${tenantSlug}${meta.path(log.entityId)}`
                            : null;

                    // The identifying text: the resolved title when we
                    // have one, otherwise the noun stands in as the
                    // link target. `linkPart` is what carries the href.
                    const linkPart = log.title ?? nounText;
                    const body = (
                        <>
                            <span className="text-content-default font-medium">
                                {log.actorName ?? t('systemActor')}
                            </span>{' '}
                            {verbText} {log.title ? nounText + ' ' : ''}
                            <span
                                className={
                                    href
                                        ? 'text-content-link hover:underline'
                                        : 'text-content-default'
                                }
                            >
                                {log.title ? `“${linkPart}”` : linkPart}
                            </span>
                        </>
                    );

                    return (
                        <div
                            key={log.id}
                            className="flex flex-col sm:flex-row items-start gap-1 sm:gap-tight text-xs"
                        >
                            <span className="text-content-subtle whitespace-nowrap">
                                {formatDateTime(log.createdAt)}
                            </span>
                            {href ? (
                                <Link
                                    href={href}
                                    className="text-content-muted rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                                >
                                    {body}
                                </Link>
                            ) : (
                                <span className="text-content-muted">{body}</span>
                            )}
                        </div>
                    );
                })}
                {recentActivity.length === 0 && (
                    <p className="text-content-subtle text-xs">{noActivityLabel}</p>
                )}
            </div>
        </Card>
    );
}
