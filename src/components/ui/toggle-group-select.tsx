"use client";

import { cn } from "@inflect/ui/lib/cn";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { Combobox, type ComboboxOption } from "./combobox";
import type { ToggleGroupProps } from "./toggle-group";

/**
 * The below-`sm` rendering of a long group: the existing `<Combobox>`,
 * which opens as a bottom sheet on a phone. Link-mode options navigate,
 * as their `<Link>` would.
 */
export function ToggleGroupSelect({
    options,
    selected,
    selectAction,
    className,
    style,
    ariaLabel,
}: ToggleGroupProps) {
    const t = useTranslations("common.ui");
    const router = useRouter();
    const groupLabel = ariaLabel ?? t("options");
    const comboOptions: ComboboxOption[] = useMemo(
        () =>
            options.map((o) => ({
                value: o.value,
                label: o.label,
                // The Combobox has no plain `disabled`; a disabled-tooltip
                // is how it refuses an option. The label repeats as the hint.
                disabledTooltip: o.disabled ? o.label : undefined,
            })),
        [options],
    );
    const current = comboOptions.find((o) => o.value === selected) ?? null;
    const currentText =
        current && typeof current.label === "string" ? current.label : "";
    return (
        <div
            className={cn("w-full", className)}
            style={style}
            data-testid="toggle-group-select"
        >
            <Combobox
                options={comboOptions}
                selected={current}
                hideSearch
                matchTriggerWidth
                caret
                buttonProps={{
                    className: "w-full min-h-11",
                    "aria-label": currentText
                        ? `${groupLabel}: ${currentText}`
                        : groupLabel,
                }}
                setSelected={(opt) => {
                    if (!opt) return;
                    const option = options.find((o) => o.value === opt.value);
                    if (!option || option.disabled) return;
                    selectAction?.(option.value);
                    if (option.href) router.push(option.href);
                }}
            />
        </div>
    );
}

