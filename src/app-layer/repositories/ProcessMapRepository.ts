/**
 * Roadmap-26 PR-A — ProcessMap repository.
 *
 * Persists the Process-Map graph (nodes + edges + edge-controls)
 * with a full-graph replace semantic. The usecase layer above
 * calls `replaceGraph(...)` on every save; this repo deletes the
 * existing graph children inside a transaction and recreates them
 * with the supplied payload, then bumps the parent map's
 * `version` + `updatedAt`.
 *
 * Why a transaction for the whole replace:
 *   The graph is conceptually one document. A partial replace
 *   would leave the canvas in a structurally broken state (e.g.
 *   edges referencing nodes that no longer exist). Wrapping
 *   delete+create in `db.$transaction` makes either all of it
 *   land or none of it.
 *
 * Why we don't diff before replacing:
 *   Per-row diff (node moved by 4px → UPDATE; new node added →
 *   INSERT; removed node → DELETE) is more efficient but adds
 *   complexity for negligible benefit at the bounded graph sizes
 *   the Processes page targets (dozens of nodes). The full
 *   replace keeps the repo's contract trivially auditable.
 */

import { PrismaTx } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../types';
import type { SubflowGroupItem } from '@/lib/processes/subflow-groups';
import { staleData, badRequest } from '@/lib/errors/types';
import { withDeleted } from '@/lib/soft-delete';
import {
    LINKED_NODE_TYPES,
    NODE_LINK_FIELD,
    linkFieldForNodeType,
    type LinkedNodeType,
} from '../schemas/process-map';
import type {
    ProcessNodeInput,
    ProcessEdgeInput,
    ProcessMapStatusValue,
} from '../schemas/process-map';

export interface ProcessMapListItem {
    id: string;
    name: string;
    description: string | null;
    status: ProcessMapStatusValue;
    version: number;
    canvasMode: 'DOCUMENT' | 'AUTOMATION';
    createdAt: Date;
    updatedAt: Date;
    nodeCount: number;
    edgeCount: number;
}

export interface ProcessMapWithGraph {
    id: string;
    name: string;
    description: string | null;
    status: ProcessMapStatusValue;
    version: number;
    /**
     * #2960 — the renderer's own shapes (sticky notes, freehand, loose text),
     * verbatim. `unknown` rather than a shape, because nothing server-side
     * reads it: typing it would invite someone to.
     */
    freeformJson: unknown;
    createdAt: Date;
    updatedAt: Date;
    nodes: Array<{
        nodeKey: string;
        nodeType: string;
        label: string;
        subtitle: string | null;
        posX: number;
        posY: number;
        parentNodeKey: string | null;
        dataJson: unknown;
        /** The linked Control's id (`ProcessNodeControl`), or null. */
        controlId: string | null;
        /** The linked Risk's id (`ProcessNodeRisk`), or null. */
        riskId: string | null;
        /** The linked Asset's id (`ProcessNodeAsset`), or null. */
        assetId: string | null;
    }>;
    edges: Array<{
        edgeKey: string;
        sourceKey: string;
        targetKey: string;
        edgeKind: string;
        labelOverride: string | null;
        dataJson: unknown;
        controls: Array<{
            controlKey: string;
            label: string;
            controlId: string;
            dataJson: unknown;
        }>;
    }>;
}

/** A node kind's links, decided from the payload. */
export interface NodeLinkPlan {
    /** nodeKey → id the payload names; checked strictly at save. */
    explicit: Map<string, string>;
    /** nodeKey → legacy `linkedEntityId`, lifted best effort. */
    legacy: Map<string, string>;
}

/**
 * Where each linked node's link comes from — `control`, `risk` and `asset`
 * nodes alike — decided before anything is written. Pure, so the three-state
 * contract is unit-testable without a DB.
 *
 *   - its field (`controlId` / `riskId` / `assetId`) a string → an EXPLICIT
 *     link. Checked strictly: a record that is not this tenant's refuses the
 *     whole save, as edge controls do.
 *   - the field null → explicitly unlinked (a draft placeholder).
 *   - the field absent → the sender predates it (an old snapshot being restored,
 *     a browser tab from before the deploy). Its legacy
 *     `dataJson.linkedEntityId` is LIFTED, best effort: kept only if it names
 *     one of this tenant's records, dropped otherwise — the rule the backfill
 *     migrations applied, because nothing ever validated that string.
 *
 * A linked node's `linkedEntityId` is stripped from the `dataJson` written: the
 * link has one home, and a stale copy in the JSON would be a second source that
 * drifts. A node carrying ANOTHER kind's link field is refused, not ignored.
 */
export function planNodeLinks(nodes: readonly ProcessNodeInput[]): {
    nodes: ProcessNodeInput[];
    links: Record<LinkedNodeType, NodeLinkPlan>;
} {
    const links = Object.fromEntries(
        LINKED_NODE_TYPES.map((t) => [t, { explicit: new Map(), legacy: new Map() }]),
    ) as Record<LinkedNodeType, NodeLinkPlan>;
    const cleaned = nodes.map((n) => {
        const own = linkFieldForNodeType(n.nodeType);
        for (const t of LINKED_NODE_TYPES) {
            const field = NODE_LINK_FIELD[t];
            if (field !== own && n[field] != null) {
                const a = t === 'asset' ? 'an' : 'a';
                throw badRequest(
                    `Node ${n.nodeKey} is not ${a} ${t} node and cannot link to ${a} ${t}`,
                );
            }
        }
        if (own === null) return n;
        const kind = n.nodeType as LinkedNodeType;
        const data =
            n.dataJson && typeof n.dataJson === 'object' && !Array.isArray(n.dataJson)
                ? { ...(n.dataJson as Record<string, unknown>) }
                : null;
        const legacyId = data?.linkedEntityId;
        const value = n[own];
        if (typeof value === 'string') {
            links[kind].explicit.set(n.nodeKey, value);
        } else if (value === undefined && typeof legacyId === 'string' && legacyId.length > 0) {
            links[kind].legacy.set(n.nodeKey, legacyId);
        }
        if (data && 'linkedEntityId' in data) delete data.linkedEntityId;
        return data ? { ...n, dataJson: data } : n;
    });
    return { nodes: cleaned, links };
}

/**
 * The links to write for one kind: every explicit one (already checked), and
 * each legacy one the ownership read found.
 */
function resolvedLinks(plan: NodeLinkPlan, owned: ReadonlySet<string>): Map<string, string> {
    const out = new Map<string, string>(plan.explicit);
    for (const [nodeKey, id] of plan.legacy) if (owned.has(id)) out.set(nodeKey, id);
    return out;
}

/** Every id a kind's plan names, explicit and legacy, deduplicated. */
function idsOf(plan: NodeLinkPlan): string[] {
    return Array.from(new Set([...plan.explicit.values(), ...plan.legacy.values()]));
}

/** A linked node's stored link, as its snapshot records it: `{ riskId: … }` etc. */
function linkFieldEntry(
    n: ProcessNodeInput,
    linkedByKind: Record<LinkedNodeType, ReadonlyMap<string, string>>,
): Partial<Record<(typeof NODE_LINK_FIELD)[LinkedNodeType], string | null>> {
    const field = linkFieldForNodeType(n.nodeType);
    if (field === null) return {};
    return { [field]: linkedByKind[n.nodeType as LinkedNodeType].get(n.nodeKey) ?? null };
}

/** Refuse a save whose explicit links name a record the read did not find. */
function assertExplicitOwned(plan: NodeLinkPlan, owned: ReadonlySet<string>, noun: string): void {
    const foreign = Array.from(new Set(plan.explicit.values())).filter((id) => !owned.has(id));
    if (foreign.length > 0) {
        throw badRequest(
            `Node references ${foreign.length} ${noun}(s) that do not belong to this tenant`,
        );
    }
}

/** A node placement of a linked record, as the reverse lookups return it. */
export interface NodePlacementRow {
    mapId: string;
    mapName: string;
    mapStatus: string;
    nodeKey: string;
    nodeLabel: string;
}

const NODE_PLACEMENT_SELECT = {
    node: { select: { nodeKey: true, label: true } },
    processMap: { select: { id: true, name: true, status: true, deletedAt: true } },
} as const;

function toNodePlacements(
    rows: ReadonlyArray<{
        node: { nodeKey: string; label: string };
        processMap: { id: string; name: string; status: string; deletedAt: Date | null };
    }>,
): NodePlacementRow[] {
    return rows
        .filter((r) => r.processMap.deletedAt === null)
        .map((r) => ({
            mapId: r.processMap.id,
            mapName: r.processMap.name,
            mapStatus: r.processMap.status,
            nodeKey: r.node.nodeKey,
            nodeLabel: r.node.label,
        }));
}

export class ProcessMapRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<ProcessMapListItem[]> {
        const rows = await db.processMap.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null },
            orderBy: [{ updatedAt: 'desc' }],
            select: {
                id: true,
                name: true,
                description: true,
                status: true,
                version: true,
                canvasMode: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { nodes: true, edges: true } },
            },
        });
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            status: r.status,
            version: r.version,
            canvasMode: r.canvasMode,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            nodeCount: r._count.nodes,
            edgeCount: r._count.edges,
        }));
    }

    static async getByIdWithGraph(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
    ): Promise<ProcessMapWithGraph | null> {
        const map = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            include: {
                nodes: {
                    orderBy: { nodeKey: 'asc' },
                    select: {
                        nodeKey: true,
                        nodeType: true,
                        label: true,
                        subtitle: true,
                        posX: true,
                        posY: true,
                        parentNodeKey: true,
                        dataJson: true,
                        control: { select: { controlId: true } },
                        risk: { select: { riskId: true } },
                        asset: { select: { assetId: true } },
                    },
                },
                edges: {
                    orderBy: { edgeKey: 'asc' },
                    select: {
                        edgeKey: true,
                        sourceKey: true,
                        targetKey: true,
                        edgeKind: true,
                        labelOverride: true,
                        dataJson: true,
                        controls: {
                            orderBy: { controlKey: 'asc' },
                            select: {
                                controlKey: true,
                                label: true,
                                controlId: true,
                                dataJson: true,
                            },
                        },
                    },
                },
            },
        });
        if (!map) return null;
        return {
            id: map.id,
            name: map.name,
            description: map.description,
            status: map.status,
            version: map.version,
            createdAt: map.createdAt,
            updatedAt: map.updatedAt,
            freeformJson: map.freeformJson ?? null,
            nodes: map.nodes.map(({ control, risk, asset, ...n }) => ({
                ...n,
                controlId: control?.controlId ?? null,
                riskId: risk?.riskId ?? null,
                assetId: asset?.assetId ?? null,
            })),
            edges: map.edges,
        };
    }

    /**
     * VR / PR-B follow-up — flip a map's canvasMode (DOCUMENT ⇄ AUTOMATION)
     * without touching the graph. Returns false if no row matched.
     */
    static async setCanvasMode(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        canvasMode: 'DOCUMENT' | 'AUTOMATION',
    ): Promise<boolean> {
        const res = await db.processMap.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { canvasMode },
        });
        return res.count > 0;
    }

    // PR-F — lifecycle status transition (DRAFT → ACTIVE → ARCHIVED). Metadata
    // only; does not touch the graph. Mirrors setCanvasMode.
    static async setStatus(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        status: ProcessMapStatusValue,
    ): Promise<boolean> {
        const res = await db.processMap.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { status },
        });
        return res.count > 0;
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        input: {
            name: string;
            description?: string | null;
            status?: ProcessMapStatusValue;
            canvasMode?: 'DOCUMENT' | 'AUTOMATION';
            createdByUserId: string;
        },
    ): Promise<ProcessMapWithGraph> {
        const created = await db.processMap.create({
            data: {
                tenantId: ctx.tenantId,
                name: input.name,
                description: input.description ?? null,
                status: input.status ?? 'DRAFT',
                canvasMode: input.canvasMode ?? 'DOCUMENT',
                createdByUserId: input.createdByUserId,
            },
        });
        return {
            id: created.id,
            name: created.name,
            description: created.description,
            status: created.status,
            version: created.version,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
            // A new map has no freeform layer. NULL rather than `{}` — the
            // column distinguishes "the renderer never wrote" from "the
            // renderer wrote and found nothing", and create is the former.
            freeformJson: null,
            nodes: [],
            edges: [],
        };
    }

    /**
     * Replace the graph atomically.
     *
     * Steps:
     *   1. Verify the map exists + belongs to the tenant.
     *   2. Validate that every edge's source/target key references
     *      a node key in the supplied node set (cheap structural
     *      guard; the DB has no FK to enforce this since nodeKey
     *      is per-map, not globally unique).
     *   3. Transactionally:
     *      a. Delete all existing nodes + edges for the map.
     *         Cascading FK takes care of edge-controls.
     *      b. Insert the new node set.
     *      c. Insert the new edge set.
     *      d. Insert each edge's controls.
     *      e. Bump version + apply metadata edits.
     */
    static async replaceGraph(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        input: {
            name?: string;
            description?: string | null;
            status?: ProcessMapStatusValue;
            nodes: ProcessNodeInput[];
            edges: ProcessEdgeInput[];
            /**
             * #2960 — three states, and they are NOT interchangeable.
             * `undefined` leaves the stored value alone (a client that knows
             * nothing about freeform must not erase it), `null` clears it, a
             * value replaces it.
             */
            freeformJson?: unknown;
            /**
             * Epic P1 — optimistic-concurrency guard. When set, the
             * repo refuses the write if the server's current
             * `version` doesn't match. Surfaces as
             * `staleData(...)` → HTTP 409 + `{ code: 'STALE_DATA',
             * details: { currentVersion } }`.
             *
             * Omit for last-write-wins semantics (older clients) —
             * the canvas always sends it now.
             */
            expectedVersion?: number;
        },
    ): Promise<ProcessMapWithGraph | null> {
        // Structural validation — fail fast before opening a tx.
        const nodeKeys = new Set(input.nodes.map((n) => n.nodeKey));
        for (const e of input.edges) {
            if (!nodeKeys.has(e.sourceKey)) {
                throw new Error(
                    `Edge ${e.edgeKey} references unknown source nodeKey ${e.sourceKey}`,
                );
            }
            if (!nodeKeys.has(e.targetKey)) {
                throw new Error(
                    `Edge ${e.edgeKey} references unknown target nodeKey ${e.targetKey}`,
                );
            }
        }
        // R30 — parent-reference integrity. A `parentNodeKey` must
        // point to another node in the SAME save payload. Self-
        // references are rejected. Nested groups (a group whose
        // parent is itself a group) are allowed today — xyflow
        // supports the recursion and the save shape is otherwise
        // identical.
        for (const n of input.nodes) {
            if (n.parentNodeKey == null) continue;
            if (n.parentNodeKey === n.nodeKey) {
                throw new Error(
                    `Node ${n.nodeKey} references itself as parentNodeKey`,
                );
            }
            if (!nodeKeys.has(n.parentNodeKey)) {
                throw new Error(
                    `Node ${n.nodeKey} references unknown parentNodeKey ${n.parentNodeKey}`,
                );
            }
        }

        const existing = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            // `freeformJson` rides along on a read this method already makes.
            // The snapshot below needs the STORED freeform layer whenever the
            // request omitted one, and a second findFirst for it would be an
            // extra round trip on every autosave — a 3-second debounce.
            select: { id: true, version: true, freeformJson: true },
        });
        if (!existing) return null;

        // Epic P1 — optimistic concurrency. Refuse the write if the
        // client's `expectedVersion` doesn't match the server's
        // current version. Doing the check up-front skips the
        // destructive delete-and-insert when we already know the
        // conditional commit at the end would lose the race; the
        // conditional `updateMany` below is the second line of
        // defence catching any concurrent commit that lands BETWEEN
        // the check and the version bump.
        //
        // Callers who omit `expectedVersion` are accepting last-write-wins
        // by omission.
        //
        // THE DOOR CANNOT BE CLOSED IN ONE LINE, and the comment that used to
        // sit here made it look like it could. It claimed "the canvas client
        // always sends it now", which is false: two in-repo canvas paths omit
        // it by construction, both of them CREATE-then-FILL flows that have no
        // version to send until the create returns —
        //
        //   PersistedProcessCanvas.tsx  (Duplicate)
        //   lib/processes/create-map-from-template.ts  (New from template)
        //
        // Making `expectedVersion` required today would 400 both, plus any
        // save or rename attempted while `loadedMap` is null after a failed
        // load. The sunset needs those two callers to thread the freshly
        // created map's version first — the POST response already returns it,
        // and both helpers read `filled.version` immediately afterwards, so
        // the value is there for the taking.
        //
        // Until then this is not migration debt for stale browser bundles; it
        // is a live path with in-repo callers, and the current gap is benign
        // because those callers race nothing (they have just created the row).
        if (
            input.expectedVersion !== undefined &&
            existing.version !== input.expectedVersion
        ) {
            throw staleData(
                'This process map was modified by another user. Reload to see the latest version.',
                { currentVersion: existing.version },
            );
        }

        // The repo is invoked from the usecase via `runInTenantContext`
        // which already opens a Prisma `$transaction` and binds the
        // tenant-scoping session variable. We MUST NOT open a nested
        // transaction here — `PrismaTx` is the inner-tx type and
        // intentionally omits `$transaction` to enforce that
        // invariant. The sequential operations below are atomic for
        // free because they share the outer tx.

        // Cascading FK on ProcessNode / ProcessEdge → ProcessMap
        // would let us drop+recreate the parent, but that would
        // lose `createdAt` / `createdByUserId`. Cleaner to keep
        // the parent intact and delete just the children.
        await db.processEdge.deleteMany({
            where: { processMapId: id, tenantId: ctx.tenantId },
        });

        // ═══ NODES KEEP THEIR ROW IDENTITY ACROSS A SAVE (#2967) ═══
        //
        // This used to be `deleteMany` + `createMany`, matching the edges above
        // and the "full-graph replace" the file header describes. For edges
        // that is harmless: nothing outside this map references an edge row by
        // id, and `ProcessEdgeControl` travels in the save payload and is
        // recreated with them.
        //
        // NODES WERE NOT LIKE EDGES, because one thing referenced them by row
        // id: `BusinessImpactAnalysis.processNodeId`, whose FK was
        // `ON DELETE SET NULL`. Delete-and-recreate therefore nulled that link
        // on EVERY save — identical graph, no user edit, autosave alone was
        // enough — and minted a fresh cuid nothing pointed at. No error, no
        // 409: the save succeeded and the version bumped while the BIA quietly
        // came unattached from the process it analyses.
        //
        // The rest of the graph survived this only because it references
        // `nodeKey` rather than the cuid — `ProcessEdge.sourceKey`/`targetKey`
        // and `parentNodeKey` all do. BIA was the single reference using the
        // row id, and so the single one that did not survive.
        //
        // PAST TENSE, DELIBERATELY: #2971 moved BIA onto (`processMapId`,
        // `processNodeKey`) as well, so nothing OUTSIDE THIS SAVE references a
        // ProcessNode by row id. One table does reference it by row id,
        // `ProcessNodeControl`, and it is safe for the reason edge controls
        // are: its rows are rewritten from the payload below, in this same
        // transaction, so a redrawn node gets its link back with its new id.
        // A new reference to a node row from anywhere else must not assume
        // that. The two changes are not redundant. This one keeps an
        // ordinary save from churning every row; #2971 covers the case this
        // one cannot, a node genuinely deleted and recreated — the same step
        // redrawn — where no amount of upserting preserves a row id.
        //
        // WHY BOTH, WHEN EITHER FIXES THE AUTOSAVE BUG. This one was
        // contained to this function and needed no migration, so it shipped
        // first and stopped the bleeding. It also removes a second class of
        // problem for free: node identity is stable across saves, which is
        // what anything else that comes to reference a node will assume — and
        // that assumption is now the ONLY thing holding, since the FK that
        // used to enforce it is gone.
        //
        // The cost is N statements instead of two. That is the shape the edge
        // loop below already has — and at a lower cap (500 nodes against 1000
        // edges), inside the same transaction. The header's note that a diff
        // buys "negligible benefit at the bounded graph sizes" was true about
        // SPEED and missed this: the benefit was never speed.
        // Decide each linked node's link before any write (throws on a node
        // carrying another kind's link field).
        const plan = planNodeLinks(input.nodes);

        const incomingKeys = plan.nodes.map((n) => n.nodeKey);

        // Nodes the payload dropped. Guarded because `notIn: []` is a condition
        // that excludes nothing — correct here, but stating the empty case
        // explicitly keeps "the map was cleared" from depending on that.
        await db.processNode.deleteMany({
            where: {
                processMapId: id,
                tenantId: ctx.tenantId,
                ...(incomingKeys.length > 0 ? { nodeKey: { notIn: incomingKeys } } : {}),
            },
        });

        const nodeIdByKey = new Map<string, string>();
        for (const n of plan.nodes) {
            const fields = {
                nodeType: n.nodeType,
                label: n.label,
                subtitle: n.subtitle ?? null,
                posX: n.posX,
                posY: n.posY,
                parentNodeKey: n.parentNodeKey ?? null,
                dataJson:
                    n.dataJson === undefined
                        ? Prisma.JsonNull
                        : (n.dataJson as Prisma.InputJsonValue | null) ??
                          Prisma.JsonNull,
            };
            const row = await db.processNode.upsert({
                // The map-scoped natural key. `nodeKey` is unique per map, not
                // per tenant, so the compound is the only correct target — and
                // it is the id the client has considered stable all along.
                where: { processMapId_nodeKey: { processMapId: id, nodeKey: n.nodeKey } },
                create: {
                    tenantId: ctx.tenantId,
                    processMapId: id,
                    nodeKey: n.nodeKey,
                    ...fields,
                },
                // `tenantId`, `processMapId` and `nodeKey` are deliberately NOT
                // updatable here: they identify the row. A payload that tried
                // to move a node between maps would be describing a different
                // node.
                update: fields,
                select: { id: true },
            });
            nodeIdByKey.set(n.nodeKey, row.id);
        }

        // Verify every referenced controlId belongs to THIS tenant, once,
        // before any edge is written.
        //
        // `processEdgeControl` rows stamp `tenantId: ctx.tenantId` onto a
        // caller-supplied `controlId` that was never checked — so a foreign id
        // was stored under this tenant's stamp, and the row then reads as if
        // the tenant owns a control it does not. RLS does not save this: the
        // row's own tenantId is correct, it is the REFERENCE that is foreign.
        //
        // Hoisted out of the loop deliberately — a per-edge lookup would be an
        // N+1, which the query-shape ratchet rejects and which would scale with
        // canvas size.
        //
        // Control NODES ride the same single read: their explicit links are
        // checked as strictly as edge controls, and their legacy lifts (see
        // `planNodeLinks`) are kept only when the read finds them.
        const edgeControlIds = input.edges
            .flatMap((e) => e.controls ?? [])
            .map((c) => c.controlId)
            .filter((v): v is string => typeof v === 'string' && v.length > 0);
        const referencedControlIds = Array.from(
            new Set([
                ...edgeControlIds,
                ...plan.links.control.explicit.values(),
                ...plan.links.control.legacy.values(),
            ]),
        );
        let ownedControlIds = new Set<string>();
        if (referencedControlIds.length > 0) {
            // Bounded by `referencedControlIds`, which is derived from the
            // caller's own edge list. A `take:` here would silently truncate the
            // owned set and reject legitimate controls as foreign.
            //
            // `withDeleted`: a control the tenant soft-deleted is still the
            // tenant's (#5105). Its gate row survives the soft delete (the FK
            // cascade fires only on a hard delete), the canvas sends it back,
            // and the default read hid it, so every save of the map was refused
            // as "foreign" until somebody found and removed the gate by hand.
            const owned = await db.control.findMany(withDeleted({ // guardrail-allow: unbounded
                where: { id: { in: referencedControlIds }, tenantId: ctx.tenantId },
                select: { id: true },
            }));
            ownedControlIds = new Set(owned.map((c: { id: string }) => c.id));
            const foreign = Array.from(new Set(edgeControlIds)).filter(
                (cid) => !ownedControlIds.has(cid),
            );
            if (foreign.length > 0) {
                throw badRequest(
                    `Edge references ${foreign.length} control(s) that do not belong to this tenant`,
                );
            }
            assertExplicitOwned(plan.links.control, ownedControlIds, 'control');
        }

        // Risk and asset nodes: one read per kind, over the ids the payload
        // names, under the same rules. `withDeleted` for the reason above: a
        // soft-deleted record is still the tenant's, and its link survives the
        // soft delete.
        const riskIds = idsOf(plan.links.risk);
        const ownedRiskIds = new Set<string>(
            riskIds.length === 0
                ? []
                : (
                      await db.risk.findMany(withDeleted({ // guardrail-allow: unbounded
                          where: { id: { in: riskIds }, tenantId: ctx.tenantId },
                          select: { id: true },
                      }))
                  ).map((r: { id: string }) => r.id),
        );
        assertExplicitOwned(plan.links.risk, ownedRiskIds, 'risk');
        const assetIds = idsOf(plan.links.asset);
        const ownedAssetIds = new Set<string>(
            assetIds.length === 0
                ? []
                : (
                      await db.asset.findMany(withDeleted({ // guardrail-allow: unbounded
                          where: { id: { in: assetIds }, tenantId: ctx.tenantId },
                          select: { id: true },
                      }))
                  ).map((a: { id: string }) => a.id),
        );
        assertExplicitOwned(plan.links.asset, ownedAssetIds, 'asset');

        // The node links, rebuilt from the payload like edge controls. A node
        // the payload dropped took its links with it (FK cascade on the node
        // delete above); clearing the survivors' links is what makes a node the
        // user unlinked unlinked.
        const linkedByKind: Record<LinkedNodeType, Map<string, string>> = {
            control: resolvedLinks(plan.links.control, ownedControlIds),
            risk: resolvedLinks(plan.links.risk, ownedRiskIds),
            asset: resolvedLinks(plan.links.asset, ownedAssetIds),
        };
        const scope = { processMapId: id, tenantId: ctx.tenantId };
        // Every key below came from `plan.nodes`, which the loop above upserted,
        // so `nodeIdByKey` always holds it.
        const row = (nodeKey: string) => ({ ...scope, nodeId: nodeIdByKey.get(nodeKey) as string });
        await db.processNodeControl.deleteMany({ where: scope });
        if (linkedByKind.control.size > 0) {
            await db.processNodeControl.createMany({
                data: Array.from(linkedByKind.control, ([k, controlId]) => ({ ...row(k), controlId })),
            });
        }
        await db.processNodeRisk.deleteMany({ where: scope });
        if (linkedByKind.risk.size > 0) {
            await db.processNodeRisk.createMany({
                data: Array.from(linkedByKind.risk, ([k, riskId]) => ({ ...row(k), riskId })),
            });
        }
        await db.processNodeAsset.deleteMany({ where: scope });
        if (linkedByKind.asset.size > 0) {
            await db.processNodeAsset.createMany({
                data: Array.from(linkedByKind.asset, ([k, assetId]) => ({ ...row(k), assetId })),
            });
        }

        // Edges and their controls. Need each edge's row id back
        // to wire its controls, so we create one edge at a time
        // (createMany doesn't return ids in Postgres). At the
        // bounded graph sizes the Processes page targets the
        // per-edge round trip is fine.
        for (const e of input.edges) {
            const edge = await db.processEdge.create({
                data: {
                    tenantId: ctx.tenantId,
                    processMapId: id,
                    edgeKey: e.edgeKey,
                    sourceKey: e.sourceKey,
                    targetKey: e.targetKey,
                    edgeKind: e.edgeKind,
                    labelOverride: e.labelOverride ?? null,
                    dataJson:
                        e.dataJson === undefined
                            ? Prisma.JsonNull
                            : (e.dataJson as Prisma.InputJsonValue | null) ??
                              Prisma.JsonNull,
                },
            });
            if (e.controls.length > 0) {
                await db.processEdgeControl.createMany({
                    data: e.controls.map((c) => ({
                        tenantId: ctx.tenantId,
                        processMapId: id,
                        edgeId: edge.id,
                        controlKey: c.controlKey,
                        label: c.label,
                        controlId: c.controlId,
                        dataJson:
                            c.dataJson === undefined
                                ? Prisma.JsonNull
                                : (c.dataJson as
                                      | Prisma.InputJsonValue
                                      | null) ?? Prisma.JsonNull,
                    })),
                });
            }
        }

        // Conditional version bump — the SECOND line of defence
        // for optimistic concurrency. A concurrent save that landed
        // between the up-front check and here would fail with
        // `count === 0`; the outer tx then rolls back the
        // delete-and-insert, leaving the previous graph intact.
        //
        // When `expectedVersion` is omitted (last-write-wins
        // callers), the `version` predicate is omitted too — the
        // bump happens unconditionally, matching the pre-Epic-P1
        // behaviour.
        const updated = await db.processMap.updateMany({
            where: {
                id,
                tenantId: ctx.tenantId,
                ...(input.expectedVersion !== undefined
                    ? { version: input.expectedVersion }
                    : {}),
            },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.description !== undefined
                    ? { description: input.description }
                    : {}),
                ...(input.status !== undefined
                    ? { status: input.status }
                    : {}),
                // #2960 — the renderer's own shapes, stored verbatim. The
                // THREE-STATE contract is deliberate and matches the other
                // optional fields here: `undefined` leaves the stored value
                // alone (so a client that knows nothing about freeform cannot
                // erase it by saving), an explicit `null` clears it, and a
                // value replaces it. Collapsing undefined and null would make
                // every legacy save wipe the freeform layer.
                ...(input.freeformJson !== undefined
                    ? {
                          freeformJson:
                              input.freeformJson === null
                                  ? Prisma.DbNull
                                  : (input.freeformJson as Prisma.InputJsonValue),
                      }
                    : {}),
                version: { increment: 1 },
            },
        });
        if (updated.count === 0) {
            // Only reachable when `expectedVersion` is set and lost
            // a race with another commit between the up-front check
            // and the bump. Refresh the current version so the
            // client gets the post-race value, not the pre-race
            // value we read at the top of this method.
            const current = await db.processMap.findFirst({
                where: { id, tenantId: ctx.tenantId },
                select: { version: true },
            });
            throw staleData(
                'This process map was modified by another user. Reload to see the latest version.',
                { currentVersion: current?.version ?? existing.version },
            );
        }

        // Epic P5-PR-A — archive the just-committed graph as a
        // snapshot. Writes inside the same outer tx as the version
        // bump so either both land or neither does.
        const newVersion = (existing.version ?? 0) + 1;
        // What the freeform layer IS as of this commit — which is not the same
        // as what this request sent. An omitted `freeformJson` leaves the
        // stored value alone, so the snapshot has to record the stored one or
        // every legacy save would archive a map with no freeform content and a
        // later restore would erase it.
        const freeformForSnapshot =
            input.freeformJson !== undefined
                ? (input.freeformJson ?? null)
                : (existing.freeformJson ?? null);
        const graphJsonPayload = {
            version: newVersion,
            nodes: plan.nodes.map((n) => ({
                nodeKey: n.nodeKey,
                nodeType: n.nodeType,
                label: n.label,
                subtitle: n.subtitle ?? null,
                posX: n.posX,
                posY: n.posY,
                parentNodeKey: n.parentNodeKey ?? null,
                dataJson: n.dataJson ?? null,
                // What was STORED, not what was sent: a legacy lift that found
                // no control is null here, so restoring this version later
                // restores exactly this state.
                ...linkFieldEntry(n, linkedByKind),
            })),
            edges: input.edges.map((e) => ({
                edgeKey: e.edgeKey,
                sourceKey: e.sourceKey,
                targetKey: e.targetKey,
                edgeKind: e.edgeKind,
                labelOverride: e.labelOverride ?? null,
                dataJson: e.dataJson ?? null,
                controls: e.controls.map((c) => ({
                    controlKey: c.controlKey,
                    label: c.label,
                    controlId: c.controlId ?? null,
                    dataJson: c.dataJson ?? null,
                })),
            })),
            // A snapshot that omitted this would restore a map with every
            // sticky note gone — data loss that looks like a successful
            // restore. It rides in the same payload as the graph.
            freeformJson: freeformForSnapshot,
        };
        await db.processMapSnapshot.create({
            data: {
                tenantId: ctx.tenantId,
                processMapId: id,
                version: newVersion,
                graphJson: graphJsonPayload as Prisma.InputJsonValue,
                createdByUserId: ctx.userId,
            },
        });

        return ProcessMapRepository.getByIdWithGraph(db, ctx, id);
    }

    /**
     * Epic P5-PR-A — list snapshots for a process map (descending
     * by version). The sidebar reads this to render the version
     * timeline. Capped at 200 — older snapshots roll off the
     * sidebar; future P5 work can add pagination if needed.
     */
    static async listSnapshots(
        db: PrismaTx,
        ctx: RequestContext,
        mapId: string,
    ): Promise<
        Array<{
            id: string;
            version: number;
            createdAt: Date;
            createdByUserId: string;
            createdByName: string | null;
        }>
    > {
        const rows = await db.processMapSnapshot.findMany({
            where: { tenantId: ctx.tenantId, processMapId: mapId },
            orderBy: { version: 'desc' },
            take: 200,
            select: {
                id: true,
                version: true,
                createdAt: true,
                createdByUserId: true,
                createdBy: { select: { name: true } },
            },
        });
        return rows.map((r) => ({
            id: r.id,
            version: r.version,
            createdAt: r.createdAt,
            createdByUserId: r.createdByUserId,
            createdByName: r.createdBy?.name ?? null,
        }));
    }

    /**
     * Epic P5-PR-B — fetch a single snapshot's full graphJson for
     * the "View version N" overlay + visual diff. Capped read; one
     * row by `(processMapId, version)` unique. Returns null when
     * the version isn't found.
     */
    static async getSnapshotByVersion(
        db: PrismaTx,
        ctx: RequestContext,
        mapId: string,
        version: number,
    ): Promise<{
        id: string;
        version: number;
        graphJson: unknown;
        createdAt: Date;
        createdByName: string | null;
    } | null> {
        const row = await db.processMapSnapshot.findFirst({
            where: {
                tenantId: ctx.tenantId,
                processMapId: mapId,
                version,
            },
            select: {
                id: true,
                version: true,
                graphJson: true,
                createdAt: true,
                createdBy: { select: { name: true } },
            },
        });
        if (!row) return null;
        return {
            id: row.id,
            version: row.version,
            graphJson: row.graphJson,
            createdAt: row.createdAt,
            createdByName: row.createdBy?.name ?? null,
        };
    }

    static async softDelete(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        userId: string,
    ): Promise<boolean> {
        const res = await db.processMap.updateMany({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            data: { deletedAt: new Date(), deletedByUserId: userId },
        });
        return res.count > 0;
    }

    /**
     * Epic P2-PR-C — reverse lookup: process maps referencing a
     * given control. Returns one row per (map, edge) pairing —
     * usually one edge per map, but the schema allows a control
     * to gate multiple edges within the same map.
     *
     * Uses the `@@index([tenantId, controlId])` on ProcessEdgeControl
     * for the seek; bounded by the small process-map graph sizes
     * (dozens of edges per map) so no take cap is needed.
     */
    static async listMapsByControl(
        db: PrismaTx,
        ctx: RequestContext,
        controlId: string,
    ): Promise<
        Array<{
            mapId: string;
            mapName: string;
            mapStatus: string;
            edgeKey: string;
            edgeLabel: string | null;
        }>
    > {
        // P2-PR-C reverse lookup: bounded by edges referencing one control (typically <10); leading `@@index([tenantId, controlId])` gates the seek.
        const rows = await db.processEdgeControl.findMany({ // guardrail-allow: unbounded
            where: { tenantId: ctx.tenantId, controlId },
            select: {
                edge: {
                    select: {
                        edgeKey: true,
                        labelOverride: true,
                        processMap: {
                            select: {
                                id: true,
                                name: true,
                                status: true,
                                deletedAt: true,
                            },
                        },
                    },
                },
            },
        });
        return rows
            .filter((r) => r.edge.processMap.deletedAt === null)
            .map((r) => ({
                mapId: r.edge.processMap.id,
                mapName: r.edge.processMap.name,
                mapStatus: r.edge.processMap.status,
                edgeKey: r.edge.edgeKey,
                edgeLabel: r.edge.labelOverride,
            }));
    }

    /**
     * Reverse lookup for a control NODE: "which process maps have a control
     * node linked to control X?" The node analogue of `listMapsByControl`
     * (edge-mounted controls), and like it a read of a real FK table,
     * `ProcessNodeControl`, gated by its leading `[tenantId, controlId]` index.
     */
    static async listMapsByControlNode(
        db: PrismaTx,
        ctx: RequestContext,
        controlId: string,
    ): Promise<NodePlacementRow[]> {
        // Bounded by the control nodes linking one control (a handful across a
        // tenant's maps), the same bound as the edge lookup above.
        const rows = await db.processNodeControl.findMany({ // guardrail-allow: unbounded
            where: { tenantId: ctx.tenantId, controlId },
            select: NODE_PLACEMENT_SELECT,
        });
        return toNodePlacements(rows);
    }

    /**
     * Reverse lookup for a risk NODE: "which process maps have a risk node
     * linked to risk X?" Reads `ProcessNodeRisk` by its leading
     * `[tenantId, riskId]` index; bounded by the nodes linking one risk.
     */
    static async listMapsByRiskNode(
        db: PrismaTx,
        ctx: RequestContext,
        riskId: string,
    ): Promise<NodePlacementRow[]> {
        const rows = await db.processNodeRisk.findMany({ // guardrail-allow: unbounded
            where: { tenantId: ctx.tenantId, riskId },
            select: NODE_PLACEMENT_SELECT,
        });
        return toNodePlacements(rows);
    }

    /**
     * Reverse lookup for an asset NODE, the same over `ProcessNodeAsset` and
     * its leading `[tenantId, assetId]` index.
     */
    static async listMapsByAssetNode(
        db: PrismaTx,
        ctx: RequestContext,
        assetId: string,
    ): Promise<NodePlacementRow[]> {
        const rows = await db.processNodeAsset.findMany({ // guardrail-allow: unbounded
            where: { tenantId: ctx.tenantId, assetId },
            select: NODE_PLACEMENT_SELECT,
        });
        return toNodePlacements(rows);
    }

    /**
     * #5477 — the tenant's sub-flow groups: every `group` node on a live
     * AUTOMATION map, for the rule builder's `INVOKE_SUBFLOW` target picker.
     * Only AUTOMATION maps, because only their saves write the membership an
     * invocation reads (`subFlowGroupId`); a group on a DOCUMENT map has no
     * rules and would start nothing.
     */
    static async listSubflowGroups(
        db: PrismaTx,
        ctx: RequestContext,
    ): Promise<SubflowGroupItem[]> {
        const rows = await db.processNode.findMany({
            where: {
                tenantId: ctx.tenantId,
                nodeType: 'group',
                processMap: { deletedAt: null, canvasMode: 'AUTOMATION' },
            },
            orderBy: [{ processMap: { name: 'asc' } }, { label: 'asc' }, { nodeKey: 'asc' }],
            select: {
                nodeKey: true,
                label: true,
                processMap: { select: { id: true, name: true } },
            },
            take: 500,
        });
        return rows.map((r) => ({
            mapId: r.processMap.id,
            mapName: r.processMap.name,
            nodeKey: r.nodeKey,
            label: r.label,
        }));
    }
}
