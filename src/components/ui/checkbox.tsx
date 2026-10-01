"use client";

/**
 * Epic 55 — shared <Checkbox> primitive.
 *
 * Wraps `@radix-ui/react-checkbox` with semantic-token styling and a
 * CVA-sized API so checkboxes look consistent next to inputs of
 * matching size (sm: 16px, md: 20px, lg: 24px).
 *
 * States covered by the variant:
 *   - unchecked → transparent background, default border
 *   - checked / indeterminate → brand-emphasis background, inverted icon
 *   - disabled → semi-opaque, cursor-not-allowed
 *   - invalid (`data-invalid=""` attr) → error-border + error-ring
 *
 * The invalid state is a data attribute rather than a prop branch so
 * `<FormField>` can toggle it declaratively from the wrapper.
 */

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { Check2, Minus } from "./icons";

export const checkboxVariants = cva(
    [
        "peer shrink-0 rounded-md border transition-colors",
        // The EDGE is the whole control: an unchecked checkbox is a box and
        // nothing else, so its border is what WCAG 2.1 1.4.11 measures. It
        // rode `border-border-default` — 1.36:1 dark, 1.20:1 light, both well
        // under the 3:1 minimum. `border-border-strong` is the token that
        // reaches it (3.50 dark / 3.51 light, measured in tokens.css).
        "bg-bg-default border-border-strong text-content-inverted",
        // Hover rides the brand edge the checked state already uses, rather
        // than `border-border-emphasis` (2.44 dark / 1.59 light) — against a
        // 3.5:1 rest edge that token is a step DOWN, so hovering would have
        // dropped the boundary back below the floor the line above just met.
        "hover:border-brand-emphasis",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
        "data-[state=checked]:bg-brand-emphasis data-[state=checked]:border-brand-emphasis",
        "data-[state=indeterminate]:bg-brand-emphasis data-[state=indeterminate]:border-brand-emphasis",
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

const iconSizeForCheckbox = {
    sm: "size-2.5",
    md: "size-3",
    lg: "size-3.5",
} as const;

export interface CheckboxProps
    extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
        VariantProps<typeof checkboxVariants> {
    /** Surface the invalid state without prop drilling. */
    invalid?: boolean;
}

const Checkbox = forwardRef<
    React.ElementRef<typeof CheckboxPrimitive.Root>,
    CheckboxProps
>(({ className, size, invalid, ...props }, ref) => (
    <CheckboxPrimitive.Root
        ref={ref}
        data-invalid={invalid ? "" : undefined}
        aria-invalid={invalid || undefined}
        className={cn(checkboxVariants({ size }), className)}
        {...props}
    >
        <CheckboxPrimitive.Indicator className="group/indicator flex items-center justify-center text-content-inverted">
            <Check2
                className={cn(
                    iconSizeForCheckbox[size ?? "md"],
                    "group-data-[state=indeterminate]/indicator:hidden",
                )}
            />
            <Minus
                className={cn(
                    iconSizeForCheckbox[size ?? "md"],
                    "group-data-[state=checked]/indicator:hidden",
                )}
            />
        </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
