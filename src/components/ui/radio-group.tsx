"use client";

/**
 * Epic 55 — shared <RadioGroup> + <RadioGroupItem> primitives.
 *
 * Wraps `@radix-ui/react-radio-group` with semantic-token styling.
 * Drops the legacy `border-primary` classes; tokens are brand-* for
 * the selected dot and border-strong for the ring.
 *
 * Size variant aligns with Checkbox so mixed groups of radio + check
 * boxes line up vertically in the same form.
 */

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

export const radioItemVariants = cva(
    [
        "aspect-square shrink-0 rounded-full border transition-colors",
        // Same edge-is-the-control reasoning as Checkbox: an unselected radio
        // is a ring and nothing else, and `border-border-default` measured
        // 1.36:1 dark / 1.20:1 light against WCAG 2.1 1.4.11's 3:1.
        // `border-border-strong` is 3.50 / 3.51 (see tokens.css).
        "bg-bg-default border-border-strong",
        // Hover on the brand edge, not `border-border-emphasis` — that token
        // is 2.44 dark / 1.59 light, i.e. BELOW the rest edge above, so it
        // would have made hover the least visible state of the three.
        "hover:border-brand-emphasis",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
        "data-[state=checked]:border-brand-emphasis data-[state=checked]:text-brand-emphasis",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[invalid]:border-border-error data-[invalid]:focus-visible:ring-border-error",
    ],
    {
        variants: {
            size: {
                sm: "h-4 w-4",
                md: "h-5 w-5",
                lg: "h-6 w-6",
            },
        },
        defaultVariants: { size: "md" },
    },
);

const RadioGroup = React.forwardRef<
    React.ElementRef<typeof RadioGroupPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
    <RadioGroupPrimitive.Root
        ref={ref}
        className={cn("grid gap-tight", className)}
        {...props}
    />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

export interface RadioGroupItemProps
    extends React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>,
        VariantProps<typeof radioItemVariants> {
    invalid?: boolean;
}

const indicatorSizeForRadio = {
    sm: "h-2 w-2",
    md: "h-2.5 w-2.5",
    lg: "h-3 w-3",
} as const;

const RadioGroupItem = React.forwardRef<
    React.ElementRef<typeof RadioGroupPrimitive.Item>,
    RadioGroupItemProps
>(({ className, size, invalid, ...props }, ref) => (
    <RadioGroupPrimitive.Item
        ref={ref}
        data-invalid={invalid ? "" : undefined}
        aria-invalid={invalid || undefined}
        className={cn(radioItemVariants({ size }), className)}
        {...props}
    >
        <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
            <span
                className={cn(
                    "rounded-full bg-brand-emphasis",
                    indicatorSizeForRadio[size ?? "md"],
                )}
            />
        </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
