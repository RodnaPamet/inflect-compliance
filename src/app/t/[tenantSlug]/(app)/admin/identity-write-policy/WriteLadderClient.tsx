'use client';

/**
 * The identity write ladder — the control that decides whether this product may
 * disable or create accounts in a customer's own directory.
 *
 * ## Why it needed a page at all
 *
 * The route has existed since the ladder shipped; nothing in the product called
 * it. So the only way to move a tenant from DISABLED to DRY_RUN was a hand-made
 * HTTP request from someone holding an OWNER session — which meant the mandated
 * seven-day observation could not be STARTED through the product, and the
 * ladder's whole design argument (that widening must be a deliberate, reviewable
 * act) rested on folklore passed between operators.
 *
 * ## The three things this page must do that a generic settings form would not
 *
 * 1. **Show the refusal, not just the disabled button.** The GET returns
 *    `blockedReason` for each direction's next rung precisely so a control can
 *    explain itself. Greying one out with no reason is how an operator concludes
 *    the feature is broken and goes looking for a bug that is not there.
 *
 * 2. **Narrowing is one click and never confirmed.** Widening grants standing
 *    power over a customer's directory and is confirmed every time; narrowing
 *    takes it away and is the emergency stop. Putting a dialog in front of the
 *    stop is how you make someone hesitate at the moment they should not. The
 *    asymmetry is deliberate, not an oversight.
 *
 * 3. **Say when the rung is above what the runtime will honour.** The ladder is
 *    a statement of intent stored on the tenant; the leaver pass enforces its own
 *    clamp and refuses anything above it, and the joiner has no implementation at
 *    all. Both are perfectly settable here and both would then do nothing. A
 *    control that accepts a value the system ignores, silently, is worse than one
 *    that refuses.
 *
 * The page offers only the NEXT rung, never a jump. The usecase already refuses
 * skips and enforces the seven-day minimum — this surfaces those rules rather
 * than re-implementing them, so there is one place they can be wrong.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LADDER as SHARED_LADDER, isAboveClamp } from '@/lib/identity/write-ladder';

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

type Mode = 'DISABLED' | 'DRY_RUN' | 'PROPOSE' | 'AUTOMATIC';
type Direction = 'leaver' | 'joiner';

// Imported, not redeclared. This was a verbatim copy of the usecase's private
// LADDER, and the pass used a third form again (`!==`). Three encodings of one
// ordering that agreed only while the clamp sat at the second rung.
// `write-ladder` carries no server imports, so a client component can hold it.
const LADDER = SHARED_LADDER;

/** Authority rises left to right, so the badge should too. */
const MODE_VARIANT: Record<Mode, StatusBadgeVariant> = {
    DISABLED: 'neutral',
    DRY_RUN: 'info',
    PROPOSE: 'warning',
    AUTOMATIC: 'error',
};

interface DirectionState {
    mode: Mode;
    dryRunSince: string | null;
    nextMode: Mode | null;
    blockedReason: string | null;
}

interface LadderPayload {
    directions: Record<Direction, DirectionState>;
    dryRunMinDays: number;
    honoured: Record<Direction, { maxMode: Mode; implemented: boolean }>;
}

export function WriteLadderClient() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { data, error, isLoading, mutate } = useTenantSWR<LadderPayload>(
        '/admin/identity-write-policy',
    );

    const [pending, setPending] = useState<{ direction: Direction; mode: Mode } | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    /**
     * REJECTS on refusal, and that is load-bearing rather than sloppy.
     * `Modal.Confirm` closes itself when `onConfirm` resolves and keeps itself
     * open when it rejects — "so the caller can surface an error", in its own
     * words. Swallowing the failure here would resolve, so the dialog would
     * close over a refusal the operator never read; the widen path renders the
     * sentence inside the dialog instead. The narrow path has no dialog and
     * catches, reading the same message from the page-level notice.
     */
    const setMode = useCallback(
        async (direction: Direction, mode: Mode) => {
            setSaving(true);
            setSaveError(null);
            try {
                const res = await fetch(apiUrl('/admin/identity-write-policy'), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ direction, mode }),
                });
                if (!res.ok) {
                    // The usecase refuses with a SENTENCE — "cannot widen more
                    // than one rung", "must sit in DRY_RUN for 7 days". Showing
                    // it beats a generic failure, because the refusal is the
                    // answer to the question the operator is about to ask.
                    const body = (await res.json().catch(() => null)) as { error?: string } | null;
                    const message = body?.error ?? t('writeLadder.saveError');
                    setSaveError(message);
                    throw new Error(message);
                }
                setPending(null);
                setSaveError(null);
                await mutate();
            } finally {
                setSaving(false);
            }
        },
        [apiUrl, mutate, t],
    );

    const renderDirection = (direction: Direction) => {
        if (!data) return null;
        const state = data.directions[direction];
        const honoured = data.honoured[direction];
        const current = LADDER.indexOf(state.mode);
        const previous = current > 0 ? LADDER[current - 1] : null;
        // Above what the runtime will act on. Settable, and inert.
        const aboveClamp = isAboveClamp(state.mode, honoured.maxMode);

        // Each direction is a LABELLED REGION, not a bare card. Two structurally
        // identical blocks sit on this page whose buttons carry the same words —
        // "Widen to Dry run" appears in both when both sit at Off. Without a
        // named landmark a screen-reader user hears the second set of controls
        // with nothing to say which directory operation they govern, which on
        // this page is the difference between creating accounts and disabling
        // them.
        const headingId = `write-ladder-${direction}`;
        return (
            <section key={direction} aria-labelledby={headingId}>
                <Card className="space-y-default p-6">
                <div className="flex items-center justify-between gap-default">
                    <Heading level={2} id={headingId}>
                        {t(`writeLadder.direction.${direction}`)}
                    </Heading>
                    <StatusBadge variant={MODE_VARIANT[state.mode]}>
                        {t(`writeLadder.mode.${state.mode}`)}
                    </StatusBadge>
                </div>

                <p className="max-w-3xl text-sm text-content-muted">
                    {t(`writeLadder.blurb.${direction}`)}
                </p>

                {!honoured.implemented && (
                    <InlineNotice variant="warning">
                        {t('writeLadder.notImplemented')}
                    </InlineNotice>
                )}
                {honoured.implemented && aboveClamp && (
                    <InlineNotice variant="warning">
                        {t('writeLadder.aboveClamp', {
                            mode: t(`writeLadder.mode.${honoured.maxMode}`),
                        })}
                    </InlineNotice>
                )}

                {state.dryRunSince && (
                    <p className="text-sm text-content-muted">
                        {t('writeLadder.dryRunSince', {
                            date: formatDate(state.dryRunSince),
                            days: data.dryRunMinDays,
                        })}
                    </p>
                )}

                <div className="flex flex-wrap items-center gap-default">
                    {state.nextMode ? (
                        <div className="flex flex-col gap-tight">
                            <Button
                                variant="primary"
                                disabled={Boolean(state.blockedReason) || saving}
                                onClick={() =>
                                    setPending({ direction, mode: state.nextMode as Mode })
                                }
                            >
                                {t('writeLadder.widenTo', {
                                    mode: t(`writeLadder.mode.${state.nextMode}`),
                                })}
                            </Button>
                            {state.blockedReason && (
                                // The reason, beside the control it disables. This
                                // is the line the whole page exists for.
                                <span className="max-w-md text-sm text-content-muted">
                                    {state.blockedReason}
                                </span>
                            )}
                        </div>
                    ) : (
                        <span className="text-sm text-content-muted">{t('writeLadder.atTop')}</span>
                    )}

                    {previous && (
                        // No confirmation. Narrowing removes authority and is the
                        // emergency stop; a dialog in front of it is a reason to
                        // hesitate at the moment nobody should.
                        <Button
                            variant="secondary"
                            disabled={saving}
                            onClick={() => void setMode(direction, previous).catch(() => {})}
                        >
                            {t('writeLadder.narrowTo', {
                                mode: t(`writeLadder.mode.${previous}`),
                            })}
                        </Button>
                    )}
                </div>
                </Card>
            </section>
        );
    };

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('integrations.title'), href: tenantHref('/admin/integrations') },
                    { label: t('writeLadder.breadcrumb') },
                ]}
            />

            <Heading level={1}>{t('writeLadder.title')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">{t('writeLadder.intro')}</p>

            {saveError && <InlineNotice variant="error">{saveError}</InlineNotice>}

            {error ? (
                <InlineNotice variant="error">{t('writeLadder.loadError')}</InlineNotice>
            ) : isLoading ? (
                <p className="text-sm text-content-muted">{t('writeLadder.loading')}</p>
            ) : (
                <div className="space-y-default">
                    {(['leaver', 'joiner'] as const).map(renderDirection)}
                </div>
            )}

            {pending && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => {
                        // Only ever called with `false` here — the dialog is
                        // mounted on `pending`, so dismissing it means dropping
                        // the pending rung. The refusal goes with it: a stale
                        // "must sit in DRY_RUN for 7 days" left on screen after
                        // the operator walked away reads as a fresh verdict on
                        // whatever they do next.
                        setPending(null);
                        setSaveError(null);
                    }}
                    // `warning`, not `danger`. The tone semantics in this repo
                    // reserve `danger` for the IRREVERSIBLE — delete, revoke,
                    // rotate. Widening is reversible by construction: narrowing
                    // is always allowed and sits beside this button. Dressing a
                    // reversible act as an irreversible one spends the strongest
                    // signal the design has on the wrong thing, and leaves
                    // nothing louder for the acts that really cannot be undone.
                    tone="warning"
                    title={t('writeLadder.confirmTitle', {
                        mode: t(`writeLadder.mode.${pending.mode}`),
                    })}
                    description={
                        <>
                            {t(`writeLadder.confirmBody.${pending.mode}`)}
                            {saveError && (
                                // A `span.block`, not an InlineNotice: the
                                // primitive renders `description` inside a <p>,
                                // and a div in there is invalid nesting that
                                // React reparents at runtime.
                                <span className="mt-compact block text-content-error">
                                    {saveError}
                                </span>
                            )}
                        </>
                    }
                    confirmLabel={t('writeLadder.widenTo', {
                        mode: t(`writeLadder.mode.${pending.mode}`),
                    })}
                    onConfirm={() => setMode(pending.direction, pending.mode)}
                />
            )}
        </div>
    );
}
