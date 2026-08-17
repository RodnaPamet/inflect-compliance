/**
 * identity-sync — enumerate a connected directory (Okta / Google Workspace / Entra ID / Active Directory)
 * and upsert its accounts into `ConnectedIdentityAccount`, recording ONE
 * `IntegrationExecution`. Idempotent by `(tenantId, provider,
 * externalUserId)`; accounts that vanish from the directory are reconciled
 * to DEPROVISIONED so PR-4's offboarded-access check stays accurate.
 *
 * Mirrors `aws-posture.ts`: runs entirely inside `runInTenantContext`
 * (tenant-scoped, RLS-bound, no global prisma). Directory metadata only —
 * email + status flags, not content — so nothing is encrypted here.
 */
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context-system';
import { runInTenantContext } from '@/lib/db-context';
import { markAuthFailure, clearAuthFailure } from '../integrations/connection-health';
import { shouldBypassQueueRetry } from '../integrations/http-resilience';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { recordSyncTruncated, recordIdentityDeprovisioned } from '@/lib/observability/integration-metrics';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { registry } from '../integrations/registry';
import { isIdentitySyncProvider, type IdentitySyncProvider, type NormalizedIdentityAccount } from '../integrations/providers/identity/types';

const IDENTITY_PROVIDERS = new Set(['okta', 'google-workspace', 'entra-id', 'active-directory']);

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'identity-sync' });
}

export interface IdentitySyncResult {
    executionId: string;
    status: 'PASSED' | 'ERROR';
    upserted: number;
    deprovisioned: number;
    errorMessage?: string;
    /**
     * True when the queue must NOT immediately re-run this sync — a revoked
     * credential or a throttle that outlasted our absorb budget.
     *
     * Carried on the result rather than raised as a throw because this usecase
     * deliberately catches provider errors to record them on the execution row.
     * Without it the classification dies here and the queue retries anyway.
     */
    noRetry?: boolean;
}

/**
 * Sync one identity connection end-to-end. `connectionId` selects the
 * connection (provider must be okta / google-workspace). `provider` and
 * `now` are injectable for tests.
 */
export async function runIdentitySync(input: {
    tenantId: string;
    connectionId: string;
    now?: Date;
    provider?: IdentitySyncProvider;
}): Promise<IdentitySyncResult> {
    const ctx = makeSystemCtx(input.tenantId);
    const now = input.now ?? new Date();

    return runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: input.connectionId, tenantId: ctx.tenantId },
            select: { id: true, provider: true, configJson: true, secretEncrypted: true, isEnabled: true },
        });
        if (!conn || !IDENTITY_PROVIDERS.has(conn.provider)) {
            const execution = await db.integrationExecution.create({
                data: {
                    tenantId: ctx.tenantId,
                    provider: conn?.provider ?? 'identity',
                    automationKey: 'identity.sync',
                    status: 'ERROR',
                    errorMessage: 'Identity connection not found',
                    triggeredBy: 'scheduled',
                    completedAt: now,
                },
            });
            return { executionId: execution.id, status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Identity connection not found' };
        }

        const automationKey = `${conn.provider}.sync`;
        const config = (conn.configJson ?? {}) as Record<string, unknown>;
        const secrets: Record<string, unknown> = conn.secretEncrypted
            ? (JSON.parse(decryptField(conn.secretEncrypted)) as Record<string, unknown>)
            : {};

        const execution = await db.integrationExecution.create({
            data: { tenantId: ctx.tenantId, connectionId: conn.id, provider: conn.provider, automationKey, status: 'RUNNING', triggeredBy: 'scheduled', executedAt: now },
        });

        // Resolve the provider (registry instance in prod; injected in tests).
        const resolved = input.provider ?? registry.getProvider(conn.provider);
        if (!resolved || !isIdentitySyncProvider(resolved)) {
            await db.integrationExecution.update({
                where: { id: execution.id },
                data: { status: 'ERROR', errorMessage: `Provider ${conn.provider} does not support identity sync`, completedAt: new Date() },
            });
            return { executionId: execution.id, status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Provider does not support identity sync' };
        }

        const start = Date.now();
        let accounts: NormalizedIdentityAccount[];
        let complete: boolean;
        try {
            const res = await resolved.listAccounts({ ...config, ...secrets });
            accounts = res.accounts;
            complete = res.complete;
        } catch (e) {
            const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
            await db.integrationExecution.update({
                where: { id: execution.id },
                data: { status: 'ERROR', errorMessage: msg, durationMs: Date.now() - start, completedAt: new Date() },
            });
            // Surface a REVOKED CREDENTIAL on the connection itself. Recording
            // it only on the execution row left a dead connection presenting as
            // healthy until someone opened the history of a job nobody watches.
            // No-op unless this is an IntegrationAuthError (401/403).
            await markAuthFailure(db, conn.id, e, now);
            return {
                executionId: execution.id,
                status: 'ERROR',
                upserted: 0,
                deprovisioned: 0,
                errorMessage: msg,
                // Preserve the retry classification across the usecase boundary.
                // This function CATCHES the provider error, so without this the
                // queue-level bypass could never see it and a revoked credential
                // would go back to being retried three times in ~35s.
                noRetry: shouldBypassQueueRetry(e),
            };
        }

        // Upsert each account idempotently by (tenantId, provider, externalUserId).
        let upserted = 0;
        const seen: string[] = [];
        for (const a of accounts) { // guardrail-allow: n+1 — per-account upsert, bounded by MAX_USERS
            if (!a.externalUserId) continue;
            seen.push(a.externalUserId);
            await db.connectedIdentityAccount.upsert({
                where: { tenantId_provider_externalUserId: { tenantId: ctx.tenantId, provider: conn.provider, externalUserId: a.externalUserId } },
                create: {
                    tenantId: ctx.tenantId,
                    provider: conn.provider,
                    externalUserId: a.externalUserId,
                    email: a.email,
                    displayName: a.displayName ?? null,
                    status: a.status,
                    isAdmin: a.isAdmin ?? false,
                    mfaEnrolled: a.mfaEnrolled ?? false,
                    groupsJson: a.groups,
                    lastActiveAt: a.lastActiveAt ?? null,
                    syncedAt: now,
                },
                update: {
                    email: a.email,
                    displayName: a.displayName ?? null,
                    status: a.status,
                    isAdmin: a.isAdmin ?? false,
                    mfaEnrolled: a.mfaEnrolled ?? false,
                    groupsJson: a.groups,
                    lastActiveAt: a.lastActiveAt ?? null,
                    syncedAt: now,
                },
            });
            upserted += 1;
        }

        // H3 — a KNOWN-PARTIAL enumeration (directory larger than MAX_USERS)
        // must NEVER drive the deprovision reconcile: accounts past the cap
        // weren't observed and would be wrongly flipped to DEPROVISIONED. Upsert
        // what we did see (idempotent, additive), skip the reconcile, and fail
        // the execution loudly so the truncation is visible.
        if (!complete) {
            const msg = `Partial directory enumeration: hit the ${accounts.length}-account cap with more pages remaining. Deprovision reconcile skipped to avoid wrongful mass-deprovisioning.`;
            await db.integrationExecution.update({
                where: { id: execution.id },
                data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, deprovisioned: 0, total: accounts.length, truncated: true }, durationMs: Date.now() - start, completedAt: new Date() },
            });
            logger.warn('identity-sync partial enumeration — deprovision skipped', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId: execution.id, upserted });
            recordSyncTruncated({ provider: conn.provider }); // H6 — alertable truncation signal
            return {
                executionId: execution.id,
                status: 'ERROR',
                upserted,
                deprovisioned: 0,
                errorMessage: msg,
                // Loud, but NOT retryable. The cap is deterministic: re-running
                // enumerates the same too-large directory and truncates at the
                // same point. Three retries would mean three more full 5000-
                // account enumerations for a guaranteed-identical outcome —
                // the amplification pattern, arriving from a different door.
                // Resuming past the cap is H3-2, not a retry.
                noRetry: true,
            };
        }

        // Reconcile still-ACTIVE accounts no longer in the (fully-enumerated)
        // directory — they are now deprovisioned. Runs ONLY on a confirmed-
        // complete enumeration. The whole callback is one RLS transaction
        // (runInTenantContext), so upsert + reconcile commit atomically.
        const reconcile = await db.connectedIdentityAccount.updateMany({
            where: {
                tenantId: ctx.tenantId,
                provider: conn.provider,
                status: { not: 'DEPROVISIONED' },
                externalUserId: { notIn: seen.length > 0 ? seen : ['__none__'] },
            },
            data: { status: 'DEPROVISIONED', syncedAt: now },
        });

        await db.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: 'PASSED',
                resultJson: { upserted, deprovisioned: reconcile.count, total: accounts.length },
                durationMs: Date.now() - start,
                completedAt: new Date(),
            },
        });

        // The load-bearing half. A "credential revoked" banner that survives
        // the admin fixing the credential is worse than no banner — it teaches
        // people to ignore the one signal that means someone must act. Cleared
        // unconditionally on every success, not only the success after a
        // failure.
        await clearAuthFailure(db, conn.id);

        recordIdentityDeprovisioned({ provider: conn.provider, count: reconcile.count }); // H6 — spike = wrongful mass-deprovision
        logger.info('identity-sync complete', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId: execution.id, upserted, deprovisioned: reconcile.count });
        return { executionId: execution.id, status: 'PASSED', upserted, deprovisioned: reconcile.count };
    });
}
