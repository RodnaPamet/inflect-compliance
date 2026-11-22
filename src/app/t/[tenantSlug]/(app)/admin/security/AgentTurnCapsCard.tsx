'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { NumberStepper } from '@/components/ui/number-stepper';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { TURN_CAP_KEYS, TURN_CAP_MIN, type TurnCapKey, type TurnCaps } from '@/lib/agentic/turn-caps';

/**
 * AGENT PER-TURN LIMITS — this workspace's narrowing of the two caps its
 * organization sets (#4594, owner decision 3 of 2026-11-13).
 *
 * The organization holds the CEILING; this workspace may only lower it, and
 * the value that applies is the lower of the two. So each cap offers two named
 * choices, as the rotation-age card does: follow the organization (NULL), or a
 * lower limit, with the stepper bounded by the ceiling. A value above the
 * ceiling cannot be typed here, and the server refuses it anyway
 * (`TURN_CAP_ABOVE_ORGANIZATION_CEILING`).
 *
 * THE VALUE THAT APPLIES IS SHOWN BESIDE THE STORED ONE. When an organization
 * lowers its ceiling below a value this workspace stored, the stored value is
 * kept and the ceiling applies; the card says "narrowed by your organization"
 * rather than show a number that changes nothing.
 *
 * Each cap saves on its own and sends only its key.
 */

type Mode = 'follow' | 'custom';

const COLUMN: Readonly<Record<TurnCapKey, 'agentMaxSubagentsPerTurn' | 'agentMaxToolCallsPerTurn'>> = {
    delegationsPerTurn: 'agentMaxSubagentsPerTurn',
    toolCallsPerTurn: 'agentMaxToolCallsPerTurn',
};

type Payload = {
    agentMaxSubagentsPerTurn?: number | null;
    agentMaxToolCallsPerTurn?: number | null;
    turnCaps?: TurnCaps;
};

export function AgentTurnCapsCard() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const [loaded, setLoaded] = useState<Payload | null>(null);
    const [unavailable, setUnavailable] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/security-settings'));
            if (!res.ok) { setUnavailable(true); return; }
            const body = (await res.json()) as Payload;
            if (!body.turnCaps) { setUnavailable(true); return; }
            setLoaded(body);
        } catch {
            setUnavailable(true);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    if (unavailable) {
        return (
            <Card data-testid="agent-turn-caps-card">
                <Heading level={2} className="mb-1">{t('security.agentTurnCaps.title')}</Heading>
                <p className="text-sm text-content-muted">{t('security.agentTurnCaps.unavailable')}</p>
            </Card>
        );
    }
    if (!loaded?.turnCaps) return null;

    return (
        <Card data-testid="agent-turn-caps-card">
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('security.agentTurnCaps.title')}</Heading>
                    <p className="text-sm text-content-muted">{t('security.agentTurnCaps.description')}</p>
                </div>
                {TURN_CAP_KEYS.map((key) => (
                    <TurnCapRow
                        key={key}
                        capKey={key}
                        caps={loaded.turnCaps as TurnCaps}
                        onSaved={(next) => setLoaded(next)}
                    />
                ))}
            </div>
        </Card>
    );
}

function TurnCapRow({
    capKey,
    caps,
    onSaved,
}: {
    capKey: TurnCapKey;
    caps: TurnCaps;
    onSaved: (next: Payload) => void;
}) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const cap = caps[capKey];
    const min = TURN_CAP_MIN[capKey];
    const id = `agent-turn-cap-${capKey}`;
    const label = t(`security.agentTurnCaps.${capKey}`);

    const [mode, setMode] = useState<Mode>(cap.workspace === null ? 'follow' : 'custom');
    const [value, setValue] = useState<number>(Math.min(cap.workspace ?? cap.ceiling, cap.ceiling));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const pending = mode === 'follow' ? null : value;
    const dirty = pending !== cap.workspace;
    const narrowedByOrg = cap.workspace !== null && cap.workspace > cap.ceiling;
    const basisKey =
        cap.basis === 'WORKSPACE'
            ? 'basisWorkspace'
            : cap.basis === 'NO_ORGANIZATION'
              ? 'basisNoOrganization'
              : 'basisOrganization';

    async function save() {
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/admin/security-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [COLUMN[capKey]]: pending }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(apiErrorMessage(body, t('security.agentTurnCaps.saveFailed')));
                return;
            }
            const next = body as Payload;
            const nextCap = next.turnCaps?.[capKey];
            if (nextCap) {
                setMode(nextCap.workspace === null ? 'follow' : 'custom');
                setValue(Math.min(nextCap.workspace ?? nextCap.ceiling, nextCap.ceiling));
            }
            onSaved(next);
            setSaved(true);
        } catch {
            setError(t('security.agentTurnCaps.saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="rounded-lg border border-border-subtle p-3 space-y-default" data-testid={`${id}-row`}>
            <div className="flex flex-wrap items-center gap-tight" data-testid={`${id}-state`}>
                <span className="text-sm font-medium text-content-emphasis">{label}</span>
                <StatusBadge variant={cap.basis === 'WORKSPACE' ? 'info' : 'neutral'} size="sm">
                    {t('security.agentTurnCaps.applies', { value: cap.value })}
                </StatusBadge>
                <span className="text-xs text-content-muted">{t(`security.agentTurnCaps.${basisKey}`)}</span>
            </div>
            {narrowedByOrg && (
                <InlineNotice variant="info" icon={null}>
                    <span data-testid={`${id}-narrowed`}>
                        {t('security.agentTurnCaps.narrowedByOrg', { stored: cap.workspace ?? 0, ceiling: cap.ceiling })}
                    </span>
                </InlineNotice>
            )}

            <RadioGroup
                value={mode}
                onValueChange={(v) => { setMode(v as Mode); setSaved(false); }}
                aria-label={t('security.agentTurnCaps.modeAria', { cap: label })}
                className="space-y-1.5"
            >
                {(['follow', 'custom'] as const).map((m) => {
                    const itemId = `${id}-mode-${m}`;
                    return (
                        <label key={m} htmlFor={itemId} className="flex items-center gap-compact cursor-pointer">
                            <RadioGroupItem id={itemId} value={m} size="sm" data-testid={itemId} />
                            <span className="text-sm text-content-default">
                                {m === 'follow'
                                    ? t(cap.basis === 'NO_ORGANIZATION' ? 'security.agentTurnCaps.followNoOrg' : 'security.agentTurnCaps.followOrg', { ceiling: cap.ceiling })
                                    : t('security.agentTurnCaps.custom')}
                            </span>
                        </label>
                    );
                })}
            </RadioGroup>

            {mode === 'custom' && (
                <FormField
                    label={label}
                    description={t('security.agentTurnCaps.customDesc', { min, ceiling: cap.ceiling })}
                >
                    <NumberStepper
                        id={id}
                        value={value}
                        onChange={(v) => { setValue(v); setSaved(false); }}
                        min={min}
                        max={cap.ceiling}
                        ariaLabel={label}
                        decrementAriaLabel={t('security.agentTurnCaps.decrease')}
                        incrementAriaLabel={t('security.agentTurnCaps.increase')}
                        className="max-w-xs"
                        data-testid={id}
                    />
                </FormField>
            )}

            {error && <InlineNotice variant="error" icon={null}>{error}</InlineNotice>}
            {saved && !error && (
                <InlineNotice variant="success" icon={null}>{t('security.agentTurnCaps.saved')}</InlineNotice>
            )}

            <div className="flex justify-end">
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={save}
                    disabled={!dirty || busy}
                    loading={busy}
                    data-testid={`${id}-save`}
                    text={t('security.agentTurnCaps.save')}
                />
            </div>
        </div>
    );
}
