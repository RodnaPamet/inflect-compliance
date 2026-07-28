"use client";

import { cn } from "@/lib/cn";
import { VariantProps } from "class-variance-authority";
import { ReactNode, forwardRef } from "react";
import { LoadingSpinner } from "./icons";
import { Tooltip } from "./tooltip";
import { buttonVariants } from "./button-variants";

export { buttonVariants };

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  text?: ReactNode | string;
  textWrapperClassName?: string;
  shortcutClassName?: string;
  loading?: boolean;
  icon?: ReactNode;
  shortcut?: string;
  right?: ReactNode;
  disabledTooltip?: string | ReactNode;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      text,
      variant = "primary",
      size,
      className,
      textWrapperClassName,
      shortcutClassName,
      loading,
      icon,
      shortcut,
      disabledTooltip,
      right,
      children,
      ...props
    }: ButtonProps,
    forwardedRef,
  ) => {
    const content = text ?? children;

    if (disabledTooltip) {
      return (
        <Tooltip content={disabledTooltip}>
          <div
            className={cn(
              "flex items-center justify-center gap-tight cursor-not-allowed",
              "rounded-full border border-border-subtle bg-bg-subtle text-content-subtle",
              // Still Surface single-rung ladder (2026-07-28). This
              // branch does NOT route through the cva variant (it is a
              // cn-only fallback for a non-interactive shape), so it
              // must mirror the size scale in `button-variants.ts`
              // exactly. Every rung is the same 28px geometry, so the
              // mirror collapses to one unconditional line — there is
              // no longer a per-size branch to keep in sync.
              "h-7 px-[0.7rem] text-[0.76rem] tracking-[0.005em] font-[560]",
              className,
            )}
          >
            {icon}
            {content && (
              <div
                className={cn(
                  "min-w-0 truncate",
                  // Icons passed as CHILDREN (e.g. <Button><Mail/>Invite</Button>
                  // or a brand <svg>) land in this label div. Tailwind's
                  // preflight makes `svg { display: block }`, which stacks
                  // the icon ABOVE the text on its own row. Force any direct
                  // svg child inline so icon + text share one row, vertically
                  // centred, with a small gap to whichever side the text is on.
                  // The canonical `icon` prop renders OUTSIDE this div and is
                  // unaffected; text-only labels still truncate normally.
                  "[&>svg]:inline-block [&>svg]:align-middle",
                  "[&>svg:not(:last-child)]:mr-1.5 [&>svg:not(:first-child)]:ml-1.5",
                  shortcut && "flex-1 text-left",
                  textWrapperClassName,
                )}
              >
                {content}
              </div>
            )}
            {shortcut && (
              <kbd
                className={cn(
                  "hidden rounded border border-border-subtle bg-bg-subtle px-2 py-0.5 text-xs font-light text-content-subtle md:inline-block",
                  shortcutClassName,
                )}
              >
                {shortcut}
              </kbd>
            )}
          </div>
        </Tooltip>
      );
    }

    return (
      <button
        ref={forwardedRef}
        type={props.onClick ? "button" : "submit"}
        className={cn(
          props.disabled || loading
            ? cn(
                "flex items-center justify-center gap-tight whitespace-nowrap",
                "rounded-full border border-border-subtle bg-bg-subtle text-content-subtle",
                "cursor-not-allowed outline-none",
                // Still Surface single-rung ladder (2026-07-28). Mirrors
                // the size scale in `button-variants.ts`; this branch
                // bypasses the cva variant, so the two must agree. With
                // every rung at the same 28px geometry the mirror is one
                // unconditional line rather than a four-way branch.
                "h-7 px-[0.7rem] text-[0.76rem] tracking-[0.005em] font-[560]",
              )
            : buttonVariants({ variant, size }),
          className,
        )}
        disabled={props.disabled || loading}
        {...props}
      >
        {/**
         * Label centering (2026-05-31).
         *
         * The button is `justify-center` and hugs its content
         * (inline-flex, no forced width), so the WHOLE content unit —
         * `[icon][gap][label]` — is centred as one symmetric group
         * with equal padding on both sides. A leading `+ Asset`
         * therefore reads as a tidy centred unit (the `+` counted with
         * the word), not the word alone centred with the icon hanging
         * off-centre to the left.
         *
         * An earlier approach mirrored each side weight with an
         * invisible "balance ghost" to centre the LABEL (treating a
         * leading icon as decoration). That was reverted on user
         * feedback: the ghosts widened the button with one-sided blank
         * space and the `+ word` unit didn't read as centred. The
         * simplest correct rule — centre the content unit, no ghosts —
         * is what ships now. `shortcut` buttons remain the one
         * intentional exception (label left, kbd right) via the
         * `flex-1 text-left` wrapper below.
         */}
        {loading ? <LoadingSpinner className="h-4 w-4" /> : icon ? icon : null}
        {content && (
          <div
            className={cn(
              "min-w-0 truncate",
              // Icons passed as CHILDREN (e.g. <Button><Mail/>Invite</Button>
              // or a brand <svg>) land in this label div. Tailwind's
              // preflight makes `svg { display: block }`, stacking the icon
              // ABOVE the text on its own row. Force any direct svg child
              // inline so icon + text share one row, vertically centred,
              // with a small gap to whichever side the text is on. The
              // canonical `icon` prop renders OUTSIDE this div and is
              // unaffected; text-only labels still truncate normally.
              "[&>svg]:inline-block [&>svg]:align-middle",
              "[&>svg:not(:last-child)]:mr-1.5 [&>svg:not(:first-child)]:ml-1.5",
              shortcut && "flex-1 text-left",
              textWrapperClassName,
            )}
          >
            {content}
          </div>
        )}
        {shortcut && (
          <kbd
            className={cn(
              "hidden rounded px-2 py-0.5 text-xs font-light transition-all duration-75 md:inline-block",
              {
                "bg-[var(--brand-default)] text-white/70 group-hover:bg-[var(--brand-muted)]":
                  variant === "primary",
                "bg-bg-elevated text-content-muted":
                  variant === "secondary",
                "bg-bg-muted text-content-muted": variant === "ghost",
                "bg-black/25 text-white/80": variant === "destructive",
              },
              shortcutClassName,
            )}
          >
            {shortcut}
          </kbd>
        )}
        {right}
      </button>
    );
  },
);

Button.displayName = "Button";

export { Button };
