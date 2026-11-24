"use client";

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useTranslations } from "next-intl";

import { cn } from "./table-utils";
import type { Row, TableInstance, TableRowData } from "./types";
import {
  ButtonHTMLAttributes,
  forwardRef,
  ReactNode,
  useEffect,
  useState,
} from "react";
import { Checkbox } from "../checkbox";
import { useKeyboardShortcut } from "../hooks/use-keyboard-shortcut";
import { DynamicTooltipWrapper, Tooltip } from "../tooltip";

// ── Batch Action Types ──────────────────────────────────────────────

/**
 * Describes a single batch action that can be plugged into the SelectionToolbar.
 *
 * Usage:
 *   const actions: BatchAction<Item>[] = [
 *     {
 *       label: "Export",
 *       icon: <Download className="size-3.5" />,
 *       onClick: (rows) => exportItems(rows.map(r => r.original)),
 *     },
 *     {
 *       label: "Archive",
 *       icon: <Archive className="size-3.5" />,
 *       onClick: (rows) => archiveItems(rows.map(r => r.original.id)),
 *       variant: "danger",
 *     },
 *   ];
 */
export interface BatchAction<T extends TableRowData> {
  /** Human-readable label for the button. */
  label: string;

  /** Optional icon rendered before the label. */
  icon?: ReactNode;

  /** Callback receiving the currently selected rows. */
  onClick: (selectedRows: Row<T>[]) => void;

  /** Visual variant — danger adds a red/destructive style. */
  variant?: "default" | "danger";

  /** Whether this action is currently disabled. */
  disabled?: boolean;

  /** Optional tooltip text shown when hovering the button. */
  title?: string;
}

// ── BatchActionButton ───────────────────────────────────────────────

/**
 * Styled button for use inside the SelectionToolbar.
 * Matches the platform's dark-theme design tokens and provides default + danger variants.
 *
 * Can be used standalone or generated from BatchAction[] via renderBatchActions.
 */
export interface BatchActionButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "danger";
  icon?: ReactNode;
}

export const BatchActionButton = forwardRef<
  HTMLButtonElement,
  BatchActionButtonProps
>(({ variant = "default", icon, className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:pointer-events-none disabled:opacity-50",
      // 44px for a finger below md, where the toolbar is two rows; the
      // compact pill on desktop.
      "min-h-11 md:min-h-0",
      variant === "default" &&
        "bg-bg-elevated text-content-emphasis hover:bg-bg-muted active:bg-bg-subtle border border-border-subtle",
      variant === "danger" &&
        "bg-bg-error text-content-error hover:bg-bg-error/80 active:bg-bg-error/60",
      className,
    )}
    {...props}
  >
    {icon && <span className="shrink-0">{icon}</span>}
    {children}
  </button>
));

BatchActionButton.displayName = "BatchActionButton";

// ── renderBatchActions helper ───────────────────────────────────────

/**
 * Converts a BatchAction[] into a (table) => ReactNode callback
 * suitable for the `selectionControls` prop of DataTable.
 *
 * Usage:
 *   <DataTable
 *     selectionControls={renderBatchActions(myActions)}
 *     ...
 *   />
 */
export function renderBatchActions<T extends TableRowData>(
  actions: BatchAction<T>[],
): (table: TableInstance<T>) => ReactNode {
  // This returns a render function for DataTable's `batchActions` slot,
  // not a React component — ESLint's display-name heuristic misfires on
  // factories that return JSX-producing functions.
  // eslint-disable-next-line react/display-name
  return (table: TableInstance<T>) => {
    const selectedRows = table.getSelectedRowModel().rows;
    return (
      <>
        {actions.map((action) => (
          <DynamicTooltipWrapper
            key={action.label}
            tooltipProps={action.title ? { content: action.title } : undefined}
          >
            <BatchActionButton
              variant={action.variant}
              icon={action.icon}
              disabled={action.disabled}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(selectedRows);
              }}
            >
              {action.label}
            </BatchActionButton>
          </DynamicTooltipWrapper>
        ))}
      </>
    );
  };
}

// ── SelectionToolbar ────────────────────────────────────────────────

/**
 * Where the bar sits.
 *
 * - `"overlay"` (default) — over the top of the list, covering the column
 *   header row. What `<Table>` and the virtualized table mount.
 * - `"dock"` — IN the flow after the list, `sticky` to the bottom of the
 *   screen and padded clear of the home indicator. What the phone's card list
 *   mounts: the list is long and scrolls with the page, so a bar pinned over
 *   its TOP is off-screen by the time a card further down is ticked. Sticky,
 *   not fixed: it takes its own space at the end of the list (so it never
 *   covers the last card), and if an ancestor clips overflow it degrades to
 *   sitting after the list rather than to somewhere unrelated. A docked bar
 *   with nothing selected is not rendered as a box at all, where the overlay
 *   only fades — an invisible box in the flow would be a gap after the list.
 */
export type SelectionToolbarPlacement = "overlay" | "dock";

export function SelectionToolbar<T extends TableRowData>({
  table,
  controls,
  className,
  placement = "overlay",
}: {
  table: TableInstance<T>;
  controls?: (table: TableInstance<T>) => ReactNode;
  className?: string;
  placement?: SelectionToolbarPlacement;
}) {
  const t = useTranslations("common");
  const selectedCount = table.getSelectedRowModel().rows.length;
  const totalCount = table.getRowModel().rows.length;
  const [lastSelectedCount, setLastSelectedCount] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedCount !== 0) setLastSelectedCount(selectedCount);
  }, [selectedCount]);

  // Epic 57 — Escape clears the current row selection. Priority 2 so
  // this beats the filter-list clear (priority 1) when both are
  // active; both remain below any open overlay's native Escape (our
  // global-scope hook is skipped while a modal/sheet is mounted).
  useKeyboardShortcut("Escape", () => table.resetRowSelection(), {
    enabled: selectedCount > 0,
    priority: 2,
    scope: "global",
    description: t("table.clearSelection"),
  });

  return (
    <div
      className={cn(
        // UI-23: a thin brand-coloured lower border marks the active action
        // row — `--brand-default` resolves to orange (light) / yellow (dark)
        // per theme. 1px (`border-b`) keeps it a hairline accent.
        "w-full border-b border-[var(--brand-default)] bg-bg-elevated",
        "transition-opacity duration-100",
        selectedCount > 0
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0",
        // Docked (the phone's card list): the hairline moves to the top edge,
        // which is the edge that meets the list, and the bar pads itself
        // clear of the home indicator. See SelectionToolbarPlacement.
        placement === "dock" && [
          "sticky bottom-0 z-30 border-b-0 border-t",
          "pb-[env(safe-area-inset-bottom)]",
          selectedCount === 0 && "hidden",
        ],
        className,
      )}
      data-placement={placement}
      // React 19 knows `inert` as a boolean attribute: `true` renders it,
      // `undefined` omits it. The React 18 workaround passed `inert=""`,
      // which React 19 reads as FALSE, so the hidden bar was never inert
      // and every list page logged "Received an empty string for a boolean
      // attribute `inert`" (#5924).
      inert={selectedCount === 0 || undefined}
      role="toolbar"
      aria-label={t("table.batchActions")}
      data-testid="selection-toolbar"
    >
      {/* B1 (2026-06-07): the bar matches the column-header row height
          (~37px) so it pops over it cleanly — was h-11 (45px incl. border),
          which overhung the header by ~8px.

          BELOW md it is TWO rows, because one row does not fit a phone: the
          count and Clear on the first, the batch controls across the whole
          second. As one non-wrapping `h-9` row it was ~408px wide at 390, and
          Apply was cut off by the shell's horizontal clip with no way to
          scroll to it — bulk actions could not be used on a phone at all.
          Every phone-only class below is the BASE and `md:` restores the
          desktop row exactly. */}
      <div
        data-selection-toolbar-row
        className="flex flex-wrap items-center gap-y-tight py-tight pr-2 md:h-9 md:flex-nowrap md:py-0"
      >
        {/* Select-all / indeterminate checkbox */}
        <div className="relative flex h-11 w-12 shrink-0 items-center justify-center md:h-full">
          <Tooltip
            content={
              table.getIsAllRowsSelected()
                ? t("table.deselectAll")
                : t("table.selectAllCount", { count: totalCount })
            }
          >
            {/* NB: <div>, not <button>. Radix Checkbox inside renders
                its own <button>, so a <button> wrapper causes the
                "<button> cannot be a descendant of <button>" hydration
                mismatch.
                GAP-CI-77: role="presentation" so the labelled inner
                Checkbox is the canonical button. role="button" here
                created a button-name violation because axe inspected
                both layers. */}
            <div
              role="presentation"
              tabIndex={-1}
              className="absolute inset-0 flex cursor-pointer items-center justify-center"
              onClick={(e) => {
                e.stopPropagation();
                table.toggleAllRowsSelected();
              }}
            >
              <Checkbox
                aria-label={
                  table.getIsAllRowsSelected()
                    ? t("table.deselectAllRows")
                    : t("table.selectAllRows")
                }
                className="border-border-emphasis pointer-events-none size-4 rounded-full data-[state=checked]:bg-[var(--brand-emphasis)] data-[state=indeterminate]:bg-[var(--brand-emphasis)]"
                checked={
                  table.getIsAllRowsSelected()
                    ? true
                    : table.getIsSomeRowsSelected()
                      ? "indeterminate"
                      : false
                }
              />
            </div>
          </Tooltip>
        </div>

        {/* Count + Clear. On a phone this fills the first row beside the
            checkbox; the controls below it then wrap to their own row. */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1 md:flex-initial">
          <span
            className={cn(
              "text-content-emphasis text-sm font-medium tabular-nums transition-transform duration-150",
              selectedCount > 0 ? "translate-x-0" : "-translate-x-1",
            )}
          >
            {t("table.selectedCount", { count: lastSelectedCount })}
          </span>

          {/* Separator between count and actions */}
          <div
            className={cn(
              "bg-border-emphasis h-4 w-px transition-opacity duration-150",
              selectedCount > 0 ? "opacity-100" : "opacity-0",
            )}
          />

          {/* Clear selection button */}
          <Tooltip content={t("table.clearSelection")} shortcut="Esc">
          <button
            type="button"
            className={cn(
              "text-content-muted hover:text-content-emphasis text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded",
              // A finger's 44px on a phone; the hairline text button on
              // desktop.
              "min-h-11 px-compact md:min-h-0 md:px-1",
            )}
            onClick={(e) => {
              e.stopPropagation();
              table.resetRowSelection();
            }}
            aria-label={t("table.clearSelection")}
          >
            {t("table.clear")}
          </button>
          </Tooltip>
        </div>

        {/* Pluggable batch action buttons. A phone gives them the whole
            second row (`basis-full`) and lets several buttons wrap; desktop
            keeps them inline after Clear, 10px on (`md:pl-2.5`, the gap they
            had when they sat inside the count group). */}
        <div
          data-selection-toolbar-controls
          className={cn(
            "flex basis-full flex-wrap items-center gap-1.5 px-compact transition-transform duration-150",
            "md:basis-auto md:flex-nowrap md:px-0 md:pl-2.5",
            selectedCount > 0 ? "translate-x-0" : "-translate-x-1",
          )}
        >
          {controls?.(table)}
        </div>
      </div>
    </div>
  );
}
