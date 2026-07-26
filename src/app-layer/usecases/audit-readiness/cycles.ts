/**
 * Audit Readiness — Cycle CRUD
 */
import { AuditCycleStatus } from '@prisma/client';
import { RequestContext } from '../../types';
import {
    assertCanManageAuditCycles, assertCanViewPack,
} from '../../policies/audit-readiness.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { recordAuditCycleStarted } from '@/lib/observability/business-metrics';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Audit Cycles РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function createAuditCycle(
    ctx: RequestContext,
    data: { frameworkKey: string; frameworkVersion: string; name: string; periodStartAt?: string; periodEndAt?: string }
) {
    assertCanManageAuditCycles(ctx);
    // PR-O — a cycle can be created for ANY installed framework, not just
    // ISO27001 / NIS2. The scorer already dispatches non-ISO/NIS2 keys to
    // computeGenericReadiness (coverage + evidence + issues), so the only
    // thing that gated custom frameworks was this allowlist. We still require
    // the framework to be installed for the tenant so a cycle can't reference
    // a key with no requirements to score.
    const installed = await runInTenantContext(ctx, (tdb) =>
        tdb.framework.findFirst({ where: { key: data.frameworkKey }, select: { key: true } }),
    );
    if (!data.frameworkKey || !installed) {
        throw badRequest('frameworkKey must be an installed framework');
    }

    const cycle = await runInTenantContext(ctx, async (tdb) => {
        const created = await tdb.auditCycle.create({
            data: {
                tenantId: ctx.tenantId,
                frameworkKey: data.frameworkKey,
                frameworkVersion: data.frameworkVersion,
                name: data.name,
                periodStartAt: data.periodStartAt ? new Date(data.periodStartAt) : null,
                periodEndAt: data.periodEndAt ? new Date(data.periodEndAt) : null,
                createdByUserId: ctx.userId,
            },
        });
        await logEvent(tdb, ctx, { action: 'AUDIT_CYCLE_CREATED', entityType: 'AuditCycle', entityId: created.id, details: JSON.stringify({ frameworkKey: data.frameworkKey, name: data.name }), detailsJson: { category: 'entity_lifecycle', entityName: 'AuditCycle', operation: 'created', after: { frameworkKey: data.frameworkKey, name: data.name }, summary: `Audit cycle created: ${data.name}` } });
        return created;
    });
    recordAuditCycleStarted();
    await bumpEntityCacheVersion(ctx, 'audit');
    return cycle;
}

export async function listAuditCycles(ctx: RequestContext) {
    assertCanViewPack(ctx);
    return runInTenantContext(ctx, (tdb) =>
        tdb.auditCycle.findMany({
            where: { tenantId: ctx.tenantId },
            include: { packs: { select: { id: true, name: true, status: true }, take: 500 } },
            orderBy: { createdAt: 'desc' },
            take: 500,
        })
    );
}

export async function getAuditCycle(ctx: RequestContext, cycleId: string) {
    assertCanViewPack(ctx);
    const cycle = await runInTenantContext(ctx, (tdb) =>
        tdb.auditCycle.findFirst({
            where: { id: cycleId, tenantId: ctx.tenantId },
            include: {
                packs: { take: 500 },
                createdBy: { select: { id: true, name: true, email: true } },
                // feat/audit-cycle-unify — the fieldwork audits attached to
                // this cycle, so the cycle page can show its audits (and the
                // link is visible end-to-end, not just in the schema).
                audits: {
                    where: { deletedAt: null },
                    select: { id: true, title: true, status: true, frameworkKey: true, schedule: true },
                    orderBy: { createdAt: 'desc' },
                    take: 500,
                },
            },
        })
    );
    if (!cycle) throw notFound('Audit cycle not found');
    return cycle;
}

export async function updateAuditCycle(
    ctx: RequestContext,
    cycleId: string,
    data: { name?: string; status?: string; periodStartAt?: string; periodEndAt?: string }
) {
    assertCanManageAuditCycles(ctx);
    const cycle = await runInTenantContext(ctx, async (tdb) => {
        const existing = await tdb.auditCycle.findFirst({ where: { id: cycleId, tenantId: ctx.tenantId } });
        if (!existing) throw notFound('Audit cycle not found');
        const updated = await tdb.auditCycle.update({
            where: { id: cycleId },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.status !== undefined && { status: data.status as AuditCycleStatus }),
                ...(data.periodStartAt !== undefined && { periodStartAt: data.periodStartAt ? new Date(data.periodStartAt) : null }),
                ...(data.periodEndAt !== undefined && { periodEndAt: data.periodEndAt ? new Date(data.periodEndAt) : null }),
            },
        });
        await logEvent(tdb, ctx, { action: 'AUDIT_CYCLE_UPDATED', entityType: 'AuditCycle', entityId: updated.id, details: JSON.stringify(data), detailsJson: { category: 'entity_lifecycle', entityName: 'AuditCycle', operation: 'updated', changedFields: Object.keys(data).filter(k => data[k as keyof typeof data] !== undefined), summary: 'Audit cycle updated' } });
        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'audit');
    return cycle;
}
