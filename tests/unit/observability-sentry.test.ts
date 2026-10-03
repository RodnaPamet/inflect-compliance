/**
 * Unit tests for the Sentry error reporting module.
 *
 * Tests verify behavior WITHOUT requiring a live Sentry DSN:
 * - initSentry is safe to call without DSN
 * - captureError skips 4xx
 * - captureError invokes Sentry.withScope for 5xx
 * - beforeSend redaction (tested by constructing the beforeSend callback)
 *
 * RUN: npx jest tests/unit/observability-sentry.test.ts --verbose
 */

// Mock @sentry/nextjs before imports
const mockInit = jest.fn();
const mockCaptureException = jest.fn();
const mockWithScope = jest.fn((callback: (scope: unknown) => void) => {
    const scope = {
        setTag: jest.fn(),
        setContext: jest.fn(),
        setUser: jest.fn(),
    };
    callback(scope);
    return scope;
});
const mockSetTag = jest.fn();
const mockSetContext = jest.fn();
const mockSetUser = jest.fn();

const mockFlush = jest.fn(async () => true);
const mockClose = jest.fn(async () => true);
/*
    The SDK's CLIENT is now what `isSentryInitialized` and `flushSentry` read,
    so the mock has to model it. `init` sets it and `close` clears it, which is
    what the real SDK does — a mock that left it constant would make both
    functions untestable in the direction that matters.
*/
let mockClient: object | undefined;
jest.mock('@sentry/nextjs', () => ({
    init: (...a: unknown[]) => {
        mockClient = {};
        return mockInit(...(a as []));
    },
    captureException: mockCaptureException,
    withScope: mockWithScope,
    setTag: mockSetTag,
    setContext: mockSetContext,
    setUser: mockSetUser,
    getClient: () => mockClient,
    flush: (...a: unknown[]) => mockFlush(...(a as [])),
    close: (...a: unknown[]) => {
        mockClient = undefined;
        return mockClose(...(a as []));
    },
}));

import {
    initSentry,
    captureError,
    flushSentry,
    setSentryContext,
    isSentryInitialized,
    _resetForTesting,
} from '@/lib/observability/sentry';
import { runWithRequestContext } from '@/lib/observability/context';

beforeEach(() => {
    jest.clearAllMocks();
    _resetForTesting();
    delete process.env.SENTRY_DSN;
});

describe('initSentry', () => {
    it('does not call Sentry.init when SENTRY_DSN is not set, and reports NOT initialised', () => {
        /*
            This asserted `isSentryInitialized() === true` with the comment
            "marked initialized even without DSN" — true of the old module flag
            and misleading as a health signal: it answered "has init run here",
            and every caller is asking "is this process reporting errors".

            With no DSN the answer to the second question is no, so this now
            reports false. The diagnostics endpoint pairs it with
            `sentryConfigured`, which is the one that distinguishes "no DSN set"
            from "DSN set but the client failed to come up".
        */
        initSentry();
        expect(mockInit).not.toHaveBeenCalled();
        expect(isSentryInitialized()).toBe(false);
    });

    it('and reports initialised once a client exists', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        expect(isSentryInitialized()).toBe(true);
    });

    it('reads the SDK client, NOT this module\'s own flag (#3127 follow-up)', () => {
        /*
            THE assertion, and the production symptom it comes from.

            `_initialized` is module-level, and Next.js bundles
            `instrumentation.ts` separately from route handlers — so a route
            importing this module gets a different instance with the flag still
            false. `/api/admin/diagnostics` reported `sentryInitialized: false`
            and `flushed: false` in production while the container logs showed
            instrumentation had run and `Sentry.init()` had succeeded.

            Simulated here by clearing the client WITHOUT going through
            `shutdownSentry`: the module flag stays true, the client is gone,
            and the honest answer is false. The old implementation returned true.
        */
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        expect(isSentryInitialized()).toBe(true);
        mockClient = undefined;
        expect(isSentryInitialized()).toBe(false);
    });

    it('calls Sentry.init when SENTRY_DSN is set', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        expect(mockInit).toHaveBeenCalledTimes(1);
        expect(mockInit.mock.calls[0][0].dsn).toBe('https://abc@sentry.io/123');
    });

    it('only initializes once', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        initSentry();
        expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it('sets environment from SENTRY_ENVIRONMENT', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        process.env.SENTRY_ENVIRONMENT = 'staging';
        initSentry();
        expect(mockInit.mock.calls[0][0].environment).toBe('staging');
        delete process.env.SENTRY_ENVIRONMENT;
    });

    it('sets tracesSampleRate from SENTRY_TRACES_SAMPLE_RATE', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        process.env.SENTRY_TRACES_SAMPLE_RATE = '0.5';
        initSentry();
        expect(mockInit.mock.calls[0][0].tracesSampleRate).toBe(0.5);
        delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    });
});

describe('captureError', () => {
    it('skips 4xx errors (status < 500)', () => {
        captureError(new Error('Not found'), { status: 404 });
        expect(mockWithScope).not.toHaveBeenCalled();
        expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('skips 400 validation errors', () => {
        captureError(new Error('Invalid input'), { status: 400 });
        expect(mockWithScope).not.toHaveBeenCalled();
    });

    it('skips 401 auth errors', () => {
        captureError(new Error('Unauthorized'), { status: 401 });
        expect(mockWithScope).not.toHaveBeenCalled();
    });

    it('captures 500 errors', () => {
        captureError(new Error('DB crash'), { status: 500, requestId: 'req-1' });
        expect(mockWithScope).toHaveBeenCalledTimes(1);
        expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('captures errors without status (defaults to capturing)', () => {
        captureError(new Error('Unknown error'));
        expect(mockWithScope).toHaveBeenCalledTimes(1);
        expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('sets tags with requestId, route, method', () => {
        captureError(new Error('fail'), {
            status: 500,
            requestId: 'req-42',
            route: '/api/controls',
            method: 'POST',
            errorCode: 'INTERNAL',
        });

        const scope = mockWithScope.mock.results[0].value;
        expect(scope.setTag).toHaveBeenCalledWith('requestId', 'req-42');
        expect(scope.setTag).toHaveBeenCalledWith('route', '/api/controls');
        expect(scope.setTag).toHaveBeenCalledWith('method', 'POST');
        expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'INTERNAL');
    });

    it('sets user context with userId and tenantId', () => {
        captureError(new Error('fail'), {
            status: 500,
            userId: 'user-1',
            tenantId: 'tenant-1',
        });

        const scope = mockWithScope.mock.results[0].value;
        expect(scope.setUser).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'user-1' }),
        );
    });

    it('auto-enriches from ALS context when extra not provided', () => {
        runWithRequestContext(
            { requestId: 'als-req', startTime: 0, tenantId: 't-2', userId: 'u-2' },
            () => {
                captureError(new Error('fail'));
            },
        );

        const scope = mockWithScope.mock.results[0].value;
        expect(scope.setTag).toHaveBeenCalledWith('requestId', 'als-req');
    });

    it('wraps non-Error values in Error before capturing', () => {
        captureError('string error', { status: 500 });
        expect(mockCaptureException).toHaveBeenCalledWith(
            expect.any(Error),
        );
    });
});

describe('setSentryContext', () => {
    it('sets tag and user context', () => {
        setSentryContext({
            requestId: 'req-99',
            route: '/api/test',
            tenantId: 'tenant-x',
            userId: 'user-y',
        });

        expect(mockSetTag).toHaveBeenCalledWith('requestId', 'req-99');
        expect(mockSetTag).toHaveBeenCalledWith('route', '/api/test');
        expect(mockSetContext).toHaveBeenCalledWith('tenant', { tenantId: 'tenant-x' });
        expect(mockSetUser).toHaveBeenCalledWith({ id: 'user-y' });
    });
});

describe('beforeSend redaction', () => {
    it('initSentry configures a beforeSend that redacts sensitive data', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();

        const config = mockInit.mock.calls[0][0];
        expect(config.beforeSend).toBeDefined();

        // Simulate an event with sensitive data
        const event = {
            request: {
                headers: {
                    authorization: 'Bearer secret-token',
                    cookie: 'session=abc123',
                    'content-type': 'application/json',
                },
                data: '{"password":"hunter2"}',
                url: 'https://app.example.com/api/callback?code=abc&state=xyz&safe=yes',
                query_string: 'code=abc&state=xyz',
            },
            breadcrumbs: [
                { data: { url: 'https://sso.example.com/auth?token=secret123' } },
            ],
        };

        const result = config.beforeSend(event, {});

        // Headers redacted
        expect(result.request.headers.authorization).toBeUndefined();
        expect(result.request.headers.cookie).toBeUndefined();
        expect(result.request.headers['content-type']).toBe('application/json');

        // Body redacted
        expect(result.request.data).toBe('[Filtered]');

        // Query string redacted
        expect(result.request.query_string).toBe('[Filtered]');

        // Breadcrumb URL params redacted (URL class encodes brackets as %5B/%5D)
        expect(result.breadcrumbs[0].data.url).not.toContain('secret123');
        expect(result.breadcrumbs[0].data.url).toMatch(/Redacted/);
    });

    it('beforeSend drops NEXT_REDIRECT errors', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        _resetForTesting();
        initSentry();

        const config = mockInit.mock.calls[0][0];
        const result = config.beforeSend({}, {
            originalException: new Error('NEXT_REDIRECT'),
        });
        expect(result).toBeNull();
    });

    it('beforeSend drops NEXT_NOT_FOUND errors', () => {
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        _resetForTesting();
        initSentry();

        const config = mockInit.mock.calls[0][0];
        const result = config.beforeSend({}, {
            originalException: new Error('NEXT_NOT_FOUND'),
        });
        expect(result).toBeNull();
    });
});

/**
 * `flushSentry` — drain the buffer, and KEEP REPORTING.
 *
 * Sentry buffers, so a caller that needs to know an event left the process has
 * to flush. The obvious way to get that is `shutdownSentry`, which already
 * awaits a drain — and which also calls `Sentry.close()` and clears the
 * initialised flag. Using it to flush would leave the server running with error
 * reporting permanently dead and nothing anywhere saying so, which is a far
 * worse outcome than the unflushed event it was reached for.
 */
describe('flushSentry', () => {
    beforeEach(() => {
        mockFlush.mockClear();
        mockClose.mockClear();
        mockFlush.mockResolvedValue(true);
    });

    it('drains the buffer with the timeout it was given', async () => {
        initSentry();
        await expect(flushSentry(1_234)).resolves.toBe(true);
        expect(mockFlush).toHaveBeenCalledWith(1_234);
    });

    it('does NOT close the client — reporting survives a flush', async () => {
        // THE assertion. A flush implemented via `shutdownSentry` would pass a
        // "did it drain" test and silently disable the process.
        initSentry();
        await flushSentry();
        expect(mockClose).not.toHaveBeenCalled();
        expect(isSentryInitialized()).toBe(true);
    });

    it('returns false when the drain times out, rather than claiming success', async () => {
        // "Could not confirm" must not read as "delivered".
        initSentry();
        mockFlush.mockResolvedValue(false);
        await expect(flushSentry()).resolves.toBe(false);
    });

    it('and false when there is NO CLIENT, without calling flush', async () => {
        // Was "never initialised", meaning the module flag. The client is the
        // thing that can actually accept a flush, and it is what crosses the
        // bundle boundary — see the init test above.
        _resetForTesting();
        mockClient = undefined;
        await expect(flushSentry()).resolves.toBe(false);
        expect(mockFlush).not.toHaveBeenCalled();
    });

    it('but DOES flush when a client exists and the module flag does not', async () => {
        /*
            The production case, inverted: a route's bundle has
            `_initialized === false` while the process has a live client. The
            old guard refused to flush and reported `flushed: false` — a
            verification tool failing for the one reason it existed to rule out.
        */
        process.env.SENTRY_DSN = 'https://abc@sentry.io/123';
        initSentry();
        _resetForTesting(); // clears the module flag, leaves the client
        await expect(flushSentry(1_000)).resolves.toBe(true);
        expect(mockFlush).toHaveBeenCalledWith(1_000);
    });
});

describe('captureError returns the event id', () => {
    it('so a caller can correlate the event it just sent', () => {
        initSentry();
        mockCaptureException.mockReturnValue('evt-7f3a');
        expect(captureError(new Error('boom'), { status: 500 })).toBe('evt-7f3a');
    });

    it('and returns undefined for a 4xx, which it still does not capture', () => {
        // The skip predates this change and must survive it: widening the
        // return type must not accidentally start reporting client errors.
        initSentry();
        mockCaptureException.mockClear();
        expect(captureError(new Error('bad request'), { status: 400 })).toBeUndefined();
        expect(mockCaptureException).not.toHaveBeenCalled();
    });
});
