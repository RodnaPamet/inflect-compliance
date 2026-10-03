/**
 * Sentry Error Reporting — server-side integration.
 *
 * Provides a thin wrapper around @sentry/nextjs for error capture with
 * requestId correlation and safe metadata. Noop when SENTRY_DSN is not set.
 *
 * SAFETY:
 *   - beforeSend strips authorization headers, cookies, and request bodies
 *   - Expected 4xx errors are not reported
 *   - Never sends secrets, tokens, or raw payloads
 *
 * ENV VARS:
 *   SENTRY_DSN                  — Sentry project DSN (noop if missing)
 *   SENTRY_ENVIRONMENT          — environment tag (default: NODE_ENV)
 *   SENTRY_TRACES_SAMPLE_RATE   — performance sample rate (default: 0 — use OTel)
 */

import * as Sentry from '@sentry/nextjs';
import { getRequestContext } from './context';

// ── State ──

let _initialized = false;

// ── Sensitive URL query params to redact ──

const SENSITIVE_PARAMS = new Set([
    'code', 'state', 'token', 'access_token', 'refresh_token',
    'id_token', 'client_secret', 'secret', 'SAMLResponse', 'RelayState',
]);

// ── Errors to ignore (expected / handled) ──

const IGNORED_ERROR_PATTERNS = [
    'NEXT_REDIRECT',
    'NEXT_NOT_FOUND',
    'DYNAMIC_SERVER_USAGE',
];

/**
 * Redact sensitive query parameters from a URL string.
 */
function redactUrl(url: string): string {
    try {
        const parsed = new URL(url, 'http://placeholder');
        for (const param of SENSITIVE_PARAMS) {
            if (parsed.searchParams.has(param)) {
                parsed.searchParams.set(param, '[Redacted]');
            }
        }
        // Return without the placeholder origin if original was relative
        return url.startsWith('http') ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
    } catch {
        return url;
    }
}

/**
 * Initialize Sentry SDK. Safe to call multiple times — only initializes once.
 * Noop when SENTRY_DSN is not set.
 */
export function initSentry(): void {
    if (_initialized) return;

    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        _initialized = true;
        return;
    }

    Sentry.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
        tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),

        /**
         * PINNED, not inherited — a privacy posture must not be a default we
         * happen to receive.
         *
         * With this unset the SDK decides, and the SDK's decision moves: the
         * v11 release states its goals include making "more permissive data
         * collection the default". A major bump is exactly when an inherited
         * default changes underneath you, silently and with green CI, and for
         * this product the thing that would start flowing is a customer's users'
         * IP addresses.
         *
         * `false` is also what the code already assumes. `beforeSend` scrubs
         * `event.request` headers, body, URL and query string, and deletes
         * `event.user.ip_address` — so the identity axis has one arm, not none.
         * This comment previously said it had "no arm for `event.user` at all",
         * which was true when written and false by the time the `ip_address`
         * delete landed below. It mattered: assessing the v11 bump (#2980) I
         * read the comment rather than the code and understated the coverage.
         *
         * What `beforeSend` still does NOT cover is `event.user.id` / `email` /
         * `username`, and it has no arm at all for most of what `dataCollection`
         * governs. Those are why the posture has to stay PINNED in `init`, not
         * delegated to the scrubber.
         *
         * ── Why this is `dataCollection` and not `sendDefaultPii` ────────
         *
         * `sendDefaultPii` is REMOVED in v11 — the v10 type that declares it
         * says so itself: "will be removed in the next major version (v11)".
         * It still typechecks, which is the trap: #2980 bumped the major and
         * `Typecheck`, `Lint`, `Build` and all four test shards went green with
         * no privacy code in the diff.
         *
         * Every field below is set because its DEFAULT collects. Read from
         * `@sentry/core`'s own `DataCollection` type rather than from the
         * migration notes, and the defaults are not what I assumed when writing
         * the guard for this:
         *
         *   userInfo             false  <- already safe; set anyway, see below
         *   cookies              true
         *   httpHeaders          { request: true, response: true }
         *   httpBodies           all four targets
         *   urlQueryParams       true
         *   graphQL              { document: true, variables: true }
         *   genAI                { inputs: true, outputs: true }
         *   databaseQueryData    true
         *   stackFrameVariables  true
         *
         * `stackFrameVariables` is the one worth pausing on. It captures local
         * variable VALUES in stack frames, and this codebase decrypts tenant
         * data in-process: a throw inside the encryption middleware or a Prisma
         * extension would put plaintext field values, and potentially a wrapped
         * DEK, into a frame local. `beforeSend` has no arm for it.
         *
         * `urlQueryParams` likewise. `redactUrl` already exists, but it works
         * off `SENSITIVE_PARAMS` — ten names, so every parameter nobody thought
         * of passes through. Turning the category off closes the class instead
         * of enumerating it.
         *
         * `userInfo` already defaults to false, so that line changes nothing
         * today. It is written anyway because the default is the SDK's to
         * change, and an explicit false is what makes the posture a decision
         * rather than an inheritance — which is the whole point of pinning.
         */
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: { request: false, response: false },
            // `[]` disables body collection; an omitted value collects all four.
            httpBodies: [],
            urlQueryParams: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            stackFrameVariables: false,
        },

        // Don't send expected / handled errors
        beforeSend(event, hint) {
            const error = hint?.originalException;

            // Skip Next.js internal navigation errors
            if (error instanceof Error) {
                for (const pattern of IGNORED_ERROR_PATTERNS) {
                    if (error.message.includes(pattern) || error.name.includes(pattern)) {
                        return null;
                    }
                }
            }

            // Redact sensitive request data
            if (event.request) {
                if (event.request.headers) {
                    const headers = { ...event.request.headers };
                    delete headers['authorization'];
                    delete headers['cookie'];
                    delete headers['x-api-key'];
                    event.request.headers = headers;
                }
                // Never send full request body
                if (event.request.data) {
                    event.request.data = '[Filtered]';
                }
                // Redact sensitive URL params
                if (event.request.url) {
                    event.request.url = redactUrl(event.request.url);
                }
                if (event.request.query_string) {
                    event.request.query_string = '[Filtered]';
                }
            }

            // The identity axis, which the rest of this function never touches.
            // Belt-and-braces behind `dataCollection.userInfo: false` above:
            // that option is the control, and this is what still holds if some
            // future caller turns it on without reading the rest of the file.
            // An `ip_address` is personal data under GDPR Art 4(1) and this is a
            // compliance product — it must not reach a third-party error sink by
            // default.
            //
            // This comment named `sendDefaultPii: false` until the v11 bump
            // removed it. The rename is not cosmetic: a comment citing a control
            // that no longer exists is how this file misled a reader once
            // already -- see the `beforeSend` docblock above, which described
            // coverage it did not have and cost me a wrong risk assessment.
            if (event.user) {
                delete event.user.ip_address;
            }

            // Redact breadcrumb URLs
            if (event.breadcrumbs) {
                for (const crumb of event.breadcrumbs) {
                    if (crumb.data?.url && typeof crumb.data.url === 'string') {
                        crumb.data.url = redactUrl(crumb.data.url);
                    }
                }
            }

            return event;
        },

        // Ignore common noisy errors
        ignoreErrors: [
            'ResizeObserver loop',
            'ResizeObserver loop completed with undelivered notifications',
            'Non-Error exception captured',
            /^Loading chunk \d+ failed/,
            /^Loading CSS chunk \d+ failed/,
        ],
    });

    _initialized = true;
}

/** Check if Sentry has been initialized with a valid DSN. */
export function isSentryInitialized(): boolean {
    return _initialized;
}

/**
 * Flush pending Sentry events and close the client. Bounded by
 * `timeoutMs` — Sentry.close() takes its own timeout and never
 * throws, but we guard with Promise.race so a misbehaving transport
 * can't block shutdown past the graceful-shutdown budget.
 *
 * Noop when Sentry was never initialised (SENTRY_DSN unset).
 *
 * Safe to call multiple times.
 */
export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
    if (!_initialized) return;
    _initialized = false;

    await Promise.race([
        Sentry.close(timeoutMs).then(() => { /* discard boolean */ }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 100)),
    ]);
}

/**
 * Flush buffered events WITHOUT shutting the client down.
 *
 * ═══ WHY THIS IS NOT `shutdownSentry` ═══
 *
 * `shutdownSentry` calls `Sentry.close()` and sets `_initialized = false`, so
 * calling it to flush would permanently disable error reporting in that
 * process — the server would keep running and report nothing, with no error
 * anywhere to say so. That is a far worse outcome than the unflushed event this
 * exists to prevent, which is why the two are separate functions rather than
 * one with a flag.
 *
 * Needed because Sentry BUFFERS. An event captured and never flushed leaves a
 * probe reporting an event id for something that never left the process — a
 * verification that reports success in exactly the case it was built to detect.
 *
 * Returns false on timeout, which the caller should surface rather than treat
 * as success: "could not confirm" and "delivered" must not look alike.
 */
export async function flushSentry(timeoutMs = 2_000): Promise<boolean> {
    if (!_initialized) return false;
    return Sentry.flush(timeoutMs);
}

/**
 * Capture an error in Sentry with request context correlation.
 *
 * Only captures errors with status >= 500 (server errors).
 * Skips 4xx (client/validation errors) to reduce noise.
 *
 * @param error — the error to capture
 * @param extra — optional metadata (requestId, route, method, status, etc.)
 */
export function captureError(
    error: unknown,
    extra?: {
        requestId?: string;
        route?: string;
        method?: string;
        status?: number;
        tenantId?: string;
        userId?: string;
        errorCode?: string;
    },
): string | undefined {
    // Skip 4xx — these are expected/handled
    if (extra?.status && extra.status < 500) return undefined;

    // Auto-enrich from ALS context if extra not provided
    const ctx = getRequestContext();

    /*
        The event id, returned so a caller can CORRELATE — the delivery probe
        reports it so an operator can find that exact event in Sentry instead of
        guessing which of several recent errors was theirs.

        Assigned inside the scope callback rather than returned from it:
        `withScope` returns the callback's value in current Sentry versions, but
        relying on that couples this to a detail of a library we pin with a
        caret. The two existing callers ignore the return entirely, so widening
        `void` to `string | undefined` cannot affect them.
    */
    let eventId: string | undefined;

    Sentry.withScope((scope) => {
        // Tags for filtering in Sentry dashboard
        scope.setTag('requestId', extra?.requestId || ctx?.requestId || 'unknown');
        if (extra?.route || ctx?.route) scope.setTag('route', extra?.route || ctx?.route || '');
        if (extra?.method) scope.setTag('method', extra.method);
        if (extra?.status) scope.setTag('statusCode', String(extra.status));
        if (extra?.errorCode) scope.setTag('errorCode', extra.errorCode);

        // Safe context (never include secrets)
        scope.setContext('request', {
            requestId: extra?.requestId || ctx?.requestId,
            route: extra?.route || ctx?.route,
            method: extra?.method,
            statusCode: extra?.status,
        });

        // User context (Sentry's built-in user tracking — safe fields only)
        const tenantId = extra?.tenantId || ctx?.tenantId;
        const userId = extra?.userId || ctx?.userId;
        if (userId || tenantId) {
            scope.setUser({
                id: userId,
                ...(tenantId && { tenantId } as Record<string, string>),
            });
        }

        eventId =
            error instanceof Error
                ? Sentry.captureException(error)
                : Sentry.captureException(new Error(String(error)));
    });
    return eventId;
}

/**
 * Set Sentry scope context from the current request.
 * Useful for enriching errors captured later in the same request lifecycle.
 */
export function setSentryContext(ctx: {
    requestId: string;
    tenantId?: string;
    userId?: string;
    route?: string;
}): void {
    Sentry.setTag('requestId', ctx.requestId);
    if (ctx.route) Sentry.setTag('route', ctx.route);
    if (ctx.tenantId) Sentry.setContext('tenant', { tenantId: ctx.tenantId });
    if (ctx.userId) Sentry.setUser({ id: ctx.userId });
}

/**
 * Reset init flag (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
    _initialized = false;
}
