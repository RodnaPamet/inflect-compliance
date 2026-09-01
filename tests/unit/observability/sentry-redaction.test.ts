/**
 * The Sentry branches that decide what LEAVES the process.
 *
 * `tests/unit/observability-sentry.test.ts` covers the init guard, the 4xx
 * skip, and two `beforeSend` drops. What it does not reach is most of the
 * redaction surface — and every unreached branch there is a branch that
 * forwards customer data to a third party when it regresses:
 *
 *   - `redactUrl` on an ABSOLUTE url (a different return path from the
 *     relative one), and its `catch` arm for a url that will not parse;
 *   - breadcrumb url redaction, the `query_string` scrub, and the body
 *     `[Filtered]` replacement;
 *   - the `error.name` half of the ignore matcher (only `error.message` is
 *     covered today) and the non-Error `originalException`;
 *   - `shutdownSentry` past the never-initialised early return — nothing
 *     asserts that `Sentry.close` is even called, or that a wedged transport
 *     cannot hold the SIGTERM path open.
 */

type SentryEvent = {
    request?: {
        headers?: Record<string, string>;
        data?: unknown;
        url?: string;
        query_string?: string;
    };
    breadcrumbs?: Array<{ data?: Record<string, unknown> }>;
};
type BeforeSend = (
    event: SentryEvent,
    hint?: { originalException?: unknown },
) => SentryEvent | null;

const initCalls: Array<{ beforeSend: BeforeSend; environment: string; tracesSampleRate: number }> = [];
const closeCalls: number[] = [];
/** Behaviour of the next `Sentry.close` call. */
const closeBehaviour: { mode: 'resolve' | 'hang' } = { mode: 'resolve' };

jest.mock('@sentry/nextjs', () => ({
    init: (cfg: { beforeSend: BeforeSend; environment: string; tracesSampleRate: number }) => {
        initCalls.push(cfg);
    },
    close: (timeoutMs: number): Promise<boolean> => {
        closeCalls.push(timeoutMs);
        if (closeBehaviour.mode === 'hang') return new Promise<boolean>(() => { /* never settles */ });
        return Promise.resolve(true);
    },
    captureException: jest.fn(),
    withScope: (cb: (scope: unknown) => void) => {
        cb({ setTag: jest.fn(), setContext: jest.fn(), setUser: jest.fn() });
    },
    setTag: jest.fn(),
    setContext: jest.fn(),
    setUser: jest.fn(),
}));

import {
    initSentry,
    shutdownSentry,
    isSentryInitialized,
    _resetForTesting,
} from '@/lib/observability/sentry';

// This repo augments NodeJS.ProcessEnv, so SENTRY_DSN is not simply optional
// on the declared type. The cast is confined to this helper and every key it
// touches is saved and restored per test.
type MutableEnv = Record<string, string | undefined>;
const mutableEnv = process.env as unknown as MutableEnv;
const TOUCHED = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_TRACES_SAMPLE_RATE'] as const;
const saved: MutableEnv = {};

beforeEach(() => {
    for (const k of TOUCHED) saved[k] = mutableEnv[k];
    initCalls.length = 0;
    closeCalls.length = 0;
    closeBehaviour.mode = 'resolve';
    _resetForTesting();
    // Set every value explicitly rather than leaning on an ambient default —
    // an assertion against an unset var passes locally and fails wherever the
    // var happens to be set.
    mutableEnv.SENTRY_DSN = 'https://public@sentry.invalid/1';
    mutableEnv.SENTRY_ENVIRONMENT = 'lane-env';
    mutableEnv.SENTRY_TRACES_SAMPLE_RATE = '0';
});

afterEach(() => {
    _resetForTesting();
    for (const k of TOUCHED) {
        const v = saved[k];
        if (v === undefined) delete mutableEnv[k];
        else mutableEnv[k] = v;
    }
});

/** Init once and hand back the `beforeSend` the SDK was configured with. */
function beforeSend(): BeforeSend {
    initSentry();
    if (initCalls.length !== 1) {
        throw new Error(`expected exactly one Sentry.init, saw ${initCalls.length}`);
    }
    return initCalls[0].beforeSend;
}

// ══════════════════════════════════════════════════════════════════════
// URL redaction
// ══════════════════════════════════════════════════════════════════════

describe('beforeSend — request url redaction', () => {
    it('redacts every sensitive param on an ABSOLUTE url and keeps the origin', () => {
        // The absolute branch returns `parsed.toString()`; the relative branch
        // returns pathname+search. Getting them the wrong way round turns a
        // relative url into `http://placeholder/...`, which reads as a real
        // host in the Sentry UI.
        const out = beforeSend()({
            request: { url: 'https://app.example.com/api/auth/sso?SAMLResponse=BIG&keep=2' },
        });

        expect(out?.request?.url).toBe(
            'https://app.example.com/api/auth/sso?SAMLResponse=%5BRedacted%5D&keep=2',
        );
    });

    it('redacts a RELATIVE url without inventing an origin', () => {
        const out = beforeSend()({
            request: { url: '/api/auth/callback/google?code=abc123&state=xyz&safe=1' },
        });

        expect(out?.request?.url).toBe(
            '/api/auth/callback/google?code=%5BRedacted%5D&state=%5BRedacted%5D&safe=1',
        );
    });

    it('leaves a url that carries no sensitive param byte-identical', () => {
        const out = beforeSend()({ request: { url: '/t/acme/risks?page=2' } });
        expect(out?.request?.url).toBe('/t/acme/risks?page=2');
    });

    it('returns an UNPARSEABLE url unchanged rather than throwing out of beforeSend', () => {
        // A throw here would escape into the Sentry SDK on the error path —
        // i.e. an error while reporting an error, which is where reports go
        // silently missing.
        const out = beforeSend()({ request: { url: 'https://[' } });
        expect(out?.request?.url).toBe('https://[');
    });
});

describe('beforeSend — breadcrumb url redaction', () => {
    it('redacts sensitive params inside breadcrumb urls too', () => {
        // Breadcrumbs are the second copy of the request trail. Redacting only
        // `event.request.url` leaves the OAuth code sitting in the breadcrumb
        // list of the same event.
        const out = beforeSend()({
            breadcrumbs: [
                { data: { url: '/api/auth/callback?code=leaky&ok=1' } },
                { data: { url: 'https://idp.example.com/authorize?client_secret=shh' } },
            ],
        });

        expect(out?.breadcrumbs?.[0].data?.url).toBe('/api/auth/callback?code=%5BRedacted%5D&ok=1');
        expect(out?.breadcrumbs?.[1].data?.url).toBe(
            'https://idp.example.com/authorize?client_secret=%5BRedacted%5D',
        );
    });

    it('skips a breadcrumb that carries no data object at all', () => {
        // Navigation breadcrumbs arrive with no `data`. Without the optional
        // chain in `crumb.data?.url` this throws a TypeError from inside
        // `beforeSend`, and Sentry drops the whole event — the crash report is
        // lost precisely when something is already going wrong.
        //
        // The `typeof crumb.data.url === 'string'` half of that guard is NOT
        // asserted here and this suite makes no claim about it: `redactUrl`
        // has its own try/catch, and a non-string reaches `url.startsWith`,
        // throws inside it and is returned unchanged — so deleting the typeof
        // check is invisible to any assertion on the output.
        const out = beforeSend()({ breadcrumbs: [{}, { data: {} }] });

        expect(out?.breadcrumbs).toStrictEqual([{}, { data: {} }]);
    });
});

// ══════════════════════════════════════════════════════════════════════
// Request payload scrubbing
// ══════════════════════════════════════════════════════════════════════

describe('beforeSend — request payload scrubbing', () => {
    it('drops the three credential headers and keeps the rest', () => {
        const out = beforeSend()({
            request: {
                headers: {
                    authorization: 'Bearer super-secret',
                    cookie: 'session=abc',
                    'x-api-key': 'ak_live_1',
                    'user-agent': 'jest',
                },
            },
        });

        expect(out?.request?.headers).toStrictEqual({ 'user-agent': 'jest' });
    });

    it('replaces the request body wholesale — never a partial scrub', () => {
        const out = beforeSend()({
            request: { data: { password: 'hunter2', newPassword: 'hunter3' } },
        });
        expect(out?.request?.data).toBe('[Filtered]');
    });

    it('replaces query_string wholesale rather than parsing it', () => {
        const out = beforeSend()({
            request: { query_string: 'code=abc&state=xyz' },
        });
        expect(out?.request?.query_string).toBe('[Filtered]');
    });

    it('leaves an event with no request block alone', () => {
        const out = beforeSend()({ breadcrumbs: [] });
        expect(out).toStrictEqual({ breadcrumbs: [] });
    });
});

// ══════════════════════════════════════════════════════════════════════
// The ignore matcher
// ══════════════════════════════════════════════════════════════════════

describe('beforeSend — the ignore matcher', () => {
    it('drops an error whose NAME carries the marker even when the message does not', () => {
        // Next.js throws navigation signals whose marker lives on `.name`.
        // Only the `.message` half is covered today, so a matcher narrowed to
        // messages would silently start reporting every redirect as an error.
        const err = new Error('an ordinary looking message');
        err.name = 'NEXT_REDIRECT';

        expect(beforeSend()({}, { originalException: err })).toBeNull();
    });

    it('drops DYNAMIC_SERVER_USAGE, the third pattern', () => {
        expect(
            beforeSend()({}, { originalException: new Error('DYNAMIC_SERVER_USAGE: no store') }),
        ).toBeNull();
    });

    it('KEEPS an unrelated error — the matcher is not a blanket drop', () => {
        const event: SentryEvent = { request: { url: '/t/acme/risks' } };
        expect(beforeSend()(event, { originalException: new Error('boom') })).toBe(event);
    });

    it('keeps an event whose originalException is not an Error at all', () => {
        // A thrown string reaches `hint.originalException` as a string. The
        // `instanceof` guard is what stops `.message` blowing up in here.
        const event: SentryEvent = {};
        expect(beforeSend()(event, { originalException: 'NEXT_REDIRECT' })).toBe(event);
    });

    it('keeps an event with no hint at all', () => {
        const event: SentryEvent = {};
        expect(beforeSend()(event)).toBe(event);
    });
});

// ══════════════════════════════════════════════════════════════════════
// init configuration
// ══════════════════════════════════════════════════════════════════════

describe('initSentry — configuration derived from env', () => {
    it('prefers SENTRY_ENVIRONMENT and parses the sample rate as a float', () => {
        mutableEnv.SENTRY_ENVIRONMENT = 'production-eu';
        mutableEnv.SENTRY_TRACES_SAMPLE_RATE = '0.25';
        initSentry();

        expect(initCalls[0].environment).toBe('production-eu');
        expect(initCalls[0].tracesSampleRate).toBe(0.25);
    });

    it('defaults the sample rate to 0 when the var is unset — OTel owns tracing', () => {
        delete mutableEnv.SENTRY_TRACES_SAMPLE_RATE;
        initSentry();
        expect(initCalls[0].tracesSampleRate).toBe(0);
    });
});

// ══════════════════════════════════════════════════════════════════════
// shutdownSentry
// ══════════════════════════════════════════════════════════════════════

describe('shutdownSentry — draining an initialised client', () => {
    it('closes the transport with the caller budget and clears the flag', async () => {
        initSentry();
        expect(isSentryInitialized()).toBe(true);

        await shutdownSentry(1_500);

        expect(closeCalls).toStrictEqual([1_500]);
        expect(isSentryInitialized()).toBe(false);
    });

    it('does not re-close on a second call', async () => {
        initSentry();
        await shutdownSentry(1_500);
        await shutdownSentry(1_500);

        expect(closeCalls).toStrictEqual([1_500]);
    });

    it('still drains after a DSN-LESS init, because that init sets the flag', async () => {
        // The DSN-less init marks the module initialised without configuring a
        // transport, so shutdown takes the drain path against an SDK that
        // no-ops. Worth pinning both halves: `close` IS reached (the early
        // return is keyed on `_initialized`, not on the DSN), and the flag is
        // cleared so a second SIGTERM is a no-op.
        delete mutableEnv.SENTRY_DSN;
        initSentry();
        expect(initCalls).toHaveLength(0);

        await shutdownSentry(1_500);

        expect(closeCalls).toStrictEqual([1_500]);
        expect(isSentryInitialized()).toBe(false);
    });

    it('resolves at the budget when the transport never drains', async () => {
        // The reason close is Promise.race'd: a wedged transport must not hold
        // the process past the container grace period.
        closeBehaviour.mode = 'hang';
        initSentry();

        // The detector is that this `await` resolves at all: `Sentry.close`
        // never settles, so without the Promise.race the test hangs to the jest
        // timeout. A wall-clock `toBeLessThan` assertion here would add nothing
        // — it cannot run in the failing case.
        await shutdownSentry(20);

        expect(closeCalls).toStrictEqual([20]);
    });
});
