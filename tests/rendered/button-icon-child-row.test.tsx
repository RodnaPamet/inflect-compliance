/** @jest-environment jsdom */

/**
 * Behavioural (Tier-2) test — icon-as-child renders on the SAME ROW.
 *
 * Buttons that pass an icon as a CHILD (e.g. a brand `<svg>`, or
 * `<Button><Mail/>Invite by email</Button>`) used to stack the icon
 * ABOVE the text: the icon lands in the label div, and Tailwind's
 * preflight makes `svg { display: block }`, so the block svg took its
 * own row. The Button primitive now forces direct svg children inline
 * in the label div.
 *
 * jsdom has no layout engine, so we lock the mechanism structurally:
 * the label wrapper holding the children carries the
 * `[&>svg]:inline-block` rule (which flips the svg off `display:block`),
 * and a child `<svg>` lands inside that wrapper next to the text.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import { Button } from '@/components/ui/button';

describe('<Button> icon-as-child — same-row layout', () => {
    it('wraps child content in a label div that forces svg children inline', () => {
        const { container } = render(
            <Button>
                <svg data-testid="brand" viewBox="0 0 24 24" />
                Continue with Google
            </Button>,
        );
        const svg = container.querySelector('svg[data-testid="brand"]')!;
        const wrapper = svg.parentElement!;
        expect(wrapper.className).toContain('[&>svg]:inline-block');
        expect(wrapper.className).toContain('[&>svg]:align-middle');
        // Text is a sibling of the svg in the same wrapper (one unit).
        expect(wrapper.textContent).toContain('Continue with Google');
    });

    it('applies the same rule on the disabled-tooltip render path', () => {
        const { container } = render(
            <Button disabled disabledTooltip="nope">
                <svg data-testid="brand2" viewBox="0 0 24 24" />
                Save
            </Button>,
        );
        const svg = container.querySelector('svg[data-testid="brand2"]')!;
        expect(svg.parentElement!.className).toContain('[&>svg]:inline-block');
    });
});
