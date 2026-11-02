import { ApiClientError } from '@/lib/api-client';

/**
 * Mutation error helper.
 *
 * Once the React Query → SWR migration completed, the only surviving
 * export here is `extractMutationError` — a framework-agnostic funnel that
 * normalises an arbitrary thrown value (Error / string / `{ error }` /
 * `{ message }`) into a displayable string. Mutation call sites (plain
 * async handlers + `useTenantMutation`) reuse it so error copy stays
 * consistent. The former `optimisticListUpdate` (which took a React Query
 * `QueryClient`) was removed with the migration — optimistic list updates
 * now go through `useTenantMutation`'s `optimisticUpdate` option.
 */
export function extractMutationError(err: unknown, fallback = 'An error occurred'): string {
    // #4987 — the server's own sentence, or the caller's. An `ApiClientError`
    // with no envelope message carries `Request failed with status N` as its
    // `message`: a status code, in English, which is not for a page.
    if (err instanceof ApiClientError) return err.reason ?? fallback;
    // A failed `fetch` rejects with a `TypeError` whose text is the browser's
    // ("Failed to fetch", "NetworkError when attempting to fetch resource."),
    // and so is a coding slip's ("Cannot read properties of undefined") —
    // neither is a sentence for the person using the page.
    if (err instanceof TypeError) return fallback;
    if (err instanceof Error) return err.message || fallback;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>;
        const e = obj.error ?? obj.message ?? fallback;
        if (typeof e === 'string') return e;
        // The API's envelope is `{ error: { code, message } }` (#4691): its
        // message is the reason. A shape with no message falls back — it was
        // once JSON-stringified, which put `{"code":…}` on screen.
        const message = e && typeof e === 'object' ? (e as Record<string, unknown>).message : undefined;
        return typeof message === 'string' && message ? message : fallback;
    }
    return fallback;
}
