/**
 * Shared UI utility hooks — Epic 60's canonical home.
 *
 * **Import convention:** every consumer should import from the barrel
 * (`@/components/ui/hooks`) rather than the per-file paths below. The
 * file layout is an implementation detail that can reshuffle without
 * touching call sites.
 *
 * See `./README.md` for the full architecture — category manifest,
 * SSR-safety conventions, naming rules, how this directory relates to
 * `src/lib/hooks/` (data-fetching / domain hooks, a separate home).
 *
 * The barrel is verified against every `use-*.ts(x)` file in this
 * directory by `tests/guards/ui-hooks-barrel.test.ts` — adding a hook
 * without a barrel export fails CI.
 */

// ─── Persistence ──────────────────────────────────────────────────────
export {
    useLocalStorage,
    type UseLocalStorageOptions,
} from "@inflect/ui/components/ui/hooks/use-local-storage";

// ─── Viewport / observer ──────────────────────────────────────────────
export { useInViewport } from "@inflect/ui/components/ui/hooks/use-in-viewport";
export { useIntersectionObserver } from "@inflect/ui/components/ui/hooks/use-intersection-observer";
export { useMediaQuery } from "@inflect/ui/components/ui/hooks/use-media-query";
export { useResizeObserver } from "@inflect/ui/components/ui/hooks/use-resize-observer";
export {
    useResponsivePresentation,
    resolvePresentation,
    type ResponsivePresentation,
    type UseResponsivePresentation,
    type UseResponsivePresentationOptions,
} from "@inflect/ui/components/ui/hooks/use-responsive-presentation";

// ─── Scroll ───────────────────────────────────────────────────────────
export { useScroll } from "@inflect/ui/components/ui/hooks/use-scroll";
export { useScrollProgress } from "@inflect/ui/components/ui/hooks/use-scroll-progress";

// ─── Optimistic UI ────────────────────────────────────────────────────
export {
    useOptimisticUpdate,
    type UseOptimisticUpdateOptions,
    type UseOptimisticUpdateResult,
} from "@inflect/ui/components/ui/hooks/use-optimistic-update";

// ─── Submit / input / keyboard ────────────────────────────────────────
export {
    useEnterSubmit,
    type EnterSubmitModifierPolicy,
    type UseEnterSubmitOptions,
    type UseEnterSubmitResult,
} from "@inflect/ui/components/ui/hooks/use-enter-submit";
export { useInputFocused } from "@inflect/ui/components/ui/hooks/use-input-focused";
export { useKeyboardShortcut } from "./use-keyboard-shortcut";

// ─── Dense-table ergonomics ───────────────────────────────────────────
export { useColumnVisibility } from "@inflect/ui/components/ui/hooks/use-column-visibility";

// ─── Clipboard / copy ─────────────────────────────────────────────────
export {
    useCopyToClipboard,
    type UseCopyToClipboardOptions,
    type UseCopyToClipboardResult,
    type CopyOptions,
    type CopyFn,
} from "@inflect/ui/components/ui/hooks/use-copy-to-clipboard";

// ─── Cursor pagination ────────────────────────────────────────────────
export {
    useCursorPagination,
    type UseCursorPaginationOptions,
    type UseCursorPaginationResult,
} from "@inflect/ui/components/ui/hooks/use-cursor-pagination";

// ─── Threshold load-more (PR-1) ───────────────────────────────────────
//
// Sibling of `useCursorPagination` — same `hasMore` + `loadMore`
// vocabulary, but slices an in-memory row list to a configurable
// threshold instead of fetching the next server cursor. Used by
// tables that already have the full row set in memory and just
// want progressive disclosure for performance + scannability.
export {
    useThresholdLoadMore,
    DEFAULT_LOAD_MORE_THRESHOLD,
    type UseThresholdLoadMoreOptions,
    type UseThresholdLoadMoreResult,
} from "@inflect/ui/components/ui/hooks/use-threshold-load-more";

// ─── Celebration (Epic 62) ────────────────────────────────────────────
export {
    useCelebration,
    type CelebrateInput,
    type CelebrationDedupe,
    type CelebrationPreset,
    type UseCelebrationResult,
} from "@inflect/ui/components/ui/hooks/use-celebration";

// ─── View mode (Epic 66) ──────────────────────────────────────────────
export {
    useViewMode,
    viewModeStorageKey,
    type ViewMode,
} from "./use-view-mode";

// ─── Toast vocabulary (Roadmap-2 PR-9) ────────────────────────────────
export {
    useToast,
    type ToastApi,
    type ToastOptions,
} from "@inflect/ui/components/ui/hooks/use-toast";

// ─── Toast with undo (Epic 67) ────────────────────────────────────────
export {
    useToastWithUndo,
    cancelPendingUndoToast,
    type TriggerUndoToast,
    type TriggerUndoToastInput,
} from "./use-toast-with-undo";

// ─── Responsive viewport (mobile PR-4) ────────────────────────────────
export { useIsBelowMd } from "@inflect/ui/components/ui/hooks/use-is-below-md";
export { useCreateQueryParam } from '@inflect/ui/components/ui/hooks/use-create-query-param';
export { useSsrFallback } from '@inflect/ui/components/ui/hooks/use-ssr-fallback';

// ─── Debounced field autosave (P3.5) ──────────────────────────────────
export {
    useAutosaveFields,
    type AutosaveState,
    type UseAutosaveFieldsOptions,
    type UseAutosaveFieldsResult,
} from "@inflect/ui/components/ui/hooks/use-autosave-fields";
