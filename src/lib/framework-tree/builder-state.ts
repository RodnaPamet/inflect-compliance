/**
 * Epic 46.4 — pure helpers for the FrameworkBuilder MVP.
 *
 * The builder reduces a `FrameworkTreePayload` to a flat
 * "sections + ordered requirements" model that's cheap to mutate
 * via array splices and serializes cleanly to the reorder
 * endpoint. All mutation helpers here are pure — the component
 * holds the state and calls the helper for every drag drop.
 */

import type { FrameworkTreeNode, FrameworkTreePayload } from './types';

export interface BuilderRequirement {
    id: string;
    code: string;
    title: string;
}

export interface BuilderSection {
    id: string;
    label: string;
    requirements: BuilderRequirement[];
}

/**
 * Reduce the decorated tree to the builder's flat-section shape.
 *
 * Sub-requirements (level 3+) are flattened into their parent
 * section. Reordering INSIDE a parent requirement is out of MVP
 * scope — the builder treats every requirement as a peer within
 * its section. Persisting that flat order is still correct; the
 * tree-builder will re-derive the dotted nesting on read since
 * `5.1.1` still has `5.1` as its prefix.
 */
export function deriveBuilderModel(
    payload: FrameworkTreePayload,
): BuilderSection[] {
    return payload.nodes
        .filter((n) => n.kind === 'section')
        .map((section) => ({
            id: section.id,
            label: section.label,
            requirements: collectRequirementsFlat(section.children),
        }));
}

function collectRequirementsFlat(
    nodes: ReadonlyArray<FrameworkTreeNode>,
    out: BuilderRequirement[] = [],
): BuilderRequirement[] {
    for (const n of nodes) {
        if (n.kind === 'requirement') {
            out.push({
                id: n.id,
                code: n.code ?? n.label,
                title: n.title,
            });
            collectRequirementsFlat(n.children, out);
        }
    }
    return out;
}

// ─── Mutation helpers ──────────────────────────────────────────────────

/**
 * Move a requirement from one position to another.
 *
 * Same-section moves: splice + re-insert. Cross-section moves:
 * remove from source, insert into destination. Returns a new
 * sections array — input is never mutated.
 */
export function moveRequirement(
    sections: ReadonlyArray<BuilderSection>,
    source: { sectionId: string; requirementId: string },
    target: { sectionId: string; index: number },
): BuilderSection[] {
    // Within a section only (#5231). A requirement's section is derived from
    // the framework (section / theme / category / code), and the saved order
    // records positions, not sections, so a requirement dropped into another
    // section went back to its own on reload, and could drag its old
    // section's position with it.
    if (source.sectionId !== target.sectionId) return sections.slice();
    const result = sections.map((s) => ({ ...s, requirements: [...s.requirements] }));
    const sourceSection = result.find((s) => s.id === source.sectionId);
    const targetSection = result.find((s) => s.id === target.sectionId);
    if (!sourceSection || !targetSection) return sections.slice();

    const sourceIdx = sourceSection.requirements.findIndex(
        (r) => r.id === source.requirementId,
    );
    if (sourceIdx < 0) return sections.slice();

    const [moved] = sourceSection.requirements.splice(sourceIdx, 1);

    let insertIdx = target.index;
    if (sourceSection === targetSection && sourceIdx < insertIdx) {
        // Removing-then-inserting in the same section shifts every
        // subsequent index left by one. Adjust so a "drop after the
        // 4th item" intent lands at the user-visible 4th slot.
        insertIdx -= 1;
    }
    insertIdx = Math.max(0, Math.min(insertIdx, targetSection.requirements.length));
    targetSection.requirements.splice(insertIdx, 0, moved);
    return result;
}

/**
 * Move a section up/down to a new index in the section list.
 *
 * The brute-force re-numbering happens server-side
 * (`flattenOrderedSectionsToOverlay`); on the client we just
 * splice the section list. Returns a new sections array.
 */
export function moveSection(
    sections: ReadonlyArray<BuilderSection>,
    sourceId: string,
    targetIndex: number,
): BuilderSection[] {
    const out = sections.slice();
    const sourceIdx = out.findIndex((s) => s.id === sourceId);
    if (sourceIdx < 0) return sections.slice();
    const [moved] = out.splice(sourceIdx, 1);
    let insertIdx = targetIndex;
    if (sourceIdx < insertIdx) insertIdx -= 1;
    insertIdx = Math.max(0, Math.min(insertIdx, out.length));
    out.splice(insertIdx, 0, moved);
    return out;
}

/**
 * Serialize a builder model into the reorder endpoint's body shape.
 */
export function serializeForApi(
    sections: ReadonlyArray<BuilderSection>,
): { sections: { sectionId: string; requirementIds: string[] }[] } {
    return {
        sections: sections.map((s) => ({
            sectionId: s.id,
            requirementIds: s.requirements.map((r) => r.id),
        })),
    };
}

/**
 * Returns true when the in-memory model differs from the original
 * server-derived model. Used to enable/disable the "Save" button
 * and warn on navigation away.
 */
export function isModelDirty(
    current: ReadonlyArray<BuilderSection>,
    original: ReadonlyArray<BuilderSection>,
): boolean {
    if (current.length !== original.length) return true;
    for (let i = 0; i < current.length; i++) {
        if (current[i].id !== original[i].id) return true;
        const a = current[i].requirements;
        const b = original[i].requirements;
        if (a.length !== b.length) return true;
        for (let j = 0; j < a.length; j++) {
            if (a[j].id !== b[j].id) return true;
        }
    }
    return false;
}
