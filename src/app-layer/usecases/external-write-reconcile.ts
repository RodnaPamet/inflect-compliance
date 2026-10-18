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

import type { RequestContext } from '@/app-layer/types';

import { logger } from '@/lib/observability/logger';
import { decryptField } from '@/lib/security/encryption';
import { callTool } from '@/app-layer/integrations/mcp/client';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { buildSystemContext } from '@/app-layer/context-system';
import { runInTenantContext } from '@/lib/db-context';
import {
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    servicePrincipalFactsOf,
} from '@/lib/agentic/service-principal-disable';

import { promoteAcceptedWrite } from './external-write-journal';
import { getPriorStateRead } from './external-prior-state-read';
import { createTask } from './task';

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
/**
 * The MCP tool-result envelope unwrapped to the serialised assignment rows, or
 * `null` when the answer is not readable at all.
 *
 * Factored out of {@link assignmentIds} rather than duplicated: the envelope
 * walk — error flag, content array, first text part, JSON, `assignments.all` —
 * is the part both questions share, and the null/empty distinction it protects
 * is the one that must not be re-derived twice. What differs is only which
 * field each caller then reads.
 */
function assignmentRows(result: unknown): readonly unknown[] | null {
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
    return Array.isArray(all) ? all : null;
}

/**
 * Each reported assignment's DERIVED liveness, or `null` when unreadable.
 *
 * `liveness` and not `state`: `classifyAssignment` is what knows `delivering`
 * is neither held nor history (#3326), and a second place deriving that would
 * be the copy that drifts. A row missing the field is `'unknown'`, never
 * dropped — a row we cannot place must not vanish from a count that decides
 * whether access is still held.
 */
function assignmentLiveness(result: unknown): readonly { liveness: string }[] | null {
    const rows = assignmentRows(result);
    if (rows === null) return null;
    return rows.map((a) => {
        const liveness = (a as { liveness?: unknown } | null)?.liveness;
        return { liveness: typeof liveness === 'string' ? liveness : 'unknown' };
    });
}

function assignmentIds(result: unknown): ReadonlySet<string> | null {
    const rows = assignmentRows(result);
    if (rows === null) return null;

    const ids = new Set<string>();
    for (const a of rows) {
        // `assignmentId`, NOT `id`. The serialised shape is
        // `AccessAssignmentState`, which has no `id` field at all — reading one
        // found nothing, compared two empty sets, and returned `not_yet`
        // forever, promoting nothing (#3334).
        const id = (a as { assignmentId?: unknown } | null)?.assignmentId;
        if (typeof id === 'string' && id.trim() !== '') ids.add(id);
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
 * The service principal the write targeted now reads DISABLED (#3671).
 *
 * The only positive evidence the disable has. Four things must all be true,
 * and every other combination is `unreadable` or `not_yet` — never `delivered`:
 *
 *   · the PRIOR state is readable and reported the principal ENABLED. A prior
 *     state that already said disabled means the write had nothing to change;
 *     the request path refuses that case before sending, so reaching here means
 *     the row predates that guard or the read answers about something else, and
 *     promoting it would credit our write with a state that was already true;
 *   · the CURRENT state is readable — a far end we could not ask has told us
 *     nothing, and an absent `accountEnabled` must never read as `false`;
 *   · both describe the SAME principal, by id;
 *   · and the current state says `accountEnabled: false`.
 *
 * `not_yet` when the principal still reads enabled: replication, or a write
 * the directory has not applied. The row stays `ACCEPTED`, and this pass never
 * demotes it.
 *
 * The parser is `servicePrincipalFactsOf`, the same one the request path uses
 * to decide there is something to disable, so the two cannot disagree about
 * what the read said.
 */
const entraServicePrincipalDisabled: DeliveryVerifier = (prior, current) => {
    const before = servicePrincipalFactsOf(prior);
    if (before === null || before.accountEnabled !== true) return 'unreadable';
    const now = servicePrincipalFactsOf(current);
    if (now === null || now.id !== before.id) return 'unreadable';
    return now.accountEnabled ? 'not_yet' : 'delivered';
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
    [SERVICE_PRINCIPAL_DISABLE_TOOL, entraServicePrincipalDisabled],
]);

/**
 * What a promotion SAYS it saw, per tool (#3671).
 *
 * The detail on an `APPLIED` row is the evidence an operator reads, and it was
 * one sentence for every tool — "a record that did not exist when the write was
 * accepted" — which is true of a grant and false of a withdrawal or a disable.
 * A row whose stated evidence is not the evidence that promoted it is a record
 * nobody can audit. A tool absent here gets the grant's sentence, which is the
 * one every row before this map carried.
 */
export const DELIVERY_EVIDENCE: ReadonlyMap<string, string> = new Map([
    [
        'revoke_access_assignment',
        'The far end has since delivered this request: the paired prior-state read no longer '
            + 'reports the assignment the write withdrew.',
    ],
    [
        SERVICE_PRINCIPAL_DISABLE_TOOL,
        'The far end has since applied this request: the paired prior-state read now reports '
            + 'the service principal disabled, where it reported it enabled before the write.',
    ],
]);

const DEFAULT_DELIVERY_EVIDENCE =
    'The far end has since delivered this request: the paired prior-state read now '
    + 'reports a record that did not exist when the write was accepted.';

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

/**
 * READ WHAT THE FAR END SAYS NOW, for one journalled write.
 *
 * Extracted because two passes need exactly this and the repo has a name for
 * the alternative: two copies of one predicate, where the one that matters is
 * the quiet one. `reconcileAcceptedExternalWrites` asks "has it arrived yet"
 * and `verifyGrantExpiry` asks "has it gone"; everything up to the answer —
 * resolving the connection, decrypting its credential, finding the PAIRED
 * prior-state read, and calling it — is the same operation.
 *
 * Returns a REASON rather than throwing, because both callers record the reason
 * on the row and neither should treat "could not ask" as an answer.
 */
/**
 * Exactly the connection fields the read needs, named structurally rather than
 * by importing a Prisma type: the caller's `select` is the contract, and a
 * widened select should not silently widen what this function may touch.
 */
interface ConnectionForRead {
    readonly id: string;
    readonly isEnabled: boolean;
    readonly configJson: unknown;
    readonly secretEncrypted: string | null;
}

type RowStateRead =
    | {
          readonly ok: true;
          readonly args: Record<string, unknown>;
          readonly prior: unknown;
          readonly current: unknown;
      }
    | { readonly ok: false; readonly reason: string };

async function readJournalRowState(
    ctx: RequestContext,
    row: { id: string; toolName: string; connectionId: string | null; argumentsJson: string; priorStateJson: string },
    connections: Map<string, ConnectionForRead>,
): Promise<RowStateRead> {
    const connection = row.connectionId ? connections.get(row.connectionId) : undefined;
    if (!connection) {
        return { ok: false, reason: 'the connection is gone or is not an MCP server connection' };
    }
    if (!connection.isEnabled) return { ok: false, reason: 'the connection is disabled' };

    const url = (connection.configJson as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !url.trim()) {
        return { ok: false, reason: 'the connection has no URL' };
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
        return { ok: false, reason: 'the connection credentials are unusable' };
    }

    const pairing = await getPriorStateRead(ctx, row.toolName);
    if (!pairing) {
        return { ok: false, reason: 'the prior-state read pairing has been removed' };
    }
    const read = parseExternalToolName(pairing.readToolName);
    if (!read) {
        return { ok: false, reason: 'the paired prior-state read is not a usable external tool name' };
    }

    let args: Record<string, unknown>;
    let prior: unknown;
    try {
        args = JSON.parse(row.argumentsJson) as Record<string, unknown>;
        prior = JSON.parse(row.priorStateJson);
    } catch {
        return { ok: false, reason: 'the journalled arguments or prior state will not parse' };
    }

    try {
        const current = await callTool({ url: url.trim(), authorization }, read.toolName, args);
        return { ok: true, args, prior, current };
    } catch (err) {
        return {
            ok: false,
            reason: `the paired read failed: ${err instanceof Error ? err.message : 'unknown'}`,
        };
    }
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

        const read = await readJournalRowState(ctx, row, connections);
        if (!read.ok) {
            unreadable(read.reason);
            continue;
        }
        const { prior, current } = read;

        const verdict = verifier(prior, current);
        if (verdict === 'delivered') {
            await promoteAcceptedWrite(
                ctx,
                row.id,
                DELIVERY_EVIDENCE.get(row.advertisedToolName) ?? DEFAULT_DELIVERY_EVIDENCE,
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

// ─── #3416: did the grant actually expire? ──────────────────────────────────

/**
 * Advertised tool -> the argument naming when its grant ends.
 *
 * Keyed on the advertised name like {@link DELIVERY_VERIFIERS}, and for the
 * same reason: a new target is invisible to this sweep until it is listed, and
 * a test holds the two maps against each other so that is a visible omission
 * rather than a silent one.
 */
export const GRANT_EXPIRY_ARGS: ReadonlyMap<string, string> = new Map([
    ['grant_time_bounded_access', 'endDateTime'],
]);

/** What the far end says about a grant whose end date has passed. */
export type ExpiryVerdict = 'expired' | 'still_live' | 'unreadable';

/**
 * Is anything still LIVE for the subject and package this row granted?
 *
 * NOT `entraAssignmentDisappeared`. That one compares the prior and current id
 * sets to prove OUR withdrawal landed, and its own docblock says why it cannot
 * serve here: comparing liveness "would also report success the moment an
 * assignment merely lapsed on its own schedule, crediting our withdrawal with
 * an expiry that would have happened anyway". For this sweep the natural lapse
 * is precisely the thing being observed, so the question is about the CURRENT
 * state alone and the prior state is irrelevant.
 *
 * `liveness` is read rather than `state`, because `classifyAssignment` is what
 * knows that `delivering` is not held yet and not history either (#3326). A
 * sweep that read the raw string would have to re-derive that, and the copy
 * that drifted would be the one granting access.
 */
export function expiryVerdict(current: unknown): ExpiryVerdict {
    const parsed = assignmentLiveness(current);
    if (parsed === null) return 'unreadable';
    // No assignment at all is the clearest possible expiry: the thing we
    // granted is not there.
    if (parsed.length === 0) return 'expired';
    // `unknown` is NOT 'expired'. A row the classifier could not place must not
    // be counted as gone — that is the direction that would quietly close the
    // case on a grant that is still held.
    if (parsed.some((a) => a.liveness === 'unknown')) return 'unreadable';
    if (parsed.some((a) => a.liveness === 'live' || a.liveness === 'pending')) return 'still_live';
    return 'expired';
}

export interface GrantExpiryResult {
    /** Rows past their end date that this pass looked at. */
    scanned: number;
    /** Confirmed gone. `expiryVerifiedAt` stamped; never asked again. */
    confirmedExpired: number;
    /** STILL LIVE past the end date. A task was raised. */
    raised: number;
    /** Already raised on an earlier pass, so no second task. */
    alreadyRaised: number;
    /** Could not ask, or could not interpret the answer. Retried next pass. */
    unreadable: number;
}

/**
 * RAISE A TASK: this grant is still live past the date it was meant to end.
 *
 * A task rather than a log line, because this is a control that failed. The
 * product refused to issue a grant longer than the recertification window; if
 * one is standing anyway, the refusal did not achieve what it was for, and the
 * only thing that makes that actionable is work assigned to somebody.
 *
 * `expiryRaisedAt` is stamped in the SAME call, and is the dedup key — a daily
 * sweep must raise one task, not one per run. It is deliberately not a
 * `TaskLink`: `TaskLinkEntityType` has no value for a journal row and
 * `assertLinkTargetInTenant` requires a real row of a supported model, so the
 * link-based idempotency `retention-notifications` uses is unavailable here.
 * The journal id travels in `metadataJson` instead, so the row is still
 * reachable from the task.
 *
 * The description names the SUBJECT and the dates and nothing else from the
 * payload. A grant's arguments carry a person's directory id, and a task is
 * read by whoever holds the queue.
 */
async function raiseGrantOutlivedWindow(
    ctx: RequestContext,
    row: { id: string; advertisedToolName: string; connectionName: string; argumentsJson: string },
    endDateTime: Date,
    now: Date,
): Promise<void> {
    const overdueDays = Math.floor((now.getTime() - endDateTime.getTime()) / 86_400_000);
    let targetId: string | null = null;
    try {
        const args = JSON.parse(row.argumentsJson) as { targetId?: unknown };
        targetId = typeof args.targetId === 'string' ? args.targetId : null;
    } catch {
        targetId = null;
    }

    const task = await createTask(ctx, {
        title: 'A time-bounded grant is still active after its end date',
        type: 'REMEDIATION',
        severity: 'HIGH',
        source: 'GRANT_EXPIRY',
        description:
            `A grant made through ${row.connectionName} was due to end on `
            + `${endDateTime.toISOString()} and the directory still reports it as active`
            + `${overdueDays > 0 ? `, ${overdueDays} day(s) later` : ''}. `
            + `Subject: ${targetId ?? 'not recorded'}. `
            + 'The product refuses a grant longer than the recertification window, so an '
            + 'assignment standing past its end date means that bound is not holding. '
            + 'Check the assignment in the directory and end it there if it is still held.',
        metadataJson: {
            externalWriteJournalId: row.id,
            advertisedToolName: row.advertisedToolName,
            endDateTime: endDateTime.toISOString(),
            overdueDays,
        },
    });

    await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.update({
            where: { id: row.id },
            data: { expiryRaisedAt: now },
        }),
    );

    logger.warn('grant outlived its window', {
        component: 'usecase',
        journalId: row.id,
        taskId: task?.id,
        overdueDays,
    });
}

/**
 * Tenants holding a delivered grant whose expiry is still unconfirmed.
 *
 * The same shape as {@link tenantsWithAcceptedExternalWrites} and for the same
 * reason: without it the pass would only visit tenants that happened to have
 * other work, and a tenant whose last grant is quietly outliving its end date
 * is exactly the population this exists for.
 */
export async function tenantsWithUnverifiedGrantExpiry(db: PrismaClient): Promise<string[]> {
    const rows = await db.externalWriteJournal.groupBy({
        by: ['tenantId'],
        where: {
            outcome: 'APPLIED',
            advertisedToolName: { in: [...GRANT_EXPIRY_ARGS.keys()] },
            expiryVerifiedAt: null,
        },
    });
    return rows.map((r) => r.tenantId);
}

/**
 * DID THE GRANTS WE MADE ACTUALLY END WHEN THEY SAID THEY WOULD? (#3416)
 *
 * ── WHY THIS IS NOT THE DELIVERY RECONCILE WITH A DIFFERENT WHERE ───────────
 *
 * The two passes have OPPOSITE polarity, which is why they cannot share a
 * status. "Has it arrived yet" tolerates `not_yet` indefinitely and retries;
 * "has it gone" must ESCALATE on a `not_yet` past the end date, because there
 * the passage of time is the defect rather than the explanation. Folding them
 * into one would make a grant outliving its window indistinguishable from a
 * slow delivery — the uniform-failure-shape problem (#3326) again.
 *
 * ── WHY IT MATTERS MORE THAN IT LOOKS ───────────────────────────────────────
 *
 * `MAX_GRANT_DAYS` is anchored to the `QUARTERLY` recertification interval so
 * that a grant cannot outlive the review that would catch it. That guarantee
 * has two halves: refuse a grant longer than the window, and have the grant
 * actually end. The first is enforced in code. Until this pass, the second was
 * assumed — the delivery reconcile promotes a row to `APPLIED` BEFORE its end
 * date, always, and nothing looked at it again.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * Stamp `expiryVerifiedAt` on anything it could not read. An unreadable answer
 * leaves the row in the population, because the only thing worse than not
 * checking is a column that says we checked.
 */
export async function verifyGrantExpiry(input: {
    tenantId: string;
    limit?: number;
    now?: Date;
}): Promise<GrantExpiryResult> {
    const ctx = buildSystemContext({
        tenantId: input.tenantId,
        job: 'external-write-expiry',
    });
    const take = input.limit ?? RECONCILE_BATCH_LIMIT;
    const now = input.now ?? new Date();

    const candidates = await runInTenantContext(ctx, (db) =>
        db.externalWriteJournal.findMany({
            where: {
                tenantId: input.tenantId,
                outcome: 'APPLIED',
                advertisedToolName: { in: [...GRANT_EXPIRY_ARGS.keys()] },
                expiryVerifiedAt: null,
            },
            // Oldest end dates first, which is the order of how long something
            // may have been live past its window.
            orderBy: { attemptedAt: 'asc' },
            take,
        }),
    );

    const result: GrantExpiryResult = {
        scanned: 0,
        confirmedExpired: 0,
        raised: 0,
        alreadyRaised: 0,
        unreadable: 0,
    };

    const connectionIds = [
        ...new Set(candidates.map((r) => r.connectionId).filter((id): id is string => !!id)),
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
                    select: { id: true, isEnabled: true, configJson: true, secretEncrypted: true },
                }),
            )
        ).map((c) => [c.id, c as ConnectionForRead]),
    );

    for (const row of candidates) {
        // The end date lives in the journalled arguments, so the SQL above
        // cannot filter on it. Rows not yet due are skipped without being
        // counted as scanned: they are not this pass's population.
        const field = GRANT_EXPIRY_ARGS.get(row.advertisedToolName);
        if (!field) continue;
        let endDateTime: Date | null = null;
        try {
            const args = JSON.parse(row.argumentsJson) as Record<string, unknown>;
            const raw = args[field];
            const parsed = typeof raw === 'string' ? new Date(raw) : null;
            endDateTime = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
        } catch {
            endDateTime = null;
        }
        // An unparseable end date is NOT skipped and NOT confirmed. It is a row
        // claiming a bounded grant whose bound cannot be read, which is a thing
        // somebody should look at rather than a thing to pass over.
        if (endDateTime === null) {
            result.scanned += 1;
            result.unreadable += 1;
            continue;
        }
        if (endDateTime.getTime() > now.getTime()) continue;

        result.scanned += 1;

        const read = await readJournalRowState(ctx, row, connections);
        if (!read.ok) {
            result.unreadable += 1;
            logger.warn('grant expiry unverified', {
                component: 'usecase',
                journalId: row.id,
                reason: read.reason,
            });
            continue;
        }

        const verdict = expiryVerdict(read.current);
        if (verdict === 'expired') {
            await runInTenantContext(ctx, (db) =>
                db.externalWriteJournal.update({
                    where: { id: row.id },
                    data: { expiryVerifiedAt: now },
                }),
            );
            result.confirmedExpired += 1;
            continue;
        }
        if (verdict === 'unreadable') {
            result.unreadable += 1;
            continue;
        }

        // STILL LIVE past its end date.
        if (row.expiryRaisedAt) {
            result.alreadyRaised += 1;
            continue;
        }
        await raiseGrantOutlivedWindow(ctx, row, endDateTime, now);
        result.raised += 1;
    }

    return result;
}
