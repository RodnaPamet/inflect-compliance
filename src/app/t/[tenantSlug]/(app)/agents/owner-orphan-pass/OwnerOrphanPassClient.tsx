'use client';

/**
 * THE OWNER-ORPHAN PASS'S MODE and its recorded passes (#3807, the page for
 * step 2b's `/admin/agents/owner-orphan-pass`).
 *
 * The route had no page, so the only way to start the pass's seven-day dry run
 * was a hand-made request from an OWNER's session. This page reads the same
 * GET and sends the same PUT, and adds no authority: the route takes
 * `admin.tenant_lifecycle`, and every refusal is the usecase's.
 *
 * The mode is on the identity ladder, so the rung controls are the identity
 * page's own `LadderRungCard`: widening is confirmed, narrowing is one click.
 *
 * THE PASSES ARE THE RECORD the dry run is read against. Each pass is listed
 * with what it decided per orphan — the agent, the signals that said the owner
 * left, and what was done or would be done — so an operator can compare a
 * week of DRY_RUN against who actually left before widening. A refusal pass
 * says which refusal; none of them is a clean bill.
 */
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { LadderRungCard } from '@/components/admin/LadderRungCard';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import type { IdentityWriteMode } from '@/lib/identity/write-ladder';

interface DecisionRow {
    agentId: string;
    signals?: { kind: string; membership?: string }[];
    outcome: string;
    failedStep?: string;
    transferTask?: { status: string };
    servicePrincipal?: { status: string; detail?: string };
}

interface PassRow {
    id: string;
    status: string;
    executedAt: string;
    resultJson: {
        mode?: string;
        refusal?: string | null;
        counts?: { orphans?: number; contained?: number; failed?: number; wouldContain?: number };
        decisions?: DecisionRow[];
        decisionsTruncated?: boolean;
        hrRoster?: { read?: boolean };
    } | null;
}

interface OrphanPassPayload {
    mode: IdentityWriteMode;
    dryRunSince: string | null;
    nextMode: IdentityWriteMode | null;
    blockedReason: string | null;
    dryRunMinDays: number;
    maxMode: IdentityWriteMode;
    passes: PassRow[];
}

const STATUS_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    PASSED: 'success',
    PARTIAL: 'warning',
    NOT_APPLICABLE: 'neutral',
    ERROR: 'error',
};

function PassBlock({ pass }: { pass: PassRow }) {
    const tPass = useTranslations('agents');
    const tenantHref = useTenantHref();
    const result = pass.resultJson ?? {};
    const decisions = result.decisions ?? [];
    return (
        <li className="space-y-compact border-t border-border-subtle pt-default" data-testid={`orphan-pass-${pass.id}`}>
            <div className="flex flex-wrap items-center gap-compact">
                <span className="text-sm font-medium text-content-emphasis">{formatDateTime(pass.executedAt)}</span>
                <StatusBadge variant={STATUS_VARIANT[pass.status] ?? 'neutral'} size="sm">
                    {pass.status}
                </StatusBadge>
                {result.mode && (
                    <span className="text-xs text-content-muted">{tPass('orphanPass.passMode', { mode: result.mode })}</span>
                )}
            </div>
            {result.refusal ? (
                <p className="text-sm text-content-muted" data-testid={`orphan-pass-refusal-${pass.id}`}>
                    {tPass(`orphanPass.refusal.${result.refusal}`)}
                </p>
            ) : (
                <p className="text-sm" data-testid={`orphan-pass-counts-${pass.id}`}>
                    {result.mode === 'AUTOMATIC'
                        ? tPass('orphanPass.countsAutomatic', {
                              orphans: result.counts?.orphans ?? 0,
                              contained: result.counts?.contained ?? 0,
                              failed: result.counts?.failed ?? 0,
                          })
                        : tPass('orphanPass.countsDryRun', { orphans: result.counts?.orphans ?? 0 })}
                </p>
            )}
            {result.hrRoster && result.hrRoster.read === false && (
                <InlineNotice variant="warning" icon={null}>
                    {tPass('orphanPass.rosterNotRead')}
                </InlineNotice>
            )}
            {decisions.length > 0 && (
                <ul className="space-y-tight">
                    {decisions.map((d) => (
                        <li
                            key={d.agentId}
                            className="flex flex-wrap items-center gap-compact text-xs"
                            data-testid={`orphan-decision-${pass.id}-${d.agentId}`}
                        >
                            <Link href={tenantHref(`/agents/${d.agentId}`)} className="font-mono text-content-emphasis underline">
                                {d.agentId}
                            </Link>
                            <span>{tPass(`orphanPass.outcome.${d.outcome}`)}</span>
                            {(d.signals ?? []).map((s) => (
                                <span key={`${s.kind}-${s.membership ?? ''}`} className="font-mono text-content-muted">
                                    {s.membership ? `${s.kind}:${s.membership}` : s.kind}
                                </span>
                            ))}
                            {d.servicePrincipal && d.servicePrincipal.status !== 'NOT_CONTAINED' && (
                                <span className="text-content-muted">
                                    {tPass('orphanPass.servicePrincipal', { status: d.servicePrincipal.status })}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {result.decisionsTruncated && (
                <p className="text-xs text-content-muted">{tPass('orphanPass.decisionsTruncated')}</p>
            )}
        </li>
    );
}

export function OwnerOrphanPassClient() {
    const t = useTranslations('agents');
    const tAdmin = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { data, error, isLoading, mutate } = useTenantSWR<OrphanPassPayload>('/admin/agents/owner-orphan-pass');

    const [pending, setPending] = useState<IdentityWriteMode | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    /**
     * Rejects on refusal, because `ConfirmDialog` stays open when `onConfirm`
     * rejects: the server's sentence is then read inside the dialog. The
     * narrow path has no dialog and reads it from the page-level notice.
     */
    const setMode = useCallback(
        async (mode: IdentityWriteMode) => {
            setSaving(true);
            setSaveError(null);
            try {
                const res = await fetch(apiUrl('/admin/agents/owner-orphan-pass'), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    const message = apiErrorMessage(body, t('orphanPass.saveError'));
                    setSaveError(message);
                    throw new Error(message);
                }
                setPending(null);
                await mutate();
            } finally {
                setSaving(false);
            }
        },
        [apiUrl, mutate, t],
    );

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[{ label: t('orphanPass.crumbAgents'), href: tenantHref('/agents') }, { label: t('orphanPass.title') }]}
            />
            <div className="space-y-tight">
                <Heading level={1}>{t('orphanPass.title')}</Heading>
                <p className="max-w-3xl text-sm text-content-muted">{t('orphanPass.intro')}</p>
            </div>

            {saveError && pending === null && (
                <InlineNotice variant="error" data-testid="orphan-pass-save-error">
                    {saveError}
                </InlineNotice>
            )}

            {error ? (
                <InlineNotice variant="error">{t('orphanPass.loadError')}</InlineNotice>
            ) : isLoading || !data ? (
                <p className="text-sm text-content-muted">{t('orphanPass.loading')}</p>
            ) : (
                <>
                    <LadderRungCard
                        headingId="owner-orphan-pass-mode"
                        title={t('orphanPass.modeHeading')}
                        blurb={t('orphanPass.blurb')}
                        mode={data.mode}
                        dryRunSince={data.dryRunSince}
                        dryRunMinDays={data.dryRunMinDays}
                        nextMode={data.nextMode}
                        blockedReason={data.blockedReason}
                        saving={saving}
                        onWiden={(mode) => {
                            setSaveError(null);
                            setPending(mode);
                        }}
                        onNarrow={(mode) => void setMode(mode).catch(() => {})}
                    />

                    <Card className="space-y-default p-6" data-testid="orphan-passes">
                        <Heading level={2}>{t('orphanPass.passesHeading')}</Heading>
                        <p className="text-sm text-content-muted">{t('orphanPass.passesIntro')}</p>
                        {data.passes.length === 0 ? (
                            <InlineNotice variant="info" icon={null} data-testid="orphan-passes-none">
                                {t('orphanPass.passesNone')}
                            </InlineNotice>
                        ) : (
                            <ul className="space-y-default">
                                {data.passes.map((p) => (
                                    <PassBlock key={p.id} pass={p} />
                                ))}
                            </ul>
                        )}
                    </Card>
                </>
            )}

            {pending && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => {
                        setPending(null);
                        setSaveError(null);
                    }}
                    // `warning`, not `danger`: widening is reversible, and
                    // narrowing sits beside this button.
                    tone="warning"
                    title={tAdmin('writeLadder.confirmTitle', { mode: tAdmin(`writeLadder.mode.${pending}`) })}
                    description={
                        <>
                            {t(`orphanPass.confirmBody.${pending}`)}
                            {saveError && (
                                <span className="mt-compact block text-content-error" data-testid="orphan-pass-confirm-error">
                                    {saveError}
                                </span>
                            )}
                        </>
                    }
                    confirmLabel={tAdmin('writeLadder.widenTo', { mode: tAdmin(`writeLadder.mode.${pending}`) })}
                    onConfirm={() => setMode(pending)}
                />
            )}
        </div>
    );
}
