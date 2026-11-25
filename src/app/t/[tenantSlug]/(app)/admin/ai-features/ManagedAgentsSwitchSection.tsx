'use client';

/**
 * "Managed Agents engine": the workspace's own switch for the engine (#5964,
 * owner decisions 2026-11-25), above "Agent engines".
 *
 * ═══ WHO SEES WHAT ═══
 *
 * Every admin reads it (`GET /admin/managed-agents` is `admin.view`); only an
 * owner changes it (`PUT` is `admin.tenant_lifecycle`, and the usecase also
 * refuses an API key, an agent and a job). An admin sees the state and one
 * sentence naming who can change it, never a control that would 403.
 *
 * ═══ WHEN THE OPERATOR DECIDES INSTEAD ═══
 *
 * With `AGENT_MANAGED_AGENTS` set, the deployment decides for every workspace
 * and the toggle is not read. The section then shows the effective state, says
 * the operator decided, and disables the button: pressing it would change a
 * stored choice and nothing that runs, which is the trap #3909 named.
 *
 * Off stops new runs and hides the Anthropic workspace card; the connection,
 * the engine choice and what is already in the customer's Anthropic workspace
 * are kept. The description says so.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { SettingRow } from '@/components/layout/SettingRow';
import { apiRefusalMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { usePermissions, useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { DeploymentSwitch, WorkspaceAgentSwitchBasis } from '@/lib/agentic/agent-switches';

/** The response of `GET /api/t/{slug}/admin/managed-agents`. */
export interface ManagedAgentsSwitchPayload {
    setting: {
        enabled: boolean;
        deployment: DeploymentSwitch;
        effective: { on: boolean; basis: WorkspaceAgentSwitchBasis };
    };
}

/** Which control a viewer gets. */
export type ManagedAgentsSwitchControl = 'read-only' | 'operator-decides' | 'editable';

export function managedAgentsSwitchControl(
    setting: ManagedAgentsSwitchPayload['setting'],
    canChange: boolean,
): ManagedAgentsSwitchControl {
    if (!canChange) return 'read-only';
    // The toggle is read only while the variable is unset.
    if (setting.deployment !== 'UNSET') return 'operator-decides';
    return 'editable';
}

export function ManagedAgentsSwitchSection() {
    const t = useTranslations('admin.managedAgentsSwitch');
    const apiUrl = useTenantApiUrl();
    const canChange = usePermissions().admin.tenant_lifecycle;
    const { mutate: swrMutate } = useSWRConfig();
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const { data, error, isLoading, mutate } = useTenantSWR<ManagedAgentsSwitchPayload>('/admin/managed-agents');

    if (error && !data) {
        return (
            <section id="managed-agents" data-testid="managed-agents-switch">
                <ErrorState title={t('loadFailed')} onRetry={() => { void mutate(); }} />
            </section>
        );
    }
    const setting = data?.setting;
    if (!setting) return null;

    const control = managedAgentsSwitchControl(setting, canChange);
    const on = setting.effective.on;

    async function change(next: boolean) {
        setSaving(true);
        setFailed(null);
        try {
            const res = await fetch(apiUrl('/admin/managed-agents'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            if (!res.ok) {
                const body: unknown = res.status >= 500 ? null : await res.json().catch(() => null);
                setFailed(apiRefusalMessage(body, t('saveFailedBody')));
                return;
            }
            // The engines section below reads the same switch through the
            // engine gate: refresh it too, by its resolved key.
            await Promise.all([mutate(), swrMutate(apiUrl('/admin/agent-driver'))]).catch(() => undefined);
        } catch {
            setFailed(t('saveFailedBody'));
        } finally {
            setSaving(false);
        }
    }

    return (
        <section id="managed-agents" data-testid="managed-agents-switch" data-control={control} data-basis={setting.effective.basis}>
            <Card className="space-y-default p-6">
                <SettingRow
                    title={<Heading level={2}>{t('heading')}</Heading>}
                    titleAdornment={
                        <StatusBadge variant={on ? 'success' : 'neutral'}>
                            <span data-testid="managed-agents-switch-state">{on ? t('on') : t('off')}</span>
                        </StatusBadge>
                    }
                    description={t('description')}
                    control={
                        control === 'read-only' ? null : (
                            <Button
                                variant="secondary"
                                onClick={() => void change(!setting.enabled)}
                                disabled={isLoading || saving || control === 'operator-decides'}
                                data-testid="managed-agents-switch-toggle"
                            >
                                {setting.enabled ? t('turnOff') : t('turnOn')}
                            </Button>
                        )
                    }
                />

                {failed && (
                    <InlineNotice variant="error" title={t('saveFailedHeading')}>
                        <span data-testid="managed-agents-switch-save-failed">{failed}</span>
                    </InlineNotice>
                )}

                {/* The operator decides for every workspace: say so, and what
                    the stored choice will do once they stop. */}
                {setting.deployment !== 'UNSET' && (
                    <InlineNotice variant="info">
                        <span data-testid="managed-agents-switch-operator" className="block">
                            {t(setting.deployment === 'ON' ? 'operatorOn' : 'operatorOff')}
                        </span>
                        {control !== 'read-only' && (
                            <span data-testid="managed-agents-switch-stored" className="mt-1 block">
                                {t(setting.enabled ? 'storedOn' : 'storedOff')}
                            </span>
                        )}
                    </InlineNotice>
                )}

                {control === 'read-only' && (
                    <p className="text-sm text-content-muted" data-testid="managed-agents-switch-owner-only">
                        {t('ownerOnly')}
                    </p>
                )}
            </Card>
        </section>
    );
}
