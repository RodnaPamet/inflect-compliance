'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { SettingRow } from '@/components/layout/SettingRow';
import { ShadedRow } from '@/components/ui/shaded-row';
import { apiRefusalMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { HostedManagedAgentsSetting } from '@/app-layer/usecases/hosted-managed-agents-opt-in';

/**
 * The OWNER's opt-in to agents hosted in Inflect's own Anthropic organisation
 * (Step 6b of `docs/claude-managed-agents-design.md`, shape MA-C1).
 *
 * Rendered inside the page's `admin.tenant_lifecycle` gate, as the route
 * behind it is. It renders NOTHING while the deployment does not offer hosting
 * and the workspace has not opted in: the source constant
 * `HOSTED_MANAGED_AGENTS_ACTIVE` is false until Step 6c, so today no workspace
 * sees it. A workspace that opted in always sees the section, so it can opt
 * out. The terms below say, in plain words, what the design says hosting
 * stores, where and for how long.
 */
export function HostedAgentsSection() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const { data, error, isLoading, mutate } = useTenantSWR<{ setting: HostedManagedAgentsSetting }>(
        '/admin/hosted-managed-agents',
    );
    const setting = data?.setting;

    if (error) {
        return (
            <ErrorState
                title={t('hostedAgents.loadFailed')}
                onRetry={() => {
                    void mutate();
                }}
            />
        );
    }
    if (!setting || (!setting.offered && !setting.optedIn)) return null;

    async function change(next: boolean) {
        setSaving(true);
        setFailed(null);
        try {
            const res = await fetch(apiUrl('/admin/hosted-managed-agents'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ optIn: next }),
            });
            if (!res.ok) {
                const body: unknown = res.status >= 500 ? null : await res.json().catch(() => null);
                setFailed(apiRefusalMessage(body, t('hostedAgents.saveFailedBody')));
                return;
            }
            await mutate();
        } catch {
            setFailed(t('hostedAgents.saveFailedBody'));
        } finally {
            setSaving(false);
        }
    }

    // Why an opt-in would not run hosted today, in the resolution's order.
    const notice = !setting.offered
        ? 'notOffered'
        : setting.workspace === 'CONNECTED' || setting.workspace === 'AMBIGUOUS'
          ? 'ownWorkspace'
          : setting.residency === 'LOCAL_ONLY'
            ? 'localOnly'
            : !setting.entitled
              ? 'notEntitled'
              : setting.workspace === 'HOSTED'
                ? 'inEffect'
                : null;
    const mayOptIn = setting.offered && setting.entitled && setting.residency !== 'LOCAL_ONLY';

    return (
        <section className="space-y-default" data-testid="admin-hosted-agents">
            <div className="space-y-tight">
                <Heading level={2}>{t('hostedAgents.heading')}</Heading>
                <p className="max-w-3xl text-sm text-content-muted">{t('hostedAgents.intro')}</p>
            </div>

            <div className="space-y-compact">
                <Heading level={3}>{t('hostedAgents.termsHeading')}</Heading>
                <ul className="max-w-3xl list-disc space-y-tight pl-5 text-sm text-content-default" data-testid="hosted-agents-terms">
                    <li>{t('hostedAgents.termConversation')}</li>
                    <li>{t('hostedAgents.termAgents')}</li>
                    <li>{t('hostedAgents.termOwnWorkspace')}</li>
                    <li>{t('hostedAgents.termOptOut')}</li>
                </ul>
            </div>

            {failed && (
                <InlineNotice variant="error" title={t('hostedAgents.saveFailedHeading')}>
                    <span data-testid="hosted-agents-save-failed">{failed}</span>
                </InlineNotice>
            )}

            {notice && (
                <InlineNotice variant={notice === 'inEffect' ? 'success' : 'info'}>
                    <span data-testid={`hosted-agents-notice-${notice}`}>{t(`hostedAgents.${notice}`)}</span>
                </InlineNotice>
            )}

            <ShadedRow padding="xl" data-testid="hosted-agents-opt-in">
                <SettingRow
                    title={<span className="text-sm font-medium text-content-emphasis">{t('hostedAgents.heading')}</span>}
                    titleAdornment={
                        <StatusBadge variant={setting.optedIn ? 'success' : 'neutral'}>
                            {setting.optedIn ? t('hostedAgents.optedIn') : t('hostedAgents.notOptedIn')}
                        </StatusBadge>
                    }
                    control={
                        <Button
                            variant="secondary"
                            onClick={() => void change(!setting.optedIn)}
                            disabled={isLoading || saving || (!setting.optedIn && !mayOptIn)}
                            data-testid="hosted-agents-toggle"
                        >
                            {setting.optedIn ? t('hostedAgents.optOut') : t('hostedAgents.optIn')}
                        </Button>
                    }
                />
            </ShadedRow>
        </section>
    );
}
