"use client";

/**
 * Epic 55 — shared <FormDescription> primitive.
 *
 * Helper text that sits below a form control. One canonical shape —
 * `text-xs text-content-muted mt-1.5` — so every field description
 * across the app has the same rhythm and tone.
 *
 * Used automatically by <FormField description="…"> and available
 * standalone for bespoke form layouts (e.g. settings pages that build
 * their own rows but want consistent description styling).
 */

import { cn } from "@inflect/ui/lib/cn";
import * as React from "react";

export interface FormDescriptionProps
    extends React.HTMLAttributes<HTMLParagraphElement> {}

const FormDescription = React.forwardRef<
    HTMLParagraphElement,
    FormDescriptionProps
>(({ className, children, ...props }, ref) => (
    <p
        ref={ref}
        data-form-description
        className={cn(
            "mt-1.5 text-xs text-content-muted",
            className,
        )}
        {...props}
    >
        {children}
    </p>
));

FormDescription.displayName = "FormDescription";

export { FormDescription };
