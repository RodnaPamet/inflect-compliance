/**
 * Roadmap-26 PR-A — Process Map usecases.
 *
 * Thin orchestration: auth → tenant context → repo → audit.
 */

import { RequestContext } from '../types';
import { ProcessMapRepository } from '../repositories/ProcessMapRepository';
import { assertCanAdmin, assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import {
    syncCanvasToRules,
    hydrateCanvasFromRules,
    prepareCanvasNodesForSave,
} from '../services/canvas-rule-sync';
import { readMapGroupKeys } from '../services/canvas-subflow-membership';
import type {
    CreateProcessMapInput,
    SaveProcessMapInput,
} from '../schemas/process-map';

export async function listProcessMaps(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ProcessMapRepository.list(db, ctx),
    );
}

/**
 * #5477 — the sub-flow groups an `INVOKE_SUBFLOW` rule can target, labelled by
 * map and group for the rule builder's picker. The same read gate as the
 * canvas itself (`getProcessMap`).
 */
export async function listSubflowGroups(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => ProcessMapRepository.listSubflowGroups(db, ctx));
}

export async function getProcessMap(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const map = await ProcessMapRepository.getByIdWithGraph(db, ctx, id);
        if (!map) throw notFound('Process map not found');
        // VR-3 — Rules → Canvas hydration: enrich automation nodes with live
        // rule status / executionCount / subtitle for display (AUTOMATION
        // maps only). Read-only; never persisted.
        const meta = await db.processMap.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { canvasMode: true },
        });
        if (meta?.canvasMode === 'AUTOMATION') {
            return { ...map, nodes: await hydrateCanvasFromRules(db, ctx, map.nodes) };
        }
        return map;
    });
}

export async function createProcessMap(
    ctx: RequestContext,
    input: CreateProcessMapInput,
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, (db) => createProcessMapInTx(db, ctx, input));
}

/**
 * The body of {@link createProcessMap}, inside a transaction the CALLER opened.
 *
 * Extracted (#5053) so an approved process-map proposal can create the map AND
 * its graph in ONE transaction (`createProcessMapWithGraph`): calling the two
 * public usecases in sequence would commit twice, and nesting them shares no
 * transaction (`runInTenantContext` opens a fresh one). The caller asserts the
 * write; this asserts nothing.
 *
 * `sourceProposalId`, when given, is recorded on the CREATE audit row (in its
 * `after` record), so an auditor can trace a map back to the proposal it came
 * from.
 */
async function createProcessMapInTx(
    db: PrismaTx,
    ctx: RequestContext,
    input: CreateProcessMapInput,
    provenance?: { sourceProposalId: string },
) {
    const map = await ProcessMapRepository.create(db, ctx, {
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        canvasMode: input.canvasMode,
        createdByUserId: ctx.userId,
    });

    await logEvent(db, ctx, {
        action: 'CREATE',
        entityType: 'ProcessMap',
        entityId: map.id,
        details: `Created process map: ${map.name}`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'ProcessMap',
            operation: 'created',
            // `sourceProposalId` rides inside `after`: the entity-lifecycle
            // payload schema is strict at the top level (its shape is part of
            // the hash chain), and `after` is its open record.
            after: {
                name: map.name,
                status: map.status,
                ...(provenance ? { sourceProposalId: provenance.sourceProposalId } : {}),
            },
            summary: `Created process map: ${map.name}`,
        },
    });

    return map;
}

export async function saveProcessMap(
    ctx: RequestContext,
    id: string,
    input: SaveProcessMapInput,
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, (db) => saveProcessMapInTx(db, ctx, id, input));
}

/**
 * The body of {@link saveProcessMap}, inside a transaction the CALLER opened.
 * Extracted for the same reason as {@link createProcessMapInTx}; the caller
 * asserts the write.
 */
async function saveProcessMapInTx(
    db: PrismaTx,
    ctx: RequestContext,
    id: string,
    input: SaveProcessMapInput,
) {
    // Keep each step's rule link, and drop display-only rule fields; see
    // `prepareCanvasNodesForSave` for the duplicate-rule bug this closes.
    const nodes = await prepareCanvasNodesForSave(db, ctx, id, input.nodes);
    // The groups as stored BEFORE this save, so the sync can take a rule out of
    // a group this save deletes (#5477).
    const priorGroupKeys = await readMapGroupKeys(db, ctx, id);
    const map = await ProcessMapRepository.replaceGraph(db, ctx, id, {
        name: input.name,
        description: input.description ?? undefined,
        status: input.status,
        nodes,
        edges: input.edges,
        // #2960 — forwarded UNDEFINED-PRESERVING. The schema makes this
        // optional, and a client that omits it must leave the stored
        // freeform layer alone rather than erase it; `?? undefined` would
        // be the same value here but says the wrong thing, so the field is
        // passed through exactly as it arrived.
        freeformJson: input.freeformJson,
        // Epic P1 — optimistic concurrency. Forward the
        // client's claimed version so the repo can refuse the
        // write on conflict (HTTP 409 / `STALE_DATA`).
        expectedVersion: input.expectedVersion,
    });
    if (!map) throw notFound('Process map not found');

    // VR-3 — Canvas → Rules sync (AUTOMATION maps only): create stub
    // rules for new action nodes + wire chain topology after the graph
    // is persisted.
    const meta = await db.processMap.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: { canvasMode: true },
    });
    let ruleIdByNodeKey: Record<string, string> = {};
    if (meta?.canvasMode === 'AUTOMATION') {
        ({ ruleIdByNodeKey } = await syncCanvasToRules(db, ctx, id, { priorGroupKeys }));
    }

    await logEvent(db, ctx, {
        action: 'UPDATE',
        entityType: 'ProcessMap',
        entityId: id,
        details: `Saved process map: ${map.name} (v${map.version})`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'ProcessMap',
            operation: 'updated',
            after: {
                name: map.name,
                status: map.status,
                version: map.version,
                nodeCount: map.nodes.length,
                edgeCount: map.edges.length,
            },
            summary: `Saved process map: ${map.name} (v${map.version})`,
        },
    });

    // The rule each step is now linked to, so the canvas that saved can
    // show a new step's rule without a reload (and send it next time).
    if (Object.keys(ruleIdByNodeKey).length === 0) return map;
    return {
        ...map,
        nodes: map.nodes.map((n) => {
            const ruleId = ruleIdByNodeKey[n.nodeKey];
            if (!ruleId) return n;
            const data =
                n.dataJson && typeof n.dataJson === 'object' && !Array.isArray(n.dataJson)
                    ? (n.dataJson as Record<string, unknown>)
                    : {};
            return { ...n, dataJson: { ...data, ruleId } };
        }),
    };
}

/**
 * Create a DRAFT, DOCUMENT-mode map WITH its graph, in ONE transaction (#5053).
 *
 * The approval of an agent's process-map proposal is the caller: a failure in
 * either half rolls both back, so no empty map is left behind. The map is
 * created by the caller (the approver), and its CREATE audit row names the
 * proposal. The two audit rows are the ones the two public usecases write.
 * Canvas → Rules sync stays inert: a DOCUMENT map has no rule-owning steps.
 */
export async function createProcessMapWithGraph(
    ctx: RequestContext,
    input: {
        name: string;
        description: string | null;
        nodes: SaveProcessMapInput['nodes'];
        edges: SaveProcessMapInput['edges'];
        sourceProposalId: string;
    },
): Promise<string> {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const map = await createProcessMapInTx(
            db,
            ctx,
            {
                name: input.name,
                description: input.description,
                status: 'DRAFT',
                canvasMode: 'DOCUMENT',
            },
            { sourceProposalId: input.sourceProposalId },
        );
        await saveProcessMapInTx(db, ctx, map.id, {
            nodes: input.nodes,
            edges: input.edges,
            expectedVersion: map.version,
        });
        return map.id;
    });
}

/**
 * VR / PR-B follow-up — switch an existing map between DOCUMENT (process map)
 * and AUTOMATION (visual rule editor) without a graph save. Gated on write.
 */
export async function setProcessMapCanvasMode(
    ctx: RequestContext,
    id: string,
    canvasMode: 'DOCUMENT' | 'AUTOMATION',
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const ok = await ProcessMapRepository.setCanvasMode(db, ctx, id, canvasMode);
        if (!ok) throw notFound('Process map not found');
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ProcessMap',
            entityId: id,
            details: `Set canvas mode: ${canvasMode}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'updated',
                after: { canvasMode },
                summary: `Canvas mode → ${canvasMode}`,
            },
        });
        return { id, canvasMode };
    });
}

/**
 * PR-F — lifecycle status transition (DRAFT → ACTIVE → ARCHIVED). Metadata
 * only; does not touch the graph. Mirrors setProcessMapCanvasMode.
 */
export async function setProcessMapStatus(
    ctx: RequestContext,
    id: string,
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const ok = await ProcessMapRepository.setStatus(db, ctx, id, status);
        if (!ok) throw notFound('Process map not found');
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ProcessMap',
            entityId: id,
            details: `Set status: ${status}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'updated',
                after: { status },
                summary: `Status → ${status}`,
            },
        });
        return { id, status };
    });
}

/**
 * Epic P2-PR-C — reverse lookup. Returns the process maps + edges
 * referencing a given control. Read-only; surfaces "Where is this
 * control used?" on the Control detail page.
 */
export type MapPlacement = {
    mapId: string;
    mapName: string;
    mapStatus: string;
    /** How the control is attached to the map. */
    via: 'edge' | 'node';
    /** edgeKey (edge-mounted) or nodeKey (node-mounted). */
    locationKey: string;
    label: string | null;
};

export async function listMapsUsingControl(
    ctx: RequestContext,
    controlId: string,
): Promise<MapPlacement[]> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        // A control can gate an edge (processEdgeControl) OR sit on a `control`
        // node (ProcessNode.dataJson.linkedEntityId). The edge-only lookup
        // missed node-mounted controls even though they count toward coverage —
        // union both so the reverse-lookup matches the coverage signal.
        const [edges, nodes] = await Promise.all([
            ProcessMapRepository.listMapsByControl(db, ctx, controlId),
            ProcessMapRepository.listMapsByLinkedEntity(db, ctx, 'control', controlId),
        ]);
        return [
            ...edges.map((e) => ({
                mapId: e.mapId,
                mapName: e.mapName,
                mapStatus: e.mapStatus,
                via: 'edge' as const,
                locationKey: e.edgeKey,
                label: e.edgeLabel,
            })),
            ...nodes.map((n) => ({
                mapId: n.mapId,
                mapName: n.mapName,
                mapStatus: n.mapStatus,
                via: 'node' as const,
                locationKey: n.nodeKey,
                label: n.nodeLabel,
            })),
        ];
    });
}

/**
 * PR-D — reverse lookup for a NODE-mounted risk link. Returns the process
 * maps + nodes where a `risk` node links a given Risk. Read-only; surfaces
 * "Where is this risk used?" on the Risk detail page.
 */
export async function listMapsUsingRisk(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ProcessMapRepository.listMapsByLinkedEntity(db, ctx, 'risk', riskId),
    );
}

/**
 * PR-D — reverse lookup for a NODE-mounted asset link. Returns the process
 * maps + nodes where an `asset` node links a given Asset. Read-only;
 * surfaces "Where is this asset used?" on the Asset detail page.
 */
export async function listMapsUsingAsset(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ProcessMapRepository.listMapsByLinkedEntity(db, ctx, 'asset', assetId),
    );
}

/**
 * Epic P5-PR-A — list snapshots for a process map. Read-only;
 * surfaces the version-history sidebar.
 */
export async function listProcessMapSnapshots(
    ctx: RequestContext,
    mapId: string,
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ProcessMapRepository.listSnapshots(db, ctx, mapId),
    );
}

/**
 * Epic P5-PR-B — fetch one snapshot's full graphJson by version.
 * Powers "View version N" + visual diff.
 */
export async function getProcessMapSnapshot(
    ctx: RequestContext,
    mapId: string,
    version: number,
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const snapshot = await ProcessMapRepository.getSnapshotByVersion(
            db,
            ctx,
            mapId,
            version,
        );
        if (!snapshot) throw notFound('Snapshot not found');
        return snapshot;
    });
}

/**
 * Epic P5-PR-B — restore a process map to an earlier snapshot.
 * Routes through `replaceGraph` so the restored state becomes its
 * own new snapshot (no history is lost — a "vN restored from vM"
 * row appears in the timeline). `expectedVersion` is forwarded
 * so the P1 optimistic-concurrency check still gates the write.
 */
export async function restoreProcessMapSnapshot(
    ctx: RequestContext,
    mapId: string,
    targetVersion: number,
    expectedVersion: number,
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const snapshot = await ProcessMapRepository.getSnapshotByVersion(
            db,
            ctx,
            mapId,
            targetVersion,
        );
        if (!snapshot) throw notFound('Snapshot not found');

        const json = snapshot.graphJson as {
            nodes?: SaveProcessMapInput['nodes'];
            edges?: SaveProcessMapInput['edges'];
            freeformJson?: unknown;
        };
        const map = await ProcessMapRepository.replaceGraph(db, ctx, mapId, {
            nodes: json.nodes ?? [],
            edges: json.edges ?? [],
            // #2960 — EXPLICIT, never omitted. Omitting it means "leave the
            // stored value alone", which on a restore is exactly wrong: the
            // user would get v3's graph carrying today's sticky notes.
            //
            // `?? null` also handles a snapshot taken BEFORE this column
            // existed. Such a map had no freeform layer, so restoring it to
            // null is not data loss — it is the state that version was in.
            freeformJson: json.freeformJson ?? null,
            expectedVersion,
        });
        if (!map) throw notFound('Process map not found');

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'ProcessMap',
            entityId: mapId,
            details: `Restored process map ${map.name} from v${targetVersion}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'restored',
                summary: `Restored from v${targetVersion}`,
                after: {
                    name: map.name,
                    version: map.version,
                    restoredFromVersion: targetVersion,
                },
            },
        });

        return map;
    });
}

export async function deleteProcessMap(ctx: RequestContext, id: string) {
    // ADMIN, matching every peer destructive verb (deleteRisk, deleteAsset,
    // deleteEvidence, deleteControl, deletePolicy, deleteTask).
    //
    // This one is worse than the deleteTask gap that prompted the peer-gate
    // guardrail, on two counts.
    //
    // IRREVERSIBLE. Task is in SOFT_DELETE_MODELS, so an ADMIN can
    // `restoreEntity` a task somebody deleted by mistake. ProcessMap is in
    // NEITHER that list nor the SoftDeletableModel union — there is no restore
    // surface for any role, including OWNER. The `deletedAt` stamp is a
    // one-way door and recovery means a database restore.
    //
    // AND IT REMOVES COMPLIANCE EVIDENCE SILENTLY. Both reverse-lookup queries
    // filter deleted maps (ProcessMapRepository :708, :769), and they back
    // listMapsUsingControl / listMapsUsingRisk / listMapsUsingAsset — the
    // "where is this control used?" panel on Control, Risk and Asset detail.
    // So an EDITOR removing one map quietly drops control-coverage placements
    // out of the governance view, with nothing to put them back.
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const ok = await ProcessMapRepository.softDelete(db, ctx, id, ctx.userId);
        if (!ok) throw notFound('Process map not found');

        await logEvent(db, ctx, {
            action: 'DELETE',
            entityType: 'ProcessMap',
            entityId: id,
            details: `Deleted process map`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ProcessMap',
                operation: 'deleted',
                summary: `Deleted process map ${id}`,
            },
        });

        return { id };
    });
}
