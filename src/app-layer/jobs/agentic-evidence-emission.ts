/**
 * agentic-evidence-emission — the scheduled pass that turns records into
 * artefacts.
 *
 * "ASI coverage is evidenced AUTOMATICALLY, not assembled by hand before an
 * audit" is the claim this job makes true. Without it,
 * `emitAgenticEvidence` is a function somebody has to remember to call, which is
 * the spreadsheet again with a nicer interface.
 *
 * ── THE TENANT SET IS THE PRECISE ONE ──────────────────────────────────────
 *
 * Tenants with at least one live control linked to a target requirement. Not
 * "every tenant" (most have no agentic controls, and an artefact attached to
 * nothing is not evidence), and not "tenants with agents" (a tenant can register
 * an agent and install no controls, and a tenant can install the ASI pack before
 * its first agent — the second is the one that would silently emit nothing).
 *
 * ── WHY IT IS SAFE TO RUN EVERY DAY ────────────────────────────────────────
 *
 * The artefact identity is `(tenant, control, kind, period)`, so a daily tick
 * inside one month rewrites the same rows. A month with no new records produces
 * `unchanged` and moves only the liveness stamp. See
 * `src/lib/agentic/evidence-artefact.ts` for the full argument.
 *
 * The withdrawal sweep runs in the same pass because it is the same question
 * asked the other way round: emission asks "which controls should have evidence
 * this month", withdrawal asks "which artefacts have lost the control they were
 * about". Splitting them into two jobs would let one run without the other and
 * leave a control's evidence page telling two different stories.
 */
import crypto from 'crypto';

import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { buildDelegatedJobContext } from '../context-system';
import {
    emitAgenticEvidence,
    withdrawStaleAgenticEvidence,
} from '../usecases/agentic-evidence-emission';
import { EVIDENCE_TARGETS } from '@/lib/agentic/evidence-artefact';
import { frameworkFamilyId } from '../domain/framework-representation';
import type { AgenticEvidenceEmissionPayload, JobRunResult } from './types';

/** The framework catalogue is a small global table. */
const FRAMEWORK_CATALOGUE_CAP = 500;
/** Bound on the tenants one pass may sweep. */
const TENANT_CAP = 5_000;

/**
 * The tenants that can receive an artefact: those holding a live control linked
 * to one of the target requirements.
 *
 * Resolved through the framework FAMILY for the reason the usecase gives — both
 * representations of a framework carry the same `sourceUrn`, and a single-key
 * lookup would skip every tenant whose controls hang off the other one.
 */
async function tenantsWithAgenticControls(): Promise<string[]> {
    const catalogue = await prisma.framework.findMany({
        select: { id: true, key: true, sourceUrn: true },
        take: FRAMEWORK_CATALOGUE_CAP,
    });

    const clauses = EVIDENCE_TARGETS.flatMap((target) => {
        const frameworkIds = catalogue
            .filter(
                (f) =>
                    frameworkFamilyId(f) === target.familyUrn ||
                    target.legacyKeys.includes(f.key),
            )
            .map((f) => f.id);
        return frameworkIds.length === 0
            ? []
            : [{ frameworkId: { in: frameworkIds }, code: target.requirementCode }];
    });
    if (clauses.length === 0) return [];

    const requirements = await prisma.frameworkRequirement.findMany({
        where: { OR: clauses, deprecatedAt: null },
        select: { id: true },
    });
    if (requirements.length === 0) return [];

    const links = await prisma.controlRequirementLink.findMany({
        where: {
            requirementId: { in: requirements.map((r) => r.id) },
            control: { deletedAt: null },
        },
        select: { tenantId: true },
        distinct: ['tenantId'],
        take: TENANT_CAP,
    });
    return links.map((l) => l.tenantId);
}

/**
 * A real `User.id` to own the emitted `Evidence` — its foreign key requires one.
 * The most senior longest-standing active member, matching the kill-switch
 * drill's `resolveDrillActor`.
 */
async function resolveEmissionActor(tenantId: string): Promise<string | null> {
    const member = await prisma.tenantMembership.findFirst({
        where: { tenantId, status: 'ACTIVE' },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: { userId: true },
    });
    return member?.userId ?? null;
}

export interface EmissionSweepResult {
    tenants: number;
    created: number;
    updated: number;
    unchanged: number;
    withdrawn: number;
    /** Tenants that could not be emitted for — reported, never silently dropped. */
    skipped: number;
}

export async function runAgenticEvidenceEmission(
    payload: AgenticEvidenceEmissionPayload,
    jobRunId: string,
): Promise<EmissionSweepResult> {
    const tenantIds = payload.tenantId
        ? [payload.tenantId]
        : await tenantsWithAgenticControls();

    const result: EmissionSweepResult = {
        tenants: tenantIds.length,
        created: 0,
        updated: 0,
        unchanged: 0,
        withdrawn: 0,
        skipped: 0,
    };

    for (const tenantId of tenantIds) {
        const actor = await resolveEmissionActor(tenantId);
        if (!actor) {
            // Nothing to attribute the evidence to. Counted as skipped rather
            // than swallowed: a tenant with no active member is a real state and
            // a pass that reported success for it would claim evidence nobody
            // can find.
            logger.warn('agentic: no member to attribute emitted evidence to', {
                tenantId,
                jobRunId,
            });
            result.skipped += 1;
            continue;
        }

        const ctx = buildDelegatedJobContext({
            tenantId,
            job: 'agentic-evidence-emission',
            onBehalfOf: actor,
            requestId: jobRunId,
        });

        try {
            const report = await emitAgenticEvidence(ctx, payload.asOf ? { asOf: new Date(payload.asOf) } : {});
            for (const artefact of report.artefacts) {
                if (artefact.outcome === 'created') result.created += 1;
                else if (artefact.outcome === 'updated') result.updated += 1;
                else if (artefact.outcome === 'unchanged') result.unchanged += 1;
            }
            result.withdrawn += (await withdrawStaleAgenticEvidence(ctx)).length;
        } catch (err) {
            // One tenant's failure never aborts the sweep. Counted, logged, and
            // retried by tomorrow's tick — the artefact identity makes a partial
            // pass safe to repeat.
            result.skipped += 1;
            logger.error('agentic: evidence emission failed for a tenant', {
                tenantId,
                jobRunId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return result;
}

/** BullMQ executor body. */
export async function runAgenticEvidenceEmissionJob(
    payload: AgenticEvidenceEmissionPayload,
): Promise<JobRunResult> {
    return runJob('agentic-evidence-emission', async () => {
        const jobRunId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const r = await runAgenticEvidenceEmission(payload, jobRunId);
        return {
            jobName: 'agentic-evidence-emission',
            jobRunId,
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: r.tenants,
            itemsActioned: r.created + r.updated,
            itemsSkipped: r.skipped,
            details: {
                created: r.created,
                updated: r.updated,
                unchanged: r.unchanged,
                withdrawn: r.withdrawn,
            },
        };
    }, { tenantId: payload.tenantId });
}
