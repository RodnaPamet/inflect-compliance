/**
 * The PROCESS_MAP proposal's payload contract (#5053): its schema, the
 * canonical form a stored payload takes, and the preview a reviewer reads.
 *
 * ── ONE READER FOR REVIEW AND FOR APPROVAL ───────────────────────────────────
 *
 * `readProposedProcessMap` is the only function that turns a stored payload
 * into a map. The review diff (`buildProposalDiffs`) and the approval
 * (`prepareProcessMapApproval`) both call it, so a map the review surfaces
 * cannot render can never be approved over the API either, and what is
 * rendered is what is created.
 *
 * ── THE AGENT CHOOSES NO IDENTIFIER AND NO POSITION ──────────────────────────
 *
 * The schema is strict at every level. A step carries a key (used only to wire
 * the arrows), a type, a label and an optional subtitle; an arrow carries its
 * two endpoints and an optional label. Positions, parents, `dataJson` (a rule
 * id, a linked record), edge controls (real Control rows), edge kinds, the
 * canvas mode, the status and the freeform layer are all refused. An approved
 * map is a DRAFT in Document mode, laid out on the server.
 *
 * `canonicaliseProposedProcessMap` re-mints the step keys `n1..nN` in
 * declaration order and rewrites the arrows through the old→new map, so no
 * key the agent chose is ever stored. Arrows carry no key at all: arrow `i`
 * is `e<i+1>`, by position.
 *
 * CLIENT-SAFE: zod and a pure schema module only. No Node built-in, no React,
 * no layout engine. The layout boxes the preview carries are computed on the
 * server (`src/lib/processes/proposed-map-layout.ts`) and handed in.
 */
import { z } from 'zod';

import { MAX_GRAPH_TEXT_LENGTH } from '@/app-layer/schemas/process-map';
import { hasInvisible } from '@/lib/text/invisible-chars';

/** At most this many steps: readable in review, far below `MAX_NODES_PER_MAP`. */
export const PROPOSED_PROCESS_MAP_MAX_NODES = 40;
/** At most this many arrows: far below `MAX_EDGES_PER_MAP`. */
export const PROPOSED_PROCESS_MAP_MAX_EDGES = 80;
/** The map name's bound, the same as `CreateProcessMapSchema.name`. */
export const PROPOSED_PROCESS_MAP_MAX_NAME = 200;
/** The description's bound, the same as `CreateProcessMapSchema.description`. */
export const PROPOSED_PROCESS_MAP_MAX_DESCRIPTION = 2000;

/**
 * C0 and C1 controls (except tab, newline and carriage return), the soft
 * hyphen, the combining grapheme joiner, the Arabic letter mark, the Mongolian
 * vowel separator, zero-width characters, the line and paragraph separators,
 * bidi overrides and isolates, the invisible operators, the deprecated format
 * characters and the BOM. The label a reviewer reads must be the label that is
 * stored, and these make two different strings look alike.
 *
 * A SUPERSET of `hasInvisible` (`src/lib/text/invisible-chars.ts`), which
 * `isSafeText` also asks, so the two classes cannot drift apart in the
 * direction that admits a character. Built through the `RegExp` constructor
 * from `\u` escapes for that module's reason: a literal U+2028 ends a regex
 * literal, and a literal zero-width character cannot be reviewed in a diff.
 * The check runs on the sanitised text too (`createAgentProposal` re-parses),
 * so an entity such as `&shy;` that sanitising decodes is refused as well.
 */
const UNSAFE_TEXT = new RegExp(
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
        '\\u00AD\\u034F\\u061C\\u180E\\u200B-\\u200F\\u2028\\u2029' +
        '\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]',
);
const isSafeText = (s: string): boolean => !UNSAFE_TEXT.test(s) && !hasInvisible(s);
const UNSAFE_TEXT_MESSAGE = 'contains control, invisible or bidi-override characters';

const safeText = (max: number) =>
    z
        .string()
        .trim()
        .min(1)
        .max(max)
        .refine(isSafeText, { message: UNSAFE_TEXT_MESSAGE });

const optionalSafeText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .refine(isSafeText, { message: UNSAFE_TEXT_MESSAGE })
        .optional();

/** An agent's step key. It only wires the arrows, and is never stored. */
const ProposedNodeKey = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const PROPOSED_PROCESS_MAP_NODE_TYPES = ['processStep', 'decision'] as const;
export type ProposedProcessMapNodeType = (typeof PROPOSED_PROCESS_MAP_NODE_TYPES)[number];

export const ProposedProcessMapNodeSchema = z
    .object({
        nodeKey: ProposedNodeKey,
        nodeType: z.enum(PROPOSED_PROCESS_MAP_NODE_TYPES).default('processStep'),
        label: safeText(MAX_GRAPH_TEXT_LENGTH),
        subtitle: optionalSafeText(MAX_GRAPH_TEXT_LENGTH),
    })
    .strict();

export const ProposedProcessMapEdgeSchema = z
    .object({
        sourceKey: ProposedNodeKey,
        targetKey: ProposedNodeKey,
        labelOverride: optionalSafeText(MAX_GRAPH_TEXT_LENGTH),
    })
    .strict();

export const ProposedProcessMapSchema = z
    .object({
        name: safeText(PROPOSED_PROCESS_MAP_MAX_NAME),
        description: optionalSafeText(PROPOSED_PROCESS_MAP_MAX_DESCRIPTION),
        nodes: z.array(ProposedProcessMapNodeSchema).min(1).max(PROPOSED_PROCESS_MAP_MAX_NODES),
        // Required, and may be empty: a one-step map has no arrows.
        edges: z.array(ProposedProcessMapEdgeSchema).max(PROPOSED_PROCESS_MAP_MAX_EDGES),
    })
    .strict()
    .superRefine((m, ctx) => {
        const keys = new Set<string>();
        m.nodes.forEach((n, i) => {
            if (keys.has(n.nodeKey)) {
                ctx.addIssue({ code: 'custom', path: ['nodes', i, 'nodeKey'], message: 'duplicate step key' });
            }
            keys.add(n.nodeKey);
        });
        const pairs = new Set<string>();
        m.edges.forEach((e, i) => {
            if (!keys.has(e.sourceKey)) {
                ctx.addIssue({ code: 'custom', path: ['edges', i, 'sourceKey'], message: 'arrow starts at an unknown step' });
            }
            if (!keys.has(e.targetKey)) {
                ctx.addIssue({ code: 'custom', path: ['edges', i, 'targetKey'], message: 'arrow ends at an unknown step' });
            }
            if (e.sourceKey === e.targetKey) {
                ctx.addIssue({ code: 'custom', path: ['edges', i], message: 'arrow points at its own step' });
            }
            const pair = `${e.sourceKey}\u0000${e.targetKey}`;
            if (pairs.has(pair)) {
                ctx.addIssue({ code: 'custom', path: ['edges', i], message: 'duplicate arrow' });
            }
            pairs.add(pair);
        });
    });

export type ProposedProcessMap = z.infer<typeof ProposedProcessMapSchema>;

/** A map in canonical form: keys `n1..nN`, no empty optional text. */
export interface CanonicalProposedProcessMap {
    name: string;
    description?: string;
    nodes: Array<{
        nodeKey: string;
        nodeType: ProposedProcessMapNodeType;
        label: string;
        subtitle?: string;
    }>;
    edges: Array<{ sourceKey: string; targetKey: string; labelOverride?: string }>;
}

/** The key arrow `index` (0-based) is created with. Arrows carry no stored key. */
export function proposedEdgeKey(index: number): string {
    return `e${index + 1}`;
}

/**
 * Re-mint the step keys `n1..nN` in declaration order, rewrite the arrows'
 * endpoints, and drop empty optional text. Idempotent on its own output, and
 * the output re-parses with `ProposedProcessMapSchema`.
 */
export function canonicaliseProposedProcessMap(map: ProposedProcessMap): CanonicalProposedProcessMap {
    const minted = new Map<string, string>();
    map.nodes.forEach((n, i) => minted.set(n.nodeKey, `n${i + 1}`));
    const keyFor = (k: string): string => minted.get(k) ?? k;
    const text = (s: string | undefined): string | undefined => (s && s.length > 0 ? s : undefined);
    const out: CanonicalProposedProcessMap = {
        name: map.name,
        nodes: map.nodes.map((n) => {
            const node: CanonicalProposedProcessMap['nodes'][number] = {
                nodeKey: keyFor(n.nodeKey),
                nodeType: n.nodeType,
                label: n.label,
            };
            const subtitle = text(n.subtitle);
            if (subtitle !== undefined) node.subtitle = subtitle;
            return node;
        }),
        edges: map.edges.map((e) => {
            const edge: CanonicalProposedProcessMap['edges'][number] = {
                sourceKey: keyFor(e.sourceKey),
                targetKey: keyFor(e.targetKey),
            };
            const label = text(e.labelOverride);
            if (label !== undefined) edge.labelOverride = label;
            return edge;
        }),
    };
    const description = text(map.description);
    if (description !== undefined) out.description = description;
    return out;
}

/** Why a stored payload cannot be read as a map. Codes, never the payload's text. */
export type ProposedProcessMapUnreadable = 'NOT_AN_OBJECT' | 'INVALID' | 'NOT_CANONICAL';

/**
 * Read a STORED payload as a map. The one reader the review diff and the
 * approval share (see the header).
 *
 * The schema refuses zero steps, unknown endpoints, self-loops and duplicate
 * keys or pairs. A payload that parses but is not in canonical form (a stored
 * row edited by hand, or written by something other than
 * `createAgentProposal`) is refused too, because its keys are not the ones the
 * map would be created with.
 */
export function readProposedProcessMap(
    payload: unknown,
): { ok: true; map: CanonicalProposedProcessMap } | { ok: false; reason: ProposedProcessMapUnreadable } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, reason: 'NOT_AN_OBJECT' };
    }
    const parsed = ProposedProcessMapSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'INVALID' };
    const map = canonicaliseProposedProcessMap(parsed.data);
    const canonical = map.nodes.every(
        (n, i) => n.nodeKey === (parsed.data.nodes[i] as { nodeKey: string }).nodeKey,
    );
    if (!canonical) return { ok: false, reason: 'NOT_CANONICAL' };
    return { ok: true, map };
}

// ─── The preview ────────────────────────────────────────────────────────────

/**
 * A step's box on the proposed map, top-left and size, in canvas units.
 * Computed on the SERVER by the layout module that approval uses, so the
 * positions a reviewer is shown are the positions the map is created with.
 */
export interface ProcessMapPreviewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface ProcessMapPreviewStep {
    /** The canonical step key, `n1..nN`. A rendering handle, never shown. */
    key: string;
    /** 1-based position in the stored order: the number the reviewer reads. */
    index: number;
    nodeType: ProposedProcessMapNodeType;
    label: string;
    subtitle: string | null;
    box: ProcessMapPreviewBox;
}

export interface ProcessMapPreviewArrow {
    /** `e1..eM`, by position. A rendering handle, never shown. */
    key: string;
    fromKey: string;
    fromIndex: number;
    fromLabel: string;
    toKey: string;
    toIndex: number;
    toLabel: string;
    label: string | null;
}

/** What the review surfaces render for a PROCESS_MAP proposal. */
export interface ProcessMapPreview {
    name: string;
    description: string | null;
    steps: ProcessMapPreviewStep[];
    arrows: ProcessMapPreviewArrow[];
    notes: {
        /** 1-based indices of steps no arrow touches. Empty for a one-step map. */
        isolatedSteps: number[];
        /** 1-based indices of decisions with fewer than two outgoing arrows. */
        decisionsWithFewerThanTwoExits: number[];
    };
    /** The extent of every box, so a renderer can fit the map without measuring. */
    bounds: { width: number; height: number };
}

/**
 * Build the preview of a canonical map from the boxes the server computed.
 *
 * Throws when a step has no box: the boxes and the map come from the same
 * read on the same server, so a missing one is a bug, not a payload problem.
 */
export function buildProcessMapPreview(
    map: CanonicalProposedProcessMap,
    boxes: Readonly<Record<string, ProcessMapPreviewBox>>,
): ProcessMapPreview {
    const indexOf = new Map<string, number>();
    const labelOf = new Map<string, string>();
    map.nodes.forEach((n, i) => {
        indexOf.set(n.nodeKey, i + 1);
        labelOf.set(n.nodeKey, n.label);
    });

    const steps: ProcessMapPreviewStep[] = map.nodes.map((n, i) => {
        const box = boxes[n.nodeKey];
        if (!box) throw new Error(`no layout box for step ${i + 1}`);
        return {
            key: n.nodeKey,
            index: i + 1,
            nodeType: n.nodeType,
            label: n.label,
            subtitle: n.subtitle ?? null,
            box: { x: box.x, y: box.y, w: box.w, h: box.h },
        };
    });

    const arrows: ProcessMapPreviewArrow[] = map.edges.map((e, i) => ({
        key: proposedEdgeKey(i),
        fromKey: e.sourceKey,
        fromIndex: indexOf.get(e.sourceKey) ?? 0,
        fromLabel: labelOf.get(e.sourceKey) ?? '',
        toKey: e.targetKey,
        toIndex: indexOf.get(e.targetKey) ?? 0,
        toLabel: labelOf.get(e.targetKey) ?? '',
        label: e.labelOverride ?? null,
    }));

    const touched = new Set<string>();
    const exits = new Map<string, number>();
    for (const e of map.edges) {
        touched.add(e.sourceKey);
        touched.add(e.targetKey);
        exits.set(e.sourceKey, (exits.get(e.sourceKey) ?? 0) + 1);
    }
    const isolatedSteps =
        map.nodes.length > 1
            ? map.nodes.flatMap((n, i) => (touched.has(n.nodeKey) ? [] : [i + 1]))
            : [];
    const decisionsWithFewerThanTwoExits = map.nodes.flatMap((n, i) =>
        n.nodeType === 'decision' && (exits.get(n.nodeKey) ?? 0) < 2 ? [i + 1] : [],
    );

    const width = Math.max(0, ...steps.map((s) => s.box.x + s.box.w));
    const height = Math.max(0, ...steps.map((s) => s.box.y + s.box.h));

    return {
        name: map.name,
        description: map.description ?? null,
        steps,
        arrows,
        notes: { isolatedSteps, decisionsWithFewerThanTwoExits },
        bounds: { width, height },
    };
}
