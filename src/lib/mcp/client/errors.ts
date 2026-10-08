/**
 * The client's typed failures.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SIX TYPES AND NOT ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One error shape for every cause means the operator's log names nothing, and the
 * person reading it has to go to the rows to find out what happened. These six
 * separate the outcomes an operator would act on DIFFERENTLY:
 *
 * | Error | What the operator does |
 * | --- | --- |
 * | {@link ContractViolationError} | tell the server's owner; their server is wrong |
 * | {@link TornSnapshotError} | retry; the export moved under us |
 * | {@link CapExceededError} | raise a cap, or ask for a narrower projection |
 * | {@link SsrfBlockedError} | fix the configured URL; it resolves somewhere private |
 * | {@link AuthenticationFailedError} | rotate or re-enter the token |
 * | {@link TimeoutError} | raise the deadline, or the server is unwell |
 *
 * Collapsing those into "pull failed" is how a misconfigured URL and a wrong
 * password become the same support ticket.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE MAY CARRY THE TOKEN, OR A ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every field on these errors is a count, an identifier, a URI or a short reason.
 * Not a header, not a body, not a cell. Two reasons, and the second is the one
 * that bites:
 *
 *   1. The bearer token is a credential, and an error object reaches a log line,
 *      an audit row and sometimes a support attachment.
 *   2. The body is ATTACKER-SHAPED. It came from a server an operator we do not
 *      employ is running, through an export somebody could have typed into. An
 *      error message that quotes it has moved untrusted content into
 *      `AuditLog.detailsJson`, which is plaintext, hash-chained and never deleted.
 *
 * `tests/unit/legacy-mcp-client.test.ts` serialises every thrown error and
 * searches for the token to prove the first. The absence of body-quoting is
 * structural: none of these constructors accepts one.
 *
 * @module lib/mcp/client/errors
 */

/** The common base, so a caller can catch the family and still switch on `kind`. */
export abstract class LegacyMcpClientError extends Error {
    abstract readonly kind:
        | 'contract-violation'
        | 'torn-snapshot'
        | 'cap-exceeded'
        | 'ssrf-blocked'
        | 'authentication-failed'
        | 'timeout';

    protected constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * The server is not speaking `inflect-legacy-access/1`.
 *
 * `where` is a short, fixed phrase chosen from the code — never interpolated from
 * the response — so the message cannot become a channel for the body.
 */
export class ContractViolationError extends LegacyMcpClientError {
    readonly kind = 'contract-violation' as const;
    constructor(
        readonly where: string,
        readonly detail?: string
    ) {
        super(`contract violation at ${where}${detail ? `: ${detail}` : ''}`);
    }
}

/**
 * A page's `snapshotId` disagreed with the manifest's.
 *
 * The export moved while we were reading it, so the rows we have are from two
 * different states of the system. Both ids are opaque, bounded identifiers the
 * contract already length-limits, which is why they are safe to name.
 */
export class TornSnapshotError extends LegacyMcpClientError {
    readonly kind = 'torn-snapshot' as const;
    constructor(
        readonly expected: string,
        readonly found: string,
        readonly page: number
    ) {
        super(`torn snapshot at page ${page}: expected ${expected}, found ${found}`);
    }
}

/**
 * A declared bound was reached.
 *
 * `limit` and `observed` are numbers. For the byte cap `observed` is the cap
 * itself rather than the true size, because the whole point is that we stopped
 * reading — knowing the real size would mean having read it.
 */
export class CapExceededError extends LegacyMcpClientError {
    readonly kind = 'cap-exceeded' as const;
    constructor(
        readonly cap: 'bytes' | 'rows-per-page' | 'pages' | 'total-rows' | 'columns',
        readonly limit: number,
        readonly observed: number
    ) {
        super(`cap exceeded: ${cap} limit ${limit}, observed ${observed}`);
    }
}

/**
 * `safeFetch` refused the address or a redirect.
 *
 * Wrapped rather than rethrown so the caller gets one family to catch, and so the
 * underlying message — which may name a private address — is reduced to a reason
 * the client chose.
 */
export class SsrfBlockedError extends LegacyMcpClientError {
    readonly kind = 'ssrf-blocked' as const;
    constructor(readonly reason: string) {
        super(`egress refused: ${reason}`);
    }
}

/** 401 or 403. The token is wrong, expired, or lacks the resource. */
export class AuthenticationFailedError extends LegacyMcpClientError {
    readonly kind = 'authentication-failed' as const;
    constructor(readonly status: 401 | 403) {
        super(`authentication failed: HTTP ${status}`);
    }
}

/** The per-request deadline elapsed, or the whole-pull deadline did. */
export class TimeoutError extends LegacyMcpClientError {
    readonly kind = 'timeout' as const;
    constructor(
        readonly scope: 'request' | 'pull',
        readonly budgetMs: number
    ) {
        super(`${scope} deadline of ${budgetMs}ms elapsed`);
    }
}

/**
 * Map an unknown throw from the egress layer onto our own types.
 *
 * `safeFetch` throws its own errors (`RedirectNotAllowedError`, the private-address
 * refusals). They are matched on NAME rather than by importing the classes,
 * because importing them would couple this module to the automation layer's error
 * taxonomy for no benefit — and a renamed class there should not silently become
 * an un-mapped generic failure here. The default arm is `SsrfBlockedError` rather
 * than a rethrow, so an unrecognised egress failure still fails CLOSED with a
 * reason rather than escaping as an untyped error.
 */
export function mapEgressError(e: unknown): LegacyMcpClientError {
    if (e instanceof LegacyMcpClientError) return e;
    const name = e instanceof Error ? e.name : '';
    const msg = e instanceof Error ? e.message : String(e);

    if (name === 'AbortError') return new TimeoutError('request', 0);
    if (/redirect/i.test(name) || /redirect/i.test(msg)) {
        return new SsrfBlockedError('redirect refused');
    }
    if (/private|loopback|link-local|metadata|not a public|blocked/i.test(msg)) {
        return new SsrfBlockedError('address is not public');
    }
    if (/^https?:/i.test(msg) === false && /scheme|protocol/i.test(msg)) {
        return new SsrfBlockedError('scheme not allowed');
    }
    // Unrecognised. Still a refusal, still typed, and the reason says so rather
    // than echoing a message that may carry the target.
    return new SsrfBlockedError('egress failed');
}
