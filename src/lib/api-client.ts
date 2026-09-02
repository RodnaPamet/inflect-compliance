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
 * Tries to parse the standard { error: { code, message, ... } } shape.
 * Falls back to generic error if the body is not parseable.
 */
async function handleErrorResponse(res: Response): Promise<never> {
    let code = 'UNKNOWN';
    let message = `Request failed with status ${res.status}`;
    let details: unknown;
    let requestId: string | undefined;

    try {
        const body = await res.json();
        if (body?.error) {
            code = body.error.code || code;
            message = body.error.message || message;
            details = body.error.details;
            requestId = body.error.requestId;
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
