"use client";

/**
 * Combobox message resolution.
 *
 * The Combobox exposes four user-visible strings: `searchPlaceholder`,
 * `placeholder`, `emptyState`, and the create-row label. Each is
 * overridable per call via props.
 *
 * A caller that passes none of them still renders in the viewer's
 * locale: `<Combobox>` resolves its defaults itself, by handing
 * `useTranslations('ui.combobox')` to `getComboboxMessages(t)` below.
 * Pass props only for copy that differs from those defaults.
 *
 * `COMBOBOX_DEFAULT_MESSAGES` holds the English values, and is only
 * reached when a translator throws or returns an empty string.
 */

export const COMBOBOX_DEFAULT_MESSAGES = {
    searchPlaceholder: "Search…",
    placeholder: "Select…",
    emptyState: "No matches",
    createLabel: (search: string) =>
        search ? `Create "${search}"` : "Create new option…",
} as const;

export interface ComboboxMessages {
    searchPlaceholder: string;
    placeholder: string;
    emptyState: string;
    createLabel: (search: string) => string;
}

/**
 * Build a localised message set from a next-intl (or compatible)
 * translator. Keys expected under the passed translator's namespace:
 * `searchPlaceholder`, `placeholder`, `emptyState`, `createLabel`
 * (accepts `{search}`), `createLabelEmpty` (for when search is empty).
 *
 * Missing keys fall back to the English defaults.
 */
export function getComboboxMessages(
    t: (key: string, values?: Record<string, string>) => string,
): ComboboxMessages {
    const safeT = (key: string, values?: Record<string, string>): string => {
        try {
            return t(key, values);
        } catch {
            return "";
        }
    };
    return {
        searchPlaceholder:
            safeT("searchPlaceholder") ||
            COMBOBOX_DEFAULT_MESSAGES.searchPlaceholder,
        placeholder:
            safeT("placeholder") || COMBOBOX_DEFAULT_MESSAGES.placeholder,
        emptyState:
            safeT("emptyState") || COMBOBOX_DEFAULT_MESSAGES.emptyState,
        createLabel: (search) => {
            if (!search) {
                return (
                    safeT("createLabelEmpty") ||
                    COMBOBOX_DEFAULT_MESSAGES.createLabel("")
                );
            }
            return (
                safeT("createLabel", { search }) ||
                COMBOBOX_DEFAULT_MESSAGES.createLabel(search)
            );
        },
    };
}
