'use client';

/**
 * useColumnsDropdown — the "Toggle columns" gear's state (2026-06-07).
 *
 * Owns BOTH column visibility AND left-to-right order via the shared
 * click-to-order model (`checklist-order.ts`), persisted to localStorage
 * under the same `inflect:col-vis:<entity>` key (now storing the visible-
 * id order array). Renders the `<ColumnsDropdown>` gear (Columns3) and
 * returns:
 *
 *   const { columnVisibility, orderColumns, dropdown: columnsGear } =
 *     useColumnsDropdown({ storageKey: 'inflect:col-vis:risks', columns: [...] });
 *
 *   <DataTable
 *     columns={orderColumns(baseColumns)}   // ← reorder per the gear
 *     columnVisibility={columnVisibility}   // ← hide per the gear
 *     ...
 *   />
 *   // actions slot: <>{filterGear}{columnsGear}</>
 *
 * `orderColumns` is a slot-merge: managed columns follow the gear order;
 * fixed columns (select / actions / always-visible) keep their positions.
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import type { ColumnVisibilityState } from './types';
import { ColumnsDropdown } from './columns-dropdown';
import { useLocalStorage } from '../hooks';
import {
    applySlotOrder,
    buildChecklistItems,
    defaultOrder,
    isModifiedFromDefault,
    reconcileOrder,
    reorderOrder,
    toggleOrder,
    type ChecklistDef,
} from '../checklist-order';

export interface ColumnDropdownColumn {
    /** TanStack column id — must match the DataTable column def's id. */
    id: string;
    /** Human-readable label shown in the dropdown checklist. */
    label: string;
    /** Optional icon shown in the checklist row. */
    icon?: ReactNode;
    /** Whether visible by default. Omitted = `true`. */
    defaultVisible?: boolean;
    /** Always-visible columns can't be toggled/reordered (select, actions). */
    alwaysVisible?: boolean;
}

export interface UseColumnsDropdownOptions {
    /** Convention: `'inflect:col-vis:<entity>'`. */
    storageKey: string;
    /** The full column list (toggleable + always-visible). */
    columns: ColumnDropdownColumn[];
}

export interface UseColumnsDropdownResult {
    /** Pass to `<DataTable columnVisibility={…}>`. */
    columnVisibility: ColumnVisibilityState;
    /** Pass to `<DataTable onColumnVisibilityChange={…}>` (optional). */
    setColumnVisibility: (visibility: ColumnVisibilityState) => void;
    /** Reorder a column array per the gear: `columns={orderColumns(base)}`. */
    orderColumns: <T extends object>(columns: ReadonlyArray<T>) => T[];
    /** Pre-rendered gear — drop into the toolbar actions slot. */
    dropdown: ReactNode;
    /** Default visibility map. */
    defaults: ColumnVisibilityState;
}

export function useColumnsDropdown({
    storageKey,
    columns,
}: UseColumnsDropdownOptions): UseColumnsDropdownResult {
    const hideable = useMemo(
        () => columns.filter((c) => c.alwaysVisible !== true),
        [columns],
    );
    const defaultVisibleDefs = useMemo(
        () => hideable.filter((c) => c.defaultVisible !== false),
        [hideable],
    );
    const defaults = useMemo(
        () => defaultOrder(defaultVisibleDefs),
        [defaultVisibleDefs],
    );

    const [stored, setStored] = useLocalStorage<string[]>(storageKey, defaults);
    const order = useMemo(
        () => reconcileOrder(stored, defaultVisibleDefs),
        [stored, defaultVisibleDefs],
    );
    const orderSet = useMemo(() => new Set(order), [order]);

    // Include EVERY column: always-visible columns are explicitly `true`
    // (not merely absent) so the map round-trips cleanly to the DataTable
    // and consumers can read each column's state directly.
    const columnVisibility = useMemo<ColumnVisibilityState>(() => {
        const vis: ColumnVisibilityState = {};
        for (const c of columns) {
            vis[c.id] = c.alwaysVisible === true ? true : orderSet.has(c.id);
        }
        return vis;
    }, [columns, orderSet]);

    const defaultVisibility = useMemo<ColumnVisibilityState>(() => {
        const vis: ColumnVisibilityState = {};
        const def = new Set(defaultVisibleDefs.map((c) => c.id));
        for (const c of columns) {
            vis[c.id] = c.alwaysVisible === true ? true : def.has(c.id);
        }
        return vis;
    }, [columns, defaultVisibleDefs]);

    const items = useMemo(
        () => buildChecklistItems(hideable as ChecklistDef[], order),
        [hideable, order],
    );
    const someModified = useMemo(
        () => isModifiedFromDefault(order, defaults),
        [order, defaults],
    );

    const onToggle = useCallback(
        (id: string) =>
            setStored((prev) =>
                toggleOrder(reconcileOrder(prev, defaultVisibleDefs), id),
            ),
        [setStored, defaultVisibleDefs],
    );
    const onReset = useCallback(() => setStored(defaults), [setStored, defaults]);
    const onReorder = useCallback(
        (fromId: string, toId: string) =>
            setStored((prev) =>
                reorderOrder(
                    reconcileOrder(prev, defaultVisibleDefs),
                    fromId,
                    toId,
                ),
            ),
        [setStored, defaultVisibleDefs],
    );

    // Back-compat: if a consumer drives visibility from the DataTable side
    // (no header-toggle UI ships today), fold it into the order — keep the
    // order of still-visible columns, append newly-visible at the end.
    const setColumnVisibility = useCallback(
        (v: ColumnVisibilityState) =>
            setStored((prev) => {
                const cur = reconcileOrder(prev, defaultVisibleDefs);
                const kept = cur.filter((id) => v[id] !== false);
                const newly = hideable
                    .filter((c) => v[c.id] === true && !cur.includes(c.id))
                    .map((c) => c.id);
                return [...kept, ...newly];
            }),
        [setStored, defaultVisibleDefs, hideable],
    );

    const orderColumns = useCallback(
        <T extends object>(cols: ReadonlyArray<T>): T[] =>
            applySlotOrder(cols, order),
        [order],
    );

    const dropdown = (
        <ColumnsDropdown
            items={items}
            onToggle={onToggle}
            onReset={onReset}
            onReorder={onReorder}
            someModified={someModified}
        />
    );

    return {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown,
        defaults: defaultVisibility,
    };
}
