'use client';

/**
 * "Agent engines": which engine this workspace's agent runs execute on, why,
 * and, for an owner, the control that changes it.
 *
 * ═══ ONE CONTROL FOR ONE COLUMN ═══
 *
 * This replaces the Flue card that sat on Admin → Integrations (owner
 * decision 2026-10-25, #4139). Two surfaces writing `agentDriver` would be two
 * places to audit and two places to drift, so the card is gone, and its
 * six-term checklist lives here, for owners.
 *
 * ═══ WHO SEES WHAT ═══
 *
 * Every admin reads the gate (`GET /admin/agent-driver` is `admin.view`).
 * Only an owner can change it (`PUT` is `admin.tenant_lifecycle`), and only an
 * owner gets the wiring checklist (`GET /admin/flue-wiring`, same key, because
 * it adds counts over the agent register). Somebody who cannot change the
 * engine sees the state and one sentence naming who can. The section is never
 * hidden: hiding it is what made the gate unreadable to admins before.
 *
 * ═══ THE SECTION DOES NOT DECIDE ═══
 *
 * The effective engine and its reason come from the server, computed by the
 * function the run path calls. `agent-engine-display.ts` only turns them into
 * words and picks the control.
 */
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { CircleCheck, CircleDotted } from '@inflect/ui/components/ui/icons/nucleo';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { usePermissions, useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import type { AgentDriverMode } from '@/lib/agentic/agent-driver';

import {
    OFFERED_ENGINES,
    choiceEnabled,
    engineControlFor,
    gateTermsFor,
    headlineFor,
    headlineToneFor,
    type AgentDriverSettingPayload,
    type EngineTerm,
    type EngineTermKey,
    type FlueWiringPayload,
} from './agent-engine-display';

export function AgentEnginesSection() {
    const t = useTranslations('admin.agentEngines');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const canChange = usePermissions().admin.tenant_lifecycle;

    const setting = useTenantSWR<AgentDriverSettingPayload>('/admin/agent-driver');
    // OWNER-only, and not requested at all otherwise: a request the route
    // refuses would write an AUTHZ_DENIED row every time an admin opened the page.
    const wiring = useTenantSWR<FlueWiringPayload>(canChange ? '/admin/flue-wiring' : null);

    const [pending, setPending] = useState<AgentDriverMode | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    /**
     * REJECTS on refusal, so `ConfirmDialog` stays open over the server's
     * sentence instead of closing as if the change had worked.
     */
    const save = useCallback(
        async (mode: AgentDriverMode) => {
            setSaving(true);
            setSaveError(null);
            try {
                let res: Response;
                try {
                    res = await fetch(apiUrl('/admin/agent-driver'), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ mode }),
                    });
                } catch (err) {
                    // No response at all. The dialog stays open, so it must
                    // say why, or a retry looks like a button that does nothing.
                    setSaveError(t('saveFailed'));
                    throw err;
                }
                if (!res.ok) {
                    const body: unknown = await res.json().catch(() => null);
                    const message = apiErrorMessage(body, t('saveFailed'));
                    setSaveError(message);
                    throw new Error(message);
                }
                // The change is made. A refetch that fails must not hold the
                // dialog open as if it had not been: the section reports the
                // stale read itself (`refreshFailed`).
                await Promise.all([setting.mutate(), canChange ? wiring.mutate() : undefined]).catch(
                    () => undefined,
                );
                setPending(null);
            } finally {
                setSaving(false);
            }
        },
        [apiUrl, canChange, setting, wiring, t],
    );

    // Only when there is nothing to show. SWR keeps the last good answer
    // beside a failed revalidation, and a section that had loaded is not
    // replaced by an error about a refresh.
    if (setting.error && !setting.data) {
        return (
            <section id="agent-engines" data-testid="agent-engines">
                <ErrorState title={t('loadFailed')} />
            </section>
        );
    }
    const state = setting.data;
    if (!state) return null;

    const control = engineControlFor(state, canChange);
    const runsOnFlue = state.effective.driver === 'flue';
    // The owner's six terms only when they have arrived. While the checklist
    // is loading, or if it failed, the three terms the gate reports are shown
    // under the gate's own heading, never as "what a Flue run needs".
    const wiringData = canChange ? wiring.data : undefined;
    const terms: EngineTerm[] = wiringData ? wiringData.terms : gateTermsFor(state);
    const tone = headlineToneFor(state, wiringData);

    /** Where a tenant-owned wiring term is fixed. Operator terms have no link. */
    const fixHref = (key: EngineTermKey): string | null => {
        if (key === 'REGISTERED_AGENT') return tenantHref('/admin/agents');
        if (key === 'BOUND_KEY') return tenantHref('/admin/api-keys');
        return null;
    };

    return (
        <section id="agent-engines" data-testid="agent-engines" data-control={control}>
            <Card className="space-y-default p-6">
                <div className="flex items-start justify-between gap-default">
                    <div className="space-y-tight">
                        <Heading level={2}>{t('title')}</Heading>
                        <p className="max-w-3xl text-sm text-content-muted">{t('description')}</p>
                    </div>
                    <StatusBadge variant={tone === 'info' ? 'neutral' : tone}>
                        {runsOnFlue ? t('engine.FLUE.name') : t('engine.STATIC.name')}
                    </StatusBadge>
                </div>

                {/* The headline, and the reason the section exists: what runs
                    TODAY, which the stored choice alone does not tell you. */}
                <InlineNotice variant={tone}>
                    <span data-testid="agent-engines-headline" data-tone={tone}>
                        {t(headlineFor(state, wiringData))}
                    </span>
                </InlineNotice>

                {setting.error && (
                    <InlineNotice variant="warning">
                        <span data-testid="agent-engines-refresh-failed">{t('refreshFailed')}</span>
                    </InlineNotice>
                )}

                {/* Only over a control. A viewer who has none is told the
                    deployment is off by the headline already. */}
                {control === 'deployment-off' && (
                    <InlineNotice variant="info" title={t('deploymentOffHeading')}>
                        <span data-testid="agent-engines-deployment-off" className="block">
                            {t('deploymentOffBody')}
                        </span>
                        {state.mode === 'FLUE' && (
                            <span data-testid="agent-engines-deployment-off-stored-flue" className="mt-1 block">
                                {t('deploymentOffStoredFlue')}
                            </span>
                        )}
                    </InlineNotice>
                )}

                {control === 'read-only' ? (
                    <div className="space-y-tight" data-testid="agent-engines-read-only">
                        <p className="text-sm text-content-default">
                            {t('chosen', { engine: t(`engine.${state.mode}.name`) })}
                        </p>
                        <p className="text-sm text-content-muted">{t('ownerOnly')}</p>
                    </div>
                ) : (
                    <RadioGroup
                        value={state.mode}
                        onValueChange={(value) => {
                            const next = value as AgentDriverMode;
                            if (next !== state.mode) setPending(next);
                        }}
                        disabled={saving}
                        aria-label={t('choiceAria')}
                        className="space-y-1.5"
                    >
                        {OFFERED_ENGINES.map((mode) => {
                            const id = `agent-engine-${mode}`;
                            const checked = state.mode === mode;
                            const enabled = choiceEnabled(control, mode);
                            return (
                                <label
                                    key={mode}
                                    htmlFor={id}
                                    className={`flex items-start gap-compact rounded-lg border p-3 transition-colors duration-150 ease-out ${
                                        checked
                                            ? 'border-border-emphasis bg-bg-subtle'
                                            : 'border-border-subtle hover:bg-bg-muted'
                                    } ${enabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                                >
                                    <RadioGroupItem
                                        id={id}
                                        value={mode}
                                        size="sm"
                                        className="mt-0.5"
                                        disabled={!enabled}
                                        data-testid={id}
                                    />
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-content-emphasis">
                                            {t(`engine.${mode}.name`)}
                                        </p>
                                        <p className="text-xs text-content-muted">{t(`engine.${mode}.description`)}</p>
                                    </div>
                                </label>
                            );
                        })}
                    </RadioGroup>
                )}

                <div className="space-y-tight">
                    {canChange && wiring.error && (
                        <InlineNotice variant="warning">
                            <span data-testid="agent-engines-wiring-failed">{t('wiringLoadFailed')}</span>
                        </InlineNotice>
                    )}
                    <p className="text-sm font-medium text-content-emphasis">
                        {wiringData ? t('wiringHeading') : t('gateHeading')}
                    </p>
                    <ul className="space-y-tight" data-testid="agent-engines-terms">
                        {terms.map((term) => {
                            const href = fixHref(term.key);
                            return (
                                <li
                                    key={term.key}
                                    className="flex items-center gap-default text-sm"
                                    data-testid={`agent-engines-term-${term.key}`}
                                    data-satisfied={term.satisfied ? 'true' : 'false'}
                                >
                                    {/* A DOTTED circle, not a cross: an unmet term is
                                        work not yet done, not something gone wrong. */}
                                    {term.satisfied ? (
                                        <CircleCheck className="h-4 w-4 text-status-success" aria-hidden="true" />
                                    ) : (
                                        <CircleDotted className="h-4 w-4 text-content-muted" aria-hidden="true" />
                                    )}
                                    <span className={term.satisfied ? 'text-content-default' : 'text-content-muted'}>
                                        {t(`term.${term.key}`)}
                                    </span>
                                    {typeof term.count === 'number' && (
                                        <span className="text-xs text-content-muted tabular-nums">
                                            {t('count', { count: term.count })}
                                        </span>
                                    )}
                                    <span className="ml-auto flex items-center gap-default">
                                        {term.actor === 'operator' && (
                                            <span className="text-xs text-content-muted">{t('operatorTerm')}</span>
                                        )}
                                        {!term.satisfied && href && (
                                            <Link href={href} className="text-sm text-content-link">
                                                {t('fix')}
                                            </Link>
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                    {/* The term that surprises people: a browser session carries
                        no agentId, so nobody can start a Flue run by hand. Shown
                        to every viewer: it is the one condition the three-term
                        gate cannot report. */}
                    <p className="text-xs text-content-muted">{t('boundKeyNote')}</p>
                </div>
            </Card>

            {pending && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => {
                        // Only ever called with `false`: the dialog is mounted on
                        // `pending`, so dismissing it drops the choice and any
                        // refusal with it.
                        setPending(null);
                        setSaveError(null);
                    }}
                    // `warning` for the widen, `info` for the narrow. Neither is
                    // `danger`, which this repo keeps for the irreversible, and
                    // both directions are always one more choice away.
                    tone={pending === 'FLUE' ? 'warning' : 'info'}
                    title={t(`confirmTitle.${pending}`)}
                    description={
                        <>
                            {t(`confirmBody.${pending}`)}
                            {saveError && (
                                <span className="mt-2 block text-content-error" role="alert">
                                    {saveError}
                                </span>
                            )}
                        </>
                    }
                    confirmLabel={t('confirmLabel')}
                    onConfirm={() => save(pending)}
                />
            )}
        </section>
    );
}
