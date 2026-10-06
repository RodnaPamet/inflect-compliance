"use client";

/**
 * Epic 41 — `<DashboardGrid>` interactive composition layer.
 *
 * Wraps `react-grid-layout`'s `WidthProvider(GridLayout)` with this
 * contract:
 *
 *   - Takes typed widget rows (`{ id, position, size, enabled }`) and a
 *     `renderWidget` callback. The grid owns LAYOUT only — what's
 *     rendered inside each tile is the caller's concern, so the
 *     dispatcher from a row's `(type, chartType, config)` to a concrete
 *     chart component lives in the page, not here.
 *
 *   - On drag-stop / resize-stop, computes the diff between the new
 *     layout and the widget rows it received, and fires
 *     `onLayoutChange(changes)` with ONLY the rows whose `(x, y, w, h)`
 *     actually moved. The parent persists each via PATCH; the grid
 *     never talks to the API directly.
 *
 *   - Drag state is local to RGL during a gesture; the persisted
 *     layout is the prop coming in from the parent. The grid never
 *     mutates its own layout off-prop — every move round-trips through
 *     `onLayoutChange` → parent state → re-render. Single source of
 *     truth = the backend.
 *
 *   - Editable mode is an explicit prop; when `editable={false}`,
 *     drag + resize are disabled and the resize handles on the
 *     children are visually neutral (Epic 41 prompt 2's wrapper
 *     already opts out of the handle when `showResizeHandle=false`,
 *     and consumers should set that based on the same flag).
 *
 * CSS imports:
 *
 *   - `react-grid-layout/css/styles.css`  — placement / transitions
 *   - `react-resizable/css/styles.css`    — handle visuals
 *
 * Both are imported as side-effects. Next.js bundles them via the
 * normal global-CSS pipeline; importing here keeps the dependency
 * boundary local to the component.
 */

// Legacy entry — preserves the v1-style flat-props API + the
// `WidthProvider(GridLayout)` HOC pattern. The v2 main entry shifted
// to a hooks API (`useGridLayout`, `useContainerWidth`); we use the
// legacy wrapper because (a) the documented HOC pattern is more
// familiar and (b) the legacy module still ships in v2 for back-compat.
//
// Path note: `react-grid-layout/legacy` is the package's documented
// subpath, but `tests/rendered/tsconfig.json` uses
// `moduleResolution: "node"` which doesn't honour the package's
// `exports` field. Importing from `dist/legacy` directly resolves
// under both classic-node (tests) and bundler resolution
// (`tsc --noEmit` at the repo root) because the file exists at that
// path in either layout.
import RGL, {
    WidthProvider,
    type Layout,
    type LayoutItem,
} from 'react-grid-layout/legacy';
import { useMemo, type ReactNode } from 'react';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { cn } from '@/lib/cn';
import { useIsBelowMd } from '@/components/ui/hooks';

const ResponsiveGridLayout = WidthProvider(RGL);

// ─── Public types ───────────────────────────────────────────────────

/**
 * The minimum widget shape the grid needs to render. A host's own
 * persisted-widget DTO typically satisfies it structurally, so the page
 * layer can hand its rows straight in without an adapter.
 */
export interface DashboardGridWidget {
    id: string;
    position: { x: number; y: number };
    size: { w: number; h: number };
    enabled?: boolean;
}

/** A single widget's new layout after a drag or resize. */
export interface WidgetLayoutChange {
    id: string;
    position: { x: number; y: number };
    size: { w: number; h: number };
}

export interface DashboardGridProps<T extends DashboardGridWidget> {
    widgets: ReadonlyArray<T>;
    /**
     * Render the contents of one grid tile. The grid wraps the
     * returned node in a positioned `<div>`; the callback should
     * NOT add its own absolute positioning.
     */
    renderWidget: (widget: T) => ReactNode;
    /**
     * Fires after a drag or resize ends with the diffed set of
     * widgets whose `(x, y, w, h)` changed. Empty array fires when
     * the user drags an item back to its origin — callers can
     * short-circuit a no-op PATCH cycle on `changes.length === 0`.
     */
    onLayoutChange?: (changes: WidgetLayoutChange[]) => void;
    /** When `false` (default), drag + resize are disabled. */
    editable?: boolean;
    /** Pixel height of one grid row. Default 64. */
    rowHeight?: number;
    /** Number of columns in the grid. Default 12. */
    cols?: number;
    /** Margin between items `[x, y]` in px. Default `[12, 12]`. */
    margin?: [number, number];
    /**
     * Optional CSS selector RGL uses to restrict drag origins. When
     * unset, the entire tile is draggable. Useful when the consumer
     * wants drag to fire only from the widget header, leaving
     * chart-tooltip hover unhooked.
     */
    draggableHandle?: string;
    className?: string;
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Project a widget row into RGL's `Layout` item shape. The grid
 * preserves the widget's position + size exactly; clamping happens
 * on the backend via Zod.
 */
function widgetToLayoutItem<T extends DashboardGridWidget>(
    widget: T,
    editable: boolean,
): LayoutItem {
    return {
        i: widget.id,
        x: widget.position.x,
        y: widget.position.y,
        w: widget.size.w,
        h: widget.size.h,
        // RGL treats per-item `static` as forcing isDraggable +
        // isResizable to false. We hoist the editable flag here so a
        // global toggle works without re-cloning every widget tile.
        static: !editable,
    };
}

/**
 * Diff a fresh RGL layout against the prop widgets and emit a
 * change record only for entries whose `(x, y, w, h)` actually
 * moved. RGL fires `onLayoutChange` on every render (including the
 * initial mount), and we don't want to PATCH the entire dashboard
 * on first paint.
 */
function diffLayoutChanges<T extends DashboardGridWidget>(
    layout: Layout,
    widgets: ReadonlyArray<T>,
): WidgetLayoutChange[] {
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const changes: WidgetLayoutChange[] = [];
    for (const item of layout) {
        const original = byId.get(item.i);
        if (!original) continue;
        if (
            item.x === original.position.x &&
            item.y === original.position.y &&
            item.w === original.size.w &&
            item.h === original.size.h
        ) {
            continue;
        }
        changes.push({
            id: item.i,
            position: { x: item.x, y: item.y },
            size: { w: item.w, h: item.h },
        });
    }
    return changes;
}

// ─── Component ──────────────────────────────────────────────────────

export function DashboardGrid<T extends DashboardGridWidget>(
    props: DashboardGridProps<T>,
) {
    const {
        widgets,
        renderWidget,
        onLayoutChange,
        editable = false,
        rowHeight = 64,
        cols = 12,
        margin = [12, 12],
        draggableHandle,
        className,
    } = props;

    const visibleWidgets = useMemo(
        () => widgets.filter((w) => w.enabled !== false),
        [widgets],
    );

    const layout = useMemo<Layout>(
        () => visibleWidgets.map((w) => widgetToLayoutItem(w, editable)),
        [visibleWidgets, editable],
    );

    // Mobile PR-4 — a 12-column drag-grid is unusable on a phone (cramped
    // columns + touch drag/resize). Below `md` render the widgets as a simple
    // full-width vertical stack (no RGL). `useIsBelowMd` is false on SSR/jsdom,
    // so desktop + tests keep the grid. Widget order follows the laid-out
    // top-to-bottom / left-to-right reading order.
    const belowMd = useIsBelowMd();
    if (belowMd) {
        const stacked = [...visibleWidgets].sort((a, b) => {
            const la = widgetToLayoutItem(a, false);
            const lb = widgetToLayoutItem(b, false);
            return la.y - lb.y || la.x - lb.x;
        });
        return (
            <div
                className={cn('flex flex-col gap-default', className)}
                data-dashboard-stacked=""
            >
                {stacked.map((widget) => (
                    <div key={widget.id} data-widget-id={widget.id}>
                        {renderWidget(widget)}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <ResponsiveGridLayout
            className={[
                'dashboard-grid',
                editable ? 'dashboard-grid--editable' : 'dashboard-grid--locked',
                className ?? '',
            ]
                .filter(Boolean)
                .join(' ')}
            layout={layout}
            cols={cols}
            rowHeight={rowHeight}
            margin={margin}
            isDraggable={editable}
            isResizable={editable}
            draggableHandle={draggableHandle}
            // `compactType="vertical"` (RGL's default) is what users
            // expect — a removed widget closes the gap above. Setting
            // it explicitly so a future RGL-default change doesn't
            // silently shift our UX.
            compactType="vertical"
            onLayoutChange={(newLayout) => {
                const changes = diffLayoutChanges(newLayout, visibleWidgets);
                if (changes.length === 0) return;
                onLayoutChange?.(changes);
            }}
        >
            {visibleWidgets.map((widget) => (
                <div key={widget.id} data-widget-id={widget.id}>
                    {renderWidget(widget)}
                </div>
            ))}
        </ResponsiveGridLayout>
    );
}
