/**
 * Typed API client for frontend usage.
 *
 * Provides type-safe fetch wrappers that:
 * - Return typed data using generics
 * - Parse ApiErrorResponse on non-2xx and throw ApiClientError
 * - Optionally validate responses with Zod in dev/test
 *
 * Usage:
 *   import { apiGet, apiPost, ApiClientError } from '@/lib/api-client';
 *   const controls = await apiGet<CappedList<ControlListItemDTO>>('/api/t/acme/controls');
 *   const risk = await apiPost<RiskDetailDTO>('/api/t/acme/risks', body);
 *
 * The list generic is `CappedList<T>` (`{ rows, truncated }`), not `T[]` —
 * see `@/lib/list-backfill-cap`. The generic is an unchecked assertion, so
 * `T[]` compiles and then throws `.map is not a function` at runtime.
 */
import type { ZodSchema } from 'zod';

import { noteUnauthorized } from '@/lib/auth/session-expiry';

// ─── Error Class ───

export class ApiClientError extends Error {
    public readonly code: string;
    public readonly status: number;
    public readonly details?: unknown;
    public readonly requestId?: string;

    constructor(
        message: string,
        code: string,
        status: number,
        details?: unknown,
        requestId?: string,
    ) {
        super(message);
        this.name = 'ApiClientError';
        this.code = code;
        this.status = status;
        this.details = details;
        this.requestId = requestId;
    }
}

// ─── Internals ───

/**
 * Parse a non-2xx response into ApiClientError.
 * Reads the `error` envelope ONLY, and narrows every field (#3984). Falls back
 * to generic error if the body is not parseable.
 *
 * Deliberately NOT `apiErrorMessage` from `@/lib/api-error`, though that is
 * the right reader for a raw-`fetch` call site. The two contracts differ on
 * purpose and the tests below pin both: that helper is lenient, accepting a
 * bare `{ message }` and a flat `{ error: 'string' }` because all three shapes
 * occur in the wild, whereas this client speaks to our OWN API, where the
 * envelope is guaranteed -- so a top-level `message` is not an API error
 * message here, and an empty string is absent rather than a message. Routing
 * this through the lenient reader turns both of those into silent behaviour
 * changes.
 */
async function handleErrorResponse(res: Response): Promise<never> {
    let code = 'UNKNOWN';
    let message = `Request failed with status ${res.status}`;
    let details: unknown;
    let requestId: string | undefined;

    try {
        const body: unknown = await res.json();
        // NARROWED, not cast. This was four `||` reads against an `any`, and
        // the message one carried a milder form of the defect that crashed
        // three pages (#3984): an OBJECT passes `||`, so it reached
        // `new Error(...)` and coerced to `[object Object]`, discarding BOTH
        // the reason and the `Request failed with status N` fallback computed
        // just above. It never crashed a page only because `Error` stringifies
        // its argument. `res.json()` is typed `any`, so nothing upstream
        // checked any of this.
        //
        // A blank string stays ABSENT, which is what `||` gave and what the
        // test below pins: a whitespace-only message renders an empty alert,
        // indistinguishable from a broken page, so the status sentence is
        // strictly better.
        const envelope =
            typeof body === 'object' && body !== null
                ? (body as { error?: unknown }).error
                : undefined;
        if (typeof envelope === 'object' && envelope !== null) {
            const fields = envelope as Record<string, unknown>;
            const text = (value: unknown): string | undefined =>
                typeof value === 'string' && value.trim() !== '' ? value : undefined;
            code = text(fields.code) ?? code;
            message = text(fields.message) ?? message;
            requestId = text(fields.requestId);
            // `details` is unconstrained by the contract (Zod issues, for
            // instance), so it passes through as `unknown` and stays the
            // caller's to narrow.
            details = fields.details;
        }
    } catch {
        // Body is not JSON — use defaults
    }

    // #2222 — the non-SWR half of the app-wide 401 seam.
    //
    // `apiGet` is `useTenantSWR`'s fetcher, so a 401 raised here is also seen
    // by the `SWRConfig` `onError` in `providers.tsx` — but only for callers
    // that go through SWR. `apiPost`/`apiPut`/`apiPatch`/`apiDelete` do not,
    // and neither do the nine files that import this module directly. Marking
    // here covers them; `onError` covers the hooks whose fetcher is not
    // `apiGet` at all. Neither writer subsumes the other.
    //
    // 401 ONLY — `noteUnauthorized` owns the rule and the reasoning. A 403
    // reaching this line is very often a `requirePermission` denial from a
    // correctly signed-in user, and signing them out would be a regression.
    noteUnauthorized(res.status, res.url);

    throw new ApiClientError(message, code, res.status, details, requestId);
}

/**
 * Optionally validate response data with a Zod schema in dev/test.
 * Logs a warning instead of throwing to avoid breaking production.
 */
function validateIfDev<T>(data: unknown, schema?: ZodSchema<T>): T {
    if (!schema) return data as T;

    // Only validate in dev/test — indirect access avoids the no-fallbacks guard

    const proc = typeof process !== 'undefined' ? process : undefined;
    const nodeEnv = proc?.env?.NODE_ENV;
    const isDev = nodeEnv === 'development' || nodeEnv === 'test';

    if (!isDev) return data as T;

    const result = schema.safeParse(data);
    if (!result.success) {
        console.warn(
            '[api-client] Response validation failed:',
            result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
    }
    // Always return the original data (don't strip/transform)
    return data as T;
}

// ─── Public API ───

/**
 * Typed GET request.
 *
 * @param url - The full URL to fetch (e.g. from useTenantApiUrl())
 * @param schema - Optional Zod schema for dev-mode response validation
 * @param init - Optional additional RequestInit options
 */
export async function apiGet<T>(
    url: string,
    schema?: ZodSchema<T>,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(url, {
        method: 'GET',
        ...init,
    });

    if (!res.ok) await handleErrorResponse(res);

    const data = await res.json();
    return validateIfDev<T>(data, schema);
}

/**
 * Typed POST request.
 */
export async function apiPost<T>(
    url: string,
    body: unknown,
    schema?: ZodSchema<T>,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...init,
    });

    if (!res.ok) await handleErrorResponse(res);

    const data = await res.json();
    return validateIfDev<T>(data, schema);
}

/**
 * Typed PATCH request.
 */
export async function apiPatch<T>(
    url: string,
    body: unknown,
    schema?: ZodSchema<T>,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...init,
    });

    if (!res.ok) await handleErrorResponse(res);

    const data = await res.json();
    return validateIfDev<T>(data, schema);
}

/**
 * DELETE request — returns void on success.
 */
export async function apiDelete(
    url: string,
    init?: RequestInit,
): Promise<void> {
    const res = await fetch(url, {
        method: 'DELETE',
        ...init,
    });

    if (!res.ok) await handleErrorResponse(res);
}
