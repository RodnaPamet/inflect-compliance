/**
 * <Checkbox> — the edge IS the control.
 *
 * An unchecked checkbox is a box and nothing else, so its border is what
 * WCAG 2.1 1.4.11 (Non-text Contrast, 3:1) measures. It rode
 * `border-border-default`, which is 1.36:1 on the dark theme and 1.20:1 on
 * the light one — measured, not assumed; the figures live beside the tokens
 * in `src/styles/tokens.css`, and `tests/guardrails/token-contrast-content-brand.test.ts`
 * is what holds `--border-strong` to >= 3:1 in both themes.
 *
 * This suite is the other half: that the PRIMITIVE actually wears that
 * token. A token with no consumer passes its own contrast test and changes
 * nothing on screen.
 *
 * Hover is asserted too, and for the same reason: `border-border-emphasis`
 * is 2.44:1 dark / 1.59:1 light, so against a 3.5:1 rest edge it is a step
 * DOWN — hovering would have dropped the boundary back under the floor.
 */
import { render, screen } from "@testing-library/react";
import * as React from "react";

import { Checkbox } from "@/components/ui/checkbox";

describe("Checkbox control edge", () => {
    it("paints its rest edge on the AA control-edge token", () => {
        render(<Checkbox />);
        expect(screen.getByRole("checkbox").className).toContain(
            "border-border-strong",
        );
    });

    it("no longer carries the sub-3:1 edge it shipped with", () => {
        render(<Checkbox />);
        expect(screen.getByRole("checkbox").className).not.toContain(
            "border-border-default",
        );
    });

    it("hovers to a tone at least as visible as its rest edge", () => {
        render(<Checkbox />);
        const cls = screen.getByRole("checkbox").className;
        expect(cls).toContain("hover:border-brand-emphasis");
        expect(cls).not.toContain("hover:border-border-emphasis");
    });

    it("keeps the edge on every size rung", () => {
        const { container } = render(
            <>
                <Checkbox size="sm" />
                <Checkbox size="md" />
                <Checkbox size="lg" />
            </>,
        );
        const boxes = Array.from(
            container.querySelectorAll('[role="checkbox"]'),
        );
        expect(boxes).toHaveLength(3);
        for (const box of boxes) {
            expect(box.className).toContain("border-border-strong");
        }
    });

    it("still hands the error edge to an invalid checkbox", () => {
        // The invalid variant is a data-attribute branch, so a rest-edge
        // change must not have displaced it.
        render(<Checkbox invalid />);
        const box = screen.getByRole("checkbox");
        expect(box).toHaveAttribute("data-invalid", "");
        expect(box.className).toContain("data-[invalid]:border-border-error");
    });
});
