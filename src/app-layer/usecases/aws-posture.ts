/**
 * aws-posture collection — run the AWS compliance benchmark for a tenant's
 * connection, record ONE IntegrationExecution, and turn each mapped PASSING
 * control into auto-collected Evidence (scanner-ingestion pattern).
 *
 * Reuses IC's existing seams: IntegrationConnection (provider 'aws-posture',
 * explicitly-encrypted secretEncrypted), IntegrationExecution (the execution
 * ledger), and the rolling-Evidence + ControlEvidenceLink path. Everything runs
 * inside `runInTenantContext` — tenant-scoped, RLS-bound, no global prisma.
 *
 * Auto-collected evidence is clearly machine-collected: category `aws-posture:*`,
 * status APPROVED, and a 30-day `nextReviewDate` so the existing stale-review
 * sweep flags it if collection stops. Failing/alarm controls are a gap signal
 * only — NO risks are auto-created (a follow-on can propose-not-commit).
 */
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context-system';
import { runInTenantContext } from '@/lib/db-context';
import { markAuthFailure, clearAuthFailure } from '../integrations/connection-health';
import { shouldBypassQueueRetry } from '../integrations/http-resilience';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import {
    AwsPostureProvider,
    scrubAwsCredentials,
    type AwsPostureSecrets,
    type AwsPostureConfig,
} from '../integrations/aws-posture-provider';
import { frameworkCodesForControl } from '@/data/integrations/aws-posture-control-map';

const AWS_POSTURE_PROVIDER = 'aws-posture';
const EVIDENCE_FRESHNESS_DAYS = 30;

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'aws-posture' });
}

export interface AwsPostureCollectResult {
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

/**
 * Run the tenant's aws-posture connection end-to-end. `connectionId` selects the
 * connection (must be provider 'aws-posture'); `now` is injectable for tests.
 */
export async function runAwsPostureCollection(input: {
    tenantId: string;
    connectionId: string;
    now?: Date;
    /** Test seam — inject a provider (or a fake) instead of the default CLI-backed one. */
    provider?: Pick<AwsPostureProvider, 'runCheck'>;
}): Promise<AwsPostureCollectResult> {
    const ctx = makeSystemCtx(input.tenantId);
    const now = input.now ?? new Date();
    const provider = input.provider ?? new AwsPostureProvider();

    return runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: input.connectionId, tenantId: ctx.tenantId, provider: AWS_POSTURE_PROVIDER },
            select: { id: true, configJson: true, secretEncrypted: true, isEnabled: true },
        });
        if (!conn) {
            const execution = await db.integrationExecution.create({
                data: { tenantId: ctx.tenantId, provider: AWS_POSTURE_PROVIDER, automationKey: 'aws-posture.unknown', status: 'ERROR', errorMessage: 'Connection not found', triggeredBy: 'scheduled', completedAt: now },
            });
            return { executionId: execution.id, status: 'ERROR', counts: null, evidenceCreated: 0, errorMessage: 'Connection not found' };
        }

        const config = (conn.configJson ?? {}) as AwsPostureConfig;
        const check = (config.benchmark ?? 'soc2').toLowerCase();
        const automationKey = `${AWS_POSTURE_PROVIDER}.${check}`;
        const secrets: AwsPostureSecrets = conn.secretEncrypted
            ? (JSON.parse(decryptField(conn.secretEncrypted)) as AwsPostureSecrets)
            : {};
        const secretVals = [secrets.accessKeyId, secrets.secretAccessKey, secrets.sessionToken, secrets.externalId].filter((v): v is string => !!v);

        const execution = await db.integrationExecution.create({
            data: { tenantId: ctx.tenantId, connectionId: conn.id, provider: AWS_POSTURE_PROVIDER, automationKey, status: 'RUNNING', triggeredBy: 'scheduled', executedAt: now },
        });

        const start = Date.now();
        let checkResult;
        try {
            checkResult = await provider.runCheck({
                automationKey,
                parsed: { provider: AWS_POSTURE_PROVIDER, checkType: check, raw: automationKey },
                tenantId: ctx.tenantId,
                connectionConfig: { ...config, ...secrets },
                triggeredBy: 'scheduled',
            });
        } catch (e) {
            const msg = scrubAwsCredentials(e instanceof Error ? e.message : String(e), secretVals).slice(0, 500);
            await db.integrationExecution.update({ where: { id: execution.id }, data: { status: 'ERROR', errorMessage: msg, durationMs: Date.now() - start, completedAt: new Date() } });
            // Surface a REVOKED CREDENTIAL on the connection; no-op for
            // anything that is not an IntegrationAuthError (401/403).
            await markAuthFailure(db, conn.id, e, now);
            // Caught here, so the retry classification must ride the result.
            return { executionId: execution.id, status: 'ERROR', counts: null, evidenceCreated: 0, errorMessage: msg, noRetry: shouldBypassQueueRetry(e) };
        }

        const summary = checkResult.details as { counts?: AwsPostureCollectResult['counts']; controls?: Array<{ id: string; status: string }> };
        const counts = summary.counts ?? null;
        const controls = summary.controls ?? [];

        // Turn each mapped PASSING control into rolling auto-collected evidence.
        let evidenceCreated = 0;
        let firstEvidenceId: string | null = null;
        if (checkResult.status !== 'ERROR') {
            // Per-control resolve + rolling-evidence upsert. Bounded by the mapped
            // control set (≤ ~20), all inside one tenant transaction; each control
            // needs its own requirement→control resolve + its own Evidence row, so
            // it can't be collapsed into one query.
            for (const c of controls) { // guardrail-allow: n+1
                if (c.status !== 'ok') continue; // pass-only evidence; alarms are a gap signal
                const seenControlIds = new Set<string>();
                // Attach evidence for EVERY framework this check crosswalks to
                // (SOC 2 + NIST CSF), skipping frameworks the tenant hasn't
                // installed. Same control covered under both frameworks → one row.
                for (const { frameworkKey, codes } of frameworkCodesForControl(c.id)) { // guardrail-allow: n+1
                    const link = await db.controlRequirementLink.findFirst({
                        where: { tenantId: ctx.tenantId, requirement: { framework: { key: frameworkKey }, code: { in: codes } } },
                        select: { controlId: true },
                    });
                    if (!link?.controlId || seenControlIds.has(link.controlId)) continue; // no covering control, or already evidenced
                    const controlId = link.controlId;
                    seenControlIds.add(controlId);
                    const category = `aws-posture:${c.id}`;
                    const nextReviewDate = new Date(now.getTime() + EVIDENCE_FRESHNESS_DAYS * 86_400_000);
                    const content = `AWS posture check "${c.id}" PASSED (${automationKey}) on ${now.toISOString().slice(0, 10)}. Machine-collected via Powerpipe; execution ${execution.id}.`;
                    const existing = await db.evidence.findFirst({
                        where: { tenantId: ctx.tenantId, evidenceControlLinks: { some: { controlId } }, category, type: 'TEXT', isArchived: false, deletedAt: null },
                        select: { id: true },
                    });
                    if (existing) {
                        const ev = await db.evidence.update({ where: { id: existing.id }, data: { title: `Automated evidence — AWS ${c.id}`, content, dateCollected: now, nextReviewDate, status: 'APPROVED' } });
                        firstEvidenceId = firstEvidenceId ?? ev.id;
                    } else {
                        const ev = await db.evidence.create({ data: { tenantId: ctx.tenantId, type: 'TEXT', title: `Automated evidence — AWS ${c.id}`, content, category, dateCollected: now, reviewCycle: 'MONTHLY', nextReviewDate, status: 'APPROVED' } });
                        await db.evidenceControlLink.create({ data: { tenantId: ctx.tenantId, evidenceId: ev.id, controlId, createdByUserId: null } });
                        firstEvidenceId = firstEvidenceId ?? ev.id;
                        try {
                            await db.controlEvidenceLink.create({ data: { tenantId: ctx.tenantId, controlId, kind: 'INTEGRATION_RESULT', integrationResultId: execution.id, note: `AWS posture: ${c.id}` } });
                        } catch { /* duplicate link acceptable */ }
                    }
                    evidenceCreated += 1;
                }
            }
        }

        // resultJson is the BOUNDED summary from the provider (counts + per-control
        // status, already size-capped, creds already scrubbed) — never raw resources.
        await db.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: checkResult.status,
                resultJson: summary as unknown as object,
                evidenceId: firstEvidenceId,
                errorMessage: checkResult.errorMessage ? scrubAwsCredentials(checkResult.errorMessage, secretVals).slice(0, 500) : null,
                durationMs: Date.now() - start,
                completedAt: new Date(),
            },
        });

        // Reached only when the collection itself ran. A FAILED compliance
        // verdict is a successful collection reporting a real gap, so the
        // credential is demonstrably good either way — clear any stale banner.
        await clearAuthFailure(db, conn.id);

        logger.info('aws-posture collection complete', { component: 'aws-posture', tenantId: ctx.tenantId, executionId: execution.id, status: checkResult.status, evidenceCreated });
        return { executionId: execution.id, status: checkResult.status, counts, evidenceCreated, errorMessage: checkResult.errorMessage };
    });
}
