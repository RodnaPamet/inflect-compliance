/**
 * Coerce an API error response body to a human-readable string.
 *
 * The API error envelope is `{ error: { code, message, requestId } }` (see
 * `src/lib/errors/types.ts::toApiErrorResponse`). A common client mistake is
 * `setError(body.error ?? fallback)` — but `body.error` is an OBJECT, and
 * pushing it into React state then rendering it throws
 * "Minified React error #31 — objects are not valid as a React child", which
 * trips the page error boundary ("Something went wrong"). It only fires on a
 * 4xx/5xx response, so it hides until a real error path is exercised.
 *
 * Always route a parsed error-response body through this before `setError()`,
 * a toast, or any other render path. Handles all three shapes seen in the wild:
 * the canonical `{ error: { message } }` envelope, a flat `{ error: 'string' }`,
 * and a bare `{ message: 'string' }`.
 */
/**
 * A blank string is ABSENT, not a message (#3984). A whitespace-only sentence
 * renders an empty alert, which a reader cannot tell apart from a broken page,
 * so the caller's own fallback is strictly better. This applies at all three
 * shapes, because any of them can carry `''` — and the three are tried in
 * order, so a blank at one shape now falls through to the next rather than
 * ending the search.
 */
const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;

export function apiErrorMessage(body: unknown, fallback: string): string {
    if (body && typeof body === 'object') {
        const b = body as { error?: unknown; message?: unknown };
        const flat = text(b.error);
        if (flat !== undefined) return flat;
        if (b.error && typeof b.error === 'object') {
            const inner = text((b.error as { message?: unknown }).message);
            if (inner !== undefined) return inner;
        }
        const bare = text(b.message);
        if (bare !== undefined) return bare;
    }
    return fallback;
}

/**
 * The reasons a VALIDATION_ERROR carries, one per refused field (#4471).
 *
 * A Zod refusal's envelope message is only "Invalid request payload"
 * (`toApiErrorResponse`): what was wrong is in `error.details`, one
 * `{ path, code, message }` per issue. Empty for any other body, and for a
 * validation error whose details carry no readable message.
 */
export function validationIssueMessages(body: unknown): string[] {
    if (!body || typeof body !== 'object') return [];
    const error = (body as { error?: unknown }).error;
    if (!error || typeof error !== 'object') return [];
    const { code, details } = error as { code?: unknown; details?: unknown };
    if (code !== 'VALIDATION_ERROR' || !Array.isArray(details)) return [];
    const messages: string[] = [];
    for (const issue of details) {
        const message =
            issue && typeof issue === 'object' ? text((issue as { message?: unknown }).message) : undefined;
        if (message !== undefined && !messages.includes(message)) messages.push(message);
    }
    return messages;
}

/**
 * The sentence to show for a refused request: a validation error's own
 * reasons when it carries any, otherwise `apiErrorMessage`. Use it wherever a
 * form posts a body the server validates with Zod, so the operator reads WHY
 * rather than "Invalid request payload".
 */
export function apiRefusalMessage(body: unknown, fallback: string): string {
    const issues = validationIssueMessages(body);
    if (issues.length > 0) return issues.join('; ');
    return apiErrorMessage(body, fallback);
}
