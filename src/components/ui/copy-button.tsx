/**
 * CopyButton — Epic 56 inline copy affordance.
 *
 * Icon-only button that copies a string to the clipboard, flashes a check
 * mark, and emits a subtle toast. Wraps the primitive in a Tooltip so the
 * hover/focus hint tells the user what they're about to copy.
 *
 *   <CopyButton value={apiKey} label="Copy API key" />
 *   <CopyButton value={sharedUrl} label="Copy share link" onCopy={audit.copy} />
 *
 * Behavior:
 *   - Never auto-fires — requires an explicit click / keyboard activation.
 *   - Swallows the event so parent rows / accordions don't react.
 *   - Surfaces failures with an error toast; inline icon flips back to
 *     the copy glyph so the user can retry.
 *   - Fires `onCopy(value)` only on success, once per click, so callers
 *     can audit-log reveal-and-copy actions on secrets without double-
 *     logging on retries.
 */

"use client";

import { cn } from "@inflect/ui/lib/cn";
import { type VariantProps, cva } from "class-variance-authority";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { forwardRef } from "react";
import { useToast } from "@inflect/ui/components/ui/hooks/use-toast";
import { Tooltip } from "./tooltip";
import { useCopyToClipboard } from "./hooks";

const copyButtonVariants = cva(
    [
        "group inline-flex items-center justify-center rounded-md",
        "text-content-muted transition-colors duration-75",
        "hover:bg-bg-muted hover:text-content-default",
        "active:bg-bg-subtle",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-content-muted",
    ].join(" "),
    {
        variants: {
            size: {
                sm: "h-6 w-6",
                md: "h-7 w-7",
                lg: "h-8 w-8",
            },
            variant: {
                ghost: "bg-transparent",
                subtle: "bg-bg-subtle",
            },
        },
        defaultVariants: {
            size: "md",
            variant: "ghost",
        },
    },
);

export interface CopyButtonProps
    extends VariantProps<typeof copyButtonVariants> {
    /** Value written to the clipboard. */
    value: string;
    /**
     * Accessible label and tooltip content. Defaults to "Copy". Prefer a
     * specific label when the page has multiple copyable values ("Copy
     * API key", "Copy share link") so screen reader users aren't left
     * with ambiguous "Copy" / "Copy" / "Copy" announcements.
     */
    label?: string;
    /** Toast shown on success. Defaults to `{label} copied`. */
    successMessage?: string;
    /** Toast shown on error. Defaults to "Copy failed". */
    errorMessage?: string;
    /** Override the default Copy icon (e.g., `Link` for a share URL). */
    icon?: LucideIcon;
    /** Instrumentation hook fired once per successful copy. */
    onCopy?: (value: string) => void;
    /** Disables both the button and the underlying clipboard write. */
    disabled?: boolean;
    className?: string;
    /** Opt out of the Tooltip wrapper (e.g., inside another tooltip). */
    disableTooltip?: boolean;
}

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(
    function CopyButton(
        {
            value,
            label,
            successMessage,
            errorMessage,
            icon,
            size,
            variant,
            onCopy,
            disabled,
            className,
            disableTooltip,
        },
        ref,
    ) {
        const t = useTranslations("common.copy");
        const resolvedLabel = label ?? t("copy");
        const resolvedError = errorMessage ?? t("copyFailed");
        const { copy, copied } = useCopyToClipboard();
        const toast = useToast();
        const Glyph = icon ?? Copy;
        const iconSize = size === "sm" ? "h-3 w-3" : size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5";

        const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            if (disabled) return;
            const ok = await copy(value);
            if (ok) {
                onCopy?.(value);
                toast.success(
                    successMessage ?? t("labelCopied", { label: resolvedLabel }),
                );
            } else {
                toast.error(resolvedError);
            }
        };

        const button = (
            <button
                ref={ref}
                type="button"
                aria-label={resolvedLabel}
                aria-live="polite"
                disabled={disabled}
                data-copied={copied ? "true" : undefined}
                onClick={handleClick}
                className={cn(copyButtonVariants({ size, variant }), className)}
            >
                {copied ? (
                    <Check
                        className={cn(iconSize, "text-content-success")}
                        aria-hidden="true"
                    />
                ) : (
                    <Glyph className={iconSize} aria-hidden="true" />
                )}
            </button>
        );

        if (disableTooltip || disabled) return button;
        return (
            <Tooltip content={copied ? t("copied") : resolvedLabel} disableHoverableContent>
                {button}
            </Tooltip>
        );
    },
);
