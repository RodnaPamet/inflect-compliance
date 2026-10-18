'use client';

/**
 * Shortfall acceptances still on the clock — unrevoked and not yet handled by
 * the expiry monitor, one per agent (its latest expiry). The same population
 * the compliance calendar projects, so each row's anchor is the target of a
 * calendar deep-link: `#harness-acceptance-<discoveredAgentId>`.
 *
 * The expiry is on every row. What is NOT here is the justification or who
 * accepted: the tab reads neither. The renew (or, once lapsed, accept) action
 * is the owner's alone, by the same server-computed affordance the matrix
 * row uses.
 */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { AcceptanceRow, HarnessMatrixView } from '@/lib/agentic/harness-read-model';

export function AcceptancesCard({
    acceptances,
    onAccept,
}: {
    acceptances: HarnessMatrixView['acceptances'];
    onAccept: (row: AcceptanceRow) => void;
}) {
    const t = useTranslations('agents');

    return (
        <Card data-testid="harness-acceptances" className="space-y-default">
            <Heading level={2}>{t('harness.acceptancesHeading')}</Heading>
            <p className="text-sm text-content-muted">{t('harness.acceptancesIntro')}</p>
            {acceptances.rows.length === 0 ? (
                <p className="text-sm text-content-muted" data-testid="harness-acceptances-empty">
                    {t('harness.acceptancesEmpty')}
                </p>
            ) : (
                <ul className="space-y-compact text-sm">
                    {acceptances.rows.map((a) => (
                        <li
                            key={a.id}
                            id={`harness-acceptance-${a.discoveredAgentId}`}
                            data-testid={`harness-acceptance-row-${a.discoveredAgentId}`}
                            className="flex flex-wrap items-center gap-compact"
                        >
                            <span className="font-medium text-content-emphasis">{a.agentLabel}</span>
                            <span data-testid={`harness-acceptance-row-expiry-${a.discoveredAgentId}`}>
                                {t('harness.acceptanceLine', {
                                    level: t(`harness.level.${a.acceptedLevel}`),
                                    date: formatDate(a.expiresAt),
                                })}
                            </span>
                            <StatusBadge variant={a.inForce ? 'info' : 'warning'} size="sm">
                                {a.inForce ? t('harness.acceptanceInForce') : t('harness.acceptanceLapsed')}
                            </StatusBadge>
                            {(a.acceptAffordance === 'ACCEPT' || a.acceptAffordance === 'RENEW') && (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => onAccept(a)}
                                    data-testid={`harness-acceptance-renew-${a.discoveredAgentId}`}
                                >
                                    {a.acceptAffordance === 'RENEW' ? t('harness.renew') : t('harness.accept')}
                                </Button>
                            )}
                            {(a.acceptAffordance === 'OWNER_ONLY' || a.acceptAffordance === 'REGISTER_FIRST') && (
                                <span
                                    className="text-xs text-content-muted"
                                    data-testid={`harness-acceptance-note-${a.discoveredAgentId}`}
                                >
                                    {a.acceptAffordance === 'OWNER_ONLY' ? t('harness.ownerOnly') : t('harness.registerFirst')}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {acceptances.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-acceptances-truncated">
                    {t('harness.acceptancesTruncated', { count: acceptances.rows.length })}
                </InlineNotice>
            )}
        </Card>
    );
}
