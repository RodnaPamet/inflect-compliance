// Imported from the library rather than from `@/components/ui/table`
// on purpose: `src/components/ui/table` already imports from this hooks
// directory (`use-columns-dropdown` → `../hooks`), so pointing this file
// at the table barrel would close an import cycle. `ColumnVisibilityState`
// is a plain `Record<string, boolean>` with no feature parameter, so it
// needs no binding through the platform seam — it is v9's name for the
// state slice v8 exported as `VisibilityState`.
import type { ColumnVisibilityState } from "@tanstack/react-table";
import { useLocalStorage } from "./use-local-storage";

// Single table configuration
type SingleTableConfig = {
  all: string[];
  defaultVisible: string[];
};

// Multi-tab table configuration
type MultiTableConfig<T extends string> = Record<T, SingleTableConfig>;

// Type guard for SingleTableConfig
function isSingleTableConfig(config: unknown): config is SingleTableConfig {
  return (
    !!config &&
    typeof config === "object" &&
    Array.isArray((config as { all?: unknown }).all) &&
    Array.isArray((config as { defaultVisible?: unknown }).defaultVisible)
  );
}

// Generic hook for single table
export function useColumnVisibility<T extends SingleTableConfig>(
  storageKey: string,
  config: T,
): {
  columnVisibility: ColumnVisibilityState;
  setColumnVisibility: (visibility: ColumnVisibilityState) => void;
};

// Generic hook for multi-tab table
export function useColumnVisibility<T extends string>(
  storageKey: string,
  config: MultiTableConfig<T>,
): {
  columnVisibility: Record<T, ColumnVisibilityState>;
  setColumnVisibility: (tab: T, visibility: ColumnVisibilityState) => void;
};

// Implementation
export function useColumnVisibility<T extends string>(
  storageKey: string,
  config: SingleTableConfig | MultiTableConfig<T>,
):
  | {
      columnVisibility: ColumnVisibilityState;
      setColumnVisibility: (visibility: ColumnVisibilityState) => void;
    }
  | {
      columnVisibility: Record<T, ColumnVisibilityState>;
      setColumnVisibility: (tab: T, visibility: ColumnVisibilityState) => void;
    } {
  // Check if this is a multi-tab configuration
  const isMultiTab = !isSingleTableConfig(config);

  // Compute the default state for BOTH branches up-front so we can
  // call `useLocalStorage` exactly once — hooks must be called in
  // the same order every render (Rules of Hooks). `isMultiTab` is
  // stable per caller, so in practice only one branch's default is
  // ever used; the other is cheaply discarded.
  let defaultState: ColumnVisibilityState | Record<T, ColumnVisibilityState>;
  if (isMultiTab) {
    const multiConfig = config as MultiTableConfig<T>;
    const getDefaultColumnVisibility = (tab: T) => {
      const columns = multiConfig[tab];
      return Object.fromEntries(
        columns.all.map((id) => [id, columns.defaultVisible.includes(id)]),
      );
    };
    defaultState = Object.fromEntries(
      Object.keys(multiConfig).map((tab) => [
        tab,
        getDefaultColumnVisibility(tab as T),
      ]),
    ) as Record<T, ColumnVisibilityState>;
  } else {
    const singleConfig = config as SingleTableConfig;
    defaultState = Object.fromEntries(
      singleConfig.all.map((id) => [
        id,
        singleConfig.defaultVisible.includes(id),
      ]),
    );
  }

  const [columnVisibility, setColumnVisibilityState] = useLocalStorage<
    ColumnVisibilityState | Record<T, ColumnVisibilityState>
  >(storageKey, defaultState);

  if (isMultiTab) {
    const multiConfig = config as MultiTableConfig<T>;
    const multiVisibility = columnVisibility as Record<T, ColumnVisibilityState>;
    return {
      columnVisibility: multiVisibility,
      setColumnVisibility: (tab: T, visibility: ColumnVisibilityState) => {
        // Ensure all columns for this tab are present in the new state
        const allColumns = multiConfig[tab].all;
        const currentTabState = multiVisibility[tab] || {};

        // Create a new state that preserves all columns, defaulting to false for missing ones
        const newTabState = Object.fromEntries(
          allColumns.map((columnId) => [
            columnId,
            columnId in visibility
              ? visibility[columnId]
              : currentTabState[columnId] ?? false,
          ]),
        );

        setColumnVisibilityState({ ...multiVisibility, [tab]: newTabState });
      },
    };
  } else {
    // Single table implementation
    const singleConfig = config as SingleTableConfig;
    const singleVisibility = columnVisibility as ColumnVisibilityState;

    return {
      columnVisibility: singleVisibility,
      setColumnVisibility: (visibility: ColumnVisibilityState) => {
        // Ensure all columns are present in the new state
        const allColumns = singleConfig.all;
        const currentState = singleVisibility || {};

        // Create a new state that preserves all columns, defaulting to false for missing ones
        const newState = Object.fromEntries(
          allColumns.map((columnId) => [
            columnId,
            columnId in visibility
              ? visibility[columnId]
              : currentState[columnId] ?? false,
          ]),
        );

        setColumnVisibilityState(newState);
      },
    };
  }
}
