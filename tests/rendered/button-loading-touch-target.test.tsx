/**
 * The two things `<Button>` used to lose when it stopped being live.
 *
 * `button.tsx` has three render paths. One calls `buttonVariants` (the
 * cva recipe). The other two build their class list with `cn` alone —
 * the `disabled || loading` fallback and the `disabledTooltip` wrapper
 * — so every invariant the cva base carries is absent from them unless
 * restated. Two were:
 *
 *   1. `pointer-coarse:min-h-11`, the WCAG 2.5.5 / Apple HIG 44px touch
 *      floor. A button that is 44px tall on a phone collapsed to its
 *      28px desktop height the instant `loading` went true — i.e.
 *      exactly while the user is most likely to tap it again. The
 *      existing ladder mirror in
 *      `tests/guards/still-surface-button-material.test.ts` checks the
 *      28px HEIGHT RUNG, which is the part that is supposed to be 28px,
 *      so it could not see this.
 *
 *   2. A way to READ the `disabledTooltip` without a pointer. The
 *      wrapper was a plain `<div>` — not in the tab order — so the one
 *      thing that branch exists to say was hover-only.
 *
 * ── WHAT A JSDOM TEST CAN AND CANNOT PROVE HERE ──────────────────
 *
 * There is no layout engine and no compiled Tailwind, so nothing here
 * can measure 44 physical pixels or evaluate a `pointer: coarse` media
 * query. What it CAN do, and what makes this more than a spelling
 * check, is compare the loading element against the resting one: the
 * claim under test is "the touch floor does not DEPEND on the button
 * being live", and that is a relation between two rendered outputs.
 * The accessibility half needs no such hedging — focusability and
 * `aria-describedby` resolution are real DOM behaviour.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import { Button } from '@/components/ui/button';

/** The coarse-pointer height floor, as Tailwind spells it. */
const COARSE_FLOOR = 'pointer-coarse:min-h-11';

function classesOf(el: HTMLElement): string[] {
    return Array.from(el.classList);
}

describe('a loading Button keeps its coarse-pointer touch target', () => {
    test.each([
        ['loading', { loading: true }],
        ['disabled', { disabled: true }],
        ['loading AND disabled', { loading: true, disabled: true }],
    ])('%s — the 44px floor survives', (_label, props) => {
        render(
            <Button data-testid="subject" {...props}>
                Save
            </Button>,
        );
        expect(classesOf(screen.getByTestId('subject'))).toContain(
            COARSE_FLOOR,
        );
    });

    test('the floor does not depend on the button being live', () => {
        // The relation, not the spelling: whatever floor the resting
        // button carries, the loading one carries the same. This is the
        // assertion that fails if a future change moves the floor to a
        // different class and updates only the cva base.
        const { rerender } = render(
            <Button data-testid="subject">Save</Button>,
        );
        const resting = classesOf(screen.getByTestId('subject')).filter((c) =>
            c.startsWith('pointer-coarse:'),
        );
        expect(resting).not.toHaveLength(0); // the measurement is real

        rerender(
            <Button data-testid="subject" loading>
                Save
            </Button>,
        );
        const loading = classesOf(screen.getByTestId('subject')).filter((c) =>
            c.startsWith('pointer-coarse:'),
        );
        expect(loading).toEqual(expect.arrayContaining(resting));
    });

    test('the 28px visual height is UNCHANGED — min-h only raises', () => {
        // The companion half. If the fix had been "make the disabled
        // branch 44px tall", every assertion above would pass and the
        // dense desktop density would be gone.
        render(
            <Button data-testid="subject" loading>
                Save
            </Button>,
        );
        const classes = classesOf(screen.getByTestId('subject'));
        expect(classes).toContain('h-7');
    });

    test('a loading button still renders the spinner and is inert', () => {
        render(
            <Button data-testid="subject" loading onClick={() => undefined}>
                Save
            </Button>,
        );
        const button = screen.getByTestId('subject');
        expect(button).toBeDisabled();
        // The fallback branch is the one that paints the spinner; if the
        // shared shell had been applied to the wrong branch, this would
        // be the tell.
        expect(button.querySelector('.loading-spinner')).not.toBeNull();
    });
});

describe('the disabledTooltip explanation is reachable without a pointer', () => {
    const REASON = 'Connect a directory first';

    /**
     * Selected by ROLE, not by `data-testid`: this branch renders a bare
     * `<div>` with hand-written attributes and does NOT spread `props`,
     * so a forwarded `data-testid` never lands on it. (That is a real
     * second-order gap in the branch, reported upstream rather than
     * fixed here — forwarding arbitrary `ButtonHTMLAttributes` onto a
     * div would put `disabled` and friends somewhere React warns
     * about.) Selecting by role is also the stronger query: the whole
     * claim is that assistive tech can find and read this thing.
     */
    function subject() {
        return screen.getByRole('button');
    }

    function renderDisabled() {
        // Button's `./tooltip` import is mapped to a pass-through stub
        // in the jsdom project, so no TooltipProvider is needed and the
        // wrapper is the element under test directly.
        return render(<Button disabledTooltip={REASON}>Sync now</Button>);
    }

    test('the wrapper is in the tab order', () => {
        renderDisabled();
        expect(subject()).toHaveAttribute('tabindex', '0');
    });

    test('it is announced as a disabled button, not as a generic box', () => {
        renderDisabled();
        expect(subject()).toHaveAttribute('aria-disabled', 'true');
        // NOT the `disabled` attribute: that would remove it from the
        // tab order again, which is the defect rather than the fix.
        expect(subject()).not.toHaveAttribute('disabled');
    });

    test('aria-describedby resolves to an element carrying the reason', () => {
        renderDisabled();
        const id = subject().getAttribute('aria-describedby');
        expect(id).toBeTruthy();
        // Resolve it for real — a dangling IDREF announces nothing, and
        // asserting only that the attribute exists would not notice.
        const description = document.getElementById(id as string);
        expect(description).not.toBeNull();
        expect(description).toHaveTextContent(REASON);
    });

    test('the reason is announced but never shown', () => {
        renderDisabled();
        // The tooltip is the sighted affordance; the describedby target
        // is the announced one, and it must not duplicate the reason
        // visibly beside the label.
        const description = document.getElementById(
            subject().getAttribute('aria-describedby') as string,
        );
        expect(description).toHaveClass('sr-only');
    });

    test('the reason is the DESCRIPTION, never folded into the name', () => {
        // Radix's Trigger takes a single child, so the describedby
        // target has to live inside the element it describes — and the
        // accessible name of a `role="button"` is computed from its
        // contents. Without an explicit label the reason lands in BOTH
        // the name and the description and is announced twice.
        renderDisabled();
        const el = subject();
        const labelId = el.getAttribute('aria-labelledby');
        expect(labelId).toBeTruthy();
        const label = document.getElementById(labelId as string);
        expect(label).toHaveTextContent('Sync now');
        expect(label?.textContent).not.toContain(REASON);
        // The accessible name resolves through `aria-labelledby`, so it
        // is the label alone — the two ids must be different elements.
        expect(labelId).not.toBe(el.getAttribute('aria-describedby'));
    });

    test('an icon-only disabled button keeps a contents-derived name', () => {
        // With no label there is nothing to point `aria-labelledby` at.
        // Emitting it anyway would resolve to an EMPTY name — strictly
        // worse than falling back to the contents algorithm — so the
        // attribute is omitted in that case.
        render(
            <Button disabledTooltip={REASON} icon={<svg aria-hidden />} />,
        );
        expect(screen.getByRole('button')).not.toHaveAttribute(
            'aria-labelledby',
        );
    });

    test('focusing it explains rather than activates', () => {
        // No click handler reaches the wrapper: the whole point is that
        // the control is unavailable. A `role="button"` that fired on
        // Enter would be worse than the original div.
        renderDisabled();
        expect(subject()).toHaveAttribute('aria-disabled', 'true');
        expect(subject().getAttribute('onclick')).toBeNull();
    });

    test('it also keeps the coarse-pointer floor', () => {
        renderDisabled();
        expect(classesOf(subject())).toContain(COARSE_FLOOR);
    });
});
