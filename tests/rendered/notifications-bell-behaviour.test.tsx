/** @jest-environment jsdom */

/**
 * Behavioural (Tier-2) test — `<NotificationsBell>`.
 *
 * From `docs/roadmap-audit-2026-05-13.md` "Known broken / risky
 * areas" item #3: the bell (#432) shipped with an off-recipe hover
 * treatment and used raw `toLocaleDateString` for timestamps; #456
 * fixed it. The audit says: "worth confirming the bell actually
 * renders with correct hover + relative-time copy."
 *
 * A structural ratchet could assert the recipe consts are present in
 * source. It could NOT assert:
 *   - that the relative-time output is actually relative ("5m", "2h")
 *     and not a raw `toLocaleDateString` string;
 *   - that the hover class resolves to the canonical hover surface;
 *   - that the unread badge renders the right count from real data.
 *
 * This test renders the component, drives it with mocked
 * `/api/notifications` data, and asserts the RENDERED outcome.
 */

import {
    act,
    cleanup,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { NotificationsBell } from '@/components/layout/notifications-bell';

// ─── env mock (SSE feature flag) ────────────────────────────────────
//
// The SSE block in the bell is gated on
// `env.NEXT_PUBLIC_NOTIFICATIONS_SSE === '1'`, read through the validated
// `@/env` module — raw `process.env` access is banned by the no-fallbacks
// ratchet, so the flag cannot be flipped by assigning to `process.env` from a
// test either: `env` is built once, at module load, from the process
// environment as it stood then.
//
// Only the one key is overridden. Returning an object literal of chosen keys
// would answer `undefined` for every other variable anything in the render
// tree happens to read, and the next variable added to `src/env.ts` would
// silently become undefined here.
const mockEnvOverrides: Record<string, unknown> = {};

jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as {
        env: Record<string, unknown>;
    };
    return {
        ...actual,
        env: new Proxy(actual.env, {
            get: (target, prop) =>
                typeof prop === 'string' && prop in mockEnvOverrides
                    ? mockEnvOverrides[prop]
                    : Reflect.get(target, prop),
        }),
    };
});

// ─── EventSource stub ──────────────────────────────────────────────
//
// jsdom implements no EventSource at all, which is why the bell's whole SSE
// block — and with it the cadence re-arming — was unreachable from this
// suite. The stub is deliberately inert: it opens nothing, and the test fires
// `onopen` / `onerror` by hand to model what a browser does.
class FakeEventSource {
    static instances: FakeEventSource[] = [];

    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    readonly url: string;

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    close(): void {
        this.closed = true;
    }
}

// ─── fetch mock ────────────────────────────────────────────────────

const fetchMock = jest.fn();

function isoMinutesAgo(min: number): string {
    return new Date(Date.now() - min * 60_000).toISOString();
}

interface NotifFixture {
    id: string;
    type: string;
    title: string;
    message: string;
    read: boolean;
    linkUrl: string | null;
    createdAt: string;
}

function makeNotifications(): NotifFixture[] {
    return [
        {
            id: 'n1',
            type: 'TASK',
            title: 'Control C-12 needs review',
            message: 'A control test is overdue.',
            read: false,
            linkUrl: '/t/acme/controls/c12',
            createdAt: isoMinutesAgo(5), // → "5m"
        },
        {
            id: 'n2',
            type: 'AUDIT',
            title: 'Audit cycle started',
            message: 'Q2 audit cycle has begun.',
            read: false,
            linkUrl: null,
            createdAt: isoMinutesAgo(150), // 2.5h → "2h"
        },
        {
            id: 'n3',
            type: 'POLICY',
            title: 'Policy approved',
            message: 'Acceptable Use Policy v3 was approved.',
            read: true,
            linkUrl: null,
            createdAt: isoMinutesAgo(60 * 24 * 3), // 3d → "3d"
        },
    ];
}

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

describe('<NotificationsBell> — behavioural (Tier 2)', () => {
    it('renders the unread COUNT from real data (not a hard-coded badge)', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);

        // The mount-time ping fetches the list; the badge then shows
        // the count of `read: false` rows. The fixture has 2 unread.
        const badge = await screen.findByTestId(
            'notifications-unread-badge',
        );
        expect(badge.textContent).toBe('2');
    });

    describe('an expired session stops the poll', () => {
        /**
         * The production symptom this covers: a tab left open past its JWT
         * expiry logged
         *
         *     GET https://app.inflect.bg/api/notifications 401 (Unauthorized)
         *
         * to the browser console every 60 seconds, indefinitely. The 401 is
         * correct — `middleware.ts` returns it when `getToken()` finds no
         * valid cookie — and it is invisible server-side, because the
         * middleware short-circuits before the route's request logging. So
         * the client was the only place this could be seen OR fixed.
         *
         * Timers are faked so the interval can be advanced deterministically;
         * a wall-clock test would have to wait 60 real seconds to catch a
         * regression, which means in practice it would be deleted.
         */
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.runOnlyPendingTimers();
            jest.useRealTimers();
        });

        const unauthorized = () => ({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Unauthorized' }),
        });

        it('does not poll again after a 401', async () => {
            fetchMock.mockResolvedValue(unauthorized());
            render(<NotificationsBell />);

            await act(async () => {
                await Promise.resolve();
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Five full poll periods. Before the fix this was five more
            // requests and five more console errors.
            await act(async () => {
                jest.advanceTimersByTime(5 * 60_000);
                await Promise.resolve();
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('keeps polling after a NON-auth failure, which is transient', async () => {
            // The negative that stops the fix from over-reaching. A 500 or a
            // dropped connection is worth retrying; killing the poll on every
            // !res.ok would turn one blip into a permanently dead bell, which
            // is a worse bug than the one being fixed and would look identical
            // in the test above.
            fetchMock.mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({}),
            });
            render(<NotificationsBell />);

            await act(async () => {
                await Promise.resolve();
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                jest.advanceTimersByTime(60_000);
                await Promise.resolve();
            });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('tells the user their session went, rather than failing silently', async () => {
            fetchMock.mockResolvedValue(unauthorized());
            render(<NotificationsBell />);

            await act(async () => {
                await Promise.resolve();
            });

            const bell = screen.getByTestId('top-chrome-notifications-bell');
            await act(async () => {
                bell.click();
                await Promise.resolve();
            });

            // Copy comes from the message catalogue, so assert on the rendered
            // text rather than the key — a missing key renders the key itself
            // and would pass a key-based assertion.
            expect(screen.getByText('Your session has expired.')).toBeTruthy();
            const link = screen.getByText('Sign in again');
            expect(link.getAttribute('href')).toBe('/login');
        });
    });

    it('does not render an unread badge when everything is read', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () =>
                makeNotifications().map((n) => ({ ...n, read: true })),
        });
        render(<NotificationsBell />);

        // Let the mount-time fetch settle.
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        // The badge is conditional on unreadCount > 0 — it must be
        // absent, not present-with-"0".
        await waitFor(() => {
            expect(
                screen.queryByTestId('notifications-unread-badge'),
            ).toBeNull();
        });
    });

    it('the bell button carries the canonical hover surface class', () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [],
        });
        render(<NotificationsBell />);
        const bell = screen.getByTestId('top-chrome-notifications-bell');

        // The audit's complaint was an OFF-recipe hover. The canonical
        // top-chrome hover surface is `hover:bg-bg-muted/50` +
        // `hover:text-content-emphasis`. Assert the rendered button
        // carries BOTH halves of the recipe — and is NOT using the
        // off-recipe solid `hover:bg-bg-muted` (no `/50`) the bell
        // originally shipped with.
        expect(bell.className).toContain('hover:bg-bg-muted/50');
        expect(bell.className).toContain('hover:text-content-emphasis');
    });

    it('renders RELATIVE timestamps ("5m", "2h", "3d") — not raw dates', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);
        // Wait for the mount-time fetch so the popover has data.
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(
            screen.getByTestId('top-chrome-notifications-bell'),
        );

        const list = await screen.findByTestId('notifications-list');

        // The fixture rows are 5 minutes, 150 minutes, and 3 days old.
        // The bell's relative-time formatter must render "5m", "2h",
        // "3d" — compact relative strings.
        await waitFor(() => {
            expect(within(list).getByText('5m')).toBeInTheDocument();
        });
        expect(within(list).getByText('2h')).toBeInTheDocument();
        expect(within(list).getByText('3d')).toBeInTheDocument();

        // The exact regression the audit named: NO raw
        // `toLocaleDateString` output. A locale date for a 5-minute-
        // old notification would contain a slash or a month name and
        // a 4-digit year. Assert none of the rendered time chips
        // looks like a full date.
        const year = new Date().getFullYear().toString();
        const timeChips = list.querySelectorAll('.tabular-nums');
        expect(timeChips.length).toBeGreaterThan(0);
        for (const chip of Array.from(timeChips)) {
            const text = chip.textContent ?? '';
            // Relative chips are short tokens; a raw locale date is
            // long and carries the current year.
            expect(text).not.toContain('/');
            expect(text).not.toContain(year);
            expect(text.length).toBeLessThanOrEqual(8);
        }
    });

    it('opening the popover renders one row per notification with the hover recipe', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(
            screen.getByTestId('top-chrome-notifications-bell'),
        );

        // Each notification renders a row keyed by id.
        const row1 = await screen.findByTestId('notification-row-n1');
        expect(
            screen.getByTestId('notification-row-n2'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('notification-row-n3'),
        ).toBeInTheDocument();

        // The row hover surface is the canonical `hover:bg-bg-muted/50`
        // — the same /50 recipe as the bell button, not a solid tint.
        expect(row1.className).toContain('hover:bg-bg-muted/50');

        // n1 has a linkUrl → it must render as a real navigable
        // anchor, not a button.
        expect(row1.tagName).toBe('A');
        expect(row1.getAttribute('href')).toBe('/t/acme/controls/c12');
        // n2 has no linkUrl → renders as a button.
        expect(
            screen.getByTestId('notification-row-n2').tagName,
        ).toBe('BUTTON');
    });

    it('REST-polls /api/notifications on a fixed interval (badge stays live)', async () => {
        // The bell's doc-comment promised a periodic poll; the code
        // shipped without one, so the badge froze at its mount-time
        // value. This asserts the poll is real: advancing the
        // 60s interval triggers a fresh fetch with no user action.
        jest.useFakeTimers();
        try {
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => makeNotifications(),
            });
            render(<NotificationsBell />);
            // Flush the mount-time fetch.
            await act(async () => {});
            const afterMount = fetchMock.mock.calls.length;
            expect(afterMount).toBeGreaterThanOrEqual(1);

            // One poll interval elapses → at least one more fetch.
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(afterMount);

            // The poll is periodic — a second interval fetches again.
            const afterFirstPoll = fetchMock.mock.calls.length;
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirstPoll);
        } finally {
            jest.useRealTimers();
        }
    });

    it('shows the "All clear" empty state when there are no notifications', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [],
        });
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(
            screen.getByTestId('top-chrome-notifications-bell'),
        );

        // The audit's R11 personality vocabulary: "All clear", not a
        // generic "No notifications".
        expect(await screen.findByText('All clear')).toBeInTheDocument();
    });
});

// ─── SSE health → poll cadence ─────────────────────────────────────

describe('<NotificationsBell> — SSE health governs the fallback poll', () => {
    /**
     * The bell throttles its REST poll from 60s to 5 minutes while the SSE
     * stream is healthy, and back to 60s when it is not. Both transitions run
     * through one `arm(ms)` helper, and the property that matters is that
     * `arm` is IDEMPOTENT — a request for the cadence already running must
     * leave the running countdown alone.
     *
     * It matters because neither handler fires once per state change.
     * `EventSource.onerror` fires on every reconnect ATTEMPT (the browser's
     * default backoff is ~3s, and `/api/notifications/stream` sends no
     * `retry:` field to widen it), so a stream that cannot connect asks for
     * the 60s cadence roughly twenty times a minute. A non-idempotent `arm`
     * restarts the interval on each of those, the 60s deadline is never
     * reached, and the fallback poll is silently dead in precisely the
     * situation it exists to cover — the inverse of its documented purpose.
     * The healthy mirror is as real: a proxy recycling a live connection
     * re-fires `onopen`.
     *
     * Timers are faked; a wall-clock version of this would have to wait five
     * real minutes, which means in practice it would be deleted.
     */
    beforeEach(() => {
        jest.useFakeTimers();
        FakeEventSource.instances = [];
        (globalThis as unknown as { EventSource?: unknown }).EventSource =
            FakeEventSource;
        mockEnvOverrides.NEXT_PUBLIC_NOTIFICATIONS_SSE = '1';
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [],
        });
    });

    afterEach(() => {
        delete mockEnvOverrides.NEXT_PUBLIC_NOTIFICATIONS_SSE;
        delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
        // Unmount BEFORE draining the timers: a poll fired at teardown would
        // set state on a still-mounted component outside `act`.
        cleanup();
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    /**
     * `fetchList` takes three microtask turns to finish: `fetch()`, then
     * `res.json()`, then the `setItems` / `setLoading` tail. Draining only one
     * leaves that tail landing outside the `act` window, which React 19
     * reports as a console error — and which this repo has seen escalate from
     * a warning into a failure under worker memory pressure.
     */
    async function settle(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    /**
     * The stream the component opened. Asserting it exists is not decoration:
     * if the env mock or the global stub stopped taking, the SSE block would
     * be skipped entirely and every assertion below would pass for the wrong
     * reason — the poll would simply sit at its default 60s cadence.
     */
    async function mountAndGetStream(): Promise<FakeEventSource> {
        render(<NotificationsBell />);
        await act(async () => {
            await settle();
        });
        // The mount-time seed fetch, and nothing else yet.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        expect(FakeEventSource.instances).toHaveLength(1);
        const es = FakeEventSource.instances[0];
        expect(es.url).toBe('/api/notifications/stream');
        return es;
    }

    it('a flapping stream does not starve the 60s fallback poll', async () => {
        const es = await mountAndGetStream();

        // Twenty failed reconnects at the browser's ~3s default backoff —
        // sixty seconds of wall clock, one whole poll period.
        for (let i = 0; i < 20; i += 1) {
            await act(async () => {
                jest.advanceTimersByTime(3_000);
                es.onerror?.();
                await settle();
            });
        }

        // The poll must have fired. Before the fix each onerror cleared and
        // reinstalled the 60s interval, pushing the deadline out by 3s every
        // 3s, and this stayed at 1 forever.
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    it('a healthy stream drops to the 5-minute cadence and stays there', async () => {
        const es = await mountAndGetStream();

        await act(async () => {
            es.onopen?.();
            await settle();
        });

        // Four minutes, with a proxy re-announcing the same healthy
        // connection once a minute. The 60s cadence is gone, so nothing
        // fetches...
        for (let i = 0; i < 4; i += 1) {
            await act(async () => {
                jest.advanceTimersByTime(60_000);
                es.onopen?.();
                await settle();
            });
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // ...and the fifth minute still arrives. Repeated `onopen` must not
        // push the 5-minute deadline forward forever.
        await act(async () => {
            jest.advanceTimersByTime(60_000);
            await settle();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('drops back to the 60s cadence when a healthy stream errors', async () => {
        // The negative that stops the idempotence from over-reaching: a
        // GENUINE change of cadence must still re-arm. An `arm` that only
        // ever refused to restart would pass both tests above while freezing
        // the bell at five minutes through a total SSE outage.
        const es = await mountAndGetStream();

        await act(async () => {
            es.onopen?.();
            await settle();
        });
        // One minute at the throttled cadence: no poll.
        await act(async () => {
            jest.advanceTimersByTime(60_000);
            await settle();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            es.onerror?.();
            await settle();
        });
        await act(async () => {
            jest.advanceTimersByTime(60_000);
            await settle();
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('closes the stream on unmount', async () => {
        const es = await mountAndGetStream();
        expect(es.closed).toBe(false);

        cleanup();

        expect(es.closed).toBe(true);
    });
});
