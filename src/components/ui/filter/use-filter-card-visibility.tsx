'use client';

/**
 * useFilterCardVisibility — the "Edit filter cards" gear's state (2026-06-07).
 *
 * Owns the click-to-order + visibility state for the cards above a list
 * table, persists it to localStorage under `inflect:filter-vis:<entity>`, and
 * returns a ready `<EditFiltersButton>` plus the ordered visible cards.
 *
 *   const cards: CardDefinition[] = useMemo(() => [
 *     { id: 'total',  label: tx('list.kpiTotal'),  kind: 'kpi' },
 *     { id: 'draft',  label: tx('list.kpiDraft'),  kind: 'kpi' },
 *     { id: 'stale',  label: tx('list.kpiStale'),  kind: 'kpi', defaultVisible: false },
 *   ], [tx]);
 *   const { visibleCards, dropdown: filterGear } =
 *     useFilterCardVisibility({ storageKey: 'inflect:filter-vis:policies', cards });
 *   // strip:   {visibleCards.map((card) => …)}
 *   // toolbar: <EntityListPage filters={{ defs: liveFilters, toolbarActions: filterGear }} />
 *
 * WHAT THE GEAR CONTROLS. `kind: 'kpi'` — on all eight list pages, since
 * #1886. The gear is named "edit cards" and edits the KPI cards; it does not
 * touch the filter dropdown, and the toolbar gets the FULL filter defs.
 *
 * An earlier version of this comment said the opposite ("only `kind:'filter'`
 * is wired; kpi is a forward-compat extension point") and its usage example
 * called `filtersToCards` + `selectVisibleFilters` — the two functions
 * `kpi-sparkline-canonical` now FAILS a page for calling. So the module's own
 * documentation instructed the next contributor to write code that could not
 * merge. #1905 corrected the field comment on `kind` and missed this block,
 * which is its own lesson: fixing the line you are looking at is not the same
 * as fixing the file.
 *
 * `preset` and `scope` remain genuine forward-compat extension points — typed,
 * unused, and free to register here later.
 *
 * WHY THERE IS NO `kpisToCards` FACTORY. Each page hand-writes its array
 * (evidence 5 cards, policies 6, tasks 4, vendors 5, risks 4, plus tests). That
 * is deliberate, but NOT for the reason recorded in the #1886 implementation
 * note — which says every label carries "that page's own tx() call" and is
 * false on its own evidence. There are three different label mechanisms in
 * play: `tx('list.kpiTotal')` (policies, evidence), `t('kpi.total')` (tasks,
 * vendors) and `t.totalRisks`, a SERVER-PASSED PROP BAG (risks). A factory
 * would therefore have to take a label resolver as a parameter, and what
 * remains to be saved is the words `kind: 'kpi'` on each line.
 *
 * So: inline is right, the array is the page's own data, and if you are here
 * to extract a factory, the thing to extract is not the labels.
 */
import {
    createElement,
    isValidElement,
    useCallback,
    useMemo,
    type ComponentType,
    type ReactNode,
    type SVGProps,
} from 'react';
import { useLocalStorage } from '@/components/ui/hooks';
import {
    buildChecklistItems,
    defaultOrder,
    isModifiedFromDefault,
    reconcileOrder,
    reorderOrder,
    toggleOrder,
} from '@/components/ui/checklist-order';
import { EditFiltersButton } from './edit-filters-button';
import type { Filter as FilterType } from './types';

/** Discriminator for the cards a filter gear can control. */
export type CardKind = 'filter' | 'kpi' | 'preset' | 'scope';

export interface CardDefinition {
    /** Unique key — used for localStorage persistence + checklist rows. */
    id: string;
    /** Shown in the checklist. */
    label: string;
    /** Shown in the checklist row. */
    icon?: ReactNode;
    /** Defaults to `true` — set `false` for opt-in cards. */
    defaultVisible?: boolean;
    /** Extensible discriminator; `'filter'` and `'kpi'` are both wired. */
    kind: CardKind;
}

export interface UseFilterCardVisibilityOptions {
    /** Convention: `'inflect:filter-vis:<entity>'`. */
    storageKey: string;
    cards: CardDefinition[];
}

export interface UseFilterCardVisibilityResult {
    /** Visible cards, in left-to-right order. */
    visibleCards: CardDefinition[];
    /** Pre-rendered gear — drop into the toolbar actions slot. */
    dropdown: ReactNode;
}

/**
 * Render a `FilterIcon` to a node for the checklist. FilterIcon is a union
 * of three shapes and each needs different handling:
 *   - an already-created element (`<Foo/>`)        → use as-is
 *   - a COMPONENT TYPE: a function component OR a forwardRef/memo object
 *     (lucide icons are forwardRef — `{$$typeof, render, displayName}`,
 *     NOT a plain function), which must be INSTANTIATED, else React throws
 *     #31 ("objects are not valid as a React child")
 *   - a plain node (string/number)                 → use as-is
 */
function renderFilterIcon(icon: FilterType['icon']): ReactNode {
    if (icon == null) return undefined;
    if (isValidElement(icon)) return icon;
    const isComponentType =
        typeof icon === 'function' ||
        (typeof icon === 'object' && '$$typeof' in (icon as object));
    if (isComponentType) {
        return createElement(
            icon as ComponentType<SVGProps<SVGSVGElement>>,
            { className: 'h-3.5 w-3.5' },
        );
    }
    return icon as ReactNode;
}

/**
 * Map a page's `FilterType[]` into `kind: 'filter'` card definitions.
 *
 * NO CALLERS IN `src/`, deliberately, and `kpi-sparkline-canonical` FAILS any
 * list page that acquires one — feeding the gear filter categories is the
 * defect #1886 existed to remove. Same for `selectVisibleFilters` below, which
 * returns `[]` once every card is `kind: 'kpi'`, so wiring it into a toolbar
 * renders an empty Filter dropdown.
 *
 * Kept rather than deleted because they are the correct projection for a
 * future `kind: 'filter'` consumer, and that argument previously existed only
 * inside a dated implementation note — which is read-only, classified
 * historical, and not where anyone looks before deleting an unused export.
 * If that future consumer never arrives, deleting these three (with
 * `renderFilterIcon` and their two unit tests) is the right call; it is not a
 * decision to make silently in passing.
 */
export function filtersToCards(filters: FilterType[]): CardDefinition[] {
    return filters.map((f) => ({
        id: f.key,
        label: f.label,
        icon: renderFilterIcon(f.icon),
        kind: 'filter' as const,
    }));
}

/**
 * Project the gear's ordered visible cards back onto the page's filter
 * defs — the `FilterType[]` (in order) to pass to `<FilterToolbar filters>`.
 */
export function selectVisibleFilters(
    visibleCards: CardDefinition[],
    allFilters: FilterType[],
): FilterType[] {
    const byKey = new Map(allFilters.map((f) => [f.key, f]));
    return visibleCards
        .filter((c) => c.kind === 'filter')
        .map((c) => byKey.get(c.id))
        .filter((f): f is FilterType => Boolean(f));
}

export function useFilterCardVisibility({
    storageKey,
    cards,
}: UseFilterCardVisibilityOptions): UseFilterCardVisibilityResult {
    const defaultVisibleDefs = useMemo(
        () => cards.filter((c) => c.defaultVisible !== false),
        [cards],
    );
    const defaults = useMemo(
        () => defaultOrder(defaultVisibleDefs),
        [defaultVisibleDefs],
    );

    const [stored, setStored] = useLocalStorage<string[]>(storageKey, defaults);

    /**
     * Reconcile a persisted order against EVERY registered card — not just
     * the default-visible ones.
     *
     * `defaultVisibleDefs` answers "what shows on a fresh mount". It must not
     * also answer "what is the user allowed to turn on", and conflating the
     * two made every `defaultVisible: false` card permanently unreachable:
     * `onToggle` wrote the id to storage, and the next render's reconcile
     * dropped it again because it was never in the live set. The checklist row
     * rendered, the user clicked, and the checkbox did not even check.
     *
     * `reconcileOrder` only DROPS unknown ids — it never appends — so widening
     * the def list cannot un-hide anything. Opt-in cards stay hidden on a
     * fresh mount because `defaults` is still built from `defaultVisibleDefs`.
     *
     * The non-array branch stays on `defaults` rather than delegating: a
     * pre-gear persisted value is a TanStack VisibilityState OBJECT, and
     * `reconcileOrder`'s own fallback returns every def it is given — which,
     * now that we pass the full registry, would silently un-hide the opt-in
     * cards for exactly those legacy users.
     */
    const reconcileLive = useCallback(
        (prev: unknown): string[] =>
            Array.isArray(prev) ? reconcileOrder(prev as string[], cards) : defaults,
        [cards, defaults],
    );

    const order = useMemo(() => {
        const reconciled = reconcileLive(stored);
        // Stale-data migration: if a NON-empty persisted order had ALL of
        // its ids dropped (the gear's cards changed identity — e.g. filter
        // categories → KPI cards under the same storage key), fall back to
        // defaults rather than rendering an empty card set. A genuinely
        // empty `stored` (user hid everything) is respected.
        if (
            reconciled.length === 0 &&
            Array.isArray(stored) &&
            stored.length > 0
        ) {
            return defaults;
        }
        return reconciled;
    }, [stored, reconcileLive, defaults]);

    const cardById = useMemo(
        () => new Map(cards.map((c) => [c.id, c])),
        [cards],
    );
    const visibleCards = useMemo(
        () =>
            order
                .map((id) => cardById.get(id))
                .filter((c): c is CardDefinition => Boolean(c)),
        [order, cardById],
    );
    const items = useMemo(
        () => buildChecklistItems(cards, order),
        [cards, order],
    );
    const someModified = useMemo(
        () => isModifiedFromDefault(order, defaults),
        [order, defaults],
    );

    const onToggle = useCallback(
        (id: string) => setStored((prev) => toggleOrder(reconcileLive(prev), id)),
        [setStored, reconcileLive],
    );
    const onReset = useCallback(() => setStored(defaults), [setStored, defaults]);
    const onReorder = useCallback(
        (fromId: string, toId: string) =>
            setStored((prev) => reorderOrder(reconcileLive(prev), fromId, toId)),
        [setStored, reconcileLive],
    );

    const dropdown = (
        <EditFiltersButton
            items={items}
            onToggle={onToggle}
            onReset={onReset}
            onReorder={onReorder}
            someModified={someModified}
        />
    );

    return { visibleCards, dropdown };
}
