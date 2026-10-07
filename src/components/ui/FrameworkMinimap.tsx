'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 46 — Framework Minimap.
 *
 * A narrow sidebar that lists the framework's top-level sections
 * with their compliance status. Two-way wired to the tree view it
 * accompanies:
 *
 *   - Minimap → tree: clicking a section scrolls the corresponding
 *     row into view in the tree's scroll container AND fires
 *     `onSectionSelected` so the parent can also expand/select the
 *     section in the underlying TreeView.
 *
 *   - Tree → minimap: an `IntersectionObserver` mounted on the
 *     section rows of the tree's scroll container drives an
 *     "active section" highlight in the minimap. The active
 *     section is purely derived from scroll state — there is no
 *     duplicated selection model.
 *
 * Performance: the observer fires per-section visibility events,
 * but the active-section pick is a pure O(n) reducer
 * (`pickActiveSection`) — even a 500-section framework recomputes
 * the active id in negligible time. The minimap itself renders
 * once per active-id change, not per scroll event.
 */

import { cn } from '@inflect/ui/lib/cn';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ComplianceStatusIndicator } from './ComplianceStatusIndicator';
import {
    type MinimapSection,
    deriveMinimapSections,
    pickActiveSection,
    type SectionVisibility,
} from '@/lib/framework-tree/minimap';
import type { FrameworkTreeNode } from '@/lib/framework-tree/types';

export interface FrameworkMinimapProps {
    /** Top-level nodes from the tree. Sections only are extracted internally. */
    nodes: ReadonlyArray<FrameworkTreeNode>;
    /**
     * The DOM element that scrolls the tree (the inner viewport,
     * NOT the page). The minimap watches its scrollable
     * descendants matching `[data-tree-node-id="<sectionId>"]`.
     */
    scrollContainerRef: React.RefObject<HTMLElement | null>;
    /**
     * Called when the user clicks a section in the minimap.
     * Receives the section node id. The parent should:
     *   1. Add the id to its `expanded` set (so the section is
     *      open in the tree),
     *   2. Optionally call `setSelectedId(id)` to reflect the
     *      selection in the detail pane.
     */
    onSectionSelected?: (id: string) => void;
    /** Test/dom id on the wrapper. */
    id?: string;
    className?: string;
}

export function FrameworkMinimap({
    nodes,
    scrollContainerRef,
    onSectionSelected,
    id = 'framework-minimap',
    className,
}: FrameworkMinimapProps) {
    const sections = useMemo(() => deriveMinimapSections(nodes), [nodes]);
    const sectionIds = useMemo(() => sections.map((s) => s.id), [sections]);

    // ── Active-section observer. ──────────────────────────────────────
    const [activeId, setActiveId] = useState<string | null>(null);
    // Live map of last-seen visibilities, keyed by section id. We
    // recompute the active id every observer callback by reducing
    // over this map's values via `pickActiveSection`.
    const visibilityRef = useRef<Map<string, SectionVisibility>>(new Map());

    useEffect(() => {
        // Reset visibility memory whenever the section list changes —
        // ids get rebuilt when the framework changes or when search
        // filters the tree.
        visibilityRef.current = new Map();
        if (sectionIds.length === 0) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setActiveId(null);
            return;
        }
        if (typeof IntersectionObserver === 'undefined') {
            // SSR / unsupported runtime — bail. The minimap still
            // renders, just without active-section sync.
            return;
        }
        const root = scrollContainerRef.current;
        if (!root) return;

        // Re-observe whenever the underlying tree DOM changes
        // (search filter, expand/collapse). MutationObserver on the
        // scroll container catches these without us needing a
        // timer.
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const id = (entry.target as HTMLElement).dataset.treeNodeId;
                    if (!id) continue;
                    const containerRect = root.getBoundingClientRect();
                    visibilityRef.current.set(id, {
                        id,
                        intersectionRatio: entry.intersectionRatio,
                        topOffset: entry.boundingClientRect.top - containerRect.top,
                    });
                }
                const next = pickActiveSection([...visibilityRef.current.values()]);
                setActiveId(next);
            },
            {
                root,
                threshold: [0, 0.25, 0.5, 0.75, 1],
            },
        );

        function observeAll() {
            for (const sid of sectionIds) {
                const el = root!.querySelector(
                    `[data-tree-node-id="${CSS.escape(sid)}"]`,
                );
                if (el) observer.observe(el);
            }
        }
        observeAll();

        const mut = new MutationObserver(() => {
            // Cheap to call observe() on already-observed elements
            // — IntersectionObserver dedupes.
            observeAll();
        });
        mut.observe(root, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            mut.disconnect();
        };
    }, [sectionIds, scrollContainerRef]);

    // ── Click → scroll the section row into view + notify parent. ─────
    const handleClick = useCallback(
        (sectionId: string) => {
            const root = scrollContainerRef.current;
            if (root) {
                const target = root.querySelector<HTMLElement>(
                    `[data-tree-node-id="${CSS.escape(sectionId)}"]`,
                );
                target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }
            onSectionSelected?.(sectionId);
        },
        [onSectionSelected, scrollContainerRef],
    );

    if (sections.length === 0) return null;

    return (
        <nav
            id={id}
            aria-label="Framework section navigator"
            className={cn(
                'flex flex-col gap-1 overflow-y-auto p-2 rounded-md border border-border-subtle bg-bg-default/30',
                className,
            )}
        >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle px-1 mb-1">
                Sections
            </p>
            {sections.map((section) => (
                <MinimapRow
                    key={section.id}
                    section={section}
                    active={section.id === activeId}
                    onClick={() => handleClick(section.id)}
                />
            ))}
        </nav>
    );
}

// ─── Single section row in the minimap ─────────────────────────────────

function MinimapRow({
    section,
    active,
    onClick,
}: {
    section: MinimapSection;
    active: boolean;
    onClick: () => void;
}) {
    const status = section.status ?? 'unknown';
    return (
        <button
            type="button"
            onClick={onClick}
            data-minimap-section-id={section.id}
            data-active={active ? 'true' : undefined}
            aria-current={active ? 'true' : undefined}
            className={cn(
                'group flex items-center gap-tight px-2 py-1.5 rounded text-left text-xs transition-colors',
                'text-content-muted hover:text-content-emphasis hover:bg-bg-muted',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-inset',
                active && 'bg-[var(--brand-subtle)] text-content-brand font-medium',
            )}
        >
            <ComplianceStatusIndicator
                status={status}
                mode="bar"
                className="self-stretch h-auto"
                labelled={false}
            />
            <span className="truncate flex-1 min-w-0">{section.label}</span>
            <span className="text-[10px] text-content-subtle tabular-nums">
                {section.descendantCount}
            </span>
        </button>
    );
}
