/**
 * POST /api/auth/change-password   body: { currentPassword, newPassword }
 *
 * Authenticated password change. Requires a live session; verifies the
 * current password, validates the new one (length policy + HIBP breach
 * screening — Epic A.3 / E.4), swaps the stored hash, and revokes every
 * session for the account.
 *
 * That includes the caller's OWN session — so the response carries
 * `reauthRequired: true` and the UI redirects to sign-in. A password
 * change should never leave a stale session alive anywhere.
 *
 * Mutation rate limiting is the default API_MUTATION_LIMIT — the route
 * is authenticated and `currentPassword` must verify, so the abuse
 * surface is already small.
 *
 * Every refusal carries a `code` from `CHANGE_PASSWORD_REFUSALS` beside its
 * English `error`, so the account page can say it in the reader's language
 * (#4645); the sentence stays for API callers.
 */
import { z } from 'zod';

import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import {
    validatePasswordPolicy,
    describePasswordPolicyFailure,
} from '@/lib/auth/passwords';
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { changePassword } from '@/lib/auth/password-management';
import type { ChangePasswordRefusal } from '@/lib/auth/change-password-refusals';

const POLICY_REFUSAL = {
    empty: 'PASSWORD_EMPTY',
    too_short: 'PASSWORD_TOO_SHORT',
    too_long: 'PASSWORD_TOO_LONG',
} as const satisfies Record<string, ChangePasswordRefusal>;

function refuse(code: ChangePasswordRefusal, error: string) {
    return jsonResponse({ error, code }, { status: 400 });
}

const ChangePasswordSchema = z
    .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1),
    })
    .strip();

export const POST = withApiErrorHandling(
    withValidatedBody(ChangePasswordSchema, async (req, _ctx, body) => {
        const session = await auth();
        if (!session?.user) {
            return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
        }

        if (body.newPassword === body.currentPassword) {
            return refuse(
                'SAME_AS_CURRENT',
                'Your new password must be different from your current password.',
            );
        }

        // ── New-password policy (length floor/ceiling) ──
        const policy = validatePasswordPolicy(body.newPassword);
        if (!policy.ok) {
            return refuse(POLICY_REFUSAL[policy.reason], describePasswordPolicyFailure(policy.reason));
        }

        // ── Breached-password screening (fails open on a HIBP outage) ──
        const hibp = await checkPasswordAgainstHIBP(body.newPassword);
        if (hibp.breached) {
            return refuse(
                'PASSWORD_BREACHED',
                'This password appears in known data breaches. Please choose a different password.',
            );
        }

        const requestId = req.headers.get('x-request-id') ?? undefined;
        const result = await changePassword(
            session.user.id,
            body.currentPassword,
            body.newPassword,
            { requestId },
        );
        if (!result.ok) {
            return result.reason === 'no_password'
                ? refuse('NO_PASSWORD', 'This account signs in with a social provider and has no password to change.')
                : refuse('CURRENT_PASSWORD_INCORRECT', 'Your current password is incorrect.');
        }

        // Every session — including this one — is now revoked.
        return jsonResponse({ ok: true, reauthRequired: true });
    }),
);
