'use client';

/**
 * Breadcrumbs context — Roadmap-2 PR-2.
 *
 * The top chrome (rendered by `<AppShell>`) carries breadcrumbs in
 * its left region. Pages tell the chrome what to render via
 * `useBreadcrumbs(items)` — the hook pushes the items into a
 * shell-scoped context, the chrome consumes them. When a page
 * unmounts, the hook clears its push so the previous page's trail
 * doesn't bleed into the next route.
 *
 * Why a context, not a portal:
 *   • A portal would force the page to render breadcrumbs into the
 *     chrome's DOM — fine on desktop, fragile on mobile where the
 *     chrome collapses. Context lets the chrome decide HOW to
 *     render at each viewport.
 *   • Concurrent pages (e.g. modal-on-route, parallel routes) can
 *     each push without DOM contention. The latest push wins; the
 *     previous one is preserved as fallback when the latest unmounts.
 *
 * Why a stack, not a single value:
 *   • Detail-page-with-modal-overlay scenarios: the modal mounts a
 *     transient sub-route that wants its own breadcrumbs without
 *     trampling the underlying page's trail. The stack lets each
 *     mount push, and pop on cleanup, restoring the parent.
 */
import {
    createContext,
    isValidElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import type { BreadcrumbItem } from '@/components/ui/breadcrumbs';

interface BreadcrumbsApi {
    /** Currently-displayed breadcrumb trail (top of the stack). */
    items: ReadonlyArray<BreadcrumbItem>;
    /**
     * Push a trail. Returns a stable cleanup function that pops
     * exactly this push. Pages call this from `useBreadcrumbs`;
     * never call it directly.
     */
    push: (items: ReadonlyArray<BreadcrumbItem>) => () => void;
}

const BreadcrumbsContext = createContext<BreadcrumbsApi | null>(null);

/**
 * Provider — mount once inside `<AppShell>`. Outside the shell
 * (auth/error/print surfaces) the context is absent and
 * `useBreadcrumbs` becomes a silent no-op so unauth pages can
 * still call the hook without crashing if they share components.
 */
export function BreadcrumbsProvider({ children }: { children: ReactNode }) {
    // Stack of pushes. Render the TOP push (last array).
    const [stack, setStack] = useState<
        ReadonlyArray<ReadonlyArray<BreadcrumbItem>>
    >([]);

    const push = useCallback(
        (items: ReadonlyArray<BreadcrumbItem>) => {
            const entry = items;
            setStack((prev) => [...prev, entry]);
            // Cleanup pops THIS specific entry by reference identity —
            // safe under concurrent pushes from sibling components.
            return () => {
                setStack((prev) => prev.filter((e) => e !== entry));
            };
        },
        [],
    );

    const items = stack[stack.length - 1] ?? [];

    const api = useMemo<BreadcrumbsApi>(
        () => ({ items, push }),
        [items, push],
    );

    return (
        <BreadcrumbsContext.Provider value={api}>
            {children}
        </BreadcrumbsContext.Provider>
    );
}

/**
 * One way back on a phone (#5822). On a page that shows a back link, the
 * inline (phone-only) breadcrumb trail is hidden, so a phone shows the back
 * link and nothing else, in the one place every subpage mounts it: above the
 * title. Desktop is untouched — its trail is the chrome's.
 *
 * Pure CSS, keyed on the DOM, not on a route list: every back link carries
 * `BACK_LINK_ATTR`, and the trail wrappers carry `PHONE_TRAIL_CLASS`, whose
 * arbitrary variant hides them inside a `<main>` that holds a back link. So
 * the rule is exactly "a back link is showing", it is right in the server
 * HTML (no flash), and it costs no JavaScript — a JS rule here pulled the
 * product's route registry into every page's First Load JS.
 */
export const BACK_LINK_ATTR = 'data-back-link';
export const PHONE_TRAIL_CLASS = 'md:hidden [main:has([data-back-link])_&]:hidden';

/**
 * Read the current breadcrumb trail. The `<TopChrome>` is the only
 * canonical caller. Returns an empty array when the provider is
 * absent (e.g. on unauth surfaces).
 */
export function useCurrentBreadcrumbs(): ReadonlyArray<BreadcrumbItem> {
    const ctx = useContext(BreadcrumbsContext);
    return ctx?.items ?? [];
}

/**
 * Push a breadcrumb trail for the current page. Re-runs when the
 * `items` array reference changes — pass a stable reference (e.g.
 * `useMemo` or a top-level const) to avoid thrashing the stack.
 *
 * Outside `<BreadcrumbsProvider>` (auth/error/print) this hook is
 * a silent no-op so pages can call it unconditionally.
 */
export function useBreadcrumbs(
    items: ReadonlyArray<BreadcrumbItem> | undefined,
): void {
    const ctx = useContext(BreadcrumbsContext);
    // Snapshot the latest items in a ref so the effect's identity
    // is stable per-page-mount, not per-render. A page that builds
    // its breadcrumbs inline each render would otherwise push a
    // fresh array every keystroke.
    const itemsRef = useRef(items);
    itemsRef.current = items;

    // Serialise the items so reference changes that DON'T change
    // the visible trail don't re-push. This is the right tradeoff:
    // pages typically rebuild breadcrumbs each render but the
    // CONTENT is stable.
    //
    // A label may be a ReactNode (a loading skeleton in the test-plan trail),
    // and a React element is not serialisable — its owner fiber is circular —
    // so an element is keyed by its type and key, not walked.
    const key = useMemo(
        () =>
            JSON.stringify(items ?? [], (_k, v: unknown) =>
                isValidElement(v)
                    ? `<element:${typeof v.type === 'string' ? v.type : 'component'}:${v.key ?? ''}>`
                    : v,
            ),
        [items],
    );

    useEffect(() => {
        if (!ctx || !items || items.length === 0) return;
        const cleanup = ctx.push(itemsRef.current ?? []);
        return cleanup;
        // ctx is stable per-provider-mount; key is the content
        // identity. Re-pushing on either is correct.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ctx, key]);
}
