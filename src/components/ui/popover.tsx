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
  // Aliased: the bare name is the DOM event, which `onEscapeKeyDown` below
  // already means and Radix hands it.
  KeyboardEvent as ReactKeyboardEvent,
  PropsWithChildren,
  ReactNode,
  WheelEventHandler,
  forwardRef,
} from "react";
import { createPortal } from "react-dom";
import { Drawer } from "vaul";
import { useMediaQuery } from "./hooks";
import { OverlayDepthProvider, useIsNestedInOverlay } from "./overlay-depth";
import { Tooltip } from "./tooltip";
import {
  keyboardAvoidanceStyle,
  useKeyboardInset,
} from "@/lib/hooks/use-keyboard-inset";

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

  // The soft keyboard covers the bottom of the screen. This overlay caps its
  // height in `vh` — the LAYOUT viewport — which does not shrink when the
  // keyboard opens, so any input near the bottom ends up BEHIND it. The user is
  // typing into something they cannot see.
  const keyboard = useKeyboardInset();

  // Am I already inside a bottom sheet? If so, presenting as a SECOND sheet
  // stacks two drawers — overlapping scroll locks, a drag gesture that
  // dismisses the wrong one, and an escape key that closes both or neither.
  //
  // This is what `forceDropdown` was for. It is an opt-out every call site had
  // to remember, in a situation the call site frequently cannot see: whether a
  // Combobox is inside a Modal depends on where it was USED, not how it was
  // written. A shared form component has no idea.
  //
  // So ask the tree. `forceDropdown` stays as an explicit override.
  const nested = useIsNestedInOverlay();

  const { isMobile } = useMediaQuery();
  // When a trigger tooltip is requested, wrap the whole Radix Trigger ELEMENT
  // (not the inner button) in <Tooltip>. Order matters: Tooltip OUTER →
  // Popover.Trigger INNER → button. The inner Popover.Trigger's asChild Slot
  // owns the open-onClick on the button, and the outer Tooltip's hover props
  // merge through it — so the popover still opens. The reverse nesting (Tooltip
  // inside the Trigger) swallowed the click: the old "gear doesn't open" bug.
  const withTooltip = (el: ReactNode) =>
    triggerTooltip ? <Tooltip content={triggerTooltip}>{el}</Tooltip> : el;

  if (!forceDropdown && !nested && (mobileOnly || isMobile)) {
    return (
      <Drawer.Root open={openPopover} onOpenChange={setOpenPopover}>
        {withTooltip(
          <Drawer.Trigger className="sm:hidden" asChild>
            {children}
          </Drawer.Trigger>,
        )}
        <Drawer.Portal>
          {/* ONE overlay. A second `<Drawer.Overlay />` used to be rendered
              after `Drawer.Content` below, which stacked two backdrops: the
              blur applied twice and the second element sat ABOVE the content in
              paint order. */}
          <Drawer.Overlay className="bg-bg-subtle/10 fixed inset-0 z-50 backdrop-blur" />
          <Drawer.Content
            data-popover-drawer
            // KEYBOARD AVOIDANCE. This sheet is bottom-anchored, so the soft
            // keyboard opens directly over it. See use-keyboard-inset.ts.
            style={keyboardAvoidanceStyle(keyboard)}
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
              {/* This popover IS a bottom sheet. Anything inside it is nested,
                  so a Combobox in here must present as a dropdown, not a second
                  sheet. */}
              <OverlayDepthProvider>{content}</OverlayDepthProvider>
            </div>
          </Drawer.Content>
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
          // A forceDropdown popover (a searchable Combobox inside a modal) is
          // ALSO affected: the list hangs below the input and the keyboard
          // covers it. Cap it to the visible viewport too.
          style={keyboardAvoidanceStyle(keyboard)}
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
 * Anything a menu can hold that takes focus.
 *
 * Written with UNQUOTED attribute values — valid CSS, and deliberately not the
 * same text as the `role="menuitem"` attribute on `Item` below. With the quoted
 * spelling this constant was a second textual home for that attribute, so a
 * guard asserting "Item renders role=menuitem" would have stayed green with the
 * attribute deleted and only the selector left.
 */
const MENU_ITEM = "[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]";

/**
 * Arrow keys, Home and End move focus between items, wrapping at the ends.
 *
 * `role="menu"` is a promise to assistive technology: a screen reader
 * announces a menu and its user reaches for the arrow keys, because that is
 * the ARIA menu pattern. Tab alone — all this container used to offer — moves
 * through the items and then straight out of the popover, which closes it.
 *
 * Disabled items are skipped: focus that lands on one goes nowhere.
 */
function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(MENU_ITEM),
    ).filter(
        (el) =>
            !el.hasAttribute("disabled") &&
            el.getAttribute("aria-disabled") !== "true",
    );
    if (items.length === 0) return;

    // Only now: a menu with nothing focusable should not swallow the page's keys.
    event.preventDefault();

    const at = items.indexOf(
        event.currentTarget.ownerDocument.activeElement as HTMLElement,
    );
    const last = items.length - 1;
    const next =
        event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : event.key === "ArrowDown"
                ? at === -1 || at === last
                    ? 0
                    : at + 1
                : at <= 0
                  ? last
                  : at - 1;

    items[next]!.focus();
}

/**
 * Standard menu container. Drop inside a Popover's `content` prop to
 * keep every action menu aligned on padding, width, and keyboard feel.
 */
function Menu({
    className,
    children,
    onKeyDown,
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
            onKeyDown={(event) => {
                // A caller's handler runs first and may claim the key.
                onKeyDown?.(event);
                if (!event.defaultPrevented) moveMenuFocus(event);
            }}
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
