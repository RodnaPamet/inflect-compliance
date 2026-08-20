/** @jest-environment jsdom */

/**
 * `<EntityPrevNextNav>` — the up/down record stepper beside a detail-page name.
 *
 * Two invariants, both of which were broken or latent before this suite:
 *
 * 1. It RENDERS when given real list ids. The component was never deleted —
 *    it hid itself because its caller fed it `[]` after `/assets` changed
 *    response shape. The retired structural guard asserted only that the
 *    source still *mentioned* the component, so it passed 3/3 the whole time
 *    the feature was dead. These assertions fail instead.
 *
 * 2. Its keyboard binding requires ALT. `useKeyboardShortcut` defaults
 *    `preventDefault` to true and binds on `window`, so a bare ArrowUp/Down
 *    binding would stop the arrow keys scrolling the detail page. That was
 *    invisible while the component rendered nothing.
 */

import { fireEvent, render } from '@testing-library/react';
import * as React from 'react';

import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';
import { idsFromCappedList } from '@/lib/list-backfill-cap';

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: mockReplace,
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

const hrefFor = (id: string) => `/t/acme/assets/${id}`;

function mount(ids: string[], currentId: string) {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityPrevNextNav
                    ids={ids}
                    currentId={currentId}
                    hrefFor={hrefFor}
                    labelSingular="asset"
                />
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}

beforeEach(() => mockReplace.mockClear());

describe('EntityPrevNextNav — renders for a real list payload', () => {
    // The exact envelope `/assets` returns today. Feeding the component ids
    // derived from it is the assertion that would have failed on dd0a9127e.
    const payload = {
        rows: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
        truncated: false,
    };

    it('mounts both steppers for a mid-list record', () => {
        const ids = idsFromCappedList(payload);
        const { queryByTestId } = mount(ids, 'a2');
        expect(queryByTestId('entity-prev-next-nav')).not.toBeNull();
        expect(queryByTestId('entity-nav-prev')).not.toBeNull();
        expect(queryByTestId('entity-nav-next')).not.toBeNull();
    });

    it('steps to the previous and next neighbour in list order', () => {
        const ids = idsFromCappedList(payload);
        const { getByTestId } = mount(ids, 'a2');

        fireEvent.click(getByTestId('entity-nav-prev'));
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a1'));

        mockReplace.mockClear();
        fireEvent.click(getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a3'));
    });

    it('disables the ends rather than wrapping around', () => {
        const ids = idsFromCappedList(payload);
        const first = mount(ids, 'a1');
        expect(first.getByTestId('entity-nav-prev').hasAttribute('disabled')).toBe(true);
        expect(first.getByTestId('entity-nav-next').hasAttribute('disabled')).toBe(false);
        first.unmount();

        const last = mount(ids, 'a3');
        expect(last.getByTestId('entity-nav-next').hasAttribute('disabled')).toBe(true);
    });

    it('hides itself when there is nothing to step through', () => {
        expect(mount(idsFromCappedList({ rows: [{ id: 'only' }], truncated: false }), 'only')
            .queryByTestId('entity-prev-next-nav')).toBeNull();
        // Current id outside the loaded window — arrows would point nowhere.
        expect(mount(['a1', 'a2'], 'not-in-list')
            .queryByTestId('entity-prev-next-nav')).toBeNull();
    });
});

describe('EntityPrevNextNav — arrow keys need alt, so the page still scrolls', () => {
    const ids = ['a1', 'a2', 'a3'];

    it('ignores a BARE ArrowUp/ArrowDown', () => {
        mount(ids, 'a2');
        fireEvent.keyDown(window, { key: 'ArrowUp' });
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('does not preventDefault a bare ArrowDown — that is the page scroll', () => {
        mount(ids, 'a2');
        const evt = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(false);
    });

    it('navigates on alt+ArrowUp / alt+ArrowDown', () => {
        mount(ids, 'a2');

        fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a1'));

        mockReplace.mockClear();
        fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a3'));
    });
});
