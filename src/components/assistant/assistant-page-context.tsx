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
import { usePathname } from 'next/navigation';

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
export function useAssistantPageContext(): {
    route: string;
    entity?: string;
    filters?: Record<string, string>;
    selectedIds?: string[];
} {
    const pathname = usePathname();
    const ctx = useContext(AssistantPageContextCtx);
    const facts = ctx?.facts ?? {};

    return useMemo(() => {
        const filters = facts.filters ?? {};
        const selectedIds = facts.selectedIds ?? [];
        return {
            route: pathname ?? '/',
            ...(facts.entity === undefined ? {} : { entity: facts.entity }),
            ...(Object.keys(filters).length === 0 ? {} : { filters }),
            ...(selectedIds.length === 0 ? {} : { selectedIds }),
        };
    }, [pathname, facts.entity, facts.filters, facts.selectedIds]);
}
