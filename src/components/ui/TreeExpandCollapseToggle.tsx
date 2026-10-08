'use client';

/**
 * Epic 46 — Generic expand-all / collapse-all control for any
 * `<TreeView>` consumer.
 *
 * Reusable beyond the framework explorer — any caller that holds an
 * expansion `Set<string>` plus the total number of expandable nodes
 * can drop this in. The toggle owns no state of its own — it's a
 * tiny stateless control that fires `onExpandAll` /
 * `onCollapseAll`. The tri-state visual (none / partial / all) is
 * derived from `expandedCount` vs `totalExpandable`.
 *
 * Inspired by the explorer-style pattern used in Vanta and Drata
 * for control / requirement libraries — two compact buttons grouped
 * together, with the inactive side de-emphasised. Clearer than a
 * single toggle that hides one action behind state.
 */

import { cn } from '@inflect/ui/lib/cn';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { getExpandToggleState } from '@/lib/framework-tree/tree-helpers';

export interface TreeExpandCollapseToggleProps {
    /** Number of nodes currently expanded. */
    expandedCount: number;
    /** Number of nodes that COULD be expanded (have children). */
    totalExpandable: number;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    /** Optional accessible labels — defaults to the obvious English. */
    expandLabel?: string;
    collapseLabel?: string;
    className?: string;
    /** Test/dom id; both buttons get suffixed `${id}-expand` / `${id}-collapse`. */
    id?: string;
}

export function TreeExpandCollapseToggle({
    expandedCount,
    totalExpandable,
    onExpandAll,
    onCollapseAll,
    expandLabel = 'Expand all',
    collapseLabel = 'Collapse all',
    className,
    id = 'tree-toggle',
}: TreeExpandCollapseToggleProps) {
    // Derive tri-state. Disabling the no-op direction makes the
    // affordance honest: when nothing's expanded, "Collapse all" is
    // pointless and clicking it would be confusing. The state
    // computation is a pure helper so the unit tests can cover it
    // without rendering the component.
    const state = getExpandToggleState(expandedCount, totalExpandable);
    const noWork = state === 'empty';
    const allExpanded = state === 'all';
    const noneExpanded = state === 'none' || noWork;

    return (
        <div
            className={cn(
                'inline-flex items-center rounded-md border border-border-default bg-bg-default',
                'divide-x divide-border-subtle overflow-hidden',
                className,
            )}
            role="group"
            aria-label="Tree expansion controls"
            data-tree-toggle-id={id}
        >
            <button
                type="button"
                onClick={onExpandAll}
                disabled={noWork || allExpanded}
                aria-label={expandLabel}
                title={expandLabel}
                id={`${id}-expand`}
                className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors',
                    'text-content-muted hover:text-content-emphasis hover:bg-bg-muted',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)] focus-visible:ring-inset',
                )}
            >
                <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{expandLabel}</span>
            </button>
            <button
                type="button"
                onClick={onCollapseAll}
                disabled={noWork || noneExpanded}
                aria-label={collapseLabel}
                title={collapseLabel}
                id={`${id}-collapse`}
                className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors',
                    'text-content-muted hover:text-content-emphasis hover:bg-bg-muted',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)] focus-visible:ring-inset',
                )}
            >
                <ChevronsDownUp className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{collapseLabel}</span>
            </button>
        </div>
    );
}
