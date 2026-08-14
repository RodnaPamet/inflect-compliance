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
describe('opt-in cards (defaultVisible: false) can actually be turned on', () => {
    /**
     * The regression this pins shipped in #1905 and was live on main.
     *
     * `defaultVisibleDefs` EXCLUDES opt-in cards, and both `order` and
     * `onToggle` reconciled against it. So toggling one ON wrote the id to
     * storage and the very next render dropped it again — it was never in the
     * live set. The checklist row rendered, the user clicked, and the checkbox
     * did not even check. Two Policies KPI cards were unreachable.
     *
     * Note what the #1905 ratchet asserted: that `defaultVisible: false`
     * appears in the page source. It did. The flag was present and inert.
     * That is the difference between pinning the shape of a diff and testing
     * that the feature works — and it is why this test toggles rather than
     * greps.
     */
    const OPT_IN: CardDefinition[] = [
        { id: 'total', label: 'Total', kind: 'kpi' },
        { id: 'draft', label: 'Draft', kind: 'kpi' },
        { id: 'overdue', label: 'Overdue', kind: 'kpi', defaultVisible: false },
    ];

    /** onToggle is not on the hook result — it rides the rendered gear. */
    const toggle = (
        result: { current: { dropdown: React.ReactNode } },
        id: string,
    ) => {
        const dd = result.current.dropdown as React.ReactElement<{
            onToggle: (id: string) => void;
        }>;
        act(() => dd.props.onToggle(id));
    };

    beforeEach(() => window.localStorage.clear());

    it('hides an opt-in card on a fresh mount', () => {
        const { result } = renderHook(() =>
            useFilterCardVisibility({ storageKey: 'test:opt-in:fresh', cards: OPT_IN }),
        );
        expect(result.current.visibleCards.map((c) => c.id)).toEqual(['total', 'draft']);
    });

    it('SHOWS it after the user toggles it on, and keeps it across a re-render', () => {
        const { result, rerender } = renderHook(() =>
            useFilterCardVisibility({ storageKey: 'test:opt-in:toggle', cards: OPT_IN }),
        );
        toggle(result, 'overdue');
        expect(result.current.visibleCards.map((c) => c.id)).toContain('overdue');

        // The bug only became visible on the NEXT render: the id was written
        // to storage and then reconciled straight back out.
        rerender();
        expect(result.current.visibleCards.map((c) => c.id)).toContain('overdue');
    });

    it('survives a remount — the choice is persisted, not just in-memory', () => {
        const first = renderHook(() =>
            useFilterCardVisibility({ storageKey: 'test:opt-in:persist', cards: OPT_IN }),
        );
        toggle(first.result, 'overdue');
        first.unmount();

        const second = renderHook(() =>
            useFilterCardVisibility({ storageKey: 'test:opt-in:persist', cards: OPT_IN }),
        );
        expect(second.result.current.visibleCards.map((c) => c.id)).toContain('overdue');
    });

    it('can be toggled back off again', () => {
        const { result } = renderHook(() =>
            useFilterCardVisibility({ storageKey: 'test:opt-in:off', cards: OPT_IN }),
        );
        toggle(result, 'overdue');
        expect(result.current.visibleCards.map((c) => c.id)).toContain('overdue');
        toggle(result, 'overdue');
        expect(result.current.visibleCards.map((c) => c.id)).not.toContain('overdue');
    });

    it('a default-visible card still hides — widening the def list did not un-hide anything', () => {
        const { result } = renderHook(() =>
            useFilterCardVisibility({ storageKey: 'test:opt-in:still-hides', cards: OPT_IN }),
        );
        toggle(result, 'draft');
        expect(result.current.visibleCards.map((c) => c.id)).toEqual(['total']);
    });
});

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
