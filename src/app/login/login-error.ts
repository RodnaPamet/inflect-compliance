/**
 * The message the sign-in page shows for an `?error=` code.
 *
 * The codes come from the SSO callbacks (`/api/auth/sso/*`) and from NextAuth,
 * which sends its own errors to `/login` too. The page never renders the
 * code, nor the `error_description` that rides beside it: both are in a URL
 * anyone can write, and a sign-in page that prints whatever text a link
 * carries is a phishing prop. Every code reads as one of a fixed set of
 * messages instead; one nobody listed reads as the generic one.
 */
export type LoginErrorKey =
    | 'errors.signInFailed'
    | 'errors.accountNotLinked'
    | 'errors.ssoIncomplete'
    | 'errors.ssoStartFromSignIn'
    | 'errors.ssoNoAccount'
    | 'errors.ssoDomainNotAllowed'
    | 'errors.ssoUnavailable';

const SSO_NO_ACCOUNT = new Set(['no_user', 'no_membership', 'jit_disabled', 'user_not_found']);
const SSO_UNAVAILABLE = new Set(['provider_disabled', 'config_error', 'discovery_error', 'tenant_not_found']);
const SSO_INCOMPLETE = new Set([
    'sso_error',
    'missing_params',
    'invalid_state',
    'token_error',
    'nonce_mismatch',
    'id_token_invalid',
    'no_email',
    'cross_tenant',
    'subject_conflict',
    'invalid_request',
    'missing_response',
    'missing_relay',
    'invalid_relay',
    'validation_failed',
]);

export function loginErrorKey(code: string): LoginErrorKey {
    if (code === 'OAuthAccountNotLinked') return 'errors.accountNotLinked';
    if (code === 'sso_start_refused') return 'errors.ssoStartFromSignIn';
    if (code === 'domain_mismatch') return 'errors.ssoDomainNotAllowed';
    if (SSO_NO_ACCOUNT.has(code)) return 'errors.ssoNoAccount';
    if (SSO_UNAVAILABLE.has(code)) return 'errors.ssoUnavailable';
    if (SSO_INCOMPLETE.has(code)) return 'errors.ssoIncomplete';
    return 'errors.signInFailed';
}
