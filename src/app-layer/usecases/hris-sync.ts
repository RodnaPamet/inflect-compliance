/**
 * hris-sync (PR-4) — sync an HRIS roster (BambooHR) into Employee.
 *
 * Idempotent by (tenantId, workEmail). Two passes: upsert every employee,
 * then resolve managerEmail → managerEmployeeId (map workEmail → id). Records
 * ONE IntegrationExecution. Tenant-scoped (runInTenantContext, no global
 * prisma). Mirrors identity-sync.
 *
 * ═══ THE RUN IS SEVERAL TRANSACTIONS, NOT ONE (#2501) ═══
 *
 * This whole function used to be a single `runInTenantContext` callback — one
 * Prisma interactive transaction on the 5,000 ms runtime default, with the
 * provider's HTTPS roster read inside it. `integrations/sync-transaction.ts`
 * carries the full account; the part that governs how to read the code below
 * is the ORDER:
 *
 *   1. a short transaction opens the run and commits the `RUNNING` row;
 *   2. the provider read happens with NO transaction open;
 *   3. bounded write transactions carry the upserts, the manager links and
 *      the reconcile;
 *   4. a short transaction finalises the execution row.
 *
 * Every failure arm from step 2 onwards therefore writes its `ERROR` row in a
 * transaction of its own, on a client the failure has not closed. A blown
 * budget now LEAVES EVIDENCE, where before it rolled away the `RUNNING` row
 * and the `ERROR` row together and the run's only observable was an absence.
 */
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context-system';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { markAuthFailure, clearAuthFailure } from '../integrations/connection-health';
import { shouldBypassQueueRetry } from '../integrations/http-resilience';
import { decryptField, encryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { recordSyncTruncated } from '@/lib/observability/integration-metrics';
import {
    chunk,
    SYNC_BOOKKEEPING_TX_OPTIONS,
    SYNC_UPSERT_CHUNK_SIZE,
    SYNC_WRITE_TX_OPTIONS,
} from '../integrations/sync-transaction';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { registry } from '../integrations/registry';
import { isHrisSyncProvider, isHrisProviderId, type HrisSyncProvider, type NormalizedEmployee } from '../integrations/providers/hris';

function makeSystemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'hris-sync' });
}

/** Employees pulled into the manager map in one statement. */
const MANAGER_MAP_TAKE = 10000;

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
    /**
     * `SKIPPED` is set by the JOB, not this usecase: another run already holds
     * the connection's sync lock. Distinct from PASSED because nothing ran, and
     * distinct from ERROR because nothing is wrong.
     */
    status: 'PASSED' | 'ERROR' | 'PARTIAL' | 'SKIPPED';
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

    /**
     * A handful of statements, no provider round trip. Everything whose job is
     * to be DURABLE rather than fast goes through here: the RUNNING row, every
     * ERROR row, a rotated secret, the final status.
     */
    const shortTx = <T>(fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
        runInTenantContext(ctx, fn, SYNC_BOOKKEEPING_TX_OPTIONS);
    /** One bounded batch of row writes — at most SYNC_UPSERT_CHUNK_SIZE of them. */
    const writeTx = <T>(fn: (db: PrismaTx) => Promise<T>): Promise<T> =>
        runInTenantContext(ctx, fn, SYNC_WRITE_TX_OPTIONS);

    // ── 1. Open the run ──────────────────────────────────────────────────
    // Committed BEFORE the provider read, which is the entire point: from here
    // on there is a row on disk saying this run started.
    const opened = await shortTx(async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: input.connectionId, tenantId: ctx.tenantId },
            select: { id: true, provider: true, configJson: true, secretEncrypted: true, syncCursor: true, syncPassStartedAt: true },
        });
        if (!conn || !isHrisProviderId(conn.provider)) {
            const execution = await db.integrationExecution.create({
                data: { tenantId: ctx.tenantId, provider: conn?.provider ?? 'hris', automationKey: 'hris.sync', status: 'ERROR', errorMessage: 'HRIS connection not found', triggeredBy: 'scheduled', completedAt: now },
            });
            return { ok: false as const, executionId: execution.id };
        }
        const execution = await db.integrationExecution.create({
            data: { tenantId: ctx.tenantId, connectionId: conn.id, provider: conn.provider, automationKey: `${conn.provider}.sync`, status: 'RUNNING', triggeredBy: 'scheduled', executedAt: now },
        });
        return { ok: true as const, conn, executionId: execution.id };
    });
    if (!opened.ok) {
        return { executionId: opened.executionId, status: 'ERROR', upserted: 0, managersLinked: 0, errorMessage: 'HRIS connection not found' };
    }
    const { conn, executionId } = opened;

    const config = (conn.configJson ?? {}) as Record<string, unknown>;
    const secrets: Record<string, unknown> = conn.secretEncrypted ? (JSON.parse(decryptField(conn.secretEncrypted)) as Record<string, unknown>) : {};

    const resolved = input.provider ?? registry.getProvider(conn.provider);
    if (!resolved || !isHrisSyncProvider(resolved)) {
        await shortTx((db) => db.integrationExecution.update({ where: { id: executionId }, data: { status: 'ERROR', errorMessage: 'Provider does not support HRIS sync', completedAt: new Date() } }));
        return { executionId, status: 'ERROR', upserted: 0, managersLinked: 0, errorMessage: 'Provider does not support HRIS sync' };
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

    // ── 2. The provider read — outside every transaction ─────────────────
    // For Workday this is up to ten sequential HTTPS fetches, each budgeted at
    // 30 s and each able to absorb a 60 s Retry-After sleep in-process. Held
    // inside an interactive transaction it pinned a Postgres backend — and,
    // through PgBouncer, a pooled server connection — for all of that, and blew
    // the 5 s default long before the read returned.
    try {
        const res = await resolved.listEmployees({ ...config, ...secrets }, conn.syncCursor, {
            // Persist a rotated credential the MOMENT it rotates, not when
            // the read returns. An OAuth2 provider invalidates the old
            // refresh token on rotation, so if the roster read throws
            // afterwards and we only persisted on success, the connection
            // is left holding a dead token — and reports it two runs later
            // as a revoked grant, long after the run that lost it.
            //
            // A PATCH merged over the decrypted secret: the provider was
            // handed config and secrets merged and cannot tell them apart,
            // so it states only what changed and the split stays here.
            //
            // Its own short transaction, opened and committed mid-read.
            //
            // BE PRECISE ABOUT WHAT THAT BUYS, because the obvious claim is
            // wrong: under the old single transaction an ordinary provider
            // error did NOT lose the rotated secret. This usecase catches
            // provider errors and returns normally, so the transaction
            // COMMITTED and the persist stood. What lost it was the
            // transaction ABORTING — the blown budget, or a throw that
            // escaped the callback entirely. Those are the same long, paging,
            // token-rotating reads this callback exists for, which is why the
            // hole was worth closing, but it was never every failure.
            persistSecret: async (patch) => {
                Object.assign(secrets, patch);
                await shortTx((db) =>
                    db.integrationConnection.update({
                        where: { id: conn.id },
                        data: { secretEncrypted: encryptField(JSON.stringify(secrets)) },
                    }),
                );
            },
        });
        roster = res.employees;
        complete = res.complete;
        resumeToken = res.resumeToken ?? null;
    } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        await shortTx(async (db) => {
            await db.integrationExecution.update({ where: { id: executionId }, data: { status: 'ERROR', errorMessage: msg, durationMs: Date.now() - start, completedAt: new Date() } });
            // Surface a REVOKED CREDENTIAL on the connection itself; no-op for
            // anything that is not an IntegrationAuthError (401/403).
            await markAuthFailure(db, conn.id, e, now, conn.provider);
        });
        // This usecase CATCHES the provider error, so the classification has
        // to ride the result or the queue-level bypass never sees it.
        return { executionId, status: 'ERROR', upserted: 0, managersLinked: 0, errorMessage: msg, noRetry: shouldBypassQueueRetry(e) };
    }

    // Declared outside the try so the write-failure arm can report what
    // actually landed before it broke. Reporting 0 there would describe a
    // half-written pass as a run that did nothing.
    let upserted = 0;
    let managersLinked = 0;

    // ── 3. The write phase ───────────────────────────────────────────────
    // Wrapped in a catch, because the RUNNING row is now COMMITTED. Before this
    // change a throw took that row down with it and the run left no trace at
    // all; now the row outlives the failure, so something has to finish it or
    // the connection shows a run that started and never ended.
    try {
        // Pass 1 — upsert each employee (no manager yet), one bounded
        // transaction per chunk.
        //
        // NOT ONE TRANSACTION ANY MORE, and the reconcile further down depends
        // on why that is still safe. What the reconcile needs is not that the
        // upserts commit WITH it but that every upsert of this pass has
        // ALREADY committed by the time it runs — which the sequencing gives:
        // a chunk that fails throws out of this block, and the reconcile is
        // never reached.
        //
        // What is genuinely given up is rolling committed upserts back when a
        // LATER step fails, and that direction is the safe one. Rows refreshed
        // with no reconcile keep whatever status the roster reported, so the
        // mirror over-reports people as present. The reconcile is the half that
        // marks people TERMINATED, and it cannot run on its own.
        for (const group of chunk(roster, SYNC_UPSERT_CHUNK_SIZE)) {
            upserted += await writeTx(async (db) => {
                let n = 0;
                for (const e of group) { // guardrail-allow: n+1 — per-employee upsert, bounded by SYNC_UPSERT_CHUNK_SIZE
                    if (!e.workEmail) continue;
                    await db.employee.upsert({
                        where: { tenantId_workEmail: { tenantId: ctx.tenantId, workEmail: e.workEmail } },
                        create: { tenantId: ctx.tenantId, externalId: e.externalId, fullName: e.fullName, workEmail: e.workEmail, status: e.status, department: e.department ?? null, jobTitle: e.jobTitle ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null, source: 'HRIS', syncedAt: now },
                        update: { externalId: e.externalId, fullName: e.fullName, status: e.status, department: e.department ?? null, jobTitle: e.jobTitle ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null, source: 'HRIS', syncedAt: now },
                    });
                    n += 1;
                }
                return n;
            });
        }

        // Pass 2 — resolve managers by email (one query, in-memory map — no N+1).
        // The read runs after every upsert chunk has committed, so employees
        // this run created are already in the map.
        const emailToId = new Map<string, string>();
        const all = await shortTx((db) => db.employee.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, workEmail: true }, take: MANAGER_MAP_TAKE }));
        for (const r of all) emailToId.set(r.workEmail.toLowerCase(), r.id);
        // Resolved in memory BEFORE any transaction opens, so the write
        // transactions below carry writes only. Deciding what to link is not
        // work a held transaction should be paying for.
        const managerLinks: Array<{ selfId: string; managerId: string }> = [];
        for (const e of roster) {
            if (!e.managerEmail) continue;
            const managerId = emailToId.get(e.managerEmail.toLowerCase());
            const selfId = emailToId.get(e.workEmail.toLowerCase());
            if (!managerId || !selfId || managerId === selfId) continue;
            managerLinks.push({ selfId, managerId });
        }
        for (const group of chunk(managerLinks, SYNC_UPSERT_CHUNK_SIZE)) {
            await writeTx(async (db) => {
                for (const link of group) { // guardrail-allow: n+1 — bounded manager-link update
                    await db.employee.update({ where: { id: link.selfId }, data: { managerEmployeeId: link.managerId } });
                }
            });
            managersLinked += group.length;
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
                //
                // The cursor is stored AFTER the upserts commit. The other
                // order advances the pass past rows that then roll back, and
                // the next run resumes beyond employees nothing ever wrote.
                await shortTx((db) =>
                    db.integrationConnection.updateMany({
                        where: { id: conn.id },
                        data: { syncCursor: resumeToken, syncPassStartedAt: passStartedAt },
                    }),
                );
                const msg = `Partial HRIS roster (${roster.length} employees this run); pass continues from the stored cursor on the next run.`;
                await shortTx(async (db) => {
                    await db.integrationExecution.update({
                        where: { id: executionId },
                        data: {
                            status: 'PASSED',
                            errorMessage: null,
                            resultJson: { upserted, managersLinked, departed: 0, total: roster.length, partial: true, resuming: true },
                            durationMs: Date.now() - start,
                            completedAt: new Date(),
                        },
                    });
                    await clearAuthFailure(db, conn.id, conn.provider);
                });
                logger.info('hris-sync partial — cursor stored, pass continues', {
                    component: 'hris-sync',
                    tenantId: ctx.tenantId,
                    provider: conn.provider,
                    executionId,
                    upserted,
                    passStartedAt,
                });
                return { executionId, status: 'PARTIAL', upserted, managersLinked, errorMessage: msg };
            }

            // NOT resumable — unchanged behaviour. Loud and non-retryable,
            // because re-reading truncates at the same place.
            const msg = `Partial HRIS roster: hit the ${roster.length}-employee cap with more rows available, and this provider cannot resume. Departure reconcile skipped.`;
            await shortTx((db) =>
                db.integrationExecution.update({
                    where: { id: executionId },
                    data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, managersLinked, total: roster.length, truncated: true }, durationMs: Date.now() - start, completedAt: new Date() },
                }),
            );
            logger.warn('hris-sync partial roster — departure reconcile skipped', { component: 'hris-sync', tenantId: ctx.tenantId, executionId, upserted });
            // Loud, but NOT retryable: the cap is deterministic, so a retry
            // re-reads the same too-large roster and truncates identically.
            return { executionId, status: 'ERROR', upserted, managersLinked, errorMessage: msg, noRetry: true };
        }

        // H3 — departed-employee reconcile: a source=HRIS employee absent from a
        // COMPLETE roster was DELETED in the HRIS (not just terminated) and would
        // otherwise stay ACTIVE forever, invisible to offboarding. Mark them
        // TERMINATED.
        //
        // GUARDED ON THE PASS SEEING ROWS, NOT THIS RUN. The guard used to read
        // `roster.length > 0` — correct while a pass was exactly one run, and
        // quietly wrong the moment resume made it several. `roster` now holds
        // only the LAST run's slice, and the last run of a pass reads an empty
        // final page whenever the roster size is an exact multiple of the
        // per-run cap: the provider requests from an offset at the end of the
        // report, gets zero rows, and correctly reports `complete: true` with
        // nothing in hand.
        //
        // With the old guard that pass would clear its cursor, report PASSED,
        // and NEVER reconcile — permanently, every night, for that tenant.
        // Deleted employees stay ACTIVE forever, which is precisely the state
        // this reconcile exists to prevent, and it fails silently on a roster
        // size nobody would think to vary while debugging.
        //
        // `syncPassStartedAt` being set is the pass-level evidence the run-level
        // count cannot give: an earlier run of THIS pass read a full page, so
        // the API is answering and the empty final page is the end of the
        // report rather than the glitch the guard was written for. A first-run
        // empty roster still skips, which is the case that mattered originally.
        //
        // Reconciles on `syncedAt < passStartedAt`, NOT `workEmail: { notIn:
        // seenEmails }`. That was correct only while a pass was a single run.
        // Under resume `roster` holds just the LAST run's slice, so a notIn
        // reconcile would terminate every employee upserted by every earlier
        // run of the same pass — the wrongful-mass-termination failure this
        // whole area exists to prevent, introduced BY the resume feature.
        //
        // Anything not touched since the pass BEGAN was absent from the roster
        // across every run of that pass, so it is genuinely gone.
        //
        // THE RECONCILE AND THE CURSOR CLEAR SHARE ONE TRANSACTION, and that
        // is the one pairing this function still cannot do without. A reconcile
        // that commits while the cursor survives leaves the next run resuming a
        // pass that already terminated its departures; a cursor cleared while
        // the reconcile is lost closes the pass with the departures never
        // marked. Both are silent, so they stay atomic.
        // Boolean(), not `!== null`: an earlier-run marker is absent as either
        // null or undefined depending on the caller, and `!== null` reads
        // undefined as "resumed" — which would make the guard unconditional
        // and reinstate the mass-terminate it exists to prevent.
        const passSawRows = roster.length > 0 || Boolean(conn.syncPassStartedAt);
        const departed = await writeTx(async (db) => {
            let count = 0;
            if (passSawRows) {
                const res = await db.employee.updateMany({
                    where: { tenantId: ctx.tenantId, source: 'HRIS', status: { not: 'TERMINATED' }, syncedAt: { lt: passStartedAt } },
                    data: { status: 'TERMINATED', syncedAt: now },
                });
                count = res.count;
            }
            // The pass is done — clear the cursor so the next run starts fresh.
            // Left set, the next run would resume a pass that already reconciled.
            await db.integrationConnection.updateMany({
                where: { id: conn.id },
                data: { syncCursor: null, syncPassStartedAt: null },
            });
            return count;
        });

        await shortTx(async (db) => {
            await db.integrationExecution.update({
                where: { id: executionId },
                data: { status: 'PASSED', resultJson: { upserted, managersLinked, departed, total: roster.length }, durationMs: Date.now() - start, completedAt: new Date() },
            });
            // Clear unconditionally on success — a stale "credential revoked"
            // banner is worse than none, because it trains people to ignore it.
            await clearAuthFailure(db, conn.id, conn.provider);
        });
        logger.info('hris-sync complete', { component: 'hris-sync', tenantId: ctx.tenantId, executionId, upserted, managersLinked, departed });

        return { executionId, status: 'PASSED', upserted, managersLinked };
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
                data: { status: 'ERROR', errorMessage: msg, resultJson: { upserted, managersLinked, writePhaseFailed: true }, durationMs: Date.now() - start, completedAt: new Date() },
            }),
        );
        logger.error('hris-sync write phase failed — execution recorded as ERROR', { component: 'hris-sync', tenantId: ctx.tenantId, executionId, upserted, error: msg });
        // NO `noRetry` here. Unlike the deterministic truncation arms above, a
        // write that ran out of budget or lost the pool is exactly the shape a
        // retry fixes, so the queue must stay free to try again.
        return { executionId, status: 'ERROR', upserted, managersLinked, errorMessage: msg };
    }
}
