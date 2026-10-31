/**
 * POST /api/auth/reset-password   body: { token, newPassword }
 *
 * Step 2 of the password-reset flow. Validates the new password
 * (length policy + HIBP breach screening — Epic A.3 / E.4), then
 * consumes the one-time token and swaps the stored hash. Consuming the
 * token revokes every session for the account.
 *
 * Token errors (`invalid` / `expired`) are surfaced to the user — a
 * "your link expired, request a new one" message is genuinely useful
 * and is not an enumeration vector (256-bit tokens are unguessable).
 *
 * Rate-limited by LOGIN_LIMIT (10 per 15 min, 15-min lockout) — the
 * preset's JSDoc explicitly names password reset as an intended use.
 */
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import {
    validatePasswordPolicy,
    describePasswordPolicyFailure,
} from '@/lib/auth/passwords';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { consumePasswordReset } from '@/lib/auth/password-management';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import type { ResetPasswordRefusal } from '@/lib/auth/reset-password-refusals';

const POLICY_REFUSAL = {
    empty: 'PASSWORD_EMPTY',
    too_short: 'PASSWORD_TOO_SHORT',
    too_long: 'PASSWORD_TOO_LONG',
} as const satisfies Record<string, ResetPasswordRefusal>;

/** Every refusal carries its code beside the English sentence (#4688). */
function refuse(code: ResetPasswordRefusal, error: string) {
    return jsonResponse({ error, code }, { status: 400 });
}

const ResetPasswordSchema = z
    .object({
        token: z.string().min(1),
        newPassword: z.string().min(1),
    })
    .strip();

export const POST = withApiErrorHandling(
    withValidatedBody(ResetPasswordSchema, async (_req, _ctx, body) => {
        // ── New-password policy (length floor/ceiling) ──
        const policy = validatePasswordPolicy(body.newPassword);
        if (!policy.ok) {
            return refuse(POLICY_REFUSAL[policy.reason], describePasswordPolicyFailure(policy.reason));
        }

        // ── Breached-password screening. Fails open on a HIBP outage
        //    (the helper returns breached:false) so an outage cannot
        //    brick the reset flow. Never logs the password or its hash.
        const hibp = await checkPasswordAgainstHIBP(body.newPassword);
        if (hibp.breached) {
            return refuse(
                'PASSWORD_BREACHED',
                'This password appears in known data breaches. Please choose a different password.',
            );
        }

        // ── Consume the token + swap the hash ──
        const result = await consumePasswordReset(body.token, body.newPassword);
        if (!result.ok) {
            return result.reason === 'expired'
                ? refuse('RESET_LINK_EXPIRED', 'This password reset link has expired. Please request a new one.')
                : refuse('RESET_LINK_INVALID', 'This password reset link is invalid or has already been used.');
        }

        return jsonResponse({ ok: true });
    }),
    { rateLimit: { config: LOGIN_LIMIT, scope: 'password-reset-confirm' } },
);
