'use client';

/**
 * One ladder's rung, and the controls that move it: the card both the identity
 * write ladder and the agent owner-orphan pass render (#3807).
 *
 * The two ladders are one ladder (`src/lib/identity/write-ladder.ts`): the same
 * rungs, the same seven-day dwell, the same OWNER key. Two ladders that do the
 * same thing to different systems should not look different, so they share
 * this card rather than each spelling the controls out — the widen control is
 * declared once, here.
 *
 * Three rules this card holds for every ladder that uses it:
 *
 * 1. **Show the refusal, not just the disabled button.** The server returns a
 *    `blockedReason` for the next rung so a control can explain itself.
 *    Greying one out with no reason is how an operator concludes the feature is
 *    broken and goes looking for a bug that is not there.
 * 2. **Narrowing is one click and never confirmed.** Widening grants standing
 *    authority and the caller confirms it; narrowing takes it away and is the
 *    emergency stop. A dialog in front of the stop is a reason to hesitate at
 *    the moment nobody should.
 * 3. **Only the NEXT rung is offered, never a jump.** The usecase refuses skips
 *    and enforces the dwell; this surfaces those rules rather than
 *    re-implementing them, so there is one place they can be wrong.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { LADDER, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@inflect/ui/lib/format-date';

/** Authority rises left to right, so the badge should too. */
const MODE_VARIANT: Record<IdentityWriteMode, StatusBadgeVariant> = {
    DISABLED: 'neutral',
    DRY_RUN: 'info',
    AUTOMATIC: 'error',
};

export interface LadderRungCardProps {
    /** The heading's id, which names the card's region for assistive technology. */
    headingId: string;
    title: string;
    blurb: string;
    mode: IdentityWriteMode;
    dryRunSince: string | null;
    dryRunMinDays: number;
    nextMode: IdentityWriteMode | null;
    /** The server's sentence for why the next rung is refused, if it is. */
    blockedReason: string | null;
    /**
     * Whether to print `blockedReason` beside the control. A ladder that already
     * says why in a notice of its own passes `false`, so the card never carries
     * two messages for one reason.
     */
    showBlockedReason?: boolean;
    /** A reason the caller knows of to refuse the widen, beside `blockedReason`. */
    widenRefused?: boolean;
    /** Ladder-specific notices, shown under the blurb. */
    notices?: ReactNode;
    saving: boolean;
    /** Opens the caller's confirmation. The card never widens on one click. */
    onWiden: (mode: IdentityWriteMode) => void;
    onNarrow: (mode: IdentityWriteMode) => void;
    /** Extra content under the controls. */
    children?: ReactNode;
}

export function LadderRungCard({
    headingId,
    title,
    blurb,
    mode,
    dryRunSince,
    dryRunMinDays,
    nextMode,
    blockedReason,
    showBlockedReason = true,
    widenRefused = false,
    notices,
    saving,
    onWiden,
    onNarrow,
    children,
}: LadderRungCardProps) {
    const t = useTranslations('admin');
    const current = LADDER.indexOf(mode);
    const previous = current > 0 ? LADDER[current - 1] : null;

    // A LABELLED REGION, not a bare card. A page can hold two of these whose
    // buttons carry the same words ("Widen to Dry run" in both when both sit at
    // Off); without a named landmark a screen-reader user hears the second set
    // of controls with nothing to say which system they govern.
    return (
        <section aria-labelledby={headingId}>
            <Card className="space-y-default p-6">
                <div className="flex items-center justify-between gap-default">
                    <Heading level={2} id={headingId}>
                        {title}
                    </Heading>
                    <StatusBadge variant={MODE_VARIANT[mode]}>{t(`writeLadder.mode.${mode}`)}</StatusBadge>
                </div>

                <p className="max-w-3xl text-sm text-content-muted">{blurb}</p>

                {notices}

                {dryRunSince && (
                    <p className="text-sm text-content-muted">
                        {t('writeLadder.dryRunSince', { date: formatDate(dryRunSince), days: dryRunMinDays })}
                    </p>
                )}

                <div className="flex flex-wrap items-center gap-default">
                    {nextMode ? (
                        <div className="flex flex-col gap-tight">
                            <Button
                                variant="primary"
                                // The control must not depend on a derived STRING
                                // arriving: a caller-known refusal disables it
                                // whatever `blockedReason` holds.
                                disabled={Boolean(blockedReason) || widenRefused || saving}
                                onClick={() => onWiden(nextMode)}
                            >
                                {t('writeLadder.widenTo', { mode: t(`writeLadder.mode.${nextMode}`) })}
                            </Button>
                            {showBlockedReason && blockedReason && (
                                // The reason, beside the control it disables. A
                                // dwell or one-rung refusal carries dates and rung
                                // names the client does not have, so the server's
                                // sentence is the right one.
                                <span className="max-w-md text-sm text-content-muted">{blockedReason}</span>
                            )}
                        </div>
                    ) : (
                        <span className="text-sm text-content-muted">{t('writeLadder.atTop')}</span>
                    )}

                    {previous && (
                        // No confirmation: narrowing removes authority.
                        <Button variant="secondary" disabled={saving} onClick={() => onNarrow(previous)}>
                            {t('writeLadder.narrowTo', { mode: t(`writeLadder.mode.${previous}`) })}
                        </Button>
                    )}
                </div>

                {children}
            </Card>
        </section>
    );
}
