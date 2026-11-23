'use client';

/**
 * `<ScrollCueStrip>` — a horizontally scrolling tab strip that SAYS it scrolls.
 *
 * A row of tabs in an `overflow-x-auto` box is fine on a desktop and silent on
 * a phone: it shows two or three tabs of nine, iOS hides the scrollbar, and
 * nothing tells the reader there is more. Owner decision (2026-11-22): keep the
 * scrolling strip, not a dropdown, and give it cues. This component is those
 * cues, in one place, for every tab bar that scrolls:
 *
 *   - **Edge fades and a chevron** on each side that has hidden items. They
 *     follow the scroll position and the strip's size (scroll, resize and a
 *     `ResizeObserver`), and appear only when the strip actually overflows —
 *     a strip whose items fit renders exactly as it did without them.
 *   - **The active item scrolled into view**, on mount and whenever
 *     `activeKey` changes, far enough inside the edge that the fade does not
 *     cover it. Horizontal only: it never scrolls the page.
 *   - **End padding**, a trailing spacer while the strip overflows, so the
 *     last item is fully reachable when scrolled to the end. (Padding on a
 *     flex scroller is not counted in its scrollable overflow by every engine;
 *     a spacer element always is.)
 *   - **Sticky below the top bar on a phone** (`sticky`), on an opaque band so
 *     the content scrolling beneath does not show through a translucent
 *     surface. From `md` up it is static, as before.
 *
 * The fade is a CSS mask over the list, not a gradient painted on top, so it
 * works on any surface — including a translucent one — without knowing its
 * colour. Smooth scrolling honours `prefers-reduced-motion`.
 *
 * Prop routing: `className` and `data-testid` style and name the outer band;
 * every other attribute (`role`, `aria-label`, `id`, …) lands on the scrolling
 * list, which is the element that owns the items — so a caller writes
 * `role="tablist"` on this component and the tabs' parent is the tablist.
 */

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';

/**
 * Width of each edge fade, in px. The outer `SCROLL_CUE_CHEVRON_PX` of it is
 * fully transparent, so the chevron never sits on legible text; the rest ramps
 * the items back in.
 */
export const SCROLL_CUE_FADE_PX = 48;
const SCROLL_CUE_CHEVRON_PX = 24;

/** The phone top bar's height (`min-h-16`) plus its safe-area inset. */
const STICKY_UNDER_TOP_BAR =
    'max-md:sticky max-md:top-[calc(4rem+env(safe-area-inset-top))] max-md:z-20 max-md:bg-bg-page';

export interface ScrollCueStripProps
    extends Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'> {
    /** The strip's items — typically `role="tab"` buttons. */
    children: React.ReactNode;
    /**
     * Identifies the selected item. Whenever it changes (and on mount) the
     * element matching `activeSelector` is scrolled into view.
     */
    activeKey?: string;
    /** How to find the selected item inside the list. */
    activeSelector?: string;
    /** Classes for the outer band (surface, border, radius). */
    className?: string;
    /** Classes for the scrolling list (gap, inner padding). */
    listClassName?: string;
    /** Stick below the top bar on a phone. */
    sticky?: boolean;
    /** Names the outer band. */
    'data-testid'?: string;
}

type Edges = { start: boolean; end: boolean };

function prefersReducedMotion(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
}

function scrollListTo(list: HTMLElement, left: number, smooth: boolean) {
    const behavior: ScrollBehavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
    if (typeof list.scrollTo === 'function') {
        list.scrollTo({ left, behavior });
    } else {
        list.scrollLeft = left;
    }
}

/**
 * The scroll position that brings `item` fully inside `list`, clear of the
 * edge fades — or `null` when it already is.
 */
export function scrollLeftToReveal(list: HTMLElement, item: HTMLElement): number | null {
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const inset = SCROLL_CUE_FADE_PX;
    let target: number | null = null;
    if (itemRect.left < listRect.left + inset) {
        target = Math.max(0, list.scrollLeft + (itemRect.left - listRect.left) - inset);
    } else if (itemRect.right > listRect.right - inset) {
        target = list.scrollLeft + (itemRect.right - listRect.right) + inset;
    }
    // The first item at scroll 0 is "inside the inset" and already in view.
    return target !== null && Math.abs(target - list.scrollLeft) >= 1 ? target : null;
}

function fadeMask(edges: Edges): string | undefined {
    if (!edges.start && !edges.end) return undefined;
    const f = `${SCROLL_CUE_FADE_PX}px`;
    const c = `${SCROLL_CUE_CHEVRON_PX}px`;
    const start = edges.start ? `transparent 0, transparent ${c}, black ${f}` : 'black 0';
    const end = edges.end
        ? `black calc(100% - ${f}), transparent calc(100% - ${c}), transparent 100%`
        : 'black 100%';
    return `linear-gradient(to right, ${start}, ${end})`;
}

export function ScrollCueStrip({
    children,
    activeKey,
    activeSelector = '[aria-selected="true"]',
    className,
    listClassName,
    sticky = false,
    'data-testid': testId,
    style,
    ...listProps
}: ScrollCueStripProps) {
    const t = useTranslations('ui.scrollCueStrip');
    const listRef = React.useRef<HTMLElement>(null);
    const [edges, setEdges] = React.useState<Edges>({ start: false, end: false });

    const measure = React.useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const max = list.scrollWidth - list.clientWidth;
        const start = max > 1 && list.scrollLeft > 1;
        const end = max > 1 && list.scrollLeft < max - 1;
        setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    }, []);

    // Follow scroll and size. The observer watches the list and each item, so
    // a label that changes width (a locale switch, a count arriving) is seen.
    React.useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        measure();
        list.addEventListener('scroll', measure, { passive: true });
        window.addEventListener('resize', measure);
        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure);
            observer.observe(list);
            for (const child of Array.from(list.children)) observer.observe(child);
        }
        return () => {
            list.removeEventListener('scroll', measure);
            window.removeEventListener('resize', measure);
            observer?.disconnect();
        };
    }, [measure]);

    // Items added or removed after mount: re-measure on every render. It reads
    // layout once and bails out of the state update when nothing changed.
    React.useEffect(() => {
        measure();
    });

    // The active item into view: instantly on mount (the reader did not see it
    // move), smoothly on a change.
    const mounted = React.useRef(false);
    React.useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const active = list.querySelector<HTMLElement>(activeSelector);
        if (active) {
            const left = scrollLeftToReveal(list, active);
            if (left !== null) scrollListTo(list, left, mounted.current);
        }
        mounted.current = true;
        measure();
    }, [activeKey, activeSelector, measure]);

    const page = (direction: 1 | -1) => {
        const list = listRef.current;
        if (!list) return;
        const step = Math.max(list.clientWidth - 2 * SCROLL_CUE_FADE_PX, SCROLL_CUE_FADE_PX);
        scrollListTo(list, list.scrollLeft + direction * step, true);
    };

    const mask = fadeMask(edges);
    // The end spacer exists only while the strip overflows, so a strip whose
    // items fit (and an `ml-auto` item at its end) lays out exactly as without
    // it. Stable: it is added only when the list already overflows without it.
    const overflowing = edges.start || edges.end;
    // Pointer convenience only: keyboard users reach every item with Tab, and
    // focusing an item scrolls it into view natively. Labelled all the same.
    const chevronClass =
        'absolute inset-y-0 z-10 flex w-6 items-center justify-center text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none';

    const band = (
        <div
            className={cn('relative min-w-0', className)}
            data-testid={testId}
            data-scroll-cue-strip=""
            data-overflow-start={edges.start ? '' : undefined}
            data-overflow-end={edges.end ? '' : undefined}
        >
            <nav
                {...listProps}
                ref={listRef}
                className={cn('scrollbar-hide flex overflow-x-auto', listClassName)}
                style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
                data-scroll-cue-list=""
            >
                {children}
                {overflowing && (
                    <span
                        aria-hidden="true"
                        className="w-4 flex-shrink-0"
                        data-scroll-cue-end-spacer=""
                    />
                )}
            </nav>
            {edges.start && (
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('scrollStart')}
                    className={cn(chevronClass, 'left-0')}
                    onClick={() => page(-1)}
                    data-scroll-cue-chevron="start"
                >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
            )}
            {edges.end && (
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('scrollEnd')}
                    className={cn(chevronClass, 'right-0')}
                    onClick={() => page(1)}
                    data-scroll-cue-chevron="end"
                >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
            )}
        </div>
    );

    // The sticky wrapper is a separate, opaque box: the band's own surface may
    // be translucent, and merging an opaque phone background into its classes
    // would replace the band's shade rather than sit beneath it.
    return sticky ? (
        <div className={STICKY_UNDER_TOP_BAR} data-scroll-cue-sticky="">
            {band}
        </div>
    ) : (
        band
    );
}
