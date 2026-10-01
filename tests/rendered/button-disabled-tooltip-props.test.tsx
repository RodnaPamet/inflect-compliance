/** @jest-environment jsdom */

/**
 * #3065 — the `disabledTooltip` branch forwards the props it is given.
 *
 * That branch rendered a bare `<div>` with hand-written attributes and
 * never spread `props`, so everything passed alongside `disabledTooltip`
 * was silently dropped. The regression class is the nastiest kind: the
 * tooltip worked, the shape looked right, and a test written against a
 * forwarded `data-testid` failed as though the SELECTOR were wrong rather
 * than the prop having vanished.
 *
 * The fix is deliberately NOT a blanket spread, and half of this file
 * exists to hold that line. Two groups of props must still be dropped,
 * because forwarding them would break what the branch is for:
 *
 *   every `on*` handler — focusing this must EXPLAIN, never ACTIVATE;
 *   `disabled` — it removes the element from the tab order, which is the
 *     problem the branch was written to solve, not the solution.
 *
 * So the forwarding tests below are paired with locks proving the drops
 * survive. A fix that forwarded everything would pass the first two and
 * fail the rest.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { Button } from '@/components/ui/button';

/** The inert shell this branch renders (not a real <button>). */
function shell(): HTMLElement {
    return screen.getByRole('button');
}

describe('<Button disabledTooltip> — prop forwarding', () => {
    it('forwards data-* so the control is addressable by its testid', () => {
        render(
            <Button disabledTooltip="Connect a directory first" data-testid="sync-now">
                Sync now
            </Button>,
        );
        // Failed before the fix: the testid never reached the DOM, so this
        // threw "unable to find an element by: [data-testid=sync-now]".
        expect(screen.getByTestId('sync-now')).toBeInTheDocument();
    });

    it('forwards aria-label, which names the control when it has no content', () => {
        render(<Button disabledTooltip="No permission" aria-label="Delete" />);
        // With no children there is no label div, so `aria-labelledby` is
        // omitted and the forwarded `aria-label` is what gives this its
        // accessible name. Dropped, the name fell back to the contents
        // algorithm over an element whose only text is the REASON.
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('lets the branch own the a11y attributes a caller cannot be allowed to break', () => {
        render(
            <Button disabledTooltip="why" role="link" tabIndex={-1}>
                Save
            </Button>,
        );
        // Selected by ROLE, not by a forwarded id — so this test is
        // INDEPENDENT of the forwarding fix and passes before and after.
        // That independence is what lets it catch the opposite mistake: a
        // blanket spread would hand `role="link"` to the element and this
        // would fail.
        const el = shell();
        // Spread FIRST, hand-written attributes after — so these win.
        // `role="link"` would stop it announcing as the control it looks
        // like; `tabIndex={-1}` would take it back out of the tab order and
        // make the tooltip unopenable by keyboard, which is the whole point.
        expect(el.getAttribute('role')).toBe('button');
        expect(el.getAttribute('tabindex')).toBe('0');
        expect(el.getAttribute('aria-disabled')).toBe('true');
    });

    // ─── locks on the deliberate drops ──────────────────────────────────

    it('does NOT forward onClick — focusing explains, it never activates', () => {
        const onClick = jest.fn();
        render(
            <Button disabledTooltip="why" onClick={onClick}>
                Save
            </Button>,
        );
        // By ROLE, so this holds with or without the forwarding fix and
        // fails only if a fix forwards handlers it should not.
        fireEvent.click(shell());
        fireEvent.keyDown(shell(), { key: 'Enter' });
        // A control announced as `aria-disabled` must not run its action.
        expect(onClick).not.toHaveBeenCalled();
    });

    it('does NOT forward `disabled`, so the explanation stays tab-reachable', () => {
        render(
            <Button disabled disabledTooltip="why">
                Save
            </Button>,
        );
        const el = shell();
        // The real attribute would remove it from the tab order, and Radix
        // opens the tooltip on :focus-visible — so a keyboard user would
        // meet a dead shape with no reason attached. `aria-disabled`
        // announces the state instead.
        expect(el.hasAttribute('disabled')).toBe(false);
        expect(el.getAttribute('tabindex')).toBe('0');
    });

    it('still describes itself with the reason, forwarded props or not', () => {
        render(
            <Button disabledTooltip="Connect a directory first">
                Sync now
            </Button>,
        );
        const el = shell();
        const reasonId = el.getAttribute('aria-describedby');
        expect(reasonId).toBeTruthy();
        expect(document.getElementById(reasonId as string)?.textContent).toContain(
            'Connect a directory first',
        );
    });
});
