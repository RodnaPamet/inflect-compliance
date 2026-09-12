/**
 * identity-sync — enumerate a connected directory (Okta / Google Workspace / Entra ID / Active Directory)
 * and upsert its accounts into `ConnectedIdentityAccount`, recording ONE
 * `IntegrationExecution`. Idempotent by `(tenantId, provider,
 * externalUserId)`; accounts that vanish from the directory are reconciled
 * to DEPROVISIONED so PR-4's offboarded-access check stays accurate.
 *
 * Tenant-scoped and RLS-bound throughout (`runInTenantContext`, no global
 * prisma). Directory metadata only — email + status flags, not content — so
 * nothing is encrypted here.
 *
 * ═══ THE RUN IS SEVERAL TRANSACTIONS, NOT ONE (#2501) ═══
 *
 * It used to be one. The whole function body was a single
 * `runInTenantContext` callback — a Prisma interactive transaction on the
 * 5,000 ms runtime default — with the directory enumeration's HTTPS round
 * trips inside it. `integrations/sync-transaction.ts` carries the full
 * account; the order below is what matters when reading this file:
 *
 *   1. a short transaction opens the run and commits the `RUNNING` row;
 *   2. the directory enumeration happens with NO transaction open;
 *   3. bounded write transactions carry the upserts and the reconcile;
 *   4. a short transaction finalises the execution row.
 *
 * So every failure arm from step 2 onwards records its `ERROR` row on a client
 * the failure has not closed. When the old budget blew it rolled back the
 * `RUNNING` row AND the `ERROR` row the catch was writing, and the only
 * observable left was an absence — indistinguishable from a dispatcher that
 * never fired.
 */
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context-system';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { markAuthFailure, clearAuthFailure } from '../integrations/connection-health';
import { shouldBypassQueueRetry } from '../integrations/http-resilience';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { recordSyncTruncated, recordIdentityDeprovisioned, recordDeprovisionRefused } from '@/lib/observability/integration-metrics';
import {
    chunk,
    SYNC_BOOKKEEPING_TX_OPTIONS,
    SYNC_UPSERT_CHUNK_SIZE,
    SYNC_WRITE_TX_OPTIONS,
} from '../integrations/sync-transaction';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { registry } from '../integrations/registry';
import { isIdentitySyncProvider, type IdentitySyncProvider, type NormalizedIdentityAccount } from '../integrations/providers/identity/types';

const IDENTITY_PROVIDERS = new Set(['okta', 'google-workspace', 'entra-id', 'active-directory']);

/**
 * Refuse the deprovision reconcile when it would flip more than this share of
 * the accounts this connection currently believes are live.
 *
 * ═══ THE NUMBER IS THE WRITE BREAKER'S, THE CONSTANT IS NOT ═══
 *
 * `MAX_DISABLE_SHARE` in `identity-write-breaker.ts` is 0.1 as well, and that
 * is deliberate: both rails answer the same question — "is this batch too
 * large a slice of the directory to be a real event?" — and inventing a second
 * threshold would mean two numbers an operator has to hold in their head with
 * nothing to tell them apart.
 *
 * They are separate CONSTANTS because the cost of firing differs, so the two
 * numbers must be free to move apart. A refusal by the write breaker delays a
 * real offboarding by a run; a refusal here LATCHES (see below). Retuning one
 * for sensitivity must not silently retune the other.
 *
 * ═══ WHY A SHARE CAP AND NOT ALSO AN ABSOLUTE ONE ═══
 *
 * The breaker pairs its share rule with `MAX_DISABLES_PER_RUN = 50`. Copying
 * that here would be wrong, and the reason is the shape of this count rather
 * than its size.
 *
 * `proposed` over there is a count of an ACT and can go DOWN: an account
 * disabled today is not a candidate tomorrow. The number here is a count of a
 * STANDING BACKLOG — every row for this connection untouched since the pass
 * began. Refusing does not clear it: those rows keep their stale `syncedAt`,
 * so the next pass proposes the same set plus whatever else has left since.
 * The count only grows. An absolute cap over a monotonically growing count
 * fires once and then refuses forever while looking deliberate, which is #2290
 * exactly — and 50 is calibrated for one day's departures, not for a backlog.
 *
 * The share rule latches in the same way once it fires; the difference is that
 * it only fires on an anomaly (a tenth of a directory vanishing between two
 * passes), and it is scale-free, so ordinary churn at any tenant size never
 * reaches it. A rail that holds after refusing is acceptable; a rail that
 * refuses ordinary operation and then holds is not.
 *
 * ═══ WHICH WAY IT FAILS ═══
 *
 * It fails CLOSED: on refusal the accounts stay in their current status,
 * meaning the mirror keeps reporting as present people who may really be gone.
 * That is a visible gap in the offboarded-access check, and it is the cheaper
 * error — an over-large DEPROVISIONED sweep is what strands the leaver path's
 * blast-radius numerator at zero (#2498), and a mirror that over-reports
 * ACTIVE can only make that numerator larger, never smaller.
 *
 * Recoverable, too, and only in this direction: the upsert writes `status`
 * from the directory on every pass, so an account wrongly left ACTIVE — or
 * wrongly marked DEPROVISIONED — is corrected by the next pass that sees it.
 */
export const MAX_DEPROVISION_SHARE = 0.1;

/**
 * Below this many proposed deprovisions the share rule does not apply.
 *
 * Same reasoning as `SHARE_RULE_FLOOR` in the write breaker, same value: in a
 * six-account connection one departure is 17% and always will be, so a share
 * rule without a floor refuses every genuine departure at the bottom end. The
 * zero-enumeration floor below is what covers the small-tenant case this leaves
 * open — a connection of four whose enumeration returns nothing is refused
 * there, on evidence the share rule cannot see.
 */
export const DEPROVISION_SHARE_FLOOR = 5;

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

    /**
     * A handful of statements, no directory round trip. Everything whose job
     * is to be DURABLE rather than fast goes through here: the RUNNING row,
     * every ERROR row, the final status.
     */
    const shortTx = <T>(fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
        runInTenantContext(ctx, fn, SYNC_BOOKKEEPING_TX_OPTIONS);
    /** One bounded batch of row writes — at most SYNC_UPSERT_CHUNK_SIZE of them. */
    const writeTx = <T>(fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
        runInTenantContext(ctx, fn, SYNC_WRITE_TX_OPTIONS);

    // ── 1. Open the run ──────────────────────────────────────────────────
    // Committed BEFORE the enumeration, which is the entire point: from here
    // on there is a row on disk saying this run started.
    const opened = await shortTx(async (db) => {
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
            return { ok: false as const, executionId: execution.id, provider: conn?.provider };
        }
        const execution = await db.integrationExecution.create({
            data: { tenantId: ctx.tenantId, connectionId: conn.id, provider: conn.provider, automationKey: `${conn.provider}.sync`, status: 'RUNNING', triggeredBy: 'scheduled', executedAt: now },
        });
        return { ok: true as const, conn, executionId: execution.id };
    });
    if (!opened.ok) {
        return { executionId: opened.executionId, status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Identity connection not found', provider: opened.provider };
    }
    const { conn, executionId } = opened;

    const config = (conn.configJson ?? {}) as Record<string, unknown>;
    const secrets: Record<string, unknown> = conn.secretEncrypted
        ? (JSON.parse(decryptField(conn.secretEncrypted)) as Record<string, unknown>)
        : {};

    // Resolve the provider (registry instance in prod; injected in tests).
    const resolved = input.provider ?? registry.getProvider(conn.provider);
    if (!resolved || !isIdentitySyncProvider(resolved)) {
        await shortTx((db) =>
            db.integrationExecution.update({
                where: { id: executionId },
                data: { status: 'ERROR', errorMessage: `Provider ${conn.provider} does not support identity sync`, completedAt: new Date() },
            }),
        );
        return { executionId, status: 'ERROR', upserted: 0, deprovisioned: 0, errorMessage: 'Provider does not support identity sync', provider: conn.provider };
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
    // ── 2. The enumeration — outside every transaction ───────────────────
    // Okta, Google Workspace and Entra ID all page: sequential HTTPS round
    // trips, each budgeted at 30 s by `bounded-fetch.ts` and each able to
    // absorb a 60 s Retry-After sleep in-process. Held inside an interactive
    // transaction that pinned a Postgres backend — and, through PgBouncer, a
    // pooled server connection — for the whole enumeration, and blew the 5 s
    // default long before the directory was read.
    try {
        const res = await resolved.listAccounts({ ...config, ...secrets }, conn.syncCursor);
        accounts = res.accounts;
        complete = res.complete;
        resumeToken = res.resumeToken ?? null;
    } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        await shortTx(async (db) => {
            await db.integrationExecution.update({
                where: { id: executionId },
                data: { status: 'ERROR', errorMessage: msg, durationMs: Date.now() - start, completedAt: new Date() },
            });
            // Surface a REVOKED CREDENTIAL on the connection itself. Recording
            // it only on the execution row left a dead connection presenting as
            // healthy until someone opened the history of a job nobody watches.
            // No-op unless this is an IntegrationAuthError (401/403).
            await markAuthFailure(db, conn.id, e, now, conn.provider);
        });
        return {
            executionId,
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

    // Declared outside the try so the write-failure arm can report what
    // actually landed before it broke. Reporting 0 there would describe a
    // half-written pass as a run that did nothing.
    let upserted = 0;

    // ── 3. The write phase ───────────────────────────────────────────────
    // Wrapped in a catch, because the RUNNING row is now COMMITTED. Before
    // this change a throw took that row down with it and the run left no trace
    // at all; now the row outlives the failure, so something has to finish it
    // or the connection shows a run that started and never ended.
    try {
        // Upsert each account idempotently by (tenantId, connectionId,
        // externalUserId), one bounded transaction per chunk.
        //
        // NOT ONE TRANSACTION ANY MORE, and the reconcile further down depends
        // on why that is still safe. What the reconcile needs is not that the
        // upserts commit WITH it but that every upsert of this pass has
        // ALREADY committed by the time it runs — which the sequencing gives:
        // a chunk that fails throws out of this block, and the reconcile is
        // never reached.
        //
        // What is genuinely given up is rolling committed upserts back when a
        // LATER step fails, and that direction is the safe one. Accounts
        // refreshed with no reconcile keep the status the directory reported,
        // so the mirror over-reports people as present — which is the cheaper
        // error for exactly the reason MAX_DEPROVISION_SHARE is: an over-large
        // DEPROVISIONED sweep is what strands the leaver path's blast-radius
        // numerator at zero (#2498), and over-reporting ACTIVE can only make
        // that numerator larger.
        //
        // No `seen` list is accumulated. It existed to feed
        // `externalUserId: { notIn: seen }`, which the resume work replaced with
        // the `syncedAt < passStartedAt` predicate below; the array outlived its
        // only reader and was still being built every pass. Left as a comment
        // rather than deleted silently, because its ABSENCE is what the
        // reconcile's correctness now rests on.
        for (const group of chunk(accounts, SYNC_UPSERT_CHUNK_SIZE)) {
            upserted += await writeTx(async (db) => {
                let n = 0;
                for (const a of group) { // guardrail-allow: n+1 — per-account upsert, bounded by SYNC_UPSERT_CHUNK_SIZE
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
                    n += 1;
                }
                return n;
            });
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
                //
                // The cursor is stored AFTER the upserts commit. The other
                // order advances the pass past rows that then roll back, and
                // the next run resumes beyond accounts nothing ever wrote.
                await shortTx((db) =>
                    db.integrationConnection.updateMany({
                        where: { id: conn.id },
                        data: { syncCursor: resumeToken, syncPassStartedAt: passStartedAt },
                    }),
                );
                const msg = `Partial enumeration (${accounts.length} accounts this run); pass continues from the stored cursor on the next run.`;
                await shortTx(async (db) => {
                    await db.integrationExecution.update({
                        where: { id: executionId },
                        data: {
                            // PARTIAL, not PASSED. This arm RETURNS 'PARTIAL' — the
                            // job reads that and correctly skips the link reconcile
                            // — while the row an operator reads said the sync
                            // passed. Green badge, zero links, nothing on the page
                            // distinguishing it from a complete sync.
                            //
                            // The enum value already existed for exactly this, and
                            // its own doc comment names the same defect one
                            // subsystem over: the SharePoint audit-pack export
                            // "used to record those runs as PASSED, so the
                            // operator's only durable record of an incomplete pack
                            // said it was clean".
                            //
                            // `errorMessage` stays null deliberately: a resumable
                            // partial is not an error, it is an incomplete success
                            // that continues next pass. PARTIAL is what carries that.
                            status: 'PARTIAL',
                            errorMessage: null,
                            resultJson: { upserted, deprovisioned: 0, total: accounts.length, partial: true, resuming: true },
                            durationMs: Date.now() - start,
                            completedAt: new Date(),
                        },
                    });
                    await clearAuthFailure(db, conn.id, conn.provider);
                });
                logger.info('identity-sync partial — cursor stored, pass continues', {
                    component: 'identity-sync',
                    tenantId: ctx.tenantId,
                    provider: conn.provider,
                    executionId,
                    upserted,
                    passStartedAt,
                });
                return { executionId, status: 'PARTIAL', upserted, deprovisioned: 0, errorMessage: msg, provider: conn.provider };
            }

            // NOT resumable (Active Directory: ldapjs paged search uses a
            // server-side cookie tied to the live connection, so it cannot
            // survive a process boundary). Unchanged behaviour — loud, and not
            // retryable, because re-running truncates at the same place.
            // NAMES THE FACT, NOT A CAUSE THIS LAYER CANNOT SEE. It used to
            // say "hit the N-account cap", which was true while the cap was the
            // only thing that could clear `complete`. Active Directory now also
            // reports incomplete when the search returned entries it could not
            // key, and in that case the old sentence read "hit the 0-account
            // cap" — a wrong diagnosis in the one field an operator opens to
            // find out what happened. The provider logs which condition fired.
            const msg = `Incomplete directory enumeration: the provider ingested ${accounts.length} account(s) and reported the traversal unfinished, with no cursor to resume from. Deprovision reconcile skipped to avoid wrongful mass-deprovisioning; the provider's own log names the condition (the enumeration cap, or entries that could not be keyed).`;
            await shortTx((db) =>
                db.integrationExecution.update({
                    where: { id: executionId },
                    data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, deprovisioned: 0, total: accounts.length, truncated: true }, durationMs: Date.now() - start, completedAt: new Date() },
                }),
            );
            logger.warn('identity-sync partial enumeration — deprovision skipped', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId, upserted });
            return {
                executionId,
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
        // complete enumeration.
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
        const reconcileWhere = {
            tenantId: ctx.tenantId,
            provider: conn.provider,
            connectionId: conn.id,
            status: { not: 'DEPROVISIONED' as const },
            syncedAt: { lt: passStartedAt },
        };

        // ═══ THE MEASURE, THE DECISION AND THE SWEEP ARE ONE TRANSACTION ═══
        //
        // Not a leftover of the old single-transaction shape — the one grouping
        // that has to survive it. The rails below judge a COUNT and then act on
        // it, so if the count and the `updateMany` ran in separate transactions
        // a row could change status between them and the number an operator was
        // shown would describe a different set from the one that was swept.
        // That is the same defect this subsystem fixed in the AD provider,
        // where the completeness flag was computed over one collection and the
        // upsert consumed another. The cursor clear joins them for the reason
        // given at the bottom of the block.
        const outcome = await writeTx(async (db) => {
            // ═══ `complete` IS NOT ENOUGH TO AUTHORISE THIS SWEEP ═══
            //
            // Everything above establishes that the provider finished its
            // traversal. It establishes nothing about WHAT the traversal saw, and
            // the sweep below is unbounded in the wrong direction: it flips every
            // account this connection has not touched since the pass began.
            //
            // For Active Directory `complete` was `searchEntries.length < 5000`
            // (fixed in the same change to compare against the INGESTED set), so a
            // baseDN typo, an OU ACL change or a bind user scoped down produced
            // zero entries, `0 < 5000` = complete, the whole forest DEPROVISIONED,
            // and the run recorded PASSED with an INFO log. Every rail downstream
            // then reads a mirror in which nobody is ACTIVE.
            //
            // So the reconcile is measured before it is applied: how many rows it
            // would flip, against how many this connection still calls live. Two
            // refusals, and they cover different cases — the floor catches a
            // connection too small for the share rule to speak about, the share cap
            // catches a partial scoping failure the floor cannot see.
            //
            // MEASURED WITH THE RECONCILE'S OWN PREDICATE, not a re-derivation of
            // it. `reconcileWhere` is the same object the `updateMany` below is
            // given, so the number the rails judge and the number the write
            // produces cannot describe different sets.
            const wouldDeprovision = await db.connectedIdentityAccount.count({ where: reconcileWhere });

            let refusal: string | null = null;
            let refusalReason: 'zero_enumeration' | 'share_cap' | null = null;

            // Nothing proposed is always allowed, matching `checkDisableBlastRadius`
            // on `proposed <= 0`: a no-op surfacing as a refusal would teach
            // operators that refusals are noise.
            if (wouldDeprovision > 0) {
                // FOLLOWS `hris-sync.ts`'s `passSawRows` — the sibling subsystem
                // already had this guard and this one did not. Same shape, and the
                // second clause is load-bearing for the same reason there: under
                // resume the final run of a pass legitimately reads an empty page
                // (a directory whose size is an exact multiple of the page cap ends
                // that way), and an earlier run of THIS pass already proved the
                // provider is answering. A FIRST-run empty enumeration still
                // refuses, which is the zero-entry case that matters.
                //
                // `Boolean(...)`, not `!== null`: the marker is absent as either
                // null or undefined depending on the caller, and `!== null` reads
                // undefined as "resumed", which would make the guard unconditional.
                //
                // Counts `upserted`, NOT `accounts.length`. They differ exactly when
                // the provider returned entries with no `externalUserId`, which the
                // loop above skips — and it is the rows we WROTE that the reconcile
                // predicate complements, so anything else would be measuring one
                // collection to authorise a statement about another.
                const passSawAccounts = upserted > 0 || Boolean(conn.syncPassStartedAt);
                if (!passSawAccounts) {
                    refusalReason = 'zero_enumeration';
                    refusal =
                        `Refusing to deprovision ${wouldDeprovision} account(s): this pass ingested none. ` +
                        `A complete-but-empty enumeration is far more likely a scoping failure — a baseDN ` +
                        `typo, an OU ACL change, a bind account scoped down — than a directory that emptied, ` +
                        `and the accounts stay in their current status until a human has looked.`;
                } else {
                    // The denominator is what this connection currently calls live,
                    // AFTER this pass's upserts: rows it just confirmed, plus the
                    // stale rows the numerator is proposing to remove. Same table,
                    // same connection, one predicate narrower — so the two halves of
                    // the fraction count the same kind of thing over the same set.
                    const knownPopulation = await db.connectedIdentityAccount.count({
                        where: {
                            tenantId: ctx.tenantId,
                            provider: conn.provider,
                            connectionId: conn.id,
                            status: { not: 'DEPROVISIONED' },
                        },
                    });
                    // Unreachable by construction — the numerator's predicate is the
                    // denominator's plus `syncedAt`, so the population is never
                    // below it. Pinned anyway, and pinned to 1 rather than 0: an
                    // absent denominator must read as "the whole directory" and
                    // refuse, never as "a small share" and allow.
                    const share = knownPopulation > 0 ? wouldDeprovision / knownPopulation : 1;
                    if (wouldDeprovision > DEPROVISION_SHARE_FLOOR && share > MAX_DEPROVISION_SHARE) {
                        refusalReason = 'share_cap';
                        refusal =
                            `Refusing to deprovision ${wouldDeprovision} of ${knownPopulation} account(s) ` +
                            `(${(share * 100).toFixed(1)}%): the per-pass share cap is ` +
                            `${(MAX_DEPROVISION_SHARE * 100).toFixed(0)}%. A slice of the directory this large ` +
                            `disappearing between two passes is more likely a scoping failure than a real ` +
                            `departure wave, so the accounts stay in their current status until a human has looked.`;
                    }
                }
            }

            let deprovisioned = 0;
            if (!refusal) {
                const reconcile = await db.connectedIdentityAccount.updateMany({
                    where: reconcileWhere,
                    data: { status: 'DEPROVISIONED', syncedAt: now },
                });
                deprovisioned = reconcile.count;
            }

            // The pass is done: clear the cursor so the next run starts a fresh one.
            //
            // CLEARED ON A REFUSAL TOO, and that is not tidiness. The enumeration
            // finished; it is the reconcile that was held, so there is no page left
            // to resume. Leaving `syncPassStartedAt` set would also disarm the floor
            // on the very next run: `passSawAccounts` ORs in that marker, so a
            // second zero-entry enumeration would read as "an earlier run of this
            // pass saw rows" and sweep the connection the refusal just saved.
            //
            // IN THIS TRANSACTION, with the sweep. A sweep that commits while the
            // cursor survives leaves the next run resuming a pass that already
            // deprovisioned its departures; a cursor cleared while the sweep is
            // lost closes the pass with the departures never marked. Both are
            // silent, so they stay atomic.
            await db.integrationConnection.updateMany({
                where: { id: conn.id },
                data: { syncCursor: null, syncPassStartedAt: null },
            });

            return { wouldDeprovision, refusal, refusalReason, deprovisioned };
        });

        const { refusal, refusalReason, wouldDeprovision, deprovisioned } = outcome;

        // PARTIAL, NOT PASSED, when a rail refused. The traversal succeeded and
        // the upserts landed, so this is not an ERROR — but a pass whose
        // reconcile was withheld has left the mirror knowingly incomplete, and
        // PASSED is the one thing it must not say. The enum's own doc comment
        // names this failure one subsystem over: an incomplete pack recorded as
        // clean, where the operator's only durable record said nothing happened.
        //
        // It also stops the follow-on link reconcile, which `jobs/identity-sync`
        // gates on `status === 'PASSED'`. That is the right direction rather
        // than a side effect: `IdentityAccountLink.lastVerifiedAt` would
        // otherwise be freshened from a pass we have just declared untrustworthy,
        // and `findLeaverCandidates` requires that freshness — so a suspect pass
        // yields fewer leaver candidates, not more.
        const status: 'PASSED' | 'PARTIAL' = refusal ? 'PARTIAL' : 'PASSED';
        await shortTx(async (db) => {
            await db.integrationExecution.update({
                where: { id: executionId },
                data: {
                    status,
                    // Carried on the row, because the row is the only durable record
                    // an operator reads. `null` on the clean path.
                    errorMessage: refusal,
                    resultJson: {
                        upserted,
                        deprovisioned,
                        total: accounts.length,
                        ...(refusal ? { deprovisionRefused: refusalReason, deprovisionProposed: wouldDeprovision } : {}),
                    },
                    durationMs: Date.now() - start,
                    completedAt: new Date(),
                },
            });

            // The load-bearing half. A "credential revoked" banner that survives
            // the admin fixing the credential is worse than no banner — it teaches
            // people to ignore the one signal that means someone must act. Cleared
            // unconditionally on every success, not only the success after a
            // failure.
            //
            // Cleared on a refusal as well, deliberately: the bind and the search
            // both succeeded, so the credential is demonstrably working and a banner
            // saying otherwise would be false. The refusal is not a credential
            // signal and does not travel on that channel — it travels as PARTIAL,
            // `errorMessage`, the warn log and `integration.identity.deprovision.refused`.
            await clearAuthFailure(db, conn.id, conn.provider);
        });

        recordIdentityDeprovisioned({ provider: conn.provider, count: deprovisioned }); // H6 — spike = wrongful mass-deprovision
        if (refusal) {
            // The counter above cannot carry this: it early-returns on `count <=
            // 0`, so a refusal — whose count is zero by definition — emitted
            // nothing at all. A held mass-deprovision was the one event in this
            // function with no metric, which is the opposite of the intent.
            recordDeprovisionRefused({ provider: conn.provider, reason: refusalReason ?? 'share_cap' });
            logger.warn('identity-sync deprovision reconcile REFUSED — accounts left as-is, run marked PARTIAL', {
                component: 'identity-sync',
                tenantId: ctx.tenantId,
                provider: conn.provider,
                executionId,
                upserted,
                proposed: wouldDeprovision,
                reason: refusalReason,
            });
        } else {
            logger.info('identity-sync complete', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId, upserted, deprovisioned });
        }
        return {
            executionId,
            status,
            upserted,
            deprovisioned,
            errorMessage: refusal ?? undefined,
            provider: conn.provider,
        };
    } catch (e) {
        // A WRITE failed: a chunk that ran out of budget, a pool that would not
        // yield, a constraint. The execution row is already on disk saying
        // RUNNING, so finish it here — in a transaction the failure has not
        // closed. This is the arm the old shape could not have had: there the
        // RUNNING row lived inside the transaction that had just died.
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        await shortTx((db) =>
            db.integrationExecution.update({
                where: { id: executionId },
                data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, deprovisioned: 0, writePhaseFailed: true }, durationMs: Date.now() - start, completedAt: new Date() },
            }),
        );
        logger.error('identity-sync write phase failed — execution recorded as ERROR', { component: 'identity-sync', tenantId: ctx.tenantId, provider: conn.provider, executionId, upserted, error: msg });
        // NO `noRetry` here. Unlike the deterministic truncation arms above, a
        // write that ran out of budget or lost the pool is exactly the shape a
        // retry fixes, so the queue must stay free to try again.
        return { executionId, status: 'ERROR', upserted, deprovisioned: 0, errorMessage: msg, provider: conn.provider };
    }
}
