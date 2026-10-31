'use client';

/**
 * "Where AI runs": the workspace's `aiResidency`, External or Local only.
 *
 * ═══ TWO CHOICES, AND NO ADDRESS ═══
 *
 * The setting lives on `TenantSecuritySettings`, written by
 * `PUT /admin/security-settings` (`admin.manage`), which also takes a per-tenant
 * gateway address. This section does not offer that field. The only gateway any
 * consumer will dial is the deployment's own, and an address a tenant types is a
 * host the server would be asked to call (#4545). So the choice is the posture
 * alone, and the read says whether this deployment HAS a local gateway, which
 * decides what Local only will mean here.
 *
 * ═══ THE PATCH CARRIES ONE KEY ═══
 *
 * The PUT is patch-shaped. Sending `aiResidency` and nothing else leaves every
 * other column on the row as it is, including a gateway address stored by an
 * earlier API call.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

type Residency = 'EXTERNAL' | 'LOCAL_ONLY';

interface ResidencyPayload {
    aiResidency?: Residency;
    deploymentHasLocalGateway?: boolean;
}

const CHOICES: readonly Residency[] = ['EXTERNAL', 'LOCAL_ONLY'];

export function AiResidencySection() {
    const t = useTranslations('admin.aiResidency');
    const tError = useTranslations('common.error');
    const apiUrl = useTenantApiUrl();

    /** What is STORED. `undefined` = not loaded yet. */
    const [stored, setStored] = useState<Residency | undefined>(undefined);
    const [hasGateway, setHasGateway] = useState(false);
    const [choice, setChoice] = useState<Residency>('EXTERNAL');
    const [unavailable, setUnavailable] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const adopt = useCallback((body: ResidencyPayload) => {
        const value = body.aiResidency === 'LOCAL_ONLY' ? 'LOCAL_ONLY' : 'EXTERNAL';
        setStored(value);
        setChoice(value);
        setHasGateway(body.deploymentHasLocalGateway === true);
    }, []);

    const load = useCallback(async () => {
        setUnavailable(false);
        try {
            const res = await fetch(apiUrl('/admin/security-settings'));
            if (!res.ok) { setUnavailable(true); return; }
            adopt((await res.json()) as ResidencyPayload);
        } catch {
            setUnavailable(true);
        }
    }, [apiUrl, adopt]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    async function save() {
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/admin/security-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aiResidency: choice }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(apiErrorMessage(body, t('saveFailed')));
                return;
            }
            adopt(body as ResidencyPayload);
            setSaved(true);
        } catch {
            setError(t('saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    if (unavailable) {
        return (
            <Card data-testid="ai-residency-section">
                <Heading level={2} className="mb-1">{t('title')}</Heading>
                <p className="text-sm text-content-muted">{t('loadFailed')}</p>
                <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => { void load(); }}
                    data-testid="ai-residency-retry"
                    text={tError('tryAgain')}
                />
            </Card>
        );
    }
    if (stored === undefined) return null;

    return (
        <Card data-testid="ai-residency-section">
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('title')}</Heading>
                    <p className="text-sm text-content-muted">{t('description')}</p>
                </div>

                <div className="flex items-center gap-tight" data-testid="ai-residency-state">
                    <StatusBadge variant={stored === 'LOCAL_ONLY' ? 'info' : 'neutral'} size="sm">
                        {stored === 'LOCAL_ONLY' ? t('localBadge') : t('externalBadge')}
                    </StatusBadge>
                    <span className="text-sm text-content-default">
                        {stored === 'LOCAL_ONLY' ? t('stateLocal') : t('stateExternal')}
                    </span>
                </div>

                <RadioGroup
                    value={choice}
                    onValueChange={(v) => { setChoice(v as Residency); setSaved(false); }}
                    aria-label={t('choiceAria')}
                    className="space-y-1.5"
                >
                    {CHOICES.map((value) => {
                        const id = `ai-residency-${value === 'EXTERNAL' ? 'external' : 'local-only'}`;
                        const checked = choice === value;
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
                                        {value === 'EXTERNAL' ? t('externalLabel') : t('localLabel')}
                                    </p>
                                    <p className="text-xs text-content-muted">
                                        {value === 'EXTERNAL' ? t('externalDesc') : t('localDesc')}
                                    </p>
                                </div>
                            </label>
                        );
                    })}
                </RadioGroup>

                {/* What Local only means IN THIS DEPLOYMENT, shown whenever it is
                    the choice on screen: before saving is when it matters. */}
                {choice === 'LOCAL_ONLY' && (
                    <InlineNotice variant="info" icon={null}>
                        <span data-testid="ai-residency-local-meaning">
                            {hasGateway ? t('localWithGateway') : t('localWithoutGateway')}
                        </span>
                    </InlineNotice>
                )}

                {error && <InlineNotice variant="error" icon={null}>{error}</InlineNotice>}
                {saved && !error && (
                    <InlineNotice variant="success" icon={null}>{t('saved')}</InlineNotice>
                )}

                <div className="flex justify-end">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={save}
                        disabled={choice === stored || busy}
                        loading={busy}
                        data-testid="ai-residency-save"
                        text={t('save')}
                    />
                </div>
            </div>
        </Card>
    );
}
