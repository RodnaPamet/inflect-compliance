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
import { isHrisSyncProvider, type HrisSyncProvider, type NormalizedEmployee } from '../integrations/providers/hris';

const HRIS_PROVIDERS = new Set(['bamboohr']);

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'hris-sync' });
}

export interface HrisSyncResult {
    executionId: string;
    status: 'PASSED' | 'ERROR';
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
            select: { id: true, provider: true, configJson: true, secretEncrypted: true },
        });
        if (!conn || !HRIS_PROVIDERS.has(conn.provider)) {
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
        try {
            const res = await resolved.listEmployees({ ...config, ...secrets });
            roster = res.employees;
            complete = res.complete;
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
            const msg = `Partial HRIS roster: hit the ${roster.length}-employee cap with more rows available. Departure reconcile skipped.`;
            await db.integrationExecution.update({
                where: { id: execution.id },
                data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, managersLinked, total: roster.length, truncated: true }, durationMs: Date.now() - start, completedAt: new Date() },
            });
            logger.warn('hris-sync partial roster — departure reconcile skipped', { component: 'hris-sync', tenantId: ctx.tenantId, executionId: execution.id, upserted });
            recordSyncTruncated({ provider: 'bamboohr' }); // H6 — alertable truncation signal
            // Loud, but NOT retryable: the cap is deterministic, so a retry
            // re-reads the same too-large roster and truncates identically.
            return { executionId: execution.id, status: 'ERROR', upserted, managersLinked, errorMessage: msg, noRetry: true };
        }

        // H3 — departed-employee reconcile: a source=HRIS employee absent from a
        // COMPLETE roster was DELETED in BambooHR (not just terminated) and would
        // otherwise stay ACTIVE forever, invisible to offboarding. Mark them
        // TERMINATED. Guarded on a non-empty roster so an empty-but-complete
        // response (likely an API glitch) never mass-terminates.
        let departed = 0;
        if (roster.length > 0) {
            const seenEmails = roster.map((e) => e.workEmail).filter(Boolean);
            const res = await db.employee.updateMany({
                where: { tenantId: ctx.tenantId, source: 'HRIS', status: { not: 'TERMINATED' }, workEmail: { notIn: seenEmails } },
                data: { status: 'TERMINATED', syncedAt: now },
            });
            departed = res.count;
        }

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
