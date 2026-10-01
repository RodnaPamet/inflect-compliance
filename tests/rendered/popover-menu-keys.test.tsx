/**
 * `role="menu"` IS A PROMISE, AND THIS CONTAINER WAS NOT KEEPING IT.
 *
 * A screen reader announces `role="menu"` as a menu, and its user reaches for
 * the arrow keys, because that is the ARIA menu pattern. `Popover.Menu` offered
 * Tab and nothing else — which walks through the items and then straight OUT of
 * the popover, closing it. The user never reached the last action.
 *
 * Arrow keys, Home and End now move focus between items and wrap at the ends.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { Popover } from '@/components/ui/popover';

function Menu({ onKeyDown }: { onKeyDown?: React.KeyboardEventHandler }) {
    return (
        <Popover.Menu onKeyDown={onKeyDown}>
            <Popover.Item>first</Popover.Item>
            <Popover.Item disabled>skipped</Popover.Item>
            <Popover.Item>second</Popover.Item>
            <Popover.Separator />
            <Popover.Item destructive>third</Popover.Item>
        </Popover.Menu>
    );
}

const item = (name: string) => screen.getByRole('menuitem', { name });

/**
 * Fired on the CONTAINER, which is where the handler lives, so the test does
 * not depend on bubbling from whichever item currently holds focus.
 *
 * Returns false when something called `preventDefault()`.
 */
const press = (key: string) =>
    fireEvent.keyDown(screen.getByRole('menu'), { key });

describe('Popover.Menu — roving focus', () => {
    it('ArrowDown from nowhere lands on the FIRST item', () => {
        render(<Menu />);
        press('ArrowDown');
        expect(item('first')).toHaveFocus();
    });

    it('ArrowDown SKIPS a disabled item', () => {
        // Focus that lands on a disabled control goes nowhere: the user presses
        // down, nothing appears to happen, and they conclude the menu is broken.
        render(<Menu />);
        press('ArrowDown');
        press('ArrowDown');
        expect(item('second')).toHaveFocus();
    });

    it('ArrowDown wraps from the last item to the first', () => {
        render(<Menu />);
        press('End');
        expect(item('third')).toHaveFocus();
        press('ArrowDown');
        expect(item('first')).toHaveFocus();
    });

    it('ArrowUp from nowhere lands on the LAST item', () => {
        render(<Menu />);
        press('ArrowUp');
        expect(item('third')).toHaveFocus();
    });

    it('ArrowUp wraps from the first item to the last', () => {
        render(<Menu />);
        press('Home');
        expect(item('first')).toHaveFocus();
        press('ArrowUp');
        expect(item('third')).toHaveFocus();
    });

    it('Home and End jump to the ends', () => {
        render(<Menu />);
        press('End');
        expect(item('third')).toHaveFocus();
        press('Home');
        expect(item('first')).toHaveFocus();
    });

    it('leaves other keys alone', () => {
        // The handler must not swallow typing, Escape, or Tab — Escape closes
        // the popover and Tab is still a legitimate way out.
        render(<Menu />);
        press('ArrowDown');
        expect(press('Escape')).toBe(true);
        expect(press('Tab')).toBe(true);
        expect(item('first')).toHaveFocus();
    });

    it("does not swallow the page's keys when the menu has no items", () => {
        // `preventDefault` has to come AFTER the empty check, or an empty menu
        // eats arrow keys that belonged to the page behind it.
        render(<Popover.Menu />);
        expect(press('ArrowDown')).toBe(true);
    });

    it('claims the key when it DID move focus', () => {
        // The other side of the same coin: an arrow key the menu acts on must
        // not also scroll the page.
        render(<Menu />);
        expect(press('ArrowDown')).toBe(false);
    });

    it("a caller's own handler runs first and can claim the key", () => {
        const onKeyDown = jest.fn((e: React.KeyboardEvent) =>
            e.preventDefault(),
        );
        render(<Menu onKeyDown={onKeyDown} />);

        press('ArrowDown');

        expect(onKeyDown).toHaveBeenCalled();
        // Claimed, so the roving handler stood down.
        expect(item('first')).not.toHaveFocus();
    });
});
