/**
 * TIME-BOUNDED ACCESS PACKAGE ASSIGNMENTS — Entra entitlement management.
 *
 * The write half of the owner's "grant user X access Y for a limited time", and
 * the read that pairs with it. Part of #3297.
 *
 * ═══ WHY THIS IS NOT A THIRD `IdentityDirection` ═══
 *
 * `write-direction.ts` splits directory writes into `leaver` and `joiner`, and
 * `storedWriteFlag`'s `never` arm makes a third direction a compile error on
 * purpose. A grant does not take that door, and the reason is not convenience:
 * a direction in that module is an ACCOUNT LIFECYCLE operation — create or
 * disable a user — gated by the identity write ladder. An access-package
 * assignment creates no account and disables none.
 *
 * It is an EXTERNAL WRITE instead, governed by the parallel rung on
 * `IntegrationConnection.externalWriteMode` that `external-write-dispatch`
 * reads. That path carries what the owner chose it for: the template and its
 * bounds approved by a human, the target population re-resolved at send rather
 * than at approval, a `PENDING` journal row, and a prior-state read that must
 * be paired or the write is refused.
 *
 * ═══ THE SEPARATION `write-direction.ts` SAYS IS IMPOSSIBLE IS AVAILABLE HERE ═══
 *
 * That module's central argument is that the credential cannot hold the two
 * directions apart: `User.ReadWrite.All` is sufficient to create AND is a member
 * of the writer's own `WRITE_ROLES`, so any consent sufficient to create is
 * sufficient to disable, and a client-credentials token asks for `.default`,
 * which is not a request at all. The per-connection flag is the only place the
 * separation can live.
 *
 * Entitlement management is the happier case, and it is worth saying out loud
 * because it is the opposite of what the joiner's experience would predict:
 *
 *   EntitlementManagement.ReadWrite.All   assigns access packages
 *   Access package assignment manager     the least-privileged role that can
 *
 * NEITHER grants account-lifecycle power. An app consented only for entitlement
 * management cannot disable a user, cannot create one, and cannot read the
 * directory wholesale. So the capability is separable AT THE CREDENTIAL, and the
 * right operational advice is a consent (or a role assignment) scoped to
 * entitlement management alone — not a widening of whatever the leaver already
 * holds. Nothing in this module can enforce that, which is exactly why it is
 * documented where an operator setting it up will read it.
 *
 * ═══ ENTRA EXPIRES THE ASSIGNMENT, NOT US ═══
 *
 * `schedule.expiration.type: 'afterDateTime'` with an `endDateTime` is native:
 * the directory ends the assignment itself. There is no revocation scheduler in
 * this product and there must not be one for this, because a second expiry
 * mechanism is a second thing that can be down on the day it matters — and the
 * failure is silent in the dangerous direction, leaving access live past its
 * end date while our own records say it lapsed.
 *
 * ═══ AN UNBOUNDED GRANT IS REFUSED, NOT DEFAULTED ═══
 *
 * `endDateTime` is REQUIRED and `expiryRefusal` refuses its absence. A permanent
 * grant is a different and much larger authority than a temporary one, and the
 * way products acquire it by accident is exactly this: an optional expiry, left
 * out of one call, defaulting to forever. Omission must not be able to escalate
 * the operation. If permanent assignment is ever wanted it needs its own verb,
 * its own approval copy and its own consent — not this function with a field
 * missing.
 */
import { getEntraAccessToken } from './index';
import { assertEntraObjectId } from './writer';
import { resilientFetch } from '../../http-resilience';
import { logger } from '@/lib/observability/logger';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * The longest a single grant may run: 90 days.
 *
 * NOT a round number picked for feeling reasonable. 90 days is this product's
 * own `QUARTERLY` cadence — `automation-runner.ts` maps `QUARTERLY → 90 days`
 * and `risk-report.ts` advances a quarterly due date by three months — which
 * makes it the interval at which access is recertified.
 *
 * So the bound states something true rather than arbitrary: **a grant may not
 * outlive the review that would catch it.** A 180-day assignment is live through
 * one whole recertification cycle without ever appearing in one as a decision,
 * which is the precise shape of the finding an access review exists to produce.
 *
 * It is a REFUSAL threshold, not a clamp. Silently shortening a 180-day request
 * to 90 would hand back a success for an operation nobody asked for, and the
 * person who needed 180 days would discover the difference when access
 * vanished mid-project.
 */
export const MAX_GRANT_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a caller must supply. Every field required — see the header on omission. */
export interface TimeBoundedGrantInput {
    /** The subject's Entra object id. Validated, never trusted. */
    readonly targetId: string;
    readonly accessPackageId: string;
    readonly assignmentPolicyId: string;
    /**
     * When Entra must end the assignment. REQUIRED.
     *
     * Not optional-with-a-default for the reason in the header: an omitted
     * expiry would turn a temporary grant into a permanent one by accident.
     */
    readonly endDateTime: Date;
    /** Recorded on the request for the audit trail. */
    readonly justification?: string;
}

/**
 * Why this grant must not be sent — or null when it may be.
 *
 * PURE and exported, so the refusals are testable without a network and so a
 * caller can explain one BEFORE acting. The shape `directionWriteRefusal` and
 * `gateWriteBackPreflight` already use in this codebase.
 *
 * `now` is a parameter rather than `Date.now()` for the reason
 * `identity-joiner-run`'s `readStarters` gives about its own clock: one instant
 * must govern the whole decision, or a bound computed milliseconds — or in a
 * replay, hours — apart from the value it is compared against.
 */
export function expiryRefusal(input: TimeBoundedGrantInput, now: Date): string | null {
    const end = input.endDateTime;

    // An Invalid Date is the live path, not a defensive one: a date parsed from
    // an operator form or a tool argument is `new Date(<whatever was typed>)`,
    // and `new Date('next friday')` is an Invalid Date whose getTime() is NaN.
    // Every comparison below would then be false, so an unchecked NaN sails
    // through both bounds and reaches Graph as the string "Invalid Date".
    if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
        return (
            'Grant refused: the end date is missing or unparseable. A time-bounded grant must ' +
            'name when it ends; there is no permanent-assignment path through this function.'
        );
    }

    if (end.getTime() <= now.getTime()) {
        return (
            `Grant refused: the end date ${end.toISOString()} is not in the future, so the ` +
            'assignment would expire at or before the moment it was created. Entra would accept ' +
            'it and the subject would never hold the access, which reads as a successful grant ' +
            'that silently did nothing.'
        );
    }

    const days = (end.getTime() - now.getTime()) / DAY_MS;
    if (days > MAX_GRANT_DAYS) {
        return (
            `Grant refused: ${Math.ceil(days)} days exceeds the ${MAX_GRANT_DAYS}-day maximum. ` +
            'That is this product\'s QUARTERLY recertification interval, so a longer grant would ' +
            'be live through a whole access-review cycle without appearing in one as a decision. ' +
            'Shorten it, or raise the access through a review rather than a grant. It is not ' +
            'clamped to the maximum on purpose — a shortened grant returned as a success is an ' +
            'operation nobody asked for.'
        );
    }

    return null;
}

export interface EntitlementClientOptions {
    /** Merged connection config and secrets, as the other Entra modules take it. */
    readonly connection: Record<string, unknown>;
    readonly doFetch?: typeof fetch;
    /** Injectable clock, for the reason `expiryRefusal` takes one. */
    readonly now?: () => Date;
}

/**
 * How an assignment stands RIGHT NOW, derived rather than reported (#3326).
 *
 * Graph keeps expired assignments in the collection — it does not remove them —
 * so a read filtered only on subject and package returns history and holdings
 * mixed together. `state` alone does not separate them either, because it lags:
 * #3324 measured a row sitting at `delivered` with an `endDateTime` already in
 * the past. So liveness is computed from BOTH fields, and the raw `state` is
 * kept on the row so an assessor sees what the directory actually said.
 *
 * `unknown` is a real answer and never collapses into `inactive`. A state this
 * code does not recognise, or an unparseable date, must not be classified by
 * guesswork in either direction.
 */
export type AssignmentLiveness = 'live' | 'pending' | 'inactive' | 'unknown';

/** One assignment as this product reads it. Identifying fields only. */
export interface AccessAssignmentState {
    readonly assignmentId: string;
    readonly accessPackageId: string | null;
    /** Verbatim from Graph, for the audit record. Lowercase in the live payload. */
    readonly state: string | null;
    readonly endDateTime: string | null;
    /** Derived by `classifyAssignment`. Never sent by the directory. */
    readonly liveness: AssignmentLiveness;
}

/**
 * The read's result, SHAPED so the wrong question cannot be asked (#3326).
 *
 * The defect this replaces was not missing data — every row carried its own
 * `state`. It was a bare array, which invites `assignments.length > 0` as the
 * answer to "does the subject already hold this". For a subject whose only
 * assignment expired last month that reads TRUE, and the grant that would have
 * restored their access gets suppressed as redundant. A denial of access
 * wearing the costume of an optimisation, with a real assignment and a real end
 * date behind it, so nothing in the journal looks wrong.
 *
 * `all` keeps every row because "previously held this until 2026-08-01" is
 * exactly what an assessor wants from a prior-state record; dropping it to
 * simplify a boolean would throw away the better half. `live` is the ONLY thing
 * that answers the no-op question, and it holds nothing but provably-live rows.
 */
export interface AssignmentReadResult {
    /** Everything the directory returned, unfiltered — the audit record. */
    readonly all: readonly AccessAssignmentState[];
    /** Only `liveness === 'live'`. `live.length > 0` is the no-op test. */
    readonly live: readonly AccessAssignmentState[];
}

/**
 * Classify one assignment. Pure, and exported so it is testable without a fetch.
 *
 * ═══ WHY `delivered` IS NOT ENOUGH ═══
 *
 * Microsoft's own PowerShell sample filters `state eq 'Delivered'` to answer
 * "who holds this", and that is nearly right. It is wrong for the window #3324
 * measured, where the row still says `delivered` and the end date has passed.
 * Inside that window this returns `inactive`, which is the SAFE direction and
 * deliberately so:
 *
 *   - calling it inactive when access is in fact still live means we attempt a
 *     grant that Entra may reject as already-assigned — a visible error;
 *   - calling it live when access has in fact lapsed means we suppress the
 *     grant — a silent denial of access to somebody who should have it.
 *
 * The first is noisy and recoverable, the second is quiet and harmful, so the
 * tie is broken toward attempting the write.
 *
 * ═══ CASE ═══
 *
 * Compared case-insensitively on purpose. The live Graph v1.0 payload carries
 * `delivered` lowercase while the documentation and the portal filter both say
 * `Delivered`; a comparison pinned to either spelling passes against a fixture
 * written from the docs and fails against the API.
 */
export function classifyAssignment(
    state: string | null,
    endDateTime: string | null,
    now: Date,
): AssignmentLiveness {
    const normalised = typeof state === 'string' ? state.trim().toLowerCase() : '';
    if (normalised === '') return 'unknown';
    switch (normalised) {
        case 'delivering':
        case 'partiallydelivered':
            // In flight: not held yet, and NOT history. Folding these into an
            // `historical` bucket would be this very defect a second time — a
            // field read as something it is not.
            return 'pending';
        case 'expired':
        case 'deliveryfailed':
            return 'inactive';
        case 'delivered':
            break;
        default:
            // Includes `unknownFutureValue`, which Graph reserves for enum
            // members added later. Guessing on behalf of a future value is how
            // a new state becomes silently live.
            return 'unknown';
    }
    // `delivered`: the END DATE decides, for the reason in the docblock.
    if (endDateTime === null || endDateTime === '') {
        // No expiration is a permanent holding, not a missing one — the grant
        // path always sets one, but an assignment made by another route need
        // not have.
        return 'live';
    }
    const end = Date.parse(endDateTime);
    if (Number.isNaN(end)) return 'unknown';
    return end > now.getTime() ? 'live' : 'inactive';
}

/**
 * DISCOVERY (#3329). What a human composing a grant has to choose between.
 *
 * A grant needs three identifiers and only one of them was discoverable: the
 * subject comes from the target population (#3299). `accessPackageId` and
 * `assignmentPolicyId` had no read at all, so a compose form could offer
 * nothing but two free-text boxes for opaque GUIDs — and because both are
 * opaque GUIDs, SWAPPING them is undetectable until Graph refuses, while a
 * wrong-but-valid pair is not refused at all.
 */
export interface AccessPackageSummary {
    readonly id: string;
    readonly displayName: string | null;
    readonly description: string | null;
    /** Hidden packages exist and are assignable; the form should say so. */
    readonly isHidden: boolean | null;
}

/** One assignment policy, carrying the package it belongs to. */
export interface AssignmentPolicySummary {
    readonly id: string;
    readonly displayName: string | null;
    /**
     * Echoed back from the response, NOT copied from the request.
     *
     * This is what makes the swap check real: a form that trusted the id it
     * asked with would confirm its own input. See
     * `policyBelongsToPackage`.
     */
    readonly accessPackageId: string | null;
}

/**
 * A page of discovery results, and whether there were more.
 *
 * `truncated` is not decoration. A list silently cut at a page boundary is a
 * form that cannot offer a package the tenant has, and the operator has no way
 * to tell that from the package not existing — so the cap is reported as a
 * fact rather than hidden as an implementation detail.
 */
export interface DiscoveryPage<T> {
    readonly items: readonly T[];
    readonly truncated: boolean;
}

/** Page size asked of Graph. */
const DISCOVERY_PAGE_SIZE = 100;
/**
 * How many pages to follow before giving up and saying so.
 *
 * Ten pages is 1000 access packages, which is far beyond any tenant this form
 * is for. The bound exists so a pathological tenant cannot make one form load
 * walk an unbounded cursor, not because 1000 is a meaningful number.
 */
const DISCOVERY_MAX_PAGES = 10;

/**
 * Does this policy belong to this package? (#3329)
 *
 * The cheap check that closes the undetectable-swap case. Only possible once
 * discovery exists, which is why it lives here rather than in the form: the
 * form would have to trust its own input, and the whole point is that it
 * cannot.
 *
 * A policy whose `accessPackageId` came back null is NOT treated as belonging.
 * An absent answer is not a yes — the same direction every other refusal in
 * this file takes.
 */
export function policyBelongsToPackage(
    policy: AssignmentPolicySummary,
    accessPackageId: string,
): boolean {
    return policy.accessPackageId !== null && policy.accessPackageId === accessPackageId;
}

function graphErrorCode(status: number, text: string): string {
    // Graph error bodies are `{ error: { code, message } }`, and the CODE is the
    // part worth quoting — the message routinely embeds the object id, which
    // this subsystem keeps out of logs. Same choice as `provisioner.ts`'s
    // `bodyOf`, duplicated rather than imported because that one is private to
    // the provisioner and widening its surface for a second caller is how a
    // helper becomes a shared dependency nobody owns.
    try {
        const parsed = JSON.parse(text) as { error?: { code?: string } };
        return parsed.error?.code ?? String(status);
    } catch {
        return String(status);
    }
}

export function createEntraEntitlementClient(options: EntitlementClientOptions) {
    const connection = options.connection;
    const doFetch = options.doFetch ?? resilientFetch;
    const now = options.now ?? (() => new Date());

    let token: string | null = null;
    async function auth(): Promise<string> {
        if (token) return token;
        token = await getEntraAccessToken(connection, doFetch);
        return token;
    }

    async function graph(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{ ok: boolean; status: number; text: string }> {
        const t = await auth();
        const res = await doFetch(`${GRAPH}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${t}`,
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = res.status === 204 ? '' : await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, text };
    }

    /**
     * Follow a Graph collection across pages, bounded, and report truncation.
     *
     * ═══ THE nextLink IS A SERVER-SUPPLIED REQUEST TARGET ═══
     *
     * Graph's `@odata.nextLink` is an ABSOLUTE url, and this function attaches a
     * bearer token to whatever it is given. `index.ts` already states the
     * consequence for its own stored cursor:
     *
     *     a tampered stored cursor would otherwise send this request — carrying
     *     a Graph bearer token — to an arbitrary host.
     *
     * So the link is origin-checked and then RE-BUILT: only its path and query
     * are used, against our own `GRAPH` constant, so the host cannot come from
     * the response at all. That is the same rule the legacy MCP client follows
     * for advertised page URIs, and it is stronger than a prefix check alone —
     * a prefix match still requests the string the far end chose.
     */
    async function pagedGet<T>(
        firstPathAndQuery: string,
        row: (raw: Record<string, unknown>) => T | null,
    ): Promise<DiscoveryPage<T>> {
        const items: T[] = [];
        let pathAndQuery: string | null = firstPathAndQuery;
        for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
            const res = await graph('GET', pathAndQuery);
            if (!res.ok) {
                throw new Error(
                    `Entra discovery read failed (${graphErrorCode(res.status, res.text)})`,
                );
            }
            const parsed = JSON.parse(res.text || '{}') as {
                value?: ReadonlyArray<Record<string, unknown>>;
                '@odata.nextLink'?: unknown;
            };
            for (const raw of parsed.value ?? []) {
                const mapped = row(raw);
                // A row that cannot be keyed is DROPPED, not carried with a
                // hole: an entry the form cannot submit is worse than absent,
                // because the operator would pick it and get a refusal.
                if (mapped !== null) items.push(mapped);
            }
            const next = parsed['@odata.nextLink'];
            if (typeof next !== 'string' || next === '') {
                return { items, truncated: false };
            }
            if (!next.startsWith(`${GRAPH}/`)) {
                // Not our host. Stop and SAY SO rather than follow it or
                // pretend the list is complete.
                logger.warn('Entra discovery: nextLink is not a Graph url, stopping', {
                    component: 'entra-entitlement',
                });
                return { items, truncated: true };
            }
            pathAndQuery = next.slice(GRAPH.length);
        }
        // The cap was reached with a cursor still outstanding.
        return { items, truncated: true };
    }

    return {
        /**
         * THE PRIOR STATE: every assignment of this package to this subject,
         * held or lapsed, each one CLASSIFIED (#3326).
         *
         * This docblock used to read "what this subject already holds of this
         * package", and that sentence is what made a bare array look adequate.
         * Graph does not remove an expired assignment, so the read returns
         * history too; the shape now says so — `all` for the record, `live` for
         * the question.
         *
         * This is the read that `setPriorStateRead` pairs with the write below,
         * and the pairing's own rule decides which read it has to be: the state
         * the write REPLACES. A group-membership or PIM-eligibility read would
         * be a plausible-looking record of a DIFFERENT fact, and the journal
         * presents whatever it captures as authoritative — which is the harm
         * `external-prior-state-read` names when it insists both halves sit on
         * one connection.
         *
         * Filtered server-side on BOTH the target and the package. An unfiltered
         * read would pull the tenant's whole assignment list to answer a
         * question about one person, and a prior-state record that contains
         * everybody is not a record of this write's before-state.
         */
        async readAssignments(args: {
            targetId: string;
            accessPackageId: string;
        }): Promise<AssignmentReadResult> {
            const target = assertEntraObjectId(args.targetId);
            const filter =
                `$filter=target/objectId eq '${encodeURIComponent(target)}'` +
                ` and accessPackage/id eq '${encodeURIComponent(args.accessPackageId)}'`;
            const res = await graph(
                'GET',
                `/identityGovernance/entitlementManagement/assignments?${filter}` +
                    `&$select=id,state,schedule&$expand=accessPackage($select=id)`,
            );
            if (!res.ok) {
                throw new Error(
                    `Entra assignment read failed (${graphErrorCode(res.status, res.text)})`,
                );
            }
            const parsed = JSON.parse(res.text || '{}') as {
                value?: ReadonlyArray<{
                    id?: unknown;
                    state?: unknown;
                    accessPackage?: { id?: unknown } | null;
                    schedule?: { expiration?: { endDateTime?: unknown } | null } | null;
                }>;
            };
            // ONE clock reading for the whole batch. Classifying row-by-row
            // against a moving `now` could put two rows with the same end date
            // in different buckets, which is not a thing the directory said.
            const at = now();
            const all = (parsed.value ?? []).flatMap((row) => {
                // A row with no id cannot be referred to afterwards, so it is
                // dropped rather than carried as a record with a hole in it.
                if (typeof row.id !== 'string' || row.id === '') return [];
                const end = row.schedule?.expiration?.endDateTime;
                const state = typeof row.state === 'string' ? row.state : null;
                const endDateTime = typeof end === 'string' ? end : null;
                return [
                    {
                        assignmentId: row.id,
                        accessPackageId:
                            typeof row.accessPackage?.id === 'string' ? row.accessPackage.id : null,
                        state,
                        endDateTime,
                        liveness: classifyAssignment(state, endDateTime, at),
                    },
                ];
            });
            // `live` is derived here rather than left to the caller: a caller
            // that has to filter is a caller that can forget to.
            return { all, live: all.filter((a) => a.liveness === 'live') };
        },

        /**
         * THE WRITE: ask Entra to assign the package until a named instant.
         *
         * `requestType: 'adminAdd'` — an administrator assigning on a subject's
         * behalf, which is what the owner asked for. The self-service shape
         * (`userAdd`, the subject requesting their own) is a different operation
         * with a different approval story and is deliberately not reachable from
         * here by flipping a field.
         *
         * The refusal runs FIRST and returns rather than throwing past the
         * caller, so a bad expiry costs no token exchange and no request. A
         * grant that must not happen must not be observable to the far end at
         * all — the same ordering `rpc`'s egress scan uses in the MCP client.
         */
        async requestTimeBoundedAssignment(
            input: TimeBoundedGrantInput,
        ): Promise<{ requestId: string } | { refused: string }> {
            const refusal = expiryRefusal(input, now());
            if (refusal) return { refused: refusal };

            const target = assertEntraObjectId(input.targetId);
            const res = await graph(
                'POST',
                '/identityGovernance/entitlementManagement/assignmentRequests',
                {
                    requestType: 'adminAdd',
                    assignment: {
                        targetId: target,
                        assignmentPolicyId: input.assignmentPolicyId,
                        accessPackageId: input.accessPackageId,
                    },
                    schedule: {
                        startDateTime: now().toISOString(),
                        recurrence: null,
                        expiration: {
                            endDateTime: input.endDateTime.toISOString(),
                            // `duration` and `endDateTime` are alternatives and
                            // Graph rejects both together. Null is explicit so a
                            // reader does not have to know which was chosen.
                            duration: null,
                            type: 'afterDateTime',
                        },
                    },
                    ...(input.justification === undefined
                        ? {}
                        : { justification: input.justification }),
                },
            );
            if (!res.ok) {
                throw new Error(
                    `Entra assignment request failed (${graphErrorCode(res.status, res.text)})`,
                );
            }
            const parsed = JSON.parse(res.text || '{}') as { id?: unknown };
            if (typeof parsed.id !== 'string' || parsed.id === '') {
                // Graph accepted it and told us nothing we can follow up with.
                // Reported rather than swallowed: the assignment may well exist,
                // and a caller that recorded "no id" as "no grant" would be
                // wrong in the direction that matters.
                throw new Error(
                    'Entra accepted the assignment request but returned no id, so the request ' +
                        'cannot be tracked. The assignment may have been created — reconcile ' +
                        'against readAssignments before retrying.',
                );
            }
            return { requestId: parsed.id };
        },

        /**
         * THE OTHER WRITE: ask Entra to end an assignment NOW (#3374).
         *
         * ═══ IT TAKES THE ASSIGNMENT ID, NOT THE TRIPLE ═══
         *
         * `adminAdd` is addressed by target + package + policy because the
         * assignment does not exist yet. `adminRemove` is addressed by the
         * ASSIGNMENT's own id, because by then it does. That asymmetry is
         * Graph's, not ours, and it is why the caller resolves the id from the
         * live read rather than passing the same triple twice — see
         * `revokeAccessAssignment`, which also refuses when there is nothing
         * live to remove or more than one candidate.
         *
         * ═══ NO SCHEDULE, AND THEREFORE NO expiryRefusal ═══
         *
         * A removal has no expiration to bound, so none of
         * `expiryRefusal`'s clauses apply: there is no end date to require, to
         * parse, to place in the future or to cap at `MAX_GRANT_DAYS`. Sending
         * a `schedule` here would be asking Entra to schedule a withdrawal,
         * which is a different feature and not what this is.
         *
         * ═══ UNCONFIRMED AGAINST A REAL TENANT ═══
         *
         * Stated because it matters: this repo has no `adminRemove` precedent,
         * and the shape below is taken from Graph's documentation rather than
         * from a run. #3311 is the standard this path is held to — the
         * `adminAdd` behaviour was only trusted after a measured grant — and
         * #3374 carries the same requirement for this verb. Until that run
         * exists, treat a success here as "Graph accepted the request", which
         * is all `requestId` ever meant anyway: delivery is asynchronous and
         * the reconcile pass is what confirms it.
         */
        async requestAssignmentRemoval(input: {
            readonly assignmentId: string;
            readonly justification?: string;
        }): Promise<{ requestId: string }> {
            const res = await graph(
                'POST',
                '/identityGovernance/entitlementManagement/assignmentRequests',
                {
                    requestType: 'adminRemove',
                    assignment: { id: input.assignmentId },
                    ...(input.justification === undefined
                        ? {}
                        : { justification: input.justification }),
                },
            );
            if (!res.ok) {
                throw new Error(
                    `Entra assignment removal failed (${graphErrorCode(res.status, res.text)})`,
                );
            }
            const parsed = JSON.parse(res.text || '{}') as { id?: unknown };
            if (typeof parsed.id !== 'string' || parsed.id === '') {
                // Same reasoning as the grant's: Graph took the request and
                // gave us nothing to follow up with. The removal may well have
                // happened, and recording "no id" as "no removal" would be
                // wrong in the direction that leaves access in place while the
                // journal says it was withdrawn.
                throw new Error(
                    'Entra accepted the removal request but returned no id, so the request '
                        + 'cannot be tracked. The assignment may have been removed — reconcile '
                        + 'against readAssignments before retrying.',
                );
            }
            return { requestId: parsed.id };
        },

        /**
         * DISCOVERY: the access packages this tenant has (#3329).
         *
         * Measured app-only against a licensed tenant:
         * `GET /identityGovernance/entitlementManagement/accessPackages` -> 200
         * with the credential this path already uses.
         *
         * CATALOGS ARE NOT FETCHED, deliberately. `accessPackage` in Graph
         * v1.0 carries no `catalogId` scalar — the catalog is a navigation
         * property, so grouping by it needs `$expand=catalog`, which is NOT in
         * the set measured live. Building a form grouping on an unmeasured
         * expand would be an assumption dressed as a feature; the form needs a
         * package and a policy, and that is what this returns.
         */
        async readAccessPackages(): Promise<DiscoveryPage<AccessPackageSummary>> {
            return pagedGet<AccessPackageSummary>(
                '/identityGovernance/entitlementManagement/accessPackages'
                    + `?$top=${DISCOVERY_PAGE_SIZE}&$select=id,displayName,description,isHidden`,
                (raw) => {
                    if (typeof raw.id !== 'string' || raw.id === '') return null;
                    return {
                        id: raw.id,
                        displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
                        description: typeof raw.description === 'string' ? raw.description : null,
                        isHidden: typeof raw.isHidden === 'boolean' ? raw.isHidden : null,
                    };
                },
            );
        },

        /**
         * DISCOVERY: the assignment policies valid for ONE package (#3329).
         *
         * Read per package rather than all at once on purpose. The alternative
         * — fetching every package's policies to build one payload — is an
         * N+1 against a customer's directory on every form load, where N is
         * their package count. The form asks for policies when a package is
         * chosen.
         *
         * `accessPackage/id` is `$expand`ed so each policy carries the package
         * it belongs to, which is what `policyBelongsToPackage` checks. Taking
         * it from the REQUEST instead would make the check confirm its own
         * input.
         */
        async readAssignmentPolicies(
            accessPackageId: string,
        ): Promise<DiscoveryPage<AssignmentPolicySummary>> {
            const pkg = encodeURIComponent(accessPackageId);
            return pagedGet<AssignmentPolicySummary>(
                '/identityGovernance/entitlementManagement/assignmentPolicies'
                    + `?$top=${DISCOVERY_PAGE_SIZE}`
                    + `&$filter=accessPackage/id eq '${pkg}'`
                    + '&$select=id,displayName'
                    + '&$expand=accessPackage($select=id)',
                (raw) => {
                    if (typeof raw.id !== 'string' || raw.id === '') return null;
                    const ap = raw.accessPackage as { id?: unknown } | null | undefined;
                    return {
                        id: raw.id,
                        displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
                        accessPackageId: typeof ap?.id === 'string' ? ap.id : null,
                    };
                },
            );
        },
    };
}
