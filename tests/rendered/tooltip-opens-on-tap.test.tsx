/**
 * A tooltip opens on a TAP on a touch screen (#5820).
 *
 * Radix opens a tooltip on mouse hover and keyboard focus and never on a
 * touch pointer — a tap closes it. On a phone the text behind every help icon
 * was therefore unreachable. What this holds:
 *
 *   · an `InfoTooltip` opens on a tap and closes on a second tap or a tap
 *     outside;
 *   · a tooltip on a non-interactive trigger (a badge) opens on a tap;
 *   · a tooltip on an ACTION button does not — the tap does the action and
 *     nothing more, or the label would float over whatever the button opened;
 *   · a mouse click is unchanged.
 *
 * A tap is a `pointerdown` with `pointerType: 'touch'` followed by a `click`,
 * which is the order a browser dispatches them in.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { InfoTooltip, Tooltip, TooltipProvider } from '@/components/ui/tooltip';

function Harness({ children }: { children: React.ReactNode }) {
    return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

function tap(el: Element, pointerType: 'touch' | 'mouse' = 'touch') {
    act(() => {
        fireEvent.pointerDown(el, { pointerType });
        fireEvent.pointerUp(el, { pointerType });
        fireEvent.click(el);
    });
}

describe('InfoTooltip on a touch screen', () => {
    it('opens on a tap and closes on a second tap', () => {
        render(
            <Harness>
                <InfoTooltip content="A date is required." />
            </Harness>,
        );
        const icon = screen.getByRole('button', { name: 'More information' });
        expect(screen.queryByRole('tooltip')).toBeNull();

        tap(icon);
        expect(screen.getByRole('tooltip')).toHaveTextContent('A date is required.');

        tap(icon);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('closes on a tap outside', async () => {
        render(
            <Harness>
                <InfoTooltip content="A date is required." />
                <p data-testid="elsewhere">elsewhere</p>
            </Harness>,
        );
        tap(screen.getByRole('button', { name: 'More information' }));
        expect(screen.getByRole('tooltip')).toBeInTheDocument();

        // Radix's outside-pointer listener is registered a macrotask after
        // the layer mounts, so a person's next tap is always later than that.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        tap(screen.getByTestId('elsewhere'));
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('a mouse click does not open it — desktop is unchanged', () => {
        render(
            <Harness>
                <InfoTooltip content="A date is required." />
            </Harness>,
        );
        tap(screen.getByRole('button', { name: 'More information' }), 'mouse');
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('grows a 44px touch hit area without growing the 16px icon', () => {
        render(
            <Harness>
                <InfoTooltip content="A date is required." />
            </Harness>,
        );
        const cls = screen.getByRole('button', { name: 'More information' }).className.split(/\s+/);
        // The painted box is unchanged…
        expect(cls).toContain('h-4');
        expect(cls).toContain('w-4');
        // …and the hit area is a centred pseudo-element raised to 44px only
        // where the pointer is coarse, anchored by `relative`.
        expect(cls).toContain('relative');
        expect(cls).toContain('pointer-coarse:after:min-h-11');
        expect(cls).toContain('pointer-coarse:after:min-w-11');
        expect(cls).toContain('after:absolute');
    });
});

describe('Tooltip on a touch screen, by what the trigger does', () => {
    it('a non-interactive trigger opens on a tap', () => {
        render(
            <Harness>
                <Tooltip content="Last reviewed 3 days ago">
                    <span data-testid="badge" tabIndex={0}>
                        Reviewed
                    </span>
                </Tooltip>
            </Harness>,
        );
        tap(screen.getByTestId('badge'));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Last reviewed 3 days ago');
    });

    it('an action button does its action and opens nothing', () => {
        const onClick = jest.fn();
        render(
            <Harness>
                <Tooltip content="Delete row">
                    <button type="button" onClick={onClick}>
                        Delete
                    </button>
                </Tooltip>
            </Harness>,
        );
        tap(screen.getByRole('button', { name: 'Delete' }));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('a badge inside a link does not open either, so the link still navigates', () => {
        render(
            <Harness>
                <a href="#row">
                    <Tooltip content="Last reviewed 3 days ago">
                        <span data-testid="badge-in-link">Reviewed</span>
                    </Tooltip>
                </a>
            </Harness>,
        );
        const badge = screen.getByTestId('badge-in-link');
        let defaultPrevented: boolean | null = null;
        badge.closest('a')!.addEventListener('click', (e) => {
            defaultPrevented = e.defaultPrevented;
        });
        tap(badge);
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(defaultPrevented).toBe(false);
    });

    it('`openOnTap` opts an action trigger in', () => {
        render(
            <Harness>
                <Tooltip content="Explained" openOnTap>
                    <button type="button">Why?</button>
                </Tooltip>
            </Harness>,
        );
        tap(screen.getByRole('button', { name: 'Why?' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Explained');
    });
});
