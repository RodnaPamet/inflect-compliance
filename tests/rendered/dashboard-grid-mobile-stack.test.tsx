/**
 * Mobile PR-4 — `<DashboardGrid>` renders a single-column vertical STACK below
 * `md` instead of the 12-column react-grid-layout drag grid (unusable on a
 * phone). Gated by `useIsBelowMd`, which is `false` under jsdom → the desktop
 * grid is the default in tests (every existing DashboardGrid test is
 * unaffected). Forcing the hook to `true` exercises the stacked branch.
 */
import { render, screen } from "@testing-library/react";
import * as React from "react";

let mockBelowMd = false;
jest.mock("@inflect/ui/components/ui/hooks/use-is-below-md", () => ({
    useIsBelowMd: () => mockBelowMd,
}));

import {
    DashboardGrid,
    type DashboardGridWidget,
} from "@/components/ui/dashboard-widgets/DashboardGrid";

const widgets: DashboardGridWidget[] = [
    { id: "a", position: { x: 0, y: 1 }, size: { w: 6, h: 2 } },
    { id: "b", position: { x: 0, y: 0 }, size: { w: 6, h: 2 } }, // y=0 → first when stacked
];

const renderWidget = (w: DashboardGridWidget) => (
    <div data-testid={`content-${w.id}`}>{w.id}</div>
);

beforeEach(() => {
    mockBelowMd = false;
});

describe("DashboardGrid responsive rendering", () => {
    it("desktop (default): renders the grid, not the stack", () => {
        const { container } = render(
            <DashboardGrid widgets={widgets} renderWidget={renderWidget} />,
        );
        expect(container.querySelector("[data-dashboard-stacked]")).toBeNull();
        expect(screen.getByTestId("content-a")).toBeInTheDocument();
        expect(screen.getByTestId("content-b")).toBeInTheDocument();
    });

    it("phone: renders a vertical stack (no drag grid), widgets in layout order", () => {
        mockBelowMd = true;
        const { container } = render(
            <DashboardGrid widgets={widgets} renderWidget={renderWidget} />,
        );
        const stack = container.querySelector("[data-dashboard-stacked]");
        expect(stack).not.toBeNull();
        expect(screen.getByTestId("content-a")).toBeInTheDocument();
        expect(screen.getByTestId("content-b")).toBeInTheDocument();
        // Stacked in reading order (sorted by y then x): b (y=0) before a (y=1).
        const ids = Array.from(
            stack!.querySelectorAll("[data-widget-id]"),
        ).map((el) => el.getAttribute("data-widget-id"));
        expect(ids).toEqual(["b", "a"]);
    });
});
