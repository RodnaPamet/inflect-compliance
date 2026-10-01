"use client";

/**
 * Mobile PR-2 — `<DataTableCards>`: the canonical small-screen rendering of a
 * `<DataTable>`. Below `md` a wide table can't fit a 375px viewport without
 * truncating or forcing horizontal scroll, so each row collapses to a CARD:
 * every visible column reads as a `label → value` line (full names wrap,
 * nothing is cut). `<DataTable>` renders THIS instead of the table on phones
 * (gated by `useIsBelowMd`), so only one tree is ever in the DOM.
 *
 * It renders from the SAME tanstack `table` instance the desktop `<Table>`
 * uses, so sort/filter/selection state stay in lockstep — a presentation swap,
 * not a fork.
 *
 * Columns whose header isn't a plain string (the selection checkbox, the
 * row-action chevron, icon-only columns) carry no label and render full-width
 * — selection lands at the top of the card, actions at the bottom.
 */
import * as React from "react";
import { flexRender } from "@tanstack/react-table";
import type { Row, TableInstance, TableRowData } from "./types";

import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/card";
import { buttonLikeKeys } from "@/components/ui/button-like-keys";
import { ChevronRight } from "../icons/nucleo/chevron-right";

export interface DataTableCardsProps<T extends TableRowData> {
    table: TableInstance<T>;
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    className?: string;
}

/**
 * Pointer + keyboard activation props for a clickable card.
 *
 * A clickable card used to be a bare `<div>` with `onClick`: no role, no
 * tabIndex, no key handler. A keyboard user could not reach the row and a
 * screen-reader user was never told it was actionable — the whole mobile list
 * was unusable for them, silently.
 *
 * The keyboard half comes from `buttonLikeKeys` rather than a local keydown,
 * because Space is the key people forget and `preventDefault()` on it is what
 * stops the page scrolling under a user who meant to open the row. Binding the
 * helper to the event that arrived is what lets `onRowClick` keep receiving an
 * event, which its signature requires and the helper's argument-free
 * `onActivate` does not carry.
 *
 * A real `<button>` is not available here: these cards render the row's own
 * interactive cells (a kebab menu, a checkbox), and nesting those inside a
 * button is invalid HTML.
 */
function cardActivation<T extends TableRowData>(
    row: Row<T>,
    onRowClick: (row: Row<T>, e: React.MouseEvent) => void,
) {
    /** The helper, bound to the event that triggered this activation. */
    const bound = (e: React.MouseEvent | React.KeyboardEvent) =>
        buttonLikeKeys(() => onRowClick(row, e as React.MouseEvent));
    // `role` and `tabIndex` do not depend on the event, so they are read off a
    // binding whose `onActivate` is never called.
    const { role, tabIndex } = buttonLikeKeys(() => {});
    return {
        role,
        tabIndex,
        onClick: (e: React.MouseEvent) => bound(e).onClick?.(),
        onKeyDown: (e: React.KeyboardEvent) => bound(e).onKeyDown(e),
    };
}

export function DataTableCards<T extends TableRowData>({
    table,
    onRowClick,
    className,
}: DataTableCardsProps<T>) {
    const rows = table.getRowModel().rows;

    return (
        <div
            className={cn("flex flex-col gap-default", className)}
            role="list"
            data-testid="data-table-cards"
        >
            {rows.map((row) => {
                const clickable = !!onRowClick;
                return (
                    <div
                        key={row.id}
                        data-row-id={row.id}
                        // A clickable card IS a button; a read-only one is a
                        // list item.
                        {...(clickable
                            ? cardActivation(row, onRowClick!)
                            : { role: "listitem" as const })}
                        className={cn(
                            cardVariants({ density: "compact" }),
                            "flex flex-col gap-tight",
                            // 44px floor. Below that a tap lands between rows
                            // as often as on one, and the miss scrolls the
                            // list — the opposite of what was wanted.
                            clickable && "relative min-h-11 pr-9",
                            clickable &&
                                "cursor-pointer transition-colors duration-75 hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)]/40",
                        )}
                    >
                        {clickable && (
                            // The affordance. Without it a card looks like a
                            // read-only summary and the user never discovers
                            // the row opens. Mirrors the desktop table's
                            // trailing `__row-chevron` column.
                            <ChevronRight
                                aria-hidden="true"
                                width={16}
                                height={16}
                                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-content-subtle"
                            />
                        )}
                        {row.getVisibleCells().map((cell) => {
                            const header = cell.column.columnDef.header;
                            const label =
                                typeof header === "string" && header.trim()
                                    ? header
                                    : null;
                            const value = flexRender(
                                cell.column.columnDef.cell,
                                cell.getContext(),
                            );
                            return (
                                <div
                                    key={cell.id}
                                    className={cn(
                                        "flex min-w-0 gap-default text-sm",
                                        label
                                            ? "items-baseline justify-between"
                                            : "items-center",
                                    )}
                                >
                                    {label && (
                                        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-content-muted">
                                            {label}
                                        </span>
                                    )}
                                    <span
                                        className={cn(
                                            "min-w-0 break-words",
                                            label
                                                ? "text-right text-content-default"
                                                : "flex-1 text-content-default",
                                        )}
                                    >
                                        {value}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}
