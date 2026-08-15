/**
 * Roadmap-26 PR-A — Process Map Zod schemas.
 *
 * The save payload is shaped as the FULL graph (nodes + edges +
 * edge-controls) on every save. PR-A's repo layer replaces the
 * graph atomically — there's no per-row update path. This keeps
 * the contract dead simple: "the canvas state is the source of
 * truth; the server persists what the canvas hands it." When the
 * editor grows real undo-redo (PR-E), the same payload shape
 * carries.
 *
 * Why full-graph replace (not row-level updates):
 *   • Frontend already owns canonical state via xyflow's
 *     setNodes / setEdges. Per-row PATCH endpoints would create
 *     a second source of truth (the server's row-level state)
 *     that drifts every time the user reorders / re-positions
 *     without saving.
 *   • The graph is bounded (a process map is meant to fit on
 *     a screen — dozens of nodes, not thousands). The all-rows
 *     PUT cost is fine.
 *   • Audit log carries one entry per save instead of N row
 *     updates; the audit story stays readable.
 *
 * PR-E will likely add an optimistic-concurrency check on the
 * `version` field — the column is already there, just not
 * enforced yet at the repo layer.
 */
import { z } from 'zod';

// ─── Lifecycle status ──────────────────────────────────────────────

export const ProcessMapStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export type ProcessMapStatusValue = z.infer<typeof ProcessMapStatusSchema>;

// ─── Graph rows ────────────────────────────────────────────────────

/**
 * Per-node payload sent up on save. The frontend mints `nodeKey`
 * (e.g. "node-1") and the server persists it verbatim so the round-
 * trip is round-trip-stable for selection state.
 */
/**
 * Per-blob size ceiling for the free-form `dataJson` slots.
 *
 * Node and edge COUNTS are capped (500 / 1000 below), but per-blob size was
 * not — so a map within every count limit could still carry an arbitrarily
 * large payload. That payload lands in the node/edge rows AND is copied
 * wholesale into a ProcessMapSnapshot, on a column written by every autosave.
 * The cost is write amplification on a 3-second debounce, not one big row.
 *
 * A BYTE CAP rather than a per-nodeType schema, deliberately:
 *   - it matches the failure mode, which is volume rather than shape, and it
 *     covers node, edge AND edge-control blobs with one rule;
 *   - the JSON slot exists so per-type payloads can evolve without migrations
 *     (processes.prisma:22-25). An allowlist schema spends that immediately;
 *   - it cannot break a round-trip. The server writes keys the client does not
 *     know about, and a strict shape would reject them on the way back.
 *
 * 64 KB bounds the pathological case without constraining real use. It is a
 * guard rail, not a budget.
 */
const DATA_JSON_MAX_BYTES = 64 * 1024;

const boundedDataJson = z
    .unknown()
    .optional()
    .nullable()
    .refine(
        (v) => {
            if (v === undefined || v === null) return true;
            try {
                return (
                    new TextEncoder().encode(JSON.stringify(v)).length <=
                    DATA_JSON_MAX_BYTES
                );
            } catch {
                // Unserialisable (cycles, BigInt) — reject here rather than
                // let it reach Prisma, where it is a 500 instead of a 400.
                return false;
            }
        },
        { message: `dataJson exceeds ${DATA_JSON_MAX_BYTES} bytes` },
    );


export const ProcessNodeInputSchema = z.object({
    nodeKey: z.string().min(1).max(128),
    nodeType: z.string().min(1).max(64),
    label: z.string().max(200),
    subtitle: z.string().max(200).optional().nullable(),
    posX: z.number().finite(),
    posY: z.number().finite(),
    // R30 — optional parent group reference. References another node's
    // `nodeKey` in the same map. The structural validator on the repo
    // layer rejects unknown `parentNodeKey` values; a self-reference
    // (parentNodeKey === own nodeKey) is rejected explicitly.
    parentNodeKey: z.string().max(128).optional().nullable(),
    dataJson: boundedDataJson,
});
export type ProcessNodeInput = z.infer<typeof ProcessNodeInputSchema>;

export const ProcessEdgeInputSchema = z.object({
    edgeKey: z.string().min(1).max(128),
    sourceKey: z.string().min(1).max(128),
    targetKey: z.string().min(1).max(128),
    edgeKind: z.string().min(1).max(64).default('flow'),
    labelOverride: z.string().max(200).optional().nullable(),
    dataJson: boundedDataJson,
    controls: z
        .array(
            z.object({
                controlKey: z.string().min(1).max(128),
                label: z.string().max(200),
                // PR-D — every edge control links to a real Control row
                // (ProcessEdgeControl.controlId is NOT NULL + FK).
                controlId: z.string().min(1),
                dataJson: boundedDataJson,
            }),
        )
        .max(64)
        .optional()
        .default([]),
});
export type ProcessEdgeInput = z.infer<typeof ProcessEdgeInputSchema>;

// ─── Endpoint payloads ─────────────────────────────────────────────

export const CreateProcessMapSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
    status: ProcessMapStatusSchema.optional(),
    // VR-2 — DOCUMENT (default) vs AUTOMATION (visual rule editor).
    canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']).optional(),
});
export type CreateProcessMapInput = z.infer<typeof CreateProcessMapSchema>;

/**
 * Save payload. Carries metadata edits AND the full graph.
 *
 * `expectedVersion` — optimistic-concurrency guard (Epic P1).
 * When the client sends a version, the repo refuses the write if
 * the server's current version doesn't match — the route returns
 * HTTP 409 + `{ code: 'STALE_DATA', details: { currentVersion } }`.
 * Older clients that omit `expectedVersion` get last-write-wins
 * semantics (no breaking change) — the canvas client always sends
 * it now.
 */
export const SaveProcessMapSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    status: ProcessMapStatusSchema.optional(),
    expectedVersion: z.number().int().min(1).optional(),
    nodes: z.array(ProcessNodeInputSchema).max(500),
    edges: z.array(ProcessEdgeInputSchema).max(1000),
});
export type SaveProcessMapInput = z.infer<typeof SaveProcessMapSchema>;
