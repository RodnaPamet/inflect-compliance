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
 *    all. The leaver is settable here; the joiner is not, since 2026-09-01 and both would then do nothing. A
 *    control that accepts a value the system ignores, silently, is worse than one
 *    that refuses.
 *
 * The page offers only the NEXT rung, never a jump. The usecase already refuses
 * skips and enforces the seven-day minimum — this surfaces those rules rather
 * than re-implementing them, so there is one place they can be wrong.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

import { LadderRungCard } from '@/components/admin/LadderRungCard';

// Imported, not respelled. This was a hand-written union of the same strings,
// which is how a client keeps offering a rung the ladder has retired: when
// PROPOSE was removed (#2241) a local copy would have gone on type-checking a
// `MODE_VARIANT` entry and a `writeLadder.mode.PROPOSE` lookup for a value the
// server can no longer send. Deriving it makes a retired rung a build error here.
type Mode = IdentityWriteMode;
type Direction = 'leaver' | 'joiner';

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
        // Above what the runtime will act on. Settable, and inert.
        const aboveClamp = isAboveClamp(state.mode, honoured.maxMode);

        return (
            <LadderRungCard
                key={direction}
                headingId={`write-ladder-${direction}`}
                title={t(`writeLadder.direction.${direction}`)}
                blurb={t(`writeLadder.blurb.${direction}`)}
                mode={state.mode}
                dryRunSince={state.dryRunSince}
                dryRunMinDays={data.dryRunMinDays}
                nextMode={state.nextMode}
                blockedReason={state.blockedReason}
                // Guarded on `implemented` so the unimplemented case shows
                // exactly ONE message. The notice below already states it, in
                // the operator's language, permanently; and `describeRefusal`
                // returns English prose interpolating the raw wire token, so
                // echoing it would put an untranslated paragraph under a
                // translated notice saying the same thing in different words.
                showBlockedReason={honoured.implemented}
                // `honoured.implemented` used to go unread here: the joiner's
                // widen control sat ENABLED beneath the notice saying the
                // subsystem does not exist. A direction the runtime cannot
                // honour is not widenable whatever `blockedReason` holds.
                widenRefused={!honoured.implemented}
                saving={saving}
                onWiden={(mode) => setPending({ direction, mode })}
                onNarrow={(mode) => void setMode(direction, mode).catch(() => {})}
                notices={
                    <>
                        {!honoured.implemented && (
                            <InlineNotice variant="warning">{t('writeLadder.notImplemented')}</InlineNotice>
                        )}
                        {honoured.implemented && aboveClamp && (
                            <InlineNotice variant="warning">
                                {t('writeLadder.aboveClamp', {
                                    mode: t(`writeLadder.mode.${honoured.maxMode}`),
                                })}
                            </InlineNotice>
                        )}
                    </>
                }
            />
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
