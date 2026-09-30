/**
 * Epic 57 — first product-level shortcuts.
 *
 * The audit calls out `F` (open filters) and `Escape` (close the
 * correct active context) as the first real uses of the shared
 * keyboard system. These tests lock the BEHAVIOUR — the options that
 * FilterSelect, FilterList, and SelectionToolbar actually pass to the
 * hook — rather than the primitive markup, so they're resilient to
 * visual refactors as long as the product contract holds.
 *
 * Contract under test:
 *
 *   F
 *   ─
 *   - Fires `setIsOpen(true)` for the active page's filter trigger
 *   - Inert while typing in an input / textarea / contenteditable
 *   - Inert while the filter popover is already open (enabled: !isOpen)
 *   - Inert while a modal/sheet/popover overlay is open
 *
 *   Escape
 *   ──────
 *   - When rows are selected, clears the selection (priority 2)
 *   - When no selection but filters are active, clears filters (priority 1)
 *   - While an overlay is mounted, BOTH global-scope handlers stand
 *     down — Radix/Vaul's native Escape owns that context
 */

import React, { useRef, useState } from 'react';
import { render, fireEvent } from '@testing-library/react';

import {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
} from '@/lib/hooks/use-keyboard-shortcut';

// ─── Harness mirroring the real FilterSelect F registration ──────────

function FilterTrigger({
    onOpen,
    children,
}: {
    onOpen: () => void;
    children?: React.ReactNode;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const host = useRef<HTMLDivElement>(null);
    // Mirrors the real registration, which is `within`-scoped rather than
    // global: `f` is a single printable character, and binding one globally
    // breaks WCAG 2.1.4. Anything the tests want focus on lives INSIDE this
    // host, so a negative assertion cannot pass merely because focus was
    // outside the region.
    useKeyboardShortcut(
        'f',
        () => {
            setIsOpen(true);
            onOpen();
        },
        { enabled: !isOpen, within: host, description: 'Open filters' },
    );
    return (
        <div ref={host} data-testid="filter-host" tabIndex={-1}>
            <div data-testid="filter-trigger" data-open={isOpen} />
            {children}
        </div>
    );
}

// ─── Harness mirroring the real Escape registrations ─────────────────

function ClearFiltersBinding({ onClear }: { onClear: () => void }) {
    useKeyboardShortcut('Escape', onClear, {
        priority: 1,
        scope: 'global',
        description: 'Clear all filters',
    });
    return null;
}

function ClearSelectionBinding({
    selectedCount,
    onClear,
}: {
    selectedCount: number;
    onClear: () => void;
}) {
    useKeyboardShortcut('Escape', onClear, {
        enabled: selectedCount > 0,
        priority: 2,
        scope: 'global',
        description: 'Clear selection',
    });
    return null;
}

// ─── `F` — open filters ──────────────────────────────────────────────

describe('Core shortcut: F — open filters', () => {
    it('opens the active filter trigger', () => {
        const open = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <FilterTrigger onOpen={open} />
            </KeyboardShortcutProvider>,
        );
        const host = getByTestId('filter-host');
        host.focus();
        fireEvent.keyDown(host, { key: 'f', code: 'KeyF' });
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('does not fire while typing in an input', () => {
        const open = jest.fn();
        const { container } = render(
            <KeyboardShortcutProvider>
                <FilterTrigger onOpen={open}>
                    <input aria-label="search" />
                </FilterTrigger>
            </KeyboardShortcutProvider>,
        );
        // INSIDE the host, deliberately: focus is within the scoped region, so
        // the only thing that can suppress the shortcut is the editable-target
        // guard. Rendered as a sibling it would not fire either, and the test
        // would pass without exercising that guard at all.
        const input = container.querySelector('input')!;
        input.focus();
        fireEvent.keyDown(input, { key: 'f', code: 'KeyF' });
        expect(open).not.toHaveBeenCalled();
    });

    it('does not fire while typing in a textarea or contenteditable', () => {
        const open = jest.fn();
        const { container } = render(
            <KeyboardShortcutProvider>
                <FilterTrigger onOpen={open}>
                    <textarea aria-label="notes" />
                    <div
                        data-testid="rte"
                        contentEditable
                        suppressContentEditableWarning
                    />
                </FilterTrigger>
            </KeyboardShortcutProvider>,
        );
        // Both INSIDE the host — see the input case above.
        const ta = container.querySelector('textarea')!;
        (ta as HTMLTextAreaElement).focus();
        fireEvent.keyDown(ta, { key: 'f', code: 'KeyF' });
        const rte = container.querySelector('[data-testid="rte"]')! as HTMLElement;
        rte.focus();
        fireEvent.keyDown(rte, { key: 'f', code: 'KeyF' });
        expect(open).not.toHaveBeenCalled();
    });

    it('does not fire while the filter is already open (enabled: !isOpen)', () => {
        const open = jest.fn();
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <FilterTrigger onOpen={open} />
            </KeyboardShortcutProvider>,
        );
        const host = getByTestId('filter-host');
        host.focus();
        fireEvent.keyDown(host, { key: 'f', code: 'KeyF' });
        fireEvent.keyDown(host, { key: 'f', code: 'KeyF' });
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('does not fire while a modal overlay is open', () => {
        const open = jest.fn();
        render(
            <KeyboardShortcutProvider>
                {/* Marker element matching the provider's overlay
                    selector — what Radix Dialog renders when open. */}
                <div role="dialog" aria-label="x" data-state="open" />
                <FilterTrigger onOpen={open} />
            </KeyboardShortcutProvider>,
        );
        fireEvent.keyDown(window, { key: 'f' });
        expect(open).not.toHaveBeenCalled();
    });
});

// ─── Escape — close the correct active context ──────────────────────

describe('Core shortcut: Escape — close active context', () => {
    it('clears the selection when rows are selected (priority 2 wins)', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <ClearSelectionBinding selectedCount={3} onClear={clearSelection} />
                <ClearFiltersBinding onClear={clearFilters} />
            </KeyboardShortcutProvider>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(clearSelection).toHaveBeenCalledTimes(1);
        expect(clearFilters).not.toHaveBeenCalled();
    });

    it('clears filters when no selection is active', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <ClearSelectionBinding selectedCount={0} onClear={clearSelection} />
                <ClearFiltersBinding onClear={clearFilters} />
            </KeyboardShortcutProvider>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(clearSelection).not.toHaveBeenCalled();
        expect(clearFilters).toHaveBeenCalledTimes(1);
    });

    it('re-enables after the selection is cleared (enabled toggles on count)', () => {
        function Harness() {
            const [count, setCount] = useState(2);
            return (
                <>
                    <ClearSelectionBinding
                        selectedCount={count}
                        onClear={() => setCount(0)}
                    />
                    <ClearFiltersBinding onClear={() => {}} />
                    <div data-testid="count">{count}</div>
                </>
            );
        }
        const { getByTestId } = render(
            <KeyboardShortcutProvider>
                <Harness />
            </KeyboardShortcutProvider>,
        );
        expect(getByTestId('count').textContent).toBe('2');
        fireEvent.keyDown(window, { key: 'Escape' });
        // First Escape: clears selection (count → 0).
        expect(getByTestId('count').textContent).toBe('0');
    });

    it('stands down while a modal overlay is open — native Escape owns the close', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <div role="dialog" aria-label="x" data-state="open" />
                <ClearSelectionBinding selectedCount={3} onClear={clearSelection} />
                <ClearFiltersBinding onClear={clearFilters} />
            </KeyboardShortcutProvider>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(clearSelection).not.toHaveBeenCalled();
        expect(clearFilters).not.toHaveBeenCalled();
    });

    it('stands down while a Vaul sheet/drawer is open', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <div data-vaul-drawer="true" data-state="open" />
                <ClearSelectionBinding selectedCount={3} onClear={clearSelection} />
                <ClearFiltersBinding onClear={clearFilters} />
            </KeyboardShortcutProvider>,
        );
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(clearSelection).not.toHaveBeenCalled();
        expect(clearFilters).not.toHaveBeenCalled();
    });

    it('does not fire while typing in an input', () => {
        const clearSelection = jest.fn();
        const clearFilters = jest.fn();
        const { container } = render(
            <KeyboardShortcutProvider>
                <ClearSelectionBinding selectedCount={3} onClear={clearSelection} />
                <ClearFiltersBinding onClear={clearFilters} />
                <input aria-label="search" />
            </KeyboardShortcutProvider>,
        );
        const input = container.querySelector('input')!;
        input.focus();
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(clearSelection).not.toHaveBeenCalled();
        expect(clearFilters).not.toHaveBeenCalled();
    });
});

// ─── Source-level regression check ──────────────────────────────────

describe('Call sites carry palette-ready descriptions', () => {
    // Future command palette lists every registered shortcut by its
    // `description`. Missing a description would render the shortcut
    // as "(no description)" in the palette — acceptable, but the
    // product-level bindings must always be labelled.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const ROOT = path.resolve(__dirname, '../..');

    const sites = [
        {
            file: 'src/components/ui/filter/filter-select.tsx',
            description: 'Open filters',
        },
        {
            file: 'src/components/ui/filter/filter-list.tsx',
            description: 'Clear all filters',
        },
        {
            // i18n: the description now flows through the catalog.
            file: 'src/components/ui/table/selection-toolbar.tsx',
            description: 'Clear selection',
            i18nKey: 'common.table.clearSelection',
        },
    ] as Array<{ file: string; description: string; i18nKey?: string }>;

    for (const s of sites) {
        it(`${s.file} registers with description "${s.description}"`, () => {
            const src = fs.readFileSync(path.join(ROOT, s.file), 'utf-8');
            if (s.i18nKey) {
                // Assert the shortcut wires description through t(<key>) and
                // that the key still resolves to the canonical English label.
                const [ns, ...rest] = s.i18nKey.split('.');
                const shortKey = rest.join('.');
                expect(src).toContain(`description: t("${shortKey}")`);
                const en = JSON.parse(
                    fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf-8'),
                );
                const resolved = s.i18nKey
                    .split('.')
                    .reduce(
                        (o: unknown, k: string) =>
                            o && typeof o === 'object'
                                ? (o as Record<string, unknown>)[k]
                                : undefined,
                        en,
                    );
                expect(resolved).toBe(s.description);
                expect(ns).toBe('common');
            } else {
                expect(src).toContain(`description: "${s.description}"`);
            }
        });
    }
});
