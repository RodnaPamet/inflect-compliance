"use client";

/**
 * Epic 49 — <GanttTimeline>.
 *
 * Horizontal timeline for duration-based compliance events. One row
 * per event, bar from `date` (start) to `end`. Today marker as a
 * vertical line. Click-through via the event's `href`.
 *
 * Today the only duration entity is `audit-cycle`; point-in-time
 * events with no `end` render as a 1-day-wide marker so the timeline
 * still shows everything in scope (useful for "remediation plan
 * targets within the audit window" overlays). Pass an explicitly
 * filtered events array if you want only true ranges.
 *
 * Token-styled, no external chart dep — the time axis is a CSS-grid
 * trick. Keeps the component small and the bundle cost negligible.
 */

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import type {
    CalendarEvent,
} from '@/app-layer/schemas/calendar.schemas';
import { getCategoryTone } from '@/lib/design/status-tone';
import { formatMonthShort, formatDate, formatDateRange } from '@/lib/format-date';
import { categoryLabel, statusLabel } from '@/lib/calendar-labels';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';

// ─── Public props ─────────────────────────────────────────────────────

export interface GanttTimelineProps {
    /** Inclusive timeline start. */
    from: Date;
    /** Inclusive timeline end. */
    to: Date;
    /**
     * Events to plot — the full calendar feed, NOT a pre-filtered subset.
     * Point-in-time events (those with no `end`) render as a 1-day marker,
     * so the timeline surfaces every deadline in scope, not only durations.
     */
    events: ReadonlyArray<CalendarEvent>;
    /** Override "today" for the vertical marker (tests). */
    today?: Date;
    /** Empty-state message override. */
    emptyMessage?: string;
    className?: string;
    'data-testid'?: string;
}

// ─── Token map (mirrors CalendarMonth) ───────────────────────────────
//
// Polish PR-7 — bar tone delegates to `getCategoryTone` from
// `@/lib/design/status-tone`. The Gantt bar uses the bg/border slots
// of the shared bundle with `/70` opacity for the fill, so calendar
// + gantt feel like one system.

// ─── Helpers ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

function pctBetween(t: number, from: number, to: number): number {
    if (to <= from) return 0;
    return ((t - from) / (to - from)) * 100;
}

/**
 * Pick ~6-12 axis ticks across the range. Dynamically chooses month
 * boundaries (when range >= 60 days) or weekly markers for tighter
 * windows. Keeps the axis readable without a chart library.
 */
function buildTicks(from: Date, to: Date): { date: Date; label: string }[] {
    const days = (to.getTime() - from.getTime()) / DAY_MS;
    const ticks: { date: Date; label: string }[] = [];

    if (days >= 60) {
        // Monthly ticks
        const cursor = new Date(
            Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1),
        );
        while (cursor.getTime() <= to.getTime()) {
            if (cursor.getTime() >= from.getTime()) {
                ticks.push({
                    date: new Date(cursor),
                    label:
                        cursor.getUTCMonth() === 0
                            ? `${formatMonthShort(cursor)} ${cursor.getUTCFullYear()}`
                            : formatMonthShort(cursor),
                });
            }
            cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        }
    } else {
        // Weekly ticks
        const stepMs = 7 * DAY_MS;
        for (let t = from.getTime(); t <= to.getTime(); t += stepMs) {
            const d = new Date(t);
            ticks.push({
                date: d,
                label: `${formatMonthShort(d)} ${d.getUTCDate()}`,
            });
        }
    }
    return ticks;
}

// ─── Component ───────────────────────────────────────────────────────

export function GanttTimeline({
    from,
    to,
    events,
    today,
    emptyMessage: emptyMessageProp,
    className,
    'data-testid': dataTestId = 'gantt-timeline',
}: GanttTimelineProps) {
    const t = useTranslations('common.chart');
    const tc = useTranslations('calendar');
    const emptyMessage = emptyMessageProp ?? t('ganttEmptyMessage');
    const todayDate = today ?? new Date();
    const fromMs = from.getTime();
    const toMs = to.getTime();

    // eslint-disable-next-line react-hooks/exhaustive-deps -- using ms-since-epoch as stable identity
    const ticks = React.useMemo(() => buildTicks(from, to), [fromMs, toMs]);

    // Sort events: by start ascending, then by duration descending.
    const sorted = React.useMemo(() => {
        return [...events].sort((a, b) => {
            const sa = new Date(a.date).getTime();
            const sb = new Date(b.date).getTime();
            if (sa !== sb) return sa - sb;
            const da = a.end ? new Date(a.end).getTime() - sa : 0;
            const db = b.end ? new Date(b.end).getTime() - sb : 0;
            return db - da;
        });
    }, [events]);

    const todayPct = pctBetween(todayDate.getTime(), fromMs, toMs);
    const todayInRange =
        todayDate.getTime() >= fromMs && todayDate.getTime() <= toMs;

    if (sorted.length === 0) {
        return (
            <div
                className={cn(
                    'rounded-lg border border-border-subtle bg-bg-muted/30 p-12 text-center text-sm text-content-muted',
                    className,
                )}
                data-testid={dataTestId}
            >
                {emptyMessage}
            </div>
        );
    }

    return (
        // Standalone primitive: it mounts its own TooltipProvider so the bar
        // tooltips work wherever GanttTimeline renders — nested harmlessly
        // under the app-root provider, and in isolation (Storybook, unit
        // tests) where no ancestor provider exists. Radix's Tooltip.Root
        // throws when no provider is in scope.
        <TooltipProvider>
            <div
                className={cn('flex flex-col gap-tight', className)}
                data-testid={dataTestId}
            >
                {/* Axis — decorative tick labels, kept outside the list. */}
                <div className="relative h-6 border-b border-border-subtle">
                    {ticks.map((tick) => {
                        const left = pctBetween(tick.date.getTime(), fromMs, toMs);
                        return (
                            <span
                                key={tick.date.toISOString()}
                                className="absolute top-0 -translate-x-1/2 text-[10px] text-content-muted"
                                style={{ left: `${clamp(left, 0, 100)}%` }}
                            >
                                {tick.label}
                            </span>
                        );
                    })}
                </div>

                {/* Rows — the semantic list. `role="list"` lives here (not on
                    the outer wrapper) so the list's only children are the event
                    listitems; the today marker below is presentational. */}
                <div
                    className="relative flex flex-col gap-1"
                    role="list"
                    aria-label={t('ganttTimeline')}
                >
                    {/* Today vertical marker — presentational, excluded from
                        both the list and the accessibility tree. */}
                    {todayInRange && (
                        <div
                            className="absolute top-0 bottom-0 w-px bg-[var(--brand-emphasis)]/70 z-10 pointer-events-none"
                            style={{ left: `${todayPct}%` }}
                            role="presentation"
                            aria-hidden="true"
                            data-testid="gantt-today-marker"
                        />
                    )}

                    {sorted.map((ev) => {
                        const startMs = new Date(ev.date).getTime();
                        const endMs = ev.end
                            ? new Date(ev.end).getTime()
                            : startMs + DAY_MS;
                        const clampedStart = Math.max(startMs, fromMs);
                        const clampedEnd = Math.min(endMs, toMs);
                        const left = pctBetween(clampedStart, fromMs, toMs);
                        const width = Math.max(
                            0.5,
                            pctBetween(clampedEnd, fromMs, toMs) - left,
                        );

                        // The bar encodes category (fill colour) and status
                        // (overdue border, done opacity) VISUALLY only, and
                        // point-in-time bars floor at ~6px. Give every bar an
                        // accessible name that spells out the localized title,
                        // date, status, and category so assistive tech reads
                        // what the colour conveys. `ev.title` is localized
                        // upstream — render it verbatim, never recompose.
                        const dateText = ev.end
                            ? formatDateRange(ev.date, ev.end)
                            : formatDate(ev.date);
                        const barLabel = tc('timelineBarLabel', {
                            title: ev.title,
                            category: categoryLabel(tc, ev.category),
                            status: statusLabel(tc, ev.status),
                            date: dateText,
                        });
                        const tooltipContent = ev.detail
                            ? `${ev.title} — ${ev.detail}`
                            : ev.title;

                        return (
                            <div
                                key={ev.id}
                                role="listitem"
                                className="relative h-7 flex items-center"
                                data-event-id={ev.id}
                                data-event-category={ev.category}
                            >
                                <Tooltip content={tooltipContent}>
                                    <Link
                                        href={ev.href}
                                        aria-label={barLabel}
                                        className={cn(
                                            'absolute top-1 bottom-1 rounded border px-1 flex items-center text-[10px] font-medium text-content-emphasis truncate min-w-[8px]',
                                            'hover:ring-1 hover:ring-content-emphasis/40 transition-colors duration-150 ease-out',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                                            // Polish PR-7 — getCategoryTone gives the
                                            // canonical bg + border for this category;
                                            // /70 opacity matches the prior CATEGORY_BAR
                                            // fill rhythm.
                                            `${getCategoryTone(ev.category).bg}/70`,
                                            getCategoryTone(ev.category).border,
                                            ev.status === 'overdue' && 'border-status-danger',
                                            ev.status === 'done' && 'opacity-50',
                                        )}
                                        style={{
                                            left: `${left}%`,
                                            width: `${width}%`,
                                        }}
                                    >
                                        <span className="truncate">{ev.title}</span>
                                    </Link>
                                </Tooltip>
                            </div>
                        );
                    })}
                </div>
            </div>
        </TooltipProvider>
    );
}
