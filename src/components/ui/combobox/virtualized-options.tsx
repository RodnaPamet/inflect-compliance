"use client";

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 68 — `<VirtualizedComboboxOptions>`.
 *
 * Drop-in replacement for the cmdk-driven option list inside Combobox
 * when the option count exceeds the threshold. Renders ONLY the
 * visible window of options (via the shared `<VirtualizedList>`),
 * with a bespoke keyboard-navigation layer that mirrors cmdk's
 * behaviour: ArrowDown / ArrowUp move the active option, Enter
 * selects, Home / End jump to extremes, scroll-to-active keeps the
 * active option in view.
 *
 * Why we bypass cmdk for large lists:
 *   - cmdk navigates via DOM walks (`querySelector` over the rendered
 *     `[cmdk-item]` set). With virtualization most options aren't in
 *     the DOM, so cmdk's nav silently dead-ends at the visible edge.
 *   - cmdk's `data-selected` highlight relies on items being mounted.
 *     Out-of-window items can't carry that attribute.
 *
 * What we DO keep from cmdk: the `<Command>` wrapper around the
 * popover (so Escape / click-outside / focus trapping still flow
 * through cmdk) and the `<Command.Input>` for the search field. Only
 * the option list itself changes.
 *
 * Accessibility:
 *   - The list carries `role="listbox"` + `aria-activedescendant`
 *     pointing at the active option's stable id.
 *   - Each option carries `role="option"` + `aria-selected`.
 *   - The active option also carries the `data-active="true"`
 *     attribute so the existing `data-active:` Tailwind variants on
 *     consumer-supplied row classes still apply.
 *   - Keyboard handler is attached to the SEARCH INPUT element (via
 *     `searchInputRef`) — that's where focus lives while the popover
 *     is open. We use a CAPTURE-phase listener so we run BEFORE
 *     cmdk's own keydown handler and call `stopPropagation()` for
 *     keys we own.
 *
 * Threshold — `COMBOBOX_VIRTUALIZE_THRESHOLD` is exported so the
 * Combobox call site and the structural ratchet read the same value.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

import {
    VirtualizedList,
    type VirtualizedListHandle,
} from "@/components/ui/virtualized-list";

import {
    Check2,
    CheckboxCheckedFill,
    CheckboxUnchecked,
    type Icon,
} from "../icons";
import { Tooltip } from "../tooltip";
import type { ComboboxOption } from "./index";

/** Auto-virtualize when the visible option count exceeds this. */
export const COMBOBOX_VIRTUALIZE_THRESHOLD = 50;

/**
 * Approximate row height used by the windowed list. Must
 * match the rendered option's actual height — option rows render with
 * `py-2 px-3 text-sm` which is ~36px under the platform tokens. Bump
 * when consumers pass a description (which wraps the row to two
 * lines) — that case is handled inline below.
 */
const SINGLE_LINE_OPTION_HEIGHT = 36;
const TWO_LINE_OPTION_HEIGHT = 56;
/** Max viewport height — matches the legacy ScrollContainer cap. */
const MAX_VIEWPORT_PX = 250;

// ── Wrapped-row sizing (canonical "never truncate an option name") ──
// Virtualized rows wrap their full label instead of truncating, so each row's
// height varies with how many lines the label wraps to. react-window needs a
// deterministic per-index size, so we measure the label's wrapped line count
// against the rendered panel width with an offscreen canvas (no DOM layout) and
// derive the row height. Biased to OVER-estimate (generous chrome reserve) so a
// row is never SHORTER than its content — under-estimating would overlap the
// next row.
const LABEL_FONT = "14px ui-sans-serif, system-ui, -apple-system, sans-serif"; // text-sm
const LINE_HEIGHT_PX = 20; // text-sm line box
const ROW_VPAD_PX = 16; // py-2 (8px top + 8px bottom)
const DESC_EXTRA_PX = 18; // second (description) line
// Horizontal chrome reserved per row before the label: px-3 (24) + checkbox /
// icon / trailing check + gaps. Generous so available text width stays
// conservative (→ more lines, taller row, never an overlap).
const ROW_CHROME_PX = 80;

let _measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
    if (_measureCtx !== undefined) return _measureCtx;
    if (typeof document === "undefined") {
        _measureCtx = null;
        return null;
    }
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) ctx.font = LABEL_FONT;
    _measureCtx = ctx;
    return ctx;
}

const _wordWidthCache = new Map<string, number>();
function measureWord(word: string, ctx: CanvasRenderingContext2D): number {
    const hit = _wordWidthCache.get(word);
    if (hit !== undefined) return hit;
    const w = ctx.measureText(word).width;
    _wordWidthCache.set(word, w);
    return w;
}

/**
 * Greedy word-wrap line count for `text` at `maxWidth` px — mirrors how the
 * browser wraps `whitespace-normal break-words`. Returns 1 when we can't
 * measure (SSR / jsdom has no canvas) so rows fall back to single-line height.
 */
function countWrappedLines(text: string, maxWidth: number): number {
    if (maxWidth <= 0 || !text) return 1;
    const ctx = getMeasureCtx();
    if (!ctx) return 1;
    const spaceW = measureWord(" ", ctx);
    let lines = 1;
    let cur = 0;
    for (const word of text.split(/\s+/)) {
        if (!word) continue;
        const w = measureWord(word, ctx);
        if (w > maxWidth) {
            // A single word wider than the line: break-words splits it.
            if (cur > 0) lines++;
            const whole = Math.ceil(w / maxWidth);
            lines += whole - 1;
            cur = w - (whole - 1) * maxWidth;
            continue;
        }
        if (cur === 0) cur = w;
        else if (cur + spaceW + w <= maxWidth) cur += spaceW + w;
        else {
            lines++;
            cur = w;
        }
    }
    return Math.max(1, lines);
}

export interface VirtualizedComboboxOptionsProps<TMeta> {
    options: ComboboxOption<TMeta>[];
    selected: ComboboxOption<TMeta>[];
    onSelect: (option: ComboboxOption<TMeta>) => void;
    multiple: boolean;
    maxSelected?: number;
    optionRight?: (option: ComboboxOption<TMeta>) => React.ReactNode;
    optionDescription?: (option: ComboboxOption<TMeta>) => React.ReactNode;
    optionClassName?: string;
    /**
     * Ref to the search `<input>`. We attach a capture-phase keydown
     * listener here so ArrowDown / ArrowUp / Enter / Home / End are
     * handled by US, not by cmdk's nav (which assumes the items live
     * in the DOM).
     */
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    /** Stable id prefix for `aria-activedescendant`. */
    listboxId?: string;
}

export function VirtualizedComboboxOptions<TMeta>({
    options,
    selected,
    onSelect,
    multiple,
    maxSelected,
    optionRight,
    optionDescription,
    optionClassName,
    searchInputRef,
    listboxId = "combobox-virt",
}: VirtualizedComboboxOptionsProps<TMeta>) {
    const [activeIndex, setActiveIndex] = React.useState(0);
    const listRef = React.useRef<VirtualizedListHandle>(null);

    // Track the rendered panel width so row heights can be computed from the
    // label's wrapped line count (canonical "never truncate"). Starts 0 →
    // rows fall back to single-line height until the observer reports a width
    // (and in jsdom, which lacks ResizeObserver + canvas, they stay there).
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [contentWidth, setContentWidth] = React.useState(0);
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width ?? 0;
            if (w > 0) setContentWidth(w);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Reset active index when the options list changes shape (search
    // typed/cleared). Going to 0 mirrors cmdk's "select first match"
    // behaviour.
    const optionsLength = options.length;
    const optionsKey = options.map((o) => o.value).join(",");
    React.useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveIndex(0);

    }, [optionsKey]);

    // Selection helper — `selected.some(...)` per row would be O(n*s);
    // memoise into a Set for the duration of the render.
    const selectedSet = React.useMemo(
        () => new Set(selected.map((o) => o.value)),
        [selected],
    );

    // Keyboard handler attached to the search input via capture-phase
    // — runs BEFORE cmdk's own input keydown so cmdk doesn't process
    // ArrowDown / ArrowUp / Enter and stomp our state.
    React.useEffect(() => {
        const input = searchInputRef.current;
        if (!input) return;
        const handler = (e: KeyboardEvent) => {
            if (optionsLength === 0) return;
            if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                setActiveIndex((i) => Math.min(i + 1, optionsLength - 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Home") {
                e.preventDefault();
                e.stopPropagation();
                setActiveIndex(0);
            } else if (e.key === "End") {
                e.preventDefault();
                e.stopPropagation();
                setActiveIndex(optionsLength - 1);
            } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                const opt = options[activeIndex];
                if (!opt) return;
                if (opt.disabledTooltip) return;
                if (
                    !multiple &&
                    !selectedSet.has(opt.value) &&
                    typeof maxSelected === "number" &&
                    selected.length >= maxSelected
                ) {
                    return;
                }
                onSelect(opt);
            }
        };
        // Capture phase so we beat cmdk to the keystroke.
        input.addEventListener("keydown", handler, true);
        return () => input.removeEventListener("keydown", handler, true);
    }, [
        searchInputRef,
        optionsLength,
        activeIndex,
        options,
        selected,
        selectedSet,
        multiple,
        maxSelected,
        onSelect,
    ]);

    // Auto-scroll to keep the active item visible as the user
    // navigates through options the cmdk nav would have done for us.
    React.useEffect(() => {
        listRef.current?.scrollToItem(activeIndex);
    }, [activeIndex]);

    // Per-row height — the label wraps to its FULL text (never truncated), so
    // height grows with the wrapped line count measured against the panel
    // width. Deterministic per index → safe for react-window's function-form
    // `rowHeight`.
    const availTextWidth = contentWidth - ROW_CHROME_PX;
    const getItemSize = React.useCallback(
        (index: number) => {
            const option = options[index];
            if (!option) return SINGLE_LINE_OPTION_HEIGHT;
            const hasDescription = optionDescription?.(option) != null;
            // Only a string label can be measured; a ReactNode label falls back
            // to single-line (it sizes itself and still wraps via break-words).
            const label = typeof option.label === "string" ? option.label : "";
            const lines = countWrappedLines(label, availTextWidth);
            const base = ROW_VPAD_PX + lines * LINE_HEIGHT_PX;
            const h = hasDescription ? base + DESC_EXTRA_PX : base;
            // Floor at the single-line height so short labels keep their rhythm.
            return Math.max(
                h,
                hasDescription ? TWO_LINE_OPTION_HEIGHT : SINGLE_LINE_OPTION_HEIGHT,
            );
        },
        [options, optionDescription, availTextWidth],
    );

    // Invalidate react-window's cached offsets whenever the measured width or
    // the option set changes (heights may now differ).
    React.useEffect(() => {
        listRef.current?.resetAfterIndex(0);
    }, [getItemSize]);

    // Cap viewport at MAX_VIEWPORT_PX; sum the leading rows' heights (bounded —
    // stops once the cap is reached) so a short list shows fewer rows.
    let viewportHeight = 0;
    for (
        let i = 0;
        i < optionsLength && viewportHeight < MAX_VIEWPORT_PX;
        i++
    ) {
        viewportHeight += getItemSize(i);
    }
    viewportHeight = Math.min(
        MAX_VIEWPORT_PX,
        Math.max(getItemSize(0), viewportHeight),
    );

    // Empty state — match the existing data-combobox-empty contract.
    if (optionsLength === 0) {
        return (
            <div
                className="text-content-subtle flex min-h-12 items-center justify-center text-sm"
                data-combobox-empty
            />
        );
    }

    return (
        <div
            ref={containerRef}
            role="listbox"
            id={listboxId}
            aria-activedescendant={`${listboxId}-${activeIndex}`}
            data-virtualized-combobox=""
        >
            <VirtualizedList
                ref={listRef}
                itemCount={optionsLength}
                itemSize={getItemSize}
                height={viewportHeight}
                width="100%"
                overscanCount={5}
                // react-window 2 puts `role="list"` on its scroller. Between
                // the `role="listbox"` above and the `role="option"` rows
                // below, that is invalid ARIA — the options stop being this
                // listbox's children, so screen readers lose the option count
                // and arrow-key semantics. v1 set no role, so nothing here had
                // to say this before.
                role="presentation"
                renderItem={({ index, style }) => {
                    const option = options[index]!;
                    const isSelected = selectedSet.has(option.value);
                    const isActive = index === activeIndex;
                    const isDisabled = Boolean(
                        (!isSelected &&
                            typeof maxSelected === "number" &&
                            selected.length >= maxSelected) ||
                            option.disabledTooltip,
                    );
                    const description = optionDescription?.(option);
                    const right = optionRight?.(option);

                    return (
                        <div style={style} key={option.value}>
                            <DisabledTooltip
                                disabledTooltip={option.disabledTooltip}
                            >
                                <div
                                    role="option"
                                    id={`${listboxId}-${index}`}
                                    aria-selected={isSelected}
                                    aria-disabled={isDisabled || undefined}
                                    data-active={isActive ? "true" : undefined}
                                    data-virtualized-option-index={index}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    onMouseDown={(e) => {
                                        // Prevent the search input from
                                        // losing focus when the user
                                        // clicks a row — keystrokes need
                                        // to keep flowing to the input.
                                        e.preventDefault();
                                    }}
                                    onClick={() => {
                                        if (isDisabled) return;
                                        onSelect(option);
                                    }}
                                    className={cn(
                                        // Option rows wrap their FULL label —
                                        // never truncate an option name. Row
                                        // height grows via getItemSize().
                                        "flex cursor-pointer items-center gap-compact rounded-md px-3 py-2 text-left text-sm",
                                        description
                                            ? "whitespace-normal py-2.5"
                                            : "whitespace-normal",
                                        isActive && "bg-bg-subtle",
                                        isDisabled &&
                                            "cursor-not-allowed opacity-50",
                                        optionClassName,
                                    )}
                                >
                                    {multiple && (
                                        <div className="text-content-default shrink-0">
                                            {isSelected ? (
                                                <CheckboxCheckedFill className="text-content-default size-4" />
                                            ) : (
                                                <CheckboxUnchecked className="text-content-muted size-4" />
                                            )}
                                        </div>
                                    )}
                                    <div
                                        className={cn(
                                            "flex min-w-0 grow items-center gap-tight",
                                            description &&
                                                "flex-col items-start gap-0.5",
                                        )}
                                    >
                                        {option.icon && (
                                            <span className="text-content-default shrink-0">
                                                {isReactNode(option.icon) ? (
                                                    (option.icon as React.ReactNode)
                                                ) : (
                                                    React.createElement(
                                                        option.icon as Icon,
                                                        { className: "h-4 w-4" },
                                                    )
                                                )}
                                            </span>
                                        )}
                                        <span
                                            className={cn(
                                                "grow break-words",
                                                description
                                                    ? "text-content-emphasis"
                                                    : "text-content-default",
                                            )}
                                        >
                                            {option.label}
                                        </span>
                                        {description && (
                                            <span className="text-content-subtle text-sm">
                                                {description}
                                            </span>
                                        )}
                                    </div>
                                    {right}
                                    {!multiple && isSelected && (
                                        <Check2 className="text-content-default size-4 shrink-0" />
                                    )}
                                </div>
                            </DisabledTooltip>
                        </div>
                    );
                }}
            />
        </div>
    );
}

function DisabledTooltip({
    children,
    disabledTooltip,
}: {
    children: React.ReactNode;
    disabledTooltip?: React.ReactNode;
}) {
    if (!disabledTooltip) return <>{children}</>;
    return (
        <Tooltip content={disabledTooltip}>
            <div>{children}</div>
        </Tooltip>
    );
}

function isReactNode(value: unknown): boolean {
    return React.isValidElement(value);
}
