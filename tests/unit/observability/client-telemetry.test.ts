/**
 * @jest-environment jsdom
 */

/**
 * The browser → server telemetry beacon.
 *
 * This is the SEAM the `useGuardedPush` tests mock out. An injected sink leaves
 * the send itself unexercised, and the send is where every way of being silently
 * wrong lives: the wrong URL, the wrong body shape, a gate that swallows
 * everything, a throw that reaches a click handler.
 *
 * The URL and the body shape are asserted against what
 * `/api/telemetry/vitals`'s route handler actually reads — `name`, `value`,
 * `route` — because a beacon posting a shape the sink ignores returns 204 and
 * looks exactly like a beacon that worked.
 */
import {
    beaconClientMetric,
    TELEMETRY_BEACON_URL,
    NAV_PUSH_RETRY_METRIC,
} from '@/lib/observability/client-telemetry';

// Parameters DECLARED, not inferred. `jest.fn(() => true)` types its own
// `mock.calls` as a zero-length tuple, so `calls[0][1]` is a type error and the
// body assertion below cannot be written at all — tsc caught exactly that.
const sendBeacon = jest.fn((_url: string, _body?: BodyInit | null) => true);

/**
 * Read the beaconed Blob back as text.
 *
 * `FileReader`, not `blob.text()`: jsdom's Blob in this environment has no
 * `text()` method (measured — the first version of this helper threw
 * `blob.text is not a function`), and a helper that cannot read the body would
 * have had to be replaced by an assertion about the Blob's existence, which is
 * satisfied by a beacon carrying the wrong fields.
 */
function bodyOf(blob: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            try {
                resolve(JSON.parse(String(reader.result)) as Record<string, unknown>);
            } catch (err) {
                reject(err);
            }
        };
        reader.readAsText(blob as Blob);
    });
}

beforeEach(() => {
    sendBeacon.mockClear();
    Object.defineProperty(window.navigator, 'sendBeacon', {
        value: sendBeacon,
        configurable: true,
        writable: true,
    });
    delete process.env.NEXT_PUBLIC_TEST_MODE;
});

describe('beaconClientMetric', () => {
    it('posts to the existing vitals sink, not a new endpoint', () => {
        beaconClientMetric({ name: NAV_PUSH_RETRY_METRIC, value: 1000, route: '/t/acme/agents' });

        expect(sendBeacon).toHaveBeenCalledTimes(1);
        expect(sendBeacon.mock.calls[0][0]).toBe('/api/telemetry/vitals');
        expect(TELEMETRY_BEACON_URL).toBe('/api/telemetry/vitals');
    });

    it('carries the three fields the sink reads, and nothing it does not', async () => {
        beaconClientMetric({ name: NAV_PUSH_RETRY_METRIC, value: 1003, route: '/t/acme/agents' });

        const body = await bodyOf(sendBeacon.mock.calls[0][1]);
        expect(body).toEqual({
            name: NAV_PUSH_RETRY_METRIC,
            value: 1003,
            route: '/t/acme/agents',
        });
    });

    it('is inert in Playwright test mode — the gate lives in the one send path', () => {
        process.env.NEXT_PUBLIC_TEST_MODE = '1';
        beaconClientMetric({ name: NAV_PUSH_RETRY_METRIC, value: 1000, route: '/t/acme/agents' });
        expect(sendBeacon).not.toHaveBeenCalled();
    });

    it('never throws into its caller when the beacon does', () => {
        // The caller is a click handler. Telemetry that can throw there is
        // worse than telemetry that is missing.
        sendBeacon.mockImplementationOnce(() => {
            throw new Error('beacon refused');
        });
        expect(() =>
            beaconClientMetric({ name: 'LCP', value: 1, route: '/' }),
        ).not.toThrow();
    });

    it('falls back to a keepalive fetch where sendBeacon is absent', () => {
        Object.defineProperty(window.navigator, 'sendBeacon', {
            value: undefined,
            configurable: true,
            writable: true,
        });
        const fetchMock = jest.fn((_url: string, _init?: RequestInit) =>
            Promise.resolve(new Response(null, { status: 204 })),
        );
        const original = global.fetch;
        global.fetch = fetchMock as unknown as typeof fetch;
        try {
            beaconClientMetric({ name: 'LCP', value: 2, route: '/' });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/telemetry/vitals');
            // `init?.` — an absent init fails these rather than throwing, so
            // the assertion still has teeth if the fallback stops passing one.
            expect(init?.method).toBe('POST');
            expect(init?.keepalive).toBe(true);
        } finally {
            global.fetch = original;
        }
    });
});
