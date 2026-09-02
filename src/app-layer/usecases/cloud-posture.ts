/**
 * cloud-posture collection (PR-3) — the cloud-agnostic collector.
 *
 * Generalizes `aws-posture.ts`: run one tenant connection's benchmark, record
 * ONE IntegrationExecution, and turn each mapped PASSING benchmark control into
 * rolling auto-collected Evidence (scanner-ingestion pattern). Azure + GCP pass
 * their provider + control map; a 4th cloud is incremental.
 *
 * Runs entirely inside `runInTenantContext` — tenant-scoped, RLS-bound, no
 * global prisma. resultJson is the provider's BOUNDED summary (counts +
 * per-control status, size-capped, creds scrubbed) — never raw resources.
 */
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context-system';
import { runInTenantContext } from '@/lib/db-context';
import { markAuthFailure, clearAuthFailure } from '../integrations/connection-health';
import { shouldBypassQueueRetry } from '../integrations/http-resilience';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import type { ScheduledCheckProvider } from '../integrations/types';
import { frameworkCodesForControl, type CloudPostureControlMapEntry } from '../integrations/cloud-posture/powerpipe-core';

const EVIDENCE_FRESHNESS_DAYS = 30;

function makeSystemCtx(tenantId: string, cloud: string): RequestContext {
    return buildSystemContext({ tenantId, job: `${cloud}-posture` });
}

export interface CloudPostureCollectResult {
    executionId: string;
    status: 'PASSED' | 'FAILED' | 'ERROR' | 'NOT_APPLICABLE';
    /**
     * True when the queue must NOT immediately re-run this collection —
     * a revoked credential, or a throttle past the absorb budget.
     */
    noRetry?: boolean;
    counts: { ok: number; alarm: number; skip: number; error: number; total: number } | null;
    evidenceCreated: number;
    errorMessage?: string;
}

export interface CloudPostureCollectInput {
    /** Provider prefix / connection provider, e.g. 'azure-posture'. */
    cloud: string;
    tenantId: string;
    connectionId: string;
    /** The registered ScheduledCheckProvider for this cloud. */
    provider: Pick<ScheduledCheckProvider, 'runCheck'>;
    /** Cloud → IC framework control crosswalk. */
    controlMap: Record<string, CloudPostureControlMapEntry>;
    now?: Date;
}

export async function runCloudPostureCollection(input: CloudPostureCollectInput): Promise<CloudPostureCollectResult> {
    const ctx = makeSystemCtx(input.tenantId, input.cloud);
    const now = input.now ?? new Date();

    return runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: input.connectionId, tenantId: ctx.tenantId, provider: input.cloud },
            select: { id: true, configJson: true, secretEncrypted: true },
        });
        if (!conn) {
            const execution = await db.integrationExecution.create({
                data: { tenantId: ctx.tenantId, provider: input.cloud, automationKey: `${input.cloud}.unknown`, status: 'ERROR', errorMessage: 'Connection not found', triggeredBy: 'scheduled', completedAt: now },
            });
            return { executionId: execution.id, status: 'ERROR', counts: null, evidenceCreated: 0, errorMessage: 'Connection not found' };
        }

        const config = (conn.configJson ?? {}) as Record<string, unknown>;
        const check = String(config.benchmark ?? 'soc2').toLowerCase();
        const automationKey = `${input.cloud}.${check}`;
        const secrets: Record<string, unknown> = conn.secretEncrypted ? (JSON.parse(decryptField(conn.secretEncrypted)) as Record<string, unknown>) : {};

        const execution = await db.integrationExecution.create({
            data: { tenantId: ctx.tenantId, connectionId: conn.id, provider: input.cloud, automationKey, status: 'RUNNING', triggeredBy: 'scheduled', executedAt: now },
        });

        const start = Date.now();
        let checkResult;
        try {
            checkResult = await input.provider.runCheck({
                automationKey,
                parsed: { provider: input.cloud, checkType: check, raw: automationKey },
                tenantId: ctx.tenantId,
                connectionConfig: { ...config, ...secrets },
                triggeredBy: 'scheduled',
            });
        } catch (e) {
            const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
            await db.integrationExecution.update({ where: { id: execution.id }, data: { status: 'ERROR', errorMessage: msg, durationMs: Date.now() - start, completedAt: new Date() } });
            // Surface a REVOKED CREDENTIAL on the connection; no-op for
            // anything that is not an IntegrationAuthError (401/403).
            await markAuthFailure(db, conn.id, e, now, input.cloud);
            // Caught here, so the retry classification must ride the result.
            return { executionId: execution.id, status: 'ERROR', counts: null, evidenceCreated: 0, errorMessage: msg, noRetry: shouldBypassQueueRetry(e) };
        }

        const summary = checkResult.details as { counts?: CloudPostureCollectResult['counts']; controls?: Array<{ id: string; status: string }> };
        const counts = summary.counts ?? null;
        const controls = summary.controls ?? [];

        let evidenceCreated = 0;
        let firstEvidenceId: string | null = null;
        if (checkResult.status !== 'ERROR') {
            for (const c of controls) { // guardrail-allow: n+1 — per-control resolve + rolling-evidence upsert, bounded by mapped set
                if (c.status !== 'ok') continue; // pass-only evidence; alarms are a gap signal
                const seenControlIds = new Set<string>();
                for (const { frameworkKey, codes } of frameworkCodesForControl(input.controlMap, c.id)) { // guardrail-allow: n+1
                    const link = await db.controlRequirementLink.findFirst({
                        where: { tenantId: ctx.tenantId, requirement: { framework: { key: frameworkKey }, code: { in: codes } } },
                        select: { controlId: true },
                    });
                    if (!link?.controlId || seenControlIds.has(link.controlId)) continue;
                    const controlId = link.controlId;
                    seenControlIds.add(controlId);
                    const category = `${input.cloud}:${c.id}`;
                    const nextReviewDate = new Date(now.getTime() + EVIDENCE_FRESHNESS_DAYS * 86_400_000);
                    const content = `${input.cloud} check "${c.id}" PASSED (${automationKey}) on ${now.toISOString().slice(0, 10)}. Machine-collected via Powerpipe; execution ${execution.id}.`;
                    const existing = await db.evidence.findFirst({
                        where: { tenantId: ctx.tenantId, evidenceControlLinks: { some: { controlId } }, category, type: 'TEXT', isArchived: false, deletedAt: null },
                        select: { id: true },
                    });
                    if (existing) {
                        const ev = await db.evidence.update({ where: { id: existing.id }, data: { title: `Automated evidence — ${c.id}`, content, dateCollected: now, nextReviewDate, status: 'APPROVED' } });
                        firstEvidenceId = firstEvidenceId ?? ev.id;
                    } else {
                        const ev = await db.evidence.create({ data: { tenantId: ctx.tenantId, type: 'TEXT', title: `Automated evidence — ${c.id}`, content, category, dateCollected: now, reviewCycle: 'MONTHLY', nextReviewDate, status: 'APPROVED' } });
                        await db.evidenceControlLink.create({ data: { tenantId: ctx.tenantId, evidenceId: ev.id, controlId, createdByUserId: null } });
                        firstEvidenceId = firstEvidenceId ?? ev.id;
                        try {
                            await db.controlEvidenceLink.create({ data: { tenantId: ctx.tenantId, controlId, kind: 'INTEGRATION_RESULT', integrationResultId: execution.id, note: `${input.cloud}: ${c.id}` } });
                        } catch { /* duplicate link acceptable */ }
                    }
                    evidenceCreated += 1;
                }
            }
        }

        await db.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: checkResult.status,
                resultJson: summary as unknown as object,
                evidenceId: firstEvidenceId,
                errorMessage: checkResult.errorMessage ? checkResult.errorMessage.slice(0, 500) : null,
                durationMs: Date.now() - start,
                completedAt: new Date(),
            },
        });

        // Reached only when the collection itself ran. A FAILED compliance
        // verdict is a successful collection reporting a real gap, so the
        // credential is demonstrably good either way — clear any stale banner.
        //
        // ERROR is the case that must NOT clear, and that distinction is the
        // whole point of the line. PASSED and FAILED are each proof the
        // credential worked; an ERROR means the collector never observed the
        // account, so clearing on it retracts a revoked-credential banner on no
        // evidence at all. A provider that exits non-zero with an
        // expired-token stderr now throws and never reaches here — but one that
        // fails another way (zero controls parsed, unreadable JSON) does reach
        // here, and a still-revoked connection was being declared healthy.
        // Deliberately NOT `status === 'PASSED'`: that clamp would strand the
        // banner on a healthy connection whose benchmark keeps reporting gaps.
        if (checkResult.status !== 'ERROR') {
            await clearAuthFailure(db, conn.id, input.cloud);
        }

        logger.info('cloud-posture collection complete', { component: 'cloud-posture', cloud: input.cloud, tenantId: ctx.tenantId, executionId: execution.id, status: checkResult.status, evidenceCreated });
        return { executionId: execution.id, status: checkResult.status, counts, evidenceCreated, errorMessage: checkResult.errorMessage };
    });
}
