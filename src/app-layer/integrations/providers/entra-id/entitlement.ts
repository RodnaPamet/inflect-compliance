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
    };
}
