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
import {
    DEFAULT_KEY_ROTATION_DAYS,
    MAX_KEY_ROTATION_DAYS,
    MIN_KEY_ROTATION_DAYS,
} from '@/lib/agentic/credential-hygiene';

/**
 * API-KEY ROTATION AGE — the number the credential-hygiene pass judges agent
 * keys by (#3708).
 *
 * A CHOICE BETWEEN TWO STATES, NOT AN EMPTY INPUT. The column is nullable and
 * NULL means "the product default", which the pass reports as such on every
 * row and finding. An empty number box would make that state look like a form
 * nobody finished, so the card offers it as the first of two named choices,
 * with the default's value spelled out, and the stepper only for the second.
 *
 * A finding threshold, not an authority: nothing rotates or revokes a key by
 * this number, and the card says so, so nobody shortens it expecting keys to
 * stop working.
 */

type Mode = 'default' | 'custom';

export function ApiKeyRotationCard() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();

    /** What is STORED: null is the product default. `undefined` = not loaded. */
    const [stored, setStored] = useState<number | null | undefined>(undefined);
    const [unavailable, setUnavailable] = useState(false);
    const [mode, setMode] = useState<Mode>('default');
    const [days, setDays] = useState<number>(DEFAULT_KEY_ROTATION_DAYS);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const adopt = useCallback((value: number | null) => {
        setStored(value);
        setMode(value === null ? 'default' : 'custom');
        setDays(value ?? DEFAULT_KEY_ROTATION_DAYS);
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/security-settings'));
            if (!res.ok) { setUnavailable(true); return; }
            const body = (await res.json()) as { apiKeyRotationDays?: number | null };
            adopt(body.apiKeyRotationDays ?? null);
        } catch {
            setUnavailable(true);
        }
    }, [apiUrl, adopt]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { load(); }, [load]);

    async function save() {
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/admin/security-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKeyRotationDays: mode === 'default' ? null : days }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(body?.error ?? t('security.apiKeyRotation.saveFailed'));
                return;
            }
            adopt((body as { apiKeyRotationDays?: number | null }).apiKeyRotationDays ?? null);
            setSaved(true);
        } catch {
            setError(t('security.apiKeyRotation.saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    if (unavailable) {
        return (
            <Card data-testid="api-key-rotation-card">
                <Heading level={2} className="mb-1">{t('security.apiKeyRotation.title')}</Heading>
                <p className="text-sm text-content-muted">{t('security.apiKeyRotation.unavailable')}</p>
            </Card>
        );
    }
    if (stored === undefined) return null;

    const pending = mode === 'default' ? null : days;
    const dirty = pending !== stored;

    return (
        <Card data-testid="api-key-rotation-card">
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('security.apiKeyRotation.title')}</Heading>
                    <p className="text-sm text-content-muted">{t('security.apiKeyRotation.description')}</p>
                </div>

                {/* THE AGE IN FORCE, and where it comes from — the same two facts
                    the hygiene pass writes on its row. */}
                <div className="flex items-center gap-tight" data-testid="api-key-rotation-state">
                    {stored === null ? (
                        <>
                            <StatusBadge variant="neutral" size="sm">{t('security.apiKeyRotation.defaultBadge')}</StatusBadge>
                            <span className="text-sm text-content-default">
                                {t('security.apiKeyRotation.stateDefault', { days: DEFAULT_KEY_ROTATION_DAYS })}
                            </span>
                        </>
                    ) : (
                        <>
                            <StatusBadge variant="info" size="sm">{t('security.apiKeyRotation.customBadge')}</StatusBadge>
                            <span className="text-sm text-content-default">
                                {t('security.apiKeyRotation.stateCustom', { days: stored })}
                            </span>
                        </>
                    )}
                </div>

                <RadioGroup
                    value={mode}
                    onValueChange={(v) => { setMode(v as Mode); setSaved(false); }}
                    aria-label={t('security.apiKeyRotation.modeAria')}
                    className="space-y-1.5"
                >
                    {(['default', 'custom'] as const).map((value) => {
                        const id = `api-key-rotation-mode-${value}`;
                        const checked = mode === value;
                        return (
                            <label
                                key={value}
                                htmlFor={id}
                                className={`flex items-start gap-compact rounded-lg border p-3 cursor-pointer transition-colors duration-150 ease-out ${
                                    checked
                                        ? 'border-border-emphasis bg-bg-subtle'
                                        : 'border-border-subtle hover:bg-bg-muted'
                                }`}
                            >
                                <RadioGroupItem id={id} value={value} size="sm" className="mt-0.5" data-testid={id} />
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-content-emphasis">
                                        {value === 'default'
                                            ? t('security.apiKeyRotation.useDefault', { days: DEFAULT_KEY_ROTATION_DAYS })
                                            : t('security.apiKeyRotation.useCustom')}
                                    </p>
                                    <p className="text-xs text-content-muted">
                                        {value === 'default'
                                            ? t('security.apiKeyRotation.useDefaultDesc')
                                            : t('security.apiKeyRotation.useCustomDesc', {
                                                  min: MIN_KEY_ROTATION_DAYS,
                                                  max: MAX_KEY_ROTATION_DAYS,
                                              })}
                                    </p>
                                </div>
                            </label>
                        );
                    })}
                </RadioGroup>

                {mode === 'custom' && (
                    <FormField
                        label={t('security.apiKeyRotation.daysLabel')}
                        description={t('security.apiKeyRotation.daysHint', {
                            min: MIN_KEY_ROTATION_DAYS,
                            max: MAX_KEY_ROTATION_DAYS,
                        })}
                    >
                        <NumberStepper
                            id="api-key-rotation-days"
                            value={days}
                            onChange={(v) => { setDays(v); setSaved(false); }}
                            min={MIN_KEY_ROTATION_DAYS}
                            max={MAX_KEY_ROTATION_DAYS}
                            ariaLabel={t('security.apiKeyRotation.daysLabel')}
                            decrementAriaLabel={t('security.apiKeyRotation.decrease')}
                            incrementAriaLabel={t('security.apiKeyRotation.increase')}
                            className="max-w-xs"
                            data-testid="api-key-rotation-days"
                        />
                    </FormField>
                )}

                {error && <InlineNotice variant="error" icon={null}>{error}</InlineNotice>}
                {saved && !error && (
                    <InlineNotice variant="success" icon={null}>{t('security.apiKeyRotation.saved')}</InlineNotice>
                )}

                <div className="flex justify-end">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={save}
                        disabled={!dirty || busy}
                        loading={busy}
                        data-testid="api-key-rotation-save"
                        text={t('security.apiKeyRotation.save')}
                    />
                </div>
            </div>
        </Card>
    );
}
