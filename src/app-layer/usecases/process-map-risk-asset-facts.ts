/**
 * The live facts a `risk` or `asset` node's card shows, read fresh for each
 * request — the siblings of `process-map-control-facts.ts`, with its rules:
 *
 *   - the client names the ids on the canvas, scoped to a map the caller can
 *     read, so a link picked a moment ago fills in before autosave;
 *   - an id that is not a live record of this tenant is `missing`, exactly as a
 *     deleted one is, and says nothing more;
 *   - a caller who may read the map but not the record kind gets
 *     `restricted: true` and no facts, rather than a 403 that would write an
 *     AUTHZ_DENIED row every time they opened a map.
 *
 * A risk's band is the TENANT'S matrix band (`getRiskMatrixConfig` +
 * `resolveBandForScore`), never the legacy fixed-percentage ladder, so the node
 * says the same "High" or "Critical" the register and the heat map say.
 */
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { canReadRisks } from '../policies/risk.policies';
import { canReadAssets } from '../policies/asset.policies';
import { getRiskMatrixConfig } from './risk-matrix-config';
import { resolveBandForScore } from '@/lib/risk-matrix/scoring';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { MAX_CONTROL_FACT_IDS } from '@/lib/processes/control-facts-types';
import type {
    AssetFact,
    ProcessMapAssetFacts,
    ProcessMapRiskFacts,
    RiskFact,
} from '@/lib/processes/risk-asset-facts-types';

function boundedIds(ids: readonly string[]): string[] {
    return Array.from(new Set(ids.filter((id) => id.length > 0))).slice(0, MAX_CONTROL_FACT_IDS);
}

async function assertMapReadable(db: PrismaTx, ctx: RequestContext, mapId: string): Promise<void> {
    const map = await db.processMap.findFirst({
        where: { id: mapId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
    });
    if (!map) throw notFound('Process map not found');
}

export async function getProcessMapRiskFacts(
    ctx: RequestContext,
    mapId: string,
    ids: readonly string[],
    now: Date = new Date(),
): Promise<ProcessMapRiskFacts> {
    assertCanRead(ctx);
    const wanted = boundedIds(ids);
    const mayRead = canReadRisks(ctx);
    // Read before the transaction below: it opens its own.
    const bands = mayRead && wanted.length > 0 ? (await getRiskMatrixConfig(ctx)).bands : [];

    return runInTenantContext(ctx, async (db) => {
        await assertMapReadable(db, ctx, mapId);
        if (!mayRead) return { restricted: true, risks: {}, missing: [] };
        if (wanted.length === 0) return { restricted: false, risks: {}, missing: [] };

        // Each bounded by `wanted` (at most MAX_CONTROL_FACT_IDS) or by this one
        // map's saved graph. The default read hides a soft-deleted risk or
        // control, so a trashed risk reads as missing and a trashed control does
        // not count as mitigating.
        const [rows, mitigations, nodeControls, edgeControls] = await Promise.all([
            db.risk.findMany({ // guardrail-allow: unbounded
                where: { id: { in: wanted }, tenantId: ctx.tenantId },
                select: {
                    id: true,
                    key: true,
                    title: true,
                    status: true,
                    treatment: true,
                    inherentScore: true,
                    residualScore: true,
                    nextReviewAt: true,
                },
            }),
            db.riskControl.findMany({ // guardrail-allow: unbounded
                where: { tenantId: ctx.tenantId, riskId: { in: wanted }, control: { deletedAt: null } },
                select: { riskId: true, controlId: true },
            }),
            db.processNodeControl.findMany({ // guardrail-allow: unbounded
                where: { tenantId: ctx.tenantId, processMapId: mapId },
                select: { controlId: true },
            }),
            db.processEdgeControl.findMany({ // guardrail-allow: unbounded
                where: { tenantId: ctx.tenantId, processMapId: mapId },
                select: { controlId: true },
            }),
        ]);

        const onMap = new Set<string>([
            ...nodeControls.map((r) => r.controlId),
            ...edgeControls.map((r) => r.controlId),
        ]);
        const mitigatingByRisk = new Map<string, Set<string>>();
        for (const m of mitigations) {
            const set = mitigatingByRisk.get(m.riskId) ?? new Set<string>();
            set.add(m.controlId);
            mitigatingByRisk.set(m.riskId, set);
        }

        const risks: Record<string, RiskFact> = {};
        for (const r of rows) {
            const residual = r.residualScore ?? null;
            const score = residual ?? r.inherentScore;
            // `resolveBandForScore` answers its neutral "Unbanded" band when no
            // configured band covers the score; that is no band, not a grey one.
            const resolved = resolveBandForScore(score, bands);
            const band = bands.includes(resolved) ? resolved : null;
            const mitigating = [...(mitigatingByRisk.get(r.id) ?? [])];
            risks[r.id] = {
                id: r.id,
                key: r.key ?? null,
                title: r.title,
                status: r.status,
                treatment: r.treatment ?? null,
                score,
                scoreKind: residual !== null ? 'RESIDUAL' : 'INHERENT',
                inherentScore: r.inherentScore,
                band: band ? { name: band.name, color: band.color } : null,
                reviewOverdue: r.nextReviewAt !== null && r.nextReviewAt.getTime() < now.getTime(),
                mitigation: {
                    onMap: mitigating.filter((c) => onMap.has(c)).length,
                    total: mitigating.length,
                },
            };
        }
        return { restricted: false, risks, missing: wanted.filter((id) => !(id in risks)) };
    });
}

export async function getProcessMapAssetFacts(
    ctx: RequestContext,
    mapId: string,
    ids: readonly string[],
): Promise<ProcessMapAssetFacts> {
    assertCanRead(ctx);
    const wanted = boundedIds(ids);

    return runInTenantContext(ctx, async (db) => {
        await assertMapReadable(db, ctx, mapId);
        if (!canReadAssets(ctx)) return { restricted: true, assets: {}, missing: [] };
        if (wanted.length === 0) return { restricted: false, assets: {}, missing: [] };

        // Bounded by `wanted`. A soft-deleted asset reads as missing.
        const rows = await db.asset.findMany({ // guardrail-allow: unbounded
            where: { id: { in: wanted }, tenantId: ctx.tenantId },
            select: { id: true, key: true, name: true, type: true, criticality: true, status: true },
        });
        const assets: Record<string, AssetFact> = {};
        for (const a of rows) {
            assets[a.id] = {
                id: a.id,
                key: a.key ?? null,
                name: a.name,
                type: a.type,
                criticality: a.criticality ?? null,
                status: a.status,
            };
        }
        return { restricted: false, assets, missing: wanted.filter((id) => !(id in assets)) };
    });
}
