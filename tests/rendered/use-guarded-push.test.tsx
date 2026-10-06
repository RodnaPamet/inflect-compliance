/**
 * `useGuardedPush` — the dropped-navigation workaround for #3099.
 *
 * ── THE TEST THAT MATTERS IS THE SECOND ONE ──────────────────────────────
 *
 * The retry is easy; the PREDICATE is where this goes wrong. The naive version
 * asks "did we reach the target", which fires a second navigation at a user who
 * clicked a row, changed their mind inside the grace window, and went somewhere
 * else. That is a worse bug than the one being fixed — it is not load-dependent,
 * so it would hit every user who hesitates, every time.
 *
 * So the discriminating case is `does NOT retry when the user navigated
 * elsewhere mid-window`. Without it this suite passes against a hook that
 * double-navigates in the one case that matters, because the other three cases
 * cannot tell the two predicates apart.
 *
 * ── HOW THE THREE WORLDS ARE PRODUCED ────────────────────────────────────
 *
 * The router is mocked, so `router.push` does NOT move `location.pathname` the
 * way the real one does. That is what makes the three worlds expressible: the
 * test drives the pathname itself with `history.replaceState`, which is exactly
 * the observable the hook reads.
 *
 *   dropped  — nothing moves the pathname        → retry
 *   elsewhere— replaceState to a THIRD path      → no retry
 *   worked   — replaceState to the target        → no retry
 *
 * Mocking the router is therefore not a convenience here; a real router would
 * couple "did the push commit" to React's scheduler, which is the thing nobody
 * can control from a test and the reason this defect is only visible as a flake.
 */
import { act, renderHook } from '@testing-library/react';

import {
    useGuardedPush,
    shouldRetryDroppedPush,
    pathnameOf,
    DROPPED_PUSH_GRACE_MS,
} from '@/lib/nav/use-guarded-push';
import { NAV_PUSH_RETRY_METRIC } from '@/lib/observability/client-telemetry';

const push = jest.fn();

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push,
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

jest.mock('@/lib/observability/client-telemetry', () => ({
    // The metric NAME is the real one — a test that invented its own string
    // would pass while the producer beaconed a name the server allowlist
    // rejects, which is the exact "wired is not delivered" shape.
    NAV_PUSH_RETRY_METRIC: 'Inflect-nav-push-retry',
    beaconClientMetric: jest.fn(),
}));

const { beaconClientMetric } = require('@/lib/observability/client-telemetry') as {
    beaconClientMetric: jest.Mock;
};

const LIST = '/t/acme/agents';
const DETAIL = '/t/acme/agents/agent_1';
const ELSEWHERE = '/t/acme/assets';

/** Move the browser's pathname the way a committed navigation would. */
function setPathname(pathname: string) {
    window.history.replaceState({}, '', pathname);
}

beforeEach(() => {
    jest.useFakeTimers();
    push.mockClear();
    beaconClientMetric.mockClear();
    setPathname(LIST);
});

afterEach(() => {
    jest.useRealTimers();
});

describe('useGuardedPush', () => {
    it('1. retries once when the pathname never moved (the dropped transition)', () => {
        const { result } = renderHook(() => useGuardedPush());

        act(() => result.current(DETAIL));
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenLastCalledWith(DETAIL);
        // Still on the list page — the transition never committed.
        expect(window.location.pathname).toBe(LIST);

        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));

        expect(push).toHaveBeenCalledTimes(2);
        expect(push).toHaveBeenLastCalledWith(DETAIL);

        // ONCE. A second grace window must not fire a third push — the retry is
        // a bare push, deliberately unguarded.
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS * 5));
        expect(push).toHaveBeenCalledTimes(2);
    });

    it('2. does NOT retry when the user navigated elsewhere inside the window', () => {
        // THE DISCRIMINATING CASE. A predicate that asks "did we reach the
        // target" passes every other test in this file and fails this one by
        // pushing the user back to a row they walked away from.
        const { result } = renderHook(() => useGuardedPush());

        act(() => result.current(DETAIL));
        expect(push).toHaveBeenCalledTimes(1);

        // The user clicks the sidebar 400 ms later and that navigation commits.
        act(() => void jest.advanceTimersByTime(400));
        setPathname(ELSEWHERE);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));

        expect(push).toHaveBeenCalledTimes(1);
        expect(window.location.pathname).toBe(ELSEWHERE);
    });

    it('3. does NOT retry when the push worked', () => {
        const { result } = renderHook(() => useGuardedPush());

        act(() => result.current(DETAIL));
        setPathname(DETAIL);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));

        expect(push).toHaveBeenCalledTimes(1);
    });

    it('4. the telemetry counter fires exactly once on (1) and not at all on (2) or (3)', () => {
        const dropped = renderHook(() => useGuardedPush());
        act(() => dropped.result.current(DETAIL));
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));

        expect(beaconClientMetric).toHaveBeenCalledTimes(1);
        const sample = beaconClientMetric.mock.calls[0][0];
        expect(sample.name).toBe(NAV_PUSH_RETRY_METRIC);
        // The ORIGIN list route, never the destination — a detail pathname ends
        // in the row id and this metric carries no identifier.
        expect(sample.route).toBe(LIST);
        expect(sample.route).not.toContain('agent_1');
        expect(sample.value).toBeGreaterThanOrEqual(DROPPED_PUSH_GRACE_MS);
        dropped.unmount();

        // (2) user went elsewhere.
        beaconClientMetric.mockClear();
        setPathname(LIST);
        const elsewhere = renderHook(() => useGuardedPush());
        act(() => elsewhere.result.current(DETAIL));
        setPathname(ELSEWHERE);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(beaconClientMetric).not.toHaveBeenCalled();
        elsewhere.unmount();

        // (3) push worked.
        setPathname(LIST);
        const worked = renderHook(() => useGuardedPush());
        act(() => worked.result.current(DETAIL));
        setPathname(DETAIL);
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));
        expect(beaconClientMetric).not.toHaveBeenCalled();
    });

    it('arms no watch for a push that cannot change the pathname', () => {
        // A query-only push (`?cycleId=…`) is indistinguishable from a dropped
        // one by a pathname test, so it gets no watch rather than a wrong one.
        const { result } = renderHook(() => useGuardedPush());

        act(() => result.current(`${LIST}?view=deleted`));
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS * 3));

        expect(push).toHaveBeenCalledTimes(1);
        expect(beaconClientMetric).not.toHaveBeenCalled();
    });

    it('a second row click replaces the pending watch rather than adding one', () => {
        const other = '/t/acme/agents/agent_2';
        const { result } = renderHook(() => useGuardedPush());

        act(() => result.current(DETAIL));
        act(() => void jest.advanceTimersByTime(600));
        act(() => result.current(other));
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS));

        // Two clicks + ONE retry, for the second click's href.
        expect(push).toHaveBeenCalledTimes(3);
        expect(push).toHaveBeenLastCalledWith(other);
        expect(beaconClientMetric).toHaveBeenCalledTimes(1);
    });

    it('leaving the page cancels a pending retry', () => {
        const { result, unmount } = renderHook(() => useGuardedPush());

        act(() => result.current(DETAIL));
        unmount();
        act(() => void jest.advanceTimersByTime(DROPPED_PUSH_GRACE_MS * 3));

        expect(push).toHaveBeenCalledTimes(1);
        expect(beaconClientMetric).not.toHaveBeenCalled();
    });
});

describe('shouldRetryDroppedPush — the predicate on its own', () => {
    // Driven directly as well as through the hook: the hook tests prove the
    // WIRING, these prove the truth table has no fourth corner.
    it.each([
        ['dropped', LIST, LIST, DETAIL, true],
        ['user went elsewhere', LIST, ELSEWHERE, DETAIL, false],
        ['push committed', LIST, DETAIL, DETAIL, false],
        ['target is where we already are', LIST, LIST, LIST, false],
    ])('%s', (_name, startPath, currentPath, targetPath, expected) => {
        expect(
            shouldRetryDroppedPush({
                startPath: startPath as string,
                currentPath: currentPath as string,
                targetPath: targetPath as string,
            }),
        ).toBe(expected);
    });
});

describe('pathnameOf', () => {
    it('drops the query and the hash', () => {
        expect(pathnameOf(`${DETAIL}?tab=tools#pins`)).toBe(DETAIL);
    });

    it('resolves a relative href against the current document', () => {
        setPathname('/t/acme/agents/');
        expect(pathnameOf('agent_1')).toBe('/t/acme/agents/agent_1');
    });
});
