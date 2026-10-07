'use client';

/**
 * `<AsidePanel>` — the right-rail / aside-panel primitive.
 *
 * Right-rail roadmap (see `docs/right-rail-aside-roadmap.md`). The
 * fourth chrome posture: persistent + co-resident context that stays
 * visible while the user works in the main content — distinct from a
 * tab (exclusive), a `<Sheet>` (transient overlay) and a `<Modal>`
 * (blocking).
 *
 * Responsive — content is written ONCE, the container differs:
 *   - ≥ xl (1280px): a docked column. Two states, persisted per
 *     `surfaceKey` in localStorage — expanded (a user-resizable
 *     280–480px panel, default 320px) or collapsed-to-spine (a 44px
 *     rail with an expand affordance).
 *   - < xl: the docked column is hidden; the same `children` open in
 *     a `<Sheet>` from a compact trigger. No mobile rail, no second
 *     copy of the content.
 *
 * State ownership: this primitive owns the collapse state, the width,
 * and the responsive decision (the "chrome"); the consuming page owns
 * `children` (the "content") — the same shell-owns-layout /
 * page-owns-content split as `EntityDetailLayout`.
 *
 * Phase 4 refinements:
 *   - Resizable width — drag the left-edge handle, or focus it and
 *     use ArrowLeft / ArrowRight. Width persists per `surfaceKey`.
 *   - Deep link — `?aside=<surfaceKey>` force-expands this panel once
 *     on arrival, so a shared link can open a specific rail. The
 *     param is additive + one-shot; the collapse state itself never
 *     enters the URL (it stays localStorage-only — a shared link must
 *     not carry one user's rail preference).
 */
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
    type MouseEvent as ReactMouseEvent,
    type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { cn } from '@inflect/ui/lib/cn';

import { ChevronLeft } from '@/components/ui/icons/nucleo/chevron-left';
import { ChevronRight } from '@/components/ui/icons/nucleo/chevron-right';
import { cardVariants } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { useLocalStorage } from '@/components/ui/hooks';

// ─── Width bounds ──────────────────────────────────────────────────
// The docked panel is user-resizable between these. 320px is the
// default (the roadmap's fixed v1 width); 280 keeps the content
// legible; 480 caps the bite the rail can take out of the main
// column at a 1280px viewport.
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 280;
// 560 caps the bite the panel can take out of the main column at a 1280px
// viewport. Raised from 480 so the editable quick-view (the tabbed
// Details/Activity editor) can be a proper wide right-PANEL — distinct from
// the narrow browse/assist rails — rather than a cramped rail-width column.
const MAX_WIDTH = 560;
const KEYBOARD_RESIZE_STEP = 16;

export interface AsidePanelProps {
    /** Panel heading — also the Sheet's accessible title below xl. */
    title: string;
    /**
     * Stable key for this rail surface. The expand/collapse state and
     * the width are persisted under `aside:collapsed:<surfaceKey>` /
     * `aside:width:<surfaceKey>` so each surface (a control detail
     * page, the risks list, …) remembers independently. It also
     * doubles as the `?aside=<surfaceKey>` deep-link target.
     */
    surfaceKey: string;
    /**
     * Optional icon node shown beside the title and in the spine.
     * A node (not an icon component) so callers pass the repo's own
     * `<AppIcon>` / Nucleo icons without this primitive coupling to
     * one icon family.
     */
    icon?: ReactNode;
    /**
     * When true, the panel starts collapsed-to-spine on first visit —
     * before the user has set a preference for this `surfaceKey`. Once
     * the user expands/collapses, that choice persists and wins. Use
     * for a persistent-but-secondary rail (e.g. an assist co-pilot)
     * that should not claim 320px unprompted. Default false.
     */
    defaultCollapsed?: boolean;
    /**
     * Initial expanded width (px) before the user has dragged a
     * preference for this `surfaceKey`. Clamped to [MIN_WIDTH,
     * MAX_WIDTH]. Use for a content-dense rail (e.g. the controls
     * category browser) that wants more room than the 320px default.
     * Once the user resizes, that choice persists and wins.
     */
    defaultWidth?: number;
    /** Rail content — rendered once, in the docked panel or the Sheet. */
    children: ReactNode;
    /**
     * Optional controls rendered in the panel header, to the LEFT of the
     * collapse toggle (and beside the title in the Sheet header below xl).
     * Use for a per-rail affordance that belongs next to the title rather
     * than buried in the content — e.g. an "expand/collapse all" toggle.
     */
    headerActions?: ReactNode;
    /**
     * When true, the panel opens itself on mount: it expands the docked rail
     * (≥xl) and opens the Sheet (<xl). Use for a panel that mounts in RESPONSE
     * to a user action (e.g. a quick-view that appears when a row name is
     * clicked) so the content shows immediately without a second tap. Default
     * false (the rail respects its persisted collapse state).
     */
    openOnMount?: boolean;
    /**
     * Called when the user DISMISSES the panel below `xl` (closes the Sheet).
     * Lets a controlled-content owner (e.g. the quick-view) clear its selection
     * so the panel unmounts cleanly. No-op on the docked ≥xl rail (which
     * collapses to a spine rather than closing).
     */
    onClose?: () => void;
}

const ICON_BUTTON_CLASS =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

export function AsidePanel({
    title,
    surfaceKey,
    icon,
    defaultCollapsed = false,
    defaultWidth = DEFAULT_WIDTH,
    children,
    headerActions,
    openOnMount = false,
    onClose,
}: AsidePanelProps) {
    const [collapsed, setCollapsed] = useLocalStorage<boolean>(
        `aside:collapsed:${surfaceKey}`,
        defaultCollapsed,
    );
    const [width, setWidth] = useLocalStorage<number>(
        `aside:width:${surfaceKey}`,
        Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, defaultWidth)),
    );
    const [sheetOpen, setSheetOpen] = useState(false);

    // openOnMount — a panel that appears in response to a user action shows
    // its content immediately. ≥xl: expand the docked rail (no Sheet — the
    // rail IS the surface, and opening the Sheet too would float a
    // full-viewport overlay over the page that swallows the next click, so a
    // user had to close-then-reopen to switch rows). <xl: open the Sheet (the
    // docked rail is hidden there). Viewport is read synchronously here so the
    // decision is correct on first mount regardless of media-query hook timing.
    // Runs once on mount.
    useEffect(() => {
        if (!openOnMount) return;
        setCollapsed(false);
        const belowXl =
            typeof window !== 'undefined' && window.matchMedia
                ? window.matchMedia('(max-width: 1279.98px)').matches
                : false;
        if (belowXl) setSheetOpen(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Deep link ──────────────────────────────────────────────────
    // `?aside=<surfaceKey>` force-expands this panel once on arrival,
    // so a teammate's shared link can open a specific rail. One-shot
    // (a ref guards re-runs): after it fires the user controls the
    // panel normally and the param never round-trips back into the
    // URL — collapse state stays localStorage-only by design.
    const searchParams = useSearchParams();
    const deepLinkApplied = useRef(false);
    useEffect(() => {
        if (deepLinkApplied.current) return;
        if (searchParams?.get('aside') === surfaceKey) {
            deepLinkApplied.current = true;
            setCollapsed(false);
        }
    }, [searchParams, surfaceKey, setCollapsed]);

    // ── Drag-resize ────────────────────────────────────────────────
    // The rail sits on the right, so dragging the left-edge handle
    // LEFT widens the panel. Width is clamped to [MIN, MAX] and
    // persisted per surfaceKey.
    const onResizeStart = useCallback(
        (e: ReactMouseEvent) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = width;
            const onMove = (ev: MouseEvent) => {
                const next = Math.min(
                    MAX_WIDTH,
                    Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)),
                );
                setWidth(next);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.removeProperty('user-select');
                document.body.style.removeProperty('cursor');
            };
            // Suppress text selection + force the resize cursor for
            // the whole drag, not just while over the thin handle.
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        },
        [width, setWidth],
    );

    // Keyboard resize — the handle is focusable; Arrow keys nudge the
    // width in 16px steps. ArrowLeft widens (matches drag-left).
    const onResizeKey = useCallback(
        (e: ReactKeyboardEvent) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setWidth((w) => Math.min(MAX_WIDTH, w + KEYBOARD_RESIZE_STEP));
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setWidth((w) => Math.max(MIN_WIDTH, w - KEYBOARD_RESIZE_STEP));
            }
        },
        [setWidth],
    );

    return (
        <>
            {/* ── ≥ xl — docked column ───────────────────────────── */}
            {collapsed ? (
                <div
                    className="hidden xl:flex w-11 flex-shrink-0 flex-col items-center gap-tight rounded-lg border border-border-subtle bg-bg-default py-2"
                    data-testid="aside-panel-spine"
                    data-aside-collapsed="true"
                >
                    <button
                        type="button"
                        onClick={() => setCollapsed(false)}
                        className={ICON_BUTTON_CLASS}
                        aria-label={`Expand ${title} panel`}
                        aria-expanded={false}
                    >
                        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {icon && (
                        <span className="text-content-subtle" aria-hidden="true">
                            {icon}
                        </span>
                    )}
                </div>
            ) : (
                <div
                    className={cn(
                        cardVariants({ density: 'none' }),
                        // `relative` anchors the absolutely-positioned
                        // resize handle on the left edge. `max-h-full` +
                        // `min-h-0` cap the card to the (bounded) aside
                        // column so tall content scrolls inside the body
                        // region below, rather than overflowing the fold.
                        'relative hidden xl:flex xl:max-h-full xl:min-h-0 flex-shrink-0 flex-col',
                    )}
                    style={{ width }}
                    data-testid="aside-panel-docked"
                    data-aside-collapsed="false"
                >
                    {/* Resize handle — straddles the panel's left edge.
                        Invisible at rest, a hairline on hover/focus. */}
                    <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${title} panel`}
                        aria-valuenow={width}
                        aria-valuemin={MIN_WIDTH}
                        aria-valuemax={MAX_WIDTH}
                        tabIndex={0}
                        onMouseDown={onResizeStart}
                        onKeyDown={onResizeKey}
                        className="group absolute left-0 top-0 z-10 h-full w-2 -translate-x-1/2 cursor-col-resize focus-visible:outline-none"
                        data-testid="aside-panel-resize-handle"
                    >
                        <span
                            className="mx-auto block h-full w-px bg-transparent transition-colors group-hover:bg-border-emphasis group-focus-visible:bg-[var(--brand-default)]"
                            aria-hidden="true"
                        />
                    </div>

                    <div className="flex items-center justify-between gap-tight border-b border-border-subtle px-3 py-2">
                        <span className="flex items-center gap-tight text-sm font-semibold text-content-emphasis">
                            {icon && (
                                <span
                                    className="text-content-muted"
                                    aria-hidden="true"
                                >
                                    {icon}
                                </span>
                            )}
                            {title}
                        </span>
                        <div className="flex items-center gap-tight">
                            {headerActions}
                            <button
                                type="button"
                                onClick={() => setCollapsed(true)}
                                className={ICON_BUTTON_CLASS}
                                aria-label={`Collapse ${title} panel`}
                                aria-expanded
                            >
                                <ChevronRight
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            </button>
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
                </div>
            )}

            {/* ── < xl — Sheet fallback ──────────────────────────── */}
            <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className="xl:hidden inline-flex items-center gap-tight rounded-full border border-border-subtle bg-bg-default px-3 py-1.5 text-xs font-medium text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                data-testid="aside-panel-sheet-trigger"
            >
                {icon && <span aria-hidden="true">{icon}</span>}
                {title}
            </button>
            <Sheet
                open={sheetOpen}
                onOpenChange={(next) => {
                    setSheetOpen(next);
                    if (!next) onClose?.();
                }}
                title={title}
                // The aside panel is a co-resident context surface, not a modal
                // — keep the page (the table) visible behind it: no dim, no blur.
                overlayClassName="fixed inset-0 z-40"
            >
                <Sheet.Header>
                    <Sheet.Title>{title}</Sheet.Title>
                    {headerActions}
                </Sheet.Header>
                <Sheet.Body>{children}</Sheet.Body>
            </Sheet>
        </>
    );
}
