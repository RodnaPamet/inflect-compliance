'use client';

/**
 * Epic 49 — Compliance Calendar client island.
 *
 * Three views: Heatmap (−365d…+180d), Month (single month grid), Gantt
 * (±180d centred on today). The view toggle drives both the rendered
 * component AND the query window. A category/type filter + a "my deadlines"
 * toggle refine what's shown; a selected day populates a side panel listing
 * that day's events with inline actions on task-backed deadlines.
 *
 * The client owns range selection, so it owns the fetch — the server shell
 * passes only the tenant slug (a server-side prefetch never matched the
 * client's default month window and was discarded every load).
 */

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Calendar as CalIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/icons';
import { Plus } from '@/components/ui/icons/nucleo';
import { useToast } from '@/components/ui/hooks/use-toast';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, toYMD, startOfUtcDay } from '@/components/ui/date-picker/date-utils';
import { CalendarHeatmap } from '@/components/ui/CalendarHeatmap';
import { CalendarMonth } from '@/components/ui/CalendarMonth';
import { GanttTimeline } from '@/components/ui/GanttTimeline';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Checkbox } from '@/components/ui/checkbox';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { formatDate, formatMonthYear } from '@/lib/format-date';
import { getCategoryTone } from '@/lib/design/status-tone';
import { usePermissions, useCurrentUserId } from '@/lib/tenant-context-provider';
import {
    composeEventTitle,
    categoryLabel,
    statusLabel,
    sourceLabel,
} from '@/lib/calendar-labels';
import { NewTaskModal } from '@/app/t/[tenantSlug]/(app)/tasks/NewTaskModal';
import {
    CALENDAR_EVENT_CATEGORIES,
    SOURCES_WITHOUT_OWNER,
    type CalendarEvent,
    type CalendarEventCategory,
    type CalendarResponse,
} from '@/app-layer/schemas/calendar.schemas';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';

const DAY_MS = 86_400_000;

type View = 'heatmap' | 'month' | 'gantt';

interface CalendarClientProps {
    tenantSlug: string;
}

function startOfUtcMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfUtcMonth(d: Date): Date {
    return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
}

/**
 * How far forward the heatmap looks. It used to end at `today`, so it was
 * purely retrospective — a density view of past activity beside two deadline
 * views. It now covers the same forward window as the timeline.
 */
const HEATMAP_FORWARD_DAYS = 180;

/**
 * `todayMs` is a STABLE anchor captured once at mount, not `new Date()` read
 * inside the memo — otherwise every view toggle minted a fresh window (and a
 * fresh SWR key that never hit cache).
 */
function rangeForView(
    view: View,
    monthCursor: Date,
    todayMs: number,
): { from: Date; to: Date } {
    if (view === 'heatmap') {
        return {
            from: new Date(todayMs - 365 * DAY_MS),
            to: new Date(todayMs + HEATMAP_FORWARD_DAYS * DAY_MS),
        };
    }
    if (view === 'gantt') {
        return {
            from: new Date(todayMs - 180 * DAY_MS),
            to: new Date(todayMs + 180 * DAY_MS),
        };
    }
    // month — pad to cover the 6-row grid
    const start = startOfUtcMonth(monthCursor);
    const end = endOfUtcMonth(monthCursor);
    return {
        from: new Date(start.getTime() - 7 * DAY_MS),
        to: new Date(end.getTime() + 7 * DAY_MS),
    };
}

export function CalendarClient({ tenantSlug }: CalendarClientProps) {
    const t = useTranslations('calendar');
    const toast = useToast();
    const perms = usePermissions();
    const currentUserId = useCurrentUserId();
    const canEditTask = perms.tasks.edit;
    const canCreateTask = perms.tasks.create;

    // ── URL as the source of truth for view + month + filters ──
    //
    // None of this state was in the URL, on a page whose entire purpose is
    // "what is due" and whose links get pasted into chat. A shared calendar
    // link carried the recipient to the current month with no filters,
    // whatever the sender was looking at.
    //
    // Hand-rolled rather than via `FilterProvider`: see the note on the filter
    // group below. `replace` (not `push`) so toggling a category does not
    // stack history entries the back button has to chew through.
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const viewParam = searchParams.get('view');
    const view: View =
        viewParam === 'heatmap' || viewParam === 'gantt' || viewParam === 'month'
            ? viewParam
            : 'month';
    const monthParam = searchParams.get('month');
    const monthCursor = React.useMemo(() => {
        const parsed = monthParam ? parseYMD(`${monthParam}-01`) : null;
        return parsed ? startOfUtcMonth(parsed) : startOfUtcMonth(new Date());
    }, [monthParam]);

    const setParams = React.useCallback(
        (next: Record<string, string | null>) => {
            const params = new URLSearchParams(searchParams.toString());
            for (const [k, v] of Object.entries(next)) {
                if (v === null || v === '') params.delete(k);
                else params.set(k, v);
            }
            const qs = params.toString();
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        },
        [router, pathname, searchParams],
    );

    const setView = React.useCallback(
        (v: View) => setParams({ view: v === 'month' ? null : v }),
        [setParams],
    );
    const setMonthCursor = React.useCallback(
        (d: Date) => setParams({ month: d.toISOString().slice(0, 7) }),
        [setParams],
    );
    const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
    const [taskCreateDate, setTaskCreateDate] = React.useState<string | null>(
        null,
    );
    // Filters. `categoryFilter` is server-side (it rides the SWR key so a
    // filtered view fetches only its slice); `mineOnly` is client-side (it
    // filters the fetched events by ownerUserId, no refetch).
    const categoryFilter = React.useMemo<Set<CalendarEventCategory>>(() => {
        const raw = searchParams.get('categories');
        if (!raw) return new Set();
        const valid = new Set<string>(CALENDAR_EVENT_CATEGORIES);
        return new Set(
            raw.split(',').filter((c): c is CalendarEventCategory => valid.has(c)),
        );
    }, [searchParams]);
    const setCategoryFilter = React.useCallback(
        (next: Set<CalendarEventCategory>) =>
            setParams({ categories: [...next].sort().join(',') || null }),
        [setParams],
    );
    const mineOnly = searchParams.get('mine') === '1';
    const setMineOnly = React.useCallback(
        (updater: (v: boolean) => boolean) =>
            setParams({ mine: updater(searchParams.get('mine') === '1') ? '1' : null }),
        [setParams, searchParams],
    );

    // Stable "today" anchor — see rangeForView.
    const [todayMs] = React.useState(() => startOfUtcDay(new Date()).getTime());

    const monthCursorMs = monthCursor.getTime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const range = React.useMemo(
        () => rangeForView(view, monthCursor, todayMs),
        [view, monthCursorMs, todayMs],
    );

    const fromKey = range.from.toISOString();
    const toKey = range.to.toISOString();

    const categoryKey = React.useMemo(
        () => [...categoryFilter].sort(),
        [categoryFilter],
    );

    const calQuery = useTenantSWR<CalendarResponse>(
        CACHE_KEYS.calendar.range(
            fromKey,
            toKey,
            categoryKey.length > 0 ? { categories: categoryKey } : undefined,
        ),
        {
            // The calendar wants "fresh-or-loading", not the previous range's
            // events painted into the new window — override the hook default.
            keepPreviousData: false,
        },
    );

    // Localize the server's English title into the display title, and apply
    // the client-side "my deadlines" filter.
    const events: CalendarEvent[] = React.useMemo(() => {
        let list = (calQuery.data?.events ?? []).map((e) => ({
            ...e,
            title: composeEventTitle(t, e),
        }));
        if (mineOnly) {
            list = list.filter((e) => e.ownerUserId === currentUserId);
        }
        return list;
    }, [calQuery.data, t, mineOnly, currentUserId]);

    const truncation = calQuery.data?.truncation;
    const omittedSources = calQuery.data?.omittedSources ?? [];
    const failedSources = calQuery.data?.failedSources ?? [];
    // ONE definition of "today" for all three views: the civil day the server
    // classified statuses against. The month ring used the browser's day, the
    // heatmap derived its own UTC day, and the Gantt marker used a raw instant
    // — so switching views could move which cell counted as today.
    const todayYmd = calQuery.data?.todayYmd;
    // The Gantt marker is positional (a percentage across the range), so it
    // needs an instant rather than a day label — anchor it to noon of the
    // server's day so it sits inside the cell it marks instead of on its edge.
    const todayDate = React.useMemo(
        () => (todayYmd ? new Date(`${todayYmd}T12:00:00.000Z`) : undefined),
        [todayYmd],
    );
    // "My deadlines" drops any event with no `ownerUserId`. Sixteen of the
    // seventeen sources now carry one; the remainder cannot (see
    // SOURCES_WITHOUT_OWNER) and would otherwise vanish with no signal — the
    // same silent under-reporting the permission path already refuses via
    // `omittedSources`.
    const ownerlessSources = mineOnly ? SOURCES_WITHOUT_OWNER : [];

    // Pending is derived from SWR's key-aware `isLoading` (true while the
    // current key loads with no cached data). With keepPreviousData off, a
    // range/filter switch clears `data`, so the grid shows a loading state
    // instead of the previous window's events.
    const pending = calQuery.isLoading;

    // ─── Off-screen deadline probe ───────────────────────────────────
    // Only when the current window is genuinely empty (not loading, not
    // errored). Points at the nearest deadline outside the visible window.
    // Gated on the SERVER's result being empty, not the post-filter `events`.
    // `events` has already had the client-side mineOnly filter applied, so
    // toggling "My deadlines" into an empty result used to fire a SECOND full
    // 17-source aggregation over a 730-day window — the most expensive request
    // the surface makes, triggered by a checkbox. A window with deadlines that
    // simply aren't yours is not an empty window, and pointing at the "nearest
    // deadline outside this range" would be answering a question nobody asked.
    const isEmptyView =
        !pending && !calQuery.error && (calQuery.data?.events.length ?? 0) === 0;
    const probeRange = React.useMemo(
        () => ({
            from: new Date(todayMs).toISOString(),
            to: new Date(todayMs + 730 * DAY_MS).toISOString(),
        }),
        [todayMs],
    );
    const probeQuery = useTenantSWR<CalendarResponse>(
        isEmptyView ? CACHE_KEYS.calendar.range(probeRange.from, probeRange.to) : null,
    );

    const nextOffscreenDeadline = React.useMemo(() => {
        // Suppress if the current view isn't empty, or the probe itself failed
        // (a probe error must not read as "nothing anywhere ahead").
        if (!isEmptyView || probeQuery.error) return null;
        const fromMs = range.from.getTime();
        const toMs = range.to.getTime();
        const hit = (probeQuery.data?.events ?? []).find((e) => {
            const ms = new Date(e.date).getTime();
            return ms < fromMs || ms > toMs;
        });
        return hit ? { date: new Date(hit.date) } : null;
    }, [isEmptyView, probeQuery.data, probeQuery.error, range]);

    /** Jump the month view to the month containing `d` and select the day. */
    const jumpToDeadline = React.useCallback((d: Date) => {
        setView('month');
        setMonthCursor(startOfUtcMonth(d));
        setSelectedDate(toYMD(d) ?? null);
    }, []);

    // The Timeline shows EVERY deadline, not just ranges (GanttTimeline draws
    // a point-in-time event as a 1-day marker).
    const ganttEvents = events;

    const selectedEvents = React.useMemo(() => {
        if (!selectedDate) return [];
        return events.filter((e) => e.date.slice(0, 10) === selectedDate);
    }, [events, selectedDate]);

    // Month nav + view switch must clear the stale day selection: the panel
    // header otherwise keeps a date the new month/view no longer shows, and
    // the seed-task button would create for the wrong day.
    // The setters take a VALUE, not an updater — the state lives in the URL,
    // and reading the current month from `monthCursor` (itself derived from the
    // URL) is the same thing a functional update would have read.
    const shiftMonth = (delta: number) => {
        if (view !== 'month') return;
        setSelectedDate(null);
        setMonthCursor(
            new Date(
                Date.UTC(
                    monthCursor.getUTCFullYear(),
                    monthCursor.getUTCMonth() + delta,
                    1,
                ),
            ),
        );
    };
    const handlePrev = () => shiftMonth(-1);
    const handleNext = () => shiftMonth(1);
    const changeView = (next: View) => {
        setSelectedDate(null);
        setView(next);
    };

    const toggleCategory = (cat: CalendarEventCategory) => {
        const nextSet = new Set(categoryFilter);
        if (nextSet.has(cat)) nextSet.delete(cat);
        else nextSet.add(cat);
        setCategoryFilter(nextSet);
    };

    // ─── Inline actions for task-backed events ───────────────────────
    const apiBase = `/api/t/${tenantSlug}`;
    const [busyEventId, setBusyEventId] = React.useState<string | null>(null);
    const [rescheduleEventId, setRescheduleEventId] = React.useState<
        string | null
    >(null);

    const optimisticPatch = React.useCallback(
        (eventId: string, patch: Partial<CalendarEvent>) =>
            calQuery.mutate(
                (curr) =>
                    curr
                        ? {
                              ...curr,
                              events: curr.events.map((e) =>
                                  e.id === eventId ? { ...e, ...patch } : e,
                              ),
                          }
                        : curr,
                { revalidate: false },
            ),
        [calQuery],
    );

    /** Turn a failed task mutation response into a specific message. */
    const actionErrorMessage = React.useCallback(
        (status: number | undefined) =>
            status === 403 ? t('taskForbidden') : t('taskActionError'),
        [t],
    );

    const completeTask = React.useCallback(
        async (ev: CalendarEvent) => {
            if (ev.entityType !== 'TASK' || !canEditTask) return;
            setBusyEventId(ev.id);
            await optimisticPatch(ev.id, { status: 'done' });
            try {
                const res = await fetch(
                    `${apiBase}/tasks/${ev.entityId}/status`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: 'CLOSED',
                            resolution: t('taskCompleteResolution'),
                        }),
                    },
                );
                if (!res.ok) {
                    toast.error(actionErrorMessage(res.status));
                } else {
                    toast.success(t('taskCompleted'));
                }
            } catch {
                toast.error(actionErrorMessage(undefined));
            } finally {
                setBusyEventId(null);
                await calQuery.mutate();
            }
        },
        [apiBase, calQuery, optimisticPatch, t, toast, canEditTask, actionErrorMessage],
    );

    const rescheduleTask = React.useCallback(
        async (ev: CalendarEvent, ymd: string) => {
            if (ev.entityType !== 'TASK' || !canEditTask) return;
            setBusyEventId(ev.id);
            setRescheduleEventId(null);
            await optimisticPatch(ev.id, { date: ymd });
            try {
                const res = await fetch(`${apiBase}/tasks/${ev.entityId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ dueAt: ymd }),
                });
                if (!res.ok) {
                    toast.error(actionErrorMessage(res.status));
                } else {
                    toast.success(t('taskRescheduled'));
                }
            } catch {
                toast.error(actionErrorMessage(undefined));
            } finally {
                setBusyEventId(null);
                await calQuery.mutate();
            }
        },
        [apiBase, calQuery, optimisticPatch, t, toast, canEditTask, actionErrorMessage],
    );

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <header className="flex items-start justify-between gap-default flex-wrap">
                <div className="min-w-0">
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                            { label: t('crumbCalendar') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} className="sr-only flex items-center gap-tight">
                        <CalIcon className="size-6 text-content-muted" aria-hidden="true" />
                        {t('title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('description')}
                    </p>
                </div>
                <div className="flex items-center gap-tight flex-wrap">
                    <ToggleGroup
                        selected={view}
                        selectAction={(v) => changeView(v as View)}
                        options={[
                            { value: 'month', label: t('viewMonth') },
                            { value: 'heatmap', label: t('viewHeatmap') },
                            { value: 'gantt', label: t('viewTimeline') },
                        ]}
                        size="sm"
                        ariaLabel={t('viewAria')}
                    />
                </div>
            </header>

            {/* Colour legend ONLY — the interactive filter moved into the side
                panel (see `#calendar-filter-group`).

                These used to be the same control: chips that were both the key
                to the dot colours AND the filter. Splitting them keeps the key
                beside the grid it explains — a grid of coloured events with no
                key anywhere would be a regression, whatever the filter gained.
                Both halves render from `CATEGORY_TONES` so the swatch here and
                the checkbox there cannot drift to different colours. */}
            <div
                className={cn(cardVariants({ density: 'none' }), 'flex flex-wrap items-center gap-compact px-4 py-2')}
                role="group"
                aria-label={t('legendAria')}
                id="calendar-legend"
            >
                <span className="text-xs font-medium text-content-muted">
                    {t('filterLegendLabel')}
                </span>
                {CALENDAR_EVENT_CATEGORIES.map((cat) => (
                    <span
                        key={cat}
                        className="inline-flex items-center gap-1.5 text-xs text-content-muted"
                    >
                        <span
                            className={cn('size-2 rounded-full', getCategoryTone(cat).bg)}
                            aria-hidden="true"
                        />
                        {categoryLabel(t, cat)}
                    </span>
                ))}
            </div>

            {/* Range navigation. Month has working prev/next; the fixed
                windows (heatmap / gantt) render an explicit label instead. */}
            {view === 'month' ? (
                <div
                    className={cn(cardVariants({ density: 'none' }), 'flex items-center justify-between px-4 py-2')}
                    data-testid="calendar-month-nav"
                >
                    <Button type="button" variant="ghost" onClick={handlePrev} aria-label={t('prevMonth')}>
                        <ChevronLeft className="size-4" />
                    </Button>
                    <span
                        className="text-sm font-semibold text-content-emphasis"
                        data-testid="calendar-current-month"
                    >
                        {formatMonthYear(monthCursor)}
                    </span>
                    <Button type="button" variant="ghost" onClick={handleNext} aria-label={t('nextMonth')}>
                        <ChevronRight className="size-4" />
                    </Button>
                </div>
            ) : (
                <div
                    className={cn(cardVariants({ density: 'none' }), 'flex items-center justify-center px-4 py-2')}
                    data-testid="calendar-fixed-window-label"
                >
                    <span className="text-sm font-medium text-content-muted">
                        {view === 'heatmap' ? t('heatmapWindowLabel') : t('ganttWindowLabel')}
                    </span>
                </div>
            )}

            {/* Error state */}
            {calQuery.error && (
                <div
                    className="rounded-lg border border-border-error bg-bg-error px-4 py-3 text-sm text-content-error"
                    role="alert"
                >
                    {t('loadError')}
                </div>
            )}

            {/* Permission-omitted sources: the calendar hides domains the
                caller can't see; say so rather than under-report silently. */}
            {omittedSources.length > 0 && (
                <div
                    className="rounded-lg border border-border-subtle bg-bg-subtle px-4 py-2 text-xs text-content-muted"
                    role="status"
                    data-testid="calendar-omitted-notice"
                >
                    {t('omittedNotice', {
                        sources: omittedSources.map((s) => sourceLabel(t, s)).join(', '),
                    })}
                </div>
            )}

            {/* Sources whose read FAILED. Deliberately a warning, not the same
                quiet grey as the permission notice: "you can't see these" is a
                settled fact, "these failed to load" is a transient one worth
                retrying — and a missing compliance domain must not read as an
                empty one. */}
            {failedSources.length > 0 && (
                <div
                    className="rounded-lg border border-border-warning bg-bg-warning px-4 py-3 text-sm text-content-warning"
                    role="status"
                    id="calendar-failed-notice"
                >
                    {t('failedNotice', {
                        sources: failedSources.map((s) => sourceLabel(t, s)).join(', '),
                    })}
                </div>
            )}

            {/* "My deadlines" hides sources that carry no owner at all. Say
                which, rather than letting a whole domain disappear as if it
                had no deadlines in range. */}
            {ownerlessSources.length > 0 && (
                <div
                    className="rounded-lg border border-border-subtle bg-bg-subtle px-4 py-2 text-xs text-content-muted"
                    role="status"
                    id="calendar-ownerless-notice"
                >
                    {t('ownerlessNotice', {
                        sources: ownerlessSources.map((s) => sourceLabel(t, s)).join(', '),
                    })}
                </div>
            )}

            {/* Truncation notice — nearest deadlines survive a per-source cap;
                the rest are real, so don't imply this range is complete. */}
            {truncation?.capped && (
                <div
                    className="rounded-lg border border-border-warning bg-bg-warning px-4 py-3 text-sm text-content-warning"
                    role="status"
                    data-testid="calendar-truncation-notice"
                >
                    {t('truncationNotice', {
                        limit: truncation.perSourceLimit,
                        sources: truncation.sources.map((s) => sourceLabel(t, s)).join(', '),
                    })}
                </div>
            )}

            {/* Off-screen deadline hint — only on a genuinely empty (not
                errored) window. */}
            {isEmptyView && nextOffscreenDeadline && (
                <div
                    className="flex flex-wrap items-center justify-between gap-compact rounded-lg border border-border-subtle bg-bg-subtle px-4 py-2 text-sm"
                    data-testid="calendar-offscreen-hint"
                >
                    <span className="text-content-muted">
                        {t('offscreenHint', { date: formatDate(nextOffscreenDeadline.date) })}
                    </span>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="calendar-jump-to-next"
                        onClick={() => jumpToDeadline(nextOffscreenDeadline.date)}
                    >
                        {t('offscreenJump')}
                    </Button>
                </div>
            )}

            {/* Body — view switch */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-section">
                <div
                    className={cn(
                        cardVariants({ density: 'compact' }),
                        // Dim on load OR error rather than blanking — a range
                        // switch reads as "loading", an error keeps the banner
                        // above it visible without a bare empty grid.
                        (pending || calQuery.error) && 'opacity-50 transition-opacity',
                    )}
                    aria-busy={pending || undefined}
                >
                    {pending && (
                        <div
                            className="flex items-center gap-tight pb-2 text-xs text-content-muted"
                            role="status"
                            data-testid="calendar-loading"
                        >
                            <LoadingSpinner className="h-3.5 w-3.5" />
                            {t('loading')}
                        </div>
                    )}
                    {view === 'heatmap' ? (
                        <CalendarHeatmap
                            events={events}
                            from={range.from}
                            to={range.to}
                            todayYmd={todayYmd}
                            onSelectDate={setSelectedDate}
                        />
                    ) : view === 'month' ? (
                        <CalendarMonth
                            month={monthCursor}
                            events={events}
                            onSelectDate={setSelectedDate}
                            // Task-create affordances only for callers who can
                            // create tasks — CalendarMonth hides the per-cell +
                            // when `onDoubleClickDate` is undefined.
                            onDoubleClickDate={
                                canCreateTask
                                    ? (ymd) => {
                                          setSelectedDate(ymd);
                                          setTaskCreateDate(ymd);
                                      }
                                    : undefined
                            }
                            newTaskLabel={canCreateTask ? t('newTaskOnDay') : undefined}
                            selectedYmd={selectedDate}
                            todayYmd={todayYmd}
                        />
                    ) : (
                        <GanttTimeline
                            from={range.from}
                            to={range.to}
                            events={ganttEvents}
                            today={todayDate}
                            emptyMessage={t('ganttEmpty')}
                        />
                    )}
                </div>

                {/* Side panel — filter, then the selected day's events.
                    `order-first lg:order-none` hoists it ABOVE the grid on
                    mobile: below `lg` the two-column grid collapses to one
                    column and the aside would otherwise render after a full
                    42-cell month, putting the filter behind a scroll. */}
                <aside
                    className={cn(
                        cardVariants({ density: 'compact' }),
                        'order-first lg:order-none',
                        // The panel must not grow past the viewport and push the
                        // filter off-screen on a busy day — the events list gets
                        // its own scroll region below instead.
                        'lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] flex flex-col',
                    )}
                    data-testid="calendar-side-panel"
                >
                    {/* ── Filter ── its own labelled group, because putting
                        interactive controls inside <aside> changes the a11y
                        tree: without this they would read as loose widgets in
                        a complementary landmark. */}
                    <div
                        role="group"
                        aria-label={t('filterAria')}
                        id="calendar-filter-group"
                        className="mb-3 border-b border-border-subtle pb-3"
                    >
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs font-medium text-content-muted">
                                {t('filterAria')}
                            </span>
                            {categoryFilter.size > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setCategoryFilter(new Set())}
                                    className="text-xs text-content-muted underline underline-offset-2 hover:text-content-emphasis"
                                >
                                    {t('filterClear')}
                                </button>
                            )}
                        </div>
                        {/* Two columns: eight categories stacked one-per-row
                            would push the day's events below the fold at a
                            900px viewport, which is the whole point of the
                            panel. */}
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                            {CALENDAR_EVENT_CATEGORIES.map((cat) => {
                                const active = categoryFilter.has(cat);
                                const tone = getCategoryTone(cat);
                                return (
                                    <label
                                        key={cat}
                                        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs text-content-muted hover:text-content-emphasis"
                                    >
                                        <Checkbox
                                            size="sm"
                                            checked={active}
                                            onCheckedChange={() => toggleCategory(cat)}
                                            aria-label={categoryLabel(t, cat)}
                                        />
                                        <span
                                            className={cn('size-2 shrink-0 rounded-full', tone.bg)}
                                            aria-hidden="true"
                                        />
                                        <span className="truncate">{categoryLabel(t, cat)}</span>
                                    </label>
                                );
                            })}
                        </div>
                        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-content-muted hover:text-content-emphasis">
                            <Checkbox
                                size="sm"
                                checked={mineOnly}
                                onCheckedChange={() => setMineOnly((v) => !v)}
                                aria-label={t('myDeadlines')}
                            />
                            {t('myDeadlines')}
                        </label>
                        {/* The count is the filter's feedback, so it moved with
                            it — it is the only thing that says a filter did
                            anything. */}
                        <p
                            className="mt-2 text-xs text-content-muted"
                            data-testid="calendar-count-total"
                        >
                            {t('countTotal', { count: events.length })}
                        </p>
                    </div>

                    {/* ── The selected day's events ── own scroll region so a
                        busy day cannot push the filter above it out of reach. */}
                    <div className="min-h-0 flex-1 overflow-y-auto">
                    {selectedDate ? (
                        <>
                            <Heading level={3} className="mb-2">
                                {formatDate(parseYMD(selectedDate))}
                            </Heading>
                            {canCreateTask && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="mb-3 w-full"
                                    icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                    id="calendar-new-task-on-day"
                                    onClick={() => setTaskCreateDate(selectedDate)}
                                >
                                    {t('newTaskOnDay')}
                                </Button>
                            )}
                            {selectedEvents.length === 0 ? (
                                <p className="text-xs text-content-muted">
                                    {t('eventsEmptyDay')}
                                </p>
                            ) : (
                                <ul className="space-y-tight">
                                    {selectedEvents.map((ev) => {
                                        const isTask = ev.entityType === 'TASK';
                                        const busy = busyEventId === ev.id;
                                        return (
                                            <li key={ev.id} data-event-id={ev.id}>
                                                <Link
                                                    href={ev.href}
                                                    className="block rounded p-2 text-xs hover:bg-bg-muted transition-colors"
                                                >
                                                    <div className="font-medium text-content-emphasis truncate">
                                                        {ev.title}
                                                    </div>
                                                    {ev.detail && (
                                                        <div className="text-content-muted truncate">
                                                            {ev.detail}
                                                        </div>
                                                    )}
                                                    <div className="text-[10px] text-content-subtle uppercase tracking-wider mt-0.5">
                                                        {categoryLabel(t, ev.category)} · {statusLabel(t, ev.status)}
                                                    </div>
                                                </Link>
                                                {/* Inline actions for task-backed events, gated on
                                                    the caller actually being able to edit tasks. */}
                                                {isTask && canEditTask && (
                                                    <div className="mt-1 px-2 pb-1">
                                                        {rescheduleEventId === ev.id ? (
                                                            <div className="flex items-center gap-tight">
                                                                <DatePicker
                                                                    clearable={false}
                                                                    align="start"
                                                                    value={parseYMD(ev.date.slice(0, 10))}
                                                                    onChange={(next) => {
                                                                        const ymd = toYMD(next);
                                                                        if (ymd) void rescheduleTask(ev, ymd);
                                                                    }}
                                                                    aria-label={t('rescheduleAria')}
                                                                />
                                                                {/* clearable={false} means the picker
                                                                    never offers an exit — provide one, else
                                                                    the row is stuck in picker mode. */}
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="xs"
                                                                    onClick={() => setRescheduleEventId(null)}
                                                                >
                                                                    {t('rescheduleCancel')}
                                                                </Button>
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center gap-tight">
                                                                {ev.status !== 'done' && (
                                                                    <Button
                                                                        type="button"
                                                                        variant="secondary"
                                                                        size="xs"
                                                                        disabled={busy}
                                                                        onClick={() => void completeTask(ev)}
                                                                    >
                                                                        {t('completeAction')}
                                                                    </Button>
                                                                )}
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="xs"
                                                                    disabled={busy}
                                                                    onClick={() => setRescheduleEventId(ev.id)}
                                                                >
                                                                    {t('rescheduleAction')}
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </>
                    ) : (
                        <p className="text-xs text-content-muted">{t('clickDay')}</p>
                    )}
                    </div>
                </aside>
            </div>

            {/* New Task modal — driven by the calendar's create affordances,
                which only render for callers who can create tasks. */}
            {canCreateTask && (
                <NewTaskModal
                    open={taskCreateDate !== null}
                    setOpen={(next) => {
                        const open =
                            typeof next === 'function'
                                ? next(taskCreateDate !== null)
                                : next;
                        if (!open) setTaskCreateDate(null);
                    }}
                    initialDueAt={taskCreateDate ?? undefined}
                    onCreated={() => {
                        setTaskCreateDate(null);
                        calQuery.mutate();
                    }}
                />
            )}
        </div>
    );
}
