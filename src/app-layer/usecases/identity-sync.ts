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
    /**
     * `SKIPPED` means another run already holds the per-connection lock. It is
     * a success (nothing went wrong) but deliberately NOT `PASSED` — claiming a
     * sync passed when it never ran would make the lock invisible in exactly
     * the logs someone would check to find out why data looks stale.
     */
    status: 'PASSED' | 'ERROR' | 'SKIPPED' | 'PARTIAL';
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
    /**
     * The provider this run synced, once the connection resolved.
     *
     * Optional because the two earliest failure arms return before a provider
     * is known — a connection that does not exist has none. Every arm that ran
     * against a real connection carries it, which is what the caller needs:
     * `reconcileIdentityAccountLinks` is keyed by provider, and re-reading the
     * connection to recover a string this function already held would be a
     * second query for a fact that was in scope.
     */
    provider?: string;
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
            select: { id: true, provider: true, configJson: true, secretEncrypted: true, isEnabled: true, syncCursor: true, syncPassStartedAt: true },
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
            return { executionId: execution.id, status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Identity connection not found', provider: conn?.provider };
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
            return { executionId: execution.id, status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Provider does not support identity sync', provider: conn.provider };
        }

        const start = Date.now();

        // A PASS is one full traversal of the directory, which for a directory
        // over MAX_USERS spans several scheduled runs. `syncPassStartedAt`
        // marks when it began; the deprovision reconcile compares each
        // account's `syncedAt` against it, so "seen" accumulates across the
        // whole pass instead of resetting every run — which is what makes
        // reconciling after a resumed enumeration safe at all.
        const passStartedAt = conn.syncPassStartedAt ?? now;

        let accounts: NormalizedIdentityAccount[];
        let complete: boolean;
        let resumeToken: string | null = null;
        try {
            const res = await resolved.listAccounts({ ...config, ...secrets }, conn.syncCursor);
            accounts = res.accounts;
            complete = res.complete;
            resumeToken = res.resumeToken ?? null;
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
            await markAuthFailure(db, conn.id, e, now, conn.provider);
            return {
                executionId: execution.id,
                status: 'ERROR',
                upserted: 0,
                deprovisioned: 0,
                errorMessage: msg,
                provider: conn.provider,
                // Preserve the retry classification across the usecase boundary.
                // This function CATCHES the provider error, so without this the
                // queue-level bypass could never see it and a revoked credential
                // would go back to being retried three times in ~35s.
                noRetry: shouldBypassQueueRetry(e),
            };
        }

        // Upsert each account idempotently by (tenantId, provider, externalUserId).
        let upserted = 0;
        // No `seen` list is accumulated. It existed to feed
        // `externalUserId: { notIn: seen }`, which the resume work replaced with
        // the `syncedAt < passStartedAt` predicate below; the array outlived its
        // only reader and was still being built every pass. Left as a comment
        // rather than deleted silently, because its ABSENCE is what the
        // reconcile's correctness now rests on.
        for (const a of accounts) { // guardrail-allow: n+1 — per-account upsert, bounded by MAX_USERS
            if (!a.externalUserId) continue;
            await db.connectedIdentityAccount.upsert({
                // Keyed on the CONNECTION as of phase 2. The old
                // tenantId_provider_externalUserId key made two forests under one
                // tenant collide on a single row, which is what forced the
                // deprovision reconcile to be provider-scoped in the first place.
                where: {
                    tenantId_connectionId_externalUserId: {
                        tenantId: ctx.tenantId,
                        connectionId: conn.id,
                        externalUserId: a.externalUserId,
                    },
                },
                create: {
                    tenantId: ctx.tenantId,
                    provider: conn.provider,
                    connectionId: conn.id,
                    externalUserId: a.externalUserId,
                    email: a.email,
                    displayName: a.displayName ?? null,
                    status: a.status,
                    isAdmin: a.isAdmin ?? false,
                    mfaEnrolled: a.mfaEnrolled ?? false,
                    // No `?? false` — nullable in the column too, because
                    // "unknown" must not read as "safe to disable here".
                    onPremisesSyncEnabled: a.onPremisesSyncEnabled,
                    // Written as a PAIR with the line above, always from the
                    // same pass. `null` when the provider did not answer, so
                    // the value and the claim to have observed it can never
                    // describe different syncs — a stale stamp beside a fresh
                    // unknown would be a lie the rail would act on.
                    onPremStateObservedAt: a.onPremStateObserved ? now : null,
                    groupsJson: a.groups,
                    lastActiveAt: a.lastActiveAt ?? null,
                    syncedAt: now,
                },
                update: {
                    // NOTHING ABOUT PROTECTION APPEARS IN THIS BLOCK, AND THAT IS
                    // THE POINT. `isProtected`, `protectedAt`, `protectedByUserId`
                    // and `protectionReason` are operator state, not directory
                    // state — the directory has no opinion about them and this
                    // sync must never express one. Adding any of them here would
                    // clear a break-glass flag nightly, and the failure is silent
                    // until the one run that would have refused doesn't.
                    //
                    // Prisma's explicit field lists are what make the omission
                    // sufficient: this is not a spread, so a new column is opted
                    // IN rather than swept along.
                    //
                    // Claimed on EVERY pass, not only on create. A row that
                    // predates the column, or whose connection was deleted, is
                    // adopted by whichever connection can still see the account
                    // — which is the only evidence available about where it
                    // lives. Ownership therefore converges on the truth instead
                    // of being frozen at whatever ran first.
                    connectionId: conn.id,
                    email: a.email,
                    displayName: a.displayName ?? null,
                    status: a.status,
                    isAdmin: a.isAdmin ?? false,
                    mfaEnrolled: a.mfaEnrolled ?? false,
                    // No `?? false` — nullable in the column too, because
                    // "unknown" must not read as "safe to disable here".
                    onPremisesSyncEnabled: a.onPremisesSyncEnabled,
                    // Written as a PAIR with the line above, always from the
                    // same pass. `null` when the provider did not answer, so
                    // the value and the claim to have observed it can never
                    // describe different syncs — a stale stamp beside a fresh
                    // unknown would be a lie the rail would act on.
                    onPremStateObservedAt: a.onPremStateObserved ? now : null,
                    groupsJson: a.groups,
                    lastActiveAt: a.lastActiveAt ?? null,
                    syncedAt: now,
                },
            });
            upserted += 1;
        }

        // A KNOWN-PARTIAL enumeration must NEVER drive the deprovision
        // reconcile: accounts past the cap were not observed and would be
        // wrongly flipped to DEPROVISIONED.
        //
        // H3-2 splits this by whether the provider handed back a resume token.
        if (!complete) {
            recordSyncTruncated({ provider: conn.provider }); // H6 — alertable truncation signal

            if (resumeToken) {
                // RESUMABLE. This is progress, not failure: the accounts we saw
                // are upserted, the cursor advances, and the next scheduled run
                // continues from here until the pass completes and reconciles.
                // Reporting ERROR would page someone every night for a large
                // directory that is working exactly as designed.
                await db.integrationConnection.updateMany({
                    where: { id: conn.id },
                    data: { syncCursor: resumeToken, syncPassStartedAt: passStartedAt },
                });
                const msg = `Partial enumeration (${accounts.length} accounts this run); pass continues from the stored cursor on the next run.`;
                await db.integrationExecution.update({
                    where: { id: execution.id },
                    data: {
                        status: 'PASSED',
                        errorMessage: null,
                        resultJson: { upserted, deprovisioned: 0, total: accounts.length, partial: true, resuming: true },
                        durationMs: Date.now() - start,
                        completedAt: new Date(),
                    },
                });
                logger.info('identity-sync partial — cursor stored, pass continues', {
                    component: 'identity-sync',
                    tenantId: ctx.tenantId,
                    provider: conn.provider,
                    executionId: execution.id,
                    upserted,
                    passStartedAt,
                });
                await clearAuthFailure(db, conn.id, conn.provider);
                return { executionId: execution.id, status: 'PARTIAL', upserted, deprovisioned: 0, errorMessage: msg, provider: conn.provider };
            }

            // NOT resumable (Active Directory: ldapjs paged search uses a
            // server-side cookie tied to the live connection, so it cannot
            // survive a process boundary). Unchanged behaviour — loud, and not
            // retryable, because re-running truncates at the same place.
            const msg = `Partial directory enumeration: hit the ${accounts.length}-account cap with more pages remaining, and this provider cannot resume. Deprovision reconcile skipped to avoid wrongful mass-deprovisioning.`;
            await db.integrationExecution.update({
                where: { id: execution.id },
                data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, deprovisioned: 0, total: accounts.length, truncated: true }, durationMs: Date.now() - start, completedAt: new Date() },
            });
            logger.warn('identity-sync partial enumeration — deprovision skipped', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId: execution.id, upserted });
            return {
                executionId: execution.id,
                status: 'ERROR',
                upserted,
                deprovisioned: 0,
                errorMessage: msg,
                provider: conn.provider,
                // Deterministic: re-running enumerates the same too-large
                // directory and truncates identically, so three retries mean
                // three more full enumerations for the same outcome.
                noRetry: true,
            };
        }

        // Reconcile still-ACTIVE accounts no longer in the (fully-enumerated)
        // directory — they are now deprovisioned. Runs ONLY on a confirmed-
        // complete enumeration. The whole callback is one RLS transaction
        // (runInTenantContext), so upsert + reconcile commit atomically.
        // Anything not touched since the PASS began was not in the directory
        // during any run of this pass, so it is genuinely gone.
        //
        // This replaces `externalUserId: { notIn: seen }`, which was correct
        // only while a pass was a single run. Under resume, `seen` holds just
        // the LAST run's slice — reconciling against it would deprovision every
        // account from every earlier run of the same pass. That is the
        // wrongful-mass-deprovision failure this whole area is built to avoid,
        // and it would have been introduced BY the resume feature.
        // SCOPED TO THE CONNECTION, NOT THE PROVIDER — and that is the whole
        // point of the column. `IntegrationConnection` is unique on
        // (tenantId, provider, NAME), so two AD forests or two Entra tenants
        // under one customer are supported. Matching on `provider` meant
        // connection A's pass marked every account belonging to connection B
        // DEPROVISIONED — it touched only its own accounts, then swept
        // everything for that provider it had not touched — and B's next pass
        // did the reverse. Both reported PASSED. No write permission, no
        // consent, no bind — one admin adding a second connection triggered it.
        //
        // THE NULL ARM IS GONE, and its removal is the point of phase 2 rather
        // than a tidy-up. Phase 1 had to include unattributed rows when the
        // tenant held a single connection, because `connectionId` was nullable
        // and excluding them would have silently stopped deprovisioning every
        // row written before the column existed — with
        // `recordIdentityDeprovisioned` reporting 0, which reads exactly like a
        // healthy directory. The column is NOT NULL now, so there is nothing
        // left to include: `connectionId: null` matches no row, and the extra
        // COUNT query that decided whether to widen has nothing left to decide.
        //
        // `provider` stays in the predicate even though `connectionId` already
        // implies it. It is not redundant defensively — it keeps the statement
        // readable and correct on a connection that legitimately bypasses RLS,
        // and it is the column the index leads with.
        const reconcile = await db.connectedIdentityAccount.updateMany({
            where: {
                tenantId: ctx.tenantId,
                provider: conn.provider,
                connectionId: conn.id,
                status: { not: 'DEPROVISIONED' },
                syncedAt: { lt: passStartedAt },
            },
            data: { status: 'DEPROVISIONED', syncedAt: now },
        });

        // The pass is done: clear the cursor so the next run starts a fresh one.
        await db.integrationConnection.updateMany({
            where: { id: conn.id },
            data: { syncCursor: null, syncPassStartedAt: null },
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
        await clearAuthFailure(db, conn.id, conn.provider);

        recordIdentityDeprovisioned({ provider: conn.provider, count: reconcile.count }); // H6 — spike = wrongful mass-deprovision
        logger.info('identity-sync complete', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId: execution.id, upserted, deprovisioned: reconcile.count });
        return { executionId: execution.id, status: 'PASSED', upserted, deprovisioned: reconcile.count, provider: conn.provider };
    });
}
