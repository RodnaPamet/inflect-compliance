# 2026-09-30 — Canvas export on tldraw

**Commit:** `8c665cca4 feat(processes): canvas export on tldraw, with the background parity kept`

## Design

The xyflow export makes an image in three steps: find the `.react-flow__viewport`
DOM node, compute a fit-to-content `width`/`height`/`transform` from
`getNodesBounds` + `getViewportForBounds`, then hand that node to
`html-to-image`. tldraw collapses all three into one call — `editor.toImage()`
and `editor.getSvgString()` take shapes and return finished bytes — so none of
that machinery ports. The triage bears this out: of the six exports in
`canvas-export.ts`, five carry exactly one engine reference each, and that
reference is the `toPng`/`toSvg` call. The engine work lives in two helpers
(`resolveViewportEl`, `exportTransform`), both with six call sites, and neither
has a tldraw counterpart.

What does not come for free is the background colour.

```ts
// @tldraw/editor — TLSvgExportOptions
background?: boolean;
darkMode?: boolean;
```

`background` is a **boolean**, not a colour. Passing `true` makes tldraw paint
its own theme background; the current export passes
`backgroundColor: resolveBackground()`, a product token (`#0A2138` dark /
`#FBFAF8` light). Left alone, every exported image would change colour at the
cutover — a difference nobody would notice until someone compared this
quarter's evidence pack against last quarter's.

So `background: false` is passed and the colour is applied here. That lands
differently per format, which is why the two paths are not symmetrical:

- **SVG** — `getSvgString` returns a string, so the background is a `<rect>`
  inserted after the opening `<svg>` tag. Exact, and checkable with no browser
  surface at all.
- **PNG** — `toImage` returns a `Blob`, so applying a background means drawing
  it onto a canvas. This repo has neither `canvas` nor `jest-canvas-mock`, so
  jsdom has no 2D context and that step cannot be unit-tested. It sits behind
  `compositeImpl`, an injected seam whose default does the drawing; the tests
  assert *which colour reaches the seam*, and the `drawImage` call itself is
  uncovered and said to be.

Three helpers that never belonged to either engine moved to a shared module
rather than being copied — otherwise the repo would hold two answers to "what
colour is an exported map", and they would drift.

## Files

| file | role |
|---|---|
| `src/lib/processes/canvas-export-shared.ts` | `safeFilename`, `resolveBackground`, `downloadDataUrl`, `blobToDataUrl`, the background tokens and `EXPORT_PADDING`. Engine-agnostic; moved, not written |
| `src/lib/processes/tldraw-canvas-export.ts` | PNG / SVG / clipboard over an `Editor`, plus `injectBackgroundRect` and the `compositeImpl` seam |
| `src/lib/processes/canvas-export.ts` | unchanged behaviour; imports the four helpers it used to declare |
| `tests/guards/p3a-canvas-export-png-svg.test.ts` | two assertions follow the moved code; one new assertion locks the xyflow path's use of it |
| `eslint.config.mjs` | the tldraw exporter joins the existing clipboard exemption |

## Decisions

- **`background: false` + our own colour, rather than `darkMode: true`.** The
  latter is one line and would have been visibly wrong; parity is the whole
  point of a migration. Not routed to the owner as a product question, unlike
  the item-5 node-count warning, because "the export keeps looking the way it
  looks" is not a choice anyone needs to make.

- **Convert the `Blob` at the boundary.** `toImage` returns a `Blob` and four
  downstream consumers (download anchor, clipboard, PDF route, Evidence
  attachment) take a data URL because the xyflow path produced one. Converting
  once here keeps those contracts unchanged. The clipboard path gets *simpler*:
  its xyflow counterpart had to `atob` a base64 data URL back into a Blob
  because `toPng` only returns a string, and `ClipboardItem` wants the Blob
  that `toImage` already hands over.

- **`getCurrentPageShapes()`, not `store.allRecords()`.** A process map is one
  page and tldraw allows more, the same distinction `serializeEditorCanvas`
  had to make on save. An export reading the store would silently include
  shapes the user cannot see on the map they are exporting. The fake editor in
  the tests throws from `allRecords`, so a regression fails loudly instead of
  producing a quietly wrong image.

- **The relocated guard assertions are bound to one function, not the file.**
  Moving `resolveBackground` broke two source assertions in
  `p3a-canvas-export-png-svg` that read `canvas-export.ts` for the `data-theme`
  read and the filename sanitiser. Both claims are still true — the citation
  moved, not the claim — so the guard follows them, and a new assertion locks
  that the xyflow path still *uses* them; without that edge, the two relocated
  checks pass against a module nobody calls. That edge reads
  `functionBodyOf(src, 'exportCanvasAsSvg')` rather than the whole file,
  because `resolveBackground(` occurs five times file-wide and a whole-file
  needle is satisfied by any survivor. Mutation-proved: hardcoding the colour
  in that one function reddens it with four call sites still standing.

- **An unused import does not catch a removed call site here.**
  `no-unused-vars` is not configured in `eslint.config.mjs`, and eslint exits 0
  on a file whose import is unreferenced — measured, not assumed. So the usage
  had to be asserted rather than inferred from Lint being green.

- **The eslint exemption was extended, not bypassed with an inline disable.**
  `no-restricted-syntax` routes clipboard writes through
  `useCopyToClipboard`, which is text-only; the existing image exporter is
  already listed with that reasoning. The tldraw exporter has the identical
  justification and will outlive the xyflow one at the cutover.
