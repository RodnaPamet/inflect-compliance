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
    ROSTER_READ_DEADLINE_MS,
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

/**
 * Refuse the departure reconcile when it would mark more than this share of
 * the tenant's live HRIS-sourced employees TERMINATED.
 *
 * ═══ WHAT `passSawRows` CANNOT SEE ═══
 *
 * The guard below it already refuses the catastrophic shape: a complete-but-
 * EMPTY roster does not wipe the workforce. What it cannot see is a roster
 * that came back PARTIAL-BUT-PLAUSIBLE — rows arrived, so the pass "saw rows",
 * but the set is a subset of the real workforce.
 *
 * That is the normal shape of a SCOPING change, not an exotic one: a
 * department-scoped feed, a report filter edited in the HRIS, a BambooHR
 * custom report whose criteria changed, a Workday RaaS template narrowed. And
 * it is the shape a TRANSFER produces — a person who moves between business
 * units leaves one roster and appears in another. At the `updateMany` this
 * rail guards, absence from the feed and departure from the company are the
 * same fact, so a transfer is indistinguishable from a leaver.
 *
 * ═══ WHY THAT IS NOT A MIRROR-ONLY PROBLEM ═══
 *
 * `Employee.status` is not an internal bookkeeping column. `identity-leaver-
 * pass` selects exactly `status: 'TERMINATED'`, and on a tenant at AUTOMATIC
 * that drives a real `accountEnabled: false` against Entra or a
 * `userAccountControl` write against a domain controller, unattended. That
 * path is not hypothetical — a real AD account was disabled by the scheduled
 * 05:00 pass (#2749). So a wrong row here becomes a locked-out employee one
 * hop later, which is why this reconcile needs a rail of its own rather than
 * relying on the one in front of the directory write.
 *
 * ═══ THE NUMBER IS THE SIBLING RECONCILE'S, THE CONSTANT IS NOT ═══
 *
 * `MAX_DEPROVISION_SHARE` in `identity-sync.ts` is 0.1, and that rail answers
 * the structurally identical question one table over: "is this sweep too large
 * a slice of what the pass still calls live to be a real event?" Inventing a
 * third threshold for the same question would leave an operator holding three
 * numbers with nothing to tell them apart, so the VALUE is deliberately the
 * same. (`identity-sync.ts` makes this argument about the write breaker's
 * `MAX_DISABLE_SHARE`; this is the same argument, one rail further out.)
 *
 * It is a SEPARATE CONSTANT for the reason given there: the cost of firing
 * differs per rail, so the numbers must be free to move apart without one
 * being retuned silently by an edit aimed at another.
 *
 * ═══ WHY PRODUCTION COULD NOT CHOOSE THE NUMBER ═══
 *
 * Measured read-only against `inflect_compliance` on 2026-09-24: the
 * `Employee` table holds ONE row across ten tenants, `source = 'MANUAL'`, and
 * `source = 'HRIS'` is ZERO. There is no enabled HRIS connection in
 * production at all — the two live `IntegrationConnection` rows are
 * `entra-id` and `active-directory`. (Positive control on the same
 * connection, so an empty answer is not a broken query: `Control` = 892,
 * `ConnectedIdentityAccount` = 37, `User` = 24, `Tenant` = 10, and the psql
 * role is superuser so FORCE RLS is not filtering the reads.)
 *
 * So there is no production denominator to tune against, and a number
 * presented as measured would be invented. What production DOES settle is
 * which rail binds at today's scale: the nearest real population, the 37
 * directory accounts across ten tenants, puts a typical tenant in single
 * digits, where 10% of the population is below `TERMINATE_SHARE_FLOOR` and
 * the share rule is silent by construction. At the only scale that exists
 * today the floor governs and this cap costs nothing; it is calibrated for
 * the first real roster, not for the fixtures.
 *
 * ═══ WHY A SHARE CAP AND NOT ALSO AN ABSOLUTE ONE ═══
 *
 * `checkDisableBlastRadius` pairs its share rule with `MAX_DISABLES_PER_RUN =
 * 50`, and that half does NOT transfer — the reason is the shape of this
 * count, not its size, and `identity-sync.ts` already writes it out for the
 * same reconcile shape.
 *
 * `proposed` in the write breaker counts an ACT and can go DOWN: an account
 * disabled today is not a candidate tomorrow. The number here counts a
 * STANDING BACKLOG — every HRIS row untouched since the pass began. Refusing
 * does not clear it: those rows keep their stale `syncedAt`, so the next pass
 * proposes the same set plus whatever has left since, and the count only
 * grows. An absolute cap over a monotonically growing count fires once and
 * then refuses forever while looking deliberate. That is #2290, which cost a
 * tenant its whole leaver path.
 *
 * The share rule latches the same way once it fires. The difference is that it
 * only fires on an anomaly — a tenth of a workforce vanishing between two
 * passes — and it is scale-free, so ordinary churn at any tenant size never
 * reaches it. A rail that holds after refusing is acceptable; a rail that
 * refuses ordinary operation and then holds is not.
 *
 * ═══ WHICH WAY IT FAILS ═══
 *
 * CLOSED, and the asymmetry is the whole argument. On refusal the employees
 * keep the status the roster last gave them, so the mirror over-reports people
 * as present: someone who really left stays ACTIVE and their directory account
 * is not disabled on schedule. That is a visible gap in offboarding, and it is
 * recoverable — the next pass that sees a correct roster reconciles them.
 *
 * The other direction is not recoverable on the same clock. A wrongful
 * TERMINATED is read by the 05:00 leaver pass before anybody reviews it, and
 * re-enabling a disabled account is a human action in the customer's
 * directory, not something a later sync undoes.
 */
export const MAX_TERMINATE_SHARE = 0.1;

/**
 * Below this many proposed terminations the share rule does not apply.
 *
 * Same reasoning and same value as `DEPROVISION_SHARE_FLOOR` and the write
 * breaker's `SHARE_RULE_FLOOR`: in an eight-person tenant one departure is
 * 12.5% and always will be, so a share rule without a floor refuses every
 * genuine leaver at the bottom end — and a rail that refuses correct input is
 * a rail operators switch off.
 *
 * WHAT COVERS THE SMALL TENANT INSTEAD is `passSawRows`, not this rule. A
 * four-person roster that comes back empty is refused there, on evidence the
 * share rule cannot see. The two rails are deliberately about different
 * failures: `passSawRows` catches a feed that returned NOTHING, this catches a
 * feed that returned a SUBSET.
 */
export const TERMINATE_SHARE_FLOOR = 5;

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
     *
     * `PARTIAL` NOW HAS A SECOND CAUSE: a COMPLETE roster whose departure
     * reconcile was REFUSED by the blast-radius rail (`MAX_TERMINATE_SHARE`).
     * The two are distinguishable on the execution row rather than here —
     * `resultJson.resuming` for the first, `resultJson.terminateRefused` for
     * the second — and they share this status for the same reason: the pass
     * produced usable output but knowingly left the mirror incomplete, which
     * is exactly what PASSED must not be allowed to say.
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
    /**
     * Employees this pass marked TERMINATED — ZERO when the blast-radius rail
     * refused, and absent on the arms that never reach the reconcile.
     *
     * Reported because `upserted` cannot stand in for it: a refused pass
     * upserts its whole roster and looks, on that number alone, exactly like a
     * pass that reconciled. Mirrors `IdentitySyncResult.deprovisioned`.
     */
    departed?: number;
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

    // ── 2. The provider read — outside every transaction, and on a clock ──
    // For Workday this is up to ten sequential HTTPS fetches, each budgeted at
    // 30 s and each able to absorb a 60 s Retry-After sleep in-process. Held
    // inside an interactive transaction it pinned a Postgres backend — and,
    // through PgBouncer, a pooled server connection — for all of that, and blew
    // the 5 s default long before the read returned (#2501).
    //
    // #2508 added the clock. Taking the read out of the transaction removed
    // the budget it was blowing and left it bounded by nothing at all, which
    // is a problem one layer up: the run holds this connection's lock lease,
    // and a read that outlasts the lease lets a second run start alongside it.
    // `readDeadlineAt` is measured from `start` — BEFORE the provider's own
    // token exchange, so everything the read phase spends is inside it.
    const readDeadlineAt = start + ROSTER_READ_DEADLINE_MS;
    try {
        const res = await resolved.listEmployees({ ...config, ...secrets }, conn.syncCursor, {
            readDeadlineAt,
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
                    // Both arms stay an INLINE OBJECT LITERAL naming every
                    // column, and what enforces that is NARROWER than it looks.
                    //
                    // `tests/guards/employee-status-single-write-seam` does NOT
                    // census this file's columns. It declares HRIS_SEAM (:60)
                    // but both column-census tests read PERSONNEL_SEAM (:254,
                    // :275); HRIS_SEAM appears only in the file-level census
                    // (:250), which asserts WHICH FILES write an Employee row,
                    // never which columns. Mutation-proved: replacing both arms
                    // with `...patch` leaves that guard at 4 passed, and so
                    // does appending a second `status` writer to this file.
                    // The same mutant in personnel.ts DOES redden it — the
                    // census works, it just never looks here.
                    //
                    // So the only thing pinning these two arms is
                    // tests/unit/hris-record-id-handle.test.ts, which counts
                    // the literal inside `functionBodyOf(runHrisSync)` — and a
                    // status writer added OUTSIDE that function is invisible to
                    // it too. Treat this as unguarded when editing: `status` is
                    // the column the 05:00 leaver pass keys on to disable real
                    // directory accounts.
                    //
                    // AND THIS FILE ALREADY HAS A SECOND `status` WRITER — the
                    // departure reconcile below writes `status: 'TERMINATED'`
                    // in one unbounded `updateMany`. So the single-writer rule
                    // the guard enforces on personnel.ts is already not true
                    // here; both writes look legitimate (one mirrors the
                    // roster, one reconciles absence), but a fix for the gap
                    // above has to allow exactly these two and redden a third,
                    // not assume one.
                    //
                    // `hrisRecordId` is LAST-WRITE-WINS like every other
                    // mirrored column: a row that stops reporting an id goes
                    // back to null rather than keeping a stale handle. A stale
                    // handle is the worse failure — a later write would address
                    // it, where null refuses.
                    await db.employee.upsert({
                        where: { tenantId_workEmail: { tenantId: ctx.tenantId, workEmail: e.workEmail } },
                        create: { tenantId: ctx.tenantId, externalId: e.externalId, hrisRecordId: e.hrisRecordId ?? null, fullName: e.fullName, workEmail: e.workEmail, status: e.status, department: e.department ?? null, jobTitle: e.jobTitle ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null, source: 'HRIS', syncedAt: now },
                        update: { externalId: e.externalId, hrisRecordId: e.hrisRecordId ?? null, fullName: e.fullName, status: e.status, department: e.department ?? null, jobTitle: e.jobTitle ?? null, startDate: e.startDate ?? null, endDate: e.endDate ?? null, source: 'HRIS', syncedAt: now },
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

        // The predicate the reconcile writes through, LIFTED TO A NAME so the
        // blast-radius count below and the `updateMany` are handed the same
        // object rather than two copies that can drift. Measuring one set and
        // writing another is how a rail ends up authorising a batch it never
        // looked at (#2498, in the leaver path).
        //
        // TENANT-SCOPED, not connection-scoped, and that is forced rather than
        // chosen: `Employee` carries no `connectionId` column (unlike
        // `ConnectedIdentityAccount`, whose reconcile IS per-connection). There
        // is nothing to scope by. What makes that safe is a rail one layer up —
        // `upsertIntegrationConnection` refuses a second ENABLED HRIS
        // connection per tenant, so the tenant's HRIS population and this
        // connection's population are the same set by construction. See
        // `tests/integration/hris-connection-cardinality.test.ts`, which exists
        // because two enabled HRIS connections would alternate nightly and each
        // terminate the other's whole population.
        const reconcileWhere = {
            tenantId: ctx.tenantId,
            source: 'HRIS',
            status: { not: 'TERMINATED' as const },
            syncedAt: { lt: passStartedAt },
        };

        // ═══ THE MEASURE, THE DECISION AND THE SWEEP ARE ONE TRANSACTION ═══
        //
        // The rail below judges a COUNT and then acts on it. Split across two
        // transactions a row could change status in between, and the number an
        // operator is shown would describe a different set from the one that
        // was swept. The cursor clear joins them for the reason already given.
        const outcome = await writeTx(async (db) => {
            let departed = 0;
            let proposed = 0;
            let refusal: string | null = null;
            let refusalReason: 'share_cap' | null = null;

            if (passSawRows) {
                // Counted with the reconcile's OWN predicate — the same object
                // the `updateMany` below is given.
                proposed = await db.employee.count({ where: reconcileWhere });

                // Nothing proposed is always allowed, and must be: a no-op
                // surfacing as a refusal teaches operators that refusals are
                // noise, and then the one that matters is ignored too.
                if (proposed > 0) {
                    // The denominator is what this tenant still calls live in
                    // the HRIS mirror AFTER this pass's upserts: rows the pass
                    // just confirmed, PLUS the stale rows the numerator is
                    // proposing to remove. Same table, same source, one
                    // predicate narrower — so the two halves of the fraction
                    // count the same kind of thing over the same set.
                    //
                    // Narrowing either half alone is not a cosmetic edit: a
                    // smaller numerator can only WITHDRAW a refusal, while a
                    // smaller denominator can newly CREATE one.
                    const livePopulation = await db.employee.count({
                        where: { tenantId: ctx.tenantId, source: 'HRIS', status: { not: 'TERMINATED' } },
                    });
                    // Unreachable by construction — the numerator's predicate
                    // is the denominator's plus `syncedAt`, so the population
                    // is never below it. Pinned anyway, and pinned to 1 rather
                    // than 0: an absent denominator must read as "the whole
                    // workforce" and refuse, never as "a small share" and
                    // allow.
                    const share = livePopulation > 0 ? proposed / livePopulation : 1;
                    if (proposed > TERMINATE_SHARE_FLOOR && share > MAX_TERMINATE_SHARE) {
                        refusalReason = 'share_cap';
                        refusal =
                            `Refusing to mark ${proposed} of ${livePopulation} HRIS employee(s) TERMINATED ` +
                            `(${(share * 100).toFixed(1)}%): the per-pass share cap is ` +
                            `${(MAX_TERMINATE_SHARE * 100).toFixed(0)}%. A slice of the workforce this large ` +
                            `disappearing from the roster between two passes is more likely a feed that ` +
                            `narrowed — a department-scoped report, an edited filter, a transfer to a ` +
                            `business unit served by another feed — than a real departure wave, and ` +
                            `TERMINATED is what makes an employee a candidate for a real directory disable ` +
                            `on the next leaver pass. The employees keep their current status until a human ` +
                            `has looked.`;
                    }
                }

                if (!refusal) {
                    const res = await db.employee.updateMany({
                        where: reconcileWhere,
                        data: { status: 'TERMINATED', syncedAt: now },
                    });
                    departed = res.count;
                }
            }
            // The pass is done — clear the cursor so the next run starts fresh.
            // Left set, the next run would resume a pass that already reconciled.
            //
            // CLEARED ON A REFUSAL TOO, and that is not tidiness. The roster
            // read finished; it is the reconcile that was held, so there is no
            // page left to resume. Leaving `syncPassStartedAt` set would also
            // pin `passStartedAt` to the refused pass's instant on every later
            // run — it is read from this column — so each subsequent pass would
            // keep widening the set it proposes while never advancing.
            await db.integrationConnection.updateMany({
                where: { id: conn.id },
                data: { syncCursor: null, syncPassStartedAt: null },
            });
            return { departed, proposed, refusal, refusalReason };
        });
        const { departed, proposed: terminateProposed, refusal, refusalReason } = outcome;

        await shortTx(async (db) => {
            await db.integrationExecution.update({
                where: { id: executionId },
                data: {
                    // PARTIAL, NOT PASSED, when the rail refused. The roster
                    // read succeeded and the upserts landed, so this is not an
                    // ERROR — but a pass whose reconcile was withheld has left
                    // the mirror knowingly incomplete, and PASSED is the one
                    // thing it must not say. A green badge over a held
                    // reconcile is a refusal nobody sees.
                    status: refusal ? ('PARTIAL' as const) : ('PASSED' as const),
                    // Carried ON THE ROW, because `IntegrationExecution` is the
                    // only durable record an operator reads — the warn log
                    // below is not one. `null` on the clean path, so a stale
                    // message never outlives the pass that wrote it.
                    errorMessage: refusal,
                    resultJson: {
                        upserted,
                        managersLinked,
                        departed,
                        total: roster.length,
                        ...(refusal ? { terminateRefused: refusalReason, terminateProposed } : {}),
                    },
                    durationMs: Date.now() - start,
                    completedAt: new Date(),
                },
            });
            // Clear unconditionally on success — a stale "credential revoked"
            // banner is worse than none, because it trains people to ignore it.
            //
            // Cleared on a refusal as well, deliberately: the roster read
            // succeeded, so the credential is demonstrably working and a
            // "credential revoked" banner would be false. The refusal is not a
            // credential signal and does not travel on that channel — it
            // travels as PARTIAL, `errorMessage`, and the warn log below.
            await clearAuthFailure(db, conn.id, conn.provider);
        });
        if (refusal) {
            logger.warn('hris-sync departure reconcile REFUSED — employees left as-is, run marked PARTIAL', {
                component: 'hris-sync',
                tenantId: ctx.tenantId,
                provider: conn.provider,
                executionId,
                upserted,
                proposed: terminateProposed,
                reason: refusalReason,
            });
        } else {
            logger.info('hris-sync complete', { component: 'hris-sync', tenantId: ctx.tenantId, executionId, upserted, managersLinked, departed });
        }

        return {
            executionId,
            status: refusal ? ('PARTIAL' as const) : ('PASSED' as const),
            upserted,
            managersLinked,
            departed,
            // Rides the result as well as the row: `jobs/hris-sync` returns
            // this straight to the queue, and a caller that only reads the
            // return would otherwise see a refusal as an ordinary pass.
            ...(refusal ? { errorMessage: refusal } : {}),
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
