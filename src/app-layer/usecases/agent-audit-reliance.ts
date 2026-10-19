/**
 * Step 4d (#3681) — ASSEMBLE A RELIANCE PACK FOR ONE AUDIT CYCLE.
 *
 * The external auditor relies on the auditor agent's workpapers for named
 * controls on one basis: internal audit's re-performance of a sample of them
 * (3d). This usecase gathers what that basis rests on into an ordinary audit
 * pack, so it is frozen, shared and revoked by the paths every pack already
 * uses (`usecases/audit-readiness/`):
 *
 *   - one CONTROL item per control in scope, whose snapshot carries the
 *     control's own fields plus a `reliance` block — its procedures, every
 *     workpaper of the cycle's period, internal audit's sampling record of
 *     each, the agreement figures and the limits that apply;
 *   - one FRAMEWORK_COVERAGE item for the pack — the scope, the period, the
 *     catalogue version and its standing, the pack's agreement rate with its
 *     definition, and the pack's limits.
 *
 * The pack is assembled and FROZEN in one call. A DRAFT reliance pack would be
 * a pack whose items could still be added to, and the share path refuses to
 * serve a DRAFT anyway.
 *
 * Everything decided about the rows is decided by `planReliancePack` in
 * `lib/agentic/audit-reliance.ts`; this file reads and writes. A refusal is a
 * 409 with a named reason and leaves an audit row, never a partial pack.
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { assertCanFreezePack } from '../policies/audit-readiness.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { ConflictError, notFound } from '@/lib/errors/types';
import { freezeAuditPack } from './audit-readiness/packs';
import {
    LIBRARY_V1_PROCEDURE_IDS,
    parseAuditProcedureConfig,
} from '@/lib/agentic/audit-procedure-library';
import {
    RELIANCE_WORKPAPER_CAP,
    periodLabelsWithin,
    planReliancePack,
    type RelianceControl,
    type RelianceRefusal,
    type RelianceSummarySnapshot,
    type ReliancePlan,
    type RelianceWorkpaper,
} from '@/lib/agentic/audit-reliance';

export interface AssembleReliancePackResult {
    readonly packId: string;
    readonly status: 'FROZEN';
    readonly controls: number;
    readonly workpapers: number;
    readonly summary: RelianceSummarySnapshot;
}

const DEFAULT_NAME_PREFIX = 'Agent-audit reliance';
const NAME_MAX = 200;

/**
 * Assemble and freeze the reliance pack for `auditCycleId`. OWNER or ADMIN,
 * the population that may freeze a pack (`assertCanFreezePack`), because
 * assembling one freezes it.
 */
export async function assembleAgentAuditReliancePack(
    ctx: RequestContext,
    auditCycleId: string,
    opts: { name?: string } = {},
): Promise<AssembleReliancePackResult> {
    assertCanFreezePack(ctx);

    const read = await runInTenantContext(ctx, async (db) => {
        const cycle = await db.auditCycle.findFirst({
            where: { id: auditCycleId, tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true,
                name: true,
                frameworkKey: true,
                frameworkVersion: true,
                periodStartAt: true,
                periodEndAt: true,
            },
        });
        if (!cycle) throw notFound('Audit cycle not found');

        const labels =
            cycle.periodStartAt && cycle.periodEndAt ? periodLabelsWithin(cycle.periodStartAt, cycle.periodEndAt) : [];

        // The live plans carrying a library v1 procedure. Bounded by the
        // tenant's plans with an automation config; a handful in practice.
        const planRows = await db.controlTestPlan.findMany({
            where: { tenantId: ctx.tenantId, deletedAt: null, automationConfig: { not: Prisma.AnyNull } },
            select: { controlId: true, automationConfig: true },
            take: 5000,
        });
        const plans: ReliancePlan[] = [];
        for (const row of planRows) {
            const parsed = parseAuditProcedureConfig(row.automationConfig);
            if (parsed.kind === 'OK') plans.push({ procedureId: parsed.config.procedure, controlId: row.controlId });
        }

        const workpaperRows = labels.length
            ? await db.auditWorkpaper.findMany({
                  where: {
                      tenantId: ctx.tenantId,
                      procedureId: { in: [...LIBRARY_V1_PROCEDURE_IDS] },
                      periodLabel: { in: labels },
                  },
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                  // One past the cap, so a truncated read is a fact the plan holds.
                  take: RELIANCE_WORKPAPER_CAP + 1,
                  select: {
                      id: true,
                      procedureId: true,
                      catalogueVersion: true,
                      periodLabel: true,
                      populationCount: true,
                      populationDigest: true,
                      sampleSize: true,
                      exceptionCount: true,
                      conclusion: true,
                      conclusionBasis: true,
                      createdAt: true,
                      controlTestRunId: true,
                      sampleReviews: {
                          select: {
                              outcome: true,
                              unassignedReason: true,
                              dissentCodes: true,
                              samplePercent: true,
                              samplingEpoch: true,
                              seedFingerprint: true,
                              sampledAt: true,
                              reviewedAt: true,
                          },
                          take: 1,
                      },
                  },
              })
            : [];

        const runIds = [...new Set(workpaperRows.map((w) => w.controlTestRunId))];
        const runs = runIds.length
            ? await db.controlTestRun.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: runIds } },
                  select: { id: true, controlId: true },
                  take: runIds.length,
              })
            : [];
        const runControl = new Map(runs.map((r) => [r.id, r.controlId] as const));

        const controlIds = [...new Set([...plans.map((p) => p.controlId), ...runs.map((r) => r.controlId)])];
        const controlRows = controlIds.length
            ? await db.control.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: controlIds }, deletedAt: null },
                  select: {
                      id: true,
                      code: true,
                      annexId: true,
                      name: true,
                      status: true,
                      requirementLinks: { select: { requirement: { select: { code: true } } } },
                  },
                  take: controlIds.length,
              })
            : [];
        const controls = new Map<string, RelianceControl>(
            controlRows.map((c) => [
                c.id,
                {
                    id: c.id,
                    code: c.code,
                    annexId: c.annexId,
                    name: c.name,
                    status: c.status,
                    mappedRequirementCodes: [...new Set(c.requirementLinks.map((l) => l.requirement.code))],
                },
            ]),
        );

        const workpapers: RelianceWorkpaper[] = workpaperRows.map((w) => {
            const review = w.sampleReviews[0] ?? null;
            return {
                id: w.id,
                procedureId: w.procedureId,
                catalogueVersion: w.catalogueVersion,
                periodLabel: w.periodLabel,
                populationCount: w.populationCount,
                populationDigest: w.populationDigest,
                sampleSize: w.sampleSize,
                exceptionCount: w.exceptionCount,
                conclusion: w.conclusion,
                conclusionBasis: w.conclusionBasis,
                createdAt: w.createdAt,
                runControlId: runControl.get(w.controlTestRunId) ?? null,
                review: review
                    ? {
                          outcome: review.outcome,
                          unassignedReason: review.unassignedReason,
                          dissentCodes: review.dissentCodes,
                          samplePercent: review.samplePercent,
                          samplingEpoch: review.samplingEpoch,
                          seedFingerprint: review.seedFingerprint,
                          sampledAt: review.sampledAt,
                          reviewedAt: review.reviewedAt,
                      }
                    : null,
            };
        });

        return { cycle, plans, controls, workpapers };
    });

    const plan = planReliancePack(read);
    if (plan.kind === 'REFUSED') {
        await recordRefusal(ctx, { cycleId: read.cycle.id, reason: plan.reason, refs: plan.detail });
        throw new ConflictError(refusalMessage(plan.reason), { reason: plan.reason, detail: plan.detail });
    }

    const name = (opts.name?.trim() || `${DEFAULT_NAME_PREFIX}: ${read.cycle.name}`).slice(0, NAME_MAX);
    // Named members, so every value the audit row carries is one the
    // prompt-logging rule can read by name: counts and codes, nothing else.
    const counts = {
        controls: plan.items.filter((i) => i.entityType === 'CONTROL').length,
        workpapers: plan.summary.agreement.workpapers,
        concluded: plan.summary.agreement.concluded,
    };

    const packId = await runInTenantContext(ctx, async (db) => {
        const pack = await db.auditPack.create({
            data: {
                tenantId: ctx.tenantId,
                auditCycleId,
                name,
                notes:
                    'Agent-audit reliance pack (#3681): assembled and frozen in one step from the auditor ' +
                    'agent’s workpapers and internal audit’s sampling records.',
            },
            select: { id: true },
        });
        await db.auditPackItem.createMany({
            data: plan.items.map((item, index) => ({
                tenantId: ctx.tenantId,
                auditPackId: pack.id,
                entityType: item.entityType,
                entityId: item.entityId,
                snapshotJson: JSON.stringify({ ...item.snapshot, snapshotAt: new Date().toISOString() }),
                sortOrder: index,
            })),
        });
        await logEvent(db, ctx, {
            action: 'AGENT_AUDIT_RELIANCE_PACK_ASSEMBLED',
            entityType: 'AuditPack',
            entityId: pack.id,
            details: `Agent-audit reliance pack assembled for cycle ${read.cycle.id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditPack',
                operation: 'created',
                after: {
                    auditCycleId: read.cycle.id,
                    controls: counts.controls,
                    workpapers: counts.workpapers,
                    concluded: counts.concluded,
                    limits: [...plan.summary.limits],
                },
                summary: `Agent-audit reliance pack: ${counts.controls} control(s), ${counts.workpapers} workpaper(s)`,
            },
        });
        return pack.id;
    });

    await freezeAuditPack(ctx, packId);

    return { packId, status: 'FROZEN', controls: counts.controls, workpapers: counts.workpapers, summary: plan.summary };
}

const REFUSAL_MESSAGES: Record<RelianceRefusal, string> = {
    CYCLE_PERIOD_REQUIRED: 'The audit cycle has no period, so no workpaper can be said to fall inside it.',
    NO_PERIOD_IN_CYCLE: 'The audit cycle’s period contains no whole month or quarter.',
    NO_CONTROLS_IN_SCOPE: 'No library v1 procedure is configured on a control, and none ran in the period.',
    NO_WORKPAPERS_IN_PERIOD:
        'No workpaper of a library v1 procedure falls inside the cycle’s period; a pack over none would evidence nothing.',
    TOO_MANY_WORKPAPERS: `More than ${RELIANCE_WORKPAPER_CAP} workpapers fall inside the period; narrow the cycle.`,
    WORKPAPER_CONTROL_UNRESOLVED:
        'A workpaper in the period cannot be attributed to a control: its test run is gone and its procedure is not on exactly one live plan.',
};

function refusalMessage(reason: RelianceRefusal): string {
    return REFUSAL_MESSAGES[reason];
}

async function recordRefusal(
    ctx: RequestContext,
    refusal: { readonly cycleId: string; readonly reason: RelianceRefusal; readonly refs: readonly string[] },
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'AGENT_AUDIT_RELIANCE_PACK_REFUSED',
            entityType: 'AuditCycle',
            entityId: refusal.cycleId,
            details: `Agent-audit reliance pack refused: ${refusal.reason}`,
            detailsJson: {
                category: 'custom',
                event: 'agent_audit_reliance_pack_refused',
                reason: refusal.reason,
                // `detail` is a string in the audit schema; the named rows go
                // beside it, capped so one refusal cannot write a huge row.
                refusedRefs: refusal.refs.slice(0, 50),
            },
        }),
    );
}
