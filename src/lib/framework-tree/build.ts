/**
 * Epic 46 — pure tree builder for framework hierarchies.
 *
 * The `FrameworkRequirement` table is FLAT: there is no `parentId`
 * column. Hierarchy is encoded in three different shapes across the
 * seeded frameworks:
 *
 *   1. ISO 27001  — `theme` + `themeNumber` carry the section
 *                   ("ORGANIZATIONAL"/5, "PEOPLE"/6, ...). Codes look
 *                   like `5.1`, `5.10` (no third level today).
 *   2. NIS 2      — `section` carries the article header
 *                   ("Article 21 - ..."). Codes like `Art.21(2)(a)`.
 *   3. SOC 2      — neither `section` nor `theme`. Codes like `CC1.1`.
 *
 * The builder picks the strongest available signal for grouping and
 * always supports at least 3 logical levels (section → requirement →
 * sub-requirement) without requiring a schema change. When sub-
 * requirements DON'T exist in the data, the tree gracefully degrades
 * to two levels.
 *
 * Pure + deterministic — same input always produces the same output,
 * which keeps the contract testable and lets the caller cache the
 * result confidently.
 */

import type { FrameworkTreeNode, FrameworkTreePayload } from './types';

// ─── Inputs ────────────────────────────────────────────────────────────

/** Minimal framework descriptor the builder needs. */
export interface BuildableFramework {
    id: string;
    key: string;
    name: string;
    version: string | null;
    kind: string;
    description: string | null;
}

/**
 * Minimal requirement descriptor — matches a subset of
 * `FrameworkRequirement` columns. Keeping this narrow lets unit tests
 * construct fixtures without touching Prisma types.
 */
export interface BuildableRequirement {
    id: string;
    code: string;
    title: string;
    description: string | null;
    section: string | null;
    category: string | null;
    theme: string | null;
    themeNumber: number | null;
    sortOrder: number;
}

// ─── Section-key derivation ────────────────────────────────────────────

/**
 * Pick the strongest grouping signal for a single requirement.
 *
 * Preference order is intentional: explicit metadata beats implicit
 * code-prefix derivation. Empty strings are treated as missing
 * (real seed data has both `null` and `""` in the wild).
 */
/**
 * The section a requirement belongs to, as the tree groups it. A section is
 * derived from the framework's own fields, so a tenant's reorder can move a
 * requirement within its section but never into another (#5231).
 */
export function sectionKeyOf(req: Pick<BuildableRequirement, 'code' | 'section' | 'theme' | 'category'>): string {
    return deriveSectionKey({ ...req, id: '', title: '', description: null, themeNumber: null, sortOrder: 0 }).key;
}

function deriveSectionKey(req: BuildableRequirement): {
    key: string;
    label: string;
    sortOrder: number;
} {
    if (req.section && req.section.trim()) {
        return { key: `section:${req.section}`, label: req.section.trim(), sortOrder: req.sortOrder };
    }
    if (req.theme && req.theme.trim()) {
        // Theme grouping — `themeNumber` is intentionally NOT used
        // for the section's effective sortOrder. The seed loads
        // requirements in theme order so MIN(req.sortOrder) per
        // theme naturally sorts ORGANIZATIONAL → PEOPLE → … in
        // the original order. Using `req.sortOrder` here is what
        // makes the Epic 46.4 per-tenant reorder overlay actually
        // re-order sections — overlay rows update the per-row
        // sortOrder, and the section's MIN follows.
        return { key: `theme:${req.theme}`, label: req.theme.trim(), sortOrder: req.sortOrder };
    }
    if (req.category && req.category.trim()) {
        return { key: `category:${req.category}`, label: req.category.trim(), sortOrder: req.sortOrder };
    }
    // Fall back to the leading code segment (`CC1.1` → `CC1`,
    // `5.10` → `5`). Splits on the first dot OR the first
    // parenthesis so `Art.21(2)(a)` → `Art.21` (already a useful
    // grouping for SOC2-like data even though NIS2 wouldn't reach
    // this branch in practice).
    const codePrefix = req.code.split(/[.(]/)[0] || req.code;
    return { key: `code:${codePrefix}`, label: codePrefix, sortOrder: req.sortOrder };
}

// ─── Code-prefix nesting (level 3+) ────────────────────────────────────

/**
 * Detects whether `child` is a strict dotted descendant of `parent`.
 *
 * Examples:
 *   `5.1.1` is a child of `5.1`        ✓
 *   `5.10`  is NOT a child of `5.1`    ✗ (lexical-prefix trap)
 *   `5.1`   is NOT a child of `5.1`    ✗ (strict)
 *
 * The dot-boundary check rules out the lexical-prefix trap that
 * would otherwise corrupt the tree (`5.1` "containing" `5.10`).
 */
function isDottedChildCode(parent: string, child: string): boolean {
    if (parent === child) return false;
    if (!child.startsWith(parent)) return false;
    return child.charAt(parent.length) === '.';
}

/**
 * Build a nested tree of requirement nodes from a flat sibling
 * list, parenting each requirement under the longest existing
 * sibling that is its dotted prefix.
 *
 * Algorithm: sort siblings by code-segment count ascending so
 * potential parents are processed before their children, then for
 * each child walk back to find the nearest ancestor by code.
 *
 * Complexity: O(n²) per section in the pathological case, but
 * sections are always small (largest seeded today is 37 for
 * ISO27001 ORGANIZATIONAL), so the constant factor dominates.
 */
function nestRequirementsByCode(
    requirements: BuildableRequirement[],
): FrameworkTreeNode[] {
    if (requirements.length === 0) return [];

    // Sort by depth-of-code (number of dotted segments) ASC, then by
    // sortOrder ASC. Shallow first means we can resolve parents
    // greedily without backtracking.
    const sorted = [...requirements].sort((a, b) => {
        const da = a.code.split('.').length;
        const db = b.code.split('.').length;
        if (da !== db) return da - db;
        return a.sortOrder - b.sortOrder;
    });

    type WorkNode = FrameworkTreeNode & { _children: FrameworkTreeNode[] };
    const nodesByCode = new Map<string, WorkNode>();
    const roots: WorkNode[] = [];

    for (const req of sorted) {
        const node: WorkNode = {
            id: req.id,
            kind: 'requirement',
            label: req.code,
            title: req.title,
            description: req.description,
            code: req.code,
            sortOrder: req.sortOrder,
            descendantCount: 0,
            childCount: 0,
            hasChildren: false,
            children: [],
            _children: [],
        };

        // Find longest-prefix existing parent (e.g. for `5.1.2.3`,
        // try `5.1.2` then `5.1` then `5`).
        let parent: WorkNode | undefined;
        const segments = req.code.split('.');
        for (let i = segments.length - 1; i >= 1; i--) {
            const prefix = segments.slice(0, i).join('.');
            const candidate = nodesByCode.get(prefix);
            if (candidate && isDottedChildCode(candidate.code!, req.code)) {
                parent = candidate;
                break;
            }
        }
        if (parent) {
            parent._children.push(node);
        } else {
            roots.push(node);
        }
        nodesByCode.set(req.code, node);
    }

    // Stabilise sibling order at every level (sortOrder ASC) and
    // compute aggregates bottom-up.
    function finalise(node: WorkNode): { descendants: number } {
        node._children.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        let descendants = 0;
        for (const child of node._children) {
            const sub = finalise(child as WorkNode);
            descendants += 1 + sub.descendants;
        }
        node.children = node._children;
        node.childCount = node._children.length;
        node.descendantCount = descendants;
        node.hasChildren = node._children.length > 0;
        delete (node as Partial<WorkNode>)._children;
        return { descendants };
    }

    roots.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (const root of roots) finalise(root);
    return roots;
}

// ─── Top-level builder ─────────────────────────────────────────────────

/**
 * Build the full framework tree.
 *
 * Output shape: an array of section nodes, each containing
 * requirement nodes (which may themselves contain dotted-prefix
 * children).
 */
export function buildFrameworkTree(
    framework: BuildableFramework,
    requirements: ReadonlyArray<BuildableRequirement>,
): FrameworkTreePayload {
    // Group by derived section key.
    const groups = new Map<
        string,
        { label: string; sortOrder: number; reqs: BuildableRequirement[] }
    >();
    for (const req of requirements) {
        const { key, label, sortOrder } = deriveSectionKey(req);
        const existing = groups.get(key);
        if (existing) {
            existing.reqs.push(req);
            // Promote the smallest sortOrder in the group as the
            // canonical section sortOrder so groups order stably.
            if (sortOrder < existing.sortOrder) existing.sortOrder = sortOrder;
        } else {
            groups.set(key, { label, sortOrder, reqs: [req] });
        }
    }

    let maxDepth = 0;
    function depthOf(node: FrameworkTreeNode, current = 1): number {
        if (!node.children.length) return current;
        let m = current;
        for (const c of node.children) m = Math.max(m, depthOf(c, current + 1));
        return m;
    }

    const sectionNodes: FrameworkTreeNode[] = [];
    let sectionIndex = 0;
    const sortedGroups = [...groups.entries()].sort(([, a], [, b]) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.label.localeCompare(b.label);
    });

    for (const [key, group] of sortedGroups) {
        const reqRoots = nestRequirementsByCode(group.reqs);
        let descendants = 0;
        for (const r of reqRoots) descendants += 1 + r.descendantCount;
        const node: FrameworkTreeNode = {
            id: `section:${framework.id}:${key}:${sectionIndex++}`,
            kind: 'section',
            label: group.label,
            title: group.label,
            description: null,
            descendantCount: descendants,
            childCount: reqRoots.length,
            hasChildren: reqRoots.length > 0,
            children: reqRoots,
        };
        sectionNodes.push(node);
        const d = depthOf(node);
        if (d > maxDepth) maxDepth = d;
    }

    return {
        framework: {
            id: framework.id,
            key: framework.key,
            name: framework.name,
            version: framework.version,
            kind: framework.kind,
            description: framework.description,
        },
        nodes: sectionNodes,
        totals: {
            sections: sectionNodes.length,
            requirements: requirements.length,
            maxDepth,
        },
    };
}
