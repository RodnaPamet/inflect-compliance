"use client";

import { cn } from "@inflect/ui/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronLeft } from "@inflect/ui/components/ui/icons/glyphs/chevron-left";
import { ChevronRight } from "@inflect/ui/components/ui/icons/glyphs/chevron-right";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
    KeyboardEvent,
    ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { HIT_AREA_CLASS } from "./hit-area";
import dynamic from "next/dynamic";

/**
 * The below-`sm` select is loaded only when a phone needs it. It renders the
 * `<Combobox>` (cmdk + the virtualised list), and a static import put that
 * whole graph into the First Load JS of every page with a toggle group —
 * about 10 KB on every tenant and org route, for a branch only a phone with
 * a 4+ option group ever takes. `isMobile` is false on the server and the
 * first client render, so nothing is lost by loading it after mount.
 */
const ToggleGroupSelect = dynamic(
    () => import("./toggle-group-select").then((m) => m.ToggleGroupSelect),
    { ssr: false },
);

/**
 * Epic 60 polish primitive — ToggleGroup.
 *
 * Segmented control for a small set of mutually-exclusive choices
 * (time range: 7d/30d/90d/custom; view mode: list/grid/kanban; status
 * filter: all/open/closed). Sits in dense toolbars where a full
 * Combobox would be overkill and a Radio list would waste vertical
 * space.
 *
 * ## Variants
 *
 *   - `size: default` — 12px vertical padding, reads as a prominent
 *     control on top of a card.
 *   - `size: sm` — compact 6px vertical padding for dense filter bars.
 *
 * ## Accessibility
 *
 * The group renders as `role="radiogroup"` with each option marked
 * `role="radio"` + `aria-checked`. Arrow keys cycle focus and
 * selection (APG automatic-activation), Home/End jump to endpoints.
 * Disabled options are skipped by the roving tabindex.
 *
 * Link-mode options render as `<Link>` — a Next.js navigation is what
 * commits the selection — and ARIA stays as `link`-like by dropping
 * the `role="radio"` in that case (they're navigation, not a radio).
 *
 * ## The sliding pill, without an animation engine
 *
 * The selected option carries the pill, as before; when the selection
 * moves, the new pill starts where the old one was and slides into
 * place (FLIP: measure both, play the difference with the browser's own
 * Web Animations API). It used to be a `motion` shared-layout animation,
 * and because the account menu's language switch is a ToggleGroup, that
 * put the whole engine (about 37 KB gzip) in every route's first load
 * for one 250 ms slide. Measured relative to the group, so a page that
 * scrolled between two choices does not throw the pill across it; not
 * played when the reader asked for reduced motion, or with `layout`
 * off.
 *
 * ## On a phone
 *
 * A label NEVER wraps (`whitespace-nowrap`): "Топлинна / карта" on two
 * lines read as two options. A group wider than its container scrolls
 * sideways instead of being clipped by the shell, with an edge fade and a
 * chevron on whichever side has more, and the selected option is scrolled
 * into view. Below `sm`, a group of `SELECT_MIN_OPTIONS` or more renders as
 * a `<Combobox>` instead — four Bulgarian labels do not fit 360px in any
 * arrangement a thumb can use. Each option is 44px tall on a coarse
 * pointer.
 */

/**
 * At this many options, below `sm`, the group becomes a select. Three
 * short options fit a phone; four Bulgarian ones ("Персонализирано") do not.
 */
export const SELECT_MIN_OPTIONS = 4;

const toggleGroupVariants = cva(
    // `max-w-full` + `overflow-x-auto`: a group wider than its container
    // scrolls rather than running past the card and being clipped.
    // `scrollbar-hide`: the cue is the edge fade, not a scrollbar.
    "border-border-subtle bg-bg-default relative z-0 inline-flex max-w-full items-center overflow-x-auto overscroll-x-contain rounded-lg border scrollbar-hide",
    {
        variants: {
            size: {
                default: "gap-1 p-1",
                sm: "gap-0.5 p-0.5",
            },
        },
        defaultVariants: { size: "default" },
    },
);

const toggleOptionVariants = cva(
    // `HIT_AREA_CLASS`: the rounded corners of an option were dead to
    // `:hover` (5% of a 63x20 option, measured), so sliding along the
    // toggle dropped the hover between options. See `hit-area.ts`.
    //
    // NO `capitalize`. CSS `text-transform: capitalize` upper-cases the
    // first letter of EVERY word, which is an English-newspaper
    // convention and not a general one: a two-word Bulgarian label comes
    // out title-cased, where the orthography capitalises only the first
    // word. There is nothing a primitive can do to make that per-locale
    // decision, and the option labels are already authored in the case
    // they should render in — which is what made the transform
    // unnecessary even in English.
    //
    // `whitespace-nowrap shrink-0`: a label never wraps onto two lines and
    // an option never shrinks below its label; the group scrolls instead.
    // `text-content-muted` unselected, `text-content-emphasis` selected
    // (the `data-selected` variant): in the light theme an unselected
    // option in emphasis text read as plain body copy, so the selection
    // was carried by the pill alone. `pointer-coarse:min-h-11`: 44px.
    // `pointer-coarse:min-w-11` too: a one-word option ("All") was 41px wide
    // on a phone (#5924); the label stays centred in the wider pill.
    `text-content-muted data-[selected=true]:text-content-emphasis relative z-10 flex shrink-0 items-center justify-center gap-tight whitespace-nowrap font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${HIT_AREA_CLASS}`,
    {
        variants: {
            size: {
                default: "px-3 py-1 text-sm",
                sm: "px-2 py-0.5 text-xs",
            },
        },
        defaultVariants: { size: "default" },
    },
);

export interface ToggleGroupOption {
    value: string;
    label: string | ReactNode;
    badge?: ReactNode;
    href?: string;
    disabled?: boolean;
    /** Optional DOM id to pin on the rendered radio/link. Use for
     *  long-lived E2E selectors. Default: no id. */
    id?: string;
}

export interface ToggleGroupProps extends VariantProps<typeof toggleGroupVariants> {
    options: ToggleGroupOption[];
    selected: string | null;
    selectAction?: (option: string) => void;
    /** Defaults to `true` — the pill slides to the selected option. */
    layout?: boolean;
    className?: string;
    optionClassName?: string;
    indicatorClassName?: string;
    style?: React.CSSProperties;
    /** Screen-reader label for the radiogroup. Defaults to `common.ui.options`. */
    ariaLabel?: string;
}

/**
 * True only on a POSITIVE `(max-width: 639.98px)` match, i.e. below Tailwind's
 * `sm`. Not `useMediaQuery().isMobile`, which reads "mobile" whenever neither
 * of its `min-width` queries matches — so an environment without real media
 * queries (jsdom, and any non-browser renderer) counted as a phone and every
 * 4+ option group turned into a select. False on the server and the first
 * client render, so hydration sees the segmented group either way.
 */
const BELOW_SM_QUERY = "(max-width: 639.98px)";
function useBelowSm(): boolean {
    const [below, setBelow] = useState(false);
    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
        const mql = window.matchMedia(BELOW_SM_QUERY);
        const update = () => setBelow(mql.matches);
        update();
        mql.addEventListener?.("change", update);
        return () => mql.removeEventListener?.("change", update);
    }, []);
    return below;
}

export function ToggleGroup(props: ToggleGroupProps) {
    // `isMobile` is below `sm` (640px). It starts false on SSR and the first
    // client render, so the server, jsdom and a desktop all render the
    // segmented group, and a phone swaps once on mount.
    const belowSm = useBelowSm();
    if (belowSm && props.options.length >= SELECT_MIN_OPTIONS) {
        return <ToggleGroupSelect {...props} />;
    }
    return <ToggleGroupSegments {...props} />;
}

function ToggleGroupSegments({
    options,
    selected,
    selectAction,
    layout = true,
    size,
    className,
    optionClassName,
    indicatorClassName,
    style,
    ariaLabel,
}: ToggleGroupProps) {
    const t = useTranslations("common.ui");
    const btnRefs = useRef(new Map<string, HTMLElement>());
    const groupRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const pillRef = useRef<HTMLDivElement>(null);
    // Where the pill was, relative to the group, after the last render.
    const lastPill = useRef<{ x: number; y: number; w: number; h: number } | null>(
        null,
    );

    useLayoutEffect(() => {
        const group = groupRef.current;
        const pill = pillRef.current;
        if (!group || !pill) {
            lastPill.current = null;
            return;
        }
        const g = group.getBoundingClientRect();
        const r = pill.getBoundingClientRect();
        const next = {
            // In the group's CONTENT coordinates, so a scrolled group does not
            // throw the pill across it.
            x: r.left - g.left + group.scrollLeft,
            y: r.top - g.top,
            w: r.width,
            h: r.height,
        };
        const prev = lastPill.current;
        lastPill.current = next;
        if (!layout || !prev || typeof pill.animate !== "function") return;
        if (
            prev.x === next.x &&
            prev.y === next.y &&
            prev.w === next.w &&
            prev.h === next.h
        )
            return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
            return;
        pill.animate(
            [
                {
                    transform: `translate(${prev.x - next.x}px, ${prev.y - next.y}px)`,
                    width: `${prev.w}px`,
                    height: `${prev.h}px`,
                },
                {
                    transform: "translate(0, 0)",
                    width: `${next.w}px`,
                    height: `${next.h}px`,
                },
            ],
            { duration: 250, easing: "ease-out" },
        );
    }, [selected, layout]);

    // The selected option is scrolled into view INSIDE the group. Not
    // `scrollIntoView`, which would also scroll the page to a group that is
    // below the fold on mount.
    useLayoutEffect(() => {
        const group = groupRef.current;
        if (!group || group.scrollWidth <= group.clientWidth) return;
        const el =
            selected !== null ? btnRefs.current.get(selected) ?? null : null;
        const target =
            el ??
            group.querySelector<HTMLElement>('[data-selected="true"]');
        if (!target) return;
        const start = target.offsetLeft;
        const end = start + target.offsetWidth;
        if (start < group.scrollLeft) group.scrollLeft = start;
        else if (end > group.scrollLeft + group.clientWidth)
            group.scrollLeft = end - group.clientWidth;
    }, [selected]);

    // Edge cues. Written to the frame as data attributes rather than React
    // state, so scrolling re-renders nothing.
    useEffect(() => {
        const group = groupRef.current;
        const frame = frameRef.current;
        if (!group || !frame) return;
        const sync = () => {
            const max = group.scrollWidth - group.clientWidth;
            frame.dataset.scrollStart = String(group.scrollLeft > 1);
            frame.dataset.scrollEnd = String(max - group.scrollLeft > 1);
        };
        sync();
        group.addEventListener("scroll", sync, { passive: true });
        const ro =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(sync);
        ro?.observe(group);
        return () => {
            group.removeEventListener("scroll", sync);
            ro?.disconnect();
        };
    }, []);

    const enabledNonLinkValues = useMemo(
        () =>
            options
                .filter((o) => !o.disabled && !o.href)
                .map((o) => o.value),
        [options],
    );

    const onKeyDown = useCallback(
        (e: KeyboardEvent<HTMLButtonElement>, value: string) => {
            if (enabledNonLinkValues.length === 0) return;
            const idx = enabledNonLinkValues.indexOf(value);
            if (idx === -1) return;

            let next: string | undefined;
            switch (e.key) {
                case "ArrowRight":
                case "ArrowDown":
                    next =
                        enabledNonLinkValues[
                            (idx + 1) % enabledNonLinkValues.length
                        ];
                    break;
                case "ArrowLeft":
                case "ArrowUp":
                    next =
                        enabledNonLinkValues[
                            (idx - 1 + enabledNonLinkValues.length) %
                                enabledNonLinkValues.length
                        ];
                    break;
                case "Home":
                    next = enabledNonLinkValues[0];
                    break;
                case "End":
                    next =
                        enabledNonLinkValues[
                            enabledNonLinkValues.length - 1
                        ];
                    break;
                default:
                    return;
            }
            e.preventDefault();
            const el = btnRefs.current.get(next);
            el?.focus();
            selectAction?.(next);
        },
        [enabledNonLinkValues, selectAction],
    );

    return (
        // The frame carries the caller's layout classes and the edge cues;
        // the radiogroup inside it is the scroller.
        <div
            ref={frameRef}
            data-toggle-frame=""
            className={cn("group/toggle relative inline-flex min-w-0 max-w-full", className)}
            style={style}
        >
        <div
            ref={groupRef}
            role="radiogroup"
            aria-label={ariaLabel ?? t("options")}
            className={cn(toggleGroupVariants({ size }), "w-full")}
        >
                {options.map((option) => {
                    const isSelected = option.value === selected;
                    const isDisabled = option.disabled === true;
                    const commonClassName = cn(
                        toggleOptionVariants({ size }),
                        !isSelected &&
                            !isDisabled &&
                            "hover:text-content-emphasis z-[11] transition-colors",
                        isDisabled && "cursor-not-allowed opacity-50",
                        optionClassName,
                    );

                    const content = (
                        <>
                            {typeof option.label === "string" ? (
                                <p>{option.label}</p>
                            ) : (
                                option.label
                            )}
                            {option.badge}
                            {isSelected && (
                                <div
                                    ref={pillRef}
                                    aria-hidden="true"
                                    data-toggle-pill=""
                                    // `border-border-strong` (3.5:1 in
                                    // both themes) on `bg-bg-elevated`: the
                                    // light theme's old `bg-bg-muted` pill on
                                    // a `bg-bg-default` track was a faint
                                    // beige the eye did not find.
                                    className={cn(
                                        "border-border-strong bg-bg-elevated absolute left-0 top-0 -z-[1] h-full w-full rounded-lg border",
                                        indicatorClassName,
                                    )}
                                />
                            )}
                        </>
                    );

                    if (option.href) {
                        return (
                            <Link
                                key={option.value}
                                id={option.id}
                                href={option.href}
                                data-selected={isSelected}
                                aria-current={
                                    isSelected ? "page" : undefined
                                }
                                aria-disabled={
                                    isDisabled ? true : undefined
                                }
                                className={commonClassName}
                                onClick={(e) => {
                                    if (isDisabled) {
                                        e.preventDefault();
                                        return;
                                    }
                                    selectAction?.(option.value);
                                }}
                            >
                                {content}
                            </Link>
                        );
                    }

                    return (
                        <button
                            key={option.value}
                            id={option.id}
                            ref={(el) => {
                                if (el)
                                    btnRefs.current.set(option.value, el);
                                else btnRefs.current.delete(option.value);
                            }}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            disabled={isDisabled}
                            tabIndex={
                                isDisabled ? -1 : isSelected ? 0 : -1
                            }
                            data-selected={isSelected}
                            className={commonClassName}
                            onClick={() => selectAction?.(option.value)}
                            onKeyDown={(e) => onKeyDown(e, option.value)}
                        >
                            {content}
                        </button>
                    );
                })}
        </div>
            {/* Edge cues: shown only while there is more in that direction. */}
            <span
                aria-hidden="true"
                data-testid="toggle-group-cue-start"
                className="pointer-events-none absolute inset-y-px left-px z-20 flex w-7 items-center justify-start rounded-l-lg bg-gradient-to-r from-bg-default to-transparent text-content-muted opacity-0 transition-opacity group-data-[scroll-start=true]/toggle:opacity-100"
            >
                <ChevronLeft width={14} height={14} />
            </span>
            <span
                aria-hidden="true"
                data-testid="toggle-group-cue-end"
                className="pointer-events-none absolute inset-y-px right-px z-20 flex w-7 items-center justify-end rounded-r-lg bg-gradient-to-l from-bg-default to-transparent text-content-muted opacity-0 transition-opacity group-data-[scroll-end=true]/toggle:opacity-100"
            >
                <ChevronRight width={14} height={14} />
            </span>
        </div>
    );
}
