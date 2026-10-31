/**
 * Why `POST /api/auth/change-password` refused, as a code the account
 * security page translates (#4645).
 *
 * The route's sentences were English and the page showed them verbatim, so
 * a person using the Bulgarian UI read every refusal in English. The route
 * now sends one of these codes beside its sentence — the sentence stays for
 * API callers — and the page labels the code from its own catalogue.
 *
 * Client-safe on purpose: no server import, so the form can hold the list.
 */
export const CHANGE_PASSWORD_REFUSALS = [
    'SAME_AS_CURRENT',
    'PASSWORD_EMPTY',
    'PASSWORD_TOO_SHORT',
    'PASSWORD_TOO_LONG',
    'PASSWORD_BREACHED',
    'NO_PASSWORD',
    'CURRENT_PASSWORD_INCORRECT',
] as const;

export type ChangePasswordRefusal = (typeof CHANGE_PASSWORD_REFUSALS)[number];

export function isChangePasswordRefusal(value: unknown): value is ChangePasswordRefusal {
    return typeof value === 'string' && (CHANGE_PASSWORD_REFUSALS as readonly string[]).includes(value);
}
