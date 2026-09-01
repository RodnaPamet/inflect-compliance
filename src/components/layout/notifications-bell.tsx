'use client';

/**
 * Roadmap-14 PR-8 — `<NotificationsBell>` — notification affordance
 * in the top-bar right slot.
 *
 * Mounts between the workspace switcher and the user menu. Shows a
 * bell icon with a count badge for unread notifications; click
 * opens a popover listing recent notifications.
 *
 * Data: REST-polled from `/api/notifications`. A fetch on mount
 * seeds the badge; a fixed-cadence poll (NOTIFICATIONS_POLL_INTERVAL_MS)
 * keeps the unread count live without the user opening the popover;
 * and every popover-open pulls a fresh list. The poll pauses while
 * the browser tab is hidden and refetches on return, so a
 * backgrounded tab never hammers the endpoint.
 *
 * Each notification:
 *
 *   • Title + message (truncated to one + two lines respectively).
 *   • Time (relative, formatted via Intl.RelativeTimeFormat).
 *   • Click → marks-read + navigates to `linkUrl` if present.
 *
 * Empty state uses the R11 personality vocabulary — "All clear"
 * with a calm icon, not a generic "No notifications" sentence.
 *
 * Mark-all-read action lives in the popover footer (bulk verb).
 *
 * Out of scope (separate roadmaps — do not blur in here):
 *   • Real-time push. The bell REST-polls by design; SSE / WebSocket
 *     streaming is a separate infrastructure roadmap. When it lands
 *     it replaces the poll interval below and nothing else — the
 *     fetch/merge/render path is already the seam.
 *   • Notification preferences / settings.
 *   • Per-channel filtering — the count is unread-total only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bell, CheckCheck } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateCompact } from '@/lib/format-date';
import { env } from '@/env';
import { NAV_BAR_SLOT_PRESS } from './nav-bar';
import { HIT_AREA_CLASS } from '@/components/ui/hit-area';

// ─── Types ─────────────────────────────────────────────────────────

interface NotificationRow {
    id: string;
    type: string;
    title: string;
    message: string;
    read: boolean;
    linkUrl: string | null;
    createdAt: string;
}

// ─── Polling ───────────────────────────────────────────────────────

/**
 * REST-poll cadence for the unread badge. 60s is frequent enough
 * that the count feels live without meaningfully loading the
 * endpoint. This interval IS the real-time mechanism today — a
 * future SSE / WebSocket roadmap would replace it.
 */
const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

/**
 * 2026-05-27 (PR-C) — when the SSE channel is open and healthy,
 * the poll throttles to 5 minutes — coverage for the cross-pod
 * gap (a notification created on a pod whose bus subscribers
 * don't include this client will reach the bell within 5 min via
 * the fallback poll). When SSE errors, this drops back to the
 * original 60s.
 */
const NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS = 5 * 60_000;

// ─── Recipes ───────────────────────────────────────────────────────

// `HIT_AREA_CLASS`: a 22px `rounded-full` bell is a circle in a square —
// 14% of its box rendered as bell but did not answer to `:hover`. See
// `hit-area.ts` for the measurements.
const BELL_BUTTON_CLASS =
    `relative inline-flex items-center justify-center h-[22px] w-[22px] rounded-full text-content-muted transition-colors hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${NAV_BAR_SLOT_PRESS} ${HIT_AREA_CLASS}`;

const BADGE_OVERLAY_CLASS =
    // Pill chip pinned to the bell's top-right corner. Negative
    // inset puts it slightly outside the bell's bounding box so
    // the bell glyph remains uncluttered.
    'absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-bg-error-emphasis text-[10px] font-semibold text-content-inverted tabular-nums leading-none';

const ROW_CLASS =
    'flex flex-col gap-tight rounded-md px-2.5 py-2 transition-colors hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

const ROW_UNREAD_CLASS = 'bg-bg-subtle';

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Relative-time formatter. Returns "5m", "2h", "3d", "Mar 12".
 * Avoids dependency on date-fns / dayjs — this is the only place in
 * the bell that needs date formatting.
 */
function formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Date.now() - then;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    return formatDateCompact(iso);
}

// ─── Component ─────────────────────────────────────────────────────

export function NotificationsBell() {
    const t = useTranslations('panels.bell');
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<NotificationRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Distinct from `error`: this one is terminal and gets its own copy with a
    // way out, because "reload the page" is the only thing that helps.
    const [sessionExpired, setSessionExpired] = useState(false);

    const close = useCallback(() => setOpen(false), []);

    /**
     * Set once the endpoint has answered 401/403, and never cleared.
     *
     * A ref rather than state on purpose: the poll callback below closes over
     * it, and a state update would not be visible to the already-scheduled
     * interval — which is the exact shape of the bug this guards against.
     */
    const authFailedRef = useRef(false);

    const fetchList = useCallback(async () => {
        // Belt and braces with the interval teardown: `open` and
        // `visibilitychange` also call this, and both must stay quiet once the
        // session is gone.
        if (authFailedRef.current) return;

        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/notifications', {
                credentials: 'same-origin',
            });

            // AN EXPIRED SESSION IS TERMINAL, NOT A TRANSIENT FAILURE.
            //
            // This used to fall into the `!res.ok` throw below, which set the
            // error banner and left the 60s interval running — so a tab left
            // open past its JWT expiry re-requested `/api/notifications`,
            // failed 401, and logged a console error every 60 seconds for as
            // long as the tab stayed visible. Nothing ever told the user their
            // session had gone, and nothing ever stopped.
            //
            // Retrying cannot help: the 401 comes from `middleware.ts`, where
            // `getToken()` returned null for a missing, malformed or expired
            // cookie. None of those resolve by asking again — only signing in
            // does.
            if (res.status === 401 || res.status === 403) {
                authFailedRef.current = true;
                setSessionExpired(true);
                setItems(null);
                return;
            }

            if (!res.ok) {
                throw new Error(`Failed to load notifications (${res.status})`);
            }
            const body = (await res.json()) as NotificationRow[];
            setItems(body);
        } catch (e) {
            setError(
                e instanceof Error ? e.message : 'Failed to load notifications',
            );
        } finally {
            setLoading(false);
        }
    }, []);

    // 2026-05-27 (PR-C) — SSE-first with REST poll as a fallback.
    // Primary signal: an EventSource subscription to
    // `/api/notifications/stream`. Each server-side notification
    // create emits an event; the bell prepends it to the list the
    // moment it lands — no 60s wait. The browser's EventSource
    // handles reconnect automatically after network blips.
    //
    // Fallback path: the original 60s REST poll stays in place but
    // throttled to ~5 minutes when SSE is healthy (so a cross-pod
    // notification — produced on a pod whose bus subscribers don't
    // include us — still reaches the bell within five minutes).
    // If the SSE connection errors (single-process bus on a
    // restart-friendly platform, or a corporate proxy stripping
    // text/event-stream), we drop back to the 60s cadence so the
    // user keeps seeing the unread count tick.
    useEffect(() => {
        fetchList();

        let es: EventSource | null = null;
        // Assigned below, once the interval exists. Declared here so the SSE
        // handlers — created before it — can close over the binding.
        let onSseHealthChange: ((healthy: boolean) => void) | null = null;
        // typeof check — SSR + jsdom unit tests both lack EventSource.
        // Feature flag: NEXT_PUBLIC_NOTIFICATIONS_SSE=1 opts the
        // client into the SSE channel. Defaults OFF so the bell keeps
        // polling — the server-side bus + endpoint stay wired (so
        // future opt-in is one env-var flip), but E2E specs that wait
        // on `networkidle` aren't blocked by a long-lived stream that
        // never lets the page settle. Flip when the client integration
        // has been manually verified end-to-end (browser → bell →
        // event arriving inside <1s).
        const sseEnabled = env.NEXT_PUBLIC_NOTIFICATIONS_SSE === '1';
        if (sseEnabled && typeof EventSource !== 'undefined') {
            try {
                es = new EventSource('/api/notifications/stream', {
                    withCredentials: true,
                });
                es.onopen = () => onSseHealthChange?.(true);
                es.onmessage = (msg) => {
                    try {
                        const event = JSON.parse(msg.data) as NotificationRow;
                        // Prepend if not already present (dedupe by id —
                        // the server includes the row id OR the dedupeKey
                        // as id so cross-channel duplicates collapse).
                        setItems((prev) => {
                            const list = prev ?? [];
                            if (list.some((n) => n.id === event.id)) return list;
                            return [event, ...list];
                        });
                    } catch {
                        // Malformed event — refetch to recover.
                        void fetchList();
                    }
                };
                es.onerror = () => onSseHealthChange?.(false);
            } catch {
                // Construction itself threw (a blocked scheme, a proxy that
                // refuses text/event-stream at connect time). There is no
                // stream and no health signal, so the poll simply stays at the
                // 60s cadence armed below — nothing to re-arm.
            }
        }

        // The cadence is re-armed when the stream's health CHANGES, rather than
        // read once here.
        //
        // Reading it once was a dead branch: the health flag is false at this
        // point in the effect ALWAYS, because `es.onopen` cannot have fired on
        // a socket opened microseconds earlier in the same synchronous block.
        // So `NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS` was unreachable and the
        // poll stayed at 60s even with SSE healthy — the opposite of what the
        // comment on that constant promises. Currently masked because
        // NEXT_PUBLIC_NOTIFICATIONS_SSE defaults off, so the only way to meet
        // it is to flip the flag and wonder why traffic did not drop 5x.
        //
        // There is no separate `sseHealthy` variable: the handlers call
        // `arm()` with the cadence they want and `arm()` owns the current
        // one. A flag read by nobody is how the dead branch above happened.
        let intervalId = 0;
        // The cadence currently armed. Zero is not a cadence any caller asks
        // for, so the first arm() below always installs a timer.
        let armedMs = 0;
        const poll = () => {
            // Stop the timer from inside itself. The auth failure can land on
            // any tick, and there is no outer signal to react to.
            if (authFailedRef.current) {
                window.clearInterval(intervalId);
                return;
            }
            if (typeof document !== 'undefined' && document.hidden) return;
            void fetchList();
        };
        /**
         * Install the poll at `ms` — or leave the running timer alone when it
         * is already at that cadence.
         *
         * The no-op is the load-bearing half, because both health handlers
         * fire far more often than they change anything. `es.onerror` fires on
         * every EventSource reconnect ATTEMPT, not once per outage: the
         * browser's default backoff is ~3s and `/api/notifications/stream`
         * sends no `retry:` field to widen it, so a stream that cannot connect
         * asks for 60s again about twenty times a minute. Clearing and
         * restarting the interval on each of those discards the elapsed
         * countdown, so a 60s poll restarted every 3s NEVER elapses — the
         * fallback would be dead in exactly the case it exists to cover. The
         * mirror case is as real: a proxy recycling a healthy connection
         * re-fires `onopen`, and the 5-minute poll would never elapse either.
         *
         * A genuine change of cadence does still restart the countdown; that
         * is a stream alternating open→error→open, which is rarer than the
         * flat cases above and asks for a different interval each time.
         */
        const arm = (ms: number) => {
            // Terminal auth failure outranks every cadence: `poll` clears the
            // interval from inside itself when it lands, and an SSE health
            // change arriving afterwards must not install a fresh one.
            if (authFailedRef.current) return;
            if (ms === armedMs) return;
            armedMs = ms;
            window.clearInterval(intervalId);
            intervalId = window.setInterval(poll, ms);
        };
        arm(NOTIFICATIONS_POLL_INTERVAL_MS);
        // Re-arm at the slower cadence once SSE actually reports healthy, and
        // back to 60s if it drops.
        onSseHealthChange = (healthy: boolean) =>
            arm(
                healthy
                    ? NOTIFICATIONS_FALLBACK_POLL_INTERVAL_MS
                    : NOTIFICATIONS_POLL_INTERVAL_MS,
            );

        const onVisibility = () => {
            if (authFailedRef.current) return;
            if (!document.hidden) void fetchList();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.clearInterval(intervalId);
            document.removeEventListener('visibilitychange', onVisibility);
            onSseHealthChange = null;
            if (es) es.close();
        };
    }, [fetchList]);

    // Opening the popover always pulls a fresh list — the user is
    // looking now, so show current data, not the last poll's.
    useEffect(() => {
        if (!open) return;

        fetchList();
    }, [open, fetchList]);

    const unreadCount = items?.filter((n) => !n.read).length ?? 0;
    const hasItems = (items?.length ?? 0) > 0;

    const handleRowClick = useCallback(
        async (n: NotificationRow) => {
            // Optimistic local mark-as-read so the badge updates the
            // moment the user clicks.
            setItems((prev) =>
                prev
                    ? prev.map((x) => (x.id === n.id ? { ...x, read: true } : x))
                    : prev,
            );
            try {
                await fetch(`/api/notifications/${n.id}`, {
                    method: 'PATCH',
                    credentials: 'same-origin',
                });
            } catch {
                // Server-side mark failed; the local optimistic
                // update remains so the user perceives the row as
                // handled. Next fetch will reconcile if needed.
            }
        },
        [],
    );

    const handleMarkAllRead = useCallback(async () => {
        const unread = items?.filter((n) => !n.read) ?? [];
        if (unread.length === 0) return;
        setItems((prev) =>
            prev ? prev.map((x) => ({ ...x, read: true })) : prev,
        );
        await Promise.all(
            unread.map((n) =>
                fetch(`/api/notifications/${n.id}`, {
                    method: 'PATCH',
                    credentials: 'same-origin',
                }).catch(() => {}),
            ),
        );
    }, [items]);

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={8}
            popoverContentClassName="w-[340px] max-w-[calc(100vw-1rem)] p-1"
            content={
                <Popover.Menu aria-label={t('notifications')}>
                    {/* Header row — count + mark-all-read action */}
                    <div className="flex items-center justify-between px-2.5 py-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                            {t('notifications')}
                        </span>
                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={handleMarkAllRead}
                                className="inline-flex items-center gap-tight text-xs text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded px-1"
                                data-testid="notifications-mark-all-read"
                            >
                                <CheckCheck
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                />
                                {t('markAllRead')}
                            </button>
                        )}
                    </div>

                    <Popover.Separator />

                    {/* Content */}
                    <div
                        className="max-h-[400px] overflow-y-auto"
                        data-testid="notifications-list"
                    >
                        {/* Terminal, so it precedes every other branch: once
                            the session is gone there is nothing to load and
                            nothing to retry, and the only useful thing the
                            panel can do is say so and offer the way back. */}
                        {sessionExpired ? (
                            <div className="px-2.5 py-6 text-center text-xs text-content-muted">
                                <p>{t('sessionExpired')}</p>
                                <Link
                                    href="/login"
                                    className="mt-1 inline-block font-medium text-content-emphasis underline underline-offset-2"
                                >
                                    {t('sessionExpiredAction')}
                                </Link>
                            </div>
                        ) : loading && items === null ? (
                            <div className="px-2.5 py-6 text-center text-xs text-content-muted animate-pulse">
                                {t('loading')}
                            </div>
                        ) : error ? (
                            <div className="px-2.5 py-6 text-center text-xs text-content-error">
                                {error}
                            </div>
                        ) : !hasItems ? (
                            <div className="py-4">
                                <EmptyState
                                    icon={Bell}
                                    title={t('allClear')}
                                    description={t('caughtUp')}
                                />
                            </div>
                        ) : (
                            items!.map((n) => {
                                const row = (
                                    <>
                                        <div className="flex items-center justify-between gap-tight">
                                            <p className="min-w-0 flex-1 break-words text-sm font-medium text-content-emphasis">
                                                {n.title}
                                            </p>
                                            <span className="flex-shrink-0 text-[10px] text-content-subtle tabular-nums">
                                                {formatRelativeTime(n.createdAt)}
                                            </span>
                                        </div>
                                        <p className="text-xs text-content-muted line-clamp-2">
                                            {n.message}
                                        </p>
                                    </>
                                );
                                const rowClasses = `${ROW_CLASS} ${n.read ? '' : ROW_UNREAD_CLASS}`;
                                return n.linkUrl ? (
                                    <Link
                                        key={n.id}
                                        href={n.linkUrl}
                                        onClick={() => {
                                            close();

                                            handleRowClick(n);
                                        }}
                                        className={rowClasses}
                                        data-testid={`notification-row-${n.id}`}
                                    >
                                        {row}
                                    </Link>
                                ) : (
                                    <button
                                        key={n.id}
                                        type="button"
                                        onClick={() => handleRowClick(n)}
                                        className={`${rowClasses} text-left`}
                                        data-testid={`notification-row-${n.id}`}
                                    >
                                        {row}
                                    </button>
                                );
                            })
                        )}
                    </div>
                </Popover.Menu>
            }
        >
            <button
                type="button"
                className={BELL_BUTTON_CLASS}
                aria-label={
                    unreadCount > 0
                        ? t('unreadAria', { count: unreadCount })
                        : t('notifications')
                }
                aria-expanded={open}
                aria-haspopup="menu"
                data-testid="top-chrome-notifications-bell"
            >
                <Bell className="h-4 w-4" aria-hidden="true" />
                {unreadCount > 0 && (
                    <span
                        className={BADGE_OVERLAY_CLASS}
                        aria-hidden="true"
                        data-testid="notifications-unread-badge"
                    >
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>
        </Popover>
    );
}

