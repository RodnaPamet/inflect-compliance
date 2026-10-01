/**
 * <RadioGroupItem> — the ring IS the control.
 *
 * Same defect and same fix as Checkbox: an unselected radio is a ring and
 * nothing else, and `border-border-default` measures 1.36:1 dark / 1.20:1
 * light against WCAG 2.1 1.4.11's 3:1 floor. `--border-strong` reaches it
 * (3.50 / 3.51); the token's own contrast is held by
 * `tests/guardrails/token-contrast-content-brand.test.ts`, and what this
 * suite holds is that the primitive wears it.
 *
 * Checkbox and radio are asserted separately on purpose — they are two
 * files with two cva recipes, and fixing one has twice left the other
 * behind.
 */
import { render, screen } from "@testing-library/react";
import * as React from "react";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

function renderGroup(node: React.ReactNode) {
    return render(<RadioGroup>{node}</RadioGroup>);
}

describe("RadioGroupItem control edge", () => {
    it("paints its rest ring on the AA control-edge token", () => {
        renderGroup(<RadioGroupItem value="a" />);
        expect(screen.getByRole("radio").className).toContain(
            "border-border-strong",
        );
    });

    it("no longer carries the sub-3:1 edge it shipped with", () => {
        renderGroup(<RadioGroupItem value="a" />);
        expect(screen.getByRole("radio").className).not.toContain(
            "border-border-default",
        );
    });

    it("hovers to a tone at least as visible as its rest ring", () => {
        renderGroup(<RadioGroupItem value="a" />);
        const cls = screen.getByRole("radio").className;
        expect(cls).toContain("hover:border-brand-emphasis");
        expect(cls).not.toContain("hover:border-border-emphasis");
    });

    it("keeps the ring on every size rung", () => {
        const { container } = renderGroup(
            <>
                <RadioGroupItem value="a" size="sm" />
                <RadioGroupItem value="b" size="md" />
                <RadioGroupItem value="c" size="lg" />
            </>,
        );
        const radios = Array.from(container.querySelectorAll('[role="radio"]'));
        expect(radios).toHaveLength(3);
        for (const radio of radios) {
            expect(radio.className).toContain("border-border-strong");
        }
    });

    it("still hands the error edge to an invalid item", () => {
        renderGroup(<RadioGroupItem value="a" invalid />);
        const radio = screen.getByRole("radio");
        expect(radio).toHaveAttribute("data-invalid", "");
        expect(radio.className).toContain("data-[invalid]:border-border-error");
    });

    it("selected still reads as the brand edge, not the rest edge", () => {
        renderGroup(<RadioGroupItem value="a" />);
        expect(screen.getByRole("radio").className).toContain(
            "data-[state=checked]:border-brand-emphasis",
        );
    });
});
