import { cn } from "@inflect/ui/lib/cn";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

// R20-PR-C — labels rhyme with button-md typography. `text-sm
// font-medium` already matched; adding `tracking-[-0.005em]` (the
// button-md tracking) gives form labels the same subtle confidence
// the button family wears. A focused input + its label now share
// not just border tone (PR-B) but typographic rhythm too — the
// "expensive type" effect on the whole form row.
const labelVariants = cva(
  "text-sm font-medium leading-none tracking-[-0.005em] text-content-emphasis peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants(), className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
