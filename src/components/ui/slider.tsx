"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { cn } from "@inflect/ui/lib/cn";
import type { ReactNode } from "react";

/**
 * The Radix part, loaded when a slider first renders rather than with the
 * page. See "Loading" below.
 */
const SliderControl = dynamic(
    () => import("./slider-control").then((m) => m.SliderControl),
    {
        ssr: false,
        // The bare track at the control's height, so nothing moves when the
        // thumb arrives.
        loading: () => (
            <div className="relative flex h-8 w-full items-center" aria-hidden>
                <div className="h-[var(--track-height)] w-full rounded-full bg-bg-subtle" />
            </div>
        ),
    },
);

/**
 * Epic 60 polish primitive — Slider.
 *
 * Styled wrapper over Radix Slider so we inherit the keyboard contract
 * (Arrow step, PageUp/Down step*10, Home/End to bounds) and ARIA
 * semantics (`role="slider"`, `aria-valuemin/max/now`, `aria-orientation`)
 * for free. Everything we own is token-backed and will re-theme.
 *
 * ## The track-inset trick
 *
 * The Radix Range fills from 0 → thumb position, but the thumb is
 * `thumb-radius` tall — so if we drew the Range edge-to-edge it would
 * visibly extend past the thumb by half its width, giving the track a
 * lopsided look. We render the FILLED portion inside an inset wrapper
 * (`inset-x-[var(--thumb-radius)]`) and draw a matching-color stub
 * manually on the left edge so "full" means "reached the thumb center".
 * The mark dots are positioned on the full range (min..max), also
 * inside the inset area.
 *
 * ## Value display + marks
 *
 * `marks` — array of numeric positions to draw as dots on the track.
 *   Defaults to four evenly-spaced points (min, 1/3, 2/3, max).
 * `hint` — freeform ReactNode under the slider. Use for "min / max"
 *   range labels, a live-updated current value, or help copy.
 * `formatLabel` — if provided, renders a floating label above the
 *   thumb at the current position. Handy for percentage sliders.
 *
 * ## When NOT to use
 *
 * A slider is the wrong control for discrete choices with ≤5 steps or
 * non-numeric options — use ToggleGroup or RadioGroup. Sliders also
 * struggle on touch without a visible numeric value; if the user
 * needs to pick precisely, pair with NumberStepper.
 *
 * ## Loading
 *
 * The Radix part (`slider-control.tsx`) is a `next/dynamic` import, so
 * `@radix-ui/react-slider` and its collection runtime (about 8.5 KB gzipped)
 * are not in the First Load JS of any page that merely CAN show a slider.
 * The risk and asset forms that use it are modals and edit panels, and the
 * risks list mounts `<NewRiskModal>` statically, so loading Radix eagerly put
 * it in that page's entry and, through Next's client-reference manifest
 * (which merges a parent path's page into every route below it), into
 * `/risks/[riskId]` too: 675.2 -> 684.5 KB against a 676 KB budget (#5906).
 * Until the chunk arrives the slider shows its bare track at full height,
 * so the layout does not move, and is not yet operable — tests find it with
 * `findByRole`, not `getByRole`.
 */

export interface SliderProps {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step?: number;
    marks?: number[];
    className?: string;
    hint?: ReactNode;
    disabled?: boolean;
    /** Accessible label. Required by RadixSlider — defaults to "Slider"
     *  but consumers should pass something specific ("Impact", "Volume"). */
    ariaLabel?: string;
    /** Optional formatter for a floating current-value label above the
     *  thumb. Typical use: `(v) => `${v}%`` for percentage sliders. */
    formatLabel?: (value: number) => ReactNode;
    /** The thumb's `id` (the element that takes focus: `role="slider"`). */
    id?: string;
    /**
     * The id of a VISIBLE label to name the slider by. Preferred over
     * `ariaLabel` when the form already shows one: a `<label htmlFor>`
     * cannot point at the thumb, which is not a labelable element.
     */
    ariaLabelledBy?: string;
}

export function Slider({
    value,
    onChange,
    min,
    max,
    step = 1,
    marks,
    className,
    hint,
    disabled,
    ariaLabel,
    formatLabel,
    id,
    ariaLabelledBy,
}: SliderProps) {
    const t = useTranslations("common.ui");
    const sliderMarks = marks || [
        min,
        min + (max - min) / 3,
        min + (2 * (max - min)) / 3,
        max,
    ];
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;

    return (
        <div
            className={cn(
                "relative z-0 [--thumb-radius:13px] [--track-height:16px]",
                disabled && "opacity-60",
                className,
            )}
        >
            <div className="w-full">
                <SliderControl
                    value={value}
                    onChange={onChange}
                    min={min}
                    max={max}
                    step={step}
                    marks={sliderMarks}
                    disabled={disabled}
                    ariaLabel={ariaLabel ?? t("slider")}
                    ariaLabelledBy={ariaLabelledBy}
                    id={id}
                    formatLabel={formatLabel}
                />

                {hint && (
                    <div className="mt-2 min-h-[1rem] text-xs text-content-subtle">
                        {hint}
                    </div>
                )}
            </div>
            {/* Percentage is useful in-DOM for tests + assistive tech
                that reads data-* attributes; the visible presentation
                comes from Radix's ARIA values. */}
            <span aria-hidden data-value-percent={pct.toFixed(2)} />
        </div>
    );
}
