"use client";

/**
 * Epic 49 + Roadmap-21 PR-C — `<CalendarHeatmap>`.
 *
 * GitHub-style activity heatmap (week columns × day rows). Each cell
 * represents one calendar day. R21-PR-C rebuilds the colouring on
 * the R21-PR-A `useHeatScale` foundation: a CONTINUOUS OKLAB ramp
 * driven by chart-series 1 (brand warm yellow/orange), replacing
 * the previous 5-bucket `getIntensityTone` step function. Cells
 * now interpolate smoothly across the activity range rather than
 * snapping to bucket thresholds.
 *
 * The Epic 49 bottom-strip legend (5 swatches between "Less" and
 * "More") is replaced by `<ChartLegend variant="gradient">` from
 * R21-PR-A — the legend gradient paints from the same tokens the
 * cells consume, so legend ↔ cells are visually continuous.
 *
 * One affordance refinement on top:
 *
 *   - Month separators — a soft vertical line between the last
 *     week of one month and the first of the next. Subtle (token-
 *     backed border-subtle alpha), but gives the eye a temporal
 *     anchor without a heavy axis.
 *
 * Sized to a 12-month look-back by default; the `from`/`to` props
 * adjust the rendered range. Bare HTML — no chart library
 * dependency. Token-styled, click-through (`onSelectDate` fires for
 * any clicked cell, populated or empty).
 *
 * Accessibility: every day is a labelled `<button>` carrying its
 * localized date + event count as its accessible name. The grid is a
 * single tab stop (ROVING TABINDEX) — one cell is `tabIndex={0}`
 * (today, else the first day), the rest `tabIndex={-1}` — and the
 * arrow keys walk the grid in its actual visual orientation:
 * Up/Down move ±1 day (a row within the week column), Left/Right
 * move ±7 days (an adjacent week column). Enter/Space select via the
 * native button click.
 */

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import type { CalendarEvent } from '@/app-layer/schemas/calendar.schemas';
import { ChartLegend, useHeatScale } from '@/components/ui/charts';
import { Tooltip } from '@/components/ui/tooltip';
import { formatDate, formatWeekdayShort } from '@/lib/format-date';

// ─── Public props ─────────────────────────────────────────────────────

export interface CalendarHeatmapProps {
    /** Events to bucket. Heatmap aggregates per-day count. */
    events: ReadonlyArray<CalendarEvent>;
    /** Inclusive range start (defaults to 12 months before `to`). */
    from?: Date;
    /** Inclusive range end (defaults to today). */
    to?: Date;
    /** Click handler — fires with the YYYY-MM-DD of the clicked cell. */
    onSelectDate?: (date: string) => void;
    /** ARIA label for the wrapping <figure>. */
    'aria-label'?: string;
    /** Forwarded for E2E selectors. */
    'data-testid'?: string;
    className?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function startOfUtcDay(d: Date): Date {
    return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
}

function toYMD(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): Date[] {
    const start = startOfUtcDay(from);
    const end = startOfUtcDay(to);
    const days: Date[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
        days.push(new Date(t));
    }
    return days;
}

// Sunday-first short weekday labels. 2023-01-01 (UTC) is a Sunday, so
// `i` maps 0→Sun … 6→Sat — the same row order the grid pads to. Sourced
// from the canonical `formatWeekdayShort` so they stay locale/UTC-pinned
// like every other date string, replacing the hand-rolled
// `['Sun', 'Mon', …]` array.
const WEEKDAY_LABELS: string[] = Array.from({ length: 7 }, (_, i) =>
    formatWeekdayShort(new Date(Date.UTC(2023, 0, 1 + i))),
);

// ─── Component ───────────────────────────────────────────────────────

export function CalendarHeatmap({
    events,
    from,
    to,
    onSelectDate,
    className,
    'aria-label': ariaLabel = 'Compliance activity heatmap',
    'data-testid': dataTestId = 'calendar-heatmap',
}: CalendarHeatmapProps) {
    // Default range: 12 months back from `to` (or from today).
    const rangeTo = to ?? new Date();
    const rangeFrom =
        from ??
        new Date(rangeTo.getTime() - 365 * DAY_MS);

    // Stabilise object identity for the dependency array — comparing
    // by `.getTime()` avoids re-running on every parent render that
    // happens to construct a new Date for the same instant.
    const fromMs = rangeFrom.getTime();
    const toMs = rangeTo.getTime();
    const days = React.useMemo(
        () => eachDay(rangeFrom, rangeTo),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- using ms-since-epoch as stable identity
        [fromMs, toMs],
    );

    const counts = React.useMemo(() => {
        const m = new Map<string, number>();
        for (const e of events) {
            const ymd = e.date.slice(0, 10);
            m.set(ymd, (m.get(ymd) ?? 0) + 1);
        }
        return m;
    }, [events]);

    const max = React.useMemo(() => {
        let m = 0;
        for (const v of counts.values()) if (v > m) m = v;
        return m;
    }, [counts]);

    // R21-PR-C — continuous OKLAB heat scale, series 1 (brand warm
    // yellow/orange — the canonical activity hue). The floor 0.15
    // keeps "no activity" cells faintly visible rather than vanishing
    // into the bg — same intent as the Epic 49 bucket-0 tone, just
    // continuous now.
    const heat = useHeatScale({
        domain: [0, Math.max(max, 1)],
        series: 1,
        idPrefix: 'calendar-heat',
    });

    const t = useTranslations('calendar');

    // ─── Roving tabindex ─────────────────────────────────────────────
    // Up to 546 day buttons must be ONE tab stop, not 546. Exactly one
    // cell is `tabIndex={0}` (the "roving" cell); arrow keys move DOM
    // focus + the roving index. Default the roving cell to today when
    // it's in range, else the first day.
    const defaultFocusIndex = React.useMemo(() => {
        const todayYmd = toYMD(startOfUtcDay(new Date()));
        const i = days.findIndex((d) => toYMD(d) === todayYmd);
        return i >= 0 ? i : 0;
    }, [days]);

    const [focusedIndex, setFocusedIndex] = React.useState(defaultFocusIndex);
    const gridRef = React.useRef<HTMLDivElement>(null);

    // Re-anchor the roving cell whenever the day set changes (range /
    // prop change) so it never points past the end of a shorter range.
    React.useEffect(() => {
        setFocusedIndex(defaultFocusIndex);
    }, [defaultFocusIndex]);

    // Move the roving index to `index` (clamped into range) and pull DOM
    // focus to that day's button. The button already exists in the DOM
    // (only its tabIndex flips on the re-render), so `.focus()` lands
    // even before React commits.
    const focusDayAt = React.useCallback(
        (index: number) => {
            if (days.length === 0) return;
            const clamped = Math.max(0, Math.min(days.length - 1, index));
            setFocusedIndex(clamped);
            const ymd = toYMD(days[clamped]);
            gridRef.current
                ?.querySelector<HTMLButtonElement>(`button[data-ymd="${ymd}"]`)
                ?.focus();
        },
        [days],
    );

    // Arrow-key navigation matched to the ACTUAL layout orientation
    // (week columns × day rows): Up/Down step ±1 day (a row within the
    // column), Left/Right step ±7 days (an adjacent week column).
    // Home/End jump to the range ends. Enter/Space are left to the
    // native button click (which already calls onSelectDate).
    const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        let next: number;
        switch (e.key) {
            case 'ArrowUp':
                next = focusedIndex - 1;
                break;
            case 'ArrowDown':
                next = focusedIndex + 1;
                break;
            case 'ArrowLeft':
                next = focusedIndex - 7;
                break;
            case 'ArrowRight':
                next = focusedIndex + 7;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = days.length - 1;
                break;
            default:
                return;
        }
        e.preventDefault();
        focusDayAt(next);
    };

    // Guarantee exactly one tabbable cell even during the render before
    // the re-anchor effect runs.
    const rovingIndex =
        days.length > 0
            ? Math.max(0, Math.min(focusedIndex, days.length - 1))
            : -1;

    // Group days into 7-row × N-column grid. We pad the start so the
    // first column begins on a Sunday (UTC day index 0).
    const padStart = days.length > 0 ? days[0].getUTCDay() : 0;
    const padded: (Date | null)[] = [
        ...Array.from<null>({ length: padStart }).fill(null),
        ...days,
    ];
    while (padded.length % 7 !== 0) padded.push(null);
    const weeks: (Date | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) {
        weeks.push(padded.slice(i, i + 7));
    }

    // R21-PR-C — derive month-boundary flag per week. A week column
    // gets `data-month-start` when its first non-null day's month
    // differs from the previous week's first non-null day's month.
    // CSS paints a 1px left border on that column → subtle month
    // separator without a heavy axis.
    const weekMonthStart: boolean[] = weeks.map((week, i) => {
        if (i === 0) return false;
        const firstThisWeek = week.find((d): d is Date => d !== null);
        const firstPrevWeek = weeks[i - 1].find((d): d is Date => d !== null);
        if (!firstThisWeek || !firstPrevWeek) return false;
        return firstThisWeek.getUTCMonth() !== firstPrevWeek.getUTCMonth();
    });

    return (
        <figure
            className={cn('flex flex-col gap-tight', className)}
            aria-label={ariaLabel}
            data-testid={dataTestId}
        >
            <div className="flex gap-tight">
                {/* Row labels (only show every other row to save space). */}
                <div className="flex flex-col gap-[2px] pt-[14px] text-[10px] text-content-muted select-none">
                    {WEEKDAY_LABELS.map((label, i) => (
                        <span
                            key={i}
                            className={cn(
                                'h-[10px] leading-[10px]',
                                i % 2 === 0 && 'opacity-0',
                            )}
                        >
                            {label}
                        </span>
                    ))}
                </div>

                {/* Heatmap grid — one roving tab stop; arrow keys walk it. */}
                <div
                    ref={gridRef}
                    onKeyDown={onGridKeyDown}
                    className="flex gap-[2px] overflow-x-auto"
                >
                    {weeks.map((week, weekIdx) => (
                        <div
                            key={weekIdx}
                            data-month-start={
                                weekMonthStart[weekIdx] ? 'true' : undefined
                            }
                            className={cn(
                                'flex flex-col gap-[2px]',
                                // R21-PR-C — month separator. Subtle 1px
                                // tone-shift on the left edge of any week
                                // that starts a new month. Token-backed so
                                // it adapts to dark/light theme.
                                weekMonthStart[weekIdx] &&
                                    'pl-[2px] border-l border-border-subtle/60',
                            )}
                        >
                            {week.map((day, dayIdx) => {
                                if (!day) {
                                    return (
                                        <span
                                            key={dayIdx}
                                            className="h-[10px] w-[10px]"
                                            aria-hidden="true"
                                        />
                                    );
                                }
                                const ymd = toYMD(day);
                                const count = counts.get(ymd) ?? 0;
                                const intensity = heat.intensityFor(count);
                                // Flat chronological index of this day —
                                // paddedIndex (weekIdx*7 + dayIdx) minus the
                                // leading Sunday pad. Drives roving tabindex +
                                // arrow-key focus.
                                const flatIdx = weekIdx * 7 + dayIdx - padStart;
                                // Accessible name + tooltip: the localized date
                                // plus an ICU-pluralized event count (covers 0,
                                // 1, N in every locale). The colour encodes only
                                // this count/intensity, so the count text is the
                                // full non-colour equivalent — no category is
                                // colour-coded here.
                                const label = `${formatDate(day)}: ${t('eventCount', { count })}`;
                                return (
                                    <Tooltip key={dayIdx} content={label}>
                                        <button
                                            type="button"
                                            onClick={() => onSelectDate?.(ymd)}
                                            onFocus={() =>
                                                setFocusedIndex(flatIdx)
                                            }
                                            tabIndex={
                                                flatIdx === rovingIndex ? 0 : -1
                                            }
                                            aria-label={label}
                                            data-ymd={ymd}
                                            data-count={count}
                                            data-intensity={intensity.toFixed(2)}
                                            className={cn(
                                                'h-[10px] w-[10px] rounded-[2px]',
                                                'transition-[background-color,outline-color] duration-150',
                                                'hover:ring-1 hover:ring-content-emphasis/40',
                                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                                            )}
                                            style={{
                                                background: heat.colorFor(count),
                                            }}
                                        />
                                    </Tooltip>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            {/* R21-PR-C: shared gradient legend, painted from the same
                tokens the cells consume — visually continuous. */}
            <figcaption className="flex justify-end">
                <ChartLegend
                    variant="gradient"
                    heatScale={heat}
                    label="Activity"
                    unit=""
                />
            </figcaption>
        </figure>
    );
}
