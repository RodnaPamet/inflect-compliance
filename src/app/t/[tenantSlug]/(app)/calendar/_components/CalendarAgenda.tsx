"use client";

/**
 * <CalendarAgenda> — the calendar as a list of days, the phone's default view.
 *
 * The month grid at a phone's width gave each day a 45 px cell and each event
 * a dot and two letters ("● П.."), with the day's events one tap and a scroll
 * away in the panel above the grid (owner decision, 2026-11-23: an agenda
 * below `md`, the grid still available). This lists the same events — the
 * month's window, the filter already applied — as day headings in date order,
 * each followed by its events with their title, category and status, every
 * event a link to its record.
 *
 * What is due now comes first. Days before today sit behind one "Show N
 * earlier days" button at the top, so in the current month the first thing on
 * the screen is today and the rest of the week, not the first of the month. A
 * month that is wholly past or wholly ahead lists every day.
 *
 * It is a fourth renderer beside the month grid, the heatmap and the timeline,
 * and like them shares no layout code with the others
 * (`docs/calendar-surface-do-not-touch.md` §4): a list of days has no grid
 * maths to share. It holds no strings of its own beyond the calendar
 * namespace's, and does no fetching.
 */

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';
import type { CalendarEvent } from '@/app-layer/schemas/calendar.schemas';
import { getCategoryTone } from '@/lib/design/status-tone';
import { formatDate, formatWeekdayShort } from '@inflect/ui/lib/format-date';
import { parseYMD } from '@/components/ui/date-picker/date-utils';
import { categoryLabel, statusLabel } from '@/lib/calendar-labels';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';

export interface CalendarAgendaProps {
    /** The window's events, titles already localized and filters applied. */
    events: ReadonlyArray<CalendarEvent>;
    /** The server's civil day (`CalendarResponse.todayYmd`), `YYYY-MM-DD`. */
    todayYmd?: string;
    /** Shown when the window holds no event. */
    emptyMessage: string;
}

interface AgendaDay {
    ymd: string;
    events: CalendarEvent[];
}

/** Events grouped by their day, days ascending, each day's events by title. */
export function groupAgendaDays(events: ReadonlyArray<CalendarEvent>): AgendaDay[] {
    const byDay = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
        const ymd = ev.date.slice(0, 10);
        const list = byDay.get(ymd);
        if (list) list.push(ev);
        else byDay.set(ymd, [ev]);
    }
    return [...byDay.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([ymd, list]) => ({
            ymd,
            events: [...list].sort((a, b) => a.title.localeCompare(b.title)),
        }));
}

export function CalendarAgenda({ events, todayYmd, emptyMessage }: CalendarAgendaProps) {
    const t = useTranslations('calendar');
    const days = React.useMemo(() => groupAgendaDays(events), [events]);
    const [showEarlier, setShowEarlier] = React.useState(false);

    // Only a window that holds today has "earlier" days to fold: in a past or
    // a future month every day is shown.
    const earlier = todayYmd ? days.filter((d) => d.ymd < todayYmd) : [];
    const foldsEarlier = earlier.length > 0 && earlier.length < days.length;
    const shown = foldsEarlier && !showEarlier ? days.filter((d) => d.ymd >= todayYmd!) : days;

    if (days.length === 0) {
        return (
            <p className="py-6 text-center text-sm text-content-muted" id="calendar-agenda-empty">
                {emptyMessage}
            </p>
        );
    }

    return (
        <div id="calendar-agenda" data-testid="calendar-agenda" className="space-y-default">
            {foldsEarlier && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    aria-expanded={showEarlier}
                    onClick={() => setShowEarlier((v) => !v)}
                    data-testid="calendar-agenda-earlier"
                >
                    {showEarlier
                        ? t('agenda.hideEarlier')
                        : t('agenda.showEarlier', { count: earlier.length })}
                </Button>
            )}
            {shown.map((day) => {
                const date = parseYMD(day.ymd);
                const isToday = day.ymd === todayYmd;
                const headingId = `calendar-agenda-day-${day.ymd}`;
                return (
                    <section
                        key={day.ymd}
                        aria-labelledby={headingId}
                        data-ymd={day.ymd}
                        data-testid="calendar-agenda-day"
                    >
                        <Heading
                            level={3}
                            id={headingId}
                            className={cn(
                                'mb-1 flex items-baseline gap-tight',
                                isToday ? 'text-content-emphasis' : 'text-content-default',
                            )}
                        >
                            <span>{date ? formatWeekdayShort(date) : ''}</span>
                            <span>{date ? formatDate(date) : day.ymd}</span>
                            {isToday && (
                                <span className="rounded-full bg-bg-subtle px-2 text-xs font-medium text-content-info">
                                    {t('agenda.today')}
                                </span>
                            )}
                        </Heading>
                        <ul className="space-y-tight">
                            {day.events.map((ev) => {
                                const tone = getCategoryTone(ev.category);
                                const endDate = ev.end ? parseYMD(ev.end.slice(0, 10)) : null;
                                return (
                                    <li key={ev.id} data-event-id={ev.id}>
                                        <Link
                                            href={ev.href}
                                            className="flex min-h-11 items-start gap-compact rounded-lg border border-border-subtle px-3 py-2 transition-colors hover:bg-bg-muted"
                                        >
                                            <span
                                                className={cn('mt-1.5 size-2 shrink-0 rounded-full', tone.bg)}
                                                aria-hidden="true"
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block break-words text-sm font-medium text-content-emphasis">
                                                    {ev.title}
                                                </span>
                                                {ev.detail && (
                                                    <span className="block break-words text-xs text-content-muted">
                                                        {ev.detail}
                                                    </span>
                                                )}
                                                <span className="block text-xs text-content-subtle">
                                                    {categoryLabel(t, ev.category)} · {statusLabel(t, ev.status)}
                                                    {endDate && ` · ${t('agenda.until', { date: formatDate(endDate) })}`}
                                                </span>
                                            </span>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
