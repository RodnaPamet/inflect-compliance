/**
 * `mobileFallback` and the keyboard-operable card — the phone contract.
 *
 * Two things are pinned here, and they fail in opposite directions.
 *
 * ── 1. The DEFAULT is the safe one ──────────────────────────────────────────
 *
 * An eight-column table at 390px does not fit, will not wrap, and pushes the
 * whole PAGE sideways. `mobileFallback` defaults to `'card'` so that collapse
 * happens with no opt-in; `'scroll'` is an ESCAPE HATCH for a table that is
 * genuinely desktop-only. A regression here is silent — the table still
 * renders, it just takes the document with it — so the assertion that matters
 * is that OMITTING the prop collapses, not that passing `'card'` does.
 *
 * The wrapper's `min-w-0 max-w-full` belongs to the same failure: a child with
 * `overflow-x-auto` still expands its parent unless the parent is allowed to
 * be narrower than its content, and before hydration (`useIsBelowMd` resolves
 * false on the server) the desktop table is what a phone first paints. jsdom
 * does no layout, so the classes are asserted on the element rather than the
 * drift being measured — the measurement lives in the upstream mobile-drift
 * ratchet, and 484px at a 393px viewport is what it caught.
 *
 * ── 2. A clickable card was not operable at all ─────────────────────────────
 *
 * It was a bare `<div>` with `onClick`: no role, no tabIndex, no key handler.
 * A keyboard user could not reach the row and a screen-reader user was never
 * told it was actionable, so the whole mobile list was unusable for them —
 * silently, because the pointer path worked fine.
 */
/** @jest-environment jsdom */

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

let mockBelowMd = false;
jest.mock("@/components/ui/table/use-is-below-md", () => ({
    useIsBelowMd: () => mockBelowMd,
}));

import { DataTable, createColumns } from "@/components/ui/table";

interface Row {
    id: string;
    name: string;
    status: string;
}

const columns = createColumns<Row>([
    { id: "name", header: "Name", accessorKey: "name" },
    { id: "status", header: "Status", accessorKey: "status" },
]);

const data: Row[] = [
    { id: "r1", name: "First", status: "OPEN" },
    { id: "r2", name: "Second", status: "CLOSED" },
];

function renderTable(
    props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {},
) {
    return render(
        <DataTable<Row>
            data={data}
            columns={columns}
            getRowId={(r) => r.id}
            {...props}
        />,
    );
}

beforeEach(() => {
    mockBelowMd = false;
});

describe("DataTable — mobileFallback", () => {
    it("collapses to cards on a phone when the prop is OMITTED", () => {
        // The default, exercised by its absence. Passing `'card'` explicitly
        // would prove the branch reads the prop; this proves the DEFAULT is
        // the collapsing one, which is the decision the prop exists to make
        // visible.
        mockBelowMd = true;
        renderTable();

        expect(screen.getByTestId("data-table-cards")).toBeInTheDocument();
        expect(screen.queryByRole("table")).toBeNull();
    });

    it('keeps the scrolling table on a phone for mobileFallback="scroll"', () => {
        mockBelowMd = true;
        renderTable({ mobileFallback: "scroll" });

        expect(screen.queryByTestId("data-table-cards")).toBeNull();
        expect(screen.getByRole("table")).toBeInTheDocument();
    });

    it('renders the table on desktop whatever the fallback says', () => {
        // The prop is about the phone only; a `'card'` must not leak into the
        // desktop rendering.
        renderTable({ mobileFallback: "card" });

        expect(screen.queryByTestId("data-table-cards")).toBeNull();
        expect(screen.getByRole("table")).toBeInTheDocument();
    });

    it("lets the wrapper be narrower than its content, so the PAGE cannot drift", () => {
        // `min-w-0 max-w-full` is what makes the table's own `overflow-x-auto`
        // actually work. Without them the wrapper grows to fit the table, the
        // wrapper pushes the page, and the document scrolls sideways while the
        // table's scroll container sits there with nothing left to scroll.
        renderTable({ "data-testid": "wrapped" });

        const wrapper = screen.getByTestId("wrapped");
        expect(wrapper).toHaveClass("min-w-0");
        expect(wrapper).toHaveClass("max-w-full");
    });

    it("keeps those classes on the card branch too", () => {
        mockBelowMd = true;
        renderTable({ "data-testid": "wrapped" });

        const wrapper = screen.getByTestId("wrapped");
        expect(wrapper).toHaveClass("min-w-0");
        expect(wrapper).toHaveClass("max-w-full");
    });
});

describe("DataTableCards — a clickable card is operable by keyboard", () => {
    const clickableCards = () => {
        const onRowClick = jest.fn();
        mockBelowMd = true;
        renderTable({ onRowClick });
        const cards = screen.getByTestId("data-table-cards");
        return { onRowClick, cards };
    };

    it("announces a clickable card as a button and puts it in the tab order", () => {
        const { cards } = clickableCards();

        const buttons = within(cards).getAllByRole("button");
        expect(buttons).toHaveLength(data.length);
        for (const button of buttons) {
            expect(button).toHaveAttribute("tabindex", "0");
        }
    });

    it("leaves a read-only card as a plain list item, out of the tab order", () => {
        // The other half of the contract: a card with nothing to activate
        // must NOT claim to be a button, or a screen-reader user is promised
        // an action that does not exist.
        mockBelowMd = true;
        renderTable();
        const cards = screen.getByTestId("data-table-cards");

        expect(within(cards).getAllByRole("listitem")).toHaveLength(data.length);
        expect(within(cards).queryAllByRole("button")).toHaveLength(0);
        for (const item of within(cards).getAllByRole("listitem")) {
            expect(item).not.toHaveAttribute("tabindex");
        }
    });

    it("activates the row on Enter", () => {
        const { onRowClick, cards } = clickableCards();

        fireEvent.keyDown(within(cards).getAllByRole("button")[0], {
            key: "Enter",
        });

        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe("r1");
    });

    it("activates the row on Space, and swallows the page scroll", () => {
        // Space is the key people forget, and it is the one most users press
        // on something announced as a button. Without `preventDefault()` the
        // list scrolls out from under the user instead of opening the row —
        // which is worse than a row that does nothing, because it looks like
        // the tap went somewhere.
        const { onRowClick, cards } = clickableCards();

        const event = new KeyboardEvent("keydown", {
            key: " ",
            bubbles: true,
            cancelable: true,
        });
        within(cards).getAllByRole("button")[1].dispatchEvent(event);

        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe("r2");
        expect(event.defaultPrevented).toBe(true);
    });

    it("ignores keys that are not Enter or Space", () => {
        // A card that fired on every keystroke would make arrow-key scrolling
        // open rows at random.
        const { onRowClick, cards } = clickableCards();
        const button = within(cards).getAllByRole("button")[0];

        for (const key of ["a", "Tab", "ArrowDown", "Escape"]) {
            fireEvent.keyDown(button, { key });
        }

        expect(onRowClick).not.toHaveBeenCalled();
    });

    it("still activates on a pointer click", () => {
        // The keyboard work must not have displaced the path that already
        // worked.
        const { onRowClick, cards } = clickableCards();

        fireEvent.click(within(cards).getAllByRole("button")[0]);

        expect(onRowClick).toHaveBeenCalledTimes(1);
    });

    it("gives the card a 44px tap floor and a visible focus ring", () => {
        // Below 44px a tap lands between rows as often as on one, and the
        // miss scrolls the list. The focus ring is the keyboard half of the
        // same affordance: a reachable row that shows nothing when focused is
        // reachable in name only.
        const { cards } = clickableCards();
        const button = within(cards).getAllByRole("button")[0];

        expect(button).toHaveClass("min-h-11");
        expect(button).toHaveClass("focus-visible:ring-2");
    });

    it("renders a decorative trailing chevron so the row reads as actionable", () => {
        // Without it a card looks like a read-only summary and the user never
        // discovers the row opens. It is decoration: hidden from AT, and
        // `pointer-events-none` so it cannot swallow the tap it advertises.
        const { cards } = clickableCards();
        const button = within(cards).getAllByRole("button")[0];

        const chevron = button.querySelector("svg[aria-hidden='true']");
        expect(chevron).toBeTruthy();
        expect(chevron).toHaveClass("pointer-events-none");
    });

    it("renders no chevron on a read-only card", () => {
        // The positive control for the assertion above: a detector that found
        // a chevron on every card would pass it without telling us anything.
        mockBelowMd = true;
        renderTable();
        const cards = screen.getByTestId("data-table-cards");

        expect(cards.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(0);
    });
});
