"use client";

/**
 * Epic 55 — shared <Switch> primitive.
 *
 * CVA-sized binary toggle built on `@radix-ui/react-switch`. Replaces
 * the over-parameterized original port (trackDimensions /
 * thumbDimensions / thumbTranslate props) with a single `size` variant
 * and semantic tokens. Preserves the Tooltip-wrapped disabledTooltip
 * affordance from the legacy API since that's useful for
 * permission-gated toggles.
 *
 * Size contract:
 *   - sm: h-4 w-7,  thumb 3, translate-x-3
 *   - md: h-5 w-9,  thumb 4, translate-x-4 (default)
 *   - lg: h-6 w-11, thumb 5, translate-x-5
 */

import { cn } from "@inflect/ui/lib/cn";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Tooltip } from "./tooltip";

// Track styling (the outer pill)
const switchTrackVariants = cva(
    [
        "relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent",
        "transition-colors duration-200 ease-in-out",
        "bg-border-default",
        "data-[state=checked]:bg-brand-emphasis",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        "data-[invalid]:ring-2 data-[invalid]:ring-border-error",
    ],
    {
        variants: {
            size: {
                sm: "h-4 w-7",
                md: "h-5 w-9",
                lg: "h-6 w-11",
            },
        },
        defaultVariants: { size: "md" },
    },
);

// Thumb styling (the sliding dot)
const switchThumbVariants = cva(
    [
        "pointer-events-none block rounded-full bg-bg-default shadow-lg ring-0",
        "transition-transform duration-200 ease-in-out",
        "translate-x-0 data-[state=checked]:translate-x-[var(--switch-thumb-x)]",
    ],
    {
        variants: {
            size: {
                sm: "h-3 w-3 [--switch-thumb-x:0.75rem]",
                md: "h-4 w-4 [--switch-thumb-x:1rem]",
                lg: "h-5 w-5 [--switch-thumb-x:1.25rem]",
            },
        },
        defaultVariants: { size: "md" },
    },
);

type CvaSwitchSize = VariantProps<typeof switchTrackVariants>;

export interface SwitchProps
    extends Omit<
            React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
            "size"
        >,
        CvaSwitchSize {
    /** Surface invalid state for form-level styling. */
    invalid?: boolean;
    /** When set, the switch is forced disabled and wrapped in a Tooltip. */
    disabledTooltip?: React.ReactNode;
    /** Render a loading spinner / placeholder inside the thumb. */
    thumbIcon?: React.ReactNode;
    /** Loading state forces `checked={false}` and disables interaction. */
    loading?: boolean;
    className?: string;
}

const Switch = React.forwardRef<
    React.ElementRef<typeof SwitchPrimitive.Root>,
    SwitchProps
>(
    (
        {
            size,
            checked,
            loading = false,
            disabled,
            disabledTooltip,
            invalid,
            thumbIcon,
            className,
            ...props
        },
        ref,
    ) => {
        const isDisabled = disabled || loading || Boolean(disabledTooltip);

        const root = (
            <SwitchPrimitive.Root
                ref={ref}
                checked={loading ? false : checked}
                disabled={isDisabled}
                data-invalid={invalid ? "" : undefined}
                aria-invalid={invalid || undefined}
                className={cn(switchTrackVariants({ size }), className)}
                {...props}
            >
                <SwitchPrimitive.Thumb className={switchThumbVariants({ size })}>
                    {thumbIcon}
                </SwitchPrimitive.Thumb>
            </SwitchPrimitive.Root>
        );

        if (disabledTooltip) {
            return (
                <Tooltip content={disabledTooltip}>
                    <div className="inline-block leading-none">{root}</div>
                </Tooltip>
            );
        }

        return root;
    },
);
Switch.displayName = "Switch";

export { Switch };
