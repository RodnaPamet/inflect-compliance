/**
 * Point the camera at what the map holds.
 *
 * tldraw's camera is session state: this canvas has no `persistenceKey`, so
 * nothing remembers where the user was looking, and a fresh editor opens at
 * page (0, 0) at 100%. A map drawn anywhere else, which is most maps once a
 * step has been dragged left of or above the origin, opened with its content
 * off-screen and only an edge of a step showing, as if the save had moved it.
 *
 * Framed once the map is loaded, and again on entering or leaving a group,
 * because each drill level shows a different set of shapes. Only VISIBLE
 * shapes count, so a group's children do not pull the camera at root and the
 * root's steps do not pull it inside a group.
 *
 * `targetZoom: 1` caps the zoom: a map of one small step is shown at its real
 * size, not blown up to fill the view. A map larger than the view is zoomed
 * out to fit, as tldraw's own "zoom to fit" does.
 */
import { Box, type Editor } from 'tldraw';

/** Frame the visible shapes. Returns false when there is nothing to frame. */
export function frameVisibleContent(editor: Editor): boolean {
    const ids = [...editor.getCurrentPageShapeIds()].filter((id) => !editor.isShapeHidden(id));
    if (ids.length === 0) return false;
    const boxes = ids
        .map((id) => editor.getShapePageBounds(id))
        .filter((b): b is Box => b !== undefined);
    if (boxes.length === 0) return false;
    const bounds = Box.Common(boxes);
    editor.zoomToBounds(bounds, { targetZoom: 1 });
    return true;
}
