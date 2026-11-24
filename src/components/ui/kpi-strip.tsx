'use client';

/**
 * `<KpiStrip>` — a page's row of KPI tiles: a grid on a larger screen, one
 * scrolling strip that says it scrolls on a phone.
 *
 * Four tiles in a two-column grid, or six, or seven, filled a phone's whole
 * first screen before the first row of the list they summarise (#5895). The
 * owner's decision (2026-11-23) is a horizontal strip, so below `md` the tiles
 * sit in one row, each a fixed, compact width; from `md` up the same list is
 * the grid it always was.
 *
 * The switch is CSS only — the children render once, so an `id` a tile
 * carries (and an E2E selector on it) stays unique, nothing waits for a media
 * query on hydration, and the strip adds next to nothing to the bundle of
 * every list page that renders one:
 *
 *   - the list is `flex` and scrolls sideways below `md`, and is `md:grid`
 *     (with the caller's columns, e.g. `md:grid-cols-4`) from `md` up;
 *   - every direct child is `w-40`, does not shrink and takes `p-3` below
 *     `md`, so a `KpiFilterCard`, a dashboard metric card or a plain tile all
 *     come out compact without knowing they are in a strip;
 *   - a `KPIStat` value (`[data-metric-value]`) drops to `text-xl` below `md`.
 *
 * THE CUE. Below `md` the strip's end edge fades out (a CSS mask), so the
 * tile it cuts reads as "more this way"; a trailing spacer as wide as the fade
 * lets the last tile scroll fully clear of it. Four tiles of 160 px never fit
 * a 360-390 px phone, so the cue is there whenever the strip overflows.
 *
 * Deliberately no JavaScript beyond the label: every list page, and the
 * controls and risks detail routes through them, load this module, and those
 * routes sit at their bundle budgets. `ScrollCueStrip`'s measured fades and
 * chevron (and even an effect scrolling the selected tile into view) put them
 * over.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';

/**
 * The list's classes. Exported so a rendered test can hold the phone layout
 * (jsdom applies no media query, so the classes are what can be asserted).
 * The cue is the mask (the end edge fades) and the `after:` spacer, as wide as
 * the fade, that lets the last tile scroll clear of it.
 */
export const KPI_STRIP_LIST_CLASS =
    'scrollbar-hide flex gap-tight overflow-x-auto md:grid md:overflow-visible ' +
    'max-md:*:w-40 max-md:*:shrink-0 max-md:*:p-3 max-md:[&_[data-metric-value]]:text-xl ' +
    'max-md:[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)] ' +
    "max-md:after:w-8 max-md:after:shrink-0 max-md:after:content-['']";

export interface KpiStripProps {
    children: React.ReactNode;
    /** Names the group of figures; "Key figures" when omitted. */
    'aria-label'?: string;
    /** The grid's columns from `md` up, e.g. `md:grid-cols-4 lg:grid-cols-6`. */
    columns?: string;
    /** The grid's gap from `md` up (the strip's own is `gap-tight`). */
    gridGap?: 'md:gap-default' | 'md:gap-compact';
    className?: string;
    id?: string;
    'data-testid'?: string;
}

export function KpiStrip({
    children,
    'aria-label': ariaLabel,
    columns = 'md:grid-cols-4',
    gridGap = 'md:gap-default',
    className,
    id,
    'data-testid': testId = 'kpi-strip',
}: KpiStripProps) {
    const t = useTranslations('ui.kpiStrip');
    return (
        <div
            role="group"
            aria-label={ariaLabel ?? t('label')}
            id={id}
            className={cn(KPI_STRIP_LIST_CLASS, gridGap, columns, className)}
            data-testid={testId}
        >
            {children}
        </div>
    );
}
