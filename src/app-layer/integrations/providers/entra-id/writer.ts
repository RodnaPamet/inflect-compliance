/**
 * The Microsoft Entra (Graph) directory writer — the half of this provider that
 * CHANGES a customer's directory.
 *
 * `index.ts` reads. Everything here writes, and the two are deliberately not the
 * same object: reading a directory wrong produces a wrong dashboard, writing one
 * wrong produces a person who cannot log in on Monday, or — far worse — a leaver
 * who still can, while the audit trail says otherwise.
 *
 * ═══ WHAT THIS FILE IS ACTUALLY DEFENDING AGAINST ═══
 *
 * Not a failed write. A SUCCESSFUL-LOOKING one. Three distinct ways Graph
 * produces that, each closed here:
 *
 *   1. `GET /users/{id}` without an explicit `$select` omits `accountEnabled`
 *      entirely. `undefined === false` is false, so the account reads as
 *      ENABLED, we "disable" an account we never observed, and we journal a
 *      prior state we invented. `readState` therefore refuses on an absent
 *      `accountEnabled` rather than defaulting it — unlike `normalizeGraphUser`
 *      in index.ts, which fails OPEN on the same field because a posture read
 *      may and a write may not.
 *
 *   2. A directory-synced account (`onPremisesSyncEnabled: true`) is mastered
 *      on-prem. Graph accepts the PATCH; Azure AD Connect reverts it at the
 *      next cycle. `resolveWriteTarget` already refuses this from the STORED
 *      sync flag, but that flag came from the last identity-sync pass, which
 *      for a >5000-user directory spans several scheduled runs. So `disable`
 *      re-checks the value `readState` just observed, and the fresh one wins.
 *
 *   3. `PATCH /users/{id}` without `Content-Type: application/json` is answered
 *      400. 400 is in none of `resilientFetch`'s classification sets, so the
 *      `Response` comes back intact and a writer that forgets `res.ok` reads a
 *      malformed request that changed nothing as a completed disable.
 *
 * ═══ WHY THIS DOES NOT USE THE SHARED `resilientFetch` DIRECTLY ═══
 *
 * `http-resilience.ts` puts 403 in `AUTH_STATUS` and throws
 * `IntegrationAuthError` the instant it sees one — the `Response` is never
 * returned, the Graph error body is never read. That is right for a read sync
 * and wrong here twice over:
 *
 *   • `markAuthFailure` keys on exactly that class. A 403 meaning "this app was
 *     consented for READ and you asked it to WRITE" is not a bad credential —
 *     the secret is valid and every posture sync is working. Letting it reach
 *     `markAuthFailure` would mark the connection credential-revoked, raise the
 *     UI banner, and have `shouldBypassQueueRetry` suppress the queue retry:
 *     a missing WRITE scope taking the tenant's READ posture dark.
 *
 *   • `IntegrationAuthError`'s message embeds `safeUrl(input)`, which preserves
 *     the pathname. Every read path in this provider hits collection URLs with
 *     no identifiers in them; the write path is `/users/<objectId>`. That
 *     message is persisted verbatim into
 *     `IntegrationConnection.authFailureReason`, a column exempt from field
 *     encryption ON THE GROUNDS that it is system-generated and URL-scrubbed.
 *     The write path would be the first thing to break that premise.
 *
 * The cloak takes 403 and 404 back from the classifier, which leaves 401 — and
 * 401 was reaching `readState`'s caller as a RAW `IntegrationAuthError` carrying
 * `.../users/<objectId>` in its message. Nothing calls `markAuthFailure` on this
 * path TODAY only because no `connectionId` is threaded here yet; production
 * wiring is what would arm it, and by then the leak would be a behaviour someone
 * has to notice rather than a shape someone has to add. So `get` now converts
 * every escaping `IntegrationAuthError` into this module's own
 * `DirectoryWriteError` family — and rebuilds the retained `cause` with the
 * object id replaced by a placeholder, so that the one seam this file
 * deliberately leaves open (unwrap the cause, decide at the call site whether a
 * 401 should mark the connection) is safe to actually use.
 *
 * So the transport here is `createResilientFetch` composed OVER a cloak that
 * turns a 403 — and a 404, for the separate reason given at
 * `LOCALLY_CLASSIFIED_STATUS` — into an inspectable response before the
 * classifier sees it. The deadline, the 429/`Retry-After` absorption and the 401
 * verdict are all kept; only those two statuses are taken back. Reaching for the
 * bounded fetch instead would escape the classifier and silently drop throttle
 * handling, which `tests/guards/integrations-bounded-fetch-coverage.test.ts`
 * rejects.
 *
 * ═══ THE 403 DISCRIMINATOR ═══
 *
 * Graph answers ALL of these `403 Authorization_RequestDenied`, "Insufficient
 * privileges to complete the operation":
 *
 *   (a) the application permission was never consented, or was revoked;
 *   (b) the app HAS the write permission but the target holds a privileged
 *       directory role, which additionally needs a Privileged Authentication
 *       Administrator assignment;
 *   (c) the target sits in a restricted-management administrative unit;
 *   (d) the service principal is disabled or blocked by tenant policy.
 *
 * The body cannot tell (a) from (b)/(c), and the difference decides what the
 * operator should DO. Telling someone in case (b) to "re-consent the
 * application with that permission" is actively harmful: they grant directory
 * write, it does not help, and they are left holding a broader grant for
 * nothing. Case (b) is not exotic — it fires precisely on the admin accounts
 * whose offboarding matters most.
 *
 * The discriminator is free and deterministic: the client-credentials access
 * token is a JWT whose `roles` claim lists the consented application
 * permissions verbatim. We decode the payload (base64url, NO signature
 * verification — it is our own token, from Microsoft, used only to explain a
 * failure and never to authorise anything) once per token and check it:
 *
 *   role absent  → refuse BEFORE any PATCH, as a consent problem;
 *   role present → a 403 is about THIS target, and says so without mentioning
 *                  consent.
 *
 * A token we cannot decode at all is "unknown", not "absent": we proceed and let
 * Graph decide, because refusing on our own parse failure would take a working
 * tenant offline.
 *
 * ═══ definitivelyNotApplied — THE ONE FLAG THAT MUST NOT BE WRONG ═══
 *
 * A `true` here makes the orchestrator settle the journal row FAILED, which is a
 * POSITIVE claim that the directory is unchanged. A wrong `true` files the row
 * under the single outcome that `findRestorableState` (APPLIED / INDETERMINATE)
 * and `listUnsettledWrites` (PENDING / INDETERMINATE) BOTH exclude — the
 * captured prior state becomes unreachable and nobody is told to look. So this
 * file uses one rule, mechanical rather than a judgement call at each site:
 *
 *     Everything that happens BEFORE the PATCH is dispatched is
 *     definitivelyNotApplied: true, because no request existed.
 *     Everything after depends on a response we actually received.
 *
 * A lost response — timeout, reset, an exhausted 5xx, a throttle that outlived
 * the absorb budget — is `false`, always. Before giving up on one we re-read the
 * account: if it now reads disabled, the write landed and `disable` resolves
 * normally. If it still reads enabled we report failure with the flag still
 * FALSE, because a read-back on an eventually-consistent directory is strong
 * evidence and not the provider's own rejection, and the contract asks for proof
 * rather than confidence.
 *
 * @module integrations/providers/entra-id/writer
 * @see src/app-layer/usecases/identity-disable-account.ts — the contract
 */
import {
    DirectoryWriteError,
    InsufficientDirectoryPermission,
    type DirectoryAccountState,
    type DirectoryWriter,
} from '@/app-layer/usecases/identity-disable-account';
import { createBoundedFetch, safeUrl } from '../../bounded-fetch';
import {
    createResilientFetch,
    IntegrationAuthError,
    IntegrationRateLimitedError,
} from '../../http-resilience';
import { fetchOAuthToken } from '../../oauth-token-fetch';
import { logger } from '@/lib/observability/logger';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_BASE = 'https://login.microsoftonline.com';

/**
 * The provider id, and it is the EXACT literal or nothing works.
 *
 * `resolveWriteTarget` matches this against `CLOUD_DIRECTORIES`, and
 * `DirectoryWriter.provider` is typed `string`, so nothing type-checks it. The
 * near-miss is already in this codebase: `'microsoft-entra-id'` is the NextAuth
 * provider id used throughout `src/auth.ts` and `src/lib/auth/refresh.ts`, so it
 * is the string that is top-of-mind here. A writer declaring it would fall into
 * the `!CLOUD_DIRECTORIES.has(...)` arm and return `REFUSED_TARGET` for every
 * account in every tenant — nothing throws, nothing logs an error, and the batch
 * reports clean results. It would look exactly like the safety rails working.
 *
 * The same string is denormalised into `IdentityWriteJournal.provider` by
 * `beginWrite` and queried by `findRestorableState`, so a mismatch would also
 * orphan every journal row from its own restore lookup.
 */
export const ENTRA_WRITER_PROVIDER_ID = 'entra-id';

/**
 * The `$select` `readState` issues, and every part of it is deliberate.
 *
 * `GET /users/{id}` returns a small DEFAULT property set containing neither
 * `accountEnabled` nor `onPremisesSyncEnabled`, so an absent `$select` is the
 * single most dangerous way to get this wrong.
 *
 * Neither of the two existing constants can be reused:
 *
 *   USER_SELECT_FULL  carries `signInActivity`, which needs AuditLog.Read.All
 *                     plus a premium licence. The read path has a whole fallback
 *                     for exactly that 4xx; a writer copying the constant would
 *                     have none, and if the 4xx were a 403 it would be reported
 *                     as "you lack permission to disable accounts" when the real
 *                     cause is an unrelated select field.
 *   USER_SELECT_BASE  is shaped for `normalizeGraphUser`, which collapses the
 *                     three-state answer into two (absent reads as ACTIVE).
 *
 * `assignedLicenses` is here for the CAPTURE, not the write: dynamic groups
 * whose membership rule keys on `accountEnabled` drop the user when we disable
 * them, group-based licensing then strips the licence, and that starts a 30-day
 * mailbox deletion clock which re-enabling restores the membership but does not
 * rewind. Recording what was assigned makes that damage checkable. It is split
 * out of the minimal set below so that a tenant which refuses it costs us the
 * licence capture and not the whole read.
 */
const WRITE_SELECT_FULL =
    'id,accountEnabled,onPremisesSyncEnabled,userPrincipalName,displayName,userType,assignedLicenses';
/** The same set minus the one field that could plausibly be refused. */
const WRITE_SELECT_MINIMAL =
    'id,accountEnabled,onPremisesSyncEnabled,userPrincipalName,displayName,userType';

/**
 * Application permissions that permit `PATCH /users/{id}` with `accountEnabled`.
 *
 * `User.EnableDisableAccount.All` is the least-privilege answer — it grants that
 * property and nothing else, and it is what the setup guide asks for.
 * `User.ReadWrite.All` and `Directory.ReadWrite.All` are ACCEPTED because a
 * tenant may already hold either for unrelated reasons and refusing a grant that
 * genuinely works would be a false negative; neither is ever REQUESTED.
 *
 * `Directory.Read.All` — which the setup guide does ask for — does NOT imply
 * write, and that is the trap this list exists to state plainly.
 */
const WRITE_ROLES: readonly string[] = [
    'User.EnableDisableAccount.All',
    'User.ReadWrite.All',
    'Directory.ReadWrite.All',
];

/** Named in operator-facing copy: the one an admin should actually grant. */
const LEAST_PRIVILEGE_WRITE_ROLE = 'User.EnableDisableAccount.All';

/**
 * Renew this many ms before the token's own expiry.
 *
 * A sequential batch that spends time absorbing 429s can outlive an hour-long
 * Graph token mid-run, and the resulting 401 is indistinguishable at the catch
 * site from a genuinely revoked secret.
 */
const TOKEN_SKEW_MS = 5 * 60_000;
/** Used when the token endpoint omits `expires_in`. Graph's real value is ~3600. */
const TOKEN_DEFAULT_TTL_MS = 3_600_000;

/** One page of group memberships. The capture is a record, not an inventory. */
const MEMBER_OF_PAGE = 100;

/**
 * The status a cloaked response wears while it passes the classifier.
 *
 * A 4xx rather than a 2xx on purpose: `res.ok` stays false, so a future reader
 * who forgets the header cannot mistake a refusal for a success. 460 is
 * unassigned, so it cannot collide with a real Graph answer, and
 * `classifyStatus` returns null for it (not in the retryable / auth / terminal
 * sets, below 500) which is what lets it through untouched.
 */
const CLOAKED_STATUS = 460;
/** Where the cloak stashes the status it hid. The authority, not `res.status`. */
const CLOAK_HEADER = 'x-inflect-cloaked-status';

/** A GUID, in the 8-4-4-4-12 shape Entra object ids always take. */
const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same shape, unanchored and global, for removing an id from a URL.
 *
 * Only ever used with `String.replace`, which resets `lastIndex` on a global
 * regex. It must never be handed to `.test()`, where the retained `lastIndex`
 * makes alternate calls return false — the classic footgun, and the reason this
 * is a second constant rather than a flag on `OBJECT_ID_RE`.
 */
const ANY_OBJECT_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Host + path, with any object id replaced. Safe to persist and to render. */
function scrubbedUrl(url: string): string {
    return safeUrl(url).replace(ANY_OBJECT_ID_RE, '{objectId}');
}

/**
 * The version stamp on every capture this file writes.
 *
 * `beginWrite` rejects `{}` because a restore reading an empty capture cannot
 * tell "the answer is missing" from "there was nothing to capture". The same
 * argument applies one level down, per key: six months from now, an absent
 * `assignedLicenseSkuIds` in a plaintext JSON column is unreadable without
 * knowing whether the writer of that era selected the field at all. So the
 * capture says which schema and which `$select` produced it.
 */
const CAPTURE_SCHEMA = 'entra-id/disable-account/v1';

/** What Graph hands back for the fields we ask for. */
interface GraphWriteUser {
    id?: string;
    accountEnabled?: boolean;
    onPremisesSyncEnabled?: boolean | null;
    userPrincipalName?: string;
    displayName?: string;
    userType?: string;
    assignedLicenses?: Array<{ skuId?: string }>;
}

interface GraphErrorBody {
    error?: { code?: string; message?: string };
}

/**
 * A 403 whose token PROVES the write permission was never consented.
 *
 * Carries `InsufficientDirectoryPermission`'s message — which names the missing
 * permission and tells the operator to re-consent — but IS a
 * `DirectoryWriteError`, because the usecase's `provenNotApplied` is an
 * `instanceof DirectoryWriteError` check. Raising the bare
 * `InsufficientDirectoryPermission` would settle a proven, pre-network refusal
 * as INDETERMINATE and put a row in front of a human for a write that never left
 * this process.
 */
export class EntraWritePermissionMissingError extends DirectoryWriteError {
    constructor(needed: string = LEAST_PRIVILEGE_WRITE_ROLE) {
        super(new InsufficientDirectoryPermission(ENTRA_WRITER_PROVIDER_ID, needed).message, {
            definitivelyNotApplied: true,
        });
        this.name = 'EntraWritePermissionMissingError';
    }
}

/**
 * A 403 on an account we are otherwise permitted to write.
 *
 * The token carries the write role, so consent is not the problem and must not
 * be mentioned: the operator's next action is a directory-role assignment (or
 * moving the account out of a restricted-management administrative unit), and
 * sending them to the consent screen would cost them a broader grant that fixes
 * nothing.
 */
export class EntraPrivilegedTargetError extends DirectoryWriteError {
    constructor(externalUserId: string, graphCode: string | null) {
        super(
            `Entra refused to disable account ${externalUserId}, and the application's own token shows the ` +
                `write permission IS consented — so this refusal is about this account, not about consent. ` +
                `Graph answers 403 ${graphCode ?? 'Authorization_RequestDenied'} when the target holds a ` +
                `privileged directory role (changing accountEnabled on an admin additionally requires a ` +
                `Privileged Authentication Administrator role assignment), or when the account sits in a ` +
                `restricted-management administrative unit. Do NOT re-consent the application: it would ` +
                `broaden the grant without fixing this. Assign the directory role, or disable this account ` +
                `in the Entra admin center.`,
            { definitivelyNotApplied: true },
        );
        this.name = 'EntraPrivilegedTargetError';
    }
}

/**
 * The credential itself was rejected on a Graph call.
 *
 * A `DirectoryWriteError` rather than the `IntegrationAuthError` it came from,
 * for two reasons. It must carry `definitivelyNotApplied: true` — Graph
 * evaluated and rejected the request, nothing was mutated — which the contract
 * can only read off this class. And the original message embeds
 * `/users/<objectId>`, which `markAuthFailure` would persist into an
 * unencrypted, UI-rendered column.
 *
 * `cause` keeps the original so that if the write path is ever handed a
 * `connectionId`, a caller can unwrap it and decide — deliberately leaving that
 * decision at the call site rather than making it here, because per the module
 * docblock a 403 must NEVER take that route and a 401 legitimately may.
 */
export class EntraCredentialRejectedError extends DirectoryWriteError {
    /**
     * `cause` is optional because a 401 now arrives two different ways.
     *
     * Through the read path it is still a thrown `IntegrationAuthError`. On the
     * WRITE path it is a plain Response, because writes bypass the retrying
     * transport that used to convert it — so there is no error object to carry,
     * only the status and Graph's message. Both are the same event to an
     * operator; only the plumbing differs.
     */
    constructor(externalUserId: string, cause: IntegrationAuthError | string) {
        const status = typeof cause === 'string' ? 401 : cause.status;
        super(
            `Entra rejected the credential (HTTP ${status}) while disabling account ${externalUserId}. ` +
                `The request was evaluated and refused, so the directory is unchanged. A token refresh was ` +
                `already attempted, so this is the app registration's client secret rather than a merely ` +
                `expired access token.`,
            { definitivelyNotApplied: true },
        );
        this.name = 'EntraCredentialRejectedError';
        // Kept in both shapes so a caller can always unwrap the provenance.
        //
        // The objectId-leak concern is specific to `IntegrationAuthError`,
        // whose own message embeds `/users/<objectId>` — carrying THAT into the
        // unencrypted, UI-rendered `authFailureReason` column is the thing to
        // decide about at the call site. The string form is Graph's error
        // message or code, which names no account.
        this.cause = cause;
    }
}

/**
 * The trailing half of the writes-disabled refusal, when the stored value is
 * the reason rather than the absence of one.
 *
 * Returns '' for a plainly absent opt-in (undefined / null / false / missing),
 * where the base message already says everything there is to say. The extra
 * sentence is earned only by a value that an operator would reasonably read as
 * an opt-in, because that is the case where repeating "turn it on" describes
 * something they have already done.
 */
function describeWritesEnabled(value: unknown): string {
    if (value === undefined || value === null || value === false) return '';
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    const looksAffirmative =
        (typeof value === 'string' && ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase())) ||
        value === 1;
    if (!looksAffirmative) {
        return (
            ` (This connection stores writesEnabled as ${typeof value} ${shown}, which is not an opt-in: ` +
            'the flag is compared strictly against the boolean true.)'
        );
    }
    return (
        ` (This connection stores writesEnabled as the ${typeof value} ${shown} rather than the boolean ` +
        'true, so the flag reads as ON in the admin UI and OFF here — writes are compared strictly, on ' +
        'purpose, because a value that merely looks affirmative is not a deliberate grant of standing ' +
        'power to disable accounts. Other booleans on this same connection are read through a ' +
        'string-coercing helper and WILL be on, which is why this one looks inconsistent. Re-save the ' +
        'connection, or correct the stored value to a JSON boolean.)'
    );
}

/** Config the writer needs. Shaped like `{...configJson, ...decryptedSecrets}`. */
export interface EntraWriterConfig {
    readonly tenantId?: unknown;
    readonly clientId?: unknown;
    readonly clientSecret?: unknown;
    readonly writesEnabled?: unknown;
}

export interface EntraWriterDeps {
    /**
     * The underlying transport. Injected by tests; NEVER the global fetch. When
     * absent the writer builds a bounded one and composes the resilient stack
     * over it, so the default carries the 30s deadline plus 429 handling.
     */
    readonly fetchImpl?: typeof fetch;
    /** Injected so a backoff can be asserted without a test sleeping through it. */
    readonly sleepImpl?: (ms: number) => Promise<void>;
    /** Injected so jittered backoff is deterministic under test. */
    readonly rand?: () => number;
    /** Injected so token-expiry behaviour is testable without waiting an hour. */
    readonly now?: () => number;
}

interface CachedToken {
    readonly token: string;
    /**
     * The `roles` claim, or null when the token could not be decoded at all.
     * An EMPTY set is a real answer (a token with no consented application
     * permissions has no roles); null means we do not know and must not refuse.
     */
    readonly roles: ReadonlySet<string> | null;
    readonly expiresAt: number;
}

/** Decode a JWT payload's `roles`. Never throws; null means "could not tell". */
function decodeTokenRoles(token: string): ReadonlySet<string> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (typeof payload !== 'object' || payload === null) return null;
        const roles = (payload as { roles?: unknown }).roles;
        // A parsed payload with NO roles claim is the zero-consent case, and it
        // is a real answer — the set is empty, not unknown.
        if (roles === undefined) return new Set<string>();
        if (!Array.isArray(roles)) return null;
        return new Set(roles.filter((r): r is string => typeof r === 'string'));
    } catch {
        return null;
    }
}

/**
 * The two statuses this writer must classify for itself.
 *
 *   403  because the shared classifier throws `IntegrationAuthError` — the class
 *        `markAuthFailure` keys on — before the Graph error body can be read.
 *        See the module docblock: a missing WRITE scope is not a bad credential,
 *        and letting it mark the connection would take the tenant's READ posture
 *        dark over a permission the read path does not need.
 *
 *   404  because it throws `IntegrationTerminalError`, and `readState` is called
 *        OUTSIDE the orchestrator's try/catch. `findLeaverCandidates` does not
 *        filter on `ConnectedIdentityAccount.status`, so the candidate list
 *        routinely holds accounts since deleted from Entra — one of them would
 *        end a 1000-account run at whichever position it happened to occupy,
 *        with no `results` array to say which accounts were done.
 *
 * 401 is deliberately NOT here: it stays an auth verdict from the shared
 * classifier, and `disable` translates it only after a token refresh has already
 * ruled out the benign cause.
 */
const LOCALLY_CLASSIFIED_STATUS: ReadonlySet<number> = new Set([403, 404]);

/**
 * Take those statuses back from the classifier without giving up anything else.
 *
 * The cloak sits UNDER `createResilientFetch`, so the status is rewritten before
 * `classifyStatus` ever sees it. The body is buffered into a fresh `Response`
 * because the original is consumed here; everything else — deadline, retries,
 * `Retry-After`, the 401 verdict — is unchanged.
 */
function cloakLocallyClassified(inner: typeof fetch): typeof fetch {
    return async function cloakingFetch(input, init) {
        const res = await inner(input, init);
        if (!LOCALLY_CLASSIFIED_STATUS.has(res.status)) return res;
        const body = await res.text();
        const headers = new Headers(res.headers);
        headers.set(CLOAK_HEADER, String(res.status));
        return new Response(body, { status: CLOAKED_STATUS, headers });
    };
}

/** The status the remote actually sent, seeing through the cloak. */
function trueStatus(res: Response): number {
    const hidden = res.headers?.get?.(CLOAK_HEADER);
    if (!hidden) return res.status;
    const parsed = Number(hidden);
    return Number.isFinite(parsed) ? parsed : res.status;
}

/** Read a Graph error body. Never throws — a message is not worth a failure. */
async function readGraphError(
    res: Response,
): Promise<{ code: string | null; message: string | null }> {
    try {
        const body = (await res.json()) as GraphErrorBody;
        return {
            code: typeof body?.error?.code === 'string' ? body.error.code : null,
            message: typeof body?.error?.message === 'string' ? body.error.message : null,
        };
    } catch {
        return { code: null, message: null };
    }
}

/**
 * Assert the id is an Entra object GUID, and return it.
 *
 * Shape-checked rather than trusted because the value arrives from
 * `ConnectedIdentityAccount.externalUserId` with no type-level guarantee, and
 * because it is spliced into a request PATH — see `userUrl`.
 */
export function assertEntraObjectId(externalUserId: string): string {
    const id = externalUserId.trim();
    if (!OBJECT_ID_RE.test(id)) {
        throw new DirectoryWriteError(
            `Refusing to act on "${externalUserId}": an Entra account id must be the directory object GUID. ` +
                `No request was made. A UPN (especially a "#EXT#" guest one) would truncate the request path ` +
                `at the "#", and a value carrying path separators would re-target the request at a different ` +
                `Graph collection.`,
            { definitivelyNotApplied: true },
        );
    }
    return id;
}

/**
 * Statuses that PROVE Graph evaluated the request and rejected it without
 * mutating anything.
 *
 * Membership is a claim about the SERVER's behaviour, not about ours, so each
 * entry has to be justified on that basis:
 *
 *   400  malformed request — parsed and refused before dispatch
 *   401  unauthenticated — refused at the edge
 *   403  unauthorised — evaluated against the token's roles, then refused
 *   404  no such resource — nothing existed to mutate
 *   405  method not allowed on the route
 *   411/413/414/415  the request itself was rejected on its shape
 *   422  semantically rejected after parsing
 *
 * Deliberately ABSENT, and each for a reason:
 *   408  the server timed out RECEIVING — it may have had enough to act on
 *   409  a conflict can reflect state that a partial application produced
 *   423  locked — says nothing about whether this request touched it first
 *   425  too early — replay protection, not a statement about application
 *   429  rate-limited (resilientFetch owns it, and it is a refusal, but it
 *        never reaches here intact)
 *   5xx  the canonical may-have-landed case
 *
 * Anything not listed is indeterminate BY DEFAULT. A status nobody has reasoned
 * about must not inherit a claim of proof.
 */
const PROVEN_UNAPPLIED_STATUS: ReadonlySet<number> = new Set([
    400, 401, 403, 404, 405, 411, 413, 414, 415, 422, 429,
]);

/**
 * The Entra (Graph) implementation of `DirectoryWriter`.
 *
 * One instance per batch: the token is cached on it, so a 1000-account run costs
 * ONE client-credentials exchange rather than 2000 against an endpoint Entra
 * throttles per app-per-tenant.
 */
export class EntraIdDirectoryWriter implements DirectoryWriter {
    readonly provider = ENTRA_WRITER_PROVIDER_ID;

    private readonly tenantId: string;
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly doFetch: typeof fetch;
    /** Single-dispatch transport for writes — see `patch`. */
    private readonly writeFetch: typeof fetch;
    private readonly now: () => number;
    private cached: CachedToken | null = null;

    constructor(config: EntraWriterConfig, deps: EntraWriterDeps = {}) {
        this.tenantId = String(config.tenantId ?? '').trim();
        this.clientId = String(config.clientId ?? '').trim();
        this.clientSecret = String(config.clientSecret ?? '');
        this.now = deps.now ?? Date.now;

        // Every one of these throws at CONSTRUCTION, and that placement is the
        // point. A writer built from `configJson` alone — the natural mistake,
        // since `resolveWriteTarget` only needs provider + sync flag, and the
        // secret lives in `secretEncrypted` rather than `configJson` — would
        // otherwise be a perfectly working object that throws once per account,
        // producing 1000 FAILED journal rows and surfacing nothing on the
        // connection. Failing here fails the batch once, before any of it runs.
        if (!this.tenantId) throw new Error('Entra writer needs a Directory (tenant) ID');
        if (!this.clientId) throw new Error('Entra writer needs an Application (client) ID');
        if (!this.clientSecret) {
            // A PLAIN Error, matching getEntraAccessToken's pre-flight and for
            // the same reason: a secret missing because it failed to decrypt (a
            // rotation race, a DEK problem) must not be recorded as "your
            // credentials are revoked".
            throw new Error('Entra writer skipped: clientSecret is missing or failed to decrypt');
        }
        if (config.writesEnabled !== true) {
            // Fail CLOSED, and STRICTLY — `!== true`, not a coercion. `.default`
            // on a client-credentials grant returns whatever an admin has
            // already consented, so the moment a tenant re-consents for one
            // purpose this application gains standing power to disable any user
            // in that directory, including tenants that only ever wanted posture
            // checks. This flag is the per-connection statement that they asked
            // for more than reading, and it is why a setup-guide edit alone
            // cannot upgrade a read-only tenant. A value that merely LOOKS true
            // is not that statement.
            //
            // The strictness is right and the silence was not. Sibling booleans
            // on this very connection — `enrichMfa`, `enrichFederation` in
            // index.ts — are read through a string-coercing `truthy` helper, so
            // a config row that stored "true" as a string has those ON while
            // this one is OFF. The operator sees a checkbox they ticked, an
            // error telling them to tick it, and no way to tell those apart. So
            // when the stored value is truthy-shaped but not the boolean, say
            // exactly that instead of repeating the instruction they followed.
            throw new Error(
                'Entra writer refused: this connection is not enabled for directory writes. Turn on ' +
                    '"Allow offboarding writes" on the connection, and make sure an administrator has ' +
                    `consented the application permission ${LEAST_PRIVILEGE_WRITE_ROLE}.` +
                    describeWritesEnabled(config.writesEnabled),
            );
        }

        const inner = deps.fetchImpl ?? createBoundedFetch();
        this.doFetch = createResilientFetch({
            fetchImpl: cloakLocallyClassified(inner),
            sleepImpl: deps.sleepImpl,
            rand: deps.rand,
        });
        // Writes get the BOUNDED fetch without the retry wrapper. `inner` still
        // carries the deadline — that is what bounded means — but nothing above
        // it re-dispatches, so the response classified is the only response
        // there was. See `patch` for why a retried write cannot report honestly.
        this.writeFetch = inner;
    }

    // ─────────────────────────── token ───────────────────────────

    /**
     * The cached access token, exchanged on demand.
     *
     * Exchanged HERE rather than through `getEntraAccessToken` because that
     * helper parses `expires_in` away and returns only the string, so a caller
     * has no way to cache it honestly. The two things it does deliberately are
     * replicated: the pre-flight secret check (moved to the constructor above)
     * and routing through `fetchOAuthToken`, which is what turns a
     * `400 invalid_client` from an expired secret into a classified auth failure
     * instead of a generic one.
     */
    private async token(forceRefresh = false): Promise<CachedToken> {
        const cached = this.cached;
        if (!forceRefresh && cached && cached.expiresAt > this.now()) return cached;

        const res = await fetchOAuthToken(
            `${LOGIN_BASE}/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                // Pre-serialized. `createResilientFetch` reuses the same `init`
                // object across attempts, so any body that can only be read once
                // fails on the second try with a consumed-body error.
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                    scope: 'https://graph.microsoft.com/.default',
                }).toString(),
            },
            this.doFetch,
        );
        if (!res.ok) throw new Error(`Entra token exchange failed (HTTP ${res.status})`);
        const json = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!json.access_token) throw new Error('Entra token exchange returned no access_token');

        const ttlMs =
            typeof json.expires_in === 'number' && json.expires_in > 0
                ? json.expires_in * 1_000
                : TOKEN_DEFAULT_TTL_MS;
        const roles = decodeTokenRoles(json.access_token);
        if (roles === null) {
            logger.warn('Entra access token could not be decoded — 403 diagnosis degraded', {
                component: 'integration-entra-id-writer',
            });
        }
        const fresh: CachedToken = {
            token: json.access_token,
            roles,
            // Renew early. Expiry is measured against OUR clock, so the skew
            // also absorbs drift against Microsoft's.
            expiresAt: this.now() + Math.max(ttlMs - TOKEN_SKEW_MS, 0),
        };
        this.cached = fresh;
        return fresh;
    }

    /**
     * Whether the token's `roles` claim carries a permission that permits the
     * PATCH. `null` = the token was undecodable, so we cannot say.
     */
    private static hasWriteRole(roles: ReadonlySet<string> | null): boolean | null {
        if (roles === null) return null;
        return WRITE_ROLES.some((r) => roles.has(r));
    }

    /**
     * Check consent ONCE, before a batch, so 1000 doomed writes become one
     * refusal.
     *
     * Optional by design — `disable` enforces the same thing per account, where
     * a throw is CONTAINED by the usecase's try/catch and settles as a clean
     * FAILED row. Calling this first is strictly better (it costs one token
     * exchange and refuses the whole run), but forgetting it is safe rather than
     * silently permissive.
     */
    async preflight(): Promise<void> {
        const { roles } = await this.token();
        if (EntraIdDirectoryWriter.hasWriteRole(roles) === false) {
            throw new EntraWritePermissionMissingError();
        }
    }

    // ─────────────────────────── read ───────────────────────────

    /**
     * Read the account, and capture what a restore would need.
     *
     * Every Graph call below goes through `get`, which is where the containment
     * promised by the module docblock is actually enforced: an
     * `IntegrationAuthError` raised by the shared classifier — the class
     * `markAuthFailure` keys on, carrying `/users/<objectId>` in a message that
     * would be persisted into an unencrypted, UI-rendered column — cannot leave
     * this object.
     *
     * NOTE ON CONTAINMENT: the orchestrator calls this OUTSIDE its try/catch, so
     * anything thrown here aborts the whole batch rather than failing one
     * account. That is why a 404 RESOLVES rather than throwing (below) — a
     * candidate list built from `findLeaverCandidates` routinely contains
     * accounts since deleted from Entra, and one of them must not end a
     * 1000-account run. The remaining throws (a credential failure, an
     * unreadable account, a malformed id) are cases where continuing would mean
     * guessing at state, and guessing is what this whole file exists to avoid.
     */
    async readState(externalUserId: string): Promise<DirectoryAccountState> {
        const id = assertEntraObjectId(externalUserId);
        const token = await this.token();

        let selectUsed = WRITE_SELECT_FULL;
        let res = await this.get(this.userUrl(id, selectUsed), token.token, id);

        if (trueStatus(res) === 404) {
            // Deleted from the directory since the last sync. The account cannot
            // be enabled, so reporting it disabled lets the orchestrator record
            // ALREADY_DISABLED and move on instead of one dead account ending
            // the run. `beginWrite` never runs for this path, so the capture
            // below is documentation rather than a restore source — but it must
            // still be non-empty and self-describing.
            logger.info('Entra account no longer exists — treating as already disabled', {
                component: 'integration-entra-id-writer',
                externalUserId: id,
            });
            return {
                enabled: false,
                priorState: {
                    captureSchema: CAPTURE_SCHEMA,
                    capturedAt: new Date(this.now()).toISOString(),
                    id,
                    notFound: true,
                },
            };
        }

        if (!res.ok && selectUsed === WRITE_SELECT_FULL) {
            // Same shape as the read path's signInActivity fallback: one
            // property in the select must never be able to fail the whole read.
            // Without this, a tenant that refuses `assignedLicenses` would fall
            // into the 403 branch below and be told they lack permission to
            // disable accounts.
            logger.warn(
                'Entra user read with assignedLicenses failed; retrying without the licence capture',
                {
                    component: 'integration-entra-id-writer',
                    externalUserId: id,
                    status: trueStatus(res),
                },
            );
            selectUsed = WRITE_SELECT_MINIMAL;
            res = await this.get(this.userUrl(id, selectUsed), token.token, id);
        }

        if (!res.ok) {
            throw await this.classifyGraphFailure(res, token, id, 'read');
        }

        const user = (await res.json()) as GraphWriteUser;

        // The whole reason for the explicit $select. An absent `accountEnabled`
        // must NOT read as `true`: that would have us disable an account whose
        // state we never observed, journal a prior state we invented, and — if
        // it was in fact already disabled — destroy the only surviving record of
        // what it used to be, because the ALREADY_DISABLED short-circuit that
        // exists to prevent exactly that would never fire. index.ts already
        // applies this discipline one field over
        // (`onPremisesSyncEnabled: u.onPremisesSyncEnabled ?? null`); it fails
        // open on `accountEnabled` because a posture read may, and this may not.
        if (typeof user.accountEnabled !== 'boolean') {
            throw new DirectoryWriteError(
                `Entra returned no accountEnabled for account ${id}, so its current state is unknown. ` +
                    `Refusing to disable an account whose state was never observed — "absent" is not ` +
                    `"enabled", and treating it as such would journal a prior state that was never read.`,
                { definitivelyNotApplied: true },
            );
        }

        const licences = user.assignedLicenses
            ?.map((l) => l.skuId)
            .filter((s): s is string => typeof s === 'string');

        return {
            enabled: user.accountEnabled,
            priorState: {
                // Which schema and which $select produced this. Without it, an
                // absent key in a plaintext JSON column is unreadable later: a
                // reader cannot tell "we captured everything there was" from
                // "the writer of that era did not select that field".
                captureSchema: CAPTURE_SCHEMA,
                capturedSelect: selectUsed,
                capturedAt: new Date(this.now()).toISOString(),

                // The value a restore writes back — AS OBSERVED, never assumed.
                accountEnabled: user.accountEnabled,

                // Identity. UPNs get renamed and recycled, so the immutable
                // object id is the only reliable handle; the UPN and display
                // name are what lets a human months later confirm WHICH account
                // this was before re-enabling it.
                id: user.id ?? id,
                userPrincipalName: user.userPrincipalName ?? null,
                displayName: user.displayName ?? null,
                userType: user.userType ?? null,

                // As read AT WRITE TIME, not the possibly-days-stale value from
                // ConnectedIdentityAccount. This is the field that decides
                // whether the write could land at all, so the journal records
                // what was true when it did. `?? null` keeps "Graph omitted it"
                // distinct from "Graph said false".
                onPremisesSyncEnabled: user.onPremisesSyncEnabled ?? null,

                // Deliberately narrow. `priorStateJson` is NOT in the field
                // encryption manifest (`IdentityWriteJournal: ['detail']`), so
                // this is a plaintext column — dumping the whole Graph user here
                // would put mobilePhone, otherMails and employeeId in the clear
                // for every offboarded worker.
                assignedLicenseSkuIds: licences ?? null,
                ...(await this.captureMemberships(id, token.token)),
            },
        };
    }

    /**
     * Direct group memberships, best-effort.
     *
     * `prisma/schema/personnel.prisma` already flags why: `accountEnabled` is
     * recoverable in principle but says nothing about the group memberships a
     * disable takes with it. Dynamic groups whose rule keys on `accountEnabled`
     * drop the user, group-based licensing then strips the licence, and a
     * 30-day mailbox deletion clock starts that re-enabling does not rewind.
     * Capturing the list makes the damage checkable; not capturing it makes the
     * restore unverifiable.
     *
     * Never fails the capture: `null` records "we could not read them", which a
     * later reader can tell apart from `[]` ("they had none").
     */
    private async captureMemberships(
        id: string,
        token: string,
    ): Promise<{ memberOfGroupIds: string[] | null; memberOfTruncated: boolean }> {
        try {
            const res = await this.get(
                `${GRAPH_BASE}/users/${encodeURIComponent(id)}/memberOf/microsoft.graph.group` +
                    `?$select=id&$top=${MEMBER_OF_PAGE}`,
                token,
                id,
            );
            if (!res.ok) return { memberOfGroupIds: null, memberOfTruncated: false };
            const body = (await res.json()) as {
                value?: Array<{ id?: string }>;
                '@odata.nextLink'?: string;
            };
            const ids = (body.value ?? [])
                .map((g) => g.id)
                .filter((g): g is string => typeof g === 'string');
            // ONE page, and `memberOfTruncated` says so. This is a record of
            // what a disable displaced, not an inventory, and a leaver batch is
            // already 1000 accounts of sequential Graph traffic.
            return { memberOfGroupIds: ids, memberOfTruncated: Boolean(body['@odata.nextLink']) };
        } catch {
            return { memberOfGroupIds: null, memberOfTruncated: false };
        }
    }

    // ─────────────────────────── write ───────────────────────────

    /**
     * Disable the account.
     *
     * Resolves on success; throws `DirectoryWriteError` otherwise, with
     * `definitivelyNotApplied` set per the module docblock's one rule.
     */
    async disable(externalUserId: string, prior: DirectoryAccountState): Promise<void> {
        const id = assertEntraObjectId(externalUserId);

        // ── Re-verify the on-prem flag against what readState JUST observed. ──
        //
        // `resolveWriteTarget` already checked this at step 2 of the usecase,
        // but from `ConnectedIdentityAccount` — a row written by the last
        // successful identity-sync, which for a directory over MAX_USERS spans
        // several scheduled runs. An account brought under Azure AD Connect
        // since that sync still reads false there. That module's own rule is
        // "config loses to observation, always", and a stale observation is
        // closer to config than to observation.
        //
        // This lives in `disable` rather than `readState` on purpose: it is
        // inside the usecase's try/catch, so it settles as a clean FAILED row
        // with a reason instead of aborting the batch. The cost is a journal row
        // recording an attempt that never reached the network, which is the
        // cheaper of the two mistakes.
        const onPrem = prior.priorState.onPremisesSyncEnabled;
        if (onPrem === true) {
            throw new DirectoryWriteError(
                `Refusing to disable account ${id} through Graph: a read taken just now reports it ` +
                    `directory-synced (onPremisesSyncEnabled: true), so it is mastered on-premises and this ` +
                    `write would be reverted at the next Azure AD Connect cycle — the account would report ` +
                    `disabled and then re-enable itself, with an audit trail saying the offboarding ` +
                    `succeeded. The stored sync flag said otherwise, which means it is stale; disable this ` +
                    `account in Active Directory instead.`,
                { definitivelyNotApplied: true },
            );
        }
        if (onPrem !== false) {
            throw new DirectoryWriteError(
                `Refusing to disable account ${id}: its on-premises sync state was not observed on the read ` +
                    `taken just now. Unknown is not the same as cloud-only, and the two differ exactly where ` +
                    `it matters.`,
                { definitivelyNotApplied: true },
            );
        }

        // ── Consent, from our own token rather than from a 403 we cannot read. ──
        let token = await this.tokenForWrite(id);
        if (EntraIdDirectoryWriter.hasWriteRole(token.roles) === false) {
            throw new EntraWritePermissionMissingError();
        }

        // Pre-serialized, and it must stay that way: `createResilientFetch`
        // hands the SAME `init` to every attempt, so a Request instance, a
        // stream or FormData would fail the second attempt on a consumed body.
        // A plain string is also what makes the retry safe in the first place —
        // `{"accountEnabled": false}` is an absolute set, not a delta, so
        // applying it twice yields the same state. (Graph directory objects
        // carry no ETag / If-Match, so there is no compare-and-swap available
        // for the readState → PATCH window either.)
        const body = JSON.stringify({ accountEnabled: false });
        const url = this.userUrl(id);

        let res: Response;
        try {
            res = await this.patch(url, token.token, body);
        } catch (err) {
            return await this.settleLostResponse(err, id);
        }

        // ── A 401 is the ONE status it is safe to retry after. ──
        //
        // A long batch can outlive an hour-long token, and that 401 is
        // indistinguishable here from a revoked secret. Refresh once and try
        // again; escalate only if the FRESH token is rejected too.
        //
        // Retrying is safe because 401 PROVES the request was refused at the
        // edge without being processed — the same reason it is on
        // PROVEN_UNAPPLIED_STATUS. That property is exactly what a 5xx lacks,
        // which is why the transport under `patch` does not retry generally: a
        // second dispatch after an ambiguous first one destroys the ability to
        // say which attempt landed.
        //
        // It arrives as a RESPONSE, not a throw, because the write transport
        // is the bounded fetch alone — `createResilientFetch` is what used to
        // turn a 401 into a thrown IntegrationAuthError, and writes no longer
        // pass through it.
        if (res.status === 401) {
            token = await this.tokenForWrite(id, true);
            try {
                res = await this.patch(url, token.token, body);
            } catch (retryErr) {
                return await this.settleLostResponse(retryErr, id);
            }
        }

        // 204 No Content is the SUCCESS shape for PATCH /users/{id}. The read
        // idiom in index.ts is `await res.json()`, which throws on a 204 — so
        // the success path must not parse a body at all.
        if (res.ok) return;

        throw await this.classifyGraphFailure(res, token, id, 'write');
    }

    /** The token, with an acquisition failure reported as pre-network. */
    private async tokenForWrite(id: string, forceRefresh = false): Promise<CachedToken> {
        try {
            return await this.token(forceRefresh);
        } catch (err) {
            // No PATCH was dispatched, so "the directory is unchanged" is PROVEN
            // rather than inferred — this is one of the few places where that
            // claim is unambiguous.
            const detail = err instanceof Error ? err.message : String(err);
            const wrapped = new DirectoryWriteError(
                `Could not obtain a Graph token to disable account ${id}, so no request was made and the ` +
                    `directory is unchanged: ${detail}`,
                { definitivelyNotApplied: true },
            );
            wrapped.cause = err;
            throw wrapped;
        }
    }

    // ───────────────────── failure classification ─────────────────────

    /**
     * Turn a non-ok Graph response into the right refusal.
     *
     * Only ever reached with a response in hand, which is what makes
     * `definitivelyNotApplied: true` honest here: Graph evaluated the request
     * and answered.
     */
    private async classifyGraphFailure(
        res: Response,
        token: CachedToken,
        id: string,
        phase: 'read' | 'write',
    ): Promise<Error> {
        const status = trueStatus(res);
        const { code, message } = await readGraphError(res);

        if (status === 403 && phase === 'read') {
            // A 403 on the GET is not a statement about the WRITE permission,
            // and the difference sends an operator to a different screen.
            //
            // This used to fall into the discriminator below, so a refused read
            // was reported as "the connection was consented for READ only;
            // disabling additionally requires User.EnableDisableAccount.All" —
            // advice that cannot help, because the request that failed was a
            // read. The operator grants directory write, watches the same
            // failure, and is left holding a broader grant for nothing. That is
            // the exact harm the privileged-target branch was written to avoid,
            // arriving through the other door.
            //
            // What a read 403 actually means: this connection's read consent is
            // demonstrably working — it is what every posture sync on it runs
            // on — so the refusal is about THIS object. Restricted-management
            // administrative units and privileged directory roles both produce
            // it. The token's roles claim is reported as a diagnostic rather
            // than as a diagnosis, because it describes the write permission and
            // the write is not what was refused.
            const hasRole = EntraIdDirectoryWriter.hasWriteRole(token.roles);
            const roleNote =
                hasRole === null
                    ? "The application's token could not be decoded, so its consented permissions are unknown."
                    : hasRole
                      ? 'The application does hold a consented write permission, for what it is worth here — ' +
                        'the request that was refused is a read.'
                      : 'The application holds no consented write permission, but granting one would not ' +
                        'change this: the request that was refused is a read.';
            return new DirectoryWriteError(
                `Entra refused to READ account ${id} with 403 ${code ?? 'Authorization_RequestDenied'}` +
                    `${message ? `: ${message}` : ''}. Nothing was written, and nothing was attempted. This ` +
                    `connection's read permissions are evidently in place — its scheduled directory syncs use ` +
                    `them — so a refusal on a single account points at the account: a target holding a ` +
                    `privileged directory role, or one inside a restricted-management administrative unit, ` +
                    `which hides its members from applications that are not scoped to that unit. ${roleNote} ` +
                    `Scope the application to the administrative unit, or offboard this account in the Entra ` +
                    `admin center.`,
                { definitivelyNotApplied: true },
            );
        }

        if (status === 403) {
            // The discriminator. See the module docblock: the BODY is identical
            // for a missing consent and a privileged target, and only the
            // token's roles claim separates them.
            const hasRole = EntraIdDirectoryWriter.hasWriteRole(token.roles);
            if (hasRole === false) return new EntraWritePermissionMissingError();
            if (hasRole === true) return new EntraPrivilegedTargetError(id, code);
            // Undecodable token: say what we saw and claim neither cause. Naming
            // the wrong one is worse than naming none.
            return new DirectoryWriteError(
                `Entra refused to disable account ${id} with 403 ${code ?? 'Authorization_RequestDenied'}. ` +
                    `The application's token could not be decoded, so this is either a missing consented ` +
                    `write permission (${LEAST_PRIVILEGE_WRITE_ROLE}) or a target that needs an additional ` +
                    `directory-role assignment. Check the app registration's consented permissions before ` +
                    `granting anything new.`,
                { definitivelyNotApplied: true },
            );
        }

        // 401 reaches here as a RESPONSE now that writes bypass the retrying
        // transport (which used to convert it into a thrown IntegrationAuthError
        // before the writer saw it). The allowlist below would already mark it
        // proven-unapplied, but the named error is what tells an operator this
        // is a CREDENTIAL problem — check the client secret — rather than a
        // permission or target one, and it keeps the objectId out of the
        // message that markAuthFailure would persist.
        if (status === 401) {
            return new EntraCredentialRejectedError(id, message ?? code ?? 'unauthorized');
        }

        if (status === 404) {
            return new DirectoryWriteError(
                `Entra reports account ${id} does not exist, so there was nothing to disable.`,
                { definitivelyNotApplied: true },
            );
        }

        // 400 lands here rather than reading as success. It is in none of
        // resilientFetch's classification sets, so the Response comes back
        // intact — a writer that skips `res.ok` reads a request Graph rejected
        // outright as a completed disable. The usual cause is a missing
        // Content-Type on the PATCH.
        //
        // ═══ THE DEFAULT IS `false`, AND THAT IS THE WHOLE POINT ═══
        //
        // This used to end in an unconditional `definitivelyNotApplied: true`,
        // which claimed PROOF the directory was untouched for every status it
        // had not thought about — 408 among them, which the contract names
        // explicitly as a lost response, plus 409, 423, 425 and anything Graph
        // adds later.
        //
        // The consequence is the inversion this module exists to prevent: a
        // FAILED row whose write actually landed is excluded by
        // findRestorableState (APPLIED/INDETERMINATE) AND by
        // listUnsettledWrites (PENDING/INDETERMINATE), so the captured prior
        // state is unreachable and nobody is told to look.
        //
        // So proof is now an ALLOWLIST. A status earns `true` only by proving
        // the request was evaluated and rejected before anything was mutated;
        // everything else — known-ambiguous or simply unrecognised — is
        // indeterminate, which is the honest answer and the recoverable one.
        return new DirectoryWriteError(
            `Entra refused the ${phase} for account ${id} (HTTP ${status}` +
                `${code ? `, ${code}` : ''}): ${message ?? 'no error detail'}`,
            { definitivelyNotApplied: PROVEN_UNAPPLIED_STATUS.has(status) },
        );
    }

    /**
     * A THROWN transport failure — go and look before reporting it.
     *
     * This is the inversion the journal exists to prevent. A 503/504/timeout
     * that exhausts the attempt budget surfaces as `IntegrationRateLimitedError`
     * or `IntegrationTimeoutError`, but the write MAY ALREADY HAVE LANDED. If
     * that were reported as a refusal, `disableAccount` would settle the row
     * FAILED, `findRestorableState` (which reads APPLIED / INDETERMINATE) would
     * never see it, and the captured prior state — the only surviving copy of
     * what the write destroyed — would be unreachable while `listUnsettledWrites`
     * also skipped it. Strictly worse than the PENDING case the journal was
     * designed around.
     *
     * Returns (rather than throws) when the confirming read shows the desired end
     * state, so `disable` resolves and the usecase records APPLIED.
     */
    private async settleLostResponse(err: unknown, id: string): Promise<void> {
        if (err instanceof IntegrationAuthError) {
            // 401 after a refresh. 403 never reaches here — it is cloaked into a
            // response and handled by classifyGraphFailure. Evaluated and
            // rejected, so nothing was mutated.
            throw new EntraCredentialRejectedError(id, err);
        }

        const detail = err instanceof Error ? err.message : String(err);
        const throttled = err instanceof IntegrationRateLimitedError;

        const observed = await this.readEnabledQuietly(id);
        if (observed === false) {
            logger.warn(
                'Entra disable lost its response but the account now reads disabled — treating as applied',
                {
                    component: 'integration-entra-id-writer',
                    externalUserId: id,
                    error: detail,
                },
            );
            return;
        }

        // Everything below leaves `definitivelyNotApplied` at its default of
        // FALSE, INCLUDING the case where the confirming read said the account
        // is still ENABLED. That read is strong evidence and not proof: Graph is
        // eventually consistent, and the contract asks a writer to opt IN to
        // claiming the directory is unchanged. An untrue `true` hides the write
        // from the restore path and the operator sweep at the same time, so the
        // asymmetry is deliberate — INDETERMINATE costs an operator a look, a
        // wrong FAILED costs them the account.
        const suffix =
            observed === true
                ? ' A confirming read reports the account still ENABLED, which suggests the write did not ' +
                  'land — but a read-back is not the provider rejecting the request, so this stays ' +
                  'unconfirmed.'
                : ' The confirming read also failed, so the outcome is genuinely unknown.';

        throw new DirectoryWriteError(
            `The disable of account ${id} did not report back` +
                `${throttled ? ' (throttled beyond the absorb budget)' : ''}: ${detail}. The directory may ` +
                `or may not have changed.${suffix}`,
        );
    }

    /** `accountEnabled` right now, or null if we could not find out. Never throws. */
    private async readEnabledQuietly(id: string): Promise<boolean | null> {
        try {
            const token = await this.token();
            const res = await this.get(this.userUrl(id, 'id,accountEnabled'), token.token, id);
            if (!res.ok) return null;
            const user = (await res.json()) as GraphWriteUser;
            return typeof user.accountEnabled === 'boolean' ? user.accountEnabled : null;
        } catch {
            return null;
        }
    }

    // ─────────────────────────── transport ───────────────────────────

    private userUrl(id: string, select?: string): string {
        // `encodeURIComponent` on the SEGMENT. The value comes from
        // `ConnectedIdentityAccount.externalUserId` and is spliced into a
        // request path: a `#EXT#` guest UPN would truncate the path at the `#`
        // (the rest becomes a fragment and is never sent), and a value
        // containing `../` would re-target a PATCH aimed at /users onto a
        // different Graph collection. `assertEntraObjectId` makes both
        // impossible; this is the second layer, because that assertion is one
        // edit away from being relaxed.
        const base = `${GRAPH_BASE}/users/${encodeURIComponent(id)}`;
        return select ? `${base}?$select=${select}` : base;
    }

    /**
     * A single-dispatch transport for writes.
     *
     * Deliberately NOT `doFetch`: that one retries, and a retried write cannot
     * report honestly which attempt landed. Reads may retry freely — a repeated
     * GET says nothing new — so `get` keeps using `doFetch`.
     */
    private singleAttemptFetch(url: string, init: RequestInit): Promise<Response> {
        return this.writeFetch(url, init);
    }

    /**
     * Every Graph GET this writer makes, and the only place an
     * `IntegrationAuthError` can escape from.
     *
     * `doFetch` is the resilient transport, which throws that class on a 401
     * (403 and 404 are cloaked away before the classifier sees them). Two things
     * make letting it out of this object unacceptable, and they compound:
     *
     *   • `markAuthFailure` no-ops on anything that is not an
     *     `IntegrationAuthError`, so the CLASS is the trigger. A caller that
     *     catches whatever a leaver pass threw and hands it to `markAuthFailure`
     *     — the shape every other sync in this codebase already has — marks the
     *     connection credential-revoked from the offboarding path.
     *
     *   • Its message is `Integration auth failed (401):
     *     https://graph.microsoft.com/v1.0/users/<objectId>`, and
     *     `markAuthFailure` persists that verbatim into
     *     `IntegrationConnection.authFailureReason` — a column left out of the
     *     field-encryption manifest on the recorded grounds that integration URLs
     *     are system-generated and hold no identifiers. This path is the first
     *     one where that premise is false.
     *
     * So a 401 becomes `EntraCredentialRejectedError` (a `DirectoryWriteError`,
     * which is what `provenNotApplied` reads, and 401 genuinely proves the
     * request was refused at the edge without being processed). The retained
     * `cause` is REBUILT with the object id replaced rather than kept verbatim:
     * the docblock deliberately leaves unwrapping-and-marking as a decision for a
     * future call site, and a seam that is only safe if nobody uses it is not a
     * seam.
     *
     * Any other status wearing that class — none today, since 403 is cloaked, but
     * `AUTH_STATUS` is one edit from growing — is wrapped without being diagnosed
     * as a credential problem, and inherits `definitivelyNotApplied` from the
     * same allowlist every other response is judged by.
     */
    private async get(url: string, token: string, id: string): Promise<Response> {
        try {
            return await this.doFetch(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
        } catch (err) {
            if (!(err instanceof IntegrationAuthError)) throw err;
            const scrubbed = new IntegrationAuthError(err.status, scrubbedUrl(url), err.reason);
            if (err.status === 401) throw new EntraCredentialRejectedError(id, scrubbed);
            const wrapped = new DirectoryWriteError(
                `Entra refused a directory read for account ${id} (HTTP ${err.status}) at ${scrubbedUrl(url)}.`,
                { definitivelyNotApplied: PROVEN_UNAPPLIED_STATUS.has(err.status) },
            );
            wrapped.cause = scrubbed;
            throw wrapped;
        }
    }

    /**
     * The PATCH, dispatched ONCE.
     *
     * ═══ WHY THIS DOES NOT USE THE RETRYING TRANSPORT ═══
     *
     * `resilientFetch` retries 502/503/504 in-process, and only the FINAL
     * attempt's outcome is classified. So a 502 on attempt one followed by a
     * 401 on attempt two — a gateway hiccup mid-batch, then an expired
     * hour-long Graph token — was reported as a proven refusal, when the 502
     * attempt may well have applied the change. The earlier, ambiguous attempt
     * left no trace for the classifier to see.
     *
     * Retrying is safe for the DIRECTORY: `{"accountEnabled": false}` is an
     * absolute set, not a delta, so applying it twice is applying it once. The
     * unsafe part was never the repetition — it was REPORTING, because a
     * retried write cannot honestly say which attempt landed.
     *
     * One dispatch means the response we classify is the only response there
     * was. Retrying is still available, one layer up, where it belongs: a
     * re-run of the leaver pass reads the account first, sees it disabled, and
     * reconciles the outstanding journal row.
     */
    private patch(url: string, token: string, body: string): Promise<Response> {
        return this.singleAttemptFetch(url, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                // Mandatory. The read paths build `{ Authorization, Accept }`
                // and reusing that object here gets the request rejected 400 by
                // Graph — which, without the `res.ok` check in `disable`, would
                // be a malformed request that changed nothing reading as a
                // successful disable.
                'Content-Type': 'application/json',
            },
            body,
        });
    }
}

/**
 * Build the Entra writer from a connection.
 *
 * Takes the MERGED `{...configJson, ...decryptedSecrets}` shape that
 * `identity-sync` already assembles, because `clientSecret` lives in
 * `secretEncrypted` rather than `configJson` and a factory handed only the
 * config would build an object that fails once per account with nothing
 * surfaced on the connection.
 */
export function createEntraIdWriter(
    config: EntraWriterConfig,
    deps: EntraWriterDeps = {},
): EntraIdDirectoryWriter {
    return new EntraIdDirectoryWriter(config, deps);
}
