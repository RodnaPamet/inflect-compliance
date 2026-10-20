'use client';

/**
 * WHICH ENTRA SERVICE PRINCIPAL IS THIS AGENT'S OWN (#3807, the card for step
 * 2c's `/admin/agents/:agentId/service-principal-link`).
 *
 * When the owner-orphan pass contains an agent at AUTOMATIC it asks for the
 * agent's service principal to be disabled, and the link it acts on is the
 * harness scanner's. Owner decision, 2026-10-18: a person confirms that link
 * before any unattended disable. The route had no page, so the confirmation
 * was a console command; this card makes the same POST and adds no authority.
 *
 * THE CARD CONFIRMS THE SCANNER'S LINK AND NEVER MAKES ONE. It offers a
 * confirmation only when a scan links exactly one principal to this agent,
 * which is the usecase's own `confirmable`, and the usecase still refuses
 * anything else. A link a later scan moves invalidates its confirmation; the
 * history shows those, with why, because a confirmation that quietly stopped
 * counting is how an AUTOMATIC disable is refused with nobody knowing why.
 *
 * Confirming is deliberate, so it goes through a confirmation that says what
 * it permits. There is no undo: the record is one-way, by a trigger.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { AgentTabProps } from './types';

interface Confirmation {
    discoveredAgentId: string;
    discoveredId: string;
    confirmedAt: string;
    invalidatedAt: string | null;
    invalidatedReason: string | null;
}

interface LinkState {
    agentId: string;
    links: {
        discoveredAgentId: string;
        servicePrincipalId: string | null;
        lastSeenAt: string;
        confirmation: Confirmation | null;
    }[];
    confirmable: boolean;
    confirmations: Confirmation[];
}

export function ServicePrincipalLinkCard({ agentId, refreshToken }: AgentTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const { data, error, isLoading, mutate } = useTenantSWR<LinkState>(
        `/admin/agents/${agentId}/service-principal-link`,
    );
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [confirming, setConfirming] = useState<LinkState['links'][number] | null>(null);
    const [confirmError, setConfirmError] = useState<string | null>(null);

    if (isLoading && !data) return <SkeletonCard lines={3} />;

    const confirm = async () => {
        if (!confirming) return;
        setConfirmError(null);
        let message: string | null = null;
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}/service-principal-link`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ discoveredAgentId: confirming.discoveredAgentId }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                message = apiErrorMessage(body, t('agentDetail.spLink.confirmFailed'));
            }
        } catch {
            message = t('agentDetail.spLink.confirmFailed');
        }
        if (message !== null) {
            setConfirmError(message);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(message);
        }
        toast.success(t('agentDetail.spLink.confirmed'));
        setConfirming(null);
        await mutate();
    };

    const history = (data?.confirmations ?? []).filter((c) => c.invalidatedAt !== null);

    return (
        <Card as="section" className="space-y-default" data-testid="agent-sp-link">
            <Heading level={2}>{t('agentDetail.spLink.heading')}</Heading>
            <p className="text-sm text-content-muted">{t('agentDetail.spLink.intro')}</p>

            {error || !data ? (
                <InlineNotice variant="error">{t('agentDetail.spLink.loadError')}</InlineNotice>
            ) : data.links.length === 0 ? (
                <InlineNotice variant="info" icon={null} data-testid="agent-sp-link-none">
                    {t('agentDetail.spLink.none')}
                </InlineNotice>
            ) : (
                <>
                    {!data.confirmable && (
                        <InlineNotice variant="warning" data-testid="agent-sp-link-ambiguous">
                            {t('agentDetail.spLink.ambiguous', { count: data.links.length })}
                        </InlineNotice>
                    )}
                    <ul className="space-y-compact">
                        {data.links.map((l) => (
                            <li
                                key={l.discoveredAgentId}
                                className="flex flex-wrap items-center gap-compact text-sm"
                                data-testid={`agent-sp-link-${l.discoveredAgentId}`}
                            >
                                <span className="font-mono text-content-emphasis">
                                    {l.servicePrincipalId ?? t('agentDetail.spLink.unreadableId')}
                                </span>
                                <span className="text-xs text-content-muted">
                                    {t('agentDetail.spLink.lastSeen', { at: formatDateTime(l.lastSeenAt) })}
                                </span>
                                {l.confirmation ? (
                                    <StatusBadge variant="success" size="sm">
                                        {t('agentDetail.spLink.confirmedOn', {
                                            at: formatDateTime(l.confirmation.confirmedAt),
                                        })}
                                    </StatusBadge>
                                ) : (
                                    <>
                                        <StatusBadge variant="warning" size="sm">
                                            {t('agentDetail.spLink.unconfirmed')}
                                        </StatusBadge>
                                        {data.confirmable && (
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => {
                                                    setConfirmError(null);
                                                    setConfirming(l);
                                                }}
                                                data-testid={`agent-sp-link-confirm-${l.discoveredAgentId}`}
                                            >
                                                {t('agentDetail.spLink.confirm')}
                                            </Button>
                                        )}
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                </>
            )}

            {history.length > 0 && (
                <div className="space-y-tight" data-testid="agent-sp-link-history">
                    <p className="text-xs font-medium text-content-muted">{t('agentDetail.spLink.historyHeading')}</p>
                    <ul className="space-y-tight text-xs text-content-muted">
                        {history.map((c) => (
                            <li key={`${c.discoveredAgentId}-${c.confirmedAt}`}>
                                {t('agentDetail.spLink.historyLine', {
                                    confirmed: formatDateTime(c.confirmedAt),
                                    invalidated: formatDateTime(c.invalidatedAt as string),
                                    reason: t(`agentDetail.spLink.invalidated.${c.invalidatedReason ?? 'UNKNOWN'}`),
                                })}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <ConfirmDialog
                showModal={confirming !== null}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(confirming !== null) : open;
                    if (!next) setConfirming(null);
                }}
                tone="warning"
                title={t('agentDetail.spLink.confirmTitle')}
                description={
                    <>
                        {t('agentDetail.spLink.confirmBody', {
                            principal: confirming?.servicePrincipalId ?? '',
                        })}
                        {confirmError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="agent-sp-link-confirm-error">
                                {confirmError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('agentDetail.spLink.confirmAction')}
                cancelLabel={t('agentDetail.spLink.cancel')}
                onConfirm={confirm}
            />
        </Card>
    );
}
