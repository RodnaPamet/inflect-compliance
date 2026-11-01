'use client';

/**
 * "Agent features": the organization's two agent switches (#4557).
 *
 * ═══ A SWITCH THAT SAYS WHEN IT IS OVERRIDDEN ═══
 *
 * The organization decides only what the deployment leaves open. When the
 * deployment's variable is set, every workspace follows it, so the section
 * shows that state beside the switch: "On for every workspace" or "Off for
 * every workspace", and that the organization's choice applies once the
 * deployment leaves it open. The switch stays usable, so an admin can prepare
 * the choice, and the sentence says it changes nothing today.
 *
 * Each switch saves on its own, sending only its key: the PUT is a patch, and
 * one switch's failure must not look like the other's.
 *
 * ═══ TURNING ONE OFF ASKS FIRST (#4850) ═══
 *
 * Off reaches every workspace in the organization at once: the Behaviour tab
 * leaves every agent, and profile runs are refused. So turning a switch off
 * opens a confirmation that names the organization and how many workspaces it
 * reaches, from the server's own count. It is skipped where it would change
 * nothing: while the deployment overrides the switch, or when the
 * organization has no workspace yet. Turning one on saves at once.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useOrgApiUrl, useOrgContext } from '@/lib/org-context-provider';
import type { AgentSwitch, DeploymentSwitch } from '@/lib/agentic/agent-switches';

export interface OrgAgentSwitchesPayload {
    agentProfiles: { organization: boolean; deployment: DeploymentSwitch };
    toolRunner: { organization: boolean; deployment: DeploymentSwitch };
    canManage: boolean;
    /** The organization's live workspaces: what a switch reaches. */
    workspaceCount: number;
}

const ORDER: readonly AgentSwitch[] = ['agentProfiles', 'toolRunner'];

export function OrgAgentSwitchesSection({ initial }: { initial: OrgAgentSwitchesPayload }) {
    const t = useTranslations('org.settings.agentSwitches');
    const apiUrl = useOrgApiUrl();
    const { orgName } = useOrgContext();
    const [state, setState] = useState<OrgAgentSwitchesPayload>(initial);
    const [busy, setBusy] = useState<AgentSwitch | null>(null);
    const [error, setError] = useState<{ key: AgentSwitch; message: string } | null>(null);
    const [confirmingOff, setConfirmingOff] = useState<AgentSwitch | null>(null);

    /** Off asks first where it reaches a workspace; everything else saves at once. */
    function request(key: AgentSwitch, next: boolean) {
        const reachesWorkspaces = state[key].deployment === 'UNSET' && state.workspaceCount > 0;
        if (!next && reachesWorkspaces) {
            setConfirmingOff(key);
            return;
        }
        void flip(key, next);
    }

    async function flip(key: AgentSwitch, next: boolean) {
        setBusy(key);
        setError(null);
        try {
            const res = await fetch(apiUrl('/agent-switches'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: next }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError({ key, message: apiErrorMessage(body, t('saveFailed')) });
                return;
            }
            setState((body as { switches: OrgAgentSwitchesPayload }).switches);
        } catch {
            setError({ key, message: t('saveFailed') });
        } finally {
            setBusy(null);
        }
    }

    return (
        <Card data-testid="org-agent-switches">
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('title')}</Heading>
                    <p className="text-sm text-content-muted">{t('description')}</p>
                </div>

                {!state.canManage && (
                    <InlineNotice variant="info" icon={null}>
                        <span data-testid="org-agent-switches-read-only">{t('readOnly')}</span>
                    </InlineNotice>
                )}

                <ul className="space-y-default">
                    {ORDER.map((key) => {
                        const s = state[key];
                        const id = `org-agent-switch-${key}`;
                        const overridden = s.deployment !== 'UNSET';
                        return (
                            <li
                                key={key}
                                className="rounded-lg border border-border-subtle p-3"
                                data-testid={`${id}-row`}
                                data-deployment={s.deployment}
                            >
                                <div className="flex items-center gap-compact">
                                    <Switch
                                        id={id}
                                        checked={s.organization}
                                        disabled={!state.canManage || busy !== null}
                                        onCheckedChange={(on) => request(key, on)}
                                        aria-describedby={`${id}-help`}
                                        data-testid={id}
                                    />
                                    <Label htmlFor={id} className="font-medium text-content-emphasis">
                                        {t(`${key}.label`)}
                                    </Label>
                                    {overridden && (
                                        <span className="ml-auto">
                                            <StatusBadge variant="neutral" size="sm">
                                                {t(s.deployment === 'ON' ? 'deploymentOnBadge' : 'deploymentOffBadge')}
                                            </StatusBadge>
                                        </span>
                                    )}
                                </div>
                                <p id={`${id}-help`} className="mt-1 text-xs text-content-muted">
                                    {t(`${key}.help`)}
                                </p>
                                {overridden && (
                                    <p className="mt-1 text-xs text-content-default" data-testid={`${id}-overridden`}>
                                        {t(s.deployment === 'ON' ? 'deploymentOn' : 'deploymentOff')}
                                    </p>
                                )}
                                {error?.key === key && (
                                    <div className="mt-2">
                                        <InlineNotice variant="error" icon={null}>{error.message}</InlineNotice>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>
            <ConfirmDialog
                showModal={confirmingOff !== null}
                setShowModal={(open) => {
                    if (!open) setConfirmingOff(null);
                }}
                tone="warning"
                title={confirmingOff ? t(`confirmOff.${confirmingOff}.title`) : ''}
                description={
                    confirmingOff
                        ? t(`confirmOff.${confirmingOff}.body`, { org: orgName, count: state.workspaceCount })
                        : undefined
                }
                confirmLabel={t('confirmOff.confirm')}
                onConfirm={async () => {
                    if (confirmingOff) await flip(confirmingOff, false);
                }}
                onCancel={() => setConfirmingOff(null)}
            />
        </Card>
    );
}
