import { RequestContext } from '../types';
import { ControlRiskRepository, AssetControlRepository, AssetRiskRepository } from '../repositories/TraceabilityRepository';
import { ProcessMapRepository } from '../repositories/ProcessMapRepository';
import { logEvent } from '../events/audit';
import { forbidden, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { policyCountsWhere } from '@/lib/policy/coverage-predicate';

function assertCanRead(ctx: RequestContext) {
    // All roles can read traceability
}

function assertCanManage(ctx: RequestContext) {
    // Epic 1 — OWNER is a superset of ADMIN per CLAUDE.md RBAC.
    if (!['OWNER', 'ADMIN', 'EDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage mappings');
    }
}

// ─── Control ↔ Risk ───

export async function listControlRisks(ctx: RequestContext, controlId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => ControlRiskRepository.listByControl(db, ctx.tenantId, controlId));
}

export async function listRiskControls(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => ControlRiskRepository.listByRisk(db, ctx.tenantId, riskId));
}

export async function mapControlToRisk(ctx: RequestContext, controlId: string, riskId: string, rationale?: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const link = await ControlRiskRepository.link(db, ctx.tenantId, controlId, riskId, rationale || null, ctx.userId);
        await logEvent(db, ctx, { action: 'CONTROL_RISK_LINKED', entityType: 'Control', entityId: controlId, details: `Linked to risk ${riskId}`, detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'Risk', targetId: riskId, relation: 'mitigates' }, metadata: { riskId, rationale } });
        return link;
    });
}

export async function unmapControlFromRisk(ctx: RequestContext, controlId: string, riskId: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        await ControlRiskRepository.unlink(db, ctx.tenantId, controlId, riskId);
        await logEvent(db, ctx, { action: 'CONTROL_RISK_UNLINKED', entityType: 'Control', entityId: controlId, details: `Unlinked from risk ${riskId}`, detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Control', sourceId: controlId, targetEntity: 'Risk', targetId: riskId, relation: 'mitigates' }, metadata: { riskId } });
    });
}

// ─── Asset ↔ Control ───

export async function listAssetControls(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => AssetControlRepository.listByAsset(db, ctx.tenantId, assetId));
}

export async function listControlAssets(ctx: RequestContext, controlId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => AssetControlRepository.listByControl(db, ctx.tenantId, controlId));
}

export async function mapAssetToControl(ctx: RequestContext, assetId: string, controlId: string, coverageType?: string, rationale?: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Both the URL asset AND the body-supplied control must live in the
        // caller's tenant — the link insert stamps ctx.tenantId regardless, so
        // an unverified target id would cross-link another tenant's control.
        // 404 (not 403) keeps the id namespace non-enumerable.
        const [asset, control] = await Promise.all([
            db.asset.findFirst({ where: { id: assetId, tenantId: ctx.tenantId }, select: { id: true } }),
            db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId }, select: { id: true } }),
        ]);
        if (!asset) throw notFound('Asset not found');
        if (!control) throw notFound('Control not found');
        const link = await AssetControlRepository.link(db, ctx.tenantId, assetId, controlId, coverageType || null, rationale || null, ctx.userId);
        await logEvent(db, ctx, { action: 'ASSET_CONTROL_LINKED', entityType: 'Asset', entityId: assetId, details: `Linked to control ${controlId}`, detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Control', targetId: controlId, relation: coverageType || 'FULL' }, metadata: { controlId, coverageType } });
        return link;
    });
}

export async function unmapAssetFromControl(ctx: RequestContext, assetId: string, controlId: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        await AssetControlRepository.unlink(db, ctx.tenantId, assetId, controlId);
        await logEvent(db, ctx, { action: 'ASSET_CONTROL_UNLINKED', entityType: 'Asset', entityId: assetId, details: `Unlinked from control ${controlId}`, detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Control', targetId: controlId }, metadata: { controlId } });
    });
}

// ─── Asset ↔ Risk ───

export async function listAssetRisks(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => AssetRiskRepository.listByAsset(db, ctx.tenantId, assetId));
}

export async function listRiskAssets(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) => AssetRiskRepository.listByRisk(db, ctx.tenantId, riskId));
}

export async function mapAssetToRisk(ctx: RequestContext, assetId: string, riskId: string, exposureLevel?: string, rationale?: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Verify both the URL asset AND the body-supplied risk live in the
        // caller's tenant before linking (see mapAssetToControl). 404 otherwise.
        const [asset, risk] = await Promise.all([
            db.asset.findFirst({ where: { id: assetId, tenantId: ctx.tenantId }, select: { id: true } }),
            db.risk.findFirst({ where: { id: riskId, tenantId: ctx.tenantId }, select: { id: true } }),
        ]);
        if (!asset) throw notFound('Asset not found');
        if (!risk) throw notFound('Risk not found');
        const existing = await AssetRiskRepository.findLink(db, ctx.tenantId, assetId, riskId);
        const link = await AssetRiskRepository.link(db, ctx.tenantId, assetId, riskId, exposureLevel || null, rationale || null, ctx.userId);
        if (!existing) {
            await logEvent(db, ctx, { action: 'ASSET_RISK_LINKED', entityType: 'Asset', entityId: assetId, details: `Linked to risk ${riskId}`, detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Risk', targetId: riskId, relation: exposureLevel || 'DIRECT' }, metadata: { riskId, exposureLevel } });
        } else if (link.exposureLevel !== existing.exposureLevel || link.rationale !== existing.rationale) {
            await logEvent(db, ctx, { action: 'ASSET_RISK_UPDATED', entityType: 'Asset', entityId: assetId, details: `Updated link to risk ${riskId}`, detailsJson: { category: 'relationship', operation: 'updated', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Risk', targetId: riskId }, metadata: { riskId, exposureLevel } });
        }
        return link;
    });
}

export async function unmapAssetFromRisk(ctx: RequestContext, assetId: string, riskId: string) {
    assertCanManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        await AssetRiskRepository.unlink(db, ctx.tenantId, assetId, riskId);
        await logEvent(db, ctx, { action: 'ASSET_RISK_UNLINKED', entityType: 'Asset', entityId: assetId, details: `Unlinked from risk ${riskId}`, detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Asset', sourceId: assetId, targetEntity: 'Risk', targetId: riskId }, metadata: { riskId } });
    });
}

// ─── Traceability Views ───

/** Unified process-map placement (where an entity sits on the canvas), so
 *  "sits on map X" shows inline in traceability, not only in a separate modal. */
export type TraceabilityMapPlacement = {
    mapId: string;
    mapName: string;
    mapStatus: string;
    via: 'edge' | 'node';
    locationKey: string;
    label: string | null;
};

export async function getControlTraceability(ctx: RequestContext, controlId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [risks, assets, edgeMaps, nodeMaps] = await Promise.all([
            ControlRiskRepository.listByControl(db, ctx.tenantId, controlId),
            AssetControlRepository.listByControl(db, ctx.tenantId, controlId),
            // A control gates edges (processEdgeControl) AND/OR sits on `control`
            // nodes (ProcessNode.linkedEntityId) — union both.
            ProcessMapRepository.listMapsByControl(db, ctx, controlId),
            ProcessMapRepository.listMapsByLinkedEntity(db, ctx, 'control', controlId),
        ]);
        const processMaps: TraceabilityMapPlacement[] = [
            ...edgeMaps.map((e) => ({
                mapId: e.mapId, mapName: e.mapName, mapStatus: e.mapStatus,
                via: 'edge' as const, locationKey: e.edgeKey, label: e.edgeLabel,
            })),
            ...nodeMaps.map((n) => ({
                mapId: n.mapId, mapName: n.mapName, mapStatus: n.mapStatus,
                via: 'node' as const, locationKey: n.nodeKey, label: n.nodeLabel,
            })),
        ];
        return { controlId, risks, assets, processMaps };
    });
}

export async function getRiskTraceability(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [controls, assets, nodeMaps] = await Promise.all([
            ControlRiskRepository.listByRisk(db, ctx.tenantId, riskId),
            AssetRiskRepository.listByRisk(db, ctx.tenantId, riskId),
            ProcessMapRepository.listMapsByLinkedEntity(db, ctx, 'risk', riskId),
        ]);
        const processMaps: TraceabilityMapPlacement[] = nodeMaps.map((n) => ({
            mapId: n.mapId, mapName: n.mapName, mapStatus: n.mapStatus,
            via: 'node' as const, locationKey: n.nodeKey, label: n.nodeLabel,
        }));
        return { riskId, controls, assets, processMaps };
    });
}

export async function getAssetTraceability(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [controls, risks, nodeMaps] = await Promise.all([
            AssetControlRepository.listByAsset(db, ctx.tenantId, assetId),
            AssetRiskRepository.listByAsset(db, ctx.tenantId, assetId),
            ProcessMapRepository.listMapsByLinkedEntity(db, ctx, 'asset', assetId),
        ]);
        const processMaps: TraceabilityMapPlacement[] = nodeMaps.map((n) => ({
            mapId: n.mapId, mapName: n.mapName, mapStatus: n.mapStatus,
            via: 'node' as const, locationKey: n.nodeKey, label: n.nodeLabel,
        }));
        return { assetId, controls, risks, processMaps };
    });
}

/**
 * Policy traceability — read-only.
 *
 * A policy links DIRECTLY to controls (`PolicyControlLink`); risks and
 * assets are INHERITED through those controls (a policy "covers" the
 * risks its controls mitigate and the assets they protect). So this
 * view returns the directly-linked controls plus the deduped set of
 * risks/assets reachable via them, each tagged with how many of the
 * policy's controls reach it. Mirrors the Asset/Risk inherited-data
 * aggregators (`inherited-control-data.ts`); no link/unlink surface —
 * controls are managed via the policy↔control link flow, risks/assets
 * are purely derived.
 */
const POLICY_TRACE_TAKE = 200;

export async function getPolicyTraceability(ctx: RequestContext, policyId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const t = ctx.tenantId;
        const links = await db.policyControlLink.findMany({
            where: { tenantId: t, policyId },
            select: {
                id: true,
                control: { select: { id: true, code: true, name: true, status: true, category: true } },
            },
            take: POLICY_TRACE_TAKE,
        });
        const controls = links
            .filter((l) => l.control)
            .map((l) => ({ id: l.id, control: l.control! }));
        const controlIds = controls.map((c) => c.control.id);

        if (controlIds.length === 0) {
            return { policyId, controls, risks: [], assets: [] };
        }

        const [riskLinks, assetLinks] = await Promise.all([
            db.riskControl.findMany({
                where: { tenantId: t, controlId: { in: controlIds } },
                select: {
                    controlId: true,
                    risk: { select: { id: true, title: true, status: true, score: true, category: true } },
                },
                take: POLICY_TRACE_TAKE,
            }),
            db.controlAsset.findMany({
                where: { tenantId: t, controlId: { in: controlIds } },
                select: {
                    controlId: true,
                    asset: { select: { id: true, name: true, type: true, criticality: true, status: true } },
                },
                take: POLICY_TRACE_TAKE,
            }),
        ]);

        // Dedup inherited entities by id; count the distinct policy
        // controls each is reachable through (the "via N controls" hint).
        const riskBy = new Map<string, { id: string; risk: (typeof riskLinks)[number]['risk']; viaControls: number }>();
        for (const r of riskLinks) {
            if (!r.risk) continue;
            const e = riskBy.get(r.risk.id);
            if (e) e.viaControls += 1;
            else riskBy.set(r.risk.id, { id: r.risk.id, risk: r.risk, viaControls: 1 });
        }
        const assetBy = new Map<string, { id: string; asset: (typeof assetLinks)[number]['asset']; viaControls: number }>();
        for (const a of assetLinks) {
            if (!a.asset) continue;
            const e = assetBy.get(a.asset.id);
            if (e) e.viaControls += 1;
            else assetBy.set(a.asset.id, { id: a.asset.id, asset: a.asset, viaControls: 1 });
        }

        return {
            policyId,
            controls,
            risks: [...riskBy.values()],
            assets: [...assetBy.values()],
        };
    });
}

// ─── Coverage Summary ───

export async function coverageSummary(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const t = ctx.tenantId;

        // Total counts. Policies use the shared "counts toward coverage"
        // predicate (PUBLISHED + not deleted) — a DRAFT is not governance.
        const [totalRisks, totalControls, totalAssets, totalPolicies] = await Promise.all([
            db.risk.count({ where: { tenantId: t } }),
            db.control.count({ where: { tenantId: t } }),
            db.asset.count({ where: { tenantId: t, status: 'ACTIVE' } }),
            db.policy.count({ where: policyCountsWhere(t) }),
        ]);

        // Mapped counts (distinct)
        const [risksWithControls, controlsWithRisks, assetsWithControls, policiesWithControls] = await Promise.all([
            db.riskControl.findMany({ where: { tenantId: t }, select: { riskId: true }, distinct: ['riskId'] }),
            db.riskControl.findMany({ where: { tenantId: t }, select: { controlId: true }, distinct: ['controlId'] }),
            db.controlAsset.findMany({ where: { tenantId: t }, select: { assetId: true }, distinct: ['assetId'] }),
            // Counting policies is gated by the same predicate, applied to the
            // linked policy so an unpublished policy's links don't inflate coverage.
            db.policyControlLink.findMany({ where: { tenantId: t, policy: policyCountsWhere(t) }, select: { policyId: true }, distinct: ['policyId'] }),
        ]);

        const risksWithControlsCount = risksWithControls.length;
        const controlsWithRisksCount = controlsWithRisks.length;
        const assetsWithControlsCount = assetsWithControls.length;
        const policiesWithControlsCount = policiesWithControls.length;

        // Unmapped risks (no controls)
        const mappedRiskIds = new Set(risksWithControls.map(r => r.riskId));
        const unmappedRisks = await db.risk.findMany({
            where: { tenantId: t, id: { notIn: Array.from(mappedRiskIds) } },
            select: { id: true, title: true, score: true, status: true },
            orderBy: { score: 'desc' },
            take: 10,
        });

        // Critical assets with no controls — HIGH + CRITICAL bands (the
        // stored `Asset.criticality` now carries a CRITICAL tier).
        const mappedAssetIds = new Set(assetsWithControls.map(a => a.assetId));
        const uncoveredCriticalAssets = await db.asset.findMany({
            where: { tenantId: t, status: 'ACTIVE', criticality: { in: ['HIGH', 'CRITICAL'] }, id: { notIn: Array.from(mappedAssetIds) } },
            select: { id: true, name: true, type: true, criticality: true },
            take: 10,
        });

        // Hot controls (most risks)
        const hotControls = await db.riskControl.groupBy({
            by: ['controlId'],
            where: { tenantId: t },
            _count: { riskId: true },
            orderBy: { _count: { riskId: 'desc' } },
            take: 5,
        });
        const hotControlDetails = hotControls.length > 0 ? await db.control.findMany({
            where: { id: { in: hotControls.map(h => h.controlId) } },
            select: { id: true, code: true, name: true },
        }) : [];
        const hotControlsResult = hotControls.map(h => ({
            ...hotControlDetails.find(c => c.id === h.controlId),
            riskCount: h._count.riskId,
        }));

        // PR-D — process coverage. A control is "embedded in an operational
        // process" when it is placed on a process-map edge (ProcessEdgeControl,
        // real FK) OR linked from a `control` node (dataJson.linkedEntityId).
        // This closes the loop: the canvas linkage now shows up in the same
        // coverage graph as risk / asset / policy mapping, so an auditor sees
        // which controls are actually wired into how the org operates.
        const [processEdgeControlIds, controlNodeRows] = await Promise.all([
            db.processEdgeControl.findMany({ where: { tenantId: t }, select: { controlId: true }, distinct: ['controlId'] }),
            db.processNode.findMany({ // guardrail-allow: unbounded — bounded by the small process-node graph; JSON linkedEntityId can't be distinct-queried
                where: { tenantId: t, nodeType: 'control' },
                select: { dataJson: true },
            }),
        ]);
        const processControlIds = new Set<string>();
        for (const r of processEdgeControlIds) processControlIds.add(r.controlId);
        for (const n of controlNodeRows) {
            const linkedId = (n.dataJson as { linkedEntityId?: unknown } | null)?.linkedEntityId;
            if (typeof linkedId === 'string' && linkedId.length > 0) processControlIds.add(linkedId);
        }
        // Count only real, tenant-owned controls (a node link could reference a
        // since-deleted control); the IN-list bounds the query.
        const controlsWithProcessCount = processControlIds.size > 0
            ? await db.control.count({ where: { tenantId: t, id: { in: Array.from(processControlIds) } } })
            : 0;

        return {
            totalRisks,
            totalControls,
            totalAssets,
            risksWithControlsCount,
            risksWithControlsPct: totalRisks > 0 ? Math.round((risksWithControlsCount / totalRisks) * 100) : 0,
            controlsWithRisksCount,
            controlsWithRisksPct: totalControls > 0 ? Math.round((controlsWithRisksCount / totalControls) * 100) : 0,
            assetsWithControlsCount,
            assetsWithControlsPct: totalAssets > 0 ? Math.round((assetsWithControlsCount / totalAssets) * 100) : 0,
            // Policy governance coverage — how many issued (PUBLISHED) policies
            // are mapped to at least one control.
            totalPolicies,
            policiesWithControlsCount,
            policiesWithControlsPct: totalPolicies > 0 ? Math.round((policiesWithControlsCount / totalPolicies) * 100) : 0,
            // Process coverage — controls embedded in an operational process map.
            controlsWithProcessCount,
            controlsWithProcessPct: totalControls > 0 ? Math.round((controlsWithProcessCount / totalControls) * 100) : 0,
            unmappedRisks,
            uncoveredCriticalAssets,
            hotControls: hotControlsResult,
        };
    });
}
