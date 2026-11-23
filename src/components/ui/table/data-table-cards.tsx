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
 * The card's shape, top to bottom:
 *
 *   - the TITLE ROW: the selection checkbox (when the list has something to
 *     do with a selection), the first field, and a "⋯" menu holding every
 *     column marked `meta.cardAction`;
 *   - every other field, label above value below `sm`, with fields that
 *     render nothing but a dash left out.
 *
 * Columns whose header isn't a plain string carry no label and render
 * full-width.
 */
import * as React from "react";
import { flexRender } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Row, TableInstance, TableRowData } from "./types";

import { cn } from "@inflect/ui/lib/cn";
import { cardVariants } from "@/components/ui/card";
import { buttonLikeKeys } from "@/components/ui/button-like-keys";
import { Popover } from "@/components/ui/popover";
import { TableTitleSurfaceProvider } from "@/components/ui/table-title-cell";
import { ChevronRight } from "@inflect/ui/components/ui/icons/glyphs/chevron-right";

export interface DataTableCardsProps<T extends TableRowData> {
    table: TableInstance<T>;
    onRowClick?: (row: Row<T>, e: React.MouseEvent) => void;
    className?: string;
    /**
     * Whether anything acts on a selection: bulk actions, a selection
     * toolbar, or an `onRowSelectionChange` listener. `<DataTable>` passes
     * it. When false, the card renders no checkbox even though the table's
     * select column exists (it is default-on, so a read-only list has one).
     */
    selectable?: boolean;
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
    const bound = (
        e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    ) => buttonLikeKeys(() => onRowClick(row, e as React.MouseEvent));
    // `role` and `tabIndex` do not depend on the event, so they are read off a
    // binding whose `onActivate` is never called.
    const { role, tabIndex } = buttonLikeKeys(() => {});
    return {
        role,
        tabIndex,
        onClick: (e: React.MouseEvent<HTMLElement>) => bound(e).onClick?.(),
        // `KeyboardEvent<HTMLElement>`, not the bare `KeyboardEvent` whose
        // element parameter defaults to `Element` — `buttonLikeKeys` takes the
        // HTML-element form, and the bare alias does not satisfy it.
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) =>
            bound(e).onKeyDown(e),
    };
}

/**
 * The desktop table's trailing chevron column, which a card must not render.
 *
 * `useTable` appends this column whenever `onRowClick` is set, and its cell is
 * `opacity-0` until `group-hover/row` — an affordance for a pointer hovering a
 * table row. In a card there is no such group, so the cell renders as an
 * invisible full-width line: dead vertical space on the viewport that has
 * least of it, and no affordance. The card's own chevron below replaces it.
 *
 * The id is spelled rather than imported because `table.tsx` declares it
 * inline and `datatable-row-chevron-affordance` pins that literal there.
 */
const DESKTOP_CHEVRON_COLUMN_ID = "__row-chevron";

/** The select column `useTable` prepends while selection is enabled. */
const SELECT_COLUMN_ID = "select";

/**
 * What a cell renders when it has nothing to say. A card field whose value is
 * one of these (and holds no icon, image or control) is omitted: a stack of
 * "OWNER —", "DUE —" rows is height on the smallest screen and no information.
 */
const EMPTY_RENDERED_TEXT = new Set(["", "—", "–", "-", "−"]);

/** Anything in a value that carries meaning without text. */
const NON_TEXT_CONTENT =
    "svg,img,picture,canvas,video,input,select,textarea,button,a[href],progress,meter,[role='img'],[role='progressbar'],[role='checkbox']";

/** True when a rendered value shows the reader nothing but a dash. */
function isRenderedValueEmpty(el: HTMLElement): boolean {
    const text = (el.textContent ?? "").replace(/\s+/g, "");
    return EMPTY_RENDERED_TEXT.has(text) && !el.querySelector(NON_TEXT_CONTENT);
}

/**
 * One `label → value` field.
 *
 * Below `sm` the label sits ABOVE the value, always. A side-by-side layout
 * with a `shrink-0` label gave a long label ("ПОСЛЕДНО ПРЕГЛЕДАНО", "RESIDUAL
 * SCORE") most of a 360px card and squeezed the value to one word per line.
 * Deciding by label length was the alternative, and it was rejected: the same
 * label is short in English and long in Bulgarian, character counts do not
 * predict rendered width, and a card whose rows switch layout from one field
 * to the next is harder to scan than one that never does. From `sm` up (a
 * 640-767px card) there is room for both side by side, and the label is
 * capped so it can no longer take the row.
 *
 * The value's own `truncate` spans become BLOCK-level here. Pages write
 * `<span className="truncate">` for their desktop table cells, and on an
 * inline span `truncate` never truncates: the text ran past the card's edge
 * and the shell's `overflow-x-clip` cut it off with no ellipsis. The TITLE is
 * the exception (`wrapTitle`): it is what identifies the row, so a truncating
 * title cell wraps in full instead of ending in an ellipsis.
 */
function CardField({
    label,
    children,
    omitWhenEmpty,
    wrapTitle = false,
    testId,
}: {
    label: string | null;
    children: React.ReactNode;
    omitWhenEmpty: boolean;
    wrapTitle?: boolean;
    testId?: string;
}) {
    const fieldRef = React.useRef<HTMLDivElement>(null);
    const valueRef = React.useRef<HTMLDivElement>(null);
    // The rendered text is only known after render, so emptiness is read off
    // the DOM. Written as the `hidden` attribute directly — no state, so no
    // second render and no flash: a layout effect runs before paint.
    React.useLayoutEffect(() => {
        const field = fieldRef.current;
        const value = valueRef.current;
        if (!field || !value) return;
        field.hidden = omitWhenEmpty && isRenderedValueEmpty(value);
    });
    return (
        <div
            ref={fieldRef}
            data-testid={testId}
            data-card-field=""
            className={cn(
                "flex min-w-0 text-sm",
                label
                    ? "flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-default"
                    : "items-center",
            )}
        >
            {label && (
                <span
                    data-card-label=""
                    className="text-xs font-medium uppercase tracking-wide text-content-muted [overflow-wrap:anywhere] sm:max-w-[40%] sm:shrink-0"
                >
                    {label}
                </span>
            )}
            <div
                ref={valueRef}
                data-card-value=""
                className={cn(
                    "min-w-0 max-w-full break-words text-content-default",
                    "[&_.truncate]:block [&_.truncate]:max-w-full",
                    wrapTitle &&
                        "[&_.truncate]:whitespace-normal [&_.truncate]:[overflow-wrap:anywhere]",
                    label && !wrapTitle ? "sm:text-right" : "flex-1",
                )}
            >
                {children}
            </div>
        </div>
    );
}

/**
 * The card's "⋯" menu: every cell whose column is marked `meta.cardAction`.
 *
 * Those are icon-only buttons on the desktop row (edit, archive, submit…),
 * labelled only by a tooltip a touch user cannot open; stacked one per line
 * in a card they read as a column of unexplained glyphs. Here they are items
 * of a menu, built on the shared `<Popover>` (a bottom sheet on a phone),
 * and each control's `aria-label` is ALSO painted as its visible text, so a
 * page's existing icon buttons become labelled menu items with no change to
 * the page.
 *
 * The cells render exactly once. While the menu is closed they sit in a
 * `hidden` probe, so the trigger can disappear when no action applies to
 * this row (no permission, a pending upload); while it is open they render
 * in the menu instead. Rendering both would duplicate the ids pages give
 * their buttons.
 */
function CardActionsMenu({
    children,
    label,
    triggerLabel,
}: {
    children: React.ReactNode;
    label: string;
    triggerLabel: string;
}) {
    const [open, setOpen] = React.useState(false);
    const probeRef = React.useRef<HTMLDivElement>(null);
    // The WRAPPER is hidden, not the trigger: `<Popover>` swaps its trigger
    // element when it switches between dropdown and bottom sheet, which
    // would drop an attribute written to the old one.
    const wrapRef = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const probe = probeRef.current;
        const wrap = wrapRef.current;
        if (!probe || !wrap) return;
        wrap.hidden = !probe.querySelector(
            "button,a[href],[aria-label],[role='button']",
        );
    });
    // React events bubble through the portal to the card, whose click opens
    // the row. Nothing inside the menu, nor the trigger, may do that.
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
        <div ref={wrapRef} data-testid="data-table-card-actions" className="shrink-0">
            {!open && (
                <div ref={probeRef} hidden data-card-actions-probe="">
                    {children}
                </div>
            )}
            <Popover
                openPopover={open}
                setOpenPopover={setOpen}
                align="end"
                contentLabel={label}
                content={
                    <div
                        role="group"
                        aria-label={label}
                        data-testid="data-table-card-actions-menu"
                        onClick={(e) => {
                            e.stopPropagation();
                            // Any action taken closes the menu; a dialog
                            // the action opens takes over from here.
                            if ((e.target as HTMLElement).closest("button,a")) {
                                setOpen(false);
                            }
                        }}
                        onKeyDown={stop}
                        className={cn(
                            "flex w-full min-w-48 flex-col gap-tight p-1 text-sm",
                            // Every control becomes a full-width, 44px row…
                            "[&_:is(button,a,[aria-label])]:flex [&_:is(button,a,[aria-label])]:h-auto [&_:is(button,a,[aria-label])]:min-h-11 [&_:is(button,a,[aria-label])]:w-full [&_:is(button,a,[aria-label])]:items-center [&_:is(button,a,[aria-label])]:justify-start [&_:is(button,a,[aria-label])]:gap-compact [&_:is(button,a,[aria-label])]:px-3 [&_:is(button,a,[aria-label])]:text-content-default",
                            // …that shows its accessible name as text.
                            "[&_[aria-label]]:after:text-sm [&_[aria-label]]:after:font-medium [&_[aria-label]]:after:content-[attr(aria-label)]",
                            // A cell's own wrapper row stacks its controls.
                            "[&>div>div]:flex-col",
                        )}
                    >
                        {open ? children : null}
                    </div>
                }
            >
                <button
                    type="button"
                    aria-label={triggerLabel}
                    data-testid="data-table-card-actions-trigger"
                    onClick={stop}
                    onKeyDown={stop}
                    className="-my-1 flex size-11 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]"
                >
                    <MoreHorizontal aria-hidden="true" className="size-5" />
                </button>
            </Popover>
        </div>
    );
}

export function DataTableCards<T extends TableRowData>({
    table,
    onRowClick,
    className,
    selectable = true,
}: DataTableCardsProps<T>) {
    const t = useTranslations("ui.dataTableCards");
    const rows = table.getRowModel().rows;

    return (
        <div
            className={cn("flex flex-col gap-default", className)}
            role="list"
            data-testid="data-table-cards"
        >
            {rows.map((row) => {
                const clickable = !!onRowClick;
                const cells = row
                    .getVisibleCells()
                    .filter((cell) => cell.column.id !== DESKTOP_CHEVRON_COLUMN_ID);
                // A read-only list (nothing acts on a selection) offers no
                // checkbox: ticking a card there selected rows nothing could
                // use, and its circle took a row of its own.
                const selectCell = selectable
                    ? cells.find((cell) => cell.column.id === SELECT_COLUMN_ID)
                    : undefined;
                const actionCells = cells.filter(
                    (cell) => cell.column.columnDef.meta?.cardAction === true,
                );
                const fieldCells = cells.filter(
                    (cell) =>
                        cell.column.id !== SELECT_COLUMN_ID &&
                        cell.column.columnDef.meta?.cardAction !== true,
                );
                const [titleCell, ...restCells] = fieldCells;
                const labelOf = (header: unknown) =>
                    typeof header === "string" && header.trim() ? header : null;
                const render = (cell: (typeof cells)[number]) =>
                    flexRender(cell.column.columnDef.cell, cell.getContext());

                const card = (
                    <div
                        key={row.id}
                        data-row-id={row.id}
                        // A clickable card IS a button; a read-only one is a
                        // list item. A button is NOT an allowed child of a
                        // `list`, so the clickable case gets a `listitem`
                        // wrapper below rather than a different role here —
                        // the role AT announces for an actionable card is the
                        // part that must not change.
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
                            // The focus ring is SOLID: at /40 it measured
                            // under the 3:1 a focus indicator owes (WCAG
                            // 1.4.11) on both themes' cards.
                            clickable &&
                                "cursor-pointer transition-colors duration-75 hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]",
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
                        {(selectCell || titleCell || actionCells.length > 0) && (
                            // The title row: selection, the first field, and
                            // the actions menu, on ONE line. The checkbox used
                            // to be a lone circle on a row of its own.
                            <div
                                className="flex min-w-0 items-start gap-tight"
                                data-testid="data-table-card-title-row"
                            >
                                {selectCell && (
                                    <div
                                        data-testid="data-table-card-select"
                                        // A 44px hit area around the 20px
                                        // circle, pulled into the padding so
                                        // the row does not grow by it. The
                                        // keydown stops here: Space on the
                                        // checkbox must tick the row, not
                                        // also open it.
                                        onKeyDown={(e) => e.stopPropagation()}
                                        className={cn(
                                            "-my-2 -ml-2 size-11 shrink-0",
                                            // Faint-proof: `border-border-strong`
                                            // is 3.5:1 in both themes; the
                                            // column's own `border-border-emphasis`
                                            // is 1.6:1 on the light theme's card.
                                            "[&_[role=checkbox]]:size-5 [&_[role=checkbox]]:border-border-strong",
                                        )}
                                    >
                                        {render(selectCell)}
                                    </div>
                                )}
                                {titleCell && (
                                    <div className="min-w-0 flex-1">
                                        <CardField
                                            label={labelOf(titleCell.column.columnDef.header)}
                                            omitWhenEmpty={false}
                                            wrapTitle
                                            testId="data-table-card-title"
                                        >
                                            {/* A title cell built on `<TableTitleCell>` /
                                                `<TableTitleButton>` reads this: on a card that
                                                is a button it renders as text (one target, not
                                                a control nested in a control); on any other
                                                card it wears the 44px touch hit area. */}
                                            <TableTitleSurfaceProvider
                                                value={clickable ? "clickable-card" : "card"}
                                            >
                                                {render(titleCell)}
                                            </TableTitleSurfaceProvider>
                                        </CardField>
                                    </div>
                                )}
                                {actionCells.length > 0 && (
                                    <CardActionsMenu
                                        label={t("actions")}
                                        triggerLabel={t("rowActions")}
                                    >
                                        {actionCells.map((cell) => (
                                            <div key={cell.id}>{render(cell)}</div>
                                        ))}
                                    </CardActionsMenu>
                                )}
                            </div>
                        )}
                        {restCells.map((cell) => (
                            <CardField
                                key={cell.id}
                                label={labelOf(cell.column.columnDef.header)}
                                omitWhenEmpty
                            >
                                {render(cell)}
                            </CardField>
                        ))}
                    </div>
                );
                // `role="list"` requires its children to be `listitem`
                // (axe `aria-required-children`, impact CRITICAL — #3129,
                // measured on two real phone-width pages). A read-only card
                // already is one. A clickable card is a `role="button"`, so it
                // is wrapped in one instead of being re-roled: the wrapper
                // carries no classes and no handlers, so the card keeps every
                // class, the whole hit area, the hover affordance, the focus
                // ring and the `buttonLikeKeys` keyboard contract it had.
                return clickable ? (
                    <div key={row.id} role="listitem">
                        {card}
                    </div>
                ) : (
                    card
                );
            })}
        </div>
    );
}
