'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 46 — Framework Explorer.
 *
 * Replaces the flat "Requirements" tab on the framework detail
 * page. Two-pane layout: the tree on the left (sections →
 * requirements [→ sub-requirements]) and a selected-node detail
 * panel on the right. Reuses the generic `<TreeView>` primitive +
 * the new `/tree` API.
 *
 * What it carries forward from the old flat view:
 *   - Search box (now filters the tree, expanding ancestors of any
 *     match so hits stay visible)
 *   - Mapped/unmapped indicator + control count badge per row
 *   - Drilldown into mapped controls for a selected requirement
 *
 * What it adds:
 *   - Real hierarchy with section / requirement / sub-requirement
 *     nesting (3+ levels) drawn from the new tree API
 *   - Global Expand-all / Collapse-all toggle
 *   - Keyboard navigation + ARIA tree semantics inherited from
 *     `<TreeView>`
 *   - Stable side-panel detail view with description + linked
 *     controls
 *
 * Coverage data is reused from the existing
 * `/frameworks/<key>?action=coverage` endpoint — no new server
 * surface is needed for the mapped/unmapped indicators.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, FileText } from 'lucide-react';
import { TreeView } from '@/components/ui/TreeView';
import { TreeViewItem } from '@/components/ui/TreeViewItem';
import { TreeExpandCollapseToggle } from '@/components/ui/TreeExpandCollapseToggle';
import { ComplianceStatusIndicator } from '@/components/ui/ComplianceStatusIndicator';
import { frameworkSectionLabel } from '@/lib/framework-tree/section-label';
import { FrameworkMinimap } from '@/components/ui/FrameworkMinimap';
import {
    collectExpandableIds,
    filterTree,
} from '@/lib/framework-tree/tree-helpers';
import type {
    ComplianceStatus,
    FrameworkTreeNode,
    FrameworkTreePayload,
} from '@/lib/framework-tree/types';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { useIsBelowMd } from '@/components/ui/hooks';

// ─── Coverage shapes (subset of the existing coverage usecase output) ──

interface ControlMapping {
    requirementCode: string;
    controlCode: string;
    controlName: string;
    controlStatus: string;
}
interface CoveragePayload {
    controlMappings?: ControlMapping[];
}

// ─── Props ─────────────────────────────────────────────────────────────

export interface FrameworkExplorerProps {
    tree: FrameworkTreePayload;
    coverage: CoveragePayload | null;
    /**
     * Callback when the user picks a requirement. The detail
     * panel renders inline — this is purely for parents that want
     * to react (e.g. URL sync). Selecting a section node is a no-op.
     */
    onRequirementSelected?: (node: FrameworkTreeNode) => void;
}

// ─── Component ─────────────────────────────────────────────────────────

export function FrameworkExplorer({
    tree,
    coverage,
    onRequirementSelected,
}: FrameworkExplorerProps) {
    const t = useTranslations('panels.framework');
    // ── Derived: per-requirement control mappings, keyed by code. ────
    // The coverage usecase keys by `requirementCode` (not id), so we
    // build a lookup once and reuse it on every selection.
    const controlsByCode = useMemo(() => {
        const map = new Map<string, ControlMapping[]>();
        for (const m of coverage?.controlMappings ?? []) {
            const list = map.get(m.requirementCode) ?? [];
            list.push(m);
            map.set(m.requirementCode, list);
        }
        return map;
    }, [coverage]);

    // ── Search → filtered tree + auto-expansion of matching paths. ───
    const [search, setSearch] = useState('');
    const trimmed = search.trim().toLowerCase();
    const filteredTree = useMemo(() => {
        if (!trimmed) return tree.nodes;
        return filterTree(tree.nodes, (node) => {
            // Sections only match if their LABEL matches — searching
            // "people" surfaces the whole PEOPLE theme. Requirements
            // match on code OR title.
            if (node.kind === 'section') {
                return node.label.toLowerCase().includes(trimmed);
            }
            return (
                (node.code ?? '').toLowerCase().includes(trimmed) ||
                node.title.toLowerCase().includes(trimmed)
            );
        });
    }, [tree.nodes, trimmed]);

    // ── Expansion state. ──────────────────────────────────────────────
    // While a search is active we auto-expand every matching ancestor
    // so hits are visible without the user clicking. When the search
    // clears, we restore the user's manual expansion (cached).
    const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const allExpandableIdsForSearch = useMemo(
        () => collectExpandableIds(filteredTree),
        [filteredTree],
    );
    const expanded: ReadonlySet<string> = trimmed
        ? allExpandableIdsForSearch
        : userExpanded;

    // Total expandable count (for the toggle's tri-state) is computed
    // off the UNFILTERED tree so disabling logic doesn't flicker as
    // the user types.
    const totalExpandable = useMemo(
        () => collectExpandableIds(tree.nodes).size,
        [tree.nodes],
    );

    const handleExpandedChange = useCallback(
        (next: ReadonlySet<string>) => {
            // Ignore writes while search-driven auto-expansion is in
            // effect — they'd be overwritten on the next render anyway.
            if (trimmed) return;
            setUserExpanded(next);
        },
        [trimmed],
    );

    const handleExpandAll = useCallback(() => {
        if (trimmed) {
            // Bail out of search first so the new expansion sticks.
            setSearch('');
        }
        setUserExpanded(collectExpandableIds(tree.nodes));
    }, [tree.nodes, trimmed]);

    const handleCollapseAll = useCallback(() => {
        if (trimmed) setSearch('');
        setUserExpanded(new Set());
    }, [trimmed]);

    // ── Selection. ────────────────────────────────────────────────────
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedNode = useMemo(() => {
        if (!selectedId) return null;
        return findNodeById(tree.nodes, selectedId);
    }, [tree.nodes, selectedId]);

    // ── Phone drill-in (Mobile 4.4, owner decision 2026-11-23). ───────
    // Below `md` the panes cannot sit side by side, and stacked, a tap on a
    // requirement changed the detail pane far below the tree, so the tap
    // looked like it did nothing. On a phone the tree is the page; tapping
    // a requirement opens its detail IN PLACE of the tree, scrolled into
    // view, and Back returns to the tree at the scroll position it left.
    // The tree stays mounted (hidden by CSS), so its expansion survives the
    // round trip. Desktop keeps the master/detail panes: `phoneDetail` only
    // ever changes below `md`, and its classes are all `max-md:`.
    const belowMd = useIsBelowMd();
    const [phoneDetail, setPhoneDetail] = useState(false);
    /** Where the page was scrolled when the detail opened. */
    const treeScrollY = useRef(0);
    /** What to do once the pane swap has painted. */
    const pendingScroll = useRef<'detail' | 'tree' | null>(null);
    const detailRef = useRef<HTMLDivElement | null>(null);
    const backRef = useRef<HTMLButtonElement | null>(null);

    const closePhoneDetail = useCallback(() => {
        pendingScroll.current = 'tree';
        setPhoneDetail(false);
    }, []);

    useEffect(() => {
        const pending = pendingScroll.current;
        if (!pending) return;
        pendingScroll.current = null;
        if (pending === 'detail') {
            detailRef.current?.scrollIntoView({ block: 'start' });
            backRef.current?.focus({ preventScroll: true });
        } else {
            window.scrollTo({ top: treeScrollY.current });
            if (selectedId) {
                document.getElementById(`treeitem-${selectedId}`)?.focus({ preventScroll: true });
            }
        }
    }, [phoneDetail, selectedId]);

    const handleSelect = useCallback(
        (node: FrameworkTreeNode) => {
            setSelectedId(node.id);
            if (node.kind === 'requirement') {
                onRequirementSelected?.(node);
                if (belowMd) {
                    treeScrollY.current = window.scrollY;
                    pendingScroll.current = 'detail';
                    setPhoneDetail(true);
                }
            }
        },
        [onRequirementSelected, belowMd],
    );

    // Clear selection when the underlying framework changes.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedId(null);
        setUserExpanded(new Set());
        setPhoneDetail(false);
    }, [tree.framework.id]);

    // ── Mapped/unmapped lookup for badges. ────────────────────────────
    const isMapped = useCallback(
        (code: string | undefined) => {
            if (!code) return false;
            return controlsByCode.has(code);
        },
        [controlsByCode],
    );

    // Ref to the tree's scroll container so the minimap can both
    // observe scroll position AND trigger scrollIntoView jumps.
    // Declared BEFORE the empty-state early return so the hook
    // call order stays stable across renders (rules-of-hooks).
    const treeScrollRef = useRef<HTMLDivElement | null>(null);

    // Minimap → tree handler: ensure the section is expanded so the
    // user lands on a populated row, not a collapsed header that
    // would immediately scroll out of view as the surrounding rows
    // re-flow.
    const handleMinimapJump = useCallback(
        (sectionId: string) => {
            if (trimmed) {
                // Search-active overrides expansion — the minimap
                // jump is the user's intent, so clear the search.
                setSearch('');
            }
            setUserExpanded((prev) => {
                if (prev.has(sectionId)) return prev;
                const next = new Set(prev);
                next.add(sectionId);
                return next;
            });
            setSelectedId(sectionId);
        },
        [trimmed],
    );

    // ── Empty state for the tree side. ────────────────────────────────
    if (tree.nodes.length === 0) {
        return (
            <div className={cn(cardVariants({ density: 'none' }), 'text-center py-10 text-content-subtle')} id="framework-explorer-empty">
                {t('empty')}
            </div>
        );
    }

    return (
        <div
            className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px)_12rem_1fr] gap-default"
            id="framework-explorer"
            data-phone-view={phoneDetail ? 'detail' : 'tree'}
        >
            {/* ── Tree pane ── (on a phone: hidden while a detail is open) */}
            <div
                className={cn(cardVariants({ density: 'none' }), 'flex flex-col min-h-[24rem]', phoneDetail && 'max-md:hidden')}
                id="framework-explorer-tree"
            >
                <div className="flex flex-wrap items-center gap-tight mb-3">
                    <input
                        type="text"
                        placeholder={t('searchPlaceholder')}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="input flex-1 min-w-[10rem]"
                        id="framework-explorer-search"
                        aria-label={t('searchAria')}
                    />
                    <TreeExpandCollapseToggle
                        expandedCount={expanded.size}
                        totalExpandable={totalExpandable}
                        onExpandAll={handleExpandAll}
                        onCollapseAll={handleCollapseAll}
                        id="framework-explorer-toggle"
                    />
                </div>
                <div className="flex items-center justify-between text-xs text-content-subtle mb-2">
                    <span>
                        {t('totals', { sections: tree.totals.sections, requirements: tree.totals.requirements })}
                    </span>
                    {trimmed && (
                        <span className="text-[var(--brand-default)]">
                            {t('searchActive')}
                        </span>
                    )}
                </div>
                <div
                    ref={treeScrollRef}
                    className="flex-1 overflow-y-auto -mx-2 px-1"
                    id="framework-explorer-tree-scroll"
                >
                    <TreeView
                        nodes={filteredTree}
                        expanded={expanded}
                        onExpandedChange={handleExpandedChange}
                        selectedId={selectedId}
                        onSelect={handleSelect}
                        ariaLabel={t('requirementsAria', { name: tree.framework.name })}
                        renderItem={(node, ctx) => (
                            <FrameworkTreeRow
                                node={node}
                                ctx={ctx}
                                isMapped={isMapped(node.code)}
                                mappedCount={
                                    node.code ? controlsByCode.get(node.code)?.length ?? 0 : 0
                                }
                                onToggle={() => {
                                    if (trimmed) return; // honour the search-active gate
                                    const next = new Set(expanded);
                                    if (next.has(node.id)) next.delete(node.id);
                                    else next.add(node.id);
                                    handleExpandedChange(next);
                                }}
                                onSelect={() => {
                                    // On a phone a section is a heading in a
                                    // list, not a destination: a tap opens or
                                    // closes it, as its chevron does.
                                    if (belowMd && node.kind === 'section' && node.hasChildren && !trimmed) {
                                        const next = new Set(expanded);
                                        if (next.has(node.id)) next.delete(node.id);
                                        else next.add(node.id);
                                        handleExpandedChange(next);
                                    }
                                    handleSelect(node);
                                }}
                            />
                        )}
                    />
                </div>
            </div>

            {/* ── Minimap (Epic 46.3) ── */}
            <div className="hidden lg:block">
                <FrameworkMinimap
                    nodes={tree.nodes}
                    scrollContainerRef={treeScrollRef}
                    onSectionSelected={handleMinimapJump}
                />
            </div>

            {/* ── Detail pane ── (on a phone: shown only while drilled in) */}
            <div
                ref={detailRef}
                className={cn(
                    cardVariants({ density: 'none' }),
                    'min-h-[24rem] max-md:scroll-mt-32',
                    !phoneDetail && 'max-md:hidden',
                )}
                id="framework-explorer-detail"
            >
                {phoneDetail && (
                    <div className="border-b border-border-subtle px-2 py-tight md:hidden">
                        <button
                            ref={backRef}
                            type="button"
                            onClick={closePhoneDetail}
                            id="framework-explorer-back"
                            className="inline-flex min-h-11 items-center gap-tight rounded-md px-2 text-sm font-medium text-content-default hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]"
                        >
                            <ChevronLeft className="size-4" aria-hidden="true" />
                            {t('backToRequirements')}
                        </button>
                    </div>
                )}
                {!selectedNode ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-content-subtle px-6 py-10">
                        <FileText className="w-8 h-8 mb-2 opacity-60" aria-hidden="true" />
                        <p className="text-sm font-medium text-content-muted">{t('selectRequirement')}</p>
                        <p className="text-xs mt-1 max-w-xs">
                            {t('selectHint')}
                        </p>
                    </div>
                ) : selectedNode.kind === 'section' ? (
                    <SectionDetail node={selectedNode} />
                ) : (
                    <RequirementDetail
                        node={selectedNode}
                        controls={controlsByCode.get(selectedNode.code ?? '') ?? []}
                    />
                )}
            </div>
        </div>
    );
}

// ─── Row renderer ──────────────────────────────────────────────────────

interface FrameworkTreeRowProps {
    node: FrameworkTreeNode;
    ctx: {
        depth: number;
        expanded: boolean;
        selected: boolean;
        focusable: boolean;
        loading: boolean;
    };
    isMapped: boolean;
    mappedCount: number;
    onToggle: () => void;
    onSelect: () => void;
}

function FrameworkTreeRow({
    node,
    ctx,
    isMapped,
    mappedCount,
    onToggle,
    onSelect,
}: FrameworkTreeRowProps) {
    const t = useTranslations('panels.framework');
    const tRoot = useTranslations();
    // Epic 46.3 — compliance status comes from the server. Sections
    // get the aggregated status; requirements get their own. When
    // the tree was loaded without coverage context the status falls
    // back to `undefined` and we render the legacy mapped/unmapped
    // affordance — that's a safety net, not the happy path.
    const status: ComplianceStatus | undefined = node.complianceStatus;
    const isSection = node.kind === 'section';

    let indicator: React.ReactNode = null;
    let meta: React.ReactNode;

    if (isSection) {
        // Sections show the aggregated status as a small dot plus
        // the descendant count. Avoids the "Mapped (37)" green-bias
        // bug where a section with 30 in-progress controls looked
        // green just because every requirement had at least one
        // mapped control.
        if (status) {
            indicator = (
                <ComplianceStatusIndicator status={status} mode="dot" />
            );
        }
        meta = (
            <span className="text-content-subtle text-xs">
                {node.descendantCount}
            </span>
        );
    } else {
        // Requirement rows: the dot encodes compliance status; the
        // meta badge shows the mapped-controls count when there is
        // one, otherwise the explicit "Unmapped" pill.
        if (status) {
            indicator = (
                <ComplianceStatusIndicator status={status} mode="dot" />
            );
            if (node.outOfScope) {
                // Outside the packs this workspace chose: not a gap, so it
                // says so instead of wearing the unmapped chip.
                meta = (
                    <StatusBadge variant="neutral" size="sm">
                        {t('outOfScope')}
                    </StatusBadge>
                );
            } else {
                meta = isMapped ? (
                    <span className="text-xs text-content-subtle tabular-nums">
                        {mappedCount}
                    </span>
                ) : (
                    <ComplianceStatusIndicator
                        status="gap"
                        mode="chip"
                        labelled={false}
                    />
                );
            }
        } else {
            // Coverage data missing — fall back to the prompt-2 affordance.
            meta = isMapped ? (
                <StatusBadge variant="success" size="sm">
                    {mappedCount}
                </StatusBadge>
            ) : (
                <StatusBadge variant="neutral" size="sm">
                    {t('unmapped')}
                </StatusBadge>
            );
        }
    }

    return (
        <TreeViewItem
            id={node.id}
            label={
                isSection ? (
                    frameworkSectionLabel(node.label, tRoot)
                ) : (
                    // A requirement code never breaks mid-token ("A-/5.1").
                    <span className="whitespace-nowrap">{node.label}</span>
                )
            }
            secondary={
                isSection ? null : (
                    <span className="inline-flex items-center gap-1.5">
                        {indicator}
                        <span>{node.title}</span>
                    </span>
                )
            }
            meta={
                isSection ? (
                    <span className="inline-flex items-center gap-1.5">
                        {indicator}
                        {meta}
                    </span>
                ) : (
                    meta
                )
            }
            depth={ctx.depth}
            hasChildren={node.hasChildren}
            expanded={ctx.expanded}
            selected={ctx.selected}
            focusable={ctx.focusable}
            loading={ctx.loading}
            onToggle={onToggle}
            onSelect={onSelect}
        />
    );
}

// ─── Detail-pane sub-components ────────────────────────────────────────

function SectionDetail({ node }: { node: FrameworkTreeNode }) {
    const t = useTranslations('panels.framework');
    const tRoot = useTranslations();
    return (
        <div className="p-5">
            <p className="text-xs uppercase tracking-wider text-content-subtle mb-1">
                {t('section')}
            </p>
            <Heading level={2}>{frameworkSectionLabel(node.label, tRoot)}</Heading>
            <p className="text-xs text-content-muted mt-2">
                {node.descendantCount === 1
                    ? t('sectionCountOne', { count: node.descendantCount })
                    : t('sectionCountMany', { count: node.descendantCount })}
            </p>
        </div>
    );
}

function RequirementDetail({
    node,
    controls,
}: {
    node: FrameworkTreeNode;
    controls: ControlMapping[];
}) {
    const t = useTranslations('panels.framework');
    const tr = useTranslations();
    const CONTROL_STATUS_LABELS: Record<string, string> = {
        NOT_STARTED: tr('controls.statusLabels.NOT_STARTED'), IN_PROGRESS: tr('controls.statusLabels.IN_PROGRESS'),
        IMPLEMENTED: tr('controls.statusLabels.IMPLEMENTED'), NEEDS_REVIEW: tr('controls.statusLabels.NEEDS_REVIEW'),
        IMPLEMENTING: tr('controls.implementing'), PLANNED: tr('controls.planned'),
        NOT_APPLICABLE: tr('controls.notApplicable'),
    };
    return (
        <div className="p-5 space-y-default" id="framework-explorer-requirement-detail">
            <div>
                <p className="text-xs uppercase tracking-wider text-content-subtle mb-1">
                    {t('requirement')}
                </p>
                <div className="flex items-center gap-compact flex-wrap">
                    <code className="text-sm font-mono text-[var(--brand-default)]">
                        {node.code}
                    </code>
                    <Heading level={2}>
                        {node.title}
                    </Heading>
                    {node.complianceStatus && (
                        <ComplianceStatusIndicator
                            status={node.complianceStatus}
                            mode="chip"
                        />
                    )}
                </div>
            </div>

            {node.outOfScope && (
                <p className="text-sm text-content-muted">{t('outOfScopeDetail')}</p>
            )}

            {node.description && (
                <p className="text-sm text-content-muted whitespace-pre-line">
                    {node.description}
                </p>
            )}

            {node.children.length > 0 && (
                <div>
                    <p className="text-xs font-semibold text-content-subtle mb-2">
                        {t('subRequirements', { count: node.children.length })}
                    </p>
                    <ul className="space-y-1">
                        {node.children.map((c) => (
                            <li key={c.id} className="text-xs text-content-default">
                                <code className="font-mono text-[var(--brand-default)] mr-2">
                                    {c.code}
                                </code>
                                {c.title}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-content-subtle">
                        {t('mappedControls', { count: controls.length })}
                    </p>
                    {controls.length === 0 && !node.outOfScope && (
                        <span className="text-xs text-content-warning">{t('unmapped')}</span>
                    )}
                </div>
                {controls.length === 0 ? (
                    <p className="text-xs text-content-subtle italic">
                        {t('mappedControlsEmpty')}
                    </p>
                ) : (
                    <ul className="space-y-1.5">
                        {controls.map((c, i) => (
                            <li
                                key={`${c.controlCode}-${i}`}
                                className="flex items-center gap-tight text-xs"
                            >
                                <code className="font-mono text-[var(--brand-default)] truncate max-w-trunc-tight">
                                    {c.controlCode}
                                </code>
                                <span className="text-content-default flex-1 truncate">
                                    {c.controlName}
                                </span>
                                <StatusBadge variant={c.controlStatus === 'IMPLEMENTED'
                                            ? 'success'
                                            : c.controlStatus === 'IN_PROGRESS'
                                              ? 'warning'
                                              : 'info'} size="sm">
                                    {CONTROL_STATUS_LABELS[c.controlStatus] ?? c.controlStatus.replace(/_/g, ' ')}
                                </StatusBadge>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

// ─── Local utility ─────────────────────────────────────────────────────

function findNodeById(
    nodes: ReadonlyArray<FrameworkTreeNode>,
    id: string,
): FrameworkTreeNode | null {
    for (const n of nodes) {
        if (n.id === id) return n;
        const sub = findNodeById(n.children, id);
        if (sub) return sub;
    }
    return null;
}

// Re-export so callers that just want one import path can pull it
// from the explorer module.
export { TreeExpandCollapseToggle };
