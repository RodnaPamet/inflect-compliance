"use client";

/**
 * Minimal in-panel tab bar for the control / task side panels.
 *
 * Deliberately NOT the TabSelect primitive (which the single-tab-pattern guard
 * bans in app pages) and NOT a detail-page EntityDetailLayout — this is a
 * lightweight 2-tab switch scoped to the side panel, using the canonical
 * `border-b` brand-underline active style so it reads consistently with the
 * detail-page tab bar.
 *
 * Accessibility: full WAI-ARIA APG tabs pattern — `role="tablist"` /
 * `role="tab"` / `aria-selected` / `aria-controls`, a roving `tabIndex` (only
 * the active tab is in the tab order), and Arrow / Home / End keyboard
 * navigation with automatic activation (moving focus selects the tab). The
 * `aria-controls` targets `panel-tabpanel-<id>`; the consuming panel labels
 * its content with the matching `id` + `role="tabpanel"`.
 */
import { useCallback, useId, useRef, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";

export function PanelTabs<T extends string>({
    tabs,
    active,
    onSelect,
}: {
    tabs: { id: T; label: string }[];
    active: T;
    onSelect: (id: T) => void;
}) {
    const t = useTranslations("controls");
    const baseId = useId();
    const tabRefs = useRef(new Map<T, HTMLButtonElement>());

    const tabDomId = (id: T) => `${baseId}-panel-tab-${id}`;
    const panelDomId = (id: T) => `${baseId}-panel-tabpanel-${id}`;

    const onKeyDown = useCallback(
        (e: KeyboardEvent<HTMLButtonElement>, id: T) => {
            const idx = tabs.findIndex((tab) => tab.id === id);
            if (idx === -1) return;

            let next: T | undefined;
            switch (e.key) {
                case "ArrowRight":
                case "ArrowDown":
                    next = tabs[(idx + 1) % tabs.length]?.id;
                    break;
                case "ArrowLeft":
                case "ArrowUp":
                    next = tabs[(idx - 1 + tabs.length) % tabs.length]?.id;
                    break;
                case "Home":
                    next = tabs[0]?.id;
                    break;
                case "End":
                    next = tabs[tabs.length - 1]?.id;
                    break;
                default:
                    return;
            }
            if (next === undefined) return;
            e.preventDefault();
            tabRefs.current.get(next)?.focus();
            // Automatic activation (WAI-ARIA APG): moving focus activates the
            // tab, so keyboard users don't need a separate Enter to commit.
            onSelect(next);
        },
        [tabs, onSelect],
    );

    return (
        <div
            role="tablist"
            aria-label={t("detail.tabs.ariaLabel")}
            className="flex gap-tight border-b border-border-subtle"
        >
            {tabs.map((tab) => {
                const selected = active === tab.id;
                return (
                    <button
                        key={tab.id}
                        ref={(el) => {
                            if (el) tabRefs.current.set(tab.id, el);
                            else tabRefs.current.delete(tab.id);
                        }}
                        type="button"
                        role="tab"
                        id={tabDomId(tab.id)}
                        aria-selected={selected}
                        aria-controls={panelDomId(tab.id)}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onSelect(tab.id)}
                        onKeyDown={(e) => onKeyDown(e, tab.id)}
                        className={cn(
                            "-mb-px cursor-pointer rounded-sm border-b-2 px-3 py-1.5 text-sm transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                            selected
                                ? "border-[var(--brand-default)] text-content-emphasis"
                                : "border-transparent text-content-muted hover:text-content-emphasis",
                        )}
                    >
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
}
