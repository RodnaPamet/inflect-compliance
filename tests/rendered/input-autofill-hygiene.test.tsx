/**
 * <Input> — the attributes a correctly-typed field should not have to spell.
 *
 * Three regression classes, all of them SILENT. Nothing errors, nothing
 * looks broken in review, and nobody who builds the app ever meets them:
 *
 *   • `autoComplete` is how a password manager IDENTIFIES a field. Without
 *     it the browser offers nothing, and the user with a 40-character
 *     generated secret in their manager cannot sign in.
 *   • `enterKeyHint` is the bottom-right key on a phone keyboard. Unset, it
 *     reads "return" and the user does not press it.
 *   • A search box capitalises and spellchecks by default, so a lowercase
 *     term is sent capitalised with a red squiggle under a name that is
 *     spelled correctly.
 *
 * The fourth case is not silent at all, it is just invisible to a mouse:
 * the password reveal toggle carried `tabIndex={-1}` (unreachable by
 * keyboard) and lifted its `opacity-0` on `group-hover` from a wrapper that
 * had no `group` class — so on a password field WITH an error the toggle
 * could be neither seen nor reached.
 *
 * Every assertion below reads the rendered DOM, so it fails on the defect
 * rather than on a spelling.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";

import { Input } from "@/components/ui/input";

function inputEl(container: HTMLElement): HTMLInputElement {
    const el = container.querySelector("input");
    if (!el) throw new Error("no input rendered");
    return el as HTMLInputElement;
}

describe("Input autofill + keyboard-hint derivation", () => {
    it.each([
        ["email", "email"],
        ["tel", "tel"],
        ["url", "url"],
    ])("type=%s derives autoComplete=%s", (type, expected) => {
        const { container } = render(<Input type={type} />);
        expect(inputEl(container).getAttribute("autocomplete")).toBe(expected);
    });

    it.each([["password"], ["text"], ["search"], ["number"]])(
        "type=%s derives NO autoComplete",
        (type) => {
            const { container } = render(<Input type={type} />);
            expect(inputEl(container).getAttribute("autocomplete")).toBeNull();
        },
    );

    it("a secret field gets no guessed autoComplete even beside a mapped one", () => {
        // `current-password` and `new-password` are the same input type, so a
        // default would be right half the time — and the wrong half fills a
        // stale secret into a "choose a new one" box. The caller decides.
        const { container } = render(
            <>
                <Input type="email" />
                <Input type="password" />
            </>,
        );
        const [email, secret] = Array.from(container.querySelectorAll("input"));
        expect(email?.getAttribute("autocomplete")).toBe("email");
        expect(secret?.getAttribute("autocomplete")).toBeNull();
    });

    it("an explicit autoComplete overrides the derived one", () => {
        const { container } = render(
            <Input type="email" autoComplete="username" />,
        );
        expect(inputEl(container).getAttribute("autocomplete")).toBe("username");
    });

    it.each([
        ["search", "search"],
        ["email", "next"],
        ["tel", "next"],
        ["url", "go"],
    ])("type=%s derives enterKeyHint=%s", (type, expected) => {
        const { container } = render(<Input type={type} />);
        expect(inputEl(container).getAttribute("enterkeyhint")).toBe(expected);
    });

    it("an unmapped type carries no enterKeyHint, and an explicit one wins", () => {
        const plain = render(<Input type="text" />);
        expect(inputEl(plain.container).getAttribute("enterkeyhint")).toBeNull();
        plain.unmount();

        const explicit = render(<Input type="search" enterKeyHint="done" />);
        expect(inputEl(explicit.container).getAttribute("enterkeyhint")).toBe(
            "done",
        );
    });

    it("a search field neither capitalises nor spellchecks", () => {
        const { container } = render(<Input type="search" />);
        const el = inputEl(container);
        expect(el.getAttribute("autocapitalize")).toBe("none");
        expect(el.getAttribute("spellcheck")).toBe("false");
    });

    it("a non-search field is left alone on both channels", () => {
        const { container } = render(<Input type="text" />);
        const el = inputEl(container);
        expect(el.getAttribute("autocapitalize")).toBeNull();
        expect(el.getAttribute("spellcheck")).toBeNull();
    });

    it("explicit autoCapitalize / spellCheck beat the search defaults", () => {
        const { container } = render(
            <Input type="search" autoCapitalize="sentences" spellCheck />,
        );
        const el = inputEl(container);
        expect(el.getAttribute("autocapitalize")).toBe("sentences");
        expect(el.getAttribute("spellcheck")).toBe("true");
    });
});

describe("Input password toggle — reachable, labelled, and visible", () => {
    const toggleOf = () => screen.getByRole("button", { name: /password/i });

    it("is reachable by Tab, which `tabIndex={-1}` prevented", async () => {
        const user = userEvent.setup();
        const { container } = render(<Input type="password" />);

        await user.tab();
        expect(document.activeElement).toBe(inputEl(container));
        await user.tab();
        expect(document.activeElement).toBe(toggleOf());
    });

    it("reveals the value when activated from the keyboard", async () => {
        const user = userEvent.setup();
        const { container } = render(<Input type="password" />);

        expect(inputEl(container).type).toBe("password");
        await user.tab();
        await user.tab();
        await user.keyboard("{Enter}");
        expect(inputEl(container).type).toBe("text");
    });

    it("reports its state through aria-pressed, not just its label", () => {
        render(<Input type="password" />);
        expect(toggleOf()).toHaveAttribute("aria-pressed", "false");
    });

    it("flips aria-pressed and its accessible name together", async () => {
        const user = userEvent.setup();
        render(<Input type="password" />);

        expect(toggleOf()).toHaveAccessibleName("Show password");
        await user.click(toggleOf());
        expect(toggleOf()).toHaveAttribute("aria-pressed", "true");
        expect(toggleOf()).toHaveAccessibleName("Hide password");
    });

    it("sits inside a `group` ancestor, so its hover variants can apply", () => {
        // The defect: the toggle is `opacity-0` on an errored password field
        // and lifts on `group-hover`, but the wrapper carried no `group`, so
        // the variant could never match and the control stayed invisible.
        render(<Input type="password" error="Too short" />);
        const toggle = toggleOf();
        const wrapper = toggle.parentElement;

        expect(wrapper).not.toBeNull();
        expect(wrapper?.classList.contains("group")).toBe(true);
        expect(toggle.className).toContain("group-hover:opacity-100");
    });

    it("also lifts on focus-visible, which a Tab user is the only one to reach", () => {
        // Hover is not available from a keyboard, so `group-hover` alone
        // would hand focus to a control nobody can see.
        render(<Input type="password" error="Too short" />);
        expect(toggleOf().className).toContain("focus-visible:opacity-100");
    });

    it("renders no toggle for a non-password field", () => {
        render(<Input type="text" />);
        expect(
            screen.queryByRole("button", { name: /password/i }),
        ).toBeNull();
    });
});
