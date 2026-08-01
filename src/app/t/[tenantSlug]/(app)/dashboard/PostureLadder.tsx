'use client';

/**
 * `<PostureLadder>` — the six components, rated against the five-rung
 * ladder, with the counts each rating came from.
 *
 * This is the half of the hero that makes the radar checkable. The chart
 * shows the SHAPE (which spoke is short); this says what each spoke is
 * worth and on what evidence: `measured / total` is the fraction the
 * score came from, so a reader can divide two numbers printed on the
 * page and get the percentage back, then read the level off the same
 * published cut-points. Nothing in the hero is a figure that has to be
 * taken on trust.
 *
 * Rendered by BOTH hero branches — the posture card and the coverage
 * fallback — because the ratings come from the executive payload, not
 * from the AI narrative. A tenant should not see a different level
 * depending on whether a summary has been generated yet.
 */
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';
import type { PostureAxisRating, PostureLevel } from '@/lib/charts/posture-radar';

/**
 * Rung → tone. Deliberately only four tones across five rungs: the bottom
 * two need attention, the middle is neutral, and the top two are fine.
 * Five distinct colours would imply a precision the ladder does not
 * claim. Level 5 is the only one that means "nothing left to fix", so it
 * is the only one that gets the confident tone on its own.
 */
export const LEVEL_TONE: Record<PostureLevel, string> = {
    1: 'text-content-error',
    2: 'text-content-warning',
    3: 'text-content-emphasis',
    4: 'text-content-success',
    5: 'text-content-success',
};

export interface PostureLadderProps {
    ratings: readonly PostureAxisRating[];
    className?: string;
}

export function PostureLadder({ ratings, className }: PostureLadderProps) {
    const t = useTranslations('dashboard');
    if (ratings.length === 0) return null;

    return (
        <ul
            className={cn('grid grid-cols-2 gap-x-default gap-y-0.5', className)}
            data-posture-ladder
        >
            {ratings.map((r) => (
                <li
                    key={r.key}
                    // `min-w-0` is what makes the label's `truncate` work:
                    // without it a grid item takes its content's min-content
                    // width and the row overflows its column instead.
                    className="flex min-w-0 items-baseline justify-between gap-tight text-[11px]"
                    data-posture-axis={r.key}
                    data-posture-axis-level={r.level}
                >
                    <span className="truncate text-content-muted">{r.label}</span>
                    <span className="shrink-0 tabular-nums text-content-subtle">
                        {/* No estate on this axis ⇒ no rating to show. A
                            tenant with no vendors is neither good nor bad at
                            vendors, and printing "0/0 · L5" would be a claim
                            about something it does not do. */}
                        {r.total > 0 ? `${r.measured}/${r.total}` : t('hero.ladderNoEstate')}
                        {r.level !== null && (
                            <span className={cn('ml-1.5 font-semibold', LEVEL_TONE[r.level])}>
                                {t('hero.levelShort', { level: r.level })}
                            </span>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}
