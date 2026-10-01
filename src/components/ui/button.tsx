"use client";

import { cn } from "@/lib/cn";
import { VariantProps } from "class-variance-authority";
import { ReactNode, forwardRef, useId } from "react";
// Direct module, not the `./icons` barrel: the barrel re-exports every
// brand logo and payment mark in the directory, and a primitive this
// widely imported should not pull them into whichever chunk lands it.
// Every other LoadingSpinner call site in the app already imports the
// module path.
import { LoadingSpinner } from "./icons/loading-spinner";
import { Tooltip } from "./tooltip";
import { buttonVariants } from "./button-variants";
import { HIT_AREA_CLASS } from "./hit-area";

export { buttonVariants };

/**
 * The geometry + touch floor the two `cn`-only branches below share with
 * `buttonVariants`.
 *
 * Both branches bypass the cva variant — they are fallbacks for shapes
 * that are not interactive buttons — so anything the cva base carries
 * has to be restated here or it is silently dropped. Two things were:
 *
 *   `pointer-coarse:min-h-11` — the WCAG 2.5.5 / Apple HIG 44px touch
 *     floor. Without it a button that is 44px tall on a phone collapses
 *     to its 28px desktop height the instant `loading` goes true — i.e.
 *     exactly while the user is most likely to tap it again. `min-h`
 *     only RAISES, so fine pointers keep the 28px density.
 *
 *   `relative` + HIT_AREA_CLASS — the square hit area (see
 *     `hit-area.ts`). The `relative` is load-bearing: without a
 *     positioning context the pseudo-element's offsets resolve against
 *     an ancestor and the hit area detaches. It paints nothing.
 *
 *     Honest about what this buys on each branch: on the `loading`
 *     branch the element carries the real `disabled` attribute, so it
 *     answers no pointer events at all and the dead corners are moot —
 *     the layer is here so the two `cn` fallbacks and the cva base stay
 *     the SAME shape and cannot drift apart silently. On the
 *     `disabledTooltip` branch it is live work: that element is
 *     focusable and hoverable, and its corners really were inert.
 *
 * The 28px rung itself stays spelled out at each branch, where the
 * mirror-the-size-scale comment explains it.
 */
const INERT_BUTTON_SHELL = cn(
  "relative",
  HIT_AREA_CLASS,
  "pointer-coarse:min-h-11",
);

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
    // Unconditional — `disabledTooltip` returns early below, and a hook
    // cannot sit behind that branch.
    const generatedId = useId();
    const reasonId = `${generatedId}-disabled-reason`;
    const labelId = `${generatedId}-label`;

    if (disabledTooltip) {
      return (
        <Tooltip content={disabledTooltip}>
          {/*
           * KEYBOARD-REACHABLE EXPLANATION.
           *
           * The wrapper used to be a plain `<div>`, which is not in the
           * tab order, so the one thing this branch exists to say — WHY
           * the control is unavailable — was reachable by hover only.
           * A keyboard or screen-reader user met a dead shape with no
           * reason attached.
           *
           * Three parts, and each does something the others do not:
           *
           *   `role="button"` + `aria-disabled` — announces it as the
           *     control it looks like, in the state it is in. A real
           *     `disabled` attribute is not an option: `disabled`
           *     removes the element from the tab order, which is the
           *     problem rather than the fix.
           *   `tabIndex={0}` — puts it IN the tab order, which is what
           *     makes the tooltip openable at all (Radix opens on
           *     `:focus-visible`, i.e. keyboard focus).
           *   `aria-describedby` → the `sr-only` span — the reason is
           *     announced on focus WITHOUT waiting for the tooltip to
           *     open, so it does not depend on the tooltip's timing or
           *     on the portal being read.
           *
           * `aria-labelledby` → the LABEL div is the fourth part, and it
           * is not decoration. Radix's Trigger needs a single child, so
           * the description has to live INSIDE this element — and the
           * accessible name of a `role="button"` is computed from its
           * contents, which would fold the reason into the name and
           * announce it twice ("Sync now, Connect a directory first.
           * Connect a directory first."). Naming the label explicitly
           * confines the name to the label. When there is no label at
           * all the attribute is omitted, so the contents algorithm
           * still applies rather than resolving to an empty name.
           *
           * No `onClick` / `onKeyDown`: focusing it must explain, never
           * activate. That is the whole difference from `buttonLikeKeys`.
           */}
          <div
            role="button"
            aria-disabled="true"
            tabIndex={0}
            aria-describedby={reasonId}
            aria-labelledby={content ? labelId : undefined}
            className={cn(
              "flex items-center justify-center gap-tight cursor-not-allowed",
              "rounded-full border border-border-subtle bg-bg-subtle text-content-subtle",
              // Focus must be VISIBLE as well as reachable — the same
              // two-stop halo the cva base uses, so a disabled control
              // and a live one focus identically.
              "focus-visible:outline-none",
              "focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--brand-default)]",
              INERT_BUTTON_SHELL,
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
                id={labelId}
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
            {/* The `aria-describedby` target. Visually hidden, always
                present — the tooltip is the sighted affordance, this is
                the announced one. */}
            <span id={reasonId} className="sr-only">
              {disabledTooltip}
            </span>
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
                INERT_BUTTON_SHELL,
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
