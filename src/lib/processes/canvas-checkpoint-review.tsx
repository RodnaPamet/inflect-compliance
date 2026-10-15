'use client';

/**
 * WHICH NODE'S CHECKPOINT A REVIEWER HAS OPENED (#3472, plan point 08).
 *
 * The canvas's inline approve/reject is two pieces that must not know about
 * each other: a button INSIDE a tldraw shape, and a panel OUTSIDE the canvas
 * transform. This is the only thing between them.
 *
 * ## Why the panel cannot live in the shape
 *
 * A tldraw shape is rendered inside the canvas's pan/zoom transform, so
 * anything in it is scaled with the camera, clipped by the shape's own bounds,
 * and positioned in page space by a matrix the component does not own. A diff
 * table is none of those things — it has its own scroll, its own focus order,
 * and a size the shape's `w`/`h` know nothing about. So the shape carries the
 * AFFORDANCE and this context carries the DECISION, and the panel renders in
 * ordinary DOM beside the canvas.
 *
 * ## Why `canReview` and `canOperate` are separate
 *
 * Because they are separate on `/agents/proposals`, and this surface must not
 * invent a second authority model for the same queue. There, the PAGE gates on
 * `ctx.appPermissions.admin.view` before it loads anything and the CLIENT
 * takes `canOperate = ctx.permissions.canWrite` — two different questions:
 * may you see the queue, and may you decide. The proposals client's own
 * comment records what happens when the second is skipped: "Approve and Reject
 * rendered enabled for readers and returned 403 on press."
 *
 * So `canReview` decides whether the node offers the affordance at all, and
 * `canOperate` decides whether the panel's buttons are live. A reviewer with
 * neither sees exactly what they see today: a node that says a human is
 * needed, with no control that lies about who.
 *
 * ## Safe without a provider
 *
 * The default value's `open` is a no-op and `canReview` is false, which is the
 * same design property the execution overlay states for itself: a node still
 * renders in isolation in a test and under SSR, and the feature is simply
 * absent. That is why `ProcessNodeShapeUtil` can read this unconditionally.
 */
import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

export interface CheckpointReviewValue {
    /** May this viewer read the checkpoint queue at all? */
    canReview: boolean;
    /** May this viewer approve or reject? The role-tier `canWrite`. */
    canOperate: boolean;
    /** The run whose checkpoint is open, or null. */
    openRunId: string | null;
    open: (runId: string) => void;
    close: () => void;
}

const DEFAULT: CheckpointReviewValue = {
    canReview: false,
    canOperate: false,
    openRunId: null,
    open: () => {},
    close: () => {},
};

const CheckpointReviewContext = createContext<CheckpointReviewValue>(DEFAULT);

export function CheckpointReviewProvider({
    canReview,
    canOperate,
    children,
}: {
    canReview: boolean;
    canOperate: boolean;
    children: ReactNode;
}) {
    const [openRunId, setOpenRunId] = useState<string | null>(null);
    // GATED IN THE SETTER, not only at the call site. `open` is handed to a
    // shape util that has no idea what authority the viewer holds, and a
    // second caller added later would inherit the check for free rather than
    // having to remember it.
    const open = useCallback(
        (runId: string) => {
            if (canReview) setOpenRunId(runId);
        },
        [canReview],
    );
    const close = useCallback(() => setOpenRunId(null), []);
    const value = useMemo(
        () => ({ canReview, canOperate, openRunId, open, close }),
        [canReview, canOperate, openRunId, open, close],
    );
    return (
        <CheckpointReviewContext.Provider value={value}>
            {children}
        </CheckpointReviewContext.Provider>
    );
}

/** Node-side and panel-side read — safe without a provider. */
export function useCheckpointReview(): CheckpointReviewValue {
    return useContext(CheckpointReviewContext);
}
