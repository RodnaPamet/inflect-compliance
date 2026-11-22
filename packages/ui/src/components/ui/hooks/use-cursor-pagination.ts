"use client";

/**
 * Epic E — cursor-based "Load more" accumulator.
 *
 * Bridges a server-rendered first page (initialRows + initialNextCursor)
 * to a paginated API endpoint that returns `{ rows, nextCursor }`.
 * Each call to `loadMore()`:
 *
 *   1. Fetches `fetchUrl(currentCursor)` with `same-origin` credentials.
 *   2. Appends the response's `rows` to the accumulated list.
 *   3. Replaces `nextCursor` with the response's `nextCursor`.
 *
 * The accumulator runs in the browser; the URL is NOT updated as the
 * user pages forward. Browser back/forward returns to the entry-point
 * URL and the accumulator restarts from page 1 — equivalent to other
 * "Load more" patterns on the web. If a user deep-links with a non-
 * empty `?cursor=` query, the server-rendered first page IS that
 * cursor's page; subsequent "Load more" clicks continue from there.
 *
 * `error` is a stable, bounded string ('load_failed_<status>' or
 * 'load_failed') — safe to render directly. The hook does NOT toast
 * or log; the consumer renders an inline retry affordance.
 *
 * Tested in `tests/unit/use-cursor-pagination.test.tsx`. Used by the
 * three Epic O-4 portfolio drill-down tables.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCursorPaginationOptions<TRow> {
    /** Rows the server rendered on initial page-load. */
    initialRows: ReadonlyArray<TRow>;
    /** Cursor for the second page, or null if the first page is also the last. */
    initialNextCursor: string | null;
    /**
     * Build the fully-formed URL for the next page given the current
     * cursor. The caller owns cursor encoding (URL-safe by contract;
     * encodeURIComponent is the recommended path) and any extra query
     * params (limit, view, etc.).
     */
    fetchUrl: (cursor: string) => string;
    /**
     * Optional. When it changes, the accumulator starts again from the
     * CURRENT `initialRows` / `initialNextCursor`, and a page still in
     * flight for the old key is dropped. A page whose server-rendered first
     * page follows its URL filters passes the applied filters here, so
     * changing a filter replaces the list rather than keeping the rows the
     * old filters loaded. Omitted, the seed is read once, as before.
     */
    resetKey?: string;
}

export interface UseCursorPaginationResult<TRow> {
    rows: TRow[];
    nextCursor: string | null;
    hasMore: boolean;
    loading: boolean;
    /** Bounded enum-ish string. `null` when no error has fired yet. */
    error: string | null;
    /**
     * Fetch the next page and append. No-op when there's no cursor or a
     * fetch is already in flight. Returns a Promise so callers can
     * `await` the cycle in tests; UI consumers can fire-and-forget.
     */
    loadMore: () => Promise<void>;
}

interface PageResponse<TRow> {
    rows: TRow[];
    nextCursor: string | null;
}

export function useCursorPagination<TRow>(
    options: UseCursorPaginationOptions<TRow>,
): UseCursorPaginationResult<TRow> {
    const { initialRows, initialNextCursor, fetchUrl, resetKey } = options;

    // Snapshot the initial rows once. Callers passing a fresh array
    // every render (e.g. server prop drilling) shouldn't reset the
    // accumulator — only an explicit re-mount should. The hook owns
    // the in-flight pagination state; the prop is the seed.
    const [rows, setRows] = useState<TRow[]>(() => [...initialRows]);
    const [nextCursor, setNextCursor] = useState<string | null>(
        initialNextCursor,
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Re-seed when `resetKey` changes: React's "adjust state while
    // rendering" pattern, so the new seed shows in the same render rather
    // than one effect later. `currentKey` is what an in-flight load compares
    // against, so a page fetched for the old key never lands on the new list.
    const [seededKey, setSeededKey] = useState(resetKey);
    if (resetKey !== seededKey) {
        setSeededKey(resetKey);
        setRows([...initialRows]);
        setNextCursor(initialNextCursor);
        setError(null);
        setLoading(false);
    }
    const currentKey = useRef(resetKey);
    useEffect(() => {
        currentKey.current = resetKey;
    }, [resetKey]);

    const loadMore = useCallback(async (): Promise<void> => {
        if (!nextCursor || loading) return;
        const startedFor = currentKey.current;
        const stale = () => currentKey.current !== startedFor;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(fetchUrl(nextCursor), {
                credentials: "same-origin",
            });
            if (stale()) return;
            if (!res.ok) {
                setError(`load_failed_${res.status}`);
                return;
            }
            const json = (await res.json()) as PageResponse<TRow>;
            if (stale()) return;
            setRows((prev) => [...prev, ...json.rows]);
            setNextCursor(json.nextCursor);
        } catch {
            if (!stale()) setError("load_failed");
        } finally {
            if (!stale()) setLoading(false);
        }
    }, [nextCursor, loading, fetchUrl]);

    return {
        rows,
        nextCursor,
        hasMore: nextCursor !== null,
        loading,
        error,
        loadMore,
    };
}
