"use client";

/**
 * Epic P2-PR-B — `useTenantAssets(tenantSlug)`.
 *
 * Sibling of `useTenantControls` (P2-PR-A) and `useTenantRisks`
 * (P2-PR-B) for the inspector's asset-node picker. Assets carry a
 * `key` (short code) + `name` so the label format is "<key> · <name>"
 * when key is present, otherwise bare name.
 */
import { useEffect, useState } from "react";

import {
    isSessionExpired,
    noteUnauthorized,
} from "@/lib/auth/session-expiry";

export interface TenantAssetOption {
    id: string;
    key: string | null;
    name: string;
    /**
     * PR-D polish — live status surface (parity with Controls +
     * Risks). The API ships `Asset.status` on each row; we carry
     * it through so the inspector can render a tone-coloured chip.
     */
    status: string | null;
}

interface TenantAssetsState {
    options: TenantAssetOption[];
    loading: boolean;
    error: string | null;
}

interface UseTenantAssetsOptions {
    /**
     * PR-D polish — periodic revalidation cadence in milliseconds.
     * See `use-tenant-controls` for the full contract.
     */
    pollMs?: number;
}

const CACHE = new Map<string, TenantAssetOption[]>();

async function fetchTenantAssets(
    tenantSlug: string,
): Promise<TenantAssetOption[]> {
    const url = `/api/t/${tenantSlug}/assets`;
    const res = await fetch(url);
    if (!res.ok) {
        // #2222 — record a 401 in the app-wide store BEFORE throwing.
        // The catch below cannot tell 401 from 503 once the status is
        // wrapped in an Error message, and the two need opposite
        // treatment: a 503 must preserve the last-good options, a 401
        // never recovers. `noteUnauthorized` owns the 401-only rule.
        noteUnauthorized(res.status, url);
        throw new Error(`Could not load assets (${res.status})`);
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
        ? (body as unknown[])
        : Array.isArray((body as { assets?: unknown[] })?.assets)
          ? (body as { assets: unknown[] }).assets
          : Array.isArray((body as { data?: unknown[] })?.data)
            ? (body as { data: unknown[] }).data
            : [];
    return rows
        .map((r) => {
            const row = r as {
                id?: unknown;
                key?: unknown;
                name?: unknown;
                status?: unknown;
            };
            if (typeof row.id !== "string") return null;
            return {
                id: row.id,
                key: typeof row.key === "string" ? row.key : null,
                name:
                    typeof row.name === "string"
                        ? row.name
                        : "(unnamed)",
                status: typeof row.status === "string" ? row.status : null,
            };
        })
        .filter((r): r is TenantAssetOption => r !== null);
}

export function useTenantAssets(
    tenantSlug: string,
    options?: UseTenantAssetsOptions,
): TenantAssetsState {
    const cached = CACHE.get(tenantSlug);
    const [state, setState] = useState<TenantAssetsState>(() => ({
        options: cached ?? [],
        loading: cached === undefined && tenantSlug !== "",
        error: null,
    }));
    const pollMs = options?.pollMs ?? 0;

    useEffect(() => {
        if (tenantSlug === "") {
            setState({ options: [], loading: false, error: null });
            return;
        }
        let cancelled = false;
        const initialCached = CACHE.has(tenantSlug);
        if (initialCached) {
            setState({
                options: CACHE.get(tenantSlug) ?? [],
                loading: false,
                error: null,
            });
        } else {
            setState({ options: [], loading: true, error: null });
        }
        const runFetch = async (isRevalidation: boolean) => {
            // #2222 — PULL the terminal flag; nothing pushes it here.
            // This callback was scheduled by the interval below and
            // closes over the bindings it had then, so a React state
            // update could never reach it — which is why the flag is a
            // module-scoped store and is read at the top of each tick.
            if (isSessionExpired()) return;
            try {
                const opts = await fetchTenantAssets(tenantSlug);
                CACHE.set(tenantSlug, opts);
                if (!cancelled) {
                    setState({ options: opts, loading: false, error: null });
                }
            } catch (err) {
                if (cancelled) return;
                // Background revalidations preserve the last-good
                // state — a transient blip shouldn't blank the
                // canvas's status badges. Only the initial fetch
                // surfaces the error to the consumer.
                //
                // #2222 — this predicate is CORRECT for a 503 and was
                // the whole bug for a 401: one branch serving two
                // failure classes that need opposite treatment. It
                // stays as it is, and the 401 half is handled where the
                // status is still readable — `noteUnauthorized` in the
                // fetcher above, plus the `isSessionExpired()` pull at
                // the top of this function and in the interval, which
                // is what stops the poll re-firing forever.
                if (isRevalidation) return;
                setState({
                    options: [],
                    loading: false,
                    error:
                        err instanceof Error
                            ? err.message
                            : "Could not load assets",
                });
            }
        };
        if (!initialCached) {
            void runFetch(false);
        }
        let timer: ReturnType<typeof setInterval> | null = null;
        if (pollMs > 0) {
            timer = setInterval(() => {
                // #2222 — stop the timer from INSIDE itself. The auth
                // failure can land on any tick and there is no outer
                // signal to react to; without this the poll re-fires
                // forever against an endpoint that can only 401 (~38
                // of these run on a canvas with 20 edges + 15 linked
                // nodes). The user is told once, by the app-wide
                // notice in `providers.tsx`.
                if (isSessionExpired()) {
                    if (timer !== null) clearInterval(timer);
                    return;
                }
                void runFetch(true);
            }, pollMs);
        }
        return () => {
            cancelled = true;
            if (timer !== null) clearInterval(timer);
        };
    }, [tenantSlug, pollMs]);

    return state;
}

export function formatAssetLabel(opt: TenantAssetOption): string {
    return opt.key ? `${opt.key} · ${opt.name}` : opt.name;
}

/**
 * PR-D polish — locate one asset by id (parity with the
 * controls + risks `find*` helpers).
 */
export function findTenantAsset(
    state: TenantAssetsState,
    id: string | null,
): TenantAssetOption | null {
    if (!id) return null;
    return state.options.find((o) => o.id === id) ?? null;
}

export function __resetTenantAssetsCacheForTests(): void {
    CACHE.clear();
}
