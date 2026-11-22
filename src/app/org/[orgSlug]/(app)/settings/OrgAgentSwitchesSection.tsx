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
 *
 * ═══ PER-TURN LIMITS (#4594) ═══
 *
 * The organization's CEILING of delegations and of tool calls one agent turn
 * may start, for every workspace under it; a workspace may only narrow it.
 * Two steppers, bounded by the database's ranges, each saving on its own and
 * sending only its key, as each switch does. Lowering a ceiling asks first,
 * naming the organization and how many workspaces it reaches, as turning a
 * switch off does; raising one saves at once. A member without the write key
 * sees the values read-only.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useOrgApiUrl, useOrgContext } from '@/lib/org-context-provider';
import type { AgentSwitch, DeploymentSwitch } from '@/lib/agentic/agent-switches';
import { TURN_CAP_KEYS, TURN_CAP_MAX, TURN_CAP_MIN, type TurnCapKey } from '@/lib/agentic/turn-caps';

export interface OrgAgentSwitchesPayload {
    agentProfiles: { organization: boolean; deployment: DeploymentSwitch };
    toolRunner: { organization: boolean; deployment: DeploymentSwitch };
    canManage: boolean;
    /** The organization's live workspaces: what a switch reaches. */
    workspaceCount: number;
}

/** The organization's per-turn ceilings, as `GET …/agent-turn-caps` returns them (#4594). */
export interface OrgAgentTurnCapsPayload {
    delegationsPerTurn: number;
    toolCallsPerTurn: number;
    canManage: boolean;
    /** The organization's live workspaces: what a ceiling reaches. */
    workspaceCount: number;
}

const ORDER: readonly AgentSwitch[] = ['agentProfiles', 'toolRunner'];

export function OrgAgentSwitchesSection({
    initial,
    turnCaps,
}: {
    initial: OrgAgentSwitchesPayload;
    turnCaps: OrgAgentTurnCapsPayload;
}) {
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

                <TurnCapsGroup initial={turnCaps} />
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

/**
 * "Per-turn limits": the organization's two ceilings (#4594). Each stepper
 * holds a draft; its Save sends that key alone. A draft below the stored value
 * asks first when the ceiling reaches a workspace.
 */
function TurnCapsGroup({ initial }: { initial: OrgAgentTurnCapsPayload }) {
    const t = useTranslations('org.settings.agentSwitches');
    const apiUrl = useOrgApiUrl();
    const { orgName } = useOrgContext();
    const [state, setState] = useState<OrgAgentTurnCapsPayload>(initial);
    const [draft, setDraft] = useState<Record<TurnCapKey, number>>({
        delegationsPerTurn: initial.delegationsPerTurn,
        toolCallsPerTurn: initial.toolCallsPerTurn,
    });
    const [busy, setBusy] = useState<TurnCapKey | null>(null);
    const [error, setError] = useState<{ key: TurnCapKey; message: string } | null>(null);
    const [saved, setSaved] = useState<TurnCapKey | null>(null);
    const [confirmingLower, setConfirmingLower] = useState<TurnCapKey | null>(null);

    /** Lowering asks first where it reaches a workspace; raising saves at once. */
    function request(key: TurnCapKey) {
        if (draft[key] < state[key] && state.workspaceCount > 0) {
            setConfirmingLower(key);
            return;
        }
        void save(key);
    }

    async function save(key: TurnCapKey) {
        setBusy(key);
        setError(null);
        setSaved(null);
        try {
            const res = await fetch(apiUrl('/agent-turn-caps'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: draft[key] }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError({ key, message: apiErrorMessage(body, t('saveFailed')) });
                return;
            }
            const next = (body as { turnCaps: OrgAgentTurnCapsPayload }).turnCaps;
            setState(next);
            // Only the saved key adopts the answer: the other stepper keeps its draft.
            setDraft((d) => ({ ...d, [key]: next[key] }));
            setSaved(key);
        } catch {
            setError({ key, message: t('saveFailed') });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="space-y-default" data-testid="org-turn-caps">
            <div>
                <Heading level={3} className="mb-1">{t('turnCaps.title')}</Heading>
                <p className="text-sm text-content-muted">{t('turnCaps.description')}</p>
            </div>
            <ul className="space-y-default">
                {TURN_CAP_KEYS.map((key) => {
                    const id = `org-turn-cap-${key}`;
                    const dirty = draft[key] !== state[key];
                    return (
                        <li key={key} className="rounded-lg border border-border-subtle p-3" data-testid={`${id}-row`}>
                            <FormField label={t(`turnCaps.${key}.label`)} description={t(`turnCaps.${key}.help`)}>
                                <div className="flex items-center gap-compact">
                                    <NumberStepper
                                        id={id}
                                        value={draft[key]}
                                        onChange={(v) => {
                                            setDraft((d) => ({ ...d, [key]: v }));
                                            setSaved(null);
                                        }}
                                        min={TURN_CAP_MIN[key]}
                                        max={TURN_CAP_MAX}
                                        disabled={!state.canManage || busy !== null}
                                        ariaLabel={t(`turnCaps.${key}.label`)}
                                        decrementAriaLabel={t('turnCaps.decrease')}
                                        incrementAriaLabel={t('turnCaps.increase')}
                                        className="max-w-xs"
                                        data-testid={id}
                                    />
                                    {state.canManage && (
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => request(key)}
                                            disabled={!dirty || busy !== null}
                                            loading={busy === key}
                                            data-testid={`${id}-save`}
                                            text={t('turnCaps.save')}
                                        />
                                    )}
                                </div>
                            </FormField>
                            {error?.key === key && (
                                <div className="mt-2">
                                    <InlineNotice variant="error" icon={null}>{error.message}</InlineNotice>
                                </div>
                            )}
                            {saved === key && error?.key !== key && (
                                <div className="mt-2">
                                    <InlineNotice variant="success" icon={null}>
                                        <span data-testid={`${id}-saved`}>{t('turnCaps.saved')}</span>
                                    </InlineNotice>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
            <ConfirmDialog
                showModal={confirmingLower !== null}
                setShowModal={(open) => {
                    if (!open) setConfirmingLower(null);
                }}
                tone="warning"
                title={confirmingLower ? t(`turnCaps.confirmLower.${confirmingLower}.title`) : ''}
                description={
                    confirmingLower
                        ? t('turnCaps.confirmLower.body', {
                              org: orgName,
                              count: state.workspaceCount,
                              from: state[confirmingLower],
                              to: draft[confirmingLower],
                          })
                        : undefined
                }
                confirmLabel={t('turnCaps.confirmLower.confirm')}
                onConfirm={async () => {
                    if (confirmingLower) await save(confirmingLower);
                }}
                onCancel={() => setConfirmingLower(null)}
            />
        </div>
    );
}
