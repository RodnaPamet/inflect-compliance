"use client";

import { cn } from "@inflect/ui/lib/cn";
import { TOUCH_HIT_AREA_CLASS } from "@inflect/ui/components/ui/hit-area";
import * as RadixSlider from "@radix-ui/react-slider";
import type { ReactNode } from "react";

/**
 * The interactive part of `<Slider>`: the Radix root, track, range, mark dots
 * and thumb. It lives apart from `slider.tsx` so `<Slider>` can load it on
 * demand, and nothing else should import it. See "Loading" in `slider.tsx`.
 */
export interface SliderControlProps {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step: number;
    /** Resolved mark positions (the wrapper applies the default). */
    marks: number[];
    disabled?: boolean;
    /** Resolved accessible name, unused when `ariaLabelledBy` is set. */
    ariaLabel: string;
    ariaLabelledBy?: string;
    id?: string;
    formatLabel?: (value: number) => ReactNode;
}

export function SliderControl({
    value,
    onChange,
    min,
    max,
    step,
    marks,
    disabled,
    ariaLabel,
    ariaLabelledBy,
    id,
    formatLabel,
}: SliderControlProps) {
    return (
        <RadixSlider.Root
            className="relative flex h-8 w-full items-center"
            value={[value]}
            min={min}
            max={max}
            step={step}
            onValueChange={([v]: number[]) => onChange(v)}
            disabled={disabled}
        >
            <RadixSlider.Track className="relative h-[var(--track-height)] w-full overflow-visible rounded-full bg-bg-subtle">
                {/* Stub on the left edge — see the docblock in slider.tsx. */}
                <div className="absolute left-0 top-0 h-full w-[var(--thumb-radius)] rounded-l-full bg-content-emphasis" />

                <div className="pointer-events-none absolute inset-x-[var(--thumb-radius)] inset-y-0">
                    <RadixSlider.Range className="absolute h-[var(--track-height)] bg-content-emphasis" />

                    {marks.map((mark) => {
                        const left =
                            ((mark - min) / (max - min)) * 100;
                        return (
                            <span
                                key={mark}
                                aria-hidden
                                className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg-default"
                                style={{ left: `${left}%` }}
                            />
                        );
                    })}
                </div>
            </RadixSlider.Track>

            <RadixSlider.Thumb
                id={id}
                aria-labelledby={ariaLabelledBy}
                aria-label={ariaLabelledBy ? undefined : ariaLabel}
                // 26px painted, 44px to a finger (the shared touch hit
                // area); the track itself also answers a tap.
                className={cn(
                    "relative z-20 flex size-[calc(var(--thumb-radius)*2)] items-center justify-center rounded-full border-0 bg-bg-default shadow-[0_2px_2px_rgba(0,0,0,0.10),0_3px_3px_rgba(0,0,0,0.09)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    TOUCH_HIT_AREA_CLASS,
                )}
            >
                <span className="block size-[calc(var(--thumb-radius)*1.23)] rounded-full bg-content-emphasis" />
                {formatLabel && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-bg-inverted px-2 py-0.5 text-xs font-medium text-content-inverted"
                    >
                        {formatLabel(value)}
                    </span>
                )}
            </RadixSlider.Thumb>
        </RadixSlider.Root>
    );
}
