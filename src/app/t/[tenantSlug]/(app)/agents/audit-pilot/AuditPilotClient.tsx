'use client';

/**
 * SET UP THE PILOT AUDITOR, as its owner (#3807, the page for step 3c's
 * set-up, which was a script the production image could not run).
 *
 * The page shows what the set-up WOULD do before it does anything: it opens on
 * a dry run, and each change of the inputs is checked again on request. Only
 * "Set up" writes, through a confirmation, and every write is the usecase a
 * person reaches elsewhere in the product, made as the signed-in owner. A
 * refusal is the usecase's named reason and its sentence, shown as the answer
 * to "can the pilot be set up yet?" — the dry run makes no claim it cannot
 * keep.
 *
 * A procedure's control is mapped from the catalogue when the mapping is
 * clean; when it is not (`CONTROL_MISSING`, `CONTROL_AMBIGUOUS`), the owner
 * names the control here instead of passing `--control=` to a script.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { AsyncCombobox, type AsyncOption } from '@/components/ui/async-combobox';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

interface Step {
    step: string;
    outcome: 'UNCHANGED' | 'WOULD_CHANGE' | 'CHANGED' | 'PENDING' | 'DIFFERS';
    detail: string;
}

type SetupResult =
    | { ok: false; refusal: string; detail: string }
    | { ok: true; applied: boolean; agentId: string | null; steps: Step[] };

export interface AuditPilotProcedure {
    id: string;
    title: string;
}

const OUTCOME_VARIANT: Readonly<Record<Step['outcome'], StatusBadgeVariant>> = {
    UNCHANGED: 'success',
    CHANGED: 'success',
    WOULD_CHANGE: 'info',
    PENDING: 'warning',
    DIFFERS: 'warning',
};

/** Refusals the owner can answer on this page by naming a control. */
const CONTROL_REFUSALS = new Set(['CONTROL_MISSING', 'CONTROL_AMBIGUOUS']);

export function AuditPilotClient({
    defaultAgentName,
    procedures,
}: {
    defaultAgentName: string;
    procedures: AuditPilotProcedure[];
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [agentName, setAgentName] = useState('');
    const [controls, setControls] = useState<Record<string, AsyncOption | null>>({});
    const [result, setResult] = useState<SetupResult | null>(null);
    const [running, setRunning] = useState<'check' | 'apply' | null>(null);
    const [requestError, setRequestError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);

    const body = useCallback(
        (apply: boolean) => {
            const named = Object.fromEntries(
                Object.entries(controls)
                    .filter((entry): entry is [string, AsyncOption] => entry[1] !== null)
                    .map(([procedure, option]) => [procedure, option.value]),
            );
            return {
                apply,
                ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
                ...(Object.keys(named).length > 0 ? { controls: named } : {}),
            };
        },
        [agentName, controls],
    );

    /** The server's answer, or the sentence to show instead. Sets no state. */
    const request = useCallback(
        async (apply: boolean): Promise<{ result: SetupResult } | { error: string }> => {
            try {
                const res = await fetch(apiUrl('/admin/agents/audit-pilot'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body(apply)),
                });
                const json = await res.json().catch(() => null);
                if (!res.ok) return { error: apiErrorMessage(json, t('auditPilot.requestFailed')) };
                return { result: json as SetupResult };
            } catch {
                return { error: t('auditPilot.requestFailed') };
            }
        },
        [apiUrl, body, t],
    );

    const show = useCallback((answer: { result: SetupResult } | { error: string }) => {
        if ('error' in answer) {
            setRequestError(answer.error);
            return;
        }
        setRequestError(null);
        setResult(answer.result);
    }, []);

    // The page opens on a dry run, which writes nothing.
    useEffect(() => {
        void request(false).then(show);
        // Once, on arrival; later checks are the owner's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const check = () => {
        setRunning('check');
        void request(false)
            .then(show)
            .finally(() => setRunning(null));
    };

    const searchControls = useCallback(
        async (query: string, signal: AbortSignal): Promise<AsyncOption[]> => {
            const qs = new URLSearchParams({ limit: '20', ...(query ? { q: query } : {}) });
            const res = await fetch(apiUrl(`/controls?${qs.toString()}`), { signal });
            if (!res.ok) return [];
            const json = (await res.json().catch(() => null)) as {
                items?: { id: string; name: string; code: string | null; annexId: string | null }[];
            } | null;
            return (json?.items ?? []).map((c) => ({
                value: c.id,
                label: `${c.code ?? c.annexId ?? ''} ${c.name}`.trim(),
            }));
        },
        [apiUrl],
    );

    const apply = async () => {
        setApplyError(null);
        setRunning('apply');
        const answer = await request(true).finally(() => setRunning(null));
        if ('error' in answer) {
            setApplyError(answer.error);
            // Rejecting keeps the confirmation open over the server's sentence.
            throw new Error(answer.error);
        }
        show(answer);
        setConfirming(false);
    };

    const ready = result?.ok === true && !result.applied && result.steps.some((s) => s.outcome === 'WOULD_CHANGE');

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[{ label: t('auditPilot.crumbAgents'), href: tenantHref('/agents') }, { label: t('auditPilot.title') }]}
            />
            <div className="space-y-tight">
                <Heading level={1}>{t('auditPilot.title')}</Heading>
                <p className="max-w-3xl text-sm text-content-muted">{t('auditPilot.intro')}</p>
            </div>

            <Card className="space-y-default p-6" data-testid="audit-pilot-inputs">
                <Heading level={2}>{t('auditPilot.inputsHeading')}</Heading>
                <FormField label={t('auditPilot.nameLabel')} description={t('auditPilot.nameHint')}>
                    <Input
                        id="audit-pilot-name"
                        value={agentName}
                        placeholder={defaultAgentName}
                        maxLength={200}
                        onChange={(e) => setAgentName(e.target.value)}
                    />
                </FormField>
                <div className="space-y-compact">
                    <p className="text-sm font-medium text-content-emphasis">{t('auditPilot.controlsLabel')}</p>
                    <p className="text-xs text-content-muted">{t('auditPilot.controlsHint')}</p>
                    <ul className="space-y-compact">
                        {procedures.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center gap-compact" data-testid={`audit-pilot-procedure-${p.id}`}>
                                <span className="w-full text-sm sm:w-64">
                                    {p.title} <span className="font-mono text-xs text-content-muted">{p.id}</span>
                                </span>
                                <div className="w-full max-w-sm">
                                    <AsyncCombobox
                                        id={`audit-pilot-control-${p.id}`}
                                        value={controls[p.id]?.value ?? null}
                                        onChange={(option) => setControls((c) => ({ ...c, [p.id]: option }))}
                                        onSearch={searchControls}
                                        placeholder={t('auditPilot.controlMapped')}
                                        searchPlaceholder={t('auditPilot.controlSearch')}
                                        matchTriggerWidth
                                    />
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="flex flex-wrap gap-compact">
                    <Button
                        type="button"
                        variant="secondary"
                        loading={running === 'check'}
                        disabled={running !== null}
                        onClick={check}
                        data-testid="audit-pilot-check"
                    >
                        {t('auditPilot.check')}
                    </Button>
                    <Button
                        type="button"
                        // Secondary: the confirmation carries the decision.
                        variant="secondary"
                        disabled={!ready || running !== null}
                        onClick={() => {
                            setApplyError(null);
                            setConfirming(true);
                        }}
                        data-testid="audit-pilot-apply"
                    >
                        {t('auditPilot.apply')}
                    </Button>
                </div>
            </Card>

            <Card className="space-y-default p-6" data-testid="audit-pilot-result">
                <Heading level={2}>
                    {result?.ok && result.applied ? t('auditPilot.appliedHeading') : t('auditPilot.dryRunHeading')}
                </Heading>
                {requestError ? (
                    <InlineNotice variant="error" data-testid="audit-pilot-request-error">
                        {requestError}
                    </InlineNotice>
                ) : !result ? (
                    <p className="text-sm text-content-muted">{t('auditPilot.checking')}</p>
                ) : !result.ok ? (
                    <InlineNotice variant="warning" data-testid="audit-pilot-refusal">
                        <span className="font-mono">{result.refusal}</span>: {result.detail}
                        {CONTROL_REFUSALS.has(result.refusal) && (
                            <span className="mt-compact block">{t('auditPilot.nameAControl')}</span>
                        )}
                    </InlineNotice>
                ) : (
                    <ul className="space-y-compact" data-testid="audit-pilot-steps">
                        {result.steps.map((s) => (
                            <li key={s.step} className="flex flex-wrap items-start gap-compact text-sm">
                                <span className="w-full font-mono text-xs sm:w-72">{s.step}</span>
                                <StatusBadge variant={OUTCOME_VARIANT[s.outcome]} size="sm">
                                    {t(`auditPilot.outcome.${s.outcome}`)}
                                </StatusBadge>
                                <span className="min-w-0 flex-1 text-content-muted">{s.detail}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <ConfirmDialog
                showModal={confirming}
                setShowModal={(next) => {
                    const value = typeof next === 'function' ? next(confirming) : next;
                    if (!value) setConfirming(false);
                }}
                tone="warning"
                title={t('auditPilot.confirmTitle')}
                description={
                    <>
                        {t('auditPilot.confirmBody')}
                        {applyError && (
                            <span role="alert" className="mt-2 block text-content-error" data-testid="audit-pilot-apply-error">
                                {applyError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('auditPilot.confirmAction')}
                cancelLabel={t('auditPilot.cancel')}
                onConfirm={apply}
            />
        </div>
    );
}
