/**
 * Credential classification for the CLI-backed cloud-posture collectors.
 *
 * ## The gap this closes
 *
 * `markAuthFailure` marks a connection credential-revoked for an
 * `IntegrationAuthError` and for nothing else, and both posture collectors
 * call it from the `catch` around `provider.runCheck`
 * (`usecases/aws-posture.ts`, `usecases/cloud-posture.ts`). Neither posture
 * provider ever threw: `AwsPostureProvider.runCheck` and
 * `runPowerpipeBenchmark` both CATCH a non-zero Powerpipe exit and RETURN
 * `{ status: 'ERROR', errorMessage: 'collector error; stderr: …' }`. So the
 * catch never ran, and even if it had, a generic `Error` is a no-op for
 * `markAuthFailure`. Two independent gaps, one effect: the "credential
 * revoked" banner was unreachable from both posture collectors, and a revoked
 * AWS key or an expired Azure client secret presented as a healthy connection
 * for as long as nobody opened the execution ledger.
 *
 * A non-zero exit is precisely how a dead credential presents here — the
 * fail-closed note this module sits behind says so in as many words
 * ("a revoked credential (non-zero exit, empty stdout)",
 * `cloud-posture/powerpipe-core.ts`). What was missing is the ability to tell
 * that case apart from every other reason the CLI exits non-zero.
 *
 * ## Why an allowlist, and why it is this short
 *
 * The two failure directions are NOT symmetric.
 *
 *   - A MISSED auth failure is exactly today's behaviour: a silently stale
 *     connection. Bad, bounded, already the status quo.
 *   - A FALSE auth failure tells a customer that a WORKING credential has been
 *     revoked. It is user-visible, it sends somebody to rotate a key that was
 *     fine, and it is the failure mode that teaches operators to ignore the
 *     one banner that means somebody must act.
 *
 * So this defaults to NOT flagging. It recognises ONLY codes that mean the
 * request was never AUTHENTICATED — the credential is absent, malformed,
 * expired or unknown to the provider. Nothing else is a verdict.
 *
 * ## What is deliberately NOT here
 *
 *   - AUTHORIZATION codes — `AccessDenied`, `AccessDeniedException`,
 *     `UnauthorizedOperation`, `PERMISSION_DENIED`. These say the identity
 *     authenticated fine and lacks one permission. A read-only posture role
 *     missing one `Describe*` out of the hundreds a benchmark touches emits
 *     them while the credential is perfectly good, so marking on them would
 *     manufacture the false alarm above out of a routine IAM gap.
 *   - CLOCK / ENVIRONMENT codes — `RequestExpired`, `RequestTimeTooSkewed`.
 *     Those accuse the collector host's clock, not the customer's credential.
 *   - TRANSIENT codes — `ThrottlingException`, `RequestLimitExceeded`, and
 *     every transport failure (`ETIMEDOUT`, `ECONNRESET`, a missing CLI). A
 *     network blip must stay retryable.
 *
 * ## Provenance of the allowlist
 *
 * There is no captured-stderr fixture anywhere in this repo, so these are the
 * providers' own documented, long-stable API error codes rather than strings
 * observed in our logs — each one is the code a cloud returns when it refuses
 * to authenticate a request at all. That is stated plainly because the cost of
 * being wrong is asymmetric: an entry that never fires costs nothing, and one
 * that fires wrongly costs a customer a false revocation. When a real stderr
 * sample arrives, add to this list rather than loosening the matcher.
 *
 * Matching is CASE-SENSITIVE and word-bounded on purpose. The codes are exact
 * mixed-case identifiers, and Powerpipe control ids and titles are lowercase
 * or snake_case — so a benchmark control about "authentication failures"
 * cannot be mistaken for EC2's `AuthFailure`.
 *
 * @see src/app-layer/integrations/oauth-token-fetch.ts — the same shape for
 *      OAuth2 token endpoints, and the source of the three RFC 6749 codes.
 * @see tests/unit/posture-credential-classification.test.ts
 */
import { IntegrationAuthError } from './http-resilience';

/**
 * Codes that mean THE CREDENTIAL ITSELF WAS REJECTED, in match order.
 *
 * Grouped by the cloud that emits them; the list is searched as one because a
 * code from one cloud cannot appear in another cloud's collector output.
 */
export const POSTURE_CREDENTIAL_ERROR_CODES: readonly string[] = Object.freeze([
    // ── AWS ────────────────────────────────────────────────────────────
    /** STS/query-protocol: the temporary session token has expired. */
    'ExpiredToken',
    /** JSON-protocol flavour of the same expiry. */
    'ExpiredTokenException',
    /** STS: the access key id in the request is not a valid key. */
    'InvalidClientTokenId',
    /** JSON-protocol flavour: "the security token included is invalid". */
    'UnrecognizedClientException',
    /** S3/EC2: the access key id does not exist in AWS's records. */
    'InvalidAccessKeyId',
    /** The secret access key does not match — the request could not be signed. */
    'SignatureDoesNotMatch',
    /** EC2: "AWS was not able to validate the provided access credentials." */
    'AuthFailure',

    // ── Azure ──────────────────────────────────────────────────────────
    /** Entra ID: invalid client secret provided for the service principal. */
    'AADSTS7000215',
    /** Entra ID: the service principal's client secret keys have expired. */
    'AADSTS7000222',
    /** ARM / Graph 401: the bearer token is not a valid token. */
    'InvalidAuthenticationToken',
    /** ARM / Graph 401: the bearer token has expired. */
    'ExpiredAuthenticationToken',

    // ── GCP ────────────────────────────────────────────────────────────
    /** Google API status for a request that was not authenticated at all. */
    'UNAUTHENTICATED',

    // ── RFC 6749 §5.2, any cloud whose plugin reports the OAuth2 code ──
    // The same three `oauth-token-fetch.ts` treats as credential failures,
    // and for the same reason. `invalid_request` / `invalid_scope` /
    // `unsupported_grant_type` stay out there and stay out here: they blame
    // our own request, not the customer's credential.
    'invalid_grant',
    'invalid_client',
    'unauthorized_client',
]);

/**
 * The credential-rejection code in this collector output, or `null`.
 *
 * `null` means "we could not tell", NEVER "the credential is fine" — the
 * caller must keep treating an unclassified failure exactly as it did before.
 * Never throws: an unreadable stderr must not become a verdict.
 */
export function postureCredentialErrorCode(stderr: string | null | undefined): string | null {
    if (!stderr) return null;
    for (const code of POSTURE_CREDENTIAL_ERROR_CODES) {
        // Word-bounded so `ExpiredToken` does not match inside
        // `ExpiredTokenException` (which is listed on its own terms), and
        // case-sensitive so lowercase benchmark prose cannot match a code.
        if (new RegExp(`\\b${code}\\b`).test(stderr)) return code;
    }
    return null;
}

/**
 * Turn a credential rejection in collector output into the one error class the
 * connection-health writer acts on. A no-op for everything else.
 *
 * Throwing (rather than returning a richer result) is what makes the fix
 * whole: the collectors' existing `catch` already persists the ERROR execution
 * row, calls `markAuthFailure`, and derives `noRetry` from
 * `shouldBypassQueueRetry` — which is true for `IntegrationAuthError`, so a
 * revoked credential also stops being re-run three times inside 35 seconds.
 */
export function throwIfPostureCredentialFailure(
    stderr: string | null | undefined,
    benchmarkId: string,
): void {
    const code = postureCredentialErrorCode(stderr);
    if (code === null) return;

    // `code` comes from POSTURE_CREDENTIAL_ERROR_CODES, never from the stderr
    // verbatim. `IntegrationAuthError`'s message is persisted into
    // `IntegrationConnection.authFailureReason`, a column exempt from field
    // encryption, and a Powerpipe stderr can carry a role ARN, a
    // service-account email or a subscription GUID. The benchmark id is the
    // only other thing interpolated, and every caller resolves it from a fixed
    // per-cloud table; it is length-capped anyway, since this column is UI copy.
    //
    // 403 is SYNTHESISED, not observed: there is no HTTP response here. It is
    // the status AWS answers these codes with, and `markAuthFailure` keys on
    // the CLASS rather than the number, so it carries no other weight.
    throw new IntegrationAuthError(403, `powerpipe benchmark run ${benchmarkId.slice(0, 120)}`, code);
}
