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

export interface DataTableCardsProps<T extends TableRowData> {
    table: TableInstance<T>;
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    className?: string;
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
                        role="listitem"
                        data-row-id={row.id}
                        onClick={clickable ? (e) => onRowClick!(row, e) : undefined}
                        className={cn(
                            cardVariants({ density: "compact" }),
                            "flex flex-col gap-tight",
                            clickable &&
                                "cursor-pointer transition-colors duration-75 hover:bg-bg-muted/50",
                        )}
                    >
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
