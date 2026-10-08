'use client';

/**
 * Epic 46 — single tree row.
 *
 * Stateless renderer for one `treeitem`. The TreeView container owns
 * focus, expansion, selection, and lazy-loading state — this
 * component just paints the row and delegates clicks back via
 * callbacks.
 *
 * Split from `TreeView.tsx` so a) the container's render path is
 * tractable and b) callers who need a custom row can swap this
 * implementation without forking the keyboard / focus logic. (Pass
 * `renderItem` to `<TreeView>` to do that — the default uses this
 * component.)
 */

import { ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@inflect/ui/lib/cn';
import type { ReactNode } from 'react';
import { forwardRef } from 'react';

export interface TreeViewItemProps {
    /** Stable id (matches the underlying node). */
    id: string;
    /** Display label — usually a short code or section name. */
    label: ReactNode;
    /** Optional secondary label (title, description). */
    secondary?: ReactNode;
    /** Right-side metadata (badges, counts). */
    meta?: ReactNode;
    /** 0-indexed depth from the tree root; used for indentation + ARIA. */
    depth: number;
    /** Whether this row has children to expand. */
    hasChildren: boolean;
    expanded: boolean;
    selected: boolean;
    /** True while a lazy `loadChildren` call is in flight for this node. */
    loading?: boolean;
    /**
     * Whether this row is the keyboard-focusable element. Only ONE
     * row in the tree carries `tabIndex=0` at any moment — see
     * `TreeView` for the roving-tabindex contract.
     */
    focusable: boolean;
    /** Called when the row body (not the chevron) is clicked. */
    onSelect: () => void;
    /** Called when the chevron is clicked. */
    onToggle: () => void;
}

/**
 * Indent step in pixels. Kept as a constant so a future overflow
 * mode (collapse-to-icons at deep levels) can compute breakpoints
 * without re-reading the className soup.
 */
const INDENT_PX = 16;

export const TreeViewItem = forwardRef<HTMLDivElement, TreeViewItemProps>(
    function TreeViewItem(
        {
            id,
            label,
            secondary,
            meta,
            depth,
            hasChildren,
            expanded,
            selected,
            loading = false,
            focusable,
            onSelect,
            onToggle,
        },
        ref,
    ) {
        return (
            <div
                ref={ref}
                role="treeitem"
                id={`treeitem-${id}`}
                aria-level={depth + 1}
                aria-expanded={hasChildren ? expanded : undefined}
                aria-selected={selected}
                tabIndex={focusable ? 0 : -1}
                data-tree-node-id={id}
                data-selected={selected ? 'true' : undefined}
                onClick={onSelect}
                className={cn(
                    'flex items-center gap-tight py-1.5 pr-2 cursor-pointer rounded-md',
                    'text-sm text-content-default transition-colors',
                    'hover:bg-bg-muted',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default',
                    selected && 'bg-[var(--brand-subtle)] text-content-brand font-medium',
                )}
                style={{ paddingLeft: depth * INDENT_PX + 4 }}
            >
                {/* Chevron — clickable, but does NOT trigger selection. */}
                <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden={!hasChildren}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (hasChildren) onToggle();
                    }}
                    className={cn(
                        'flex-shrink-0 w-5 h-5 flex items-center justify-center rounded',
                        hasChildren ? 'hover:bg-bg-muted text-content-muted' : 'invisible',
                    )}
                >
                    {loading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                        <ChevronRight
                            className={cn(
                                'w-3.5 h-3.5 transition-transform',
                                expanded && 'rotate-90',
                            )}
                            aria-hidden="true"
                        />
                    )}
                </button>

                <span className="truncate flex-1 min-w-0">
                    <span className="font-mono text-xs text-content-subtle mr-2">{label}</span>
                    {secondary && (
                        <span className="text-content-muted">{secondary}</span>
                    )}
                </span>
                {meta && (
                    <span className="flex-shrink-0 text-xs text-content-subtle ml-2">
                        {meta}
                    </span>
                )}
            </div>
        );
    },
);
