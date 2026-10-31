/**
 * Why `POST /api/auth/register` refused, as a code the sign-in page
 * translates (#4686).
 *
 * The route's sentences were English and the page showed them verbatim, so a
 * person using the Bulgarian UI read every refusal in English. The route now
 * sends one of these codes beside its sentence (the sentence stays for API
 * callers), as change-password (#4645) and reset-password (#4688) do.
 *
 * Client-safe on purpose: no server import, so the page can hold the list.
 */
export const REGISTER_REFUSALS = [
    'REGISTER_FIELDS_MISSING',
    'PASSWORD_EMPTY',
    'PASSWORD_TOO_SHORT',
    'PASSWORD_TOO_LONG',
    'PASSWORD_BREACHED',
    'EMAIL_ALREADY_REGISTERED',
    /** No workspace name, and no invitation to register for instead. */
    'WORKSPACE_NAME_REQUIRED',
    /** An account-only registration whose invitation is spent, revoked or expired. */
    'INVITE_UNAVAILABLE',
    /** An account-only registration with an email the invitation was not sent to. */
    'INVITE_EMAIL_MISMATCH',
] as const;

export type RegisterRefusal = (typeof REGISTER_REFUSALS)[number];

export function isRegisterRefusal(value: unknown): value is RegisterRefusal {
    return typeof value === 'string' && (REGISTER_REFUSALS as readonly string[]).includes(value);
}

/**
 * The error a password sign-in returns for an account whose email is not
 * verified yet, when the deployment requires verification (#4686). Every
 * other credentials failure stays the generic `CredentialsSignin`. This one
 * is reported only after the password was checked, so it tells nothing to
 * somebody who does not know the password.
 */
export const EMAIL_NOT_VERIFIED_SIGN_IN_ERROR = 'email_not_verified';
