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
 * tenant reaches AUTOMATIC by elapsed time in DRY_RUN (`DRY_RUN_MIN_DAYS`), one
 * rung at a time, and starts at DISABLED. What the clamp used to add — a blanket
 * refusal above the second rung — is gone deliberately, on the owner's
 * instruction.
 *
 * That single widen is now the whole of the climb, and it is gated. The PROPOSE
 * rung that used to sit between the two was removed in #2241: it refused every
 * candidate, and it was the only transition the dwell did not cover, so it was
 * the way AROUND the seven days rather than a step through them.
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
 * row is not this unit choice but two rules in `resolveWriteTarget`
 * (`identity-write-target.ts`): `CONNECTION_DISABLED`, decided per candidate in
 * step 5b below from the connection's own `isEnabled`, and — for a row that is
 * merely stale rather than orphaned — the age bound on the observation, applied
 * to the raw timestamp the candidate carries whole
 * (`identity-disable-account.ts`).
 *
 * The first of those exists because the second alone left a window. The age
 * bound only fires once a row has been frozen for `OBSERVATION_FRESHNESS_MS`,
 * so soft-disabling one of two connections lifted the factory's ambiguity
 * refusal immediately while nothing else refused for two more days (#2419).
 *
 * @module usecases/identity-leaver-pass
 */
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import { buildSystemContext } from '@/app-layer/context-system';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { resolveDirectoryWriter, type WriterRefusal } from '../integrations/identity-writer-factory';
import { getIdentityWritePolicy, type IdentityWriteMode } from './identity-write-policy';
import { listUnsettledWrites } from './identity-write-journal';
import {
    CONNECTION_DISABLED_REFUSAL,
    OBSERVATION_FRESHNESS_MS,
} from './identity-write-target';
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
import {
    recordIdentityWriteOutcome,
    recordLeaverPassOutcome,
} from '@/lib/observability/integration-metrics';

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
 *   this, a tenant that climbed above DRY_RUN was refused by gate 1
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
 * The refusal check comes FIRST, and after #2473 and #2419 the reason is no
 * longer the one either change wrote on its own.
 *
 * `refused` is set at two places in `disableAccountsForLeaver` — the
 * blast-radius breaker, and the batch-level preflight that refuses a credential
 * PROVEN unable to write. Both return before the per-candidate loop, so both
 * carry `results: []` FROM THE BATCH.
 *
 * What is no longer true is that a refusal implies an empty decision list. The
 * pass now prepends the rail refusals it decided BEFORE the batch — candidates
 * whose connection is no longer enabled (#2419) — so a refused batch can reach
 * here with decisions already in it. #2473's comment said the two were mutually
 * exclusive by construction; that held when it was written and this branch ends
 * it.
 *
 * Refusal still wins, and that is right: NOT_APPLICABLE describes the batch the
 * breaker or preflight stopped, while the decisions in the row describe what the
 * pass had already refused by name. Neither claim is weakened by the other.
 *
 * The property to check on any future refusal is therefore NOT the count of
 * refusal sites, and no longer "does a refusal carry results". It is whether the
 * refusal returns results IT HAD ALREADY COLLECTED — a third refusal added
 * AFTER the per-candidate loop would mask a real PARTIAL, which is the failure
 * both of the comments this replaces were reaching for.
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
        // THE POINTER FROM A DISABLE BACK TO WHAT IT REPLACED.
        //
        // `disableAccount` captures the account's prior state into
        // IdentityWriteJournal BEFORE it calls the provider, and hands the row's
        // id back on the result. Until this line, `recordPassExecution` threw it
        // away — so the only surviving in-product pointer from a disable to its
        // capture was `detailsJson.journalId` on the audit row, which the leaver
        // report cannot reach and an operator reading that report cannot see.
        //
        // That absence had a user-visible consequence. The DISABLED notification
        // tells IT to quote the journal reference to "your platform
        // administrator, who can read the captured state and re-apply it" — and
        // the reference printed in that mail IS this id. With it dropped here,
        // the only copy of the pointer was in an email somebody had to still
        // have. Carrying it onto the decision makes the report the second,
        // durable place to find it.
        //
        // NOT SCRUBBED, deliberately, and this is the line to read twice. Every
        // `reason` above goes through `redactDirectoryIdentifiers` because a
        // provider sentence embeds the account it is about. A journal id is not
        // a sentence and not a directory identifier: it is an opaque cuid minted
        // by our own database, tenant-scoped by RLS, and resolvable only through
        // an authorised read of a row in a table we own. Putting it through the
        // scrubber would be theatre — there is no account name in it to remove —
        // and `IntegrationExecution.resultJson` is not encrypted at rest, which
        // is exactly why the value stored has to be an opaque handle rather than
        // anything that names a person. It is.
        //
        // ABSENT rather than null on a decision that never reached a write.
        // `journalId` exists only once `beginWrite` has committed, so the three
        // refusals decided before it (self-account, protected, ladder) and the
        // stranded-connection refusal carry none. Same rule as `basis` directly
        // above, and for the same reason: a `null` on the row would read on
        // screen as "a capture was attempted and produced nothing", which is a
        // different and much more alarming claim than "no write was attempted".
        ...(r.journalId ? { journalId: r.journalId } : {}),
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

/**
 * The one place a leaver pass that RAN creates its row, so both callers agree on
 * its shape. The pass that THREW has its own seam below —
 * `writeErrorExecutionRow` — because the status it writes is the one this
 * function's parameter type deliberately cannot express.
 */
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

/**
 * The catch path's own seam — the ONLY place `ERROR` is persisted.
 *
 * A SIBLING of `writeExecutionRow` rather than a widening of it, and the
 * duplication is deliberate. That function takes `LeaverPassRanStatus` — the
 * full union minus `ERROR` — precisely so the compiler, and not a comment,
 * keeps the normal path from persisting a status that inflates
 * `errorCount24h`. Widening its parameter to serve the catch path would delete
 * that guarantee to save four lines. Here `status: 'ERROR'` is a literal, and
 * this function is unreachable from a pass that reached a decision.
 */
async function writeErrorExecutionRow(
    ctx: RequestContext,
    provider: string,
    resultJson: Prisma.InputJsonValue,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                provider,
                automationKey: `${provider}${LEAVER_PASS_AUTOMATION_SUFFIX}`,
                status: 'ERROR',
                triggeredBy: 'scheduled',
                completedAt: new Date(),
                resultJson,
            },
        }),
    );
}

/**
 * A pass that THREW still ran, and must not read as a pass that never fired.
 *
 * The same argument `recordRefusedPass` makes, one rung further down. Until
 * this existed the outer catch logged, emitted its metric and returned — so
 * `/admin/identity-leaver-passes` showed nothing at all, which is precisely
 * what a tenant with a dead worker also shows. A crashed pass and a pass that
 * never ran were the same artefact: none. That is the ambiguity this subsystem
 * closes everywhere else, and it is the one thing a proving run exists to rule
 * out.
 *
 * REDACTION IS LOAD-BEARING. A thrown provider error routinely embeds the
 * account it was about — a UPN, a DN, an objectGUID — and
 * `IntegrationExecution.resultJson` is NOT encrypted at rest, which is the same
 * reason `recordPassExecution` keys by link id and scrubs every reason on the
 * way in. No candidate is in scope on this path, so there is no
 * `externalUserId` to pass and the shape-based rules are the whole of the
 * defence; that is a reason to scrub, not a reason to skip it.
 *
 * `mode: 'unknown'` because the throw may have come from the policy read
 * itself, so no rung was ever established — the same value, spelled the same
 * way, that the returned `LeaverPassResult` carries.
 *
 * Never lets its own failure become the pass's, exactly as `safeRecordRefusal`
 * does: it runs inside a catch whose entire contract is that the function
 * returns.
 */
async function safeRecordErroredPass(
    ctx: RequestContext,
    provider: string,
    detail: string,
): Promise<void> {
    try {
        await writeErrorExecutionRow(ctx, provider, {
            mode: 'unknown',
            refusal: null,
            detail: redactDirectoryIdentifiers(detail, undefined),
        });
    } catch (err) {
        logger.error('leaver pass threw and its record could not be written either', {
            component: 'identity-leaver-pass',
            tenantId: ctx.tenantId,
            provider,
            // Scrubbed: this fires when the pass ITSELF threw, so the message can
            // carry a directory identifier out of the write path. Same treatment
            // as `detail` two lines above, and pinned by
            // tests/guards/identity-log-identifier-scrub.test.ts.
            error: redactDirectoryIdentifiers(
                err instanceof Error ? err.message : String(err),
                undefined,
            ),
        });
    }
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
    // The batch was refused WHOLE, before any candidate was decided. Distinct
    // from every refusal above: those stop before the pass has looked at
    // anything, this one stops after it has assembled a real population.
    //
    // Covers the two rails that can reach that conclusion — the blast-radius
    // breaker judging the batch the wrong size, and the preflight finding the
    // credential PROVEN unable to disable anyone. ONE code for both on purpose:
    // the distinction an operator acts on is carried by the accompanying detail
    // text, which names the cause in a sentence, and widening this union splits
    // every consumer of it for a difference already legible where they look.
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

/**
 * Candidates whose OBSERVING connection is not currently enabled.
 *
 * ═══ THE HOLE THIS FILLS ═══
 *
 * `resolveDirectoryWriter` refuses AMBIGUOUS_CONNECTION on more than one
 * ENABLED connection for a provider. `removeIntegrationConnection` is a SOFT
 * disable, so soft-disabling one of two takes that count back to one and the
 * refusal stops applying — while the rows the disabled connection observed are
 * still present, still linked, and still inside their observation window. The
 * age bound in `resolveWriteTarget` catches them, but only once
 * `OBSERVATION_FRESHNESS_MS` has elapsed: a window of up to two days in which a
 * pass evaluates a row against a writer bound to a different connection. (#2419)
 *
 * ═══ WHY THE READ IS HERE AND NOT ON THE CANDIDATE ═══
 *
 * `DisableAccountInput` carries no connection, and the fields it does carry are
 * read where the population is assembled — which is the right shape and is one
 * file over. Until the candidate can carry it, this is the nearest seam that
 * still sees every candidate BEFORE the batch, and one indexed read for the
 * whole list is the same cost the population count above already pays.
 *
 * ═══ FAILS CLOSED, TWICE ═══
 *
 * A link is treated as actionable ONLY on a positive `isEnabled === true`. A
 * link the read did not return at all — deleted between the two queries, hidden
 * by row-level security, or simply absent — is STRANDED, not actionable: "we
 * could not confirm the connection" and "the connection is fine" are the two
 * answers this subsystem must never collapse. And a read that throws propagates
 * to the pass's own catch, which records an errored pass and writes nothing.
 */
async function findStrandedLinkIds(
    ctx: RequestContext,
    candidates: readonly DisableAccountInput[],
): Promise<Set<string>> {
    const linkIds = candidates.map((c) => c.linkId);
    if (linkIds.length === 0) return new Set();

    const rows = await runInTenantContext(ctx, (db) =>
        db.identityAccountLink.findMany({
            where: { tenantId: ctx.tenantId, id: { in: linkIds } },
            select: {
                id: true,
                // Two hops, no extra round trip: the account names the
                // connection that observed it (`connectionId` is NOT NULL as of
                // the phase-2 migration), and the connection carries the flag
                // `removeIntegrationConnection` clears.
                connectedAccount: { select: { connection: { select: { isEnabled: true } } } },
            },
            // Bounded by the candidate list, which `findLeaverCandidates` has
            // already capped. Never unbounded, even reading by primary key.
            take: linkIds.length,
        }),
    );

    // Optional-chained even though both relations are REQUIRED in the schema.
    // Prisma types them non-null, but the value that decides a directory write
    // should not depend on that being true at runtime under every RLS
    // configuration: a missing hop lands on `undefined !== true`, which refuses,
    // rather than on a TypeError that ends the pass.
    const actionable = new Set(
        rows.filter((r) => r.connectedAccount?.connection?.isEnabled === true).map((r) => r.id),
    );
    return new Set(linkIds.filter((id) => !actionable.has(id)));
}

/**
 * The decision a stranded candidate gets: a NAMED refusal, never a quiet drop.
 *
 * `REFUSED_TARGET` with `basis.rule = CONNECTION_DISABLED`, so it reads on the
 * report exactly like the other write-target refusals and says which rule
 * produced it. Filtering these candidates out silently would shrink the batch
 * and leave the operator with a pass that offboarded fewer people than it had
 * candidates, with nothing on the row saying why.
 *
 * The sentence and the basis both come from the rail, so this and
 * `resolveWriteTarget` cannot drift into two different accounts of one rule.
 *
 * The counter is recorded HERE because `disableAccount` — the one choke point
 * that counts every other outcome — is never reached for these candidates.
 * A refusal that is invisible to the metric would make the rail look inert.
 */
function refuseStrandedCandidate(
    provider: string,
    mode: IdentityWriteMode,
    candidate: DisableAccountInput,
): LeaverDisableResult {
    recordIdentityWriteOutcome({ provider, action: 'disable', outcome: 'REFUSED_TARGET' });
    return {
        linkId: candidate.linkId,
        outcome: 'REFUSED_TARGET',
        reason: CONNECTION_DISABLED_REFUSAL.reason,
        mode,
        basis: {
            rule: CONNECTION_DISABLED_REFUSAL.basis,
            onPremisesSyncEnabled: candidate.onPremisesSyncEnabled,
            ...(candidate.onPremStateObservedAt
                ? { observedAt: candidate.onPremStateObservedAt.toISOString() }
                : {}),
        },
    };
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
/**
 * How stale an unsettled row must be before it counts as stranded.
 *
 * A row is minted and settled within the same candidate, seconds apart, so
 * anything unsettled for an hour was left behind rather than being in flight.
 * The window is generous on purpose: this read runs at the HEAD of the pass,
 * before any row of its own exists, so its only real job is to avoid counting
 * a concurrent pass's in-flight write on a tenant running two providers.
 */
const UNSETTLED_STALE_MS = 60 * 60 * 1000;

/**
 * Count the directory writes nobody ever confirmed, and emit the metric.
 *
 * WHY AT THE HEAD OF THE PASS. `listUnsettledWrites` shipped with no caller at
 * all, which left the capture-before-write rail invisible: a row stranded by a
 * worker killed mid-batch stayed PENDING for ever, no page read it, and
 * `identity.write.unsettled` — whose docblock says ALERT ON — could never be
 * emitted, because its only call site is inside the function nobody called.
 *
 * Reading here rather than beside the write means it runs before EVERY early
 * return, including the two ladder refusals that write no execution row. That
 * matters most for the tenant narrowed back to DISABLED after an incident,
 * which is exactly when rows strand and exactly when nothing else would look.
 *
 * Provider-scoped, because the dispatcher fans out one job per (tenant,
 * provider) and the counter's only label is the tenant — unscoped, a
 * two-provider tenant would report its backlog twice under one series.
 *
 * Never throws: an observability read must not be able to stop an offboarding.
 * Returns null when it could not read, which is NOT the same as zero and is
 * carried into the report as such.
 */
async function readUnsettledBacklog(
    ctx: RequestContext,
    provider: string,
    now: Date,
): Promise<number | null> {
    try {
        const rows = await listUnsettledWrites(ctx, new Date(now.getTime() - UNSETTLED_STALE_MS), provider);
        if (rows.length > 0) {
            logger.warn('directory writes are still unconfirmed from an earlier pass', {
                component: 'identity-leaver-pass',
                tenantId: ctx.tenantId,
                provider,
                unsettled: rows.length,
                // Opaque handles only — this line is not encrypted, and the
                // reader's projection deliberately carries no directory id.
                linkIds: rows.map((r) => r.linkId).filter(Boolean).slice(0, 10),
            });
        }
        return rows.length;
    } catch (err) {
        logger.error('could not read the unsettled-write backlog', {
            component: 'identity-leaver-pass',
            tenantId: ctx.tenantId,
            provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

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
        // ── 0. What did an earlier pass leave unconfirmed? Read FIRST, so it is
        // reported even when the ladder refuses below and no execution row is
        // written at all. Cannot throw; see the helper.
        const unsettledOnEntry = await readUnsettledBacklog(ctx, input.provider, now);

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
            // ── 5b. Which candidates sit on a connection that is no longer
            //        ENABLED.
            //
            // Refused by name rather than left to the age bound two days later
            // — see `findStrandedLinkIds`. They stay in `candidates` for the
            // reported count, because they WERE candidates and the report must
            // not quietly show fewer people than the pass looked at; what they
            // are kept out of is the batch.
            //
            // BELOW the writer refusal, and INSIDE this try, and both
            // placements are load-bearing:
            //
            //   · below, because every refusal built here is counted on the
            //     write-outcome metric and reported in the row, and the two
            //     must describe the same set. Above that line the pass can
            //     still return without recording a decision at all —
            //     NO_CONNECTION is the reachable case, a tenant whose ONLY
            //     connection was soft-disabled — leaving counters for
            //     decisions no artefact holds.
            //   · inside, because the writer is already resolved. The AD arm
            //     holds an LDAP bind, and a read that throws out here would
            //     leak it; the finally below is what closes it, and it is
            //     unconditional.
            const strandedLinkIds = await findStrandedLinkIds(ctx, candidates);
            const actionable =
                strandedLinkIds.size === 0
                    ? candidates
                    : candidates.filter((c) => !strandedLinkIds.has(c.linkId));
            const strandedResults: LeaverDisableResult[] =
                strandedLinkIds.size === 0
                    ? []
                    : candidates
                          .filter((c) => strandedLinkIds.has(c.linkId))
                          .map((c) => refuseStrandedCandidate(input.provider, mode, c));
            if (strandedResults.length > 0) {
                logger.warn('leaver candidates refused: their connection is no longer enabled', {
                    component: 'identity-leaver-pass',
                    tenantId: ctx.tenantId,
                    provider: input.provider,
                    // COUNTS ONLY. This line is neither encrypted nor
                    // tenant-scoped, so it carries no link id and no directory
                    // identifier — the per-decision record does, on a surface
                    // that is both.
                    stranded: strandedResults.length,
                    candidates: candidates.length,
                });
            }

            const outcome = await disableAccountsForLeaver(ctx, resolution.writer, {
                candidates: actionable,
                population,
            });
            // The stranded refusals FIRST, then what the batch decided. One
            // list from here down, so the counts, the row and the returned
            // status are all derived from the same decisions — a refusal the
            // report counted but the row omitted is the drift this file has
            // already had to fix twice.
            const results: readonly LeaverDisableResult[] =
                strandedResults.length === 0
                    ? outcome.results
                    : [...strandedResults, ...outcome.results];
            const counts = tally(results);

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
                unsettledOnEntry,
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
                    results,
                    {
                        mode,
                        evidence: resolution.kind,
                        // A COUNT, never the rows: the reader's projection
                        // carries no directory identifier and this column is
                        // not encrypted at rest. `null` means the read itself
                        // failed, which is not the same fact as zero.
                        unsettledOnEntry,
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
                status: leaverPassStatus(outcome.refused, results.length),
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
        // AND LEAVE A ROW. The metric above is aggregate and the log line above
        // it lands outside the tenant boundary, so before this call the only
        // tenant-visible trace of a crashed pass was the absence of one — the
        // same artefact a pass that never fired leaves. `ctx` is built before
        // the try, so it is in scope here without restructuring.
        await safeRecordErroredPass(ctx, input.provider, detail);
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
