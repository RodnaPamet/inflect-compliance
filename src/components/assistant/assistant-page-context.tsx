'use client';

/**
 * What the assistant can see of the page you are on (#3841).
 *
 * A provider rather than a prop drilled from every page, because the launcher
 * mounts once in `AppShell` and the pages that have context to offer are
 * dozens of levels away from it. A page that has nothing to add registers
 * nothing and the assistant simply gets the route.
 *
 * The route is read from `usePathname()` rather than reported by pages, so the
 * baseline context is correct on every page with no per-page wiring — the same
 * reason the launcher mounts in the shell.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The parts a page can contribute. Mirrors `PageContextSchema` on the server,
 * minus `route`, which the provider supplies itself.
 */
export interface AssistantPageFacts {
    /** The entity type in view, as a slug: `control`, `risk`, `vendor`. */
    entity?: string;
    /** Visible filter state, as the query-parameter pairs the user can see. */
    filters?: Record<string, string>;
    /** Ids the user has selected, when the surface supports selection. */
    selectedIds?: string[];
}

interface AssistantPageContextValue {
    facts: AssistantPageFacts;
    /**
     * Replace this page's contribution.
     *
     * Replace rather than merge: a filter the user has CLEARED must disappear
     * from the context, and a merge would keep reporting it. Stale context is
     * worse than none — it produces a confident answer about a filter that is
     * no longer applied.
     */
    setFacts: (facts: AssistantPageFacts) => void;
}

const AssistantPageContextCtx = createContext<AssistantPageContextValue | null>(null);

export function AssistantPageContextProvider({ children }: { children: React.ReactNode }) {
    const [facts, setFacts] = useState<AssistantPageFacts>({});
    const value = useMemo<AssistantPageContextValue>(() => ({ facts, setFacts }), [facts]);
    return (
        <AssistantPageContextCtx.Provider value={value}>
            {children}
        </AssistantPageContextCtx.Provider>
    );
}

/**
 * Register this page's contribution to the assistant's context.
 *
 * Returns a setter rather than taking the facts directly so the caller decides
 * when to report — a list page reports after its filters resolve, not on every
 * render while they are still undefined.
 */
export function useReportAssistantContext(): (facts: AssistantPageFacts) => void {
    const ctx = useContext(AssistantPageContextCtx);
    // No provider is not an error: the assistant is feature-gated, and a page
    // rendered with the launcher switched off should not throw for calling a
    // hook that now has nowhere to report to.
    return useCallback(
        (facts: AssistantPageFacts) => {
            ctx?.setFacts(facts);
        },
        [ctx],
    );
}

/**
 * The context to send with a question, in the server's wire shape.
 *
 * Empty collections are OMITTED rather than sent as `{}` / `[]`: the server
 * distinguishes "no filters" from "filters, none of them set", and an empty
 * object reaching the prompt would read as the latter.
 */
/**
 * Keys and values the server's `PageContextSchema` will accept.
 *
 * Mirrored here so an unacceptable param is DROPPED rather than sent. The
 * server rejects the whole body on a schema violation, so one filter value
 * containing a comma would cost the user their entire turn — losing that
 * filter from the context is the smaller failure by a wide margin.
 */
const FILTER_KEY_OK = /^[A-Za-z0-9_-]{1,40}$/;
const FILTER_VALUE_OK = /^[A-Za-z0-9 _.:+-]{1,80}$/;
const RECORD_ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Query params that are not filter state.
 *
 * `ids` is the selection and is reported as such. The rest are view
 * mechanics — reporting a page number as a "filter" would invite the model to
 * reason about it as one.
 */
const NOT_FILTERS = new Set(['ids', 'page', 'cursor', 'sort', 'dir', 'tab', 'view']);

/** How many filters are worth sending. Past this it is not filter state. */
const MAX_FILTERS = 20;
const MAX_SELECTED_IDS = 50;

export function useAssistantPageContext(): {
    route: string;
    entity?: string;
    filters?: Record<string, string>;
    selectedIds?: string[];
} {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const ctx = useContext(AssistantPageContextCtx);
    const facts = ctx?.facts ?? {};

    // The URL is the baseline source of filter state, not a per-page report.
    //
    // This product serialises filters into the query string —
    // `filterStateToUrlParams` in `src/components/ui/filter/filter-state.ts`,
    // and the controls list writes them with an `ids` param alongside. Reading
    // them here is the same move as reading the route from `usePathname`: it
    // makes the context correct on every list page with NO per-page wiring,
    // which is what stops the capability shipping with no caller.
    //
    // `useReportAssistantContext` remains for what the URL cannot carry — the
    // entity type, and a selection held only in component state. A page's own
    // report WINS over the URL, because a page that bothers to report knows
    // better than this generic reading does.
    const fromUrl = useMemo(() => {
        const filters: Record<string, string> = {};
        const ids: string[] = [];
        if (searchParams !== null) {
            for (const [key, value] of searchParams.entries()) {
                if (key === 'ids') {
                    for (const id of value.split(',')) {
                        if (RECORD_ID_OK.test(id) && ids.length < MAX_SELECTED_IDS) ids.push(id);
                    }
                    continue;
                }
                if (NOT_FILTERS.has(key)) continue;
                if (Object.keys(filters).length >= MAX_FILTERS) break;
                if (FILTER_KEY_OK.test(key) && FILTER_VALUE_OK.test(value)) filters[key] = value;
            }
        }
        return { filters, ids };
    }, [searchParams]);

    return useMemo(() => {
        const filters = facts.filters ?? fromUrl.filters;
        const selectedIds = facts.selectedIds ?? fromUrl.ids;
        return {
            route: pathname ?? '/',
            ...(facts.entity === undefined ? {} : { entity: facts.entity }),
            ...(Object.keys(filters).length === 0 ? {} : { filters }),
            ...(selectedIds.length === 0 ? {} : { selectedIds }),
        };
    }, [pathname, facts.entity, facts.filters, facts.selectedIds, fromUrl]);
}
