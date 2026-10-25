/**
 * Wave coverage — drill-scoped graph filter (previously 0% branches).
 *
 * Branches exercised:
 *   - filterByDrillScope: groupId === null (root) vs non-null;
 *     parentId matches groupId vs not; edge with both endpoints
 *     visible vs not.
 *   - buildDrillBreadcrumbs: empty stack; node found with string
 *     label vs empty-string label vs non-string label vs missing
 *     node; custom vs default rootLabel.
 */

import type { Edge, Node } from "@xyflow/react";
import {
    filterByDrillScope,
    buildDrillBreadcrumbs,
} from "@/lib/processes/canvas-drill-filter";

const node = (id: string, parentId?: string, label?: unknown): Node =>
    ({
        id,
        position: { x: 0, y: 0 },
        data: label === undefined ? {} : { label },
        ...(parentId !== undefined ? { parentId } : {}),
    }) as Node;

const edge = (id: string, source: string, target: string): Edge =>
    ({ id, source, target }) as Edge;

describe("filterByDrillScope", () => {
    it("returns everything unchanged at root (groupId === null)", () => {
        const nodes = [node("a"), node("b")];
        const edges = [edge("e", "a", "b")];
        const r = filterByDrillScope(nodes, edges, null);
        expect(r.visibleNodes).toBe(nodes);
        expect(r.visibleEdges).toBe(edges);
    });

    it("inside a group keeps only direct children and their edges", () => {
        const nodes = [
            node("g"), // the group container — hidden when drilled in
            node("child1", "g"),
            node("child2", "g"),
            node("other", "elsewhere"),
        ];
        const edges = [
            edge("e-in", "child1", "child2"), // both visible — kept
            edge("e-out", "child1", "other"), // target hidden — dropped
            edge("e-out2", "g", "child1"), // source (group) hidden — dropped
        ];
        const r = filterByDrillScope(nodes, edges, "g");
        expect(r.visibleNodes.map((n) => n.id).sort()).toEqual([
            "child1",
            "child2",
        ]);
        expect(r.visibleEdges.map((e) => e.id)).toEqual(["e-in"]);
    });

    it("returns empty sets when no node matches the group", () => {
        const nodes = [node("a", "x"), node("b", "y")];
        const r = filterByDrillScope(nodes, [edge("e", "a", "b")], "g");
        expect(r.visibleNodes).toHaveLength(0);
        expect(r.visibleEdges).toHaveLength(0);
    });
});

describe("buildDrillBreadcrumbs", () => {
    it("returns only the root row for an empty stack (default label)", () => {
        const r = buildDrillBreadcrumbs([], []);
        expect(r).toEqual([{ id: null, label: "All" }]);
    });

    it("honours a custom rootLabel", () => {
        const r = buildDrillBreadcrumbs([], [], "Home");
        expect(r[0]).toEqual({ id: null, label: "Home" });
    });

    it("uses the node's string label when present", () => {
        const nodes = [node("g1", undefined, "Onboarding")];
        const r = buildDrillBreadcrumbs(["g1"], nodes);
        expect(r[1]).toEqual({ id: "g1", label: "Onboarding" });
    });

    it("falls back to 'Group' for empty-string label", () => {
        const nodes = [node("g1", undefined, "")];
        const r = buildDrillBreadcrumbs(["g1"], nodes);
        expect(r[1]).toEqual({ id: "g1", label: "Group" });
    });

    it("falls back to 'Group' for non-string label", () => {
        const nodes = [node("g1", undefined, 42)];
        const r = buildDrillBreadcrumbs(["g1"], nodes);
        expect(r[1]).toEqual({ id: "g1", label: "Group" });
    });

    it("falls back to 'Group' when the node is missing entirely", () => {
        const r = buildDrillBreadcrumbs(["ghost"], []);
        expect(r[1]).toEqual({ id: "ghost", label: "Group" });
    });

    it("builds an ordered trail for a multi-level stack", () => {
        const nodes = [
            node("g1", undefined, "Level 1"),
            node("g2", undefined, "Level 2"),
        ];
        const r = buildDrillBreadcrumbs(["g1", "g2"], nodes);
        expect(r.map((x) => x.label)).toEqual(["All", "Level 1", "Level 2"]);
    });
});
