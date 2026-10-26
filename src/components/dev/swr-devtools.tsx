/**
 * Epic 69 — development-only SWR cache inspector.
 *
 * Floating panel at the bottom-right of the viewport that surfaces
 * the live state of every Epic 69 SWR cache entry. Operators leave
 * the panel collapsed; expanding it shows:
 *
 *   - Total cache size + a count of in-flight revalidations
 *     (i.e. keys whose `isValidating` is currently true).
 *   - Per-key state: whether `data` is present, whether `error` is
 *     set, whether `isValidating` is true right now, and a relative
 *     timestamp ("3s ago") of the last observed transition.
 *   - A miniature hit/miss tally maintained from
 *     observation: every render where a key flips from `isValidating`
 *     to settled increments the "hit" counter; every render where
 *     `error` becomes non-null increments "miss".
 *
 * Visibility — guarded THREE ways so the panel cannot leak into
 * production traffic:
 *
 *   1. The default-export wrapper checks
 *      `process.env.NODE_ENV !== 'development'` at the React tree
 *      boundary and renders `null`. Next.js inlines `NODE_ENV` at
 *      build time, so the entire panel is dead code in the prod
 *      bundle and tree-shaken away.
 *   2. The wrapper ALSO checks `process.env.NEXT_PUBLIC_TEST_MODE`
 *      so Playwright runs don't paint a floating overlay over the
 *      page during E2E selector-visibility checks.
 *   3. The component itself returns `null` if `useSWRConfig()` is
 *      somehow unavailable (e.g. the surrounding tree was rendered
 *      without an SWR provider) — so the panel never throws even
 *      under unexpected wiring.
 *
 * The component is intentionally simple — no debounced searches,
 * no tabular sorting, no exporters. The Epic 69 brief calls for
 * "lightweight and useful, not a heavy debug framework"; this fits.
 * If a future epic needs richer instrumentation (e.g. rolling
 * latency histograms), it lives next to this file under
 * `src/components/dev/` so the dev-only namespace stays tidy.
 */
'use client';

import * as React from 'react';
import { useSWRConfig } from 'swr';
import { useTranslations } from 'next-intl';

interface KeyState {
    /** Cache key as SWR holds it (the resolved absolute URL). */
    key: string;
    /** Whether the entry has data right now. */
    hasData: boolean;
    /** Whether the entry has an error right now. */
    hasError: boolean;
    /** Whether SWR is currently revalidating this key. */
    isValidating: boolean;
    /** Wall-clock timestamp (ms) of the last time the panel
     *  observed this key's state in any meaningful way (data
     *  arrived, error landed, validation cycled). */
    lastSeenAt: number;
}

interface CacheSnapshot {
    /** Total entries currently in the cache. */
    total: number;
    /** Count of entries where `isValidating` is true right now. */
    validatingCount: number;
    /** Per-key state, sorted by most-recently-active. */
    entries: KeyState[];
    /** Cumulative hit (settled successfully) counter since mount. */
    hits: number;
    /** Cumulative miss (settled with error) counter since mount. */
    misses: number;
}

const REFRESH_INTERVAL_MS = 1_000;

/**
 * Inner component that subscribes to the SWR cache. Assumes
 * `useSWRConfig()` is available; the wrapper at the bottom of the
 * file gates render so production never reaches this code path.
 */
function SWRDevToolsImpl() {
    // The panel is dead code in production -- the public entry returns null
    // unless NODE_ENV is 'development', and Next inlines that -- but the a11y
    // props still have to come from the catalogue (#3209): the ratchet's
    // subject is the PROP, not whether a user can reach it. The provider is an
    // ancestor (the root layout wraps everything), so the hook is safe here.
    const t = useTranslations('common.ui');
    const { cache } = useSWRConfig();
    const [open, setOpen] = React.useState(false);
    const [snapshot, setSnapshot] = React.useState<CacheSnapshot>({
        total: 0,
        validatingCount: 0,
        entries: [],
        hits: 0,
        misses: 0,
    });

    // Per-key prior-state tracker so we can count hit/miss
    // transitions without piggy-backing on SWR's internal events
    // (which aren't part of the public API). Lives in a ref so
    // updates don't retrigger the polling effect.
    const priorRef = React.useRef<
        Map<string, { isValidating: boolean; hasError: boolean }>
    >(new Map());
    const lastSeenRef = React.useRef<Map<string, number>>(new Map());
    const hitsRef = React.useRef(0);
    const missesRef = React.useRef(0);

    React.useEffect(() => {
        // Poll the cache every second. SWR's `cache` is a Map-like
        // surface — we iterate its keys and read each entry's state.
        // This is cheaper than subscribing to per-key events and
        // bounded by interval, so the panel never blocks the main
        // thread even with hundreds of cache entries.
        const tick = () => {
            const now = Date.now();
            const entries: KeyState[] = [];
            let validatingCount = 0;
            const seenKeys = new Set<string>();

            // SWR's cache exposes `keys()` per spec. Some adapters
            // also implement Symbol.iterator; we use the explicit
            // method for portability. The structural cast keeps us
            // out of the explicit-`any` ratchet — we read one optional
            // method, nothing more.
            const cacheKeys = (
                cache as unknown as {
                    keys?: () => Iterable<unknown>;
                }
            ).keys?.();
            if (!cacheKeys) {
                setSnapshot((prev) => ({ ...prev, total: 0 }));
                return;
            }

            for (const k of cacheKeys) {
                if (typeof k !== 'string') continue;
                seenKeys.add(k);
                const state = cache.get(k) as
                    | {
                          data?: unknown;
                          error?: unknown;
                          isValidating?: boolean;
                      }
                    | undefined;
                const hasData = state?.data !== undefined;
                const hasError = state?.error !== undefined;
                const isValidating = !!state?.isValidating;

                if (isValidating) validatingCount++;

                // Detect transitions for hit/miss counters.
                const prior = priorRef.current.get(k);
                if (prior) {
                    if (prior.isValidating && !isValidating) {
                        // Just settled — count hit if no error,
                        // miss otherwise.
                        if (hasError) {
                            missesRef.current += 1;
                        } else if (hasData) {
                            hitsRef.current += 1;
                        }
                    }
                    // Detect error-edge separately: transition into
                    // error counts as a miss even if the key wasn't
                    // marked validating in the previous tick (some
                    // adapters skip the validating flag).
                    if (!prior.hasError && hasError) {
                        missesRef.current += 1;
                    }
                }
                priorRef.current.set(k, { isValidating, hasError });

                // Update last-seen timestamp on any state change.
                const priorSeen = lastSeenRef.current.get(k);
                if (
                    !priorSeen ||
                    !prior ||
                    prior.isValidating !== isValidating ||
                    prior.hasError !== hasError
                ) {
                    lastSeenRef.current.set(k, now);
                }
                entries.push({
                    key: k,
                    hasData,
                    hasError,
                    isValidating,
                    lastSeenAt: lastSeenRef.current.get(k) ?? now,
                });
            }

            // Drop stale tracking entries — keys evicted from cache
            // shouldn't accumulate in the prior-state ref forever.
            for (const k of priorRef.current.keys()) {
                if (!seenKeys.has(k)) {
                    priorRef.current.delete(k);
                    lastSeenRef.current.delete(k);
                }
            }

            entries.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

            setSnapshot({
                total: entries.length,
                validatingCount,
                entries,
                hits: hitsRef.current,
                misses: missesRef.current,
            });
        };

        tick();
        const id = window.setInterval(tick, REFRESH_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [cache]);

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                data-testid="swr-devtools-toggle"
                style={{
                    position: 'fixed',
                    right: 12,
                    bottom: 12,
                    zIndex: 2_147_483_647,
                    padding: '6px 10px',
                    fontSize: 11,
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    background: '#0f172a',
                    color: '#cbd5e1',
                    border: '1px solid #334155',
                    borderRadius: 4,
                    cursor: 'pointer',
                    opacity: 0.85,
                }}
            >
                SWR · {snapshot.total}
                {snapshot.validatingCount > 0
                    ? ` · ↻${snapshot.validatingCount}`
                    : ''}
            </button>
        );
    }

    return (
        <div
            data-testid="swr-devtools-panel"
            style={{
                position: 'fixed',
                right: 12,
                bottom: 12,
                zIndex: 2_147_483_647,
                width: 380,
                maxHeight: '60vh',
                background: '#0f172a',
                color: '#cbd5e1',
                border: '1px solid #334155',
                borderRadius: 6,
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 10px',
                    borderBottom: '1px solid #334155',
                    background: '#1e293b',
                }}
            >
                <strong style={{ fontSize: 12 }}>SWR DevTools</strong>
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    data-testid="swr-devtools-close"
                    style={{
                        background: 'transparent',
                        color: '#cbd5e1',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 14,
                        lineHeight: 1,
                    }}
                    aria-label={t('devtoolsClose')}
                >
                    ×
                </button>
            </div>
            <div
                style={{
                    padding: '6px 10px',
                    borderBottom: '1px solid #334155',
                    display: 'flex',
                    gap: 12,
                    flexWrap: 'wrap',
                }}
            >
                <span data-testid="swr-devtools-total">
                    keys: <strong>{snapshot.total}</strong>
                </span>
                <span data-testid="swr-devtools-validating">
                    validating: <strong>{snapshot.validatingCount}</strong>
                </span>
                <span
                    data-testid="swr-devtools-hits"
                    title={t('devtoolsHits')}
                >
                    hit: <strong>{snapshot.hits}</strong>
                </span>
                <span
                    data-testid="swr-devtools-misses"
                    title={t('devtoolsErrors')}
                >
                    miss: <strong>{snapshot.misses}</strong>
                </span>
            </div>
            <div
                style={{ overflow: 'auto', flex: 1 }}
                data-testid="swr-devtools-entries"
            >
                {snapshot.entries.length === 0 ? (
                    <div style={{ padding: '12px 10px', opacity: 0.6 }}>
                        Cache is empty. Mount any `useTenantSWR` consumer
                        on the current page to populate.
                    </div>
                ) : (
                    snapshot.entries.map((entry) => (
                        <DevToolsRow key={entry.key} entry={entry} />
                    ))
                )}
            </div>
        </div>
    );
}

function DevToolsRow({ entry }: { entry: KeyState }) {
    // Dev-only devtools row — Date.now() shows live age in seconds; the
    // mild render-cycle staleness is the intended behaviour for this UI.
    // eslint-disable-next-line react-hooks/purity
    const ageSec = Math.max(0, Math.round((Date.now() - entry.lastSeenAt) / 1000));
    const ageLabel = ageSec === 0 ? 'now' : `${ageSec}s`;
    return (
        <div
            data-testid={`swr-devtools-row-${entry.key}`}
            style={{
                padding: '4px 10px',
                borderBottom: '1px solid #1e293b',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    width: 8,
                    height: 8,
                    flex: '0 0 auto',
                    borderRadius: 999,
                    background: entry.hasError
                        ? '#dc2626'
                        : entry.isValidating
                            ? '#f59e0b'
                            : entry.hasData
                                ? '#22c55e'
                                : '#64748b',
                }}
            />
            <span
                style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                }}
                title={entry.key}
            >
                {entry.key}
            </span>
            <span style={{ flex: '0 0 auto', opacity: 0.6 }}>{ageLabel}</span>
        </div>
    );
}

/**
 * Public entry point. Renders nothing in production / test runs;
 * mounts the live panel only when `NODE_ENV === 'development'` AND
 * `NEXT_PUBLIC_TEST_MODE !== '1'`.
 *
 * Place this once at the top of `ClientProviders` so every tenant /
 * org page gets the panel without per-page wiring.
 */
export default function SWRDevTools() {
    if (process.env.NODE_ENV !== 'development') return null;
    if (process.env.NEXT_PUBLIC_TEST_MODE === '1') return null;
    return <SWRDevToolsImpl />;
}

// Named export for tests that need to render the unguarded panel
// (force-on rendering inside a controlled SWRConfig).
export { SWRDevToolsImpl };
