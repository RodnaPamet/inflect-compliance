/**
 * SEND THE EXTERNAL WRITES THAT ARE DUE (#2861), and refuse the ones whose
 * basis stopped holding.
 *
 * Two things open the rows this pass sweeps, and the difference decides almost
 * everything below. `openApprovedExternalWrite` opens one when a human approves
 * a `PROPOSE_ONLY` proposal; `openAutomaticExternalWrite` opens one when the
 * `AUTOMATIC` rung dispatches with no human at all. Both land `PENDING` and send
 * nothing. This pass is the ONLY sender in the build, and the work-list is
 * exactly "PENDING journal rows", which is the sweep `@@index([tenantId,
 * outcome])` was built for.
 *
 * ## The order is the design, again
 *
 *   1. Is the connection still permitted to be written to? No → FAILED.
 *   2. Is the ROW's own rung still permitted by the connection's current one?
 *      No → FAILED. (A narrowing from AUTOMATIC to PROPOSE_ONLY is invisible to
 *      step 1 and is precisely about the rows opened without a human.)
 *   3. Is there still a prior-state pairing? No → FAILED.
 *   4. The DRIFT CHECK, which asks a different question per rung — below.
 *   5. Only then, send.
 *
 * Steps 1-4 send nothing, and each records WHY on the row a human can read.
 *
 * ## Why drift is a refusal and not a warning — AND WHY IT IS TWO CHECKS
 *
 * At `PROPOSE_ONLY` a human approved a specific change to a specific state —
 * "this mailbox says alice, make it bob". If the far end now says carol, the
 * thing they approved is not the thing that would happen. Sending anyway would
 * silently convert a reviewed change into an unreviewed one, which is the whole
 * failure that rung exists to prevent. The refusal names the drift and the write
 * goes back to a human, which is the only party that can say whether it still
 * applies.
 *
 * The comparison is over CANONICAL JSON — keys sorted recursively — because two
 * readings of an unchanged record routinely differ in key order, and a refusal
 * that fired on key order would make the rung unusable while looking like a
 * safety feature.
 *
 * At `AUTOMATIC` that check has no referent: nobody read the record, so "the
 * record moved" is not a change to anything anyone approved, and refusing on it
 * would refuse whenever the far end is merely busy. What WAS approved is the
 * template and its bounds — "any member of population P may have field F set to
 * any value matching C" — so the check re-asks those: the set still exists under
 * this row's label, its bounds still parse, every open value still satisfies its
 * constraint, and the target is still in the population RE-RESOLVED NOW. That
 * last one is the load-bearing half, because a population is data and the row
 * this write is about may have left it since the arm ran. See
 * `automaticBoundRefusalAtSend`, which holds the argument in full.
 *
 * The prior state is still read and journalled BEFORE anything leaves at both
 * rungs — owner decision 2 is a precondition of dispatching, not a property of
 * one rung — and the stored copy is never overwritten here.
 *
 * ## FAILED versus INDETERMINATE, and why it is not a detail
 *
 * `FAILED` is a POSITIVE claim that the far end changed nothing. Every refusal
 * above earns it honestly: no request was made. A send that THREW is different —
 * the request may have arrived and been applied before the connection broke — so
 * it settles `INDETERMINATE`. Collapsing the two would tell an operator filtering
 * on FAILED that nothing needs checking, about the one case that does.
 */
import { PrismaClient } from '@prisma/client';

import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';
import { callTool } from '@/app-layer/integrations/mcp/client';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { coerceStoredMode } from '@/lib/integrations/external-write-ladder';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { buildSystemContext } from '@/app-layer/context-system';
import { runInTenantContext } from '@/lib/db-context';

import { settleWrite } from './external-write-journal';
import { getPriorStateRead } from './external-prior-state-read';
import {
    automaticBoundRefusalAtSend,
    rowRungNarrowedRefusal,
} from './external-write-automatic';

/**
 * Bound per pass, so one tenant's backlog cannot monopolise a worker.
 *
 * A PAGE SIZE, and it refuses nothing: the next pass picks up the rest, so a
 * tenant with ten thousand queued rows still sends all ten thousand. Stated
 * because `AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW` is also 50 and the two
 * are different mechanisms — that one is per CONNECTION, per rolling hour, and
 * it REFUSES the call with its own code rather than deferring it. Neither bound
 * does the other's job: this one cannot stop a runaway population feed, and
 * that one cannot stop a worker from being monopolised.
 */
const DISPATCH_BATCH_LIMIT = 50;

/**
 * Tools whose far end ACCEPTS a request and delivers it LATER (#3324).
 *
 * ═══ WHY A DECLARATION HERE, NOT A HINT FROM THE TOOL ═══
 *
 * The obvious design is an `asyncDelivery` annotation the tool advertises, and
 * it is wrong twice over. The far end is the CUSTOMER'S server, so the hint is
 * written by the party whose behaviour it describes; and
 * `hashToolManifest` hashes `inputSchema` ONLY, so an annotation is not covered
 * by the pin a human accepted — a far end could add or remove it after
 * acceptance with nothing going red.
 *
 * So this is a closed set in our own source: reviewable, and not writable by
 * the thing being described.
 *
 * ═══ WHY KEYING ON THE ADVERTISED NAME IS SAFE ═══
 *
 * A customer's own server could advertise a tool of the same name and be read
 * as asynchronous when it is not. That direction is harmless: `ACCEPTED` claims
 * strictly LESS than `APPLIED`, so a false positive under-claims a write that
 * did happen. The damaging direction is the false NEGATIVE — an asynchronous
 * tool absent from this set, settling `APPLIED` for a delivery that may never
 * occur — and that is the defect being fixed rather than one being introduced.
 *
 * ═══ THE RENAME HAZARD, AND WHAT CATCHES IT ═══
 *
 * A literal string here goes stale the moment the endpoint renames its tool,
 * and the failure is silent: the grant would settle `APPLIED` again with no
 * test reddening. `tests/unit/external-write-accepted-outcome.test.ts`
 * cross-checks this set against the name the endpoint actually advertises,
 * found by glob so it survives the route moving.
 */
export const ASYNC_DELIVERY_TOOLS: ReadonlySet<string> = new Set([
    // Entra entitlement management. MEASURED: the `adminAdd` POST returned 200
    // at 07:07:11Z with `state = submitted/Accepted`; the assignment reached
    // `delivered/Fulfilled` at 07:10:20Z, 3m09s later.
    'grant_time_bounded_access',
]);

export interface ExternalWriteDispatchResult {
    /** Rows this pass looked at. */
    scanned: number;
    /** Sent, and the far end accepted. */
    applied: number;
    /** Refused before sending — rung, pairing, or drift. Nothing was sent. */
    refused: number;
    /** Sent, and we do not know what happened. Needs a human. */
    indeterminate: number;
    /**
     * Sent, and the far end ACCEPTED it for later delivery (#3324).
     *
     * Counted apart from `applied` because it is a different claim. An
     * operator reading "12 applied" believes twelve changes happened; for an
     * asynchronous far end that is not yet known.
     */
    accepted: number;
}

/**
 * Recursively key-sorted JSON, so an unchanged record compares equal whatever
 * order the far end serialised it in.
 */
function canonical(value: unknown): string {
    const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        // `Object.prototype.toString` rather than `typeof`: a Date, Map or RegExp
        // is `typeof object` with no own entries, and a walker blind to those
        // silently canonicalises them all to `{}` — which would make two
        // different timestamps compare equal.
        if (v === null || typeof v !== 'object') return v;
        if (Object.prototype.toString.call(v) !== '[object Object]') return String(v);
        const o = v as Record<string, unknown>;
        return Object.fromEntries(Object.keys(o).sort().map((k) => [k, walk(o[k])]));
    };
    return JSON.stringify(walk(value));
}

export async function runExternalWriteDispatch(input: {
    tenantId: string;
    limit?: number;
}): Promise<ExternalWriteDispatchResult> {
    // `context-system`, never `context` — the latter reaches @/lib/auth -> @/auth
    // and dies in the worker, which has no Next request to hang a session on.
    // SYSTEM rather than delegated: the human's decision is already recorded on
    // the row as `actorUserId`, written when approval opened it.
    const ctx = buildSystemContext({ tenantId: input.tenantId, job: 'external-write-dispatch' });
    const take = input.limit ?? DISPATCH_BATCH_LIMIT;

    const due = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.findMany({
            where: { tenantId: input.tenantId, outcome: 'PENDING' },
            orderBy: { attemptedAt: 'asc' },
            take,
        }),
    );

    // ONE read for every connection this batch touches, not one per row. The
    // batch is bounded at DISPATCH_BATCH_LIMIT and routinely covers the same
    // connection many times over, so the per-row `findFirst` this replaces was
    // an N+1 in the most literal sense.
    const connectionIds = [...new Set(due.map((r) => r.connectionId).filter((v): v is string => !!v))];
    const connections = new Map(
        (
            await runInTenantContext(ctx, (db) =>
                db.integrationConnection.findMany({
                    where: {
                        id: { in: connectionIds },
                        tenantId: input.tenantId,
                        provider: MCP_SERVER_PROVIDER_ID,
                    },
                    select: {
                        id: true,
                        isEnabled: true,
                        configJson: true,
                        secretEncrypted: true,
                        externalWriteMode: true,
                    },
                }),
            )
        ).map((c) => [c.id, c] as const),
    );

    const result: ExternalWriteDispatchResult = {
        scanned: due.length,
        applied: 0,
        refused: 0,
        indeterminate: 0,
        accepted: 0,
    };
    if (due.length === 0) return result;

    for (const row of due) {
        const refuse = async (detail: string) => {
            await settleWrite(ctx, row.id, 'FAILED', detail);
            result.refused += 1;
            logger.warn('external write refused before sending', {
                component: 'external-write-dispatch',
                tenantId: input.tenantId,
                journalId: row.id,
                tool: row.toolName,
                reason: detail,
            });
        };

        if (!row.connectionId) {
            await refuse('The connection was deleted after this write was approved.');
            continue;
        }

        const connection = connections.get(row.connectionId);
        if (!connection || !connection.isEnabled) {
            await refuse('The connection is gone or disabled, so nothing was sent.');
            continue;
        }

        // Re-checked HERE as well as at approval. An operator can narrow the rung
        // in the window between the two, and narrowing must take effect at the
        // last possible moment rather than at the first.
        const rung = coerceStoredMode(connection.externalWriteMode);
        if (rung === 'DISABLED' || rung === 'DRY_RUN') {
            await refuse(`The connection is now at ${rung}, so the write was not sent.`);
            continue;
        }

        // ── AND A NARROWING THE PAIR ABOVE CANNOT SEE ───────────────────────
        //
        // `DISABLED`/`DRY_RUN` was the whole test while every row here was
        // opened at `PROPOSE_ONLY` — nothing wider existed. It is not enough
        // once `AUTOMATIC` rows exist: a connection narrowed from `AUTOMATIC`
        // to `PROPOSE_ONLY` is an operator saying "writes through here need a
        // human now", and the rows already opened WITHOUT one are exactly what
        // that instruction is about. They pass the pair above, because
        // `PROPOSE_ONLY` is neither value.
        const narrowed = rowRungNarrowedRefusal(row.mode, rung);
        if (narrowed) {
            await refuse(narrowed);
            continue;
        }

        const url = ((connection.configJson ?? {}) as { url?: unknown }).url;
        if (typeof url !== 'string' || !url.trim()) {
            await refuse('The connection has no URL configured.');
            continue;
        }

        let authorization: string | undefined;
        try {
            const secrets = connection.secretEncrypted
                ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
                : {};
            // The SHARED resolver, so this pass and the "Test connection" button
            // agree about what a credential means. Its own docstring is explicit
            // that a second one is the shape where the button is green and the
            // runtime is broken.
            authorization = await authorizationFor(
                connection.id,
                (connection.configJson ?? {}) as Record<string, unknown>,
                secrets,
            );
        } catch {
            await refuse('The connection credentials are unusable, so nothing was sent.');
            continue;
        }
        const transport = { url: url.trim(), authorization };

        const pairing = await getPriorStateRead(ctx, row.toolName);
        if (!pairing) {
            // The pairing was cleared after approval. That is an operator
            // withdrawing the thing that makes this write accountable, and the
            // dispatch honours it rather than sending unaccountably.
            await refuse('The prior-state read pairing was removed after this was approved.');
            continue;
        }
        const read = parseExternalToolName(pairing.readToolName);
        if (!read) {
            await refuse('The paired prior-state read is not a usable external tool name.');
            continue;
        }

        const args = JSON.parse(row.argumentsJson) as Record<string, unknown>;

        // ── THE DRIFT CHECK IS MODE-AWARE, BECAUSE DRIFT MEANS TWO THINGS ───
        //
        // See the file header's "two rungs, two questions" section. At
        // `PROPOSE_ONLY` the authority was a person reading ONE record, so the
        // check is "has that record moved". At `AUTOMATIC` the authority was a
        // TEMPLATE AND ITS BOUNDS, so the check is "do those bounds still admit
        // this call" — re-resolved now, because a target population is data.
        //
        // The branch is on the ROW's recorded mode, never on the connection's
        // current one: the question is what stood in for the human WHEN THIS
        // WRITE WAS AUTHORISED. Whether the connection may still be written to
        // at all is the separate check above, plus `rowRungNarrowedRefusal`.
        if (coerceStoredMode(row.mode) === 'AUTOMATIC') {
            const boundRefusal = await automaticBoundRefusalAtSend(ctx, {
                toolName: row.toolName,
                parameterSetLabel: row.parameterSetLabel,
                argumentsJson: row.argumentsJson,
            });
            if (boundRefusal) {
                await refuse(boundRefusal);
                continue;
            }
            // The prior state is NOT re-read here. It was read and journalled
            // before the row was opened — owner decision 2's precondition, at
            // every rung — and the row's copy is the evidence of the state the
            // decision was made against. Re-reading to compare would refuse
            // whenever the far end is merely busy, which makes the unattended
            // rung unusable for the unattended workload it exists for, while
            // protecting nothing any human signed. Overwriting the stored copy
            // would be worse: it would destroy that evidence.
        } else {
            let current: unknown;
            try {
                current = await callTool(transport, read.toolName, args);
            } catch {
                // The READ failed. Nothing was sent, so this is a clean FAILED —
                // decision 2 makes unreadable prior state a refusal, not a warning.
                await refuse('The prior-state read could not be run, so the write was not sent.');
                continue;
            }

            if (canonical(current) !== canonical(JSON.parse(row.priorStateJson))) {
                await refuse(
                    'The record changed after this write was approved, so what a human reviewed is '
                        + 'no longer what would happen. Nothing was sent; re-propose it against the '
                        + 'current state.',
                );
                continue;
            }
        }

        try {
            await callTool(transport, row.advertisedToolName, args);
        } catch (err) {
            // INDETERMINATE, not FAILED. The request may have arrived and been
            // applied before the connection broke, and FAILED is a positive claim
            // that the far end changed nothing — which nobody here can make.
            await settleWrite(
                ctx,
                row.id,
                'INDETERMINATE',
                `The write was sent and no answer came back: ${(err as Error).message}`,
            );
            result.indeterminate += 1;
            continue;
        }

        if (ASYNC_DELIVERY_TOOLS.has(row.advertisedToolName)) {
            // ACCEPTED, not APPLIED. `callTool` returned when the far end took
            // the request, which for this tool is at acceptance and not at
            // delivery — so `APPLIED` would be a positive claim that the far
            // end changed, the exact mirror of the claim the catch arm above
            // refuses to make in the other direction.
            //
            // The detail says what is and is not known, because this row is
            // terminal until something promotes it and the operator reading it
            // has no other source for that distinction.
            await settleWrite(
                ctx,
                row.id,
                'ACCEPTED',
                'The far end accepted this request and delivers asynchronously, so it is not yet '
                    + 'known to have taken effect. Confirm with the paired prior-state read before '
                    + 'treating the access as granted.',
            );
            result.accepted += 1;
            continue;
        }

        await settleWrite(ctx, row.id, 'APPLIED', null);
        result.applied += 1;
    }

    logger.info('external write dispatch complete', {
        component: 'external-write-dispatch',
        tenantId: input.tenantId,
        scanned: result.scanned,
        applied: result.applied,
        refused: result.refused,
        indeterminate: result.indeterminate,
    });
    return result;
}

/** Every tenant holding a PENDING external write, for the fan-out. */
export async function tenantsWithPendingExternalWrites(db: PrismaClient): Promise<string[]> {
    const rows = await db.externalWriteJournal.groupBy({
        by: ['tenantId'],
        where: { outcome: 'PENDING' },
    });
    return rows.map((r) => r.tenantId);
}
