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
import { PageHeader } from '@/components/layout/PageHeader';
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
import type { OrphanPassModeRefusal } from '@/app-layer/usecases/agent-owner-orphan-policy';

import { AgentsViewsMenu, type AgentsViewsMenuProps } from '../AgentsViewsMenu';

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
    /** The same refusal as a code and its arguments, which this page words (#4903). */
    blockedRefusal?: OrphanPassModeRefusal | null;
    dryRunMinDays: number;
    maxMode: IdentityWriteMode;
    passes: PassRow[];
    /** Agent id → name, for the agents the listed passes decided about (#4903). */
    agentNames?: Record<string, string>;
}

const STATUS_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    PASSED: 'success',
    PARTIAL: 'warning',
    NOT_APPLICABLE: 'neutral',
    ERROR: 'error',
};

/**
 * The codes this page has words for (#4903). Each list is the union its
 * writer declares; a code outside it is shown as stored, never guessed at.
 */
const KNOWN_PASS_STATUS = new Set(Object.keys(STATUS_VARIANT));
const KNOWN_MODES = new Set(['DISABLED', 'DRY_RUN', 'AUTOMATIC']);
const KNOWN_SIGNALS = new Set(['MEMBERSHIP_NOT_ACTIVE', 'HR_TERMINATED']);
const KNOWN_MEMBERSHIP = new Set(['INVITED', 'DEACTIVATED', 'REMOVED', 'ABSENT']);
/** `ServicePrincipalDisableStatus` in `@/lib/agentic/service-principal-disable`. */
const KNOWN_SP_STATUS = new Set([
    'NOT_LINKED',
    'AMBIGUOUS_LINK',
    'NO_PAIRED_ENDPOINT',
    'AMBIGUOUS_PAIRED_ENDPOINT',
    'CONNECTION_UNUSABLE',
    'RUNG_DISABLED',
    'LINK_UNCONFIRMED',
    'NO_APPROVED_TEMPLATE',
    'AMBIGUOUS_TEMPLATE',
    'NOT_IN_POPULATION',
    'PRIOR_STATE_UNREADABLE',
    'ALREADY_DISABLED',
    'RECORDED_INTENT',
    'PROPOSED',
    'QUARANTINED',
    'QUEUED',
    'REFUSED',
    'FAILED',
]);

function PassBlock({ pass, agentNames }: { pass: PassRow; agentNames: Readonly<Record<string, string>> }) {
    const tPass = useTranslations('agents');
    // Its own name, not `tAdmin`: the i18n key guard binds each translator by
    // identifier, and the page component below already binds `tAdmin`.
    const tLadder = useTranslations('admin');
    const tenantHref = useTenantHref();
    const result = pass.resultJson ?? {};
    const decisions = result.decisions ?? [];
    const modeLabel = (mode: string) => (KNOWN_MODES.has(mode) ? tLadder(`writeLadder.mode.${mode}`) : mode);
    const signalLabel = (s: { kind: string; membership?: string }) => {
        if (!KNOWN_SIGNALS.has(s.kind)) return s.kind;
        if (s.kind === 'MEMBERSHIP_NOT_ACTIVE') {
            const state =
                s.membership && KNOWN_MEMBERSHIP.has(s.membership)
                    ? tPass(`orphanPass.membership.${s.membership}`)
                    : (s.membership ?? '');
            return tPass('orphanPass.signal.MEMBERSHIP_NOT_ACTIVE', { state });
        }
        return tPass(`orphanPass.signal.${s.kind}`);
    };
    return (
        <li className="space-y-compact border-t border-border-subtle pt-default" data-testid={`orphan-pass-${pass.id}`}>
            <div className="flex flex-wrap items-center gap-compact">
                <span className="text-sm font-medium text-content-emphasis">{formatDateTime(pass.executedAt)}</span>
                <StatusBadge variant={STATUS_VARIANT[pass.status] ?? 'neutral'} size="sm">
                    {KNOWN_PASS_STATUS.has(pass.status) ? tPass(`orphanPass.passStatus.${pass.status}`) : pass.status}
                </StatusBadge>
                {result.mode && (
                    <span className="text-xs text-content-muted">
                        {tPass('orphanPass.passMode', { mode: modeLabel(result.mode) })}
                    </span>
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
                            {/* By NAME, with the id kept as the link target
                                (#4903). A pass records ids only; an agent the
                                register no longer holds is shown by its id. */}
                            <Link href={tenantHref(`/agents/${d.agentId}`)} className="text-content-emphasis underline">
                                {agentNames[d.agentId] ?? d.agentId}
                            </Link>
                            <span>{tPass(`orphanPass.outcome.${d.outcome}`)}</span>
                            {(d.signals ?? []).map((s) => (
                                <span key={`${s.kind}-${s.membership ?? ''}`} className="text-content-muted">
                                    {signalLabel(s)}
                                </span>
                            ))}
                            {d.servicePrincipal && d.servicePrincipal.status !== 'NOT_CONTAINED' && (
                                <span className="text-content-muted">
                                    {KNOWN_SP_STATUS.has(d.servicePrincipal.status)
                                        ? tPass(`orphanPass.servicePrincipalStatus.${d.servicePrincipal.status}`)
                                        : tPass('orphanPass.servicePrincipal', { status: d.servicePrincipal.status })}
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

export function OwnerOrphanPassClient({
    menu,
}: {
    /** The views menu, rendered in the page header rather than a row of its own (#4903). */
    menu?: Omit<AgentsViewsMenuProps, 'current'>;
} = {}) {
    const t = useTranslations('agents');
    const tAdmin = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { data, error, isLoading, mutate } = useTenantSWR<OrphanPassPayload>('/admin/agents/owner-orphan-pass');

    const [pending, setPending] = useState<IdentityWriteMode | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const modeLabel = (mode: string) =>
        ['DISABLED', 'DRY_RUN', 'AUTOMATIC'].includes(mode) ? tAdmin(`writeLadder.mode.${mode}`) : mode;
    /**
     * The reason a widen is blocked, worded here from its code (#4903). The
     * server's English sentence carried mode codes and was not translated; it
     * stays only as the fallback for a code this build does not know.
     */
    const blockedReason = (payload: OrphanPassPayload): string | null => {
        const r = payload.blockedRefusal;
        if (!r) return payload.blockedReason;
        switch (r.code) {
            case 'ABOVE_CLAMP':
                return t('orphanPass.blocked.ABOVE_CLAMP', { next: modeLabel(r.next), clamp: modeLabel(r.clamp) });
            case 'MULTI_RUNG':
                return t('orphanPass.blocked.MULTI_RUNG', { from: modeLabel(r.from), to: modeLabel(r.to) });
            case 'NO_DRY_RUN_START':
                return t('orphanPass.blocked.NO_DRY_RUN_START', { mode: modeLabel('DRY_RUN') });
            case 'TOO_FEW_PASSES':
                return t('orphanPass.blocked.TOO_FEW_PASSES', { passes: r.passes, required: r.required });
            case 'DWELL':
                return t('orphanPass.blocked.DWELL', { days: r.days, required: r.required, left: r.left });
            default:
                return payload.blockedReason;
        }
    };

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
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('orphanPass.crumbAgents'), href: tenantHref('/agents') },
                    { label: t('orphanPass.title') },
                ]}
                title={t('orphanPass.title')}
                description={t('orphanPass.intro')}
                actions={menu ? <AgentsViewsMenu {...menu} current="owner-orphan-pass" /> : undefined}
            />

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
                        blockedReason={blockedReason(data)}
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
                                    <PassBlock key={p.id} pass={p} agentNames={data.agentNames ?? {}} />
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
