'use client';

/**
 * The "Accept invitation" control on /invite/org/[token], shown to a signed-in
 * invitee whose email matches the invitation (#4853).
 *
 * It used to be a `<form method="POST">` to `accept-redirect`, which redeemed
 * the invitation and answered a 303 to `/org/<slug>`. Two things went wrong:
 *
 *   - The edge org-access gate authorises `/org/<slug>/**` from the JWT's
 *     `orgMemberships` claim with no DB hit, and that JWT was minted before
 *     this membership existed, so the new member landed on "Page not found"
 *     until the claims next refreshed.
 *   - A refusal came back as `?error=<English message>` on the invite page,
 *     which printed whatever the address said.
 *
 * So, as the workspace invitation does (`InviteAcceptButton`):
 *
 *   1. POST /api/org/invite/<token>  — redeem; answers `{ slug }`.
 *   2. `refreshSessionClaims()`      — re-mint the JWT with the new membership.
 *   3. navigate to /org/<slug>.
 *
 * A refusal keeps the person here and says why, from the reason the
 * redemption names (`src/lib/invite-refusals.ts`), in their language. A
 * refusal that names no reason (a rate limit) falls back to the server's
 * message, as the workspace button does.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { refreshSessionClaims } from '@/lib/auth/refresh-session-claims';
import { inviteRefusal } from '@/lib/invite-refusals';

interface RedeemResponse {
    slug?: unknown;
    error?: { message?: unknown };
}

export function OrgInviteAcceptButton({ token }: { token: string }) {
    const t = useTranslations('invite');
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function accept(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/org/invite/${encodeURIComponent(token)}`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            const body = (await res.json().catch(() => null)) as RedeemResponse | null;
            if (!res.ok || typeof body?.slug !== 'string' || !body.slug) {
                const refusal = inviteRefusal(body);
                const message = body?.error?.message;
                setError(
                    refusal
                        ? t(`orgRefused.${refusal}`)
                        : typeof message === 'string' && message
                          ? message
                          : t('acceptFailed'),
                );
                setSubmitting(false);
                return;
            }
            await refreshSessionClaims();
            // `submitting` stays true: the button stays disabled until the
            // organization loads, and a second click cannot re-post a spent token.
            router.push(`/org/${encodeURIComponent(body.slug)}`);
        } catch {
            setError(t('acceptFailed'));
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={accept} className="space-y-default">
            {error && (
                <InlineNotice variant="error" icon={null} className="text-center" data-testid="org-invite-error">
                    {error}
                </InlineNotice>
            )}
            <Button
                type="submit"
                variant="primary"
                id="org-invite-accept"
                disabled={submitting}
                loading={submitting}
                className="w-full"
            >
                {t('acceptInvitation')}
            </Button>
        </form>
    );
}
