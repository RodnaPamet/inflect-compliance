"use client";

/**
 * Epic 54 — canonical Sheet primitive.
 *
 * Persistent side panel for entity detail / inline-edit flows. Unlike
 * `<Modal>`, the Sheet keeps the list visible on desktop so users never
 * lose context when drilling into a row.
 *
 * Responsive stance:
 *   - Desktop: right-directional Vaul Drawer (side panel).
 *   - Mobile:  bottom-directional Vaul Drawer (matches Modal's mobile UX).
 *   Consumers opt out with `direction="right"` (always-right) for rare
 *   cases where the side panel must win on small screens too, or
 *   `direction="left"` for a navigation drawer, which by convention slides
 *   in from the edge the nav itself lives on.
 *
 * Token alignment, accessible title fallback, and structured slots
 * (`Sheet.Header` / `Sheet.Body` / `Sheet.Footer` / `Sheet.Actions`) keep
 * every entity detail panel consistent with the Modal surface.
 *
 * Nesting: pass `nested` to mount Vaul `NestedRoot` when the sheet is
 * rendered inside another drawer (required by Vaul for focus-trap parity).
 */

import { cn } from "@inflect/ui/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { ContentProps, type DialogProps, Drawer } from "vaul";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useMediaQuery } from "./hooks";
import { OverlayDepthProvider } from "./overlay-depth";
import { ProgressiveBlur } from "./progressive-blur";
import { Tooltip } from "./tooltip";
import {
    keyboardAvoidanceStyle,
    useKeyboardInset,
} from "@/lib/hooks/use-keyboard-inset";

// ─── Size variants (desktop width) ──────────────────────────────────

const sheetWidthVariants = cva("", {
    variants: {
        size: {
            sm: "[--sheet-width:420px]",
            md: "[--sheet-width:540px]",
            lg: "[--sheet-width:720px]",
            xl: "[--sheet-width:960px]",
        },
    },
    defaultVariants: { size: "md" },
});

// ─── Props ──────────────────────────────────────────────────────────

type SheetRootBaseProps = Omit<DialogProps, "direction" | "children"> & {
    children?: ReactNode;
    contentProps?: ContentProps;
    nested?: boolean;
    /**
     * `"responsive"` (default) — right on desktop, bottom on mobile, matching
     * Modal's mobile stance.
     * `"right"` — always right (rare; lose mobile ergonomics).
     * `"bottom"` — always bottom (special cases).
     * `"left"` — always left. For a navigation drawer: it slides in from the
     * same edge the nav rail occupies, so the panel appears to grow out of it
     * rather than arriving from the opposite side of the screen.
     */
    direction?: "responsive" | "right" | "bottom" | "left";
    /** Accessible name. Required for screen readers; visually-hidden fallback. */
    title?: string;
    /** Supplemental description wired to `aria-describedby`. */
    description?: string;
    /**
     * Override the backdrop overlay className. Default dims + blurs the page
     * behind the sheet. Pass a transparent class to keep the content behind
     * visible (e.g. the AsidePanel's mobile fallback, which should not blur
     * the table). The overlay element stays mounted either way so
     * click-outside-to-close keeps working.
     */
    overlayClassName?: string;
};

export type SheetRootProps = SheetRootBaseProps &
    VariantProps<typeof sheetWidthVariants>;

// ─── Component ──────────────────────────────────────────────────────

function SheetRoot({
    children,
    contentProps,
    nested = false,
    direction = "responsive",
    size,
    title,
    description,
    overlayClassName,
    ...rest
}: SheetRootProps) {
    const t = useTranslations("common");
    const { isMobile } = useMediaQuery();
    const RootComponent = nested ? Drawer.NestedRoot : Drawer.Root;

    // A bottom sheet sized in `vh` keeps its full height when the soft keyboard
    // opens — `vh` is the LAYOUT viewport. An inline-edit field near the bottom
    // of the panel then sits behind the keyboard.
    const keyboard = useKeyboardInset();

    const effectiveDirection: "right" | "bottom" | "left" =
        direction === "responsive"
            ? isMobile
                ? "bottom"
                : "right"
            : direction;

    // Left and right are both edge-anchored side panels — same vertical
    // pinning, same width cap, mirrored horizontal edge and slide-in vector.
    const isSide = effectiveDirection !== "bottom";

    const fallbackTitle = (
        <VisuallyHidden.Root>
            <Drawer.Title>{title ?? t("ui.sheet")}</Drawer.Title>
            <Drawer.Description>{description ?? ""}</Drawer.Description>
        </VisuallyHidden.Root>
    );

    // Vaul's `DialogProps` is a discriminated union over snapPoints; TS
    // can't narrow the rest-spread through that, so we assert the composed
    // object as `DialogProps` — both Root and NestedRoot accept the same
    // runtime shape, and `SheetRootBaseProps extends Omit<DialogProps, …>`.
    const rootProps = {
        direction: effectiveDirection,
        handleOnly: true,
        ...rest,
    } as DialogProps;

    return (
        <RootComponent {...rootProps}>
            <Drawer.Portal>
                <Drawer.Overlay
                    className={overlayClassName ?? "fixed inset-0 z-40 bg-bg-overlay backdrop-blur-sm"}
                    data-sheet-overlay
                />
                <Drawer.Content
                    {...contentProps}
                    onPointerDownOutside={(e) => {
                        if (
                            e.target instanceof Element &&
                            e.target.closest("[data-sonner-toast]")
                        )
                            e.preventDefault();
                        contentProps?.onPointerDownOutside?.(e);
                    }}
                    className={cn(
                        "@container/sheet fixed z-40 flex outline-none",
                        sheetWidthVariants({ size }),
                        effectiveDirection === "right"
                            ? [
                                  "bottom-2 right-2 top-2",
                                  "w-[min(var(--sheet-width),calc(100%-2*var(--sheet-margin)))] [--sheet-margin:8px]",
                              ]
                            : effectiveDirection === "left"
                              ? [
                                    "bottom-2 left-2 top-2",
                                    "w-[min(var(--sheet-width),calc(100%-2*var(--sheet-margin)))] [--sheet-margin:8px]",
                                ]
                              : [
                                    "inset-x-2 bottom-2",
                                    "h-[min(var(--sheet-height),calc(100vh-var(--sheet-margin)*2))] [--sheet-margin:8px] [--sheet-height:85vh]",
                                ],
                        contentProps?.className,
                    )}
                    style={
                        {
                            // Vaul slides the panel in from its anchored edge
                            // along this offset. A left sheet starts OFF-SCREEN
                            // TO THE LEFT, so the sign flips — the same positive
                            // value would animate it in from the right while it
                            // is pinned left, i.e. across the whole viewport.
                            "--initial-transform":
                                effectiveDirection === "left"
                                    ? "calc(-100% - 8px)"
                                    : "calc(100% + 8px)",
                            userSelect: "auto",
                            // KEYBOARD AVOIDANCE, merged into the existing style
                            // rather than added as a second `style` prop (JSX
                            // takes the last one and silently drops the first —
                            // the bug would have been that the sheet's own
                            // transform vanished).
                            ...keyboardAvoidanceStyle(keyboard),
                            ...contentProps?.style,
                        } as React.CSSProperties
                    }
                    data-sheet-direction={effectiveDirection}
                >
                    <div
                        data-sheet-content
                        className={cn(
                            // B3 — brand-tinted focal-glow texture + elegant
                            // border + glass edge (see globals.css).
                            "surface-popup-texture flex size-full grow flex-col overflow-hidden rounded-lg text-content-emphasis",
                        )}
                    >
                        {fallbackTitle}
                        {!isSide ? <DrawerHandle /> : null}
                        {/* A Sheet IS a drawer. Anything inside it is nested. */}
                        <OverlayDepthProvider>{children}</OverlayDepthProvider>
                    </div>
                </Drawer.Content>
            </Drawer.Portal>
        </RootComponent>
    );
}

// Top drag-handle on the bottom-drawer variant (mobile).
function DrawerHandle() {
    return (
        <div className="sticky top-0 z-20 flex shrink-0 items-center justify-center rounded-t-[10px] bg-inherit">
            <div className="my-3 h-1 w-12 rounded-full bg-border-emphasis" />
        </div>
    );
}

// ─── Structured slots ───────────────────────────────────────────────

function Title({ className, ...rest }: ComponentProps<typeof Drawer.Title>) {
    return (
        <Drawer.Title
            className={cn(
                "text-lg font-semibold text-content-emphasis",
                className,
            )}
            {...rest}
        />
    );
}

function Description({
    className,
    ...rest
}: ComponentProps<typeof Drawer.Description>) {
    return (
        <Drawer.Description
            className={cn("text-sm text-content-muted", className)}
            {...rest}
        />
    );
}

function Header({
    title,
    description,
    className,
    children,
    showCloseButton = true,
    ...rest
}: HTMLAttributes<HTMLDivElement> & {
    title?: ReactNode;
    description?: ReactNode;
    /** Toggle the built-in close button. Default: true. */
    showCloseButton?: boolean;
}) {
    const t = useTranslations("common");
    return (
        <div
            data-sheet-header
            className={cn(
                "flex shrink-0 items-start justify-between gap-compact border-b border-border-subtle px-5 py-4",
                className,
            )}
            {...rest}
        >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                {title ? <Title>{title}</Title> : null}
                {description ? <Description>{description}</Description> : null}
                {children}
            </div>
            {showCloseButton ? (
                <Tooltip content={t("close")} shortcut="Esc">
                    <Drawer.Close asChild>
                        <button
                            type="button"
                            aria-label={t("close")}
                            data-sheet-close
                            className="shrink-0 rounded-md p-1.5 text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <X className="size-4" />
                        </button>
                    </Drawer.Close>
                </Tooltip>
            ) : null}
        </div>
    );
}

type ProgressiveBlurEdge = boolean | "top" | "bottom" | "both";

interface BodyProps extends HTMLAttributes<HTMLDivElement> {
    /**
     * Epic 64 — paint a `<ProgressiveBlur>` overlay at the body's
     * scroll edge so long content tapers off rather than abruptly
     * cutting at the footer. `true` shorthand = `"both"`.
     *
     * Off by default to keep every existing call site visually
     * unchanged. Opt in on long-form sheets (linked items panels,
     * scrollable forms) where the affordance materially helps.
     */
    progressiveBlur?: ProgressiveBlurEdge;
}

function Body({ className, progressiveBlur = false, children, ...rest }: BodyProps) {
    if (!progressiveBlur) {
        return (
            <div
                data-sheet-body
                className={cn(
                    "scrollbar-thin flex-1 overflow-y-auto px-5 py-4 text-sm text-content-default",
                    className,
                )}
                {...rest}
            >
                {children}
            </div>
        );
    }
    const edge = progressiveBlur === true ? "both" : progressiveBlur;
    return (
        <div
            data-sheet-body
            data-sheet-body-progressive-blur={edge}
            className={cn(
                "scrollbar-thin relative flex-1 overflow-y-auto px-5 py-4 text-sm text-content-default",
                className,
            )}
            {...rest}
        >
            {children}
            <ProgressiveBlur side={edge} size="3rem" />
        </div>
    );
}

function Footer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            data-sheet-footer
            className={cn(
                "flex shrink-0 items-center justify-end gap-tight border-t border-border-subtle px-5 py-3",
                className,
            )}
            {...rest}
        />
    );
}

/**
 * Canonical Cancel | Save action row — mirrors `Modal.Actions` so detail
 * panels and modals share a single footer vocabulary.
 */
function Actions({
    className,
    children,
    align = "right",
    ...rest
}: HTMLAttributes<HTMLDivElement> & { align?: "left" | "right" | "between" }) {
    return (
        <Footer
            className={cn(
                align === "left" && "justify-start",
                align === "between" && "justify-between",
                className,
            )}
            {...rest}
        >
            {children}
        </Footer>
    );
}

function Close(props: ComponentProps<typeof Drawer.Close>) {
    return <Drawer.Close {...props} />;
}

export const Sheet = Object.assign(SheetRoot, {
    Title,
    Description,
    Header,
    Body,
    Footer,
    Actions,
    Close,
});
