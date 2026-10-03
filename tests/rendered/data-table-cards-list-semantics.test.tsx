/**
 * `DataTableCards` list semantics (#3129).
 *
 * The card list's container is `role="list"`, and ARIA says a `list` may only
 * contain `listitem` children. It DID contain buttons: with `onRowClick` set,
 * each card took `role="button"` from `buttonLikeKeys` instead of
 * `role="listitem"`, so axe reported `aria-required-children` at impact
 * CRITICAL — measured by projectZ against a byte-identical vendored copy on two
 * real pages at 393px, in light and dark alike.
 *
 * The fix wraps a clickable card in a chrome-free `role="listitem"` div and
 * moves no classes and no handlers: the card itself is still the button, still
 * the whole hit area, still the hover affordance and the focus ring. A
 * read-only card is unchanged — it already WAS the list item.
 *
 * ── WHY THIS TEST IS SHAPED THE WAY IT IS ───────────────────────────────────
 *
 * "No card is a `button` inside a `list`" passes trivially in three worlds that
 * are not the fixed one: a container that stopped being a `list`, cards that
 * stopped rendering, and `onRowClick` that was never wired. All three are worse
 * than the bug. So every negative assertion here is paired with an existence
 * one — the container's role is read, the child count is checked against the row
 * count, and the clickable branch proves the button both exists and activates.
 *
 * Both branches are covered because the roles DIFFER between them and only one
 * was broken: the read-only branch is the positive control that says this suite
 * can tell a `listitem` from a `button` at all.
 *
 * The keyboard contract is re-proved here rather than cited, because moving a
 * role is exactly the kind of edit that silently drops it. The fuller keyboard
 * surface (ignored keys, pointer click, the read-only tab order) lives in
 * `tests/rendered/data-table-mobile-fallback.test.tsx`.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import * as React from "react";

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
    { id: "r1", name: "Alpha", status: "OPEN" },
    { id: "r2", name: "Beta", status: "CLOSED" },
    { id: "r3", name: "Gamma", status: "OPEN" },
];

function renderCards(
    onRowClick?: (row: { id: string }, e: React.MouseEvent) => void,
) {
    mockBelowMd = true;
    render(
        <DataTable<Row>
            data={data}
            columns={columns}
            getRowId={(r) => r.id}
            onRowClick={onRowClick}
        />,
    );
    return screen.getByTestId("data-table-cards");
}

/** The roles the `list` actually exposes to AT, in DOM order. */
function directChildRoles(list: HTMLElement): (string | null)[] {
    return Array.from(list.children).map((el) => el.getAttribute("role"));
}

beforeEach(() => {
    mockBelowMd = false;
});

describe("DataTableCards list semantics (#3129)", () => {
    it("renders a list at all — the control every child assertion needs", () => {
        // Without this, "no child of the list is a button" would also hold for a
        // container that quietly stopped being a list, which is the cheap fix
        // this test exists to refuse.
        const cards = renderCards(() => {});
        expect(cards).toHaveAttribute("role", "list");
    });

    it("renders one card per row — so an empty list cannot pass", () => {
        const cards = renderCards(() => {});
        expect(cards.children).toHaveLength(data.length);
        expect(data.length).toBeGreaterThan(0);
    });

    it("clickable: every DIRECT CHILD of the list is a listitem, none a button", () => {
        // The defect, stated as the invariant ARIA actually checks.
        const cards = renderCards(() => {});

        expect(directChildRoles(cards)).toEqual(data.map(() => "listitem"));
        expect(directChildRoles(cards)).not.toContain("button");
    });

    it("clickable: the list still REPORTS its items, one per row", () => {
        // `aria-required-children` is about what the list announces. A wrapper
        // that existed but carried no role would satisfy the negative above and
        // still leave "list, 0 items".
        const cards = renderCards(() => {});
        expect(within(cards).getAllByRole("listitem")).toHaveLength(data.length);
    });

    it("clickable: the card is STILL a button, and it lives inside a listitem", () => {
        // The other half of the fix: the role moved outward onto a wrapper, it
        // was not deleted. A screen-reader user must still be told the row is
        // actionable.
        const cards = renderCards(() => {});

        const buttons = within(cards).getAllByRole("button");
        expect(buttons).toHaveLength(data.length);
        for (const button of buttons) {
            const item = button.closest('[role="listitem"]');
            expect(item).not.toBeNull();
            // And that listitem is the list's own child, so the button is
            // inside the list rather than having been moved out of it.
            expect(item!.parentElement).toBe(cards);
        }
    });

    it("clickable: the wrapper is chrome-free, so the CARD is still the hit area", () => {
        // What makes "no classes moved" checkable. If the wrapper ever grows
        // padding or a border, the card stops being the full-size click target
        // and the 44px tap floor below stops meaning what it says.
        const cards = renderCards(() => {});

        for (const item of within(cards).getAllByRole("listitem")) {
            expect(item.getAttribute("class")).toBeNull();
            expect(item.children).toHaveLength(1);
            expect(item.firstElementChild).toHaveAttribute("role", "button");
        }
    });

    it("clickable: the card keeps its tap floor, hover affordance and focus ring", () => {
        const cards = renderCards(() => {});
        const button = within(cards).getAllByRole("button")[0];

        expect(button).toHaveClass("min-h-11");
        expect(button).toHaveClass("cursor-pointer");
        expect(button).toHaveClass("focus-visible:ring-2");
    });

    it("clickable: the card is still reachable by keyboard and activates on Enter", () => {
        const onRowClick = jest.fn();
        const cards = renderCards(onRowClick);
        const button = within(cards).getAllByRole("button")[1];

        expect(button).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(button, { key: "Enter" });

        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe("r2");
    });

    it("clickable: and on Space, swallowing the page scroll", () => {
        const onRowClick = jest.fn();
        const cards = renderCards(onRowClick);

        const event = new KeyboardEvent("keydown", {
            key: " ",
            bubbles: true,
            cancelable: true,
        });
        within(cards).getAllByRole("button")[2].dispatchEvent(event);

        expect(onRowClick).toHaveBeenCalledTimes(1);
        expect(onRowClick.mock.calls[0][0].id).toBe("r3");
        expect(event.defaultPrevented).toBe(true);
    });

    it("read-only: the card IS the listitem, and nothing claims to be a button", () => {
        // The positive control for every assertion above: the roles differ
        // between the two branches, and only the clickable one was broken. A
        // suite that could not tell these apart would pass the negatives while
        // saying nothing.
        const cards = renderCards();

        expect(directChildRoles(cards)).toEqual(data.map(() => "listitem"));
        expect(within(cards).getAllByRole("listitem")).toHaveLength(data.length);
        expect(within(cards).queryAllByRole("button")).toHaveLength(0);

        for (const item of within(cards).getAllByRole("listitem")) {
            // No wrapper in this branch — the list item carries the card's own
            // chrome, and it is not in the tab order.
            expect(item.getAttribute("class")).toContain("flex");
            expect(item).not.toHaveAttribute("tabindex");
        }
    });
});
