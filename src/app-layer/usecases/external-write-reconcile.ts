/**
 * PROMOTE AN `ACCEPTED` EXTERNAL WRITE ONCE THE FAR END HAS ACTUALLY DELIVERED (#3334).
 *
 * ═══ THE GAP THIS CLOSES ═══
 *
 * #3324 added `ACCEPTED` because settling `APPLIED` when the far end has only
 * taken the request is a positive claim nobody at the POST site can make.
 * Measured on a real grant: the `adminAdd` POST returned 200 at 07:07:11Z with
 * `state = submitted/Accepted`, and the assignment reached `delivered` at
 * 07:10:20Z — 3m09s later, and a request can fail after acceptance.
 *
 * But nothing promoted the state, and `settleWrite` only matches rows still
 * `PENDING`, so `ACCEPTED` was terminal by construction. That is strictly
 * better than a false `APPLIED` and still not finished: an operator reading the
 * journal cannot tell "accepted four minutes ago, almost certainly fine" from
 * "accepted three weeks ago and silently never delivered". The honest state has
 * a shelf life, and past it, it is honest about the wrong thing.
 *
 * ═══ POSITIVE EVIDENCE ONLY. THIS PASS NEVER DEMOTES ═══
 *
 * It promotes `ACCEPTED` -> `APPLIED` and does nothing else. It will not write
 * `FAILED`, and that is a decision rather than an omission:
 *
 *   - `FAILED` means "the far end changed nothing", and an operator reads it as
 *     a positive claim and acts on it. Writing it after a grace period means
 *     claiming a delivery never happened on the strength of a timer.
 *   - The only measurement in hand is a single 3m09s delivery on a trial
 *     tenant. One sample is not a distribution, and a grace period shorter than
 *     the real tail turns healthy slow deliveries into `FAILED` rows — worse
 *     than the defect it would fix.
 *
 * So a row that has not delivered stays `ACCEPTED` and is looked at again. The
 * "accepted three weeks ago" case is therefore still visible as an old
 * `ACCEPTED` row rather than resolved; what this removes is the much larger
 * population that merely had not been checked. Demotion waits for a measured
 * distribution.
 *
 * ═══ WHY THE PAIRED READ, AND NOT A SECOND GRAPH CLIENT ═══
 *
 * Every tool that may write already has a nominated prior-state read
 * (`setPriorStateRead`), it is journalled on the row, and the write could not
 * have happened without it. So the verification goes out through the SAME seam
 * the write did, with the row's own arguments, and the answer is the same kind
 * of fact as the one recorded before the change. A separate Graph client would
 * be a different fact dressed as the same one, and would also escape the egress
 * scan that `callTool` applies.
 *
 * ═══ WHY A VERIFIER PER TOOL, RATHER THAN "THE READ CHANGED" ═══
 *
 * A generic "the output differs from `priorStateJson`" oracle is tool-agnostic
 * and wrong: the far end can change for reasons that have nothing to do with
 * our request — somebody else granting the same package, a policy edit — and
 * that would promote a write that never delivered. Since `APPLIED` is the
 * positive claim, a false promote is the one direction that must not happen.
 *
 * So each asynchronous tool declares how to recognise ITS OWN delivery.
 * `ASYNC_DELIVERY_TOOLS` in `external-write-dispatch.ts` stays the set that
 * decides `ACCEPTED`; this map decides what promotes it, and
 * `tests/unit/external-write-reconcile.test.ts` requires the two to agree —
 * so the second asynchronous tool cannot silently inherit the original bug.
 * A tool in the set with no verifier here does not reconcile, which is logged
 * by name rather than passing quietly.
 */
import { PrismaClient } from '@prisma/client';

import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';
import { callTool } from '@/app-layer/integrations/mcp/client';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { buildSystemContext } from '@/app-layer/context-system';
import { runInTenantContext } from '@/lib/db-context';

import { promoteAcceptedWrite } from './external-write-journal';
import { getPriorStateRead } from './external-prior-state-read';

/** One pass is bounded, for the same reason the dispatch batch is. */
const RECONCILE_BATCH_LIMIT = 50;

/**
 * What a verifier may conclude.
 *
 * `unreadable` is NOT `not_yet`. A far end we could not ask has told us
 * nothing, and recording that as "not delivered" would be the same category
 * error `INDETERMINATE` exists to avoid on the write path.
 */
export type DeliveryVerdict = 'delivered' | 'not_yet' | 'unreadable';

/**
 * Did OUR request deliver?
 *
 * Given the paired read as it was journalled before the write, and the same
 * read run now. Both are raw `callTool` results, because that is what the row
 * stores and comparing anything else would be comparing a derived thing to a
 * raw one.
 */
export type DeliveryVerifier = (prior: unknown, current: unknown) => DeliveryVerdict;

/**
 * The access-package assignment ids an Entra read reports, or `null` when the
 * answer is not readable at all.
 *
 * The null/empty distinction is the whole point and is easy to lose: an empty
 * set means "read fine, the subject holds nothing", and `null` means "we did
 * not get an answer". Collapsing them would turn an unreachable far end into
 * evidence about access.
 */
function assignmentIds(result: unknown): ReadonlySet<string> | null {
    if (!result || typeof result !== 'object') return null;
    const r = result as { content?: unknown; isError?: unknown };
    if (r.isError === true) return null;
    if (!Array.isArray(r.content)) return null;

    let text: string | null = null;
    for (const part of r.content) {
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
            text = (part as { text: string }).text;
            break;
        }
    }
    if (text === null) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const all = (parsed as { assignments?: { all?: unknown } } | null)?.assignments?.all;
    if (!Array.isArray(all)) return null;

    const ids = new Set<string>();
    for (const a of all) {
        // `assignmentId`, NOT `id`. The serialised shape is
        // `AccessAssignmentState`, and reading `.id` found nothing in every
        // real answer — so both sides compared as empty sets, every verdict
        // was `not_yet`, and NOTHING WOULD EVER HAVE BEEN PROMOTED. The tests
        // passed because the fixture was written to match this extractor
        // instead of the type the endpoint actually returns, which is the
        // "fixture that cannot produce the failing input" trap. Found while
        // building #3374's inverse verifier against the real interface.
        const id = a && typeof a === 'object' ? (a as { assignmentId?: unknown }).assignmentId : null;
        if (typeof id === 'string' && id !== '') ids.add(id);
    }
    return ids;
}

/**
 * An assignment exists now that did not exist before the write.
 *
 * Deliberately NOT "the subject currently holds live access", which
 * `AssignmentReadResult.live` would answer. A time-bounded grant can be
 * delivered AND already expired by the time this pass runs — the grant measured
 * for #3311 ran for thirty minutes — and `live` would then be empty for a write
 * that delivered perfectly. The question here is whether the far end DID the
 * thing, not whether its effect is still in force.
 *
 * Nor is it an end-date comparison against the requested value: the directory
 * is entitled to normalise what it stores, and a string comparison against
 * `endDateTime` would make delivery detection depend on its serialisation.
 * An id that was not there before is the fact with the fewest assumptions.
 */
const entraAssignmentAppeared: DeliveryVerifier = (prior, current) => {
    const now = assignmentIds(current);
    if (now === null) return 'unreadable';
    const before = assignmentIds(prior);
    // An unreadable PRIOR state is also 'unreadable', not 'delivered'. Without
    // the baseline, "an assignment exists" cannot be distinguished from "an
    // assignment the subject already had", and promoting on that would claim
    // our write did something a pre-existing grant had already done.
    if (before === null) return 'unreadable';
    for (const id of now) {
        if (!before.has(id)) return 'delivered';
    }
    return 'not_yet';
};

/**
 * An assignment that WAS there has gone (#3374).
 *
 * The exact inverse of `entraAssignmentAppeared`, and it has to be its own
 * function rather than a flag: "something appeared" and "something vanished"
 * are different questions about the same two reads, and a shared one with a
 * direction parameter would be a single place to get both wrong.
 *
 * Reads `all`, not `live`, for the same reason the grant's verifier does — and
 * here the reason is sharper. A withdrawn assignment may still be LISTED by
 * Graph with `state: expired` rather than disappearing outright; what matters
 * is that the id the write targeted is no longer in the set. Comparing `live`
 * would also report success the moment an assignment merely lapsed on its own
 * schedule, crediting our withdrawal with an expiry that would have happened
 * anyway.
 */
const entraAssignmentDisappeared: DeliveryVerifier = (prior, current) => {
    const before = assignmentIds(prior);
    if (before === null) return 'unreadable';
    const now = assignmentIds(current);
    if (now === null) return 'unreadable';
    // Nothing was there to remove. Not 'delivered': an empty prior state means
    // the write had no subject, and `revokeAccessAssignment` refuses that case
    // before sending — so reaching here means the row predates that guard or
    // the read is answering about something else.
    if (before.size === 0) return 'unreadable';
    for (const id of before) {
        if (!now.has(id)) return 'delivered';
    }
    return 'not_yet';
};

/**
 * Advertised tool name -> how to recognise its delivery.
 *
 * Keyed on the ADVERTISED name, matching `ASYNC_DELIVERY_TOOLS`, so the two
 * are comparable by the test that holds them together.
 */
export const DELIVERY_VERIFIERS: ReadonlyMap<string, DeliveryVerifier> = new Map([
    ['grant_time_bounded_access', entraAssignmentAppeared],
    ['revoke_access_assignment', entraAssignmentDisappeared],
]);

export interface ExternalWriteReconcileResult {
    /** `ACCEPTED` rows this pass looked at. */
    scanned: number;
    /** Promoted to `APPLIED` on positive evidence. */
    promoted: number;
    /** Read fine; our request has not delivered yet. Left `ACCEPTED`. */
    notYet: number;
    /** Could not ask, or could not compare. Left `ACCEPTED`, will be retried. */
    unreadable: number;
    /** In `ACCEPTED` with no verifier for the tool. Left alone, and logged. */
    unverifiable: number;
}

/**
 * Tenants holding an `ACCEPTED` row.
 *
 * Separate from `tenantsWithPendingExternalWrites` rather than folding into it:
 * each name then stays true to the query behind it, and the job unions the two.
 * Without this the pass would only ever visit tenants that also had something
 * `PENDING`, so a tenant whose last write was accepted and whose queue is now
 * empty would never be reconciled at all — the exact population this exists for.
 */
export async function tenantsWithAcceptedExternalWrites(db: PrismaClient): Promise<string[]> {
    const rows = await db.externalWriteJournal.groupBy({
        by: ['tenantId'],
        where: { outcome: 'ACCEPTED' },
    });
    return rows.map((r) => r.tenantId);
}

export async function reconcileAcceptedExternalWrites(input: {
    tenantId: string;
    limit?: number;
}): Promise<ExternalWriteReconcileResult> {
    const ctx = buildSystemContext({
        tenantId: input.tenantId,
        job: 'external-write-reconcile',
    });
    const take = input.limit ?? RECONCILE_BATCH_LIMIT;

    // Oldest first: if a tenant holds more accepted rows than one batch, the
    // ones that have been waiting longest are the ones an operator is most
    // likely to be looking at.
    const due = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.findMany({
            where: { tenantId: input.tenantId, outcome: 'ACCEPTED' },
            orderBy: { settledAt: 'asc' },
            take,
        }),
    );

    const result: ExternalWriteReconcileResult = {
        scanned: due.length,
        promoted: 0,
        notYet: 0,
        unreadable: 0,
        unverifiable: 0,
    };
    if (due.length === 0) return result;

    const connectionIds = [
        ...new Set(due.map((r) => r.connectionId).filter((v): v is string => !!v)),
    ];
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
                    },
                }),
            )
        ).map((c) => [c.id, c] as const),
    );

    for (const row of due) {
        const verifier = DELIVERY_VERIFIERS.get(row.advertisedToolName);
        if (!verifier) {
            // Named, not swallowed. A tool that settles `ACCEPTED` and has no
            // way to be promoted is the bug this file exists to prevent
            // recurring, so it says so on every pass rather than looking like
            // a row that is merely still waiting.
            result.unverifiable += 1;
            logger.warn('external write reconcile: no delivery verifier for tool', {
                component: 'external-write-reconcile',
                tenantId: input.tenantId,
                journalId: row.id,
                tool: row.advertisedToolName,
            });
            continue;
        }

        // Every arm below leaves the row ACCEPTED. Nothing here can make a
        // negative claim, so an unusable connection, a withdrawn pairing and an
        // unreachable server are all "ask again later" — counted, never settled.
        const unreadable = (reason: string) => {
            result.unreadable += 1;
            logger.info('external write reconcile: not verifiable this pass', {
                component: 'external-write-reconcile',
                tenantId: input.tenantId,
                journalId: row.id,
                reason,
            });
        };

        const connection = row.connectionId ? connections.get(row.connectionId) : undefined;
        if (!connection) {
            unreadable('the connection is gone or is not an MCP server connection');
            continue;
        }
        if (!connection.isEnabled) {
            unreadable('the connection is disabled');
            continue;
        }
        const url = (connection.configJson as { url?: unknown } | null)?.url;
        if (typeof url !== 'string' || !url.trim()) {
            unreadable('the connection has no URL');
            continue;
        }

        let authorization: string | undefined;
        try {
            const secrets = connection.secretEncrypted
                ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
                : {};
            authorization = await authorizationFor(
                connection.id,
                (connection.configJson ?? {}) as Record<string, unknown>,
                secrets,
            );
        } catch {
            unreadable('the connection credentials are unusable');
            continue;
        }

        const pairing = await getPriorStateRead(ctx, row.toolName);
        if (!pairing) {
            unreadable('the prior-state read pairing has been removed');
            continue;
        }
        const read = parseExternalToolName(pairing.readToolName);
        if (!read) {
            unreadable('the paired prior-state read is not a usable external tool name');
            continue;
        }

        let args: Record<string, unknown>;
        let prior: unknown;
        try {
            args = JSON.parse(row.argumentsJson) as Record<string, unknown>;
            prior = JSON.parse(row.priorStateJson);
        } catch {
            unreadable('the journalled arguments or prior state will not parse');
            continue;
        }

        let current: unknown;
        try {
            current = await callTool({ url: url.trim(), authorization }, read.toolName, args);
        } catch (err) {
            unreadable(`the paired read failed: ${err instanceof Error ? err.message : 'unknown'}`);
            continue;
        }

        const verdict = verifier(prior, current);
        if (verdict === 'delivered') {
            await promoteAcceptedWrite(
                ctx,
                row.id,
                'The far end has since delivered this request: the paired prior-state read now '
                    + 'reports a record that did not exist when the write was accepted.',
            );
            result.promoted += 1;
            continue;
        }
        if (verdict === 'unreadable') {
            unreadable('the paired read returned an answer this tool cannot interpret');
            continue;
        }
        result.notYet += 1;
    }

    return result;
}
