/**
 * One connection's position on the external-write ladder (#2861).
 *
 * The ladder itself is `src/lib/integrations/external-write-ladder.ts`, landed by
 * #2933 with no storage on purpose: "adding `externalWriteMode` columns now would
 * be a migration for a mechanism with no reader and no writer". This file is that
 * reader and writer.
 *
 * ## WHAT READS THE RUNG — IT USED TO BE NOTHING, AND THE ORDER WAS THE POINT
 *
 * This file shipped with a note saying it changed no agent behaviour: "nothing
 * in the funnel consults the rung yet, so a connection at `DRY_RUN` and a
 * connection at `DISABLED` are treated identically by every tool call today".
 * That was true, and deliberate — #2933's argument is that the control arrives
 * BEFORE the authority it governs, because #2241's lesson is what a rung costs
 * when it arrives after. The write path cannot be born ungated: it has to ask,
 * and the default answer is `DISABLED`.
 *
 * It is no longer true. Kept in the past tense rather than deleted, because the
 * ORDER is the argument and a reader should be able to see it was honoured.
 * Three readers exist now:
 *
 *   `resolveExternalReadTools`   `DISABLED` drops the connection before a
 *                                credential is decrypted or a socket opened (#2976)
 *   `dispatchWrite`              `DRY_RUN` journals what WOULD change and sends
 *                                nothing; `PROPOSE_ONLY` queues an
 *                                `AgentProposal` for a human (#2983, #2999)
 *   `openApprovedExternalWrite`  re-reads the rung at the instant a human
 *                                approves, so a withdrawal refuses in front of
 *                                them rather than hours later (#3002)
 *
 * `EXTERNAL_MAX_MODE` is `PROPOSE_ONLY` as of step 6 of #2861: every rung at or
 * below it is implemented end to end. `AUTOMATIC` is implemented too as of
 * #3051 — `openAutomaticExternalWrite` is its arm — and stays ABOVE the
 * ceiling anyway, which is now a DELIBERATE HOLD rather than code waiting on a
 * design decision. The refusal an operator sees for it below has been reworded
 * accordingly: telling them "nothing reads this rung" stopped being true, and a
 * refusal whose stated reason the operator can disprove is the exact failure
 * #2843 finding 31 is about.
 *
 * ## Where the authorization lives
 *
 * OWNER-only, at the ROUTE, via `requirePermission('admin.tenant_lifecycle')`.
 * It is NOT repeated here as an `assertCanAdmin` — the identity policy states the
 * reason and it applies unchanged: a second, weaker gate inside the usecase is
 * how a route ends up looking protected while granting more than the route said,
 * and an `assertCanAdmin` denial writes no `AUTHZ_DENIED` row where a
 * `requirePermission` denial does.
 */
import type { Prisma } from '@prisma/client';

import { badRequest, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

import {
    LADDER,
    EXTERNAL_MAX_MODE,
    coerceStoredMode,
    isAboveClamp,
    refusalForMove,
    type ExternalWriteMode,
    type ExternalWriteState,
} from '@/lib/integrations/external-write-ladder';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';

/** One connection's rung, plus what the surface needs to explain it. */
export interface ExternalWritePolicy extends ExternalWriteState {
    readonly connectionId: string;
    readonly connectionName: string;
    /** The ceiling this build honours, published so a UI can grey out the rest. */
    readonly maxMode: ExternalWriteMode;
    /** Why each rung above the current one is refused, or null where permitted. */
    readonly refusals: Readonly<Record<string, string | null>>;
}

/**
 * What the CURRENT rung has produced since its window opened.
 *
 * ── THE SEAM THAT NEVER CONNECTED ───────────────────────────────────────────
 *
 * This counted `IntegrationExecution` rows whose `automationKey` ended in
 * `:external-write`. NOTHING HAS EVER WRITTEN SUCH A ROW. The constant naming
 * that suffix said as much itself — declared beside the rung "rather than in the
 * dispatch that will write it" — and warned that a hardcoded 0 "would go on
 * refusing after the dispatch shipped, silently, until somebody remembered the
 * line". The dispatch shipped as #2983, recorded intents in the JOURNAL instead,
 * and nobody remembered the line. The docstring predicted its own failure mode
 * and was right.
 *
 * So the count was 0 for every connection, always, and `DRY_RUN → PROPOSE_ONLY`
 * was refused on a stated reason that was false — the operator is told the rung
 * has recorded nothing while the journal fills up beside it.
 *
 * It stayed invisible because `getExternalWritePolicy` asks `isAboveClamp`
 * FIRST: with the clamp at `DRY_RUN`, every wider rung returns the ceiling
 * message and `refusalForMove` is never reached, so this gate has never once
 * been exercised. It would have gone live, broken, on the first diff that raised
 * the clamp — the single change it exists to guard.
 *
 * The journal is the right table and the schema says so in three places that all
 * predate this fix: `ExternalWriteJournal`'s header ("the dwell counts rows by
 * `mode` and `outcome`"), its `@@index([tenantId, mode, attemptedAt])` commented
 * "the dwell's evidence query", and `ExternalWriteOutcome.RECORDED_ONLY` ("this
 * is what the ladder's dwell COUNTS as evidence"). The index was built for
 * exactly this query and had no caller.
 *
 * ── PROPOSE_ONLY USED TO RETURN undefined ON A PREMISE STEP 6 FALSIFIED ─────
 *
 * The premise, stated here verbatim until this fix: "`MODE_MIN_EVIDENCE` asks
 * that rung for APPROVED PROPOSALS, and no external write can be proposed yet —
 * `dispatchWrite` refuses the rung outright with
 * `external_write_rung_unimplemented`. There is nothing to count."
 *
 * Step 6 of #2861 raised `EXTERNAL_MAX_MODE` from `DRY_RUN` to `PROPOSE_ONLY`.
 * A connection can hold that rung, `dispatchWrite` QUEUES an `AgentProposal` of
 * kind `EXTERNAL_WRITE` there rather than refusing, and `approveAgentProposal`
 * applies one. Proposals exist; approvals exist; there is something to count.
 *
 * Nothing was unsafe in the interval, and that is also why the falsification
 * was invisible: the only move that asks this rung for evidence is
 * `PROPOSE_ONLY → AUTOMATIC`, `AUTOMATIC` is above the ceiling, and
 * `getExternalWritePolicy` consults `isAboveClamp` BEFORE `refusalForMove` — so
 * no caller has ever read this number. Exactly the shape the section above
 * describes for the `DRY_RUN` gate, which is the argument for fixing it now
 * rather than in the diff that raises the ceiling again.
 *
 * ── THE JOIN, WHICH IS THE WHOLE QUESTION ───────────────────────────────────
 *
 * The count is PER CONNECTION and per window, and `AgentProposal` HAS NO
 * `connectionId`. The connection id lives inside `payloadJson` — a `String` in
 * `ENCRYPTED_FIELDS`, encrypted at rest, so it cannot be filtered in SQL at
 * all. Counting proposals directly would mean reading every accepted
 * `EXTERNAL_WRITE` proposal in the window, decrypting each payload and matching
 * in JS: an unbounded read growing with queue history, to recover a fact stored
 * one table over in an indexed column.
 *
 * So the join goes through the row the APPROVAL WRITES.
 * `approveAgentProposal` calls `openApprovedExternalWrite` only after the full
 * `requiredApprovals` count of DISTINCT humans has signed, and that opens an
 * `ExternalWriteJournal` row carrying `connectionId` and the rung it was
 * approved under. The biconditional is exact:
 *
 *   a journal row at `mode = 'PROPOSE_ONLY'`
 *     ⟺ an `EXTERNAL_WRITE` proposal against that connection met its approval
 *       requirement and a human committed to the write
 *
 * — because `recordIntent` throws on any mode but `DRY_RUN`, `beginWrite`
 * refuses `DRY_RUN` and `DISABLED`, `openApprovedExternalWrite` is
 * `beginWrite`'s only external-write caller, and the `external-write-dispatch`
 * pass only ever SETTLES rows it did not create. The journal row is the better
 * evidence of the two anyway: it is written BY the approval, under the rung
 * re-checked at that instant, and it is what `AgentProposal.createdEntityId`
 * then points at.
 *
 * Every dispatched outcome counts — see `DISPATCHED_OUTCOMES`. What this rung
 * is asked to prove is that HUMANS REVIEWED external writes, which is the
 * ladder's own wording, and the far end's answer is a different fact. A write a
 * human approved and the far end then refused is still a review that happened;
 * narrowing to `APPLIED` would let an unreliable third party hold a tenant at
 * `PROPOSE_ONLY` for a reason with nothing to do with human review.
 *
 * ── undefined STILL MEANS "COULD NOT COUNT", AND NEVER ZERO ─────────────────
 *
 * The two are not collapsed, and `refusalForMove` still carries a separate
 * sentence for each. A rung absent from `EVIDENCE_PREDICATE` has no query
 * written for it, so nothing was looked at, and `undefined` says precisely
 * that. `AUTOMATIC` is the live case: top rung, nothing is widened off it,
 * `MODE_MIN_EVIDENCE` lists no requirement — there is no question, so a 0 would
 * claim an answer. (`DISABLED` never arrives here at all; the call site skips
 * it, because a rung that produces nothing by construction has nothing to
 * count.)
 */

/**
 * The outcomes a row OPENED BY `beginWrite` can hold — i.e. a write something
 * was obliged to send.
 *
 * `RECORDED_ONLY` is the one value absent, and the absence is the pin: it is the
 * terminal outcome `recordIntent` stamps, and `recordIntent` refuses every mode
 * but `DRY_RUN`. So it cannot narrow the `PROPOSE_ONLY` population today — like
 * the `DRY_RUN` pair below it pins the claim rather than trusting one writer to
 * remain the only one.
 *
 * A positive list rather than `{ not: 'RECORDED_ONLY' }`, because the two
 * differ in which way they fail when `ExternalWriteOutcome` gains a value: a
 * negation silently COUNTS the unknown outcome as evidence and widens
 * authority, a list silently EXCLUDES it and keeps the gate shut until somebody
 * decides what it means. Shut is the safe half.
 */
const DISPATCHED_OUTCOMES = ['PENDING', 'APPLIED', 'FAILED', 'INDETERMINATE'] as const;

/**
 * What counts as EVIDENCE for each rung that has a requirement.
 *
 * A table rather than a chain of `if`s so the answerable rungs are ENUMERABLE:
 * `EVIDENCE_COUNTABLE_RUNGS` below reads its keys, and a unit test holds those
 * against `MODE_MIN_EVIDENCE`'s. A rung that demands evidence and has no entry
 * here is a gate that can NEVER be satisfied — "could not count" for ever, the
 * ladder permanently shut on a true-but-useless sentence — which is #2993's
 * failure wearing a different costume. No type can catch it, because
 * `MODE_MIN_EVIDENCE` is a value and not a type.
 *
 * Each predicate names its `mode` as a LITERAL rather than reusing the caller's
 * parameter, so an entry is a claim a reader can check against the enum's
 * contract instead of a filter assembled at runtime for a rung nobody wrote a
 * meaning for.
 */
const EVIDENCE_PREDICATE: Partial<
    Record<ExternalWriteMode, Prisma.ExternalWriteJournalWhereInput>
> = {
    // `mode` AND `outcome`, not `outcome` alone: the pair is what the index
    // leads on and what the enum's contract names.
    DRY_RUN: { mode: 'DRY_RUN', outcome: 'RECORDED_ONLY' },
    // An approved proposal, reached through the row the approval opens — see
    // the header's biconditional.
    PROPOSE_ONLY: { mode: 'PROPOSE_ONLY', outcome: { in: [...DISPATCHED_OUTCOMES] } },
};

/**
 * The rungs `countEvidenceForRung` can answer for. DERIVED, so there is one
 * source and the published list cannot drift from the queries.
 *
 * Exported for the invariant test described on `EVIDENCE_PREDICATE`, not for
 * runtime use — nothing branches on it.
 */
export const EVIDENCE_COUNTABLE_RUNGS: readonly ExternalWriteMode[] = Object.keys(
    EVIDENCE_PREDICATE,
) as ExternalWriteMode[];

async function countEvidenceForRung(
    ctx: RequestContext,
    connectionId: string,
    mode: ExternalWriteMode,
    since: Date,
): Promise<number | undefined> {
    // Plain indexing, and NO `hasOwnProperty` guard — unlike `coerceStoredMode`,
    // which needs one because it indexes a hand-written table with an arbitrary
    // `string` and would hand back an inherited `Object.prototype` member. Here
    // `mode` is the narrowed rung union, already through `coerceStoredMode`, so
    // `__proto__` and `constructor` are unrepresentable. Stated rather than left
    // looking like an oversight.
    const predicate = EVIDENCE_PREDICATE[mode];

    // No query written for this rung means nothing was looked at. `undefined`,
    // never 0 — the header's last section is about this line.
    if (!predicate) return undefined;

    return runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.count({
            where: {
                tenantId: ctx.tenantId,
                connectionId,
                attemptedAt: { gte: since },
                ...predicate,
            },
        }),
    );
}

/** Load one MCP-server connection's rung, coerced at the read boundary. */
export async function getExternalWritePolicy(
    ctx: RequestContext,
    connectionId: string,
): Promise<ExternalWritePolicy> {
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: MCP_SERVER_PROVIDER_ID },
            select: {
                id: true,
                name: true,
                externalWriteMode: true,
                externalWriteModeSince: true,
            },
        }),
    );
    if (!row) throw notFound('No such MCP server connection');

    // COERCED HERE, at the read boundary, and never further in. `coerceStoredMode`
    // fails closed to DISABLED for a rung this build does not recognise — and the
    // failure direction is the point, because `isAboveClamp` sorts an unknown mode
    // to -1, which reads as NOT above any clamp, i.e. permitted.
    const mode = coerceStoredMode(row.externalWriteMode);
    const modeSince = row.externalWriteModeSince;

    // Counted only when it can arise: a rung with an evidence requirement and an
    // open window. Every other state has nothing to prove, and this keeps the
    // read cheap for the common DISABLED case.
    const evidenceInWindow =
        modeSince && mode !== 'DISABLED'
            ? await countEvidenceForRung(ctx, row.id, mode, modeSince)
            : undefined;

    const state: ExternalWriteState = { mode, modeSince, evidenceInWindow };
    const now = new Date();

    // Every rung's verdict, precomputed. A surface that shows only "widen" has to
    // guess what the next rung is; one that shows a reason per rung can explain
    // the refusal the operator is about to hit before they hit it.
    const refusals: Record<string, string | null> = {};
    for (const rung of LADDER) {
        refusals[rung] = isAboveClamp(rung, EXTERNAL_MAX_MODE)
            ? // REWORDED, and the old sentence is why. It read "nothing reads
              // this rung to decide whether to send yet", which was true while
              // `AUTOMATIC` was unimplemented and is false now that the arm
              // exists. An operator who can disprove a refusal's stated reason
              // concludes the gate is broken — #2843 finding 31 — so the
              // sentence says what is actually true: the rung works, and this
              // build is held below it on purpose.
              `${rung} is above the ceiling this build honours (${EXTERNAL_MAX_MODE}). `
              + 'The rung is implemented; this build is deliberately held below it, and '
              + 'raising the ceiling is a reviewed code change rather than a setting. '
              + 'Selecting it here would name an authority the dispatch would refuse.'
            : refusalForMove(state, rung, now);
    }

    return {
        ...state,
        connectionId: row.id,
        connectionName: row.name,
        maxMode: EXTERNAL_MAX_MODE,
        refusals,
    };
}

/**
 * Move one connection to `next`, or refuse with a reason.
 *
 * `clamp` is REQUIRED rather than defaulted, and that is the defence here, copied
 * from `setIdentityWriteMode`: this value comes from OUTSIDE this file, and an
 * optional parameter that callers forget is indistinguishable from a check that
 * was never written. The only caller is the admin route, which already imports
 * `EXTERNAL_MAX_MODE` to publish it as `maxMode`.
 */
export async function setExternalWriteMode(
    ctx: RequestContext,
    connectionId: string,
    next: ExternalWriteMode,
    clamp: ExternalWriteMode,
    now: Date = new Date(),
): Promise<ExternalWritePolicy> {
    if (!LADDER.includes(next)) throw badRequest(`Unknown external write mode: ${next}`);

    const current = await getExternalWritePolicy(ctx, connectionId);

    // The clamp is checked BEFORE the ladder, because it is the stronger claim:
    // the ladder says "not yet", the clamp says "not in this build at all", and
    // telling an operator to wait seven days for a rung that would still be
    // refused afterwards is the refusal #2843 finding 31 called worse than a
    // vaguer one.
    if (isAboveClamp(next, clamp)) {
        throw badRequest(
            `${next} is above the ceiling this build honours (${clamp}). The dispatch would `
            + 'refuse the rung as well, so selecting it would grant nothing and record that '
            + 'something had been granted.',
        );
    }

    const refusal = refusalForMove(current, next, now);
    if (refusal) throw badRequest(refusal);

    // A no-op is not a move, and must not restart the window. Re-selecting the
    // current rung IS the documented way to open a window that has none — see the
    // ladder's `modeSince` refusal — so that case is allowed through below.
    if (next === current.mode && current.modeSince) return current;

    await runInTenantContext(ctx, async (db) => {
        await db.integrationConnection.update({
            where: { id: connectionId, tenantId: ctx.tenantId },
            data: { externalWriteMode: next, externalWriteModeSince: now },
        });
        await logEvent(db, ctx, {
            action: 'EXTERNAL_WRITE_MODE_CHANGED',
            entityType: 'IntegrationConnection',
            entityId: connectionId,
            details: `External write mode for "${current.connectionName}": ${current.mode} → ${next}`,
            detailsJson: {
                // `access`, not `configuration`, for the reason the identity
                // equivalent gives: widening this grants the product authority to
                // CHANGE something in a system that is not ours, and an
                // access-review reader is the audience for that.
                category: 'access',
                operation: next === 'DISABLED' ? 'revoke' : 'grant',
                summary: `External write mode: ${current.mode} → ${next}`,
            },
            metadata: { connectionId, from: current.mode, to: next },
        });
    });

    logger.info('external write mode changed', {
        component: 'external-write-policy',
        tenantId: ctx.tenantId,
        connectionId,
        from: current.mode,
        to: next,
    });

    return getExternalWritePolicy(ctx, connectionId);
}
