'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Command Palette entity search — UNIFIED ENDPOINT VERSION.
 *
 * Replaces the original Epic 57 per-entity fan-out (5 parallel
 * fetches across `/controls`, `/risks`, `/policies`, `/evidence`,
 * `/frameworks`) with a single call to the unified search API at
 * `GET /api/t/<slug>/search?q=`. Server-side ranking, per-type
 * caps, and result shape now live in one place.
 *
 * The exported types + hook signature are intentionally
 * unchanged from the original so the palette consumer
 * (`command-palette.tsx`) compiles without a render-side
 * rewrite. Inside, every per-entity mapper is gone — the API
 * already returns the canonical shape.
 *
 * Characteristics that stayed the same:
 *   - Debounces input (≈180 ms).
 *   - Cancels in-flight requests via AbortController on every
 *     keystroke, so a slow network can't paint stale results.
 *   - Stays inert when the palette opens outside a tenant route
 *     (`/login`, `/audit/shared/...`).
 *
 * What's new:
 *   - One round-trip per search (down from five).
 *   - Server-side ranking — hits are pre-sorted by relevance.
 *   - Frameworks no longer cached client-side; the unified
 *     endpoint queries them with the same `?q=` filter as
 *     everything else, so cache-stampede + framework-list
 *     freshness concerns disappear.
 */

import { useEffect, useRef, useState } from 'react';
import type { SearchHit, SearchHitType, SearchResponse } from '@/lib/search/types';

// ─── Public types — kept identical to the original hook ───────────────

export type EntityKind = SearchHitType;

export interface EntitySearchResult {
    id: string;
    kind: EntityKind;
    primary: string;
    secondary?: string;
    badge?: string;
    href: string;
}

export interface EntitySearchState {
    loading: boolean;
    results: EntitySearchResult[];
    disabled: boolean;
    /**
     * The last search did not answer: a non-2xx (a 500, a read-tier 429) or
     * a network failure. Distinct from an empty answer, so the palette never
     * reports "no results" for a search that never ran (#5309). An abort is
     * neither — a newer query superseded it.
     */
    failed: boolean;
}

// ─── Tunables ─────────────────────────────────────────────────────────

const DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 2;

// ─── Adapter — typed `SearchHit` → palette-shaped row ─────────────────

function adaptHit(h: SearchHit): EntitySearchResult {
    return {
        id: h.id,
        kind: h.type,
        primary: h.title,
        secondary: h.subtitle ?? undefined,
        badge: h.badge ?? undefined,
        href: h.href,
    };
}

// ─── Pathname → tenant slug ────────────────────────────────────────────

/**
 * Derive the current tenant slug from a pathname. Returns `null`
 * on any non-tenant route, making the search hook inert there.
 */
export function tenantSlugFromPathname(pathname: string | null): string | null {
    if (!pathname) return null;
    const match = pathname.match(/^\/t\/([^/?#]+)/);
    return match ? match[1] : null;
}

// ─── Hook ──────────────────────────────────────────────────────────────

export function useEntitySearch(
    query: string,
    tenantSlug: string | null,
): EntitySearchState {
    const [state, setState] = useState<EntitySearchState>({
        loading: false,
        results: [],
        disabled: tenantSlug === null,
        failed: false,
    });
    // Track requests so a stale debounce doesn't overwrite a fresh
    // result even if AbortController fires after the new request
    // returns. Belt-and-braces alongside the abort signal.
    const seqRef = useRef(0);

    useEffect(() => {
        if (tenantSlug === null) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setState({ loading: false, results: [], disabled: true, failed: false });
            return;
        }
        const trimmed = query.trim();
        if (trimmed.length < MIN_QUERY_LENGTH) {
            setState({ loading: false, results: [], disabled: false, failed: false });
            return;
        }

        const seq = ++seqRef.current;
        const controller = new AbortController();
        const { signal } = controller;
        const timer = setTimeout(async () => {
            setState((prev) => ({ ...prev, loading: true, disabled: false }));
            const url = `/api/t/${encodeURIComponent(tenantSlug)}/search?q=${encodeURIComponent(trimmed)}`;
            let payload: SearchResponse | null = null;
            let failed = false;
            try {
                const res = await fetch(url, { signal, credentials: 'same-origin' });
                if (res.ok) payload = (await res.json()) as SearchResponse;
                else failed = true;
            } catch {
                // Network failure, or an abort — which the check below drops.
                failed = true;
            }
            if (signal.aborted || seq !== seqRef.current) return;

            const hits = payload?.hits ?? [];
            setState({
                loading: false,
                disabled: false,
                results: hits.map(adaptHit),
                failed,
            });
        }, DEBOUNCE_MS);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, tenantSlug]);

    return state;
}

// Exported for tests so they can assert against the same bounds.
export const __SEARCH_TUNING__ = {
    DEBOUNCE_MS,
    MIN_QUERY_LENGTH,
};
