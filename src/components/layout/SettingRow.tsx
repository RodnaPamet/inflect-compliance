/**
 * `<SettingRow>` — a title (and description) with a trailing control.
 *
 * The shape of every settings-style row: a name and a sentence on the left, a
 * button, toggle or status on the right. Hand-rolled, it was always
 * `flex items-start justify-between` with a text block that could not shrink
 * (no `min-w-0`) and a control cluster that could not wrap. On a phone that
 * either pushed the control past the right edge, where the shell's
 * `overflow-x-clip` cut it off, or squeezed the title to one word per line
 * beside it (#5874).
 *
 * Phone (below `sm`) — a column
 *   The text block takes the full width and the control sits on its own line
 *   underneath, left-aligned at its natural width. The control cluster wraps,
 *   so two long Bulgarian button labels stack rather than run off the screen.
 *
 * From `sm` up — the row it always was
 *   Text on the left (`min-w-0 flex-1`, so a long word can no longer push the
 *   control out), the control on the right (`shrink-0`), aligned per `align`.
 *
 * Slots
 *   - `leading`         an icon or avatar before the text; stays beside it on a phone.
 *   - `title`           the row's name: a `<Heading>` or a `<span>`/`<Label>`.
 *   - `titleAdornment`  a badge or info tooltip beside the title; wraps under
 *                       it when the line is full.
 *   - `description`     one muted sentence under the title (a `<p>`, so pass
 *                       phrasing content only).
 *   - `children`        anything else in the text column, under the description.
 *   - `control`         the trailing button(s), toggle or status.
 *
 * Spacing is set by the `gap`, `titleGap`, `controlGap` and `textSpacing`
 * props, never by a `className` override (see `ROW_GAP_CLASS`).
 *
 * It owns geometry only. The container (a `ShadedRow`, a `Card`, a bare
 * `<header>`) stays the caller's, so the row drops into whatever already
 * frames it.
 */
import * as React from 'react';
import { cn } from '@inflect/ui/lib/cn';

export type SettingRowAlign = 'start' | 'center' | 'end';

/** The cross-axis alignment from `sm` up. Below `sm` the row is a column. */
const ALIGN_CLASS: Record<SettingRowAlign, string> = {
    start: 'sm:items-start',
    center: 'sm:items-center',
    end: 'sm:items-end',
};

/*
 * Spacing is chosen by prop, never by overriding a class: `cn`'s tailwind-merge
 * does not know the semantic spacing scale, so `gap-tight` and a caller's
 * `gap-compact` would both survive and the stylesheet's order would decide.
 */
export type SettingRowGap = 'tight' | 'compact' | 'default';

/** The gap between the text and the control from `sm` up. */
const ROW_GAP_CLASS: Record<SettingRowGap, string> = {
    tight: 'sm:gap-tight',
    compact: 'sm:gap-compact',
    default: 'sm:gap-default',
};

/** The gap inside the title line and inside the control cluster. */
const CLUSTER_GAP_CLASS: Record<SettingRowGap, string> = {
    tight: 'gap-tight',
    compact: 'gap-compact',
    default: 'gap-default',
};

/** The vertical rhythm of the text column (title, description, children). */
export type SettingRowTextSpacing = 'none' | 'micro' | 'tight';
const TEXT_SPACING_CLASS: Record<SettingRowTextSpacing, string> = {
    none: '',
    micro: 'space-y-1',
    tight: 'space-y-tight',
};

export interface SettingRowProps
    extends Omit<React.HTMLAttributes<HTMLElement>, 'title' | 'children'> {
    title: React.ReactNode;
    titleAdornment?: React.ReactNode;
    description?: React.ReactNode;
    leading?: React.ReactNode;
    control?: React.ReactNode;
    children?: React.ReactNode;
    /** Cross-axis alignment from `sm` up. Default `start`. */
    align?: SettingRowAlign;
    /** Gap between the text and the control from `sm` up. Default `default`. */
    gap?: SettingRowGap;
    /** Gap between the title and its adornment. Default `tight`. */
    titleGap?: SettingRowGap;
    /** Gap between the controls in the cluster. Default `tight`. */
    controlGap?: SettingRowGap;
    /** Vertical rhythm of the text column. Default `tight`. */
    textSpacing?: SettingRowTextSpacing;
    /** The root element. Default `div`; a page header passes `header`. */
    as?: 'div' | 'header' | 'section' | 'li';
    /** Extra classes on the text column (not spacing: see `textSpacing`). */
    textClassName?: string;
    /** Extra classes on the description (`max-w-none` lifts the reading measure). */
    descriptionClassName?: string;
}

export function SettingRow({
    title,
    titleAdornment,
    description,
    leading,
    control,
    children,
    align = 'start',
    gap = 'default',
    titleGap = 'tight',
    controlGap = 'tight',
    textSpacing = 'tight',
    as: Root = 'div',
    className,
    textClassName,
    descriptionClassName,
    ...rest
}: SettingRowProps) {
    const text = (
        <div
            className={cn('min-w-0 flex-1', TEXT_SPACING_CLASS[textSpacing], textClassName)}
            data-slot="setting-row-text"
        >
            {titleAdornment ? (
                <div
                    className={cn('flex min-w-0 flex-wrap items-center', CLUSTER_GAP_CLASS[titleGap])}
                    data-slot="setting-row-title"
                >
                    {title}
                    {titleAdornment}
                </div>
            ) : (
                <div className="min-w-0" data-slot="setting-row-title">
                    {title}
                </div>
            )}
            {description !== undefined && description !== null && (
                <p
                    className={cn('max-w-3xl text-sm text-content-muted', descriptionClassName)}
                    data-slot="setting-row-description"
                >
                    {description}
                </p>
            )}
            {children}
        </div>
    );

    return (
        <Root
            className={cn(
                'flex flex-col items-stretch gap-compact sm:flex-row sm:justify-between',
                ROW_GAP_CLASS[gap],
                ALIGN_CLASS[align],
                className,
            )}
            {...rest}
        >
            {leading ? (
                <div
                    className={cn(
                        'flex min-w-0 flex-1 items-start gap-compact',
                        align === 'center' && 'sm:items-center',
                    )}
                    data-slot="setting-row-lead"
                >
                    <div className="shrink-0">{leading}</div>
                    {text}
                </div>
            ) : (
                text
            )}
            {control !== undefined && control !== null && control !== false && (
                <div
                    className={cn(
                        'flex flex-wrap items-center self-start sm:shrink-0',
                        CLUSTER_GAP_CLASS[controlGap],
                        align === 'center' && 'sm:self-center',
                        align === 'end' && 'sm:self-end',
                    )}
                    data-slot="setting-row-control"
                >
                    {control}
                </div>
            )}
        </Root>
    );
}
