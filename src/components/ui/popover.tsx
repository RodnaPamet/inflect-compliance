"use client";

/**
 * Epic 54 — canonical Popover primitive.
 *
 * Radix Popover on desktop, Vaul Drawer on mobile (via `useMediaQuery`).
 * Powers every contextual surface in the app — filter dropdowns, column
 * toggles, future row-action menus — so all lightweight surfaces share
 * one keyboard model, one Escape behaviour, and one token palette.
 *
 * Composite API:
 *   - `<Popover content={…}>{trigger}</Popover>` — the canonical controlled
 *     form, used by 30+ filter/menu sites today.
 *   - `<Popover.Menu>` + `<Popover.Item>` — slot primitives for consistent
 *     action-menu layout (label, icon, shortcut, disabled, destructive).
 *     Use these inside `content` to keep every menu identical.
 */

import { cn } from "@/lib/cn";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { useTranslations } from "next-intl";
import {
  ButtonHTMLAttributes,
  HTMLAttributes,
  PropsWithChildren,
  ReactNode,
  WheelEventHandler,
  forwardRef,
} from "react";
import { createPortal } from "react-dom";
import { Drawer } from "vaul";
import { useMediaQuery } from "./hooks";
import { Tooltip } from "./tooltip";

export type PopoverProps = PropsWithChildren<{
  content: ReactNode | string;
  align?: "center" | "start" | "end";
  side?: "bottom" | "top" | "left" | "right";
  openPopover: boolean;
  setOpenPopover: (open: boolean) => void;
  mobileOnly?: boolean;
  forceDropdown?: boolean;
  popoverContentClassName?: string;
  onOpenAutoFocus?: PopoverPrimitive.PopoverContentProps["onOpenAutoFocus"];
  onCloseAutoFocus?: PopoverPrimitive.PopoverContentProps["onCloseAutoFocus"];
  collisionBoundary?: Element | Element[];
  sticky?: "partial" | "always";
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onWheel?: WheelEventHandler;
  sideOffset?: number;
  anchor?: ReactNode;
  /**
   * Canonical hover hint for the trigger. When set, the trigger child is wrapped
   * in `<Tooltip>` INSIDE the asChild Trigger so the popover-open click and the
   * tooltip hover both land on the same element (Radix Slot merges them). Use
   * this instead of a native `title=` on a popover trigger.
   */
  triggerTooltip?: string;
}>;

function PopoverRoot({
  children,
  content,
  align = "center",
  side = "bottom",
  openPopover,
  setOpenPopover,
  mobileOnly,
  forceDropdown,
  popoverContentClassName,
  onOpenAutoFocus,
  onCloseAutoFocus,
  collisionBoundary,
  sticky,
  onEscapeKeyDown,
  onWheel,
  sideOffset = 8,
  anchor,
  triggerTooltip,
}: PopoverProps) {
  const t = useTranslations("common.ui");
  const { isMobile } = useMediaQuery();
  // When a trigger tooltip is requested, wrap the whole Radix Trigger ELEMENT
  // (not the inner button) in <Tooltip>. Order matters: Tooltip OUTER →
  // Popover.Trigger INNER → button. The inner Popover.Trigger's asChild Slot
  // owns the open-onClick on the button, and the outer Tooltip's hover props
  // merge through it — so the popover still opens. The reverse nesting (Tooltip
  // inside the Trigger) swallowed the click: the old "gear doesn't open" bug.
  const withTooltip = (el: ReactNode) =>
    triggerTooltip ? <Tooltip content={triggerTooltip}>{el}</Tooltip> : el;

  if (!forceDropdown && (mobileOnly || isMobile)) {
    return (
      <Drawer.Root open={openPopover} onOpenChange={setOpenPopover}>
        {withTooltip(
          <Drawer.Trigger className="sm:hidden" asChild>
            {children}
          </Drawer.Trigger>,
        )}
        <Drawer.Portal>
          <Drawer.Overlay className="bg-bg-subtle fixed inset-0 z-50 bg-opacity-10 backdrop-blur" />
          <Drawer.Content
            className="surface-popup-texture fixed bottom-0 left-0 right-0 z-50 mt-24 rounded-t-[10px]"
            onEscapeKeyDown={onEscapeKeyDown}
            onPointerDownOutside={(e) => {
              // Prevent dismissal when clicking inside a toast
              if (
                e.target instanceof Element &&
                e.target.closest("[data-sonner-toast]")
              ) {
                e.preventDefault();
              }
            }}
          >
            {/* Vaul's Drawer wraps Radix Dialog under the hood, which
                requires a Title + Description for screen readers.
                Popover contents are diverse (filter menus, date pickers,
                action lists) so we ship a visually-hidden default pair
                — content-specific titles still win via Drawer.Title
                inside the `content` slot. */}
            <VisuallyHidden.Root>
              <Drawer.Title>{t("menu")}</Drawer.Title>
              <Drawer.Description>{t("popoverContentDesc")}</Drawer.Description>
            </VisuallyHidden.Root>
            <div className="sticky top-0 z-20 flex w-full items-center justify-center rounded-t-[10px] bg-inherit">
              <div className="bg-border-default my-3 h-1 w-12 rounded-full" />
            </div>
            <div className="bg-bg-default flex w-full items-center justify-center overflow-hidden pb-4 align-middle shadow-xl">
              {content}
            </div>
          </Drawer.Content>
          <Drawer.Overlay />
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <PopoverPrimitive.Root open={openPopover} onOpenChange={setOpenPopover}>
      {anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <PopoverPrimitive.Anchor asChild>{anchor}</PopoverPrimitive.Anchor>,
          document.body,
        )}
      {withTooltip(
        <PopoverPrimitive.Trigger className="sm:inline-flex" asChild>
          {children}
        </PopoverPrimitive.Trigger>,
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={sideOffset}
          align={align}
          side={side}
          className={cn(
            // B3-follow (2026-06-08): popover surfaces (user menu,
            // notifications, tenant/org switchers, comboboxes) share the
            // same brand-tinted focal-glow texture as modals/sheets/toast
            // — `.surface-popup-texture` owns background + border + the
            // glass-edge/drop-shadow, so no flat bg-bg-default/border here.
            "surface-popup-texture animate-slide-up-fade z-50 items-center rounded-lg sm:block",
            popoverContentClassName,
          )}
          sticky={sticky}
          collisionBoundary={collisionBoundary}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          onWheel={onWheel}
        >
          {content}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ─── Menu / Item slots ─────────────────────────────────────────────

/**
 * Standard menu container. Drop inside a Popover's `content` prop to
 * keep every action menu aligned on padding, width, and keyboard feel.
 */
function Menu({
    className,
    children,
    ...rest
}: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            role="menu"
            data-popover-menu
            className={cn(
                "flex min-w-[180px] flex-col gap-0.5 p-1 text-sm",
                className,
            )}
            {...rest}
        >
            {children}
        </div>
    );
}

export interface PopoverItemProps
    extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** Leading icon slot. */
    icon?: ReactNode;
    /** Trailing element (shortcut hint, badge, chevron). */
    right?: ReactNode;
    /** Destructive / danger styling — use for delete/revoke actions. */
    destructive?: boolean;
    /** Currently selected / active state (checkmark-style menus). */
    selected?: boolean;
}

/**
 * Single action row inside a menu. Token-driven, keyboard-focusable,
 * supports destructive + selected variants. Consumers supply `onClick`
 * (or `onSelect`-style handlers) and the label as children.
 */
const Item = forwardRef<HTMLButtonElement, PopoverItemProps>(function Item(
    {
        className,
        children,
        icon,
        right,
        destructive = false,
        selected = false,
        disabled,
        type = "button",
        ...rest
    },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            role="menuitem"
            data-popover-item
            data-destructive={destructive || undefined}
            data-selected={selected || undefined}
            disabled={disabled}
            className={cn(
                "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left",
                "transition-colors duration-100 ease-out motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                destructive
                    ? "text-content-error hover:bg-bg-error"
                    : "text-content-default hover:bg-bg-muted hover:text-content-emphasis",
                selected && !destructive && "bg-bg-subtle text-content-emphasis",
                className,
            )}
            {...rest}
        >
            {icon ? (
                <span className="inline-flex size-4 shrink-0 items-center justify-center text-content-muted">
                    {icon}
                </span>
            ) : null}
            <span className="flex-1 break-words">{children}</span>
            {right ? (
                <span className="ml-2 inline-flex shrink-0 items-center text-content-subtle">
                    {right}
                </span>
            ) : null}
        </button>
    );
});

/** Horizontal separator inside a menu. */
function Separator({
    className,
    ...rest
}: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            role="separator"
            data-popover-separator
            className={cn("-mx-1 my-1 h-px bg-border-subtle", className)}
            {...rest}
        />
    );
}

// ─── Composite export ─────────────────────────────────────────────

export const Popover = Object.assign(PopoverRoot, {
    Menu,
    Item,
    Separator,
});
