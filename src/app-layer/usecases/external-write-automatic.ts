/**
 * THE UNATTENDED ARM OF THE EXTERNAL-WRITE LADDER (#2861 / #3051, the AUTOMATIC
 * rung).
 *
 * `DRY_RUN` journals and sends nothing. `PROPOSE_ONLY` queues an
 * `AgentProposal` and a human signs it. `AUTOMATIC` is the rung with no human in
 * it at all, and everything in this file exists because of that one difference.
 *
 * ═══ WHAT REPLACES THE HUMAN, STATED AS A LIST ═══
 *
 * At `PROPOSE_ONLY` the safety property is "a person read this specific change
 * to this specific record and said yes". At `AUTOMATIC` it is a conjunction of
 * things that must ALL be true, and the arm's job is to hold every one of them:
 *
 *   1. the rung is at or below `EXTERNAL_MAX_MODE` — the build's own ceiling,
 *      checked HERE and not only where the rung is stored;
 *   2. an approved parameter SET is in force, so the model chose a template and
 *      not the arguments;
 *   3. every open VALUE field satisfied the constraint two humans approved
 *      (`refusalForValue`, applied by the tool adapter before it reaches here);
 *   4. the TARGET named a row our own data currently puts in the approved
 *      population (`resolveTargetPopulation`, resolved at dispatch because the
 *      population is data and data moves);
 *   5. a prior-state read was paired, ran, and was journalled BEFORE anything
 *      left (owner decision 2);
 *   6. the connection has not already consumed its rolling-window allowance —
 *      see `AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW`;
 *   7. the EU AI Act Art 12 record exists. Not best-effort: if it cannot be
 *      written the write is refused, because an unattended change to somebody
 *      else's system with no record of the decision is the single thing this
 *      subsystem exists to prevent.
 *
 * Terms 3 and 4 are enforced by `external-tools.ts` for EVERY rung and are not
 * re-implemented here — a second copy is the one that drifts. What this file
 * adds is 1, 2, 6, 7, and the send-time RE-VALIDATION of 3 and 4 below.
 *
 * ═══ THE ART 12 RECORD IS AN `AiDecisionLog` ROW, NOT AN `AgentProposal` ═══
 *
 * The rejected design was to write a proposal for the unattended write too, so
 * the audit surface would look uniform. It is a lie with a shape: a proposal
 * with no possible approver can never be approved, and a `PENDING` decision-log
 * row is the same lie one table over — `buildDecisionArtefact` would report a
 * "still pending review" backlog that grows for ever and that no reviewer can
 * drain, on the artefact an assessor reads to ask how much was supervised.
 *
 * So the row is written DIRECTLY by this arm, stamped `AUTONOMOUS` at insert.
 * The value is terminal from birth and the append-only trigger then refuses to
 * move it, so nothing can later restamp it as though a human had looked.
 *
 * ═══ WHY DISPATCH GOES THROUGH THE JOB AND NOT INLINE ═══
 *
 * `openApprovedExternalWrite` — the `PROPOSE_ONLY` sibling — does `beginWrite`
 * and returns the journal id. It never calls `callTool`. The
 * `external-write-dispatch` job is the ONLY sender in this build. So an arm that
 * sent inline would be the novelty, and it would be the thing that creates a
 * double-send: the job sweeps `outcome: 'PENDING'`, which is exactly what
 * `beginWrite` writes, so a row sent inline and left PENDING is sent twice, and
 * a row sent inline and settled immediately loses the retry and settlement
 * behaviour the rung most needs.
 *
 * Opening the row at `mode: 'AUTOMATIC'` and letting the job send it inherits
 * all of that and needs no new filter on a work-list that has never had one.
 */
import { badRequest, forbidden, internal, rateLimited } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    EXTERNAL_MAX_MODE,
    isAboveClamp,
    coerceStoredMode,
    type ExternalWriteMode,
} from '@/lib/integrations/external-write-ladder';
import { parseOpenFields } from '@/lib/integrations/open-fields';
import { refusalForValue } from '@/lib/integrations/parameter-constraints';
import { logAiDecision } from '@/app-layer/ai/decision-log';

import type { RequestContext } from '../types';
import { beginWrite, settleWrite } from './external-write-journal';
import { resolveTargetPopulation } from './external-tool-target-populations';

/**
 * The rung this file is the arm for. A named constant rather than the literal
 * sprinkled through the checks, so the clamp comparison and the journal row
 * cannot disagree about which rung is being opened.
 */
const AUTOMATIC: ExternalWriteMode = 'AUTOMATIC';

/**
 * HOW MANY UNATTENDED WRITES ONE CONNECTION MAY OPEN PER ROLLING WINDOW.
 *
 * ── Why a bound exists at all, and why per CONNECTION ────────────────────────
 *
 * The run cap already bounds a RUN: `TOOL_CALLS` is the strictest of
 * `MAX_STEPS` and the policy card, so no single agentic run can loop for ever.
 * It is the wrong unit for the failure this rung introduces. A target
 * population is DATA, and the thing that goes wrong with a data-bound template
 * is a bad POPULATION FEED — an HR import that marks four thousand workers
 * TERMINATED by mistake. Every one of those rows is legitimately in the
 * population, every call passes every bound, and the writes are spread across
 * as many runs as the scheduler cares to start. A per-run cap sees nothing
 * wrong. The connection is the unit the damage is measured in, so it is the
 * unit the bound is written in.
 *
 * ── It is NOT `DISPATCH_BATCH_LIMIT`, which happens to be the same number ───
 *
 * `external-write-dispatch.ts` has `DISPATCH_BATCH_LIMIT = 50`, and the
 * coincidence is worth naming so nobody reads the two as one mechanism. That
 * one is a PAGE SIZE: per tenant, per pass, `take: 50` on the work-list, and it
 * REFUSES NOTHING — the next pass ten minutes later picks up the rest, so a
 * tenant with ten thousand queued rows still sends all ten thousand. It bounds
 * a worker's appetite, not a connection's authority. This one refuses, with its
 * own code, and the refused call is never journalled as sendable at all.
 *
 * ── Why 50 per hour ─────────────────────────────────────────────────────────
 *
 * 50 is the figure the issue starts from and it is kept. It is far above any
 * legitimate run — the first writable far end is an HRIS contact-details update
 * and a leaver wave is tens of people a month — and far below the four-thousand
 * case above, which it stops inside the first few minutes. An hour is chosen
 * over a day because the quantity an operator can act on is "writes in progress
 * right now"; a daily bucket would let the whole allowance leave in one minute
 * and then refuse legitimate work for 23 hours.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *
 * This is a VOLUME bound and not a four-eyes rule, so it is a read-then-write
 * and two concurrent arms can both see 49 and both proceed. That is accepted
 * rather than overlooked: the overshoot is bounded by the number of in-flight
 * calls, nothing downstream treats the cap as proof of anything, and the
 * authority that actually constrains WHICH rows may be written is the target
 * population, which has no such race. Turning this into a database constraint
 * would be buying a serialisation cost for a bound whose job is to catch an
 * order-of-magnitude error.
 */
export const AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW = 50;

/** The rolling window the cap counts over. One hour — see the cap's docstring. */
export const AUTOMATIC_WRITE_WINDOW_MS = 60 * 60 * 1000;

/** Everything the arm needs that the tool adapter has already resolved. */
export interface AutomaticWriteRequest {
    readonly connectionId: string;
    readonly connectionName: string;
    readonly endpointUrl: string;
    /** Our qualified `mcp__<connectionId>__<tool>`. */
    readonly toolName: string;
    /** What the SERVER calls it. */
    readonly advertisedToolName: string;
    /**
     * The approved template this call ran under, or null when none was in force.
     *
     * Null is a REFUSAL here and not a default. It is nullable at all because
     * the rungs below `AUTOMATIC` legitimately permit a set-less call, and the
     * column that stores it has to represent those rows too.
     */
    readonly parameterSetLabel: string | null;
    /** The RESOLVED values — #3051 decision 5 makes this the audit record. */
    readonly argumentsJson: string;
    /** Read from the far end immediately before. Owner decision 2's precondition. */
    readonly priorStateJson: string;
}

/**
 * Is `AUTOMATIC` above the ceiling this build honours?
 *
 * ONE definition, consulted by the arm AND by the dispatch job, because the
 * gap this closes is that `EXTERNAL_MAX_MODE` was enforced only at the STORAGE
 * boundary: `setExternalWriteMode` refused a wider rung and `dispatchWrite`
 * never consulted the constant at all. A row already holding `AUTOMATIC` when
 * the ceiling is lowered — by a rollback, or by an incident response narrowing
 * the build rather than every tenant — would have sailed through.
 *
 * Returns the refusal sentence, or null when the rung is honoured.
 */
export function automaticClampRefusal(): string | null {
    if (!isAboveClamp(AUTOMATIC, EXTERNAL_MAX_MODE)) return null;
    return (
        `external_write_automatic_above_ceiling: this build's ceiling is ${EXTERNAL_MAX_MODE}, `
        + `so ${AUTOMATIC} names an authority it will not exercise. Nothing was sent.`
    );
}

/**
 * Open the journal row for an UNATTENDED external write, and record the Art 12
 * decision that goes with it.
 *
 * Returns the journal id. Sends nothing — `runExternalWriteDispatch` does that.
 * Every refusal throws before any row exists, except the Art 12 failure, which
 * settles the row it already opened (see below).
 */
export async function openAutomaticExternalWrite(
    ctx: RequestContext,
    req: AutomaticWriteRequest,
): Promise<{ journalId: string }> {
    // ── 1. THE CLAMP, FIRST ─────────────────────────────────────────────────
    //
    // Before the set check, before the cap, before any read. A rung this build
    // refuses to exercise must not cost a query, and putting it anywhere else
    // means the first thing a reviewer reads is not the thing that decides.
    const clamped = automaticClampRefusal();
    // `forbidden`, not a bare Error: the rung is an authority this build
    // refuses to exercise, which is exactly what that status means, and a usecase
    // owes a TYPED error — `regression-scanner` holds every file under
    // `usecases/` to it and carries no allowlist.
    if (clamped) throw forbidden(clamped);

    // ── 2. A SET MUST BE IN FORCE ───────────────────────────────────────────
    //
    // With no saved parameter set the model chooses every argument, and at this
    // rung there is nobody to notice. That is the whole safety property of the
    // template work inverted: `ExternalToolParameterSet` is what makes "a human
    // approved this shape" true, and without one `AUTOMATIC` would be "the
    // model may send whatever it likes to somebody else's system".
    //
    // Note what is NOT required: that the set declare a TARGET field. A set of
    // exact values with nothing open is MAXIMALLY bounded — a human typed every
    // byte that goes out — so demanding a target would refuse the safest
    // template there is.
    if (!req.parameterSetLabel) {
        throw badRequest(
            'external_write_automatic_requires_parameter_set: an unattended external write must '
                + 'run an approved parameter set, so that what goes out is a shape two humans '
                + `accepted rather than arguments the model chose. "${req.advertisedToolName}" was `
                + 'called with no set in force. Nothing was sent.',
        );
    }

    // ── 3. THE ROLLING-WINDOW CAP ───────────────────────────────────────────
    //
    // Served by `@@index([tenantId, connectionId, attemptedAt])` — two leading
    // equalities and then the range, which is the shape of this count. (The
    // journal's other composite, `[tenantId, mode, attemptedAt]`, leads on the
    // low-cardinality `mode` and is the DWELL's index, not this one; `mode` is
    // a filter here, not a prefix.)
    const since = new Date(Date.now() - AUTOMATIC_WRITE_WINDOW_MS);
    const opened = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.count({
            where: {
                tenantId: ctx.tenantId,
                connectionId: req.connectionId,
                mode: AUTOMATIC,
                attemptedAt: { gte: since },
            },
        }),
    );
    if (opened >= AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW) {
        // The refusal reports the CAP and the window, never a list of what was
        // written — an operator needs to know the bound is biting, and the rows
        // are addressable through the journal surface under its own permission.
        throw rateLimited(
            `external_write_automatic_rate_limited: this connection has already opened ${opened} `
                + `unattended writes in the last `
                + `${Math.round(AUTOMATIC_WRITE_WINDOW_MS / 60000)} minutes, which is at or past `
                + `the ceiling of ${AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW}. A population that `
                + 'suddenly admits far more rows than usual is the failure this bound exists for, '
                + 'so the call is refused rather than trimmed. Nothing was sent.',
        );
    }

    // ── 4. THE JOURNAL ROW, BEFORE ANYTHING ELSE CAN GO WRONG ───────────────
    //
    // `beginWrite`'s contract is that the row exists before the call, so a
    // process that dies mid-dispatch still leaves evidence. It also re-checks
    // the rung allowlist positively, which is why `AUTOMATIC` had to be added
    // to nothing there: it refuses `DRY_RUN` and `DISABLED` and permits the
    // rest, and the clamp above is what keeps "the rest" honest.
    const handle = await beginWrite(ctx, {
        connectionId: req.connectionId,
        connectionName: req.connectionName,
        endpointUrl: req.endpointUrl,
        toolName: req.toolName,
        advertisedToolName: req.advertisedToolName,
        mode: AUTOMATIC,
        argumentsJson: req.argumentsJson,
        priorStateJson: req.priorStateJson,
        parameterSetLabel: req.parameterSetLabel,
        agentId: ctx.agentId ?? null,
    });

    // ── 5. THE ART 12 RECORD, WHICH IS NOT BEST-EFFORT ──────────────────────
    //
    // `createAgentProposal` writes its own decision-log row with
    // `.catch(() => undefined)`, and that is defensible there: the proposal is
    // already in a queue a human reads, so a missing AI-ops row costs
    // observability and not accountability. Here the row IS the accountability
    // — there is no queue and no human — so a failure to write it refuses the
    // write.
    //
    // The journal row already exists at this point, so it is SETTLED `FAILED`
    // rather than left `PENDING`: `FAILED` is the honest positive claim (no
    // request was made), and it is also what keeps the dispatch job's
    // `outcome: 'PENDING'` work-list from picking up a write whose record is
    // missing.
    try {
        await runInTenantContext(ctx, (db) =>
            logAiDecision(db, ctx, {
                feature: 'external-write-automatic',
                // The same provider label `createAgentProposal` uses for the
                // agentic path: the decision being recorded is an agent's, and
                // no model provider was called to make it.
                provider: 'mcp-agent',
                // DIGESTED, never stored. The digest is over the template and
                // the resolved payload, which is what makes two records of "the
                // same decision" comparable without persisting either.
                //
                // THE PAYLOAD GOES IN AS THE SERIALISED STRING, NOT PARSED, and
                // that is a correctness fix rather than a shortcut. A
                // `JSON.parse` here sits INSIDE the try/catch below, so an
                // unparseable payload was reported as
                // `external_write_automatic_unrecorded` — "the Art 12 record
                // could not be written" — which is the wrong cause named
                // confidently, on the one path where the operator needs the
                // right one. It also buys nothing: `computeInputDigest`
                // stringifies whatever it is given, so a round trip through
                // `parse` does not canonicalise key order either.
                sanitizedInput: {
                    tool: req.toolName,
                    parameterSet: req.parameterSetLabel,
                    argumentsJson: req.argumentsJson,
                },
                // STRUCTURAL FACTS ONLY — the same rule `summarizeWithoutContent`
                // follows. Field NAMES and sizes, the rung, the journal id; never
                // a value. The resolved values live on the journal row, encrypted,
                // which is where #3051 decision 5 puts the audit record.
                outputSummary: automaticOutputSummary(req, handle.journalId),
                humanOutcome: 'AUTONOMOUS',
                guardVerdict: `rung=${AUTOMATIC} parameterSet=${req.parameterSetLabel}`,
            }),
        );
    } catch (err) {
        await settleWrite(
            ctx,
            handle.journalId,
            'FAILED',
            'external_write_automatic_unrecorded: the EU AI Act Art 12 record for this unattended '
                + 'write could not be written, so the write was refused. An unattended change with '
                + 'no record of the decision is the one outcome this rung must not produce.',
        );
        logger.error('external write automatic: Art 12 record failed, write refused', {
            component: 'external-write-automatic',
            tenantId: ctx.tenantId,
            journalId: handle.journalId,
            connectionId: req.connectionId,
            error: err instanceof Error ? err.name : 'non-Error thrown',
        });
        // `internal`: this is OUR failure, not the caller's, and labelling it a
        // bad request would tell an agent to retry with different arguments.
        throw internal(
            'external_write_automatic_unrecorded: the Art 12 decision record could not be '
                + 'written, so nothing was sent.',
        );
    }

    logger.info('external write opened at AUTOMATIC', {
        component: 'external-write-automatic',
        tenantId: ctx.tenantId,
        journalId: handle.journalId,
        connectionId: req.connectionId,
        tool: req.toolName,
        parameterSet: req.parameterSetLabel,
        openedInWindow: opened + 1,
    });
    return { journalId: handle.journalId };
}

/** Names and sizes, never values. See the call site. */
function automaticOutputSummary(req: AutomaticWriteRequest, journalId: string): string {
    let names: string[] = [];
    let chars = 0;
    try {
        const parsed = JSON.parse(req.argumentsJson) as unknown;
        chars = req.argumentsJson.length;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            names = Object.keys(parsed as Record<string, unknown>).sort();
        }
    } catch {
        // An unparseable payload is still recorded, as that fact. Throwing here
        // would turn a summary problem into a refused write.
        names = [];
    }
    return [
        `rung=${AUTOMATIC}`,
        `tool=${req.advertisedToolName}`,
        `parameterSet=${req.parameterSetLabel ?? 'none'}`,
        `argumentFields=${names.join('|') || 'none'}`,
        `argumentChars=${chars}`,
        `journal=${journalId}`,
        'humanReview=none (rung AUTOMATIC)',
    ].join(' ');
}

/**
 * WHAT "DRIFT" MEANS AT `AUTOMATIC`, RE-CHECKED AT SEND TIME.
 *
 * ═══ The two rungs ask different questions, and that is the whole point ═══
 *
 * At `PROPOSE_ONLY` the dispatch compares the far end's CURRENT state against
 * `priorStateJson` and refuses when they differ. Its justification is written
 * into `external-write-dispatch.ts` and is about a person: "a human approved a
 * specific change to a specific state — this mailbox says alice, make it bob.
 * If the far end now says carol, the thing they approved is not the thing that
 * would happen." The referent of that check is a human's approval of ONE
 * record's contents.
 *
 * At `AUTOMATIC` nobody read a record, so that comparison has no referent. What
 * was approved is the TEMPLATE AND ITS BOUNDS: "any member of population P may
 * have field F set to any value matching constraint C". Refusing because the
 * record moved would refuse whenever the far end is merely busy — making the
 * rung unusable for exactly the unattended workload it exists for — while
 * protecting nothing anybody signed.
 *
 * So the send-time check re-asks the terms that STOOD IN for the human:
 *
 *   · the set still exists under the label this row ran — the authority has not
 *     been withdrawn or re-labelled;
 *   · its bounds still parse;
 *   · every open VALUE still satisfies its constraint — a bound NARROWED since
 *     the call is an operator withdrawing authority, and narrowing must take
 *     effect at the last possible moment rather than the first;
 *   · the TARGET is still in the population, RE-RESOLVED now. This is the one
 *     that cannot be skipped: a population is data and data moves, so the row
 *     that was addressable when the arm ran may have left the set since, and
 *     5c's entire argument is that a snapshot presented as a live bound is not
 *     a bound.
 *
 * The prior state is still READ AND JOURNALLED before anything leaves — owner
 * decision 2 is a precondition of dispatching at every rung, and the row is the
 * evidence of what the write replaced. It is simply not re-COMPARED here, and
 * the row's copy is never overwritten: rewriting it would destroy the only
 * record of the state the decision was made against.
 *
 * Returns a refusal sentence (prefixed with its own code), or null when every
 * term still holds. It does NOT throw on a refusal: the caller is a sweep that
 * must settle the row and move on, and an exception there would abandon the
 * rest of the batch.
 */
export async function automaticBoundRefusalAtSend(
    ctx: RequestContext,
    row: {
        readonly toolName: string;
        readonly parameterSetLabel: string | null;
        readonly argumentsJson: string;
    },
): Promise<string | null> {
    const clamped = automaticClampRefusal();
    if (clamped) return clamped;

    if (!row.parameterSetLabel) {
        // Unreachable through `openAutomaticExternalWrite`, which refuses a
        // set-less call. Checked anyway, because the alternative is looking the
        // set up by `undefined` and treating "found nothing" as the ordinary
        // withdrawal case — a different fact with the same refusal.
        return (
          'external_write_automatic_requires_parameter_set: this row records no approved '
          + 'parameter set, so there is no bound to re-check and nothing may be sent for it.'
        );
    }

    const set = await runInTenantContext(ctx, (db) =>
        db.externalToolParameterSet.findFirst({
            where: {
                tenantId: ctx.tenantId,
                toolName: row.toolName,
                label: row.parameterSetLabel as string,
            },
            select: { label: true, openFields: true, targetPopulation: true },
        }),
    );
    if (!set) {
        return (
            `external_write_automatic_set_withdrawn: the approved parameter set `
            + `"${row.parameterSetLabel}" no longer exists for this tool, so the authority this `
            + 'unattended write ran under has been withdrawn. Nothing was sent.'
        );
    }

    const parsed = parseOpenFields(set.openFields ?? null, set.targetPopulation ?? null);
    if (parsed.state === 'unreadable') {
        return (
            `external_write_automatic_bound_unreadable: the approved bounds on parameter set `
            + `"${set.label}" can no longer be read, so no value on this row can be validated `
            + 'against them. Nothing was sent.'
        );
    }
    // `state === 'absent'` is a set that opens nothing: every byte was typed by
    // a human and there is no bound to re-resolve. That is the MAXIMALLY bounded
    // case and it passes, rather than being treated as a missing check.
    if (parsed.state !== 'ok') return null;

    // Parsed WITHOUT a throw of its own. The shape check is an `if` assigning
    // null rather than a bare untyped throw caught one line down, because a
    // usecase raising an untyped error — even one it catches itself — is what
    // `regression-scanner`'s typed-error rule counts, and it counts the LINE
    // rather than whether the raise can escape. The guard is right to: a reader
    // auditing this file for untyped failures should not have to trace control
    // flow to find out which of them are real.
    //
    // (And the first version of this comment QUOTED the construct it had just
    // removed, which the same guard then counted — a scan over source text
    // cannot tell code from prose about code, so the prose has to avoid it.)
    let args: Record<string, unknown> | null = null;
    try {
        const raw = JSON.parse(row.argumentsJson) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            args = raw as Record<string, unknown>;
        }
    } catch {
        args = null;
    }
    if (args === null) {
        return (
            'external_write_automatic_arguments_unreadable: the recorded arguments for this write '
            + 'are not a readable object, so they cannot be checked against the approved bounds. '
            + 'Nothing was sent.'
        );
    }

    for (const [name, constraint] of Object.entries(parsed.fields)) {
        const value = args[name];
        if (constraint.kind === 'target') {
            const resolved = await resolveTargetPopulation(ctx, constraint.population);
            switch (resolved.state) {
                case 'unknown_key':
                    return (
                        `external_write_automatic_target_population_unknown: the target `
                        + `population "${constraint.population}" is no longer defined by this `
                        + 'build, so membership cannot be decided. Nothing was sent.'
                    );
                case 'unresolvable':
                    return (
                        `external_write_automatic_target_population_unresolvable: the target `
                        + `population "${constraint.population}" could not be read `
                        + `(${resolved.detail}). This is NOT "the row left the population" — we `
                        + 'could not look. Nothing was sent.'
                    );
                case 'too_large':
                    return (
                        `external_write_automatic_target_population_too_large: the target `
                        + `population "${constraint.population}" now returns more than `
                        + `${resolved.cap} rows, so it is no longer acting as a bound. Nothing `
                        + 'was sent.'
                    );
                case 'empty':
                    return (
                        `external_write_automatic_target_population_empty: the target population `
                        + `"${constraint.population}" now contains no rows, so there is no row `
                        + 'this write may be about. Nothing was sent.'
                    );
                case 'ok':
                    if (typeof value !== 'string' || !resolved.values.has(value)) {
                        return (
                            `external_write_automatic_target_left_population: "${name}" no longer `
                            + `names a row in the approved target population `
                            + `"${constraint.population}", which currently has `
                            + `${resolved.values.size} member(s). The population is data and it `
                            + 'moved after this write was opened. Nothing was sent.'
                        );
                    }
                    break;
            }
            continue;
        }

        const refusal = refusalForValue(constraint, value);
        if (refusal) {
            return (
                `external_write_automatic_value_out_of_bound: "${name}" — ${refusal.code}: `
                + `${refusal.detail} The approved bound on parameter set "${set.label}" no longer `
                + 'admits the value this write was opened with. Nothing was sent.'
            );
        }
    }

    return null;
}

/**
 * Is a row's recorded rung still permitted by the connection's CURRENT one?
 *
 * The dispatch already refuses `DISABLED` and `DRY_RUN`, which is the right
 * check for a row opened at `PROPOSE_ONLY`. It is not sufficient once
 * `AUTOMATIC` rows exist: a connection narrowed from `AUTOMATIC` to
 * `PROPOSE_ONLY` between the arm and the sweep is an operator saying "writes
 * through here need a human now", and the rows already opened without one are
 * precisely what that instruction is about. They passed the old check, because
 * `PROPOSE_ONLY` is neither `DISABLED` nor `DRY_RUN`.
 *
 * Expressed as a ladder comparison rather than a pair of literals, so a rung
 * added above `AUTOMATIC` later inherits the rule instead of falling through
 * it. Both arguments must already be through `coerceStoredMode`; this function
 * does that for the stored string it is given.
 */
export function rowRungNarrowedRefusal(
    storedRowMode: string,
    currentConnectionMode: ExternalWriteMode,
): string | null {
    const rowMode = coerceStoredMode(storedRowMode);
    if (!isAboveClamp(rowMode, currentConnectionMode)) return null;
    return (
        `external_write_automatic_rung_narrowed: this write was opened at ${rowMode} and the `
        + `connection is now at ${currentConnectionMode}, so it would be sent with an authority `
        + 'the operator has since withdrawn. Nothing was sent; it must be re-proposed under the '
        + 'rung now in force.'
    );
}

