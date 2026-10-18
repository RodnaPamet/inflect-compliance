/**
 * integration-passport-sweep — the weekly pass that keeps every external agent
 * connection's passport (#3672, `docs/integration-passport.md`).
 *
 * Sunday 05:45 UTC (see the schedule entry for the slot). Per tenant it builds
 * every `mcp-server` connection's passport from stored rows, compares it with
 * the last one emitted, raises a Finding for each difference the specification
 * calls drift, and emits the week's passports as Evidence on the supplier and
 * access controls. The work is `runIntegrationPassportSweep`; this file finds
 * the tenants, attributes the evidence, and counts.
 *
 * ── THE TENANT SET IS TWO POPULATIONS ───────────────────────────────────────
 *
 *   1. tenants holding an `mcp-server` connection, enabled or not — a disabled
 *      connection keeps its passport;
 *   2. tenants holding a passport artefact from the last five weeks.
 *
 * The second is what lets rule 4 of the specification fire for a tenant whose
 * LAST connection disappeared: discovered by connections alone, that tenant
 * would simply stop being swept, and a vanished connection would read as a
 * tenant that never had one. Both are DRAINED rather than `take`-capped — a
 * cap and a true total are indistinguishable at the boundary, and the tail is
 * other people's tenants going unswept under a green run.
 *
 * ── FAIL CLOSED, NEVER SILENTLY ─────────────────────────────────────────────
 *
 * Every tenant ends in a counted outcome, the ones that could not run
 * included (`NO_ACTOR`, `FAILED`), and a sweep that discovered nobody emits
 * `SWEPT_NOBODY` — the kill-switch drill's lesson, that a job which did nothing
 * must say so rather than return zeros a dashboard reads as calm.
 */
import crypto from 'crypto';

import { ARTEFACT_KIND_PASSPORTS, weeklyPeriod } from '@/lib/agentic/evidence-artefact';
import { recordIntegrationPassportSweep } from '@/lib/observability/integration-metrics';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { buildDelegatedJobContext } from '../context-system';
import { MCP_SERVER_PROVIDER_ID } from '../integrations/providers/mcp-server-provider';
import {
    runIntegrationPassportSweep,
    type PassportSweepOutcome,
} from '../usecases/integration-passport';
import { resolveEmissionActor } from './agentic-evidence-emission';
import { drainPages, DRAIN_PAGE_SIZE } from './drain-pages';
import type { IntegrationPassportSweepPayload, JobRunResult } from './types';

/** How far back a passport artefact still puts its tenant in the sweep. */
const RECENT_PASSPORT_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PassportSweepTenantOutcome = PassportSweepOutcome | 'NO_ACTOR' | 'FAILED';

export interface IntegrationPassportSweepTotals {
    readonly periodLabel: string;
    readonly tenants: number;
    readonly outcomes: Readonly<Partial<Record<PassportSweepTenantOutcome, number>>>;
    readonly findingsOpened: number;
    readonly findingsReopened: number;
    readonly findingsResolved: number;
    readonly findingsReassigned: number;
    readonly artefactsCreated: number;
    readonly artefactsUpdated: number;
    readonly artefactsUnchanged: number;
    /** Tenants that opened, reopened, resolved or reassigned a finding, or created or updated an artefact. */
    readonly actioned: number;
}

/** The tenants the sweep visits — see the header for why it is two populations. */
async function discoverTenants(periodStart: Date): Promise<string[]> {
    const connections = await drainPages((cursor) =>
        prisma.integrationConnection.findMany({
            where: { provider: MCP_SERVER_PROVIDER_ID },
            // Ids only. The read crosses tenants, so it carries nothing that
            // would matter if it were logged.
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );
    const since = new Date(periodStart.getTime() - RECENT_PASSPORT_DAYS * DAY_MS);
    const passports = await drainPages((cursor) =>
        prisma.agenticEvidenceArtefact.findMany({
            where: { kind: ARTEFACT_KIND_PASSPORTS, periodStart: { gte: since } },
            select: { id: true, tenantId: true },
            orderBy: { id: 'asc' },
            take: DRAIN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
    );
    return [...new Set([...connections, ...passports].map((r) => r.tenantId))].sort();
}

export async function runIntegrationPassportSweepForTenants(
    payload: IntegrationPassportSweepPayload,
    jobRunId: string,
): Promise<IntegrationPassportSweepTotals> {
    const asOf = payload.asOf ? new Date(payload.asOf) : new Date();
    if (Number.isNaN(asOf.getTime())) {
        // A payload that names no instant names no week. Refused rather than
        // read as "now", which would sweep a week the caller did not ask for.
        throw new Error(`integration-passport-sweep: asOf is not an ISO instant (${payload.asOf})`);
    }
    const period = weeklyPeriod(asOf);
    const thisWeek = weeklyPeriod(new Date());
    if (period.start.getTime() > thisWeek.start.getTime()) {
        // The passports are built from the rows as they are NOW, so a week
        // that has not begun would be evidenced with facts from before it —
        // and, once emitted, would make every pass for the current week a
        // pass for a superseded week, which the usecase refuses.
        throw new Error(
            `integration-passport-sweep: asOf names ${period.label}, which has not begun (this is ${thisWeek.label})`,
        );
    }
    const tenantIds = payload.tenantId ? [payload.tenantId] : await discoverTenants(period.start);

    const outcomes: Partial<Record<PassportSweepTenantOutcome, number>> = {};
    const count = (o: PassportSweepTenantOutcome) => {
        outcomes[o] = (outcomes[o] ?? 0) + 1;
        recordIntegrationPassportSweep({ outcome: o });
    };
    let findingsOpened = 0;
    let findingsReopened = 0;
    let findingsResolved = 0;
    let findingsReassigned = 0;
    let artefactsCreated = 0;
    let artefactsUpdated = 0;
    let artefactsUnchanged = 0;
    let actioned = 0;

    if (tenantIds.length === 0) {
        logger.warn('agentic: integration-passport sweep discovered ZERO tenants — nothing was swept', {
            jobRunId,
            period: period.label,
        });
        recordIntegrationPassportSweep({ outcome: 'SWEPT_NOBODY' });
    }

    for (const tenantId of tenantIds) {
        const actor = await resolveEmissionActor(tenantId);
        if (!actor) {
            // Nobody to attribute the evidence to: `Evidence.ownerUserId` and a
            // delegated context both need a real user. Counted and logged — a
            // pass that reported success here would claim evidence nobody can
            // find.
            logger.warn('agentic: integration passport has no member to attribute its evidence to', {
                tenantId,
                jobRunId,
            });
            count('NO_ACTOR');
            continue;
        }
        const ctx = buildDelegatedJobContext({
            tenantId,
            job: 'integration-passport-sweep',
            onBehalfOf: actor,
            requestId: jobRunId,
        });
        try {
            const r = await runIntegrationPassportSweep(ctx, { asOf, actorUserId: actor });
            count(r.outcome);
            findingsOpened += r.findingsOpened;
            findingsReopened += r.findingsReopened;
            findingsResolved += r.findingsResolved;
            findingsReassigned += r.findingsReassigned;
            const created = r.artefacts.filter((a) => a.outcome === 'created').length;
            const updated = r.artefacts.filter((a) => a.outcome === 'updated').length;
            artefactsCreated += created;
            artefactsUpdated += updated;
            artefactsUnchanged += r.artefacts.filter((a) => a.outcome === 'unchanged').length;
            if (r.findingsOpened + r.findingsReopened + r.findingsResolved + r.findingsReassigned + created + updated > 0) {
                actioned += 1;
            }
        } catch (err) {
            // One tenant's failure never aborts the sweep. The message only:
            // an error from this path can carry a row, and a log line is a
            // wider surface than the row.
            count('FAILED');
            logger.error('agentic: integration passport sweep failed for a tenant', {
                tenantId,
                jobRunId,
                period: period.label,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return {
        periodLabel: period.label,
        tenants: tenantIds.length,
        outcomes,
        findingsOpened,
        findingsReopened,
        findingsResolved,
        findingsReassigned,
        artefactsCreated,
        artefactsUpdated,
        artefactsUnchanged,
        actioned,
    };
}

/** BullMQ executor body. */
export async function runIntegrationPassportSweepJob(
    payload: IntegrationPassportSweepPayload,
): Promise<JobRunResult> {
    return runJob('integration-passport-sweep', async () => {
        const jobRunId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const r = await runIntegrationPassportSweepForTenants(payload, jobRunId);
        const failed = r.outcomes.FAILED ?? 0;
        return {
            jobName: 'integration-passport-sweep',
            jobRunId,
            // A failed TENANT fails the run, so the job's own record says so;
            // every other tenant was still swept. Drift raised is a finding about
            // the connections, not a broken job.
            success: failed === 0,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: r.tenants,
            itemsActioned: r.actioned,
            itemsSkipped: (r.outcomes.NO_ACTOR ?? 0) + failed + (r.outcomes.TRUNCATED ?? 0),
            // Counts only — results are kept in Redis, so no ids.
            details: {
                period: r.periodLabel,
                outcomes: r.outcomes,
                findingsOpened: r.findingsOpened,
                findingsReopened: r.findingsReopened,
                findingsResolved: r.findingsResolved,
                findingsReassigned: r.findingsReassigned,
                artefactsCreated: r.artefactsCreated,
                artefactsUpdated: r.artefactsUpdated,
                artefactsUnchanged: r.artefactsUnchanged,
            },
        };
    }, { tenantId: payload.tenantId });
}
