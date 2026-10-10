/**
 * Step 4b: what a reviewer can decide about a legacy account, and what the
 * server re-checks before believing them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIX ACTIONS, AND WHY THREE OF THEM NEED A REASON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   CONFIRM     the engine suggested this person; the reviewer agrees
 *   MANUAL      the reviewer picked somebody the engine did not suggest
 *   NON_PERSON  a service account, shared mailbox or robot — needs an OWNER
 *   EXTERNAL    a real human not on the HR roster — needs an EXPIRY
 *   ORPHAN      looked at, and nobody can say whose it is
 *   DEFER       writes nothing
 *
 * `CONFIRM` needs no justification because the evidence already exists: the
 * engine recorded the signals, and the audit row names them. The other three
 * rest on something only the reviewer knows, so a free-text reason is the ONLY
 * record of why — which is exactly why it is required rather than optional, and
 * why `ORPHAN` needs one too. An orphan with no reason is indistinguishable
 * from an account nobody got round to.
 *
 * `DEFER` is in the list deliberately even though it writes nothing. Without a
 * named action for "not now", a reviewer facing a row they cannot decide picks
 * one of the others, and the queue's own design pushes them toward a guess.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER RE-CHECKS, IT DOES NOT TRUST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three independent checks, because the client is a review surface and a review
 * surface can be stale, wrong, or replayed:
 *
 * 1. **The result version.** A confirmation carries the `executionId` of the
 *    resolution the reviewer was LOOKING AT. If a newer run has since replaced
 *    it, the request is refused with 409 rather than applied to evidence
 *    nobody saw. Without this, a reviewer who left a tab open overnight
 *    confirms a suggestion the morning's run has already withdrawn.
 *
 * 2. **The candidate.** `CONFIRM` may only name an employee the engine actually
 *    scored for THAT account, re-read from the stored `candidatesJson`. A
 *    reviewer who wants somebody the engine did not suggest has to use
 *    `MANUAL`, which demands a reason. Folding the two together would make the
 *    justification optional in practice, by letting the no-reason path accept
 *    any employee.
 *
 * 3. **The tenant.** Every employee and owner id is re-read inside the tenant
 *    context, so a cross-tenant id is a not-found rather than a link.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BULK IS BOUNDED BY SOMETHING THE SOURCE HAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Bulk confirmation accepts only `SUGGESTED` rows whose leader is ahead by at
 * least {@link BULK_MIN_MARGIN}, which is `SCORER_WEIGHTS.CONVENTION` — the
 * largest score any single supporting signal can contribute. So a row is
 * bulk-eligible only when the leader is ahead by more than one whole signal,
 * and that bound moves if the weights move instead of being a constant that
 * silently stops meaning anything.
 *
 * Every row is re-checked individually on the server and reported individually.
 * A bulk call that half-succeeds says which halves — a single pass/fail for
 * fifty rows is a result a reviewer cannot act on.
 *
 * @module app-layer/usecases/legacy-reviewer-actions
 */

import type { Prisma } from '@prisma/client';

import { badRequest, conflict, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { SCORER_WEIGHTS } from '@/lib/identity/reconcile/scorers';
import { isBlindHeld } from '@/lib/legacy-access/blind-sample';
import {
    eligibleForBulkRatification,
    type VerdictClass,
} from '@/lib/legacy-access/verdict';
import type { ScoredCandidate } from '@/lib/identity/reconcile/engine';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import {
    assertCanConfirmReconciliation,
    assertCanViewReconciliation,
} from '../policies/identity-reconciliation';

/**
 * The margin a `SUGGESTED` row needs before it may be confirmed in bulk.
 *
 * Derived, not chosen: the largest weight any single supporting signal carries.
 * A leader ahead by this much is ahead by more than one whole signal, so the
 * runner-up cannot be explained by one extra match. Tying it to the weights
 * means re-weighting the scorers re-tunes this automatically rather than leaving
 * a constant that no longer means what it did.
 */
export const BULK_MIN_MARGIN = SCORER_WEIGHTS.CONVENTION;

/**
 * The most rows one bulk call may carry.
 *
 * A cap on the REQUEST, not on the reviewer: they can send a second one. It
 * exists so a single approval cannot cover more rows than a person could
 * plausibly have looked at, and so one request cannot hold a transaction open
 * across the whole queue.
 */
export const BULK_MAX_ROWS = 50;

export type ReviewerAction =
    | { readonly kind: 'CONFIRM'; readonly employeeId: string }
    | { readonly kind: 'MANUAL'; readonly employeeId: string; readonly justification: string }
    | { readonly kind: 'NON_PERSON'; readonly ownerUserId: string; readonly justification: string }
    | { readonly kind: 'EXTERNAL'; readonly justification: string; readonly expiresAt: Date }
    | { readonly kind: 'ORPHAN'; readonly justification: string }
    | { readonly kind: 'DEFER' };

export interface DecideInput {
    readonly connectionId: string;
    readonly accountKey: string;
    /** The run the reviewer was looking at. Drives the 409. */
    readonly executionId: string;
    readonly action: ReviewerAction;
}

export interface DecideResult {
    readonly accountKey: string;
    readonly outcome: 'WRITTEN' | 'DEFERRED';
    readonly classification: 'EMPLOYEE' | 'NON_PERSON' | 'EXTERNAL' | 'ORPHAN' | null;
    readonly aliasId: string | null;
}

// ─── Reading the resolution the reviewer saw ───────────────────────────────

interface SeenResolution {
    readonly id: string;
    readonly outcome: string;
    readonly candidates: readonly ScoredCandidate[];
    readonly signalsJson: Prisma.JsonValue;
}

/**
 * The resolution for this account, refusing if a newer run has replaced it.
 *
 * The check is "is the row I was shown still the LATEST for this account",
 * not "does the row I was shown still exist" — a superseded row still exists,
 * because results are immutable and a second run adds rather than overwrites.
 * Asking the weaker question would never fire.
 */
async function readSeenResolution(
    ctx: RequestContext,
    input: Pick<DecideInput, 'accountKey' | 'executionId'>
): Promise<SeenResolution> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.legacyAccountResolution.findMany({
            where: { tenantId: ctx.tenantId, accountKey: input.accountKey },
            orderBy: { createdAt: 'desc' },
            take: 2,
            select: {
                id: true,
                executionId: true,
                outcome: true,
                candidatesJson: true,
                signalsJson: true,
            },
        })
    );

    if (rows.length === 0) {
        throw notFound(`no resolution for account ${input.accountKey}`);
    }

    const latest = rows[0];
    if (latest.executionId !== input.executionId) {
        throw conflict(
            `the result for ${input.accountKey} has been replaced by a newer run; `
            + 're-open the queue and look at the current evidence before deciding'
        );
    }

    return {
        id: latest.id,
        outcome: latest.outcome,
        candidates: (latest.candidatesJson ?? []) as unknown as readonly ScoredCandidate[],
        signalsJson: latest.signalsJson,
    };
}

// ─── Validation, per action ────────────────────────────────────────────────

function requireReason(raw: string, what: string): string {
    const clean = sanitizePlainText(raw);
    // Length checked AFTER sanitising. A reason made entirely of markup
    // sanitises to nothing, and accepting it would store an empty
    // justification against a decision that is required to carry one.
    if (clean.trim().length < 10) {
        throw badRequest(`${what} requires a justification of at least 10 characters`);
    }
    return clean;
}

async function requireTenantEmployee(ctx: RequestContext, employeeId: string): Promise<void> {
    const found = await runInTenantContext(ctx, (db) =>
        db.employee.findFirst({
            where: { id: employeeId, tenantId: ctx.tenantId },
            select: { id: true },
        })
    );
    // Not-found rather than forbidden, deliberately: distinguishing "no such
    // employee" from "that employee is another tenant's" would confirm the id
    // exists somewhere, which is exactly what a cross-tenant probe wants.
    if (!found) throw notFound(`no employee ${employeeId} in this tenant`);
}

async function requireActiveOwner(ctx: RequestContext, userId: string): Promise<void> {
    const found = await runInTenantContext(ctx, (db) =>
        db.tenantMembership.findFirst({
            where: { userId, tenantId: ctx.tenantId },
            select: { userId: true },
        })
    );
    if (!found) {
        throw badRequest(
            'NON_PERSON requires an owner who is a member of this tenant — '
            + 'a service account whose owner has left is the state this classification exists to prevent'
        );
    }
}

/** The employee must be one the ENGINE scored for this account. */
function requireScoredCandidate(seen: SeenResolution, employeeId: string): void {
    if (!seen.candidates.some((c) => c.employeeId === employeeId)) {
        throw badRequest(
            `${employeeId} is not among the candidates the engine scored for this account; `
            + 'use a manual match, which records why'
        );
    }
}

// ─── The one write ────────────────────────────────────────────────────────

interface AliasWrite {
    readonly classification: 'EMPLOYEE' | 'NON_PERSON' | 'EXTERNAL' | 'ORPHAN';
    readonly employeeId: string | null;
    readonly method: 'CONFIRMED_ALIAS' | 'MANUAL';
    readonly ownerUserId: string | null;
    readonly justification: string | null;
    readonly expiresAt: Date | null;
}

async function resolveWrite(
    ctx: RequestContext,
    action: ReviewerAction,
    seen: SeenResolution
): Promise<AliasWrite | null> {
    switch (action.kind) {
        case 'DEFER':
            return null;

        case 'CONFIRM':
            requireScoredCandidate(seen, action.employeeId);
            await requireTenantEmployee(ctx, action.employeeId);
            return {
                classification: 'EMPLOYEE',
                employeeId: action.employeeId,
                method: 'CONFIRMED_ALIAS',
                ownerUserId: null,
                justification: null,
                expiresAt: null,
            };

        case 'MANUAL': {
            // NO candidate check. That is the point of this action: the reviewer
            // knows something the engine does not, and the price is a reason.
            await requireTenantEmployee(ctx, action.employeeId);
            return {
                classification: 'EMPLOYEE',
                employeeId: action.employeeId,
                method: 'MANUAL',
                ownerUserId: null,
                justification: requireReason(action.justification, 'a manual match'),
                expiresAt: null,
            };
        }

        case 'NON_PERSON': {
            await requireActiveOwner(ctx, action.ownerUserId);
            return {
                classification: 'NON_PERSON',
                employeeId: null,
                method: 'MANUAL',
                ownerUserId: action.ownerUserId,
                justification: requireReason(action.justification, 'NON_PERSON'),
                expiresAt: null,
            };
        }

        case 'EXTERNAL': {
            // Checked against the REQUEST's clock, once. An expiry in the past
            // is a classification that has already lapsed, which is a reviewer
            // mistake rather than an expired alias.
            if (action.expiresAt.getTime() <= Date.now()) {
                throw badRequest('EXTERNAL requires an expiry in the future');
            }
            return {
                classification: 'EXTERNAL',
                employeeId: null,
                method: 'MANUAL',
                ownerUserId: null,
                justification: requireReason(action.justification, 'EXTERNAL'),
                expiresAt: action.expiresAt,
            };
        }

        case 'ORPHAN':
            return {
                classification: 'ORPHAN',
                employeeId: null,
                method: 'MANUAL',
                ownerUserId: null,
                justification: requireReason(action.justification, 'ORPHAN'),
                expiresAt: null,
            };
    }
}

/**
 * Record one reviewer decision.
 *
 * Upsert, not create: `@@unique([connectionId, accountKey])` means a second
 * decision about one account is a CHANGE to the standing answer, not a rival to
 * it. A reviewer who reclassifies gets their row updated and a second audit
 * row, which is the history somebody will want when the two decisions disagree.
 */
export async function decideLegacyAccount(
    ctx: RequestContext,
    input: DecideInput
): Promise<DecideResult> {
    assertCanConfirmReconciliation(ctx);

    const seen = await readSeenResolution(ctx, input);
    const write = await resolveWrite(ctx, input.action, seen);

    if (!write) {
        // A deferral still gets an audit row. "Nobody has looked at this" and
        // "somebody looked and could not decide" are different facts about a
        // queue, and only one of them means the queue is working.
        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                entityType: 'LegacyIdentityAlias',
                entityId: `${input.connectionId}:${input.accountKey}`,
                action: 'LEGACY_RECONCILIATION_DEFERRED',
                details: `Account ${input.accountKey} deferred`,
                detailsJson: {
                    category: 'custom',
                    event: 'legacy_reconciliation_deferred',
                    connectionId: input.connectionId,
                    accountKey: input.accountKey,
                    executionId: input.executionId,
                },
            })
        );
        return {
            accountKey: input.accountKey,
            outcome: 'DEFERRED',
            classification: null,
            aliasId: null,
        };
    }

    const now = new Date();

    return runInTenantContext(ctx, async (db) => {
        const row = await db.legacyIdentityAlias.upsert({
            where: {
                connectionId_accountKey: {
                    connectionId: input.connectionId,
                    accountKey: input.accountKey,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                connectionId: input.connectionId,
                accountKey: input.accountKey,
                classification: write.classification,
                employeeId: write.employeeId,
                method: write.method,
                ownerUserId: write.ownerUserId,
                justification: write.justification,
                expiresAt: write.expiresAt,
                confirmedByUserId: ctx.userId,
                confirmedAt: now,
                // The evidence the reviewer was SHOWN, stored with the decision.
                // Not re-derived later: the engine's weights and scorers change
                // between runs, so "why did they approve this?" is only
                // answerable from what was on screen at the time.
                signalsJson: (seen.signalsJson ?? []) as Prisma.InputJsonValue,
            },
            update: {
                classification: write.classification,
                employeeId: write.employeeId,
                method: write.method,
                ownerUserId: write.ownerUserId,
                justification: write.justification,
                expiresAt: write.expiresAt,
                confirmedByUserId: ctx.userId,
                confirmedAt: now,
                signalsJson: (seen.signalsJson ?? []) as Prisma.InputJsonValue,
                // A re-decision clears any suspension: the reviewer has just
                // looked at the current facts, which is the thing a suspension
                // was asking for.
                status: 'ACTIVE',
                suspendedReason: null,
                suspendedAt: null,
            },
        });

        await logEvent(db, ctx, {
            entityType: 'LegacyIdentityAlias',
            entityId: row.id,
            action: 'LEGACY_RECONCILIATION_DECIDED',
            details:
                `Account ${input.accountKey} classified ${write.classification}`
                + ` (${write.method}) on connection ${input.connectionId}`,
            detailsJson: {
                category: 'custom',
                event: 'legacy_reconciliation_decided',
                connectionId: input.connectionId,
                accountKey: input.accountKey,
                executionId: input.executionId,
                classification: write.classification,
                method: write.method,
                employeeId: write.employeeId,
                ownerUserId: write.ownerUserId,
                hasJustification: write.justification !== null,
                expiresAt: write.expiresAt?.toISOString() ?? null,
                // The signals, so the audit row answers "what were they looking
                // at". The justification is NOT here: it is encrypted on the
                // alias row, and copying it into an audit row would put the
                // plaintext somewhere the manifest does not cover.
                signals: seen.signalsJson,
                resolutionOutcome: seen.outcome,
            },
        });

        return {
            accountKey: input.accountKey,
            outcome: 'WRITTEN' as const,
            classification: write.classification,
            aliasId: row.id,
        };
    });
}

// ─── Bulk ─────────────────────────────────────────────────────────────────

export interface BulkConfirmRow {
    readonly accountKey: string;
    readonly employeeId: string;
}

export interface BulkConfirmOutcome {
    readonly accountKey: string;
    readonly ok: boolean;
    readonly reason: string | null;
}

/**
 * The margin between the leader and the runner-up, or `Infinity` when there is
 * no runner-up.
 *
 * `Infinity` rather than the leader's own score: a sole candidate is not
 * "ahead by its score", it is unopposed, and treating the two the same would
 * make a weak sole candidate fail a margin a strong one passes — which is
 * backwards, since the sole candidate is the LESS ambiguous row.
 */
export function candidateMargin(candidates: readonly ScoredCandidate[]): number {
    if (candidates.length === 0) return 0;
    if (candidates.length === 1) return Number.POSITIVE_INFINITY;
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    return sorted[0].score - sorted[1].score;
}

/**
 * Confirm several SUGGESTED rows at once.
 *
 * Each row goes through the SAME `decideLegacyAccount` path, so every check
 * above applies per row — the version check, the candidate check, the tenant
 * check. Bulk is a convenience over the single path, not a second path with its
 * own rules, which is the only way the two cannot drift.
 */
export async function bulkConfirmLegacyAccounts(
    ctx: RequestContext,
    input: {
        readonly connectionId: string;
        readonly executionId: string;
        readonly rows: readonly BulkConfirmRow[];
    }
): Promise<readonly BulkConfirmOutcome[]> {
    assertCanConfirmReconciliation(ctx);

    if (input.rows.length === 0) throw badRequest('no rows to confirm');
    if (input.rows.length > BULK_MAX_ROWS) {
        throw badRequest(`bulk confirmation is capped at ${BULK_MAX_ROWS} rows per request`);
    }

    const out: BulkConfirmOutcome[] = [];

    for (const row of input.rows) {
        try {
            const seen = await readSeenResolution(ctx, {
                accountKey: row.accountKey,
                executionId: input.executionId,
            });

            // SUGGESTED only. An AMBIGUOUS row is one the engine refused to
            // decide between equal candidates, and an UNMATCHED row has no
            // evidence at all — neither is something a bulk approval should be
            // able to sweep up.
            if (seen.outcome !== 'SUGGESTED') {
                out.push({
                    accountKey: row.accountKey,
                    ok: false,
                    reason: `only SUGGESTED rows may be confirmed in bulk; this one is ${seen.outcome}`,
                });
                continue;
            }

            const margin = candidateMargin(seen.candidates);
            if (margin < BULK_MIN_MARGIN) {
                out.push({
                    accountKey: row.accountKey,
                    ok: false,
                    reason:
                        `margin ${margin} is under ${BULK_MIN_MARGIN}; `
                        + 'confirm this one individually, where the evidence is shown',
                });
                continue;
            }

            await decideLegacyAccount(ctx, {
                connectionId: input.connectionId,
                accountKey: row.accountKey,
                executionId: input.executionId,
                action: { kind: 'CONFIRM', employeeId: row.employeeId },
            });
            out.push({ accountKey: row.accountKey, ok: true, reason: null });
        } catch (e) {
            // Per row, never per request. A bulk call that half-succeeds has to
            // say WHICH half, or the reviewer's only safe move is to assume none
            // of it worked and do all fifty again.
            out.push({
                accountKey: row.accountKey,
                ok: false,
                reason: e instanceof Error ? e.message : 'failed',
            });
        }
    }

    return out;
}

/**
 * Why a row is in the queue.
 *
 * The reviewer needs this distinction. `UNDECIDED` is work nobody has done;
 * `EXTERNAL_EXPIRED` is work somebody DID, whose answer has a shelf life and has
 * reached the end of it. Showing them identically would make a lapsed
 * contractor look like a fresh unknown, and the right question is different in
 * each case — "who is this?" versus "are they still here?".
 */
export type QueueReason = 'UNDECIDED' | 'EXTERNAL_EXPIRED';

/**
 * The model's annotation on a queue row, when there is one to show.
 *
 * Carries the probabilities AND the labelling, because one without the other is
 * not readable: the probabilities are keyed by the shuffled letters that were
 * sent, so `{"C": 0.91}` means nothing until a letter resolves to a person.
 */
export interface QueueVerdict {
    readonly verdict: string;
    readonly topOption: string | null;
    readonly topProbability: number | null;
    readonly topMargin: number | null;
    /** Letter to employee id, for the letters actually sent. */
    readonly labelling: Readonly<Record<string, string>>;
    readonly modelRevision: string;
}

export interface QueueRow {
    readonly accountKey: string;
    readonly outcome: string;
    readonly candidates: readonly ScoredCandidate[];
    readonly reason: QueueReason;
    /** For EXTERNAL_EXPIRED: when it lapsed. */
    readonly expiredAt: Date | null;
    /**
     * The model's annotation, or null.
     *
     * NULL FOR A BLIND-SAMPLED ROW, and that is the whole mechanism. A row in
     * the sample must be INDISTINGUISHABLE from a row the model said nothing
     * about — if the API said "this is a blind sample" the reviewer would be
     * careful exactly where we are measuring, and the number we got back would
     * describe a careful reviewer rather than a typical one.
     *
     * So there is no `blindHeld` field here on purpose. The server knows; the
     * reviewer sees a row with no verdict, which is the commonest kind of row
     * anyway (`UNSURE`, `NO_EVALUATION`, a timeout). The comparison that the
     * sample exists for happens server-side, after they decide.
     */
    readonly verdict: QueueVerdict | null;
    /**
     * May this row be ratified in the `AGREES` bulk lane?
     *
     * All five terms of `eligibleForBulkRatification`, and a blind-sampled row
     * is excluded BECAUSE IT IS BLIND rather than as a side effect of its
     * verdict being hidden — the eligibility is computed from the raw row, so
     * the server knows it is an `AGREES` and declines it anyway.
     *
     * This leaks nothing about the sample: a blind row reads
     * `{verdict: null, bulkEligible: false}`, which is exactly what an
     * unadjudicated row reads.
     */
    readonly bulkEligible: boolean;
}

/**
 * All five bulk-lane terms, assembled for `eligibleForBulkRatification`.
 *
 * Computed from the RAW verdict row rather than the one a reviewer sees, so a
 * blind-sampled `AGREES` is declined BECAUSE IT IS BLIND. Deriving it from the
 * hidden verdict would give the same answer today by accident — the hidden row
 * has no class to match on — and would stop being right the moment anything
 * else started hiding a verdict.
 *
 * A NULL `suggestedRekeyed` reads as RE-KEYED, which is the fail-closed
 * direction. The column is nullable with no backfill, so every row written
 * before it existed genuinely does not know the answer; treating "unknown" as
 * "not re-keyed" would admit exactly those rows to the lane, and unknown is not
 * a reason to ratify in bulk.
 */
function bulkEligibleFor(input: {
    raw:
        | { id: string; verdict: string | null }
        | undefined;
    suggestedEmployeeId: string | null;
    candidateIsActive: boolean;
    hasVeto: boolean;
    isPrivileged: boolean;
    suggestedRekeyed: boolean | null;
}): boolean {
    const verdict = input.raw?.verdict;
    if (!verdict) return false;
    // The lane ratifies the ENGINE's suggestion, so a row without one has no
    // candidate to ratify however confident the model was.
    if (!input.suggestedEmployeeId) return false;

    return eligibleForBulkRatification({
        verdict: verdict as VerdictClass,
        candidateIsActive: input.candidateIsActive,
        hasVeto: input.hasVeto,
        isPrivileged: input.isPrivileged,
        isRekeyed: input.suggestedRekeyed !== false,
        blindHeld: isBlindHeld(input.raw!.id),
    });
}

/**
 * The verdict a reviewer may see, or null.
 *
 * THREE REASONS TO SHOW NOTHING, and they must be indistinguishable from each
 * other on the wire:
 *
 *   - there is no verdict row at all (adjudication off, or never run);
 *   - the row carries a NON-VERDICT reason, so no model answered;
 *   - the row is in the BLIND SAMPLE.
 *
 * The third is the one that has to look like the other two. If a reviewer could
 * tell a withheld verdict from an absent one, they would know which rows are
 * being measured, and the precision we measured would be of a reviewer who knew
 * they were being watched.
 *
 * `UNSURE` is also withheld. It is a real verdict, and showing it would tell a
 * reviewer the model looked and had no opinion — which is information, but not
 * information that helps them decide, and it is one more thing to distinguish a
 * blind row from. The design's `UNSURE` lane is "the queue as it would be
 * without a model", so this keeps it exactly that.
 */
function showableVerdict(
    row:
        | {
              id: string;
              verdict: string | null;
              modelRevision: string;
              topProbability: number | null;
              topMargin: number | null;
              probabilitiesJson: unknown;
              labellingJson: unknown;
          }
        | undefined
): QueueVerdict | null {
    if (!row || !row.verdict) return null;
    if (row.verdict === 'UNSURE') return null;
    if (isBlindHeld(row.id)) return null;

    const labelling =
        row.labellingJson && typeof row.labellingJson === 'object' && !Array.isArray(row.labellingJson)
            ? (row.labellingJson as Record<string, string>)
            : {};
    const probabilities =
        row.probabilitiesJson && typeof row.probabilitiesJson === 'object'
            ? (row.probabilitiesJson as Record<string, unknown>)
            : {};

    return {
        verdict: row.verdict,
        topOption: typeof probabilities.top === 'string' ? probabilities.top : null,
        topProbability: row.topProbability,
        topMargin: row.topMargin,
        labelling,
        modelRevision: row.modelRevision,
    };
}

/**
 * The queue: everything a reviewer still has to decide.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DECIDED ACCOUNT LEAVES THE QUEUE — WHICH TAKES AN ALIAS READ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine resolves an account on evidence, and three of the six reviewer
 * actions produce no evidence it can use: `readAliases` feeds it only EMPLOYEE
 * aliases, because only those name a person. So a NON_PERSON, EXTERNAL or
 * ORPHAN account resolves `UNMATCHED` on every subsequent run, for ever.
 *
 * Listing the queue from resolutions ALONE therefore undoes the reviewer's work
 * every cycle: they classify forty service accounts, the next run resolves all
 * forty as UNMATCHED, and the queue asks them again. The suppression has to come
 * from the alias table, because that is where the answer lives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE THINGS THAT DO *NOT* SUPPRESS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * - **A SUSPENDED alias.** Revalidation suspends exactly when it has stopped
 *   believing the answer, so a suspended row is the clearest case of something
 *   needing a human. Suppressing on it would hide the output of the
 *   revalidation pass behind the pass's own effect.
 *
 * - **An EXPIRED `EXTERNAL`.** The classification said "not on the roster, and
 *   that is true until this date". Past the date it is not a wrong answer, it is
 *   an OLD one — so the account returns, labelled {@link QueueReason}
 *   `EXTERNAL_EXPIRED` rather than as a fresh unknown.
 *
 * - **An alias on a different connection.** The key is
 *   `(connectionId, accountKey)`; the same login name in two legacy systems is
 *   two accounts, and one reviewer's decision about one of them says nothing
 *   about the other.
 *
 * Read with the VIEW key, not confirm: an auditor checking that the queue is
 * being worked needs exactly this, and a reviewer who may not decide may still
 * need to see what is outstanding.
 */
export async function listReconciliationQueue(
    ctx: RequestContext,
    input: { readonly executionId: string; readonly connectionId: string; readonly now?: Date }
): Promise<readonly QueueRow[]> {
    assertCanViewReconciliation(ctx);

    const now = input.now ?? new Date();

    const [rows, aliases] = await Promise.all([
        runInTenantContext(ctx, (db) =>
            db.legacyAccountResolution.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    executionId: input.executionId,
                    // The three a human has to look at. LINKED needs nobody, and
                    // NON_PERSON was already decided by rule rather than by a
                    // person.
                    outcome: { in: ['SUGGESTED', 'AMBIGUOUS', 'UNMATCHED'] },
                },
                orderBy: { accountKey: 'asc' },
                select: {
                    id: true,
                    accountKey: true,
                    outcome: true,
                    candidatesJson: true,
                    employeeId: true,
                    vetoesJson: true,
                    suggestedRekeyed: true,
                },
            })
        ),
        runInTenantContext(ctx, (db) =>
            db.legacyIdentityAlias.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    connectionId: input.connectionId,
                    status: 'ACTIVE',
                },
                select: { accountKey: true, classification: true, expiresAt: true },
            })
        ),
    ]);

    const decided = new Map(aliases.map((a) => [a.accountKey, a]));

    // One read for the whole page, not one per row. A verdict is one per
    // (resolution, revision); the NEWEST is the one to show, because an older
    // revision's answer has been superseded by a model somebody deliberately
    // changed to.
    const verdicts =
        rows.length === 0
            ? []
            : await runInTenantContext(ctx, (db) =>
                  db.legacyMatchVerdict.findMany({
                      where: { tenantId: ctx.tenantId, resolutionId: { in: rows.map((r) => r.id) } },
                      orderBy: { createdAt: 'desc' },
                      select: {
                          id: true,
                          resolutionId: true,
                          verdict: true,
                          modelRevision: true,
                          topProbability: true,
                          topMargin: true,
                          probabilitiesJson: true,
                          labellingJson: true,
                      },
                  })
              );
    const verdictByResolution = new Map<string, (typeof verdicts)[number]>();
    for (const v of verdicts) {
        if (!verdictByResolution.has(v.resolutionId)) verdictByResolution.set(v.resolutionId, v);
    }

    // The bulk lane's other two terms, one read each for the whole page. The
    // fourth — "no re-key" — is already on the row, stamped by the run, because
    // asking it here would read every `Employee` (see the column's docstring).
    const suggestedIds = [...new Set(rows.map((r) => r.employeeId).filter((id): id is string => !!id))];
    const activeSuggested = suggestedIds.length
        ? new Set(
              (
                  await runInTenantContext(ctx, (db) =>
                      db.employee.findMany({
                          where: { tenantId: ctx.tenantId, id: { in: suggestedIds }, status: 'ACTIVE' },
                          select: { id: true },
                      })
                  )
              ).map((e) => e.id)
          )
        : new Set<string>();

    const privilegedKeys = new Set(
        (
            await runInTenantContext(ctx, (db) =>
                db.legacyAccount.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        accountKey: { in: rows.map((r) => r.accountKey) },
                        isPrivileged: true,
                    },
                    select: { accountKey: true },
                })
            )
        ).map((a) => a.accountKey)
    );

    const out: QueueRow[] = [];
    for (const r of rows) {
        const a = decided.get(r.accountKey);
        const base = {
            accountKey: r.accountKey,
            outcome: r.outcome,
            candidates: (r.candidatesJson ?? []) as unknown as readonly ScoredCandidate[],
            verdict: showableVerdict(verdictByResolution.get(r.id)),
            bulkEligible: bulkEligibleFor({
                raw: verdictByResolution.get(r.id),
                suggestedEmployeeId: r.employeeId,
                candidateIsActive: !!r.employeeId && activeSuggested.has(r.employeeId),
                hasVeto: Array.isArray(r.vetoesJson) && r.vetoesJson.length > 0,
                isPrivileged: privilegedKeys.has(r.accountKey),
                suggestedRekeyed: r.suggestedRekeyed,
            }),
        };

        if (!a) {
            out.push({ ...base, reason: 'UNDECIDED', expiredAt: null });
            continue;
        }

        // An EXTERNAL past its date comes BACK, labelled. Everything else with a
        // live alias stays out: the reviewer answered it.
        const lapsed =
            a.classification === 'EXTERNAL'
            && a.expiresAt !== null
            && a.expiresAt.getTime() <= now.getTime();

        if (lapsed) {
            out.push({ ...base, reason: 'EXTERNAL_EXPIRED', expiredAt: a.expiresAt });
        }
    }

    return out;
}

/**
 * The EXTERNAL classifications that have lapsed, across a connection.
 *
 * Exposed separately from the queue because the two answer different questions.
 * The queue is bounded to ONE run and shows what a reviewer should work on now;
 * this is bounded to the connection and answers "how much of our external
 * population has gone stale", which is a number somebody reports rather than
 * works through.
 *
 * Deliberately NOT a suspension. Nothing about a lapsed EXTERNAL became
 * doubtful — `suspendedReason` is a closed set of four facts that make an alias
 * untrustworthy, and "it got old" is not one of them. Writing it there would
 * make the suspension metric unreadable: a spike would no longer mean the HR
 * feed or the accounts had changed, it would mean a quarter had ended.
 */
export async function listExpiredExternals(
    ctx: RequestContext,
    input: { readonly connectionId: string; readonly now?: Date }
): Promise<readonly { accountKey: string; expiredAt: Date }[]> {
    assertCanViewReconciliation(ctx);
    const now = input.now ?? new Date();

    const rows = await runInTenantContext(ctx, (db) =>
        db.legacyIdentityAlias.findMany({
            where: {
                tenantId: ctx.tenantId,
                connectionId: input.connectionId,
                status: 'ACTIVE',
                classification: 'EXTERNAL',
                expiresAt: { lte: now },
            },
            orderBy: { expiresAt: 'asc' },
            select: { accountKey: true, expiresAt: true },
        })
    );

    // `expiresAt` is non-null by the filter; the cast records that rather than
    // re-checking it.
    return rows.map((r) => ({ accountKey: r.accountKey, expiredAt: r.expiresAt as Date }));
}
