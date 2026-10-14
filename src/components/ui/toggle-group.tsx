"use client";

import { cn } from "@inflect/ui/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
    KeyboardEvent,
    ReactNode,
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
} from "react";
import { HIT_AREA_CLASS } from "./hit-area";

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
 */

const toggleGroupVariants = cva(
    "border-border-subtle bg-bg-default relative z-0 inline-flex items-center rounded-lg border",
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
    `text-content-emphasis relative z-10 flex items-center gap-tight font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg ${HIT_AREA_CLASS}`,
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

export function ToggleGroup({
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
            x: r.left - g.left,
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
        <div
            ref={groupRef}
            role="radiogroup"
            aria-label={ariaLabel ?? t("options")}
            className={cn(toggleGroupVariants({ size }), className)}
            style={style}
        >
                {options.map((option) => {
                    const isSelected = option.value === selected;
                    const isDisabled = option.disabled === true;
                    const commonClassName = cn(
                        toggleOptionVariants({ size }),
                        !isSelected &&
                            !isDisabled &&
                            "hover:text-content-subtle z-[11] transition-colors",
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
                                    className={cn(
                                        "border-border-subtle bg-bg-muted absolute left-0 top-0 -z-[1] h-full w-full rounded-lg border",
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
    );
}
