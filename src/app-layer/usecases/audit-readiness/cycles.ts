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
import { isFrameworkInUse } from '../framework/coverage';

// РІвЂќР‚РІвЂќР‚РІвЂќР‚ Audit Cycles РІвЂќР‚РІвЂќР‚РІвЂќР‚

export async function createAuditCycle(
    ctx: RequestContext,
    data: { frameworkKey: string; frameworkVersion: string; name: string; periodStartAt?: string; periodEndAt?: string }
) {
    assertCanManageAuditCycles(ctx);
    // PR-O — a cycle can be created for ANY framework, not just ISO27001 /
    // NIS2: the scorer dispatches other keys to computeGenericReadiness.
    //
    // #4129 — but only for a framework IN USE in this workspace. The check
    // used to be `framework.findFirst({ key })`, a lookup in the GLOBAL
    // catalogue, so any framework the product ships passed it — including one
    // this workspace has never mapped a control to, whose cycle then scores
    // against nothing. "In use" is the Frameworks page's rule (a live control
    // mapped to one of the framework's requirements), and the cycle form's
    // picker offers exactly the frameworks that pass it.
    if (!data.frameworkKey || !(await isFrameworkInUse(ctx, data.frameworkKey))) {
        throw badRequest(
            'This framework is not in use in this workspace: none of your controls is mapped to its requirements. ' +
                'Install it from the Frameworks page first, then create the cycle.',
        );
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
    return runInTenantContext(ctx, async (tdb) => {
        const cycles = await tdb.auditCycle.findMany({
            where: { tenantId: ctx.tenantId },
            include: { packs: { select: { id: true, name: true, status: true }, take: 500 } },
            orderBy: { createdAt: 'desc' },
            take: 500,
        });
        // The catalogue's name for each cycle's framework, read once for
        // the distinct keys: the readiness overview listed cycles by key
        // ("· SOC2") beside cards that already showed names (#4729).
        const keys = [...new Set(cycles.map((c) => c.frameworkKey))];
        const frameworks = keys.length === 0 ? [] : await tdb.framework.findMany({
            where: { key: { in: keys } },
            select: { key: true, name: true },
            take: keys.length,
        });
        const nameByKey = new Map(frameworks.map((f) => [f.key, f.name]));
        return cycles.map((c) => ({ ...c, frameworkName: nameByKey.get(c.frameworkKey) ?? null }));
    });
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
