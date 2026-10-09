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
 * The queue: everything a reviewer still has to decide.
 *
 * `assertCanViewReconciliation`, not the confirm key — a reviewer who may not
 * decide may still need to see what is outstanding, and an auditor checking
 * that the queue is being worked needs exactly this read.
 */
export async function listReconciliationQueue(
    ctx: RequestContext,
    input: { readonly executionId: string }
): Promise<readonly { accountKey: string; outcome: string; candidates: readonly ScoredCandidate[] }[]> {
    assertCanViewReconciliation(ctx);

    const rows = await runInTenantContext(ctx, (db) =>
        db.legacyAccountResolution.findMany({
            where: {
                tenantId: ctx.tenantId,
                executionId: input.executionId,
                // The three a human has to look at. LINKED needs nobody, and
                // NON_PERSON was already decided by rule.
                outcome: { in: ['SUGGESTED', 'AMBIGUOUS', 'UNMATCHED'] },
            },
            orderBy: { accountKey: 'asc' },
            select: { accountKey: true, outcome: true, candidatesJson: true },
        })
    );

    return rows.map((r) => ({
        accountKey: r.accountKey,
        outcome: r.outcome,
        candidates: (r.candidatesJson ?? []) as unknown as readonly ScoredCandidate[],
    }));
}
