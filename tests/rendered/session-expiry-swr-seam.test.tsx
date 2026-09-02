/**
 * #2222 — the SWR half of the 401 seam must stop FETCHING without discarding
 * the error.
 *
 * The first revision used `isPaused: isSessionExpired`. SWR checks that flag
 * twice: at the top of `revalidate`, which is what we want, and again inside
 * its own `catch`, where a paused config DISCARDS the error instead of
 * assigning `finalState.error`. That bought quiet at the price of blindness —
 * 17 components destructure `error`, and `MonitorTab`'s own "feed unavailable"
 * branch is guarded on `error && !data`, so it would never fire in the one
 * case it was written for.
 *
 * These tests bind to that specific property. Re-adding `isPaused` to the seam
 * turns the first one red; it is not satisfied by the flag being set, which a
 * paused config also does.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import useSWR from 'swr';
import { useSwrSessionSeam } from '@/app/providers';
import {
    isSessionExpired,
    noteUnauthorized,
    __resetSessionExpiryForTests,
} from '@/lib/auth/session-expiry';

// The SWR key doubles as the URL `noteUnauthorized` inspects — it marks only
// for a session-bearing API path (`/api/`, not `/api/auth/`), so a bare label
// like 'probe-key' is correctly ignored and the fixture has to look like a
// real request. That predicate is deliberate: a 401 from `/api/auth/` is the
// sign-in flow doing its job, not an expired session.
class FakeApiError extends Error {
    constructor(readonly status: number) {
        super(`http ${status}`);
    }
}

function Probe() {
    const { data, error, isLoading } = useSWR('/api/t/acme/risks', () => {
        // MARK, THEN THROW — the order `api-client.ts::handleErrorResponse`
        // uses, and the whole reason `isPaused` is the wrong lever. By the
        // time SWR reaches its own catch the flag is already set, so a paused
        // config discards the error there. A fetcher that threw WITHOUT
        // marking would not reproduce this: the first error would land
        // normally and only later hooks would go blind, which is why an
        // earlier version of this test passed against the defect.
        noteUnauthorized(401, '/api/t/acme/risks');
        throw new FakeApiError(401);
    });
    return (
        <div>
            <span data-testid="err">{error ? String((error as FakeApiError).status) : 'no-error'}</span>
            <span data-testid="data">{data ? 'has-data' : 'no-data'}</span>
            <span data-testid="loading">{isLoading ? 'loading' : 'settled'}</span>
        </div>
    );
}

function Harness() {
    const seam = useSwrSessionSeam();
    // A fresh provider cache per render tree, so one test cannot seed another.
    return (
        <SWRConfig value={{ ...seam, provider: () => new Map() }}>
            <Probe />
        </SWRConfig>
    );
}

describe('#2222 — the SWR seam surfaces the 401 it acts on', () => {
    beforeEach(() => __resetSessionExpiryForTests());

    it('assigns the error to the hook — a paused config would discard it', async () => {
        render(<Harness />);
        await waitFor(() => {
            expect(screen.getByTestId('err').textContent).toBe('401');
        });
        // The consumer-visible half. `isPaused` left this at 'no-error' while
        // still setting the flag below, which is why asserting the flag alone
        // would not have caught it.
        expect(screen.getByTestId('data').textContent).toBe('no-data');
    });

    it('also marks the session expired, so pollers can quiesce', async () => {
        render(<Harness />);
        await waitFor(() => expect(isSessionExpired()).toBe(true));
    });

    it('does NOT mark on a non-401 — one blip must not kill every poller', async () => {
        function Probe500() {
            const { error } = useSWR('/api/t/acme/controls', () => {
                throw new FakeApiError(500);
            });
            return <span data-testid="err500">{error ? 'errored' : 'none'}</span>;
        }
        function Harness500() {
            const seam = useSwrSessionSeam();
            return (
                <SWRConfig value={{ ...seam, provider: () => new Map() }}>
                    <Probe500 />
                </SWRConfig>
            );
        }
        render(<Harness500 />);
        await waitFor(() => expect(screen.getByTestId('err500').textContent).toBe('errored'));
        expect(isSessionExpired()).toBe(false);
    });
});
