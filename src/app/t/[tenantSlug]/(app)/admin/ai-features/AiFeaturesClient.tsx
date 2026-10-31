'use client';

/**
 * Turn AI on and off for this workspace.
 *
 * ═══ THE ONE THING THIS SCREEN MUST NOT DO ═══
 *
 * Show a switch that looks available over a feature that cannot run. That is
 * the defect #3909 fixed in the assistant launcher: `AI_RISK_ENABLED=false` in
 * production while the per-feature flag was true, so the launcher rendered on
 * every page and every turn was refused.
 *
 * Hence `displayFor` and `forcedOffByEnv`. A row whose feature the DEPLOY
 * forbids renders its reason and no control, because nothing an owner can do on
 * this page would change it — the env flags are read into module constants at
 * import time, so they are fixed until the container is recreated.
 *
 * ═══ WHY THE MASTER SWITCH IS RENDERED APART ═══
 *
 * It is not one of four peers. `aiEnabled` off refuses every feature below it,
 * so a flat list of four identical rows would let an owner turn the assistant
 * "on" while AI was off for the workspace and read that as success.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ErrorState } from '@/components/ui/error-state';
import { apiRefusalMessage } from '@/lib/api-error';
import type { AiToggleKey, AiToggleState } from '@/app-layer/usecases/ai-feature-toggles';

import { displayFor, type ToggleDisplay } from './ai-feature-display';

interface TogglesResponse {
    toggles: AiToggleState[];
}

/** The three feature rows, in the order an operator meets them in the product. */
const FEATURE_ORDER: readonly AiToggleKey[] = ['assistant', 'risk', 'questionnaire'];

export function AiFeaturesClient() {
    const t = useTranslations('admin');
    const { tenantSlug } = useTenantContext();
    const [saving, setSaving] = useState<AiToggleKey | null>(null);
    // The refusal to show, or null. The server's own reason when it gave one
    // (a 403 naming the key, a 400 naming the field), else the fixed sentence.
    const [failed, setFailed] = useState<string | null>(null);

    // TENANT-RELATIVE. `useTenantSWR` prefixes `/api/t/<slug>` itself, so an
    // absolute path here would resolve to `/api/t/<slug>/api/t/<slug>/…`.
    // Pinned by `useTenantSWR call sites pass tenant-relative paths`.
    const { data, error, isLoading, mutate } = useTenantSWR<TogglesResponse>('/admin/ai-features');

    async function toggle(key: AiToggleKey, next: boolean) {
        setSaving(key);
        setFailed(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/ai-features`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                // ONE KEY per request, matching the route's partial body: a form
                // posting all four would have two owners editing different
                // switches overwrite each other.
                body: JSON.stringify({ [key]: next }),
            });
            if (!res.ok) {
                // A 5xx body is not a reason anybody can act on; the fixed
                // sentence is.
                const body: unknown = res.status >= 500 ? null : await res.json().catch(() => null);
                setFailed(apiRefusalMessage(body, t('aiFeatures.saveFailedBody')));
                return;
            }
            await mutate();
        } catch {
            // VISIBLE, not swallowed. A toggle that silently failed would leave
            // an owner believing they had turned AI off for a workspace that had
            // undertaken not to use it.
            setFailed(t('aiFeatures.saveFailedBody'));
        } finally {
            setSaving(null);
        }
    }

    if (error) return <ErrorState title={t('aiFeatures.loadFailed')} onRetry={() => { void mutate(); }} />;

    const states = data?.toggles ?? [];
    const byKey = (key: AiToggleKey): AiToggleState | undefined =>
        states.find((state) => state.key === key);
    const master = byKey('ai');
    // Absent data reads as ON, matching the server: an absent settings row means
    // "never configured", and all four columns default to true.
    const tenantMasterEnabled = master?.tenantEnabled ?? true;

    function row(state: AiToggleState, testId: string) {
        const display = displayFor(state, tenantMasterEnabled);
        return (
            <section
                key={state.key}
                className="space-y-compact rounded-lg border border-border-subtle p-5"
                data-testid={testId}
                data-display-kind={display.kind}
            >
                <div className="flex items-start justify-between gap-default">
                    <div className="space-y-tight">
                        <div className="flex items-center gap-tight">
                            <Heading level={2}>{t(`aiFeatures.${state.key}.name`)}</Heading>
                            <StatusBadge variant={badgeVariant(display)}>
                                {t(`aiFeatures.status.${display.kind}`)}
                            </StatusBadge>
                        </div>
                        <p className="max-w-3xl text-sm text-content-muted">
                            {t(`aiFeatures.${state.key}.description`)}
                        </p>
                    </div>
                    {/* NO BUTTON when the deploy forbids the feature. Not a
                        disabled button either: a disabled control still says
                        "this is the thing to press", and the honest answer is
                        that this screen is not where that decision lives. */}
                    {display.actionable && (
                        <Button
                            variant="secondary"
                            onClick={() => toggle(state.key, !state.tenantEnabled)}
                            disabled={isLoading || saving !== null}
                            data-testid={`toggle-${state.key}`}
                        >
                            {state.tenantEnabled
                                ? t('aiFeatures.turnOff')
                                : t('aiFeatures.turnOn')}
                        </Button>
                    )}
                </div>

                {display.kind === 'off-by-platform' && (
                    <InlineNotice variant="info" title={t('aiFeatures.platformOffHeading')}>
                        {t('aiFeatures.platformOffBody')}
                    </InlineNotice>
                )}
                {display.kind === 'off-by-master' && (
                    <InlineNotice variant="warning" title={t('aiFeatures.masterOffHeading')}>
                        {t('aiFeatures.masterOffBody')}
                    </InlineNotice>
                )}
            </section>
        );
    }

    return (
        <div className="space-y-section" data-testid="admin-ai-features">
            {failed && (
                <InlineNotice variant="error" title={t('aiFeatures.saveFailedHeading')}>
                    <span data-testid="ai-toggle-save-failed">{failed}</span>
                </InlineNotice>
            )}

            {master && row(master, 'ai-toggle-master')}

            {FEATURE_ORDER.map((key) => {
                const state = byKey(key);
                return state ? row(state, `ai-toggle-${key}`) : null;
            })}
        </div>
    );
}

function badgeVariant(display: ToggleDisplay): 'success' | 'neutral' | 'warning' {
    if (display.kind === 'on') return 'success';
    // A platform-forced off is NEUTRAL, not a warning: nothing is wrong, the
    // feature simply is not part of this deployment. A master-forced off IS a
    // warning, because it means a switch the owner turned on is not running.
    return display.kind === 'off-by-master' ? 'warning' : 'neutral';
}
