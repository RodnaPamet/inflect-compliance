/**
 * Inherited control data for Asset / Risk detail pages.
 *
 * Evidence and test plans attach ONLY to controls. An asset or risk
 * "has" neither directly — it inherits them from the controls it is
 * mapped to (ControlAsset for assets, RiskControl for risks). These
 * read-only aggregators gather the evidence / test plans across the
 * mapped controls and tag each row with its owning control, so the
 * Asset/Risk Evidence and Tests tabs can surface them.
 *
 * Tenant isolation: every query runs inside `runInTenantContext`
 * (RLS-bound) AND filters by `ctx.tenantId` — defence in depth, same
 * as every other repository read.
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';

const CONTROL_SELECT = { id: true, code: true, annexId: true, name: true } as const;
const AGG_TAKE = 200;

type ControlRef = { id: string; code: string | null; annexId: string | null; name: string };

/** Resolve the controls mapped to an asset → (controlId[], control-by-id map). */
async function controlsForAsset(db: PrismaTx, tenantId: string, assetId: string) {
    const maps = await db.controlAsset.findMany({
        where: { tenantId, assetId },
        select: { controlId: true, control: { select: CONTROL_SELECT } },
        take: AGG_TAKE,
    });
    return mapControls(maps);
}

/** Resolve the controls linked to a policy → (controlId[], control-by-id map). */
async function controlsForPolicy(db: PrismaTx, tenantId: string, policyId: string) {
    const maps = await db.policyControlLink.findMany({
        where: { tenantId, policyId },
        select: { controlId: true, control: { select: CONTROL_SELECT } },
        take: AGG_TAKE,
    });
    return mapControls(maps);
}

/** Resolve the controls mapped to a risk → (controlId[], control-by-id map). */
async function controlsForRisk(db: PrismaTx, tenantId: string, riskId: string) {
    const maps = await db.riskControl.findMany({
        where: { tenantId, riskId },
        select: { controlId: true, control: { select: CONTROL_SELECT } },
        take: AGG_TAKE,
    });
    return mapControls(maps);
}

function mapControls(
    maps: ReadonlyArray<{ controlId: string; control: ControlRef | null }>,
): { controlIds: string[]; byId: Map<string, ControlRef> } {
    const byId = new Map<string, ControlRef>();
    for (const m of maps) {
        if (m.control) byId.set(m.controlId, m.control);
    }
    return { controlIds: [...byId.keys()], byId };
}

async function evidenceForControls(
    db: PrismaTx,
    tenantId: string,
    controlIds: string[],
    byId: Map<string, ControlRef>,
) {
    if (controlIds.length === 0) return [];
    // Evidence↔Control is a many-to-many join now: read the linked Evidence
    // through it so each inherited row carries the control it came from. An
    // evidence linked to several of the mapped controls surfaces once per
    // control (the "control" column tells them apart) — the same inheritance
    // semantic the single-FK version produced.
    const links = await db.evidenceControlLink.findMany({
        where: { tenantId, controlId: { in: controlIds }, evidence: { deletedAt: null } },
        orderBy: { evidence: { createdAt: 'desc' } },
        include: { evidence: true },
        take: AGG_TAKE,
    });
    return links.map((l) => ({ ...l.evidence, control: byId.get(l.controlId) ?? null }));
}

async function testPlansForControls(
    db: PrismaTx,
    tenantId: string,
    controlIds: string[],
    byId: Map<string, ControlRef>,
) {
    if (controlIds.length === 0) return [];
    const plans = await db.controlTestPlan.findMany({
        where: { tenantId, controlId: { in: controlIds } },
        include: {
            runs: {
                orderBy: { executedAt: 'desc' },
                take: 1,
                select: { id: true, result: true, status: true, executedAt: true },
            },
        },
        orderBy: { createdAt: 'desc' },
        take: AGG_TAKE,
    });
    return plans.map((p) => ({ ...p, control: byId.get(p.controlId) ?? null }));
}

async function mappingsForControls(
    db: PrismaTx,
    tenantId: string,
    controlIds: string[],
    byId: Map<string, ControlRef>,
) {
    if (controlIds.length === 0) return [];
    // Control → framework requirement links. Frameworks +
    // requirements are a GLOBAL catalogue (no tenantId), so the
    // tenant scope rides on ControlRequirementLink.tenantId; the
    // requirement/framework are read through the relation.
    const links = await db.controlRequirementLink.findMany({
        where: { tenantId, controlId: { in: controlIds } },
        select: {
            controlId: true,
            requirement: {
                select: {
                    id: true,
                    code: true,
                    title: true,
                    framework: { select: { id: true, name: true, version: true } },
                },
            },
        },
        take: AGG_TAKE,
    });
    return links.map((l) => ({
        requirementId: l.requirement.id,
        code: l.requirement.code,
        title: l.requirement.title,
        framework: l.requirement.framework,
        control: byId.get(l.controlId) ?? null,
    }));
}

// ─── Public usecases ───

export function getAssetInheritedEvidence(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForAsset(db, ctx.tenantId, assetId);
        return evidenceForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getRiskInheritedEvidence(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForRisk(db, ctx.tenantId, riskId);
        return evidenceForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getAssetInheritedTestPlans(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForAsset(db, ctx.tenantId, assetId);
        return testPlansForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getRiskInheritedTestPlans(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForRisk(db, ctx.tenantId, riskId);
        return testPlansForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getAssetInheritedMappings(ctx: RequestContext, assetId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForAsset(db, ctx.tenantId, assetId);
        return mappingsForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getRiskInheritedMappings(ctx: RequestContext, riskId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForRisk(db, ctx.tenantId, riskId);
        return mappingsForControls(db, ctx.tenantId, controlIds, byId);
    });
}

export function getPolicyInheritedMappings(ctx: RequestContext, policyId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const { controlIds, byId } = await controlsForPolicy(db, ctx.tenantId, policyId);
        return mappingsForControls(db, ctx.tenantId, controlIds, byId);
    });
}
