'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiRefusalMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { AgentOversightKey, AgentOversightSettings } from '@/app-layer/usecases/agent-oversight-settings';

/**
 * The OWNER's agent oversight switches (round 15: #4895, #4900, #4896–#4898).
 *
 * Rendered inside the page's `admin.tenant_lifecycle` gate, and the route
 * behind it asks the same key, so a viewer who sees a button can press it.
 * Each button sends only the switch it moves, so two owners changing different
 * switches do not overwrite each other.
 */
const GROUPS: ReadonlyArray<{ id: 'groupApprovals' | 'groupAuditors'; keys: readonly AgentOversightKey[] }> = [
    { id: 'groupApprovals', keys: ['composeNeedsSecondApprover', 'exactParameterEditNeedsSecondApprover'] },
    { id: 'groupAuditors', keys: ['auditorReadsDecisionLog', 'auditorReadsReceipts', 'auditorReadsQuarantine'] },
];

export function AgentOversightSection() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const [saving, setSaving] = useState<AgentOversightKey | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const { data, error, isLoading, mutate } = useTenantSWR<{ settings: AgentOversightSettings }>(
        '/admin/agent-oversight',
    );

    async function change(key: AgentOversightKey, next: boolean) {
        setSaving(key);
        setFailed(null);
        try {
            const res = await fetch(apiUrl('/admin/agent-oversight'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: next }),
            });
            if (!res.ok) {
                const body: unknown = res.status >= 500 ? null : await res.json().catch(() => null);
                setFailed(apiRefusalMessage(body, t('agentOversight.saveFailedBody')));
                return;
            }
            await mutate();
        } catch {
            setFailed(t('agentOversight.saveFailedBody'));
        } finally {
            setSaving(null);
        }
    }

    return (
        <section className="space-y-default" data-testid="admin-agent-oversight">
            <div className="space-y-tight">
                <Heading level={2}>{t('agentOversight.heading')}</Heading>
                <p className="max-w-3xl text-sm text-content-muted">{t('agentOversight.intro')}</p>
            </div>

            {failed && (
                <InlineNotice variant="error" title={t('agentOversight.saveFailedHeading')}>
                    <span data-testid="agent-oversight-save-failed">{failed}</span>
                </InlineNotice>
            )}

            {error ? (
                <ErrorState
                    title={t('agentOversight.loadFailed')}
                    onRetry={() => {
                        void mutate();
                    }}
                />
            ) : (
                GROUPS.map((group) => (
                    <div key={group.id} className="space-y-compact">
                        <Heading level={3}>{t(`agentOversight.${group.id}`)}</Heading>
                        {group.keys.map((key) => {
                            const on = data?.settings[key];
                            return (
                                <div
                                    key={key}
                                    className="flex items-start justify-between gap-default rounded-lg border border-border-subtle p-5"
                                    data-testid={`agent-oversight-${key}`}
                                >
                                    <div className="space-y-tight">
                                        <div className="flex flex-wrap items-center gap-tight">
                                            <span className="text-sm font-medium text-content-emphasis">
                                                {t(`agentOversight.setting.${key}.name`)}
                                            </span>
                                            {on !== undefined && (
                                                <StatusBadge variant={on ? 'success' : 'neutral'}>
                                                    {on ? t('agentOversight.on') : t('agentOversight.off')}
                                                </StatusBadge>
                                            )}
                                        </div>
                                        <p className="max-w-3xl text-sm text-content-muted">
                                            {t(`agentOversight.setting.${key}.description`)}
                                        </p>
                                    </div>
                                    <Button
                                        variant="secondary"
                                        onClick={() => void change(key, !on)}
                                        disabled={isLoading || on === undefined || saving !== null}
                                        data-testid={`agent-oversight-toggle-${key}`}
                                    >
                                        {on ? t('agentOversight.turnOff') : t('agentOversight.turnOn')}
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                ))
            )}
        </section>
    );
}
