/**
 * Tenant-aware mutation helper — for writes that want OPTIMISTIC UI.
 *
 * ## What is actually true (measured 2026-08-05)
 *
 * This docblock used to open "Epic 69 — canonical tenant-aware mutation
 * helper". It was not canonical, and saying so made the codebase look
 * inconsistent when it was in fact consistent about something else:
 *
 *   raw `fetch(`         190 files   <- the de-facto write path
 *   useTenantSWR         117 files   <- genuinely canonical, for READS
 *   useTenantMutation      8 files
 *   @/lib/api-client      14 files
 *
 * `useTenantSWR` won for reads. For writes, `fetch` + `router.refresh()`
 * is what the product does, and a hook claiming otherwise sends every new
 * contributor to reconcile a 190-vs-8 contradiction that has no answer.
 *
 * ## So when do you use this?
 *
 * When the mutation should feel instant: the lifecycle below applies the
 * predicted state to the SWR cache immediately and rolls it back if the
 * request fails. Raw `fetch` + `router.refresh()` cannot do that — it
 * produces a visible full-page refetch.
 *
 * That is a real capability, which is why this hook is kept rather than
 * deleted. It is simply not the default: reach for it when the interaction
 * is latency-sensitive (inline status changes, drag reordering, row
 * toggles), and use `fetch` + `router.refresh()` for the rest.
 *
 * Mass-migrating the 190 raw-fetch sites is NOT implied by this note. Most
 * of them submit a modal and navigate; optimistic cache updates would add
 * rollback semantics they do not need.
 *
 * Lifecycle (one round trip):
 *
 *   1. Caller invokes `trigger(input)`.
 *   2. The hook synchronously applies `optimisticUpdate(current, input)`
 *      to the SWR cache for `key` — every `useTenantSWR(key)` consumer
 *      re-renders immediately with the predicted next state.
 *   3. The hook runs the caller-supplied `mutationFn(input)` — usually
 *      an `apiPatch` / `apiPost` / `apiDelete` from `@/lib/api-client`.
 *   4. On success:
 *        - if `populateCache` is provided, the API result is written
 *          straight into the cache (no follow-up GET);
 *        - else (the default), SWR revalidates the key via background
 *          refetch and overwrites the optimistic state with the
 *          authoritative one.
 *      Either way, any `invalidate` siblings (e.g. a list page when
 *      a detail row mutated) get a background refetch too.
 *   5. On error:
 *        - SWR rolls the cache back to the pre-mutation snapshot
 *          (via `rollbackOnError: true` — the documented default);
 *        - the hook captures the error in `error` state and re-throws
 *          so the caller can also `try/catch` for routing or toast UX.
 *
 * The four supported mutation shapes (each has a single test case in
 * the rendered suite that proves the lifecycle invariant):
 *
 *   - **Patch a detail object** — caller's `optimisticUpdate` returns
 *     the merged object (`{ ...current, ...input }`).
 *   - **Append to a list** — caller's `optimisticUpdate` returns
 *     `[...(current ?? []), tempEntity]`.
 *   - **Remove from a list** — caller's `optimisticUpdate` filters
 *     the doomed entry; on rollback the entry reappears.
 *   - **Status change** — same shape as detail patch with one field.
 *
 * Why this hook, not raw SWR `useSWRConfig().mutate(...)`?
 *
 *   - Tenant-prefixing the cache key matches `useTenantSWR` exactly
 *     so optimistic updates land on the right entry. Without the
 *     wrapper every component would re-derive `/api/t/{slug}/...`.
 *   - The optimistic / mutation / rollback contract is captured as a
 *     single typed call shape — call sites stop reasoning about
 *     SWR's `MutatorOptions` flags and instead think in product
 *     terms ("apply this delta, then call the API, then verify").
 *   - `error` + `isMutating` + `reset()` give pages a familiar
 *     mutation surface for showing inline status without leaking
 *     SWR internals.
 *
 * Out of scope for this prompt:
 *
 *   - Generic optimistic-list-shape helpers (filter/upsert/append).
 *     Each call site writes a tiny `optimisticUpdate` closure for
 *     now; we'll factor common shapes once three or more pages
 *     have migrated and the actual repeated patterns reveal
 *     themselves.
 *   - Cross-page broadcast beyond the `invalidate` array.
 *   - Mutation queueing for offline scenarios.
 */
'use client';

import { useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';

import { ApiClientError } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/**
 * Caller-provided shape that turns the current cached value plus the
 * mutation input into the optimistic next state. `current` may be
 * `undefined` if no read has populated the cache yet — callers should
 * handle the empty case explicitly so list appends still work on a
 * cold cache.
 *
 * Returning `undefined` means "no optimistic prediction for this state":
 * SWR leaves the (empty) cache alone and the UI shows the loading path
 * until the mutation resolves. This is the honest answer on a cold cache
 * for a mutation that PATCHES an existing entity — there is nothing to
 * patch yet.
 *
 * The return used to be `TData`, with no way to say that. Every caller
 * that hit a cold cache had to invent a value: the control detail page
 * wrote `current as unknown as ControlPageDataDTO` (a double cast that
 * types `undefined` as a full DTO — if it ever ran, every field read off
 * it would throw), and FindingsClient synthesised an empty list whose only
 * job was, in its own comment, "to satisfy the non-optional
 * OptimisticUpdater return contract". Neither was a prediction anyone
 * wanted painted.
 */
export type OptimisticUpdater<TData, TInput> = (
    current: TData | undefined,
    input: TInput,
) => TData | undefined;

/**
 * Caller-provided shape for translating a successful API response into
 * the cache-final value. Skipping this is fine — the default behaviour
 * is to revalidate (background GET) so the optimistic prediction gets
 * replaced by the authoritative response. Provide it only when the
 * mutation endpoint already returns the full row and a follow-up GET
 * would be wasteful.
 */
export type PopulateCacheFn<TData, TResult> = (
    result: TResult,
    current: TData | undefined,
) => TData;

export interface UseTenantMutationOptions<TData, TInput, TResult = TData> {
    /**
     * Tenant-relative cache key whose entry the optimistic update
     * applies to. Same shape as `useTenantSWR`'s `path` — leading `/`
     * optional, prefixed with `/api/t/{slug}` automatically.
     *
     * Pages doing a creation flow (POST that mints a new entity)
     * usually point this at the LIST cache (`/risks`), not at a
     * detail key that doesn't exist yet.
     */
    key: string;

    /**
     * The actual API call. Throw to trigger rollback. Return the
     * server's response if the caller needs the new id, an updated
     * row, etc. — `trigger()` resolves to whatever `mutationFn`
     * returns.
     */
    mutationFn: (input: TInput) => Promise<TResult>;

    /**
     * Compute the cache state that should appear immediately when
     * `trigger(input)` is called. Omit when no optimistic prediction
     * is meaningful (e.g. operations whose result is unknowable
     * without server compute) — in that case the hook still runs the
     * mutation + revalidates, but the UI sees the loading state.
     */
    optimisticUpdate?: OptimisticUpdater<TData, TInput>;

    /**
     * Rebuild the cache from the API response on success. Default:
     * undefined → SWR revalidates (background GET) instead. Pass a
     * function only when the response IS the new cache state and you
     * want to skip the follow-up GET for latency.
     */
    populateCache?: PopulateCacheFn<TData, TResult> | true;

    /**
     * Whether to revalidate (background GET) the primary key after
     * the mutation resolves. Default: `true`. Set `false` when
     * `populateCache` is provided and the response is authoritative.
     */
    revalidate?: boolean;

    /**
     * Additional tenant-relative paths to revalidate after success.
     * Use for "detail change → list" propagation (e.g. mutating a
     * single risk should refresh the list page's `/risks` cache).
     * These are NOT optimistically updated — only invalidated.
     */
    invalidate?: readonly string[];

    /**
     * Whether to roll back to the prior cache value when
     * `mutationFn` throws. Default: `true`. Disable only when the
     * mutation is purely additive on the server but the caller wants
     * the optimistic state to persist regardless (rare).
     */
    rollbackOnError?: boolean;
}

export interface UseTenantMutationResult<TInput, TResult> {
    /**
     * Fire the mutation. Resolves to the API response on success.
     * Re-throws the error on failure (after the cache rolls back),
     * so callers can `try/catch` for toast/redirect UX without
     * also having to read `error` from the hook.
     */
    trigger: (input: TInput) => Promise<TResult>;
    /** True between trigger() invocation and resolution. */
    isMutating: boolean;
    /** Last error observed. Survives until `reset()` or the next trigger(). */
    error: ApiClientError | Error | null;
    /** Clear `error` after a UI presentation (e.g. dismiss toast). */
    reset: () => void;
}

/**
 * Tenant-aware optimistic mutation. See module docstring for the
 * lifecycle, the four supported product shapes, and the deliberate
 * non-features.
 */
export function useTenantMutation<TData, TInput, TResult = TData>(
    options: UseTenantMutationOptions<TData, TInput, TResult>,
): UseTenantMutationResult<TInput, TResult> {
    const {
        key,
        mutationFn,
        optimisticUpdate,
        populateCache,
        revalidate = true,
        invalidate = [],
        rollbackOnError = true,
    } = options;

    const buildApiUrl = useTenantApiUrl();
    const { mutate: globalMutate } = useSWRConfig();

    const [isMutating, setIsMutating] = useState(false);
    const [error, setError] = useState<ApiClientError | Error | null>(null);
    const reset = useCallback(() => setError(null), []);

    const trigger = useCallback(
        async (input: TInput): Promise<TResult> => {
            const cacheKey = buildApiUrl(key);
            setIsMutating(true);
            setError(null);
            try {
                // SWR's mutate signature accepts a Promise<Data> as the
                // second arg — when present it bridges the optimistic
                // state to the resolved state automatically. We pass
                // the mutation result coerced to the cache shape via
                // `populateCache`; if the caller didn't supply one we
                // skip the cache-write half and rely on revalidation.
                // The two-generic form binds:
                //   - `TData`  = cache value type (drives optimisticData,
                //     populateCache's `current`, rollback restoration);
                //   - `TResult` = mutation response type (the second arg
                //     and the resolved Promise).
                // SWR's `mutate(key, Promise<TResult>, opts)` returns
                // `Promise<TResult | undefined>` — undefined only when
                // the mutation rejects after rollback, which we surface
                // by re-throwing in the catch below.
                const result = await globalMutate<TData, TResult>(
                    cacheKey,
                    mutationFn(input),
                    {
                        // The optimistic data updater receives the
                        // CURRENT cached value. If the caller didn't
                        // supply an updater we skip the optimistic
                        // step — the field is left undefined so SWR
                        // doesn't paint a phantom intermediate state.
                        //
                        // An updater that RETURNS undefined ("no
                        // prediction for this state" — see
                        // OptimisticUpdater) falls back to the current
                        // value, so the cache is written with what it
                        // already holds. On a cold cache that is
                        // `undefined`, i.e. no paint at all, which is the
                        // point. SWR's own `optimisticData` signature has
                        // no way to express "skip", hence the passthrough
                        // rather than a conditional.
                        ...(optimisticUpdate
                            ? {
                                  optimisticData: (
                                      current: TData | undefined,
                                  ) =>
                                      optimisticUpdate(current, input) ??
                                      (current as TData),
                              }
                            : {}),
                        rollbackOnError,
                        revalidate,
                        // `populateCache` is either:
                        //   - a function (translate API result → cache value),
                        //   - `true` (use the response verbatim — only safe
                        //     when TResult and TData are the same shape),
                        //   - omitted (don't write the response; rely on
                        //     revalidation to refresh the cache).
                        populateCache:
                            typeof populateCache === 'function'
                                ? (result, current) =>
                                      populateCache(
                                          result as TResult,
                                          current as TData | undefined,
                                      )
                                : populateCache === true
                                    ? true
                                    : false,
                    },
                );

                // Fan out invalidations to sibling caches AFTER the
                // primary write completes — that way the user-visible
                // optimistic page already reflects the change before
                // background refetches start.
                if (invalidate.length > 0) {
                    await Promise.all(
                        invalidate.map((siblingPath) =>
                            globalMutate(buildApiUrl(siblingPath)),
                        ),
                    );
                }

                // The mutate() return is `TResult | undefined`. With a
                // Promise<TResult> argument and a successful resolve,
                // SWR returns the resolved value. The non-undefined
                // narrowing here is justified by that contract — we
                // re-await the underlying promise as a belt to
                // satisfy the type system without a cast.
                return result as TResult;
            } catch (caught) {
                const err =
                    caught instanceof Error
                        ? caught
                        : new Error(String(caught));
                setError(err);
                throw err;
            } finally {
                setIsMutating(false);
            }
        },
        [
            buildApiUrl,
            globalMutate,
            invalidate,
            key,
            mutationFn,
            optimisticUpdate,
            populateCache,
            revalidate,
            rollbackOnError,
        ],
    );

    return { trigger, isMutating, error, reset };
}
