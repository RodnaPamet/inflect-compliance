/**
 * The leaver pass: the first thing that actually assembles a batch.
 *
 * Everything below this line already existed and had no caller — the ladder, the
 * breaker, the link model, the write-target derivation, the journal, the two
 * writers, and the orchestration. This is the code path from "the HR feed says
 * this person has left" to those rails being asked their questions.
 *
 * ═══ THE CLAMP IS THE TOP RUNG. WRITES ARE LIVE-CAPABLE ═══
 *
 * `LEAVER_MAX_MODE` is `AUTOMATIC` as of 2026-08-30, so this module no longer
 * refuses any rung the ladder can reach. Read that line (below, at its
 * declaration) before reasoning about whether writes can happen — this header
 * said `DRY_RUN` for one revision after the constant moved, and two separate
 * analyses started from it and reached the wrong conclusion.
 *
 * Wiring a feature and moving a tenant to unattended writes are still two
 * decisions; what separates them is now the LADDER alone, not the clamp. A
 * tenant reaches PROPOSE or AUTOMATIC by elapsed time in DRY_RUN
 * (`DRY_RUN_MIN_DAYS`), one rung at a time, and starts at DISABLED. What the
 * clamp used to add — a blanket refusal above the second rung — is gone
 * deliberately, on the owner's instruction.
 *
 * So the rails below are now the whole of the protection, not a second layer
 * behind a ceiling: the blast-radius breaker, the account-protection flag, the
 * write-target rail, the self-lockout refusal, and — outside this repo — the
 * per-connection `writesEnabled` flag and the Entra consent without which a
 * live writer cannot be constructed.
 *
 * ═══ WHY LINK FRESHNESS IS ALSO THE COMPLETENESS GATE ═══
 *
 * Workday reports no completeness signal, so a termination inferred from ABSENCE
 * must never act. This pass never infers: it reads employees the feed explicitly
 * marks TERMINATED.
 *
 * The directory side has the same problem and it is solved upstream. Links are
 * stamped `lastVerifiedAt` ONLY by the reconciler, which runs ONLY after a sync
 * that returned `PASSED` — a confirmed-complete enumeration. So requiring a link
 * to be fresh IS requiring that a complete directory read happened recently.
 * There is deliberately no second completeness check here: one gate, held where
 * the evidence is produced, cannot drift from a copy of itself.
 *
 * ═══ THE UNIT IS (TENANT, PROVIDER) ═══
 *
 * Not per connection — still, though no longer for want of a column.
 * `ConnectedIdentityAccount.connectionId` is NOT NULL as of migration
 * `20260821170000_connected_identity_account_connection_required`, so every
 * account row now says which directory it came from. The WRITER is what is
 * still per (tenant, provider): with two enabled connections for one provider
 * the factory refuses outright rather than picking one and addressing a disable
 * at a forest the account may not live in. The unit becomes per-connection when
 * the factory resolves a writer per account — that is the only remaining step,
 * and the schema no longer blocks it.
 *
 * A soft-disabled connection does NOT reduce that count, and its account rows
 * are never swept — the deprovision reconcile is connection-scoped, so they
 * freeze holding whatever they last observed. What refuses to act on a frozen
 * row is not this unit choice but the age bound on the observation, which lives
 * in `resolveWriteTarget` (`identity-write-target.ts`) and is applied to the raw
 * timestamp the candidate carries whole (`identity-disable-account.ts`).
 *
 * @module usecases/identity-leaver-pass
 */
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { resolveDirectoryWriter, type WriterRefusal } from '../integrations/identity-writer-factory';
import { getIdentityWritePolicy } from './identity-write-policy';
import { OBSERVATION_FRESHNESS_MS } from './identity-write-target';
import { isAboveClamp } from '@/lib/identity/write-ladder';
import {
    disableAccountsForLeaver,
    findLeaverCandidates,
    type DisableAccountInput,
    type DisableOutcome,
    type DisableResult,
    type LeaverDisableResult,
} from './identity-disable-account';
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';
import { recordLeaverPassOutcome } from '@/lib/observability/integration-metrics';

/**
 * The highest rung this pass will act at.
 *
 * A constant rather than a config value on purpose: raising it must be a diff
 * somebody reviews, not a setting somebody flips. This is that diff.
 *
 * RAISED TO AUTOMATIC on the owner's instruction, 2026-08-30. What it does and
 * does not do, because the distinction is the whole safety story:
 *
 *   It does NOT make any tenant act. The clamp is a CEILING, and every tenant's
 *   own rung still governs — the ladder still refuses a two-step widen, still
 *   requires DRY_RUN_MIN_DAYS in dry run before leaving it, and still starts
 *   every tenant at DISABLED. The one live tenant is at DRY_RUN with its window
 *   open until 2026-09-05; this change does not move it and cannot.
 *
 *   What it DOES do is remove the ceiling that was making a widen inert. Before
 *   this, a tenant that climbed to PROPOSE or AUTOMATIC was refused by gate 1
 *   with no execution row — configured and silent. After it, a tenant that
 *   completes its dry-run window and widens will actually write to the
 *   directory.
 *
 * The rails below are what stand between that and a mistake: the blast-radius
 * breaker, the account-protection flag, the write-target rail, the self-lockout
 * refusal, and — outside this repo — the per-connection `writesEnabled` flag and
 * the Entra admin consent that a live writer cannot be constructed without.
 */
export const LEAVER_MAX_MODE = 'AUTOMATIC' as const;

/**
 * How recently a link must have been re-observed to be actable.
 *
 * An ALIAS, not a copy — see OBSERVATION_FRESHNESS_MS for the reasoning behind
 * the number. Both bounds ask whether the daily sync refreshed this row recently
 * enough, and a pass that accepted a link one bound calls fresh while the
 * write-target rail calls its observation stale would just refuse later, having
 * done the work.
 */
export const LINK_FRESHNESS_MS = OBSERVATION_FRESHNESS_MS;

/**
 * Bound on the per-decision detail carried into the execution report.
 *
 * Larger than anything reachable today on purpose. The blast-radius breaker
 * REFUSES a batch above MAX_DISABLES_PER_RUN (50) rather than trimming it, so a
 * pass produces 0 or at most 50 decisions — never 200. This is the bound that
 * keeps one JSON column from becoming unbounded if that ever changes, not a
 * limit anyone should expect to hit; a report that IS truncated says so, in the
 * row, rather than quietly ending early.
 */
export const MAX_REPORTED_DECISIONS = 200;

/**
 * The status of a pass, derived ONCE and read by both the row and the return.
 *
 * These were two expressions of the same fact sitting 400 lines apart, and they
 * disagreed: the row could be written `PARTIAL` while the value handed back to
 * the job was hardcoded `PASSED`. `executor-registry` carries that return
 * straight onto the job result, so a truncated pass reported itself complete to
 * everything downstream of the queue while its own artefact said otherwise.
 *
 * A helper rather than a variable threaded between them, because the two sites
 * cannot share one: the record is written inside a try/catch whose whole purpose
 * is that a failed write must not fail the pass, so on that path there is no
 * value to thread. Deriving from the same inputs at both ends makes them equal
 * by construction instead of by discipline — which is the property this
 * subsystem has now failed to hold three times.
 *
 * WHY EACH STATUS
 *
 * PARTIAL means "produced output, and that output is incomplete" — which is what
 * a truncated decision list is, and is NOT what a FAILED or INDETERMINATE
 * outcome is. Those are results the pass is reporting correctly, and they are in
 * `counts`.
 *
 * A REFUSED BATCH IS NOT A COMPLETE PASS. The breaker returns `results: []` for
 * the whole batch, so the row was once written as PASSED — which the badge
 * renders as "Ran — complete" beside an empty Refusal cell and a decision count
 * of 0. The one outcome that means "the pass deliberately did nothing because
 * the blast radius looked wrong" was the one that read as a clean night.
 *
 * NOT_APPLICABLE rather than ERROR for that refusal: nothing failed, and
 * `errorCount24h` counts `status: 'ERROR'` only, so ERROR would inflate a
 * diagnostics counter for a rail working exactly as designed. The WRITER_*
 * refusals record NOT_APPLICABLE with a non-zero candidate count, so this
 * follows the file's own precedent rather than the enum's empty-population
 * wording.
 *
 * The refusal check comes FIRST and that order is safe: `refused` is set at
 * exactly one place, and that return carries `results: []`, so a refusal and a
 * truncated decision list are mutually exclusive by construction — a real
 * PARTIAL cannot be masked by the branch above it.
 */
export function leaverPassStatus(
    refused: string | undefined,
    resultCount: number,
): LeaverPassRanStatus {
    if (refused) return 'NOT_APPLICABLE';
    return resultCount > MAX_REPORTED_DECISIONS ? 'PARTIAL' : 'PASSED';
}

/**
 * Suffix identifying a leaver pass among integration executions.
 *
 * Exported because the tenant-wide "automated checks" list EXCLUDES it. Two
 * reasons, and the second is the stronger one. A leaver pass is not a control
 * check — it is an offboarding action — so listing it beside evidence-producing
 * checks would misdescribe it to anyone reading that page. And that page is
 * reachable with `controls.view`, while everything else about the leaver rails
 * is gated at OWNER; letting the rows drift onto it would widen their audience
 * as a side effect of choosing where to store them.
 */
export const LEAVER_PASS_AUTOMATION_SUFFIX = '.leaver_pass';

/**
 * The durable record a dry run leaves behind.
 *
 * The seven-day observation window exists to be COMPARED against what HR and IT
 * actually did — the ladder's own refusal text says so — and until now a dry run
 * produced nothing to compare with. It decided, logged a histogram, and threw
 * every decision away. Worse, the promotion gate counts ELAPSED days since
 * dryRunSince rather than observed runs, so the window could be satisfied by
 * time passing while nobody watched anything.
 *
 * KEYED BY LINK ID, NEVER BY DIRECTORY IDENTIFIER. `IntegrationExecution` is not
 * encrypted at rest (the Epic B manifest is String-only, so a Json column cannot
 * join it) and its rows outlive the pass, so the identifier that goes in must be
 * one that means nothing outside an authorised read. The link id is tenant-scoped
 * and resolvable to a person only through the account it points at.
 *
 * And the reasons are SCRUBBED. `DisableResult.reason` is deliberately
 * un-redacted — it is written for an operator reading a tenant-scoped surface —
 * but a provider message routinely embeds the account: "Entra refused to disable
 * account <guid>", "No observed directory record for <id>". Persisting them
 * verbatim would put back exactly what keying by link id takes out.
 *
 * ONE TERMINAL ROW, not a RUNNING row updated later. The pass runs with
 * attempts: 1 and spans no transaction, so a two-phase write has a real orphan
 * mode: a process that dies mid-pass leaves a RUNNING row nothing will ever
 * finish, and an operator counting runs would read it as one that happened.
 */
async function recordPassExecution(
    ctx: RequestContext,
    provider: string,
    candidates: readonly DisableAccountInput[],
    results: readonly LeaverDisableResult[],
    summary: Record<string, unknown>,
    refused: string | undefined,
): Promise<void> {
    const identifierByLink = new Map(candidates.map((c) => [c.linkId, c.externalUserId]));
    const reported = results.slice(0, MAX_REPORTED_DECISIONS);
    const decisions = reported.map((r) => ({
        linkId: r.linkId,
        outcome: r.outcome,
        ...(r.reason
            ? { reason: redactDirectoryIdentifiers(r.reason, identifierByLink.get(r.linkId)) }
            : {}),
        // The BASIS goes in unscrubbed, and that is not an oversight. Every
        // reason above is a provider- or rail-authored SENTENCE, and sentences
        // embed the account they are about; a basis is an enum, a tri-state
        // boolean and a timestamp, and can name nothing. `DecisionBasis` says so
        // in its own docblock, which is the invariant to preserve if a field is
        // ever added to it.
        //
        // Recorded even though every decision in a DRY_RUN pass shares one
        // `reason` string. That is exactly why: the reason is fixed, so it
        // cannot distinguish an account the directory answered for from one
        // nothing has looked at yet — and after #2144 widened the rail, telling
        // those apart is the seven-day window's whole job.
        ...(r.basis ? { basis: r.basis } : {}),
    }));
    // Deliberately the SAME predicate `leaverPassStatus` applies, spelled the
    // same way. The row carries truncation as a flag as well as a status, and
    // the earlier `> reported.length` form was a second expression of the first
    // — provably equal, which is exactly the reasoning that let the status
    // itself drift.
    const truncated = results.length > MAX_REPORTED_DECISIONS;

    // Why each status: see `leaverPassStatus`. The choice is made there because
    // the value handed back to the job has to make the identical one.
    await writeExecutionRow(ctx, provider, leaverPassStatus(refused, results.length), {
        ...summary,
        ...(refused ? { refusal: 'BATCH_REFUSED' } : {}),
        decisions,
        decisionsTruncated: truncated,
    });
}

/**
 * A pass that ran and refused still ran.
 *
 * Every refusal after the ladder gate used to return before the record was
 * written, so the artefact could not distinguish "the pass ran and found nobody
 * to offboard" from "no pass ran at all" — and those are the two readings an
 * operator MUST be able to tell apart during a seven-day observation. The
 * silence looked identical either way, which is the same failure this subsystem
 * guards against everywhere else: a leaver pass that disables nobody and says
 * "done".
 *
 * NOT_APPLICABLE rather than PASSED, per the enum's own definition — "ran
 * cleanly but its applicable population was empty".
 *
 * The two LADDER refusals are deliberately excluded. A tenant with leaver writes
 * switched off is not observing, and should not accrue observation rows; a
 * tenant above the clamp is a configuration error that already logs a warning
 * and would otherwise mint a daily row implying it is being watched.
 */
async function recordRefusedPass(
    ctx: RequestContext,
    provider: string,
    refusal: LeaverPassRefusal,
    detail: string,
    summary: Record<string, unknown>,
): Promise<void> {
    await writeExecutionRow(ctx, provider, 'NOT_APPLICABLE', { ...summary, refusal, detail });
}

/**
 * Record a refusal, never letting the record's failure become the pass's.
 *
 * Same posture as the success path: a pass that has already decided must not be
 * reported as broken because a row could not be written. Wrapped here rather
 * than at each call site so the three refusals cannot drift apart on it.
 */
async function safeRecordRefusal(
    ctx: RequestContext,
    provider: string,
    refusal: LeaverPassRefusal,
    detail: string,
    summary: Record<string, unknown>,
): Promise<void> {
    try {
        await recordRefusedPass(ctx, provider, refusal, detail, summary);
    } catch (err) {
        logger.error('leaver pass refused but its record could not be written', {
            component: 'identity-leaver-pass',
            tenantId: ctx.tenantId,
            provider,
            refusal,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** The one place a leaver pass row is created, so both callers agree on its shape. */
async function writeExecutionRow(
    ctx: RequestContext,
    provider: string,
    status: LeaverPassRanStatus,
    // `Prisma.InputJsonValue`, not `Record<string, unknown>`. The two callers
    // used to pass object LITERALS, which Prisma accepted because their inferred
    // types were concrete; hoisting the create into one helper widened the
    // parameter and broke assignability. Typing it as Prisma's own input type
    // keeps the single-writer refactor without a cast at either call site.
    resultJson: Prisma.InputJsonValue,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                provider,
                automationKey: `${provider}${LEAVER_PASS_AUTOMATION_SUFFIX}`,
                status,
                triggeredBy: 'scheduled',
                completedAt: new Date(),
                resultJson,
            },
        }),
    );
}

/** Bound on how many passes one read returns. A daily job over a short window. */
const MAX_LISTED_PASSES = 100;

/**
 * The passes a tenant has run, most recent first — the read half of the record.
 *
 * Deliberately NOT served by the tenant-wide "automated checks" list, which
 * excludes this automationKey: that page is reachable with `controls.view`,
 * while the authority to run these passes at all is OWNER-only. A record that
 * widened its own audience by being stored in a shared table would be a strange
 * way to observe a control.
 *
 * Returns `resultJson` verbatim, because the per-decision list IS the artefact —
 * a summary of a summary would defeat the point of persisting one. Every
 * identifier in it is already a link id, and every reason was scrubbed on the
 * way in.
 */
export async function listLeaverPasses(
    ctx: RequestContext,
    options: { limit?: number } = {},
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: {
                tenantId: ctx.tenantId,
                automationKey: { endsWith: LEAVER_PASS_AUTOMATION_SUFFIX },
            },
            select: {
                id: true,
                provider: true,
                status: true,
                executedAt: true,
                completedAt: true,
                resultJson: true,
            },
            orderBy: { executedAt: 'desc' },
            take: Math.min(options.limit ?? MAX_LISTED_PASSES, MAX_LISTED_PASSES),
        }),
    );
}

/**
 * Mirrors the `IntegrationExecution.status` values a pass can persist.
 *
 * PARTIAL is the one that was missing. It means "ran, produced output, and that
 * output is incomplete" — today only a truncated decision list, which the
 * blast-radius breaker makes unreachable by refusing above 50 rather than
 * trimming to 200. Unreachable is not the same as impossible, and the two ways
 * it becomes reachable are both ordinary: raise MAX_DISABLES_PER_RUN, or lower
 * MAX_REPORTED_DECISIONS. Either is a one-line change nobody would think to
 * cross-check against a union in another part of the file.
 */
export type LeaverPassStatus = 'PASSED' | 'PARTIAL' | 'NOT_APPLICABLE' | 'ERROR';

/**
 * Every status a pass that RAN can produce — the full union minus `ERROR`.
 *
 * `ERROR` belongs to the catch path, which reports a pass that threw and never
 * reached a decision. Keeping it out of this type is what lets the compiler
 * check the distinction rather than a comment assert it: `writeExecutionRow`
 * takes this type, so a future edit that tries to persist `ERROR` through the
 * normal path fails to compile instead of writing a row that inflates
 * `errorCount24h`.
 *
 * Derived with `Exclude` rather than spelled out again, so widening
 * `LeaverPassStatus` widens this in the same edit. Spelling it out is how the
 * two ternaries this file just consolidated came to disagree.
 */
export type LeaverPassRanStatus = Exclude<LeaverPassStatus, 'ERROR'>;

export type LeaverPassRefusal =
    | 'MODE_DISABLED'
    | 'MODE_ABOVE_CLAMP'
    | 'NO_TERMINATED_WORKERS'
    | 'NO_FRESH_LINKS'
    // The breaker refused the WHOLE batch. Distinct from every refusal above:
    // those stop before any decision is made, this one stops after the pass has
    // looked at a real population and judged the blast radius wrong.
    | 'BATCH_REFUSED'
    | `WRITER_${WriterRefusal}`;

export interface LeaverPassResult {
    readonly status: LeaverPassStatus;
    readonly mode: string;
    readonly refusal?: LeaverPassRefusal;
    readonly detail?: string;
    readonly counts: Partial<Record<DisableOutcome, number>>;
    readonly terminatedWorkers: number;
    readonly candidates: number;
    readonly population: number;
    readonly batchRefused?: string;
    readonly errorMessage?: string;
}

function tally(results: readonly DisableResult[]): Partial<Record<DisableOutcome, number>> {
    const counts: Partial<Record<DisableOutcome, number>> = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    return counts;
}

function refused(
    mode: string,
    refusal: LeaverPassRefusal,
    detail: string,
    over: Partial<LeaverPassResult> = {},
): LeaverPassResult {
    return {
        status: 'NOT_APPLICABLE',
        mode,
        refusal,
        detail,
        counts: {},
        terminatedWorkers: 0,
        candidates: 0,
        population: 0,
        ...over,
    };
}

/**
 * Run one leaver pass for one (tenant, provider).
 *
 * Never throws. Every failure is a status on the result, because the caller is a
 * fan-out over tenants and one tenant's broken connection must not end the run
 * for the rest.
 */
export async function runIdentityLeaverPass(input: {
    tenantId: string;
    provider: string;
    now?: Date;
}): Promise<LeaverPassResult> {
    const now = input.now ?? new Date();
    // `context-system`, never `context` — the latter reaches @/lib/auth -> @/auth
    // and dies in the worker, which has no Next request to hang a session on.
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'identity-leaver-pass' });

    try {
        // ── 1. The ladder. Cheapest gate, and the one that must never be skipped.
        const policy = await getIdentityWritePolicy(ctx);
        const mode = policy.leaver.mode;

        if (mode === 'DISABLED') {
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'mode_disabled' });
            return refused(mode, 'MODE_DISABLED', 'Leaver writes are switched off for this tenant.');
        }
        if (isAboveClamp(mode, LEAVER_MAX_MODE)) {
            // The clamp. Not an error — a deliberate ceiling — but loud,
            // because a tenant configured above it and seeing nothing happen
            // deserves to find out why from a log rather than from an
            // offboarding that quietly never ran.
            //
            // ORDINAL, never `mode !== LEAVER_MAX_MODE`. That inequality was
            // correct only by coincidence: with the clamp at the second rung,
            // the sole mode that is neither DISABLED (handled above) nor equal
            // to it happened to be a higher one. Raise the clamp and the
            // coincidence breaks the other way — a tenant at DRY_RUN, BELOW an
            // AUTOMATIC clamp, would fail `!==` and be refused MODE_ABOVE_CLAMP,
            // which records no execution row. The dry run would stop dead and
            // the passes page would go blank with nothing saying why.
            logger.warn('leaver pass clamped below the tenant’s configured mode', {
                component: 'identity-leaver-pass',
                tenantId: ctx.tenantId,
                provider: input.provider,
                configuredMode: mode,
                clamp: LEAVER_MAX_MODE,
            });
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'mode_above_clamp' });
            return refused(
                mode,
                'MODE_ABOVE_CLAMP',
                `This tenant is configured at ${mode}, but the leaver pass is clamped at ${LEAVER_MAX_MODE} ` +
                    'until it has been observed in the field. Wiring the pass and granting it unattended ' +
                    'authority are separate decisions, and no tenant has yet watched a single pass.',
            );
        }

        // ── 2. Who the FEED says has left. Never inferred from absence.
        const terminated = await runInTenantContext(ctx, (db) =>
            db.employee.findMany({
                where: { tenantId: ctx.tenantId, status: 'TERMINATED' },
                select: { id: true },
                // Bounded: past this, the roster is not a departure wave, and the
                // breaker downstream refuses a batch this size anyway.
                take: 5000,
            }),
        );
        if (terminated.length === 0) {
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'no_terminated' });
            const detail = 'No worker is marked TERMINATED in the HR feed.';
            await safeRecordRefusal(ctx, input.provider, 'NO_TERMINATED_WORKERS', detail, {
                mode,
                terminatedWorkers: 0,
            });
            return refused(mode, 'NO_TERMINATED_WORKERS', detail);
        }

        // ── 3. Which of their accounts we have OBSERVED recently enough to act on.
        const staleBefore = new Date(now.getTime() - LINK_FRESHNESS_MS);
        const candidates = await findLeaverCandidates(
            ctx,
            input.provider,
            terminated.map((e) => e.id),
            staleBefore,
        );
        if (candidates.length === 0) {
            // Distinct from "nobody left". An empty candidate set with terminated
            // workers present means the link table is stale or empty — which is
            // exactly the silent-nothing failure this subsystem is most prone to.
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'no_fresh_links' });
            const detail =
                `${terminated.length} terminated worker(s), but none has a directory link re-observed since ` +
                `${staleBefore.toISOString()}. Either the identity sync has not completed recently, or ` +
                'these workers hold no account this product has matched to them.';
            // The most important refusal to record. This is the shape of the
            // silent-nothing failure: terminated workers present, nobody
            // offboarded, and a green pass. An operator watching the seven days
            // needs it to appear as a run that happened.
            await safeRecordRefusal(ctx, input.provider, 'NO_FRESH_LINKS', detail, {
                mode,
                terminatedWorkers: terminated.length,
            });
            return refused(mode, 'NO_FRESH_LINKS', detail, { terminatedWorkers: terminated.length });
        }

        // ── 4. The population the breaker measures the batch against.
        const population = await runInTenantContext(ctx, (db) =>
            db.connectedIdentityAccount.count({
                where: { tenantId: ctx.tenantId, provider: input.provider },
            }),
        );

        // ── 5. The writer. DRY_RUN gets the snapshot reader and no socket.
        const resolution = await resolveDirectoryWriter({ ctx, provider: input.provider, mode });
        if (resolution.kind === 'none') {
            recordLeaverPassOutcome({ provider: input.provider, outcome: 'writer_refused' });
            await safeRecordRefusal(
                ctx,
                input.provider,
                `WRITER_${resolution.refusal}`,
                resolution.detail,
                { mode, terminatedWorkers: terminated.length, candidates: candidates.length, population },
            );
            return refused(mode, `WRITER_${resolution.refusal}`, resolution.detail, {
                terminatedWorkers: terminated.length,
                candidates: candidates.length,
                population,
            });
        }

        try {
            const outcome = await disableAccountsForLeaver(ctx, resolution.writer, {
                candidates,
                population,
            });
            const counts = tally(outcome.results);

            logger.info('leaver pass complete', {
                component: 'identity-leaver-pass',
                tenantId: ctx.tenantId,
                provider: input.provider,
                mode,
                evidence: resolution.kind,
                terminatedWorkers: terminated.length,
                candidates: candidates.length,
                population,
                batchRefused: outcome.refused ?? null,
                counts,
            });

            // AFTER the counters and the log line, and inside the try so the
            // writer is still closed by the finally below. A failed insert must
            // not turn a completed pass into an ERROR — the directory decisions
            // are already made and already reported; losing the record of them
            // is worth an alert, not a retry of a pass that ran.
            try {
                await recordPassExecution(
                    ctx,
                    input.provider,
                    candidates,
                    outcome.results,
                    {
                        mode,
                        evidence: resolution.kind,
                        terminatedWorkers: terminated.length,
                        candidates: candidates.length,
                        population,
                        batchRefused: outcome.refused ?? null,
                        counts,
                    },
                    outcome.refused,
                );
            } catch (err) {
                logger.error('leaver pass ran but its record could not be written', {
                    component: 'identity-leaver-pass',
                    tenantId: ctx.tenantId,
                    provider: input.provider,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            recordLeaverPassOutcome({
                provider: input.provider,
                outcome: outcome.refused ? 'batch_refused' : 'completed',
            });
            return {
                // The SAME derivation as the row written above, not a second
                // expression of it. This used to be a hand-written ternary that
                // had already drifted — it could not produce PARTIAL at all, so
                // a truncated pass returned PASSED while its row said PARTIAL,
                // which is the defect one subsystem over (#2170: a resumable
                // sync RETURNED PARTIAL while PERSISTING PASSED) reproduced here
                // in mirror image — same two sites disagreeing, opposite way
                // round, which is why fixing that one did not find this one.
                status: leaverPassStatus(outcome.refused, outcome.results.length),
                ...(outcome.refused ? { refusal: 'BATCH_REFUSED' as const } : {}),
                mode,
                counts,
                terminatedWorkers: terminated.length,
                candidates: candidates.length,
                population,
                batchRefused: outcome.refused,
            };
        } finally {
            // Unconditional because `close` is in the type on every arm — a
            // no-op for the snapshot reader and for Entra, a real unbind for AD.
            // The obligation is discharged by the compiler, not by memory.
            await resolution.close();
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('leaver pass failed', {
            component: 'identity-leaver-pass',
            tenantId: input.tenantId,
            provider: input.provider,
            error: detail,
        });
        recordLeaverPassOutcome({ provider: input.provider, outcome: 'error' });
        return {
            status: 'ERROR',
            mode: 'unknown',
            counts: {},
            terminatedWorkers: 0,
            candidates: 0,
            population: 0,
            errorMessage: detail,
        };
    }
}
