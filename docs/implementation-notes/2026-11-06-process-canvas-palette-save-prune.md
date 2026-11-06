# 2026-11-06 — Process canvas: palette, Save, and a pruned interface

**Commit:** see the pull request for this branch (`claude/process-canvas-fixes`).

Three reports from the owner about the Processes page: the left-hand palette
(Risk, Decision and the rest) could not be used on the canvas, there was no
Save button to be seen, and the page carried buttons that did nothing useful.

## Design

### The palette

Two defects, either one enough to make every item dead.

1. **The drop handler never ran in a browser.** It sat on the wrapper `<div>`
   around tldraw in React's bubble phase. A real drop lands on tldraw's own
   canvas element, inside that wrapper, and tldraw's `useCanvasEvents` handles
   every drop itself and calls `stopPropagation`. The tests dispatched the drop
   on the wrapper, which is outside tldraw's handler, so they passed. The
   handler is now registered for the CAPTURE phase (`onDropCapture`,
   `onDragOverCapture`). It runs before tldraw's, takes only a drop carrying the
   palette MIME type, and stops that one; anything else (a file) still reaches
   tldraw. A new test dispatches on `.tl-canvas`, and fails against the old
   registration.
2. **Drag was the only way in.** The items were `<div role="button">` with no
   click handler. HTML5 drag never fires on a touch screen, and a keyboard
   cannot drag. They are real `<button>`s now: a click or Enter calls `onAdd`,
   and the workspace places the step in the middle of the view
   (`placementForClick`, nudged down-right while that spot is taken).

Both paths build the step through one function, `createProcessNode`, so a fix to
what a new step carries reaches both. The first such fix: a step created while
drilled into a group takes that group as its `parentNodeKey`. The drill filter
shows only that group's children, so a step created with no parent disappeared
the moment it was created.

### Save

The Save button existed. It was clipped: the document bar was a single
unwrapping flex row inside a frame with `overflow-hidden`, and Save was its last
item. The bar wraps now.

Behind the button were two more defects that made saving unreliable even when
it could be seen:

- **Save raced the autosave.** It sent its own PUT with the version from the
  last render. If an autosave was on the wire, both carried the same version,
  and the second got a 409, which shows the "someone else changed this map"
  toast and a reload. Save and rename now go through the autosave's own queue:
  `useCanvasAutosave.flush()` cancels the debounce, waits for a save in flight,
  then saves. The version that second save sends has to be the one the first
  save returned, before React has rendered it, so `useTldrawCanvasAutosave`
  reads the version from a ref that the save writes when it lands.
- **A duplicated step broke every later save.** tldraw's Duplicate, Alt-drag
  and paste copy a shape's props verbatim, so the copy carried its source's
  `nodeKey`, and `ProcessNode`'s unique index on `(processMapId, nodeKey)`
  refused the save. `installUniqueProcessKeys` re-mints a clashing `nodeKey` (and
  an edge binding's `edgeKey`) in a before-create side effect.

And the autosave's error message is reported now. It was hard-coded to `null`
on its way to the bar, so "Save failed" never said why.

### What the map keeps

- **The freeform layer is loaded.** Notes, text, drawings and frames were saved
  to `freeformJson` on every save and never read back, so a reload lost them and
  the next save wrote the empty layer over them. `TldrawProcessMap` reads the
  column and `restoreFreeform` puts the records back, parents first, skipping
  any record tldraw refuses.
- **A step inside a frame is saved at its page position.** tldraw stores a
  child's coordinates relative to its parent, and the row has no parent shape,
  so the step came back somewhere else.

### What was removed

| Removed | Why |
| --- | --- |
| Pages (`maxPages: 1`) | A save serialises the current page only; a shape on another page, or "Move to page", was lost. |
| Images, video, embeds (tool, menu items, drop and paste) | An asset record is not saved with the map; the image was gone after a reload. |
| tldraw groups (Ctrl+G, menu, command palette) | Not restorable around steps that are saved as rows. The map's own Group step is the container. |
| The geometric shapes and laser tools | Looked like steps without being steps: no inspector, no coverage, no connections. |
| The bar's Undo, Redo and Snap | tldraw draws its own undo and redo, keeps snapping in its preferences, and the command palette offers all three. |

The removed tools are deleted from tldraw's `tools` override, so their keyboard
shortcuts go with them. The toolbar keeps select, hand, arrow (which draws a
connection between steps), text, note, draw, eraser and frame.

## Files

| File | Role |
| --- | --- |
| `src/components/processes/tldraw/create-process-node.ts` | New. One creation path, click placement, unique-key side effects. |
| `src/components/processes/TldrawProcessCanvas.tsx` | Capture-phase drop, the pruned tldraw UI, freeform restore, unique keys. |
| `src/components/processes/ProcessPalette.tsx` | Items are buttons; `onAdd`. |
| `src/components/processes/TldrawProcessWorkspace.tsx` | Click-to-add; hands the bar the map's save; no group commands. |
| `src/components/processes/TldrawProcessMap.tsx` | Loads `freeformJson`; reports the save error; exposes `saveNow`. |
| `src/lib/processes/use-canvas-autosave.ts` | `flush()`. |
| `src/lib/processes/use-tldraw-canvas-autosave.ts` | `saveNow({ name })`; the landed-version ref. |
| `src/lib/processes/use-tldraw-document-bar.ts` | Save and rename go through `saveMap`. |
| `src/components/processes/CanvasDocumentBar.tsx` | Wraps; no Undo, Redo or Snap. |
| `src/components/processes/tldraw/editor-canvas.ts` | Page coordinates for a step inside a frame. |
| `src/lib/processes/canvas-command-groups.ts` | `group` / `ungroup` optional. |

## Decisions

- **Capture phase over a native listener on tldraw's canvas.** A native
  listener would reach into tldraw's DOM by class name, which a tldraw upgrade
  can rename. The capture phase on our own wrapper needs nothing from tldraw.
- **The bar's breadcrumb stays.** The page has no other heading since R31; the
  breadcrumb is the page's identity, not a duplicate control.
- **Undo, Redo and Snap stay in the command palette.** They work and cost
  nothing there; only the second set of buttons in the bar went.
- **A rename that meets a 409 snaps the field back.** `saveTldrawCanvas`
  resolves on a conflict (the reload toast owns it), so `ok` alone cannot tell
  whether the name landed. `saveNow` also reports `saved`, which is true only
  when the server answered with the new map.
- **The other tabs are a separate pull request.** The Rules, Analytics and
  Monitor tabs had their own dead and misleading controls; they are fixed on
  their own so this one stays about the canvas.
