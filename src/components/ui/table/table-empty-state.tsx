"use client";

/**
 * TableEmptyState — table-cell-shaped wrapper around <EmptyState>.
 *
 * Same API as before for backward-compatibility (7 existing callers in
 * the `/org/...` admin views), but the visual + action rendering is
 * delegated to the top-level <EmptyState> primitive. The only thing
 * this wrapper still owns is the `h-96` height that DataTable expects
 * inside a row-less table body, plus the `data-testid="table-empty-state"`
 * selector that E2E tests rely on.
 *
 * To migrate existing callers to the top-level primitive directly:
 *
 *     import { EmptyState } from '@/components/ui/empty-state';
 *     <EmptyState
 *         icon={IconComponent}      // a React.ElementType, NOT <Icon />
 *         title="…"
 *         description="…"
 *         primaryAction={{ label, onClick }}
 *     />
 *
 * The two API differences from this wrapper:
 *   1. `icon` is a Component (not a ReactNode), to match the canonical
 *      EmptyState contract — the wrapper still accepts ReactNode for
 *      legacy callers that pass `<Shield />` directly.
 *   2. `action: { variant: 'primary' | 'default' }` becomes either
 *      `primaryAction={…}` (was 'primary') or `secondaryAction={…}`
 *      (was 'default'). Both render the same button styling.
 */

import { useTranslations } from "next-intl";
import { type ReactNode } from "react";
import { cn } from "./table-utils";
import { EmptyState } from "../empty-state";

// ── Types (unchanged for backward-compat) ───────────────────────────

export interface TableEmptyStateAction {
    /** Button label text. */
    label: string;
    /** Click handler. */
    onClick: () => void;
    /** Visual variant for the button. */
    variant?: "default" | "primary";
}

export interface TableEmptyStateProps {
    /** Main heading text. Defaults to `common.table.noItemsFound`. */
    title?: string;
    /** Secondary description text. */
    description?: string;
    /** Icon element rendered above the title. ReactNode for legacy callers. */
    icon?: ReactNode;
    /** Optional call-to-action button. */
    action?: TableEmptyStateAction;
    /** Override the entire content with custom rendering. */
    children?: ReactNode;
    /** Additional className for the outer wrapper. */
    className?: string;
}

// ── Component ───────────────────────────────────────────────────────

export function TableEmptyState({
    title,
    description,
    icon,
    action,
    children,
    className,
}: TableEmptyStateProps) {
    const t = useTranslations("common.table");
    // Children-override path stays unchanged — some callers rely on
    // the bare flex centring with arbitrary content inside.
    if (children) {
        return (
            <div
                className={cn(
                    // Item 35 — min-h-48 (192px) that can grow, not a fixed
                    // h-96 (384px), so a row-less sub-table stays compact.
                    "text-content-muted flex min-h-48 w-full items-center justify-center text-sm",
                    className,
                )}
                data-testid="table-empty-state"
            >
                {children}
            </div>
        );
    }

    // Bridge legacy `action` shape into EmptyState's primary/secondary slots.
    const primaryAction =
        action && action.variant === "primary"
            ? { label: action.label, onClick: action.onClick }
            : undefined;
    const secondaryAction =
        action && action.variant !== "primary"
            ? { label: action.label, onClick: action.onClick }
            : undefined;

    // Legacy callers pass a ReactNode like `<Shield className="size-10" />`.
    // EmptyState wants an ElementType. Wrap the node in a tiny shim
    // component that ignores the className EmptyState would inject and
    // just renders the caller's node verbatim.
    const IconShim = icon ? () => <>{icon}</> : undefined;

    return (
        <div
            className={cn(
                // Item 35 — min-h-48 floor (192px), not fixed h-96 (384px).
                "flex min-h-48 w-full items-center justify-center",
                className,
            )}
            data-testid="table-empty-state"
        >
            <EmptyState
                icon={IconShim}
                title={title ?? t("noItemsFound")}
                description={description}
                primaryAction={primaryAction}
                secondaryAction={secondaryAction}
            />
        </div>
    );
}
