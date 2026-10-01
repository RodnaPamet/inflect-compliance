/**
 * A process node cannot be resized, because a resize cannot be saved.
 *
 * ── The invariant ────────────────────────────────────────────────────
 *
 * Every capability the shape util grants has to correspond to something the
 * serializer persists. `canResize()` returned `true`, with `onResize` wired to
 * `resizeBox`, which writes `props.w` / `props.h` — and `tldrawToRows` reads
 * neither. So a resize marked the document dirty, autosave fired, the write
 * SUCCEEDED and bumped `version`, and the size was gone on reload: a save that
 * reports success and discards the edit.
 *
 * Locking was the owner's decision (#2961) over the two alternatives — teaching
 * the renderer to read `dataJson.size`, a column #2960 deliberately made an
 * opaque passthrough, or inventing pixel dimensions for a preset that on xyflow
 * is CSS over intrinsic sizing (`min-w`/`max-w`, padding, icon and text scale)
 * rather than a width and a height.
 *
 * ── Why the util rather than a mounted editor ────────────────────────
 *
 * The editor delegates these straight to the util, so the util is where the
 * answer lives and a 36-second rendered suite would add nothing. What a mounted
 * editor *does* cover — that the shape type is registered and accepts a real
 * row — is already asserted in `tldraw-mounts-with-the-process-shapes`.
 *
 * ── Both directions ──────────────────────────────────────────────────
 *
 * The negative claims alone would be satisfied by a util that refuses
 * everything, which would mean no edges could be drawn. `canBind` is asserted
 * permissive for that reason.
 */
import {
    ProcessNodeShapeUtil,
} from '@/components/processes/tldraw/ProcessNodeShapeUtil';
import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
} from '@/components/processes/tldraw/process-node-shape';
import { PERSISTED_NODE_PROPS } from '@/components/processes/tldraw/serializer';

/** The util's capability answers, called the way the editor calls them. */
const util = ProcessNodeShapeUtil.prototype as unknown as {
    canResize: () => boolean;
    hideResizeHandles: () => boolean;
    hideRotateHandle: () => boolean;
    canBind: () => boolean;
    onResize?: unknown;
};

describe('resize is locked, and the lock is tied to persistence', () => {
    it('refuses resize', () => {
        expect(util.canResize()).toBe(false);
    });

    it('and hides the handles, so the affordance matches the answer', () => {
        // `canResize` refuses the drag; this removes the grab. Leaving handles
        // on a shape that refuses to resize reads as a broken control.
        expect(util.hideResizeHandles()).toBe(true);
    });

    it('carries no onResize handler for a future flip to find and trust', () => {
        // `onResize` was deleted rather than left unreachable. Re-enabling
        // `canResize` must be a deliberate act that also has to supply the
        // handler — and, per the comment on `canResize`, the persistence first.
        expect(util.onResize).toBeUndefined();
    });

    it('w and h are still DECLARED — the lock is on the capability, not the props', () => {
        // The defaults remain the shape's size, and `getDefaultProps` still has
        // to supply them. This is what distinguishes "cannot be changed" from
        // "does not exist", and it is why the mapper — not the type system — is
        // what stops a change to them claiming a save.
        expect(PROCESS_NODE_DEFAULT_W).toBeGreaterThan(0);
        expect(PROCESS_NODE_DEFAULT_H).toBeGreaterThan(0);
        expect(PERSISTED_NODE_PROPS).not.toContain('w');
        expect(PERSISTED_NODE_PROPS).not.toContain('h');
    });
});

describe('rotation — the handle is hidden, which is not the same as locked', () => {
    it('hides the rotate handle', () => {
        expect(util.hideRotateHandle()).toBe(true);
    });

    it('and that is honest about being an affordance, not a capability', () => {
        // `ShapeUtil` has no `canRotate`; `hideRotateHandle` is the whole API.
        // `RotateCWMenuItem` and `editor.rotateShapesBy()` stay reachable, so
        // rotation is NOT locked the way resize is.
        //
        // Tolerable only because rotation cannot claim a save: `rotation` is a
        // tldraw base-record field rather than a declared prop, so it is
        // outside `PERSISTED_NODE_PROPS` and a rotation-only diff reads as
        // `node-untouched`. Asserted here so the reasoning is checked rather
        // than trusted.
        expect(Object.keys(ProcessNodeShapeUtil.props ?? {})).not.toContain('rotation');
        expect(PERSISTED_NODE_PROPS).not.toContain('rotation');
    });
});

describe('but not everything is refused', () => {
    it('binding stays permissive, or no process node could take an edge', () => {
        // Teeth for every negative above: a util that refused everything would
        // satisfy them and break the product.
        expect(util.canBind()).toBe(true);
    });
});
