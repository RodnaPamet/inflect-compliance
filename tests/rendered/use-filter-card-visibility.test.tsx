/**
 * useFilterCardVisibility — hook behaviour (2026-06-07).
 *
 * Covers the filter-card gear state: default-all-visible, the rendered
 * gear, click-to-order toggling, selectVisibleFilters projection, and the
 * forward-compat CardDefinition `kind` discriminator.
 */
import * as React from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import {
    useFilterCardVisibility,
    filtersToCards,
    selectVisibleFilters,
    type CardDefinition,
} from '@/components/ui/filter/use-filter-card-visibility';
import type { Filter as FilterType } from '@/components/ui/filter/types';

const FILTERS = [
    { key: 'status', label: 'Status', icon: null, options: null },
    { key: 'owner', label: 'Owner', icon: null, options: null },
] as unknown as FilterType[];

const CARDS: CardDefinition[] = [
    { id: 'status', label: 'Status', kind: 'filter' },
    { id: 'owner', label: 'Owner', kind: 'filter' },
];

describe('useFilterCardVisibility', () => {
    it('starts with all cards visible, in order', () => {
        const { result } = renderHook(() =>
            useFilterCardVisibility({
                storageKey: 'test:filter-vis:a',
                cards: CARDS,
            }),
        );
        expect(result.current.visibleCards.map((c) => c.id)).toEqual([
            'status',
            'owner',
        ]);
    });

    it('renders the filter gear', () => {
        function Harness() {
            const { dropdown } = useFilterCardVisibility({
                storageKey: 'test:filter-vis:b',
                cards: CARDS,
            });
            return <div>{dropdown}</div>;
        }
        render(<Harness />);
        expect(screen.getByTestId('edit-filters-button')).toBeInTheDocument();
    });

    it('filtersToCards maps FilterType[] to kind:filter cards', () => {
        const cards = filtersToCards(FILTERS);
        expect(cards).toEqual([
            { id: 'status', label: 'Status', icon: undefined, kind: 'filter' },
            { id: 'owner', label: 'Owner', icon: undefined, kind: 'filter' },
        ]);
    });

    it('selectVisibleFilters projects visible cards back onto FilterType[] in order', () => {
        const visible: CardDefinition[] = [
            { id: 'owner', label: 'Owner', kind: 'filter' },
        ];
        const out = selectVisibleFilters(visible, FILTERS);
        expect(out.map((f) => f.key)).toEqual(['owner']);
    });

    it('hides a card when toggled off and re-projects', () => {
        const { result } = renderHook(() =>
            useFilterCardVisibility({
                storageKey: 'test:filter-vis:c',
                cards: CARDS,
            }),
        );
        // Pull the onToggle out of the rendered dropdown's props.
        const dropdown = result.current.dropdown as React.ReactElement<{
            onToggle: (id: string) => void;
        }>;
        act(() => dropdown.props.onToggle('status'));
        expect(result.current.visibleCards.map((c) => c.id)).toEqual(['owner']);
    });
});

/**
 * The stale-id migration — the invariant the whole kind swap rests on.
 *
 * U1 changed five pages from registering `kind: 'filter'` cards to
 * `kind: 'kpi'` cards UNDER THE SAME STORAGE KEY. That is only safe because
 * of one branch in the hook: when a NON-EMPTY persisted order has every one
 * of its ids dropped, the hook falls back to defaults instead of rendering
 * nothing.
 *
 * Nothing exercised that branch. Every fixture above is `kind: 'filter'`, so
 * the five migrations shipped on an untested assumption — and the failure
 * mode is invisible in code review: the same build shows all KPI cards to a
 * user who has never touched the gear, and an empty strip to one who has.
 */
describe('stale-id migration (the namespace swap)', () => {
    const KPI_CARDS: CardDefinition[] = [
        { id: 'total', label: 'Total', kind: 'kpi' },
        { id: 'active', label: 'Active', kind: 'kpi' },
    ];

    beforeEach(() => window.localStorage.clear());

    it('falls back to defaults when EVERY persisted id is dead', () => {
        // What a real user carries: an order saved while the gear still
        // listed filter categories.
        window.localStorage.setItem(
            'test:filter-vis:swap',
            JSON.stringify(['status', 'owner']),
        );

        const { result } = renderHook(() =>
            useFilterCardVisibility({
                storageKey: 'test:filter-vis:swap',
                cards: KPI_CARDS,
            }),
        );

        // Not an empty strip — all the new cards, visible.
        expect(result.current.visibleCards.map((c) => c.id)).toEqual([
            'total',
            'active',
        ]);
    });

    it('respects a genuinely empty order — the user hid everything', () => {
        window.localStorage.setItem('test:filter-vis:empty', JSON.stringify([]));

        const { result } = renderHook(() =>
            useFilterCardVisibility({
                storageKey: 'test:filter-vis:empty',
                cards: KPI_CARDS,
            }),
        );

        // The migration must NOT fire here: nothing was dropped, the user
        // chose this. Re-showing the cards would silently undo a deliberate
        // choice on every page load.
        expect(result.current.visibleCards).toEqual([]);
    });

    /**
     * The collision hazard, demonstrated rather than described.
     *
     * A single surviving id keeps `reconciled.length > 0`, so the migration
     * is skipped and the user is left with just that one card. This is why
     * `kpi-sparkline-canonical.test.ts` asserts no KPI card id equals one of
     * its page's filter keys — a rename like `dueWeek` → `due` would produce
     * exactly this state, on one page, only for users who had touched the
     * gear.
     */
    it('does NOT migrate when even one persisted id survives', () => {
        window.localStorage.setItem(
            'test:filter-vis:partial',
            JSON.stringify(['status', 'total']),
        );

        const { result } = renderHook(() =>
            useFilterCardVisibility({
                storageKey: 'test:filter-vis:partial',
                cards: KPI_CARDS,
            }),
        );

        expect(result.current.visibleCards.map((c) => c.id)).toEqual(['total']);
    });
});
