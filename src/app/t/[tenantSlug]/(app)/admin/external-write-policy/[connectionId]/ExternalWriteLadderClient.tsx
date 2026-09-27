'use client';

/**
 * The external-write ladder for one MCP connection — how far an agent may go
 * when driving a write to a customer's own third-party system (#2861).
 *
 * ## Why this page exists at all, and why it ships WITH the route
 *
 * The identity equivalent is the cautionary tale, and its own docstring says it:
 * "The route has existed since the ladder shipped; nothing in the product called
 * it. So the only way to move a tenant from DISABLED to DRY_RUN was a hand-made
 * HTTP request from someone holding an OWNER session — which meant the mandated
 * seven-day observation could not be STARTED through the product."
 *
 * That is the same shape as defect #3 of the 2026-09-26 chain, where the
 * external-tool approval API shipped with no UI and approving required a
 * hand-written `fetch` in a browser console. A control reachable only by curl is
 * a column with governance prose attached. So this lands beside the route rather
 * than after it.
 *
 * ## What it must do that a generic settings form would not
 *
 * 1. **Show the refusal, not just the disabled button.** The GET returns a reason
 *    per rung precisely so a control can explain itself. Greying one out with no
 *    reason is how an operator concludes the feature is broken and goes looking
 *    for a bug that is not there.
 *
 * 2. **Narrowing is one click and never confirmed.** Widening grants standing
 *    authority to change something in a system that is not ours; narrowing takes
 *    it away and is the emergency stop. A dialog in front of the stop is a reason
 *    to hesitate at the moment nobody should. The asymmetry is deliberate.
 *
 * 3. **Say when a rung is above what the runtime will honour.** `maxMode` is
 *    `DRY_RUN` because no dispatch reads the rung yet. A control that accepts a
 *    value the system silently ignores is worse than one that refuses — and this
 *    is the rung the server refuses too, so the page and the gate agree.
 *
 * It offers only the NEXT rung, never a jump, and reads every reason from the
 * server rather than recomputing one. The usecase already enforces the ordering,
 * the dwell, the evidence and the ceiling; this surfaces them so there is one
 * place they can be wrong.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

// Imported, never respelled. A local union of the same four strings is how a
// client keeps offering a rung the ladder has retired — the identity page states
// this exact hazard, having been built from a hand-written copy first.
// `external-write-ladder` carries no server imports, so a client can hold it.
import {
    LADDER,
    isAboveClamp,
    type ExternalWriteMode,
} from '@/lib/integrations/external-write-ladder';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatDate } from '@/lib/format-date';

/** Authority rises left to right, so the badge should too. */
const MODE_VARIANT: Record<ExternalWriteMode, StatusBadgeVariant> = {
    DISABLED: 'neutral',
    DRY_RUN: 'info',
    PROPOSE_ONLY: 'warning',
    AUTOMATIC: 'error',
};

interface PolicyPayload {
    connectionId: string;
    connectionName: string;
    mode: ExternalWriteMode;
    modeSince: string | null;
    evidenceInWindow?: number;
    maxMode: ExternalWriteMode;
    refusals: Record<string, string | null>;
    honoured: {
        maxMode: ExternalWriteMode;
        dispatchImplemented: boolean;
        minDays: number;
        minEvidence: Partial<Record<ExternalWriteMode, number>>;
    };
}

export function ExternalWriteLadderClient({ connectionId }: { connectionId: string }) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const path = `/admin/external-write-policy/${encodeURIComponent(connectionId)}`;
    const { data, error, isLoading, mutate } = useTenantSWR<PolicyPayload>(path);

    const [pending, setPending] = useState<ExternalWriteMode | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    /**
     * REJECTS on refusal, deliberately. `ConfirmDialog` closes when `onConfirm`
     * resolves and stays open when it rejects, so swallowing the failure here
     * would close the dialog over a refusal the operator never read. The widen
     * path renders the sentence inside the dialog; the narrow path has no dialog
     * and catches, reading the same message from the page-level notice.
     */
    const setMode = useCallback(
        async (mode: ExternalWriteMode) => {
            setSaving(true);
            setSaveError(null);
            try {
                const res = await fetch(apiUrl(path), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!res.ok) {
                    // The SERVER's sentence, not a generic failure. Every refusal
                    // this route raises names a date, a rung or a count the client
                    // does not have, and #2843 finding 31 is the record of what a
                    // refusal an operator can disprove costs.
                    const body = (await res.json().catch(() => null)) as { error?: string } | null;
                    const message = body?.error ?? t('externalWriteLadder.saveError');
                    setSaveError(message);
                    throw new Error(message);
                }
                await mutate();
                setPending(null);
            } finally {
                setSaving(false);
            }
        },
        [apiUrl, path, mutate, t],
    );

    if (error) {
        return (
            <div className="space-y-section">
                <BackAffordance />
                <InlineNotice variant="error">{t('externalWriteLadder.loadError')}</InlineNotice>
            </div>
        );
    }

    const current = data?.mode ?? null;
    const index = current ? LADDER.indexOf(current) : -1;
    const next = index >= 0 && index < LADDER.length - 1 ? LADDER[index + 1] : null;
    const previous = index > 0 ? LADDER[index - 1] : null;
    // The reason the SERVER gave for this rung, whatever it is. Read rather than
    // recomputed: the dwell arithmetic, the evidence count and the ceiling all
    // live server-side, and a second copy here is a second thing to be wrong.
    const nextRefusal = next && data ? (data.refusals[next] ?? null) : null;
    const nextAboveCeiling = next && data ? isAboveClamp(next, data.honoured.maxMode) : false;

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('externalTools.title'), href: tenantHref('/agents/external-tools') },
                    { label: t('externalWriteLadder.breadcrumb') },
                ]}
            />

            <Heading level={1}>{t('externalWriteLadder.title')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">{t('externalWriteLadder.intro')}</p>

            {saveError && <InlineNotice variant="error">{saveError}</InlineNotice>}

            {isLoading || !data ? (
                <p className="text-sm text-content-muted">{t('externalWriteLadder.loading')}</p>
            ) : (
                <Card className="space-y-default p-4" data-testid="external-write-ladder-card">
                    <div className="flex flex-wrap items-center gap-default">
                        <StatusBadge variant={MODE_VARIANT[data.mode]}>
                            {t(`externalWriteLadder.mode.${data.mode}`)}
                        </StatusBadge>
                        <span className="text-sm text-content-emphasis">{data.connectionName}</span>
                    </div>

                    {/* WHAT THE RUNTIME WILL ACTUALLY HONOUR. Rendered whenever the
                        dispatch is absent, because that is a standing fact about
                        the build rather than a transient refusal — and without it
                        an operator reads the two greyed rungs as a bug. */}
                    {!data.honoured.dispatchImplemented && (
                        <InlineNotice variant="info">
                            {t('externalWriteLadder.noDispatch', {
                                mode: t(`externalWriteLadder.mode.${data.honoured.maxMode}`),
                            })}
                        </InlineNotice>
                    )}

                    {data.modeSince && (
                        <p className="text-sm text-content-muted">
                            {t('externalWriteLadder.since', {
                                date: formatDate(data.modeSince),
                                days: data.honoured.minDays,
                            })}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-default">
                        {next ? (
                            <div className="flex flex-col gap-tight">
                                <Button
                                    variant="primary"
                                    // `nextAboveCeiling` is consulted as well as the
                                    // refusal STRING, not instead of it. The identity
                                    // page's own comment records why: a control that
                                    // depends on a derived string arriving sits
                                    // ENABLED the moment the server changes how it
                                    // words a refusal. A rung the runtime cannot
                                    // honour is not widenable whatever the text says.
                                    disabled={Boolean(nextRefusal) || nextAboveCeiling || saving}
                                    onClick={() => setPending(next)}
                                >
                                    {t('externalWriteLadder.widenTo', {
                                        mode: t(`externalWriteLadder.mode.${next}`),
                                    })}
                                </Button>
                                {/* The reason, beside the control it disables — but
                                    NOT when the ceiling notice above already says
                                    it, or the card shows two sentences making the
                                    same point in different words. */}
                                {!nextAboveCeiling && nextRefusal && (
                                    <span
                                        className="max-w-md text-sm text-content-muted"
                                        data-testid="external-write-ladder-refusal"
                                    >
                                        {nextRefusal}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-sm text-content-muted">
                                {t('externalWriteLadder.atTop')}
                            </span>
                        )}

                        {previous && (
                            // No confirmation. Narrowing removes authority and is
                            // the emergency stop; a dialog in front of it is a
                            // reason to hesitate at the moment nobody should.
                            <Button
                                variant="secondary"
                                disabled={saving}
                                onClick={() => void setMode(previous).catch(() => {})}
                            >
                                {t('externalWriteLadder.narrowTo', {
                                    mode: t(`externalWriteLadder.mode.${previous}`),
                                })}
                            </Button>
                        )}
                    </div>
                </Card>
            )}

            {pending && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => {
                        // Only ever called with `false` — the dialog is mounted on
                        // `pending`, so dismissing it drops the pending rung. The
                        // refusal goes with it: a stale one left on screen reads as
                        // a fresh verdict on whatever the operator does next.
                        setPending(null);
                        setSaveError(null);
                    }}
                    // `warning`, not `danger`. This repo reserves `danger` for the
                    // IRREVERSIBLE. Widening is reversible by construction —
                    // narrowing is always permitted and sits beside this button —
                    // and dressing a reversible act as an irreversible one spends
                    // the strongest signal the design has on the wrong thing.
                    tone="warning"
                    title={t('externalWriteLadder.confirmTitle', {
                        mode: t(`externalWriteLadder.mode.${pending}`),
                    })}
                    description={
                        <>
                            {t(`externalWriteLadder.confirmBody.${pending}`)}
                            {saveError && (
                                // A `span.block`, not an InlineNotice: the primitive
                                // renders `description` inside a <p>, and a div
                                // there is invalid nesting React reparents at
                                // runtime.
                                <span className="mt-compact block text-content-error">
                                    {saveError}
                                </span>
                            )}
                        </>
                    }
                    confirmLabel={t('externalWriteLadder.widenTo', {
                        mode: t(`externalWriteLadder.mode.${pending}`),
                    })}
                    onConfirm={() => setMode(pending)}
                />
            )}
        </div>
    );
}
