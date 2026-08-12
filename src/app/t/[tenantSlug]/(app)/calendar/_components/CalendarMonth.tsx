"use client";

/**
 * Epic 49 — <CalendarMonth>.
 *
 * Monthly calendar grid (7 columns × 6 fixed rows = 42 cells). Each
 * day cell shows up to N event dots colored by category. Clicking a
 * dot navigates to the event's `href`; clicking the day header
 * selects the day (caller can show a side panel of all events for
 * that day).
 *
 * Design choices:
 *   - Pure HTML/CSS grid — no chart library needed
 *   - Token-styled colors per category (single source of truth)
 *   - Sparse-data friendly: empty days render as plain cells
 *   - Overflow handled by collapsing extra events into a "+N more"
 *     pill that, when clicked, opens the same day-selection pane
 *   - Today's cell is highlighted with a token-driven ring, matched
 *     against the VIEWER'S LOCAL calendar day (not the UTC day) so a
 *     UTC−8 user late in the evening still sees the correct cell ringed
 *   - FIXED 6 rows every month so the grid height never jumps as the
 *     user pages between months
 *   - Full grid a11y: role=grid/row/gridcell/columnheader, a roving
 *     tabindex, arrow/Home/End keyboard navigation, per-cell aria-label
 *     summaries, and aria-current on today
 */

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import type {
    CalendarEvent,
    CalendarEventCategory,
} from '@/app-layer/schemas/calendar.schemas';
import { getCategoryTone } from '@/lib/design/status-tone';
import { formatDate, formatMonthYear, formatWeekdayShort } from '@/lib/format-date';
import { WEEK_STARTS_ON } from '@/components/ui/date-picker/week-start';
import { toYMD as toUtcYMD } from '@/components/ui/date-picker/date-utils';
import { categoryLabel } from '@/lib/calendar-labels';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';

// ─── Public props ─────────────────────────────────────────────────────

export interface CalendarMonthProps {
    /** First day of the month to render (any time within the month is OK). */
    month: Date;
    /** Events to plot. Must fall within the rendered month to be visible. */
    events: ReadonlyArray<CalendarEvent>;
    /** Maximum dots per cell before collapsing into "+N more". Default: 3. */
    maxDotsPerDay?: number;
    /** Fired when a day cell is selected (header or "+N more" click). */
    onSelectDate?: (date: string) => void;
    /**
     * PR-C — fired on DOUBLE-click of a day cell. The calendar page
     * wires this to a "create task with due=this-date" flow. The
     * default behaviour (no handler) keeps the existing
     * single-click select-only semantics unchanged.
     */
    onDoubleClickDate?: (date: string) => void;
    /**
     * Label for the per-day "+" create affordance (tooltip + aria-label).
     * Supplied by the caller so the copy stays in the page's i18n
     * catalog — this primitive holds no strings of its own.
     */
    newTaskLabel?: string;
    /**
     * The currently-selected day in `YYYY-MM-DD` form. B3 — the
     * matching cell renders a visible selected-state (brand ring +
     * brand-subtle background) so the click feels acknowledged.
     * Pre-B3 the cell click only updated the parent's `selectedDate`
     * state; the cell itself didn't change.
     */
    selectedYmd?: string | null;
    /**
     * The day to ring as "today", as `YYYY-MM-DD`.
     *
     * Supplied by the server (`CalendarResponse.todayYmd`) — the same civil day
     * the event statuses were classified against. It is NOT derived from the
     * browser clock: doing that gave the grid one definition of "today" and the
     * dot colours another, so a viewer west of the deployment zone could see an
     * event ringed on one cell and coloured overdue against a different day.
     */
    todayYmd?: string;
    /** Today override (for tests / stories) when `todayYmd` is not supplied. */
    today?: Date;
    className?: string;
    'data-testid'?: string;
}

// ─── Category token map ──────────────────────────────────────────────
//
// Polish PR-7 — calendar dot colour delegates to the shared
// `getCategoryTone` helper in `@/lib/design/status-tone`. The
// CalendarMonth / GanttTimeline / future calendar surfaces all read
// the same vocabulary.

// ─── Helpers ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Always render a fixed 6-row grid so the calendar height is stable. */
const TOTAL_CELLS = 42;

function startOfUtcMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * The viewer's LOCAL calendar day as `YYYY-MM-DD`.
 *
 * FALLBACK ONLY, for a caller that supplies neither `todayYmd` nor `today`.
 * The grid's cells are UTC-derived, so comparing a browser-local Y-M-D against
 * them is a second definition of "day" — which is the defect `todayYmd` exists
 * to remove. Prefer the server's day; this keeps a standalone render sane.
 */
function toLocalYMD(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Which weekday the grid starts on, shared with the date picker.
 *
 * These two render on the SAME page and disagreed: `date-picker/calendar.tsx`
 * defaults `weekStartsOn = 1` (Monday) while this grid hardcoded Sunday via a
 * bare `getUTCDay()`. Clicking a date in the picker and finding it in a
 * differently-aligned month grid is a small thing that makes a product feel
 * untrustworthy. One constant now, imported by both.
 */
// Weekday column headers, localized + SSR-safe via the shared formatter.
// 2023-01-01 (UTC) is a Sunday, so offsetting by WEEK_STARTS_ON walks the
// labels to the configured first day.
const WEEKDAY_HEADERS = Array.from({ length: 7 }, (_, i) =>
    formatWeekdayShort(new Date(Date.UTC(2023, 0, 1 + ((i + WEEK_STARTS_ON) % 7)))),
);

// ─── Component ───────────────────────────────────────────────────────

export function CalendarMonth({
    month,
    events,
    maxDotsPerDay = 3,
    onSelectDate,
    onDoubleClickDate,
    newTaskLabel = 'New task on this day',
    selectedYmd,
    todayYmd,
    today,
    className,
    'data-testid': dataTestId = 'calendar-month',
}: CalendarMonthProps) {
    const t = useTranslations('calendar');
    const todayDate = today ?? new Date();
    // Server day first — it is the day the dot colours mean. The local
    // derivation is only the standalone-render fallback.
    const todayLocalYmd = todayYmd ?? toLocalYMD(todayDate);
    const monthStart = startOfUtcMonth(month);
    const monthLabel = formatMonthYear(monthStart);

    // Bucket events by YYYY-MM-DD.
    const eventsByDay = React.useMemo(() => {
        const m = new Map<string, CalendarEvent[]>();
        for (const e of events) {
            const ymd = e.date.slice(0, 10);
            const list = m.get(ymd) ?? [];
            list.push(e);
            m.set(ymd, list);
        }
        // Stable order within a day — by category then title for
        // deterministic rendering.
        for (const list of m.values()) {
            list.sort(
                (a, b) =>
                    a.category.localeCompare(b.category) ||
                    a.title.localeCompare(b.title),
            );
        }
        return m;
    }, [events]);

    // Build the fixed 6×7 grid. Pad with leading days from the previous
    // month and trailing days from the next so every month renders as a
    // full 42-cell (6-row) rectangle — the height never jumps.
    // Days of blank padding before the 1st, relative to the configured week
    // start. `getUTCDay()` alone assumes Sunday and silently mis-aligns every
    // cell for any other start day.
    const padStart = (monthStart.getUTCDay() - WEEK_STARTS_ON + 7) % 7;
    const gridStartMs = monthStart.getTime() - padStart * DAY_MS;
    const cells: { date: Date; ymd: string; inMonth: boolean }[] = [];
    for (let i = 0; i < TOTAL_CELLS; i++) {
        const d = new Date(gridStartMs + i * DAY_MS);
        cells.push({
            date: d,
            // The shared helper is nullable (it validates its input); every
            // date here is arithmetic on a known-good month start, so the
            // fallback is unreachable — it exists so this stays total rather
            // than asserting non-null.
            ymd: toUtcYMD(d) ?? '',
            inMonth: d.getUTCMonth() === monthStart.getUTCMonth(),
        });
    }
    // Group the flat 42 cells into 6 week rows for `role="row"`.
    const weeks: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) {
        weeks.push(cells.slice(i, i + 7));
    }

    // ─── Roving tabindex + keyboard navigation (#12) ─────────────────
    //
    // Exactly one day cell is tabbable at a time. Default target: the
    // selected day, else today, else the first day OF THE MONTH. Once
    // the user arrows around, `activeIndex` takes over. Focus is moved
    // imperatively via `cellRefs` so arrow keys move DOM focus too.
    const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
    const cellRefs = React.useRef<Array<HTMLDivElement | null>>([]);

    // Reset the roving target when the visible month changes.
    const monthKey = `${monthStart.getUTCFullYear()}-${monthStart.getUTCMonth()}`;
    React.useEffect(() => {
        setActiveIndex(null);
    }, [monthKey]);

    const defaultRovingIndex = (() => {
        if (selectedYmd) {
            const i = cells.findIndex((c) => c.ymd === selectedYmd);
            if (i >= 0) return i;
        }
        const todayIdx = cells.findIndex((c) => c.ymd === todayLocalYmd);
        if (todayIdx >= 0) return todayIdx;
        const firstInMonth = cells.findIndex((c) => c.inMonth);
        return firstInMonth >= 0 ? firstInMonth : 0;
    })();
    const rovingIndex = activeIndex ?? defaultRovingIndex;

    function focusCell(index: number) {
        setActiveIndex(index);
        cellRefs.current[index]?.focus();
    }

    function handleCellKeyDown(
        e: React.KeyboardEvent<HTMLDivElement>,
        index: number,
        ymd: string,
    ) {
        // Only act when the cell itself is focused — never hijack keys
        // aimed at a focusable child (the add button, day-number button,
        // or an event link).
        if (e.target !== e.currentTarget) return;

        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onSelectDate?.(ymd);
            return;
        }

        let target: number;
        switch (e.key) {
            case 'ArrowRight':
                target = index + 1;
                break;
            case 'ArrowLeft':
                target = index - 1;
                break;
            case 'ArrowDown':
                target = index + 7;
                break;
            case 'ArrowUp':
                target = index - 7;
                break;
            case 'Home':
                target = index - (index % 7);
                break;
            case 'End':
                target = index - (index % 7) + 6;
                break;
            default:
                return;
        }
        e.preventDefault();
        if (target >= 0 && target < cells.length) focusCell(target);
    }

    return (
        // Self-contained tooltip scope — mirrors GanttTimeline /
        // RiskMatrixCell so this primitive renders correctly even when
        // mounted outside the app-root TooltipProvider (Storybook, tests,
        // isolated islands). Nested providers are valid; the app-root one
        // still governs delay-timer sharing everywhere else.
        <TooltipProvider>
        {/*
         * ARIA grid tree: role=grid (section) → rowgroup → row →
         * columnheader / gridcell. The header + day-grid stay as two
         * separate visual containers (they're each a `role="rowgroup"`)
         * so `role="row"` / `role="columnheader"` always have a valid
         * required parent — a lone `role="row"` outside a grid would
         * trip the a11y (axe) gate.
         */}
        <section
            role="grid"
            className={cn('flex flex-col gap-tight', className)}
            data-testid={dataTestId}
            aria-label={monthLabel}
        >
            {/* Weekday header */}
            <div
                role="rowgroup"
                className="grid grid-cols-7 gap-px text-xs font-medium text-content-muted"
            >
                {/* `display: contents` — the row stays in the a11y tree
                    while its cells participate in the parent CSS grid. */}
                <div role="row" className="contents">
                    {WEEKDAY_HEADERS.map((label, i) => (
                        <div
                            key={i}
                            role="columnheader"
                            className="text-center py-1"
                        >
                            {label}
                        </div>
                    ))}
                </div>
            </div>

            {/* Day grid */}
            <div
                role="rowgroup"
                className="grid grid-cols-7 gap-px bg-border-subtle rounded-lg overflow-hidden"
            >
                {weeks.map((week, wi) => (
                    // `display: contents` — the row is present in the
                    // accessibility tree but its cells still participate
                    // in the parent CSS grid.
                    <div key={`week-${wi}`} role="row" className="contents">
                        {week.map((cell, ci) => {
                            const index = wi * 7 + ci;
                            const ymd = cell.ymd;
                            const dayEvents = eventsByDay.get(ymd) ?? [];
                            const isToday = ymd === todayLocalYmd;
                            const visible = dayEvents.slice(0, maxDotsPerDay);
                            const overflow = dayEvents.length - visible.length;

                            // #12 — a screen-reader summary of the day's
                            // events. The visual dots are colour-only; this
                            // restates the same information as localized text
                            // ("3 events: 2 control, 1 risk").
                            const categoryCounts = new Map<
                                CalendarEventCategory,
                                number
                            >();
                            for (const ev of dayEvents) {
                                categoryCounts.set(
                                    ev.category,
                                    (categoryCounts.get(ev.category) ?? 0) + 1,
                                );
                            }
                            const summaryItems = Array.from(
                                categoryCounts,
                                ([cat, n]) =>
                                    t('dayCellCategorySummaryItem', {
                                        count: n,
                                        category: categoryLabel(t, cat),
                                    }),
                            );
                            const cellAriaLabel = t('dayCellAria', {
                                date: formatDate(cell.date),
                                count: dayEvents.length,
                                summary:
                                    summaryItems.length > 0
                                        ? `: ${summaryItems.join(', ')}`
                                        : '',
                            });

                            // v2-fu-6 — the entire cell is clickable, not
                            // just the day number. Inner `<Link>` / `<button>`
                            // handlers run instead when the click lands on
                            // them (guarded by the `closest` check).
                            const handleCellClick = onSelectDate
                                ? (e: React.MouseEvent<HTMLDivElement>) => {
                                      const target = e.target as HTMLElement;
                                      if (target.closest('a, button')) return;
                                      onSelectDate(ymd);
                                  }
                                : undefined;
                            const isSelected = selectedYmd === ymd;

                            return (
                                <div
                                    key={ymd}
                                    ref={(el) => {
                                        cellRefs.current[index] = el;
                                    }}
                                    role="gridcell"
                                    tabIndex={index === rovingIndex ? 0 : -1}
                                    aria-current={isToday ? 'date' : undefined}
                                    aria-label={cellAriaLabel}
                                    className={cn(
                                        'group relative min-h-[80px] p-1.5 flex flex-col gap-1',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-inset',
                                        cell.inMonth
                                            ? 'bg-bg-default'
                                            : 'bg-bg-muted/30 opacity-60',
                                        isToday &&
                                            'ring-1 ring-[var(--brand-default)] ring-inset',
                                        // B3 — selected-day state. The brand
                                        // ring (2px-inset) + brand-subtle wash
                                        // make the click feel acknowledged. The
                                        // selected ring is intentionally 2px so
                                        // it reads over the today ring (1px)
                                        // when both apply to the same cell.
                                        isSelected &&
                                            'ring-2 ring-[var(--brand-default)] ring-inset bg-brand-subtle/40',
                                        onSelectDate &&
                                            'cursor-pointer hover:bg-bg-muted/50 transition-colors duration-150 ease-out',
                                    )}
                                    data-ymd={ymd}
                                    data-in-month={cell.inMonth}
                                    data-today={isToday || undefined}
                                    data-selected={isSelected || undefined}
                                    onClick={handleCellClick}
                                    onKeyDown={(e) =>
                                        handleCellKeyDown(e, index, ymd)
                                    }
                                    // PR-C — double-click opens the
                                    // task-create modal pre-filled with
                                    // this date. The single-click select
                                    // continues to fire; React triggers
                                    // BOTH `onClick` and `onDoubleClick`
                                    // on a dblclick gesture (click fires
                                    // first), which is the right shape
                                    // here — we want the calendar to
                                    // visibly select the day and THEN
                                    // open the modal.
                                    onDoubleClick={
                                        onDoubleClickDate
                                            ? () => onDoubleClickDate(ymd)
                                            : undefined
                                    }
                                >
                                    <div className="flex items-center justify-between gap-1">
                                        {/* Create-on-this-day affordance. The
                                            double-click shortcut existed but was
                                            invisible — no cursor change, no tooltip,
                                            nothing in the aria-label — so nobody
                                            could discover it. Revealed on hover /
                                            keyboard focus; the cell's own dblclick
                                            still works for people who know it. */}
                                        {onDoubleClickDate ? (
                                            <Tooltip content={newTaskLabel}>
                                                <button
                                                    type="button"
                                                    className={cn(
                                                        'text-xs leading-none px-1 py-0.5 rounded text-content-muted',
                                                        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                                                        'hover:bg-bg-muted hover:text-content-emphasis transition-opacity',
                                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                                                    )}
                                                    onClick={() =>
                                                        onDoubleClickDate(ymd)
                                                    }
                                                    aria-label={`${newTaskLabel} — ${ymd}`}
                                                    data-testid={`calendar-day-add-${ymd}`}
                                                >
                                                    +
                                                </button>
                                            </Tooltip>
                                        ) : (
                                            <span />
                                        )}
                                        <button
                                            type="button"
                                            className={cn(
                                                'text-xs leading-none px-1 py-0.5 rounded text-content-muted hover:bg-bg-muted',
                                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                                                isToday &&
                                                    'text-content-emphasis font-semibold',
                                            )}
                                            onClick={() => onSelectDate?.(ymd)}
                                            aria-label={`${ymd}: ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}`}
                                        >
                                            {cell.date.getUTCDate()}
                                        </button>
                                    </div>
                                    {visible.length > 0 && (
                                        <ul className="flex flex-col gap-0.5 min-h-0">
                                            {visible.map((ev) => (
                                                <li
                                                    key={ev.id}
                                                    data-event-id={ev.id}
                                                    data-event-category={ev.category}
                                                >
                                                    <Tooltip
                                                        content={
                                                            ev.detail
                                                                ? `${ev.title} — ${ev.detail}`
                                                                : ev.title
                                                        }
                                                    >
                                                        <Link
                                                            href={ev.href}
                                                            className={cn(
                                                                'flex items-center gap-1 px-1 py-0.5 rounded text-[10px] truncate',
                                                                'hover:bg-bg-muted transition-colors',
                                                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                                                                ev.status === 'overdue' &&
                                                                    'text-content-error',
                                                                ev.status === 'done' &&
                                                                    'text-content-muted line-through',
                                                            )}
                                                        >
                                                            <span
                                                                className={cn(
                                                                    'inline-block size-2 rounded-full shrink-0',
                                                                    getCategoryTone(
                                                                        ev.category,
                                                                    ).bg,
                                                                    ev.status ===
                                                                        'done' &&
                                                                        'opacity-40',
                                                                )}
                                                                aria-hidden="true"
                                                            />
                                                            <span className="truncate">
                                                                {ev.title}
                                                            </span>
                                                        </Link>
                                                    </Tooltip>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {overflow > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => onSelectDate?.(ymd)}
                                            className="text-[10px] text-content-muted hover:text-content-emphasis text-left px-1"
                                        >
                                            {t('moreEvents', { count: overflow })}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </section>
        </TooltipProvider>
    );
}
