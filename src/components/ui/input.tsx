"use client";

/**
 * Epic 55 — shared <Input> primitive.
 *
 * Token-backed, CVA-sized, accessible text/number/password/etc. input
 * that composes cleanly with <Label> and <FormField>. Keeps the legacy
 * password-toggle + inline-error affordances from the original port but
 * pivots every colour to the Epic 51 semantic token palette so the same
 * component works in dark + light themes.
 *
 * API surface (props):
 *   - Standard HTMLInputElement attrs (value, onChange, placeholder, …).
 *   - `size`: "sm" | "md" | "lg" — CVA variant, default "md".
 *   - `invalid`: boolean — toggles error styling and `aria-invalid`.
 *   - `error`: string — renders a role="alert" hint below the input.
 *     Supplying `error` implies `invalid`.
 *   - `description`: string — renders a muted hint below the input.
 *
 * Accessibility:
 *   - `aria-invalid` mirrors `invalid` / presence of `error`.
 *   - `aria-describedby` auto-links to the error + description elements
 *     when an `id` is supplied. Downstream `<FormField>` wraps both in
 *     one id-linked package.
 */

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Eye, EyeSlash } from "./icons";

// ─── CVA ────────────────────────────────────────────────────────────

// R20-PR-B — Input migrated to the R20 control-parity edge tokens.
// Same shape as before, but the border / hover / focus channels
// now ride `--ctrl-edge-rest` / `--ctrl-edge-hover` / `--ctrl-edge-focus`
// so a focused Input feels like a cousin of a focused Button rather
// than an unrelated control. The Tailwind ring is dropped in favour
// of a brand-tinted box-shadow halo on focus — the halo composes
// cleanly with future iridescent input edges (deferred) and reads
// as the same "warm focus glow" the R20 button family wears.
//
// The `controlEdge` recipe from `control-variants.ts` carries the
// border + hover-border + focus-shadow + transition; the cva here
// adds Input-specific surface chrome (bg, text colour, disabled /
// read-only states) and the size scale.
export const inputVariants = cva(
    [
        // R22-PR-A — radius mirror of button-variants.ts (12→10px).
        "w-full rounded-[8px] text-sm",
        // Mobile touch target — 44px min height on coarse pointers (min-height
        // only raises, so the dense desktop sizes h-8/9/10 are unchanged).
        "pointer-coarse:min-h-11",
        "bg-bg-default text-content-emphasis placeholder-content-subtle",
        "focus:outline-none focus-visible:outline-none",
        "border border-[var(--ctrl-edge-rest)]",
        "hover:border-[var(--ctrl-edge-hover)]",
        "focus-visible:shadow-[var(--ctrl-edge-focus)]",
        "transition-colors duration-150 motion-reduce:transition-none",
        "disabled:cursor-not-allowed disabled:bg-bg-muted disabled:text-content-muted disabled:hover:border-[var(--ctrl-edge-rest)]",
        "read-only:bg-bg-muted read-only:text-content-muted read-only:hover:border-[var(--ctrl-edge-rest)]",
    ],
    {
        variants: {
            size: {
                sm: "h-8 px-2.5 text-xs",
                md: "h-9 px-3",
                lg: "h-10 px-3.5",
            },
            invalid: {
                true: "border-border-error text-content-error placeholder-content-error/60 focus-visible:border-border-error focus-visible:shadow-[0_0_0_3px_rgb(220_38_38_/_0.20)] hover:border-border-error",
                false: "",
            },
        },
        defaultVariants: { size: "md", invalid: false },
    },
);

// ─── Props ──────────────────────────────────────────────────────────

/**
 * Maps an HTML input `type` to the `inputMode` that brings up the right
 * mobile keyboard. Used as the default when a caller doesn't pass an
 * explicit `inputMode`.
 */
const TYPE_TO_INPUTMODE: Record<
    string,
    React.HTMLAttributes<HTMLInputElement>["inputMode"]
> = {
    email: "email",
    tel: "tel",
    number: "numeric",
    search: "search",
    url: "url",
};

/**
 * The GO key on the on-screen keyboard.
 *
 * `enterKeyHint` changes the bottom-right key from a generic "return" to
 * something that says what will actually happen: Search, Go, Send, Next,
 * Done.
 *
 * It is invisible on a desktop and it is the difference, on a phone,
 * between a user knowing that pressing that key will submit the form and
 * a user not pressing it at all. The app-wide count before this change
 * was ZERO.
 */
const TYPE_TO_ENTERKEYHINT: Record<
    string,
    React.HTMLAttributes<HTMLInputElement>["enterKeyHint"]
> = {
    search: "search",
    email: "next",
    tel: "next",
    url: "go",
};

/**
 * Autofill.
 *
 * A password manager can only fill a field it can IDENTIFY, and
 * `autoComplete` is how it does that. Without it the browser either
 * offers nothing, or — worse — offers the wrong thing, and the user's
 * saved password does not appear on the one screen where they needed it.
 *
 * The regression class is SILENT: nothing errors, nothing looks broken,
 * the field simply never autofills and the user assumes the app is bad.
 *
 * This map covers what is DERIVABLE from `type`. A login form's
 * `autoComplete="current-password"` versus a reset form's
 * `"new-password"` is NOT derivable — the type is the same in both — so
 * those stay explicit at the call site, and the map below deliberately
 * holds no entry for that type: the wrong guess is worse than none,
 * because the browser will confidently fill a stale secret into a
 * "choose a new one" field.
 */
const TYPE_TO_AUTOCOMPLETE: Record<string, string> = {
    email: "email",
    tel: "tel",
    url: "url",
};

type CvaInputProps = VariantProps<typeof inputVariants>;

export interface InputProps
    extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
        Omit<CvaInputProps, "invalid"> {
    /** Show error styling + render an `role="alert"` hint below. */
    error?: string;
    /** Muted helper text rendered below the input. */
    description?: string;
    /** Force invalid styling (used when error is surfaced elsewhere). */
    invalid?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    (
        {
            className,
            type,
            size,
            invalid,
            error,
            description,
            id,
            "aria-describedby": ariaDescribedBy,
            ...props
        },
        ref,
    ) => {
        const t = useTranslations("common.ui");
        const [isPasswordVisible, setIsPasswordVisible] = React.useState(false);
        const isPassword = type === "password";
        const effectiveType = isPassword && isPasswordVisible ? "text" : type;

        // Mobile keyboard affordance — derive `inputMode` from `type` when the
        // caller hasn't set one, so a correctly-typed field (email/tel/number/
        // search/url) brings up the right on-screen keyboard. Explicit
        // `inputMode` on props always wins.
        const derivedInputMode = TYPE_TO_INPUTMODE[type ?? ""];
        const inputMode = props.inputMode ?? derivedInputMode;

        // The keyboard's action key. Explicit prop always wins.
        const enterKeyHint =
            props.enterKeyHint ?? TYPE_TO_ENTERKEYHINT[type ?? ""];

        // Autofill, where the type makes it unambiguous. See the map above
        // for why the secret-entry type deliberately has no default.
        const autoComplete =
            props.autoComplete ?? TYPE_TO_AUTOCOMPLETE[type ?? ""];

        // Search hygiene.
        //
        // A phone capitalises the first letter of every field by default and
        // runs a spellchecker over it. In a search box that means the user
        // types a lowercase term, the phone sends it capitalised, and a red
        // squiggle appears under a name that is spelled perfectly correctly.
        // Neither is what anyone wants.
        const isSearch = type === "search";
        const autoCapitalize =
            props.autoCapitalize ?? (isSearch ? "none" : undefined);
        const spellCheck = props.spellCheck ?? (isSearch ? false : undefined);

        const hasError = Boolean(error);
        const effectiveInvalid = invalid || hasError;

        // Chain aria-describedby so consumers who pass their own ids
        // keep working; we append our own description/error ids when
        // the input has an id of its own.
        const errorId = id && hasError ? `${id}-error` : undefined;
        const descId = id && description ? `${id}-description` : undefined;
        const describedBy =
            [ariaDescribedBy, descId, errorId].filter(Boolean).join(" ") ||
            undefined;

        return (
            <div className="w-full">
                {/* `group` is load-bearing: the error icon and the reveal
                    toggle below swap on `group-hover`, and without a `group`
                    ancestor neither variant ever applies — which left the
                    toggle at `opacity-0` forever on a password field that
                    also carried an error. */}
                <div className="group relative flex">
                    <input
                        type={effectiveType}
                        inputMode={inputMode}
                        enterKeyHint={enterKeyHint}
                        autoComplete={autoComplete}
                        autoCapitalize={autoCapitalize}
                        spellCheck={spellCheck}
                        id={id}
                        ref={ref}
                        aria-invalid={effectiveInvalid || undefined}
                        aria-describedby={describedBy}
                        className={cn(
                            inputVariants({ size, invalid: effectiveInvalid }),
                            // Reserve room on the right for the error icon
                            // and/or password toggle so the text doesn't
                            // slide under them.
                            (hasError || isPassword) && "pr-9",
                            hasError && isPassword && "pr-14",
                            className,
                        )}
                        {...props}
                    />

                    {hasError && (
                        <div
                            className={cn(
                                "pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5",
                                isPassword && "transition-opacity group-hover:opacity-0",
                            )}
                        >
                            <AlertCircle
                                className="size-5 text-content-error"
                                aria-hidden="true"
                            />
                        </div>
                    )}

                    {isPassword && (
                        <button
                            type="button"
                            onClick={() => setIsPasswordVisible((v) => !v)}
                            className={cn(
                                "absolute inset-y-0 right-0 flex items-center px-2.5 text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                // `focus-visible:opacity-100` is what makes the
                                // error variant reachable by keyboard: hover is
                                // not available to a Tab user, so without it the
                                // toggle would take focus while invisible.
                                hasError &&
                                    "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
                            )}
                            aria-label={
                                isPasswordVisible
                                    ? t("hidePassword")
                                    : t("showPassword")
                            }
                            aria-pressed={isPasswordVisible}
                        >
                            {isPasswordVisible ? (
                                <Eye className="size-4" aria-hidden="true" />
                            ) : (
                                <EyeSlash className="size-4" aria-hidden="true" />
                            )}
                        </button>
                    )}
                </div>

                {description && !hasError && (
                    <p
                        id={descId}
                        className="mt-1.5 text-xs text-content-muted"
                    >
                        {description}
                    </p>
                )}

                {hasError && (
                    <p
                        id={errorId}
                        role="alert"
                        aria-live="polite"
                        className="mt-1.5 text-xs text-content-error"
                    >
                        {error}
                    </p>
                )}
            </div>
        );
    },
);

Input.displayName = "Input";

export { Input };
