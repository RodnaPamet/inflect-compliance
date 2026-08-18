/**
 * hris-sync (PR-4) — sync an HRIS roster (BambooHR) into Employee.
 *
 * Idempotent by (tenantId, workEmail). Two passes: upsert every employee,
 * then resolve managerEmail → managerEmployeeId (map workEmail → id). Records
 * ONE IntegrationExecution. Tenant-scoped (runInTenantContext, no global
 * prisma). Mirrors identity-sync.
 */
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context-system';
import { runInTenantContext } from '@/lib/db-context';
import { markAuthFailure, clearAuthFailure } from '../integrations/connection-health';
import { shouldBypassQueueRetry } from '../integrations/http-resilience';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { recordSyncTruncated } from '@/lib/observability/integration-metrics';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { registry } from '../integrations/registry';
import { isHrisSyncProvider, isHrisProviderId, type HrisSyncProvider, type NormalizedEmployee } from '../integrations/providers/hris';

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'hris-sync' });
}

export interface HrisSyncResult {
    executionId: string;
    /**
     * `PARTIAL` is a truncated-but-RESUMABLE pass: rows were upserted, a cursor
     * was stored, and the next scheduled run continues it. Deliberately not
     * `PASSED` — the pass has not finished and no departure reconcile has run,
     * so calling it passed would make a multi-run pass indistinguishable from a
     * completed one in exactly the logs someone would check to ask why an
     * employee still shows as active. Mirrors IdentitySyncResult.
     */
    status: 'PASSED' | 'ERROR' | 'PARTIAL';
    /**
     * True when the queue must NOT immediately re-run this sync. Set for a
     * revoked credential, a throttle past the absorb budget, and a truncated
     * roster — all cases where retrying repeats identical work.
     */
    noRetry?: boolean;
    upserted: number;
    managersLinked: number;
    errorMessage?: string;
}

export async function runHrisSync(input: {
    tenantId: string;
    connectionId: string;
    now?: Date;
    provider?: HrisSyncProvider;
}): Promise<HrisSyncResult> {
    const ctx = makeSystemCtx(input.tenantId);
    const now = input.now ?? new Date();

    return runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: input.connectionId, tenantId: ctx.tenantId },
            select: { id: true, provider: true, configJson: true, secretEncrypted: true, syncCursor: true, syncPassStartedAt: true },
        });
        if (!conn || !isHrisProviderId(conn.provider)) {
            const execution = await db.integrationExecution.create({
                data: { tenantId: ctx.tenantId, provider: conn?.provider ?? 'hris', automationKey: 'hris.sync', status: 'ERROR', errorMessage: 'HRIS connection not found', triggeredBy: 'scheduled', completedAt: now },
            });
            return { executionId: execution.id, status: 'ERROR', upserted: 0, managersLinked: 0, errorMessage: 'HRIS connection not found' };
        }

        const config = (conn.configJson ?? {}) as Record<string, unknown>;
        const secrets: Record<string, unknown> = conn.secretEncrypted ? (JSON.parse(decryptField(conn.secretEncrypted)) as Record<string, unknown>) : {};
        const execution = await db.integrationExecution.create({
            data: { tenantId: ctx.tenantId, connectionId: conn.id, provider: conn.provider, automationKey: `${conn.provider}.sync`, status: 'RUNNING', triggeredBy: 'scheduled', executedAt: now },
        });

        const resolved = input.provider ?? registry.getProvider(conn.provider);
        if (!resolved || !isHrisSyncProvider(resolved)) {
            await db.integrationExecution.update({ where: { id: execution.id }, data: { status: 'ERROR', errorMessage: 'Provider does not support HRIS sync', completedAt: new Date() } });
            return { executionId: execution.id, status: 'ERROR', upserted: 0, managersLinked: 0, errorMessage: 'Provider does not support HRIS sync' };
        }

        const start = Date.now();
        let roster: NormalizedEmployee[];
        let complete: boolean;
        let resumeToken: string | null = null;
        // The pass this run belongs to. A stored syncPassStartedAt means an
        // earlier run of the SAME pass is still in flight; only a fresh pass
        // starts the clock now. This is the value the reconcile compares
        // against, so getting it from the connection rather than from `now` is
        // what makes a multi-run pass reconcile correctly.
        const passStartedAt = conn.syncPassStartedAt ?? now;
        try {
            const res = await resolved.listEmployees({ ...config, ...secrets }, conn.syncCursor);
            roster = res.employees;
            complete = res.complete;
            resumeToken = res.resumeToken ?? null;
        } catch (e) {
            const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
            await db.integrationExecution.update({ where: { id: execution.id }, data: { status: 'ERROR', errorMessage: msg, durationMs: Date.now() - start, completedAt: new Date() } });
            // Surface a REVOKED CREDENTIAL on the connection itself; no-op for
            // anything that is not an IntegrationAuthError (401/403).
            await markAuthFailure(db, conn.id, e, now, conn.provider);
            // This usecase CATCHES the provider error, so the classification has
            // to ride the result or the queue-level bypass never sees it.
            return { executionId: execution.id, status: 'ERROR', upserted: 0, managersLinked: 0, errorMessage: msg, noRetry: shouldBypassQueueRetry(e) };
        }

        // Pass 1 — upsert each employee (no manager yet).
        let upserted = 0;
        for (const e of roster) { // guardrail-allow: n+1 — per-employee upsert, bounded by MAX_EMPLOYEES
            if (!e.workEmail) continue;
            await db.employee.upsert({
                where: { tenantId_workEmail: { tenantId: ctx.tenantId, workEmail: e.workEmail } },
                create: { tenantId: ctx.tenantId, externalId: e.externalId, fullName: e.fullName, workEmail: e.workEmail, status: e.status, department: e.department ?? null, jobTitle: e.jobTitle ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null, source: 'HRIS', syncedAt: now },
                update: { externalId: e.externalId, fullName: e.fullName, status: e.status, department: e.department ?? null, jobTitle: e.jobTitle ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null, source: 'HRIS', syncedAt: now },
            });
            upserted += 1;
        }

        // Pass 2 — resolve managers by email (one query, in-memory map — no N+1).
        const emailToId = new Map<string, string>();
        const all = await db.employee.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, workEmail: true }, take: 10000 });
        for (const r of all) emailToId.set(r.workEmail.toLowerCase(), r.id);
        let managersLinked = 0;
        for (const e of roster) { // guardrail-allow: n+1 — bounded manager-link update
            if (!e.managerEmail) continue;
            const managerId = emailToId.get(e.managerEmail.toLowerCase());
            const selfId = emailToId.get(e.workEmail.toLowerCase());
            if (!managerId || !selfId || managerId === selfId) continue;
            await db.employee.update({ where: { id: selfId }, data: { managerEmployeeId: managerId } });
            managersLinked += 1;
        }

        // H3 — a truncated roster must not report a green PASSED and must NOT
        // drive the departure reconcile (unseen employees would be wrongly
        // terminated). Upsert what we saw, skip departures, fail loudly.
        if (!complete) {
            recordSyncTruncated({ provider: conn.provider }); // H6 — alertable truncation signal

            if (resumeToken) {
                // RESUMABLE — progress, not failure. HRIS only ever had the
                // branch below, so a roster past MAX_EMPLOYEES was a PERMANENT
                // `ERROR, noRetry: true`: for any customer large enough to
                // exceed the cap the provider could never succeed, on any run,
                // ever. identity-sync solved this (H3-2); HRIS never got the
                // second branch.
                //
                // Upsert what we saw, store the cursor, and let the next
                // scheduled run continue until the pass completes and
                // reconciles. Reporting ERROR here would page someone nightly
                // for a large roster working exactly as designed.
                await db.integrationConnection.updateMany({
                    where: { id: conn.id },
                    data: { syncCursor: resumeToken, syncPassStartedAt: passStartedAt },
                });
                const msg = `Partial HRIS roster (${roster.length} employees this run); pass continues from the stored cursor on the next run.`;
                await db.integrationExecution.update({
                    where: { id: execution.id },
                    data: {
                        status: 'PASSED',
                        errorMessage: null,
                        resultJson: { upserted, managersLinked, departed: 0, total: roster.length, partial: true, resuming: true },
                        durationMs: Date.now() - start,
                        completedAt: new Date(),
                    },
                });
                logger.info('hris-sync partial — cursor stored, pass continues', {
                    component: 'hris-sync',
                    tenantId: ctx.tenantId,
                    provider: conn.provider,
                    executionId: execution.id,
                    upserted,
                    passStartedAt,
                });
                await clearAuthFailure(db, conn.id, conn.provider);
                return { executionId: execution.id, status: 'PARTIAL', upserted, managersLinked, errorMessage: msg };
            }

            // NOT resumable — unchanged behaviour. Loud and non-retryable,
            // because re-reading truncates at the same place.
            const msg = `Partial HRIS roster: hit the ${roster.length}-employee cap with more rows available, and this provider cannot resume. Departure reconcile skipped.`;
            await db.integrationExecution.update({
                where: { id: execution.id },
                data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, managersLinked, total: roster.length, truncated: true }, durationMs: Date.now() - start, completedAt: new Date() },
            });
            logger.warn('hris-sync partial roster — departure reconcile skipped', { component: 'hris-sync', tenantId: ctx.tenantId, executionId: execution.id, upserted });
            // Loud, but NOT retryable: the cap is deterministic, so a retry
            // re-reads the same too-large roster and truncates identically.
            return { executionId: execution.id, status: 'ERROR', upserted, managersLinked, errorMessage: msg, noRetry: true };
        }

        // H3 — departed-employee reconcile: a source=HRIS employee absent from a
        // COMPLETE roster was DELETED in BambooHR (not just terminated) and would
        // otherwise stay ACTIVE forever, invisible to offboarding. Mark them
        // TERMINATED. Guarded on a non-empty roster so an empty-but-complete
        // response (likely an API glitch) never mass-terminates.
        //
        // Reconciles on `syncedAt < passStartedAt`, NOT `workEmail: { notIn:
        // seenEmails }`. That was correct only while a pass was a single run.
        // Under resume `roster` holds just the LAST run's slice, so a notIn
        // reconcile would terminate every employee upserted by every earlier
        // run of the same pass — the wrongful-mass-termination failure this
        // whole area exists to prevent, introduced BY the resume feature.
        //
        // Anything not touched since the pass BEGAN was absent from the roster
        // across every run of that pass, so it is genuinely gone. The whole
        // callback is one RLS transaction, so upsert + reconcile commit
        // atomically.
        let departed = 0;
        if (roster.length > 0) {
            const res = await db.employee.updateMany({
                where: { tenantId: ctx.tenantId, source: 'HRIS', status: { not: 'TERMINATED' }, syncedAt: { lt: passStartedAt } },
                data: { status: 'TERMINATED', syncedAt: now },
            });
            departed = res.count;
        }

        // The pass is done — clear the cursor so the next run starts fresh.
        // Left set, the next run would resume a pass that already reconciled.
        await db.integrationConnection.updateMany({
            where: { id: conn.id },
            data: { syncCursor: null, syncPassStartedAt: null },
        });

        await db.integrationExecution.update({
            where: { id: execution.id },
            data: { status: 'PASSED', resultJson: { upserted, managersLinked, departed, total: roster.length }, durationMs: Date.now() - start, completedAt: new Date() },
        });
        logger.info('hris-sync complete', { component: 'hris-sync', tenantId: ctx.tenantId, executionId: execution.id, upserted, managersLinked, departed });
        // Clear unconditionally on success — a stale "credential revoked"
        // banner is worse than none, because it trains people to ignore it.
        await clearAuthFailure(db, conn.id, conn.provider);

        return { executionId: execution.id, status: 'PASSED', upserted, managersLinked };
    });
}
