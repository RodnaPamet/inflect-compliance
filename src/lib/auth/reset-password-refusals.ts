/**
 * Why `POST /api/auth/reset-password` refused, as a code the reset page
 * translates (#4688).
 *
 * The route's sentences were English and the page showed them verbatim, so a
 * person using the Bulgarian UI read every refusal in English. The route now
 * sends one of these codes beside its sentence (the sentence stays for API
 * callers), and the page labels the code from its own catalogue, as the
 * change-password form does (#4645).
 *
 * Client-safe on purpose: no server import, so the page can hold the list.
 */
export const RESET_PASSWORD_REFUSALS = [
    'PASSWORD_EMPTY',
    'PASSWORD_TOO_SHORT',
    'PASSWORD_TOO_LONG',
    'PASSWORD_BREACHED',
    'RESET_LINK_EXPIRED',
    'RESET_LINK_INVALID',
] as const;

export type ResetPasswordRefusal = (typeof RESET_PASSWORD_REFUSALS)[number];

export function isResetPasswordRefusal(value: unknown): value is ResetPasswordRefusal {
    return typeof value === 'string' && (RESET_PASSWORD_REFUSALS as readonly string[]).includes(value);
}
