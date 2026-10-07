"use client";

import { cn } from "@inflect/ui/lib/cn";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { Plus } from "./icons";

/**
 * Epic 60 polish primitive — Accordion.
 *
 * Thin styled wrapper over Radix's accordion primitive so we inherit the
 * keyboard contract (Arrow / Home / End navigation across headers,
 * Enter / Space to toggle) and ARIA semantics (`role="region"` on the
 * expanded panel, `aria-expanded` on the trigger) for free.
 *
 * The styling is what we own: token-backed borders/text, a single
 * trigger icon (chevron OR plus, not both), and size variants for
 * dense vs. reading contexts. Everything re-themes automatically via
 * the Epic 51 token system.
 */

const accordionItemVariants = cva("last:border-none", {
    variants: {
        density: {
            default: "border-b border-b-border-subtle py-3",
            compact: "border-b border-b-border-subtle py-2",
            flush: "", // no border — caller wraps with their own divider
        },
    },
    defaultVariants: { density: "default" },
});

const accordionTriggerVariants = cva(
    "flex flex-1 items-center justify-between font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm",
    {
        variants: {
            size: {
                default: "text-base sm:text-lg",
                sm: "text-sm",
            },
            variant: {
                chevron: "[&[data-state=open]>svg]:rotate-180",
                plus: "[&[data-state=open]>svg]:rotate-45",
            },
        },
        defaultVariants: { size: "default", variant: "chevron" },
    },
);

const Accordion = AccordionPrimitive.Root;

export type AccordionItemProps = React.ComponentPropsWithoutRef<
    typeof AccordionPrimitive.Item
> &
    VariantProps<typeof accordionItemVariants>;

const AccordionItem = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Item>,
    AccordionItemProps
>(({ className, density, ...props }, ref) => (
    <AccordionPrimitive.Item
        ref={ref}
        className={cn(accordionItemVariants({ density }), className)}
        {...props}
    />
));
AccordionItem.displayName = "AccordionItem";

export type AccordionTriggerProps = React.ComponentPropsWithoutRef<
    typeof AccordionPrimitive.Trigger
> &
    VariantProps<typeof accordionTriggerVariants>;

const AccordionTrigger = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Trigger>,
    AccordionTriggerProps
>(({ className, children, size, variant, ...props }, ref) => {
    const Icon = variant === "plus" ? Plus : ChevronDown;
    return (
        <AccordionPrimitive.Header className="flex">
            <AccordionPrimitive.Trigger
                ref={ref}
                className={cn(
                    accordionTriggerVariants({ size, variant }),
                    className,
                )}
                {...props}
            >
                {children}
                <Icon
                    aria-hidden
                    className="h-5 w-5 flex-none transition-transform duration-300"
                />
            </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
    );
});
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const accordionContentVariants = cva(
    "overflow-hidden text-content-muted data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
    {
        variants: {
            size: {
                default: "text-sm sm:text-base",
                sm: "text-xs sm:text-sm",
            },
        },
        defaultVariants: { size: "default" },
    },
);

export type AccordionContentProps = React.ComponentPropsWithoutRef<
    typeof AccordionPrimitive.Content
> &
    VariantProps<typeof accordionContentVariants>;

const AccordionContent = React.forwardRef<
    React.ElementRef<typeof AccordionPrimitive.Content>,
    AccordionContentProps
>(({ className, children, size, ...props }, ref) => (
    <AccordionPrimitive.Content
        ref={ref}
        className={cn(accordionContentVariants({ size }), className)}
        {...props}
    >
        {children}
    </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
