'use client';

/**
 * The "Accept invitation" control on /invite/[token], shown to a signed-in
 * invitee whose email matches the invite.
 *
 * It used to be a plain `<form action="/api/invites/<token>" method="POST">`.
 * That route answers JSON, so the browser navigated to a page of raw JSON:
 * the membership was created, and the user was left looking at `{"slug":…}`.
 *
 * Redeeming stays a POST, because accepting is a deliberate act and the
 * SameSite=Lax session cookie keeps a cross-site page from forging it. The
 * part the browser could not do on its own is what comes after. The Edge
 * tenant-access gate authorises `/t/<slug>/**` from the JWT's `memberships[]`
 * claim with no DB hit, and that JWT was minted before this membership
 * existed, so navigating straight in would bounce to /no-tenant. The steps,
 * in order:
 *
 *   1. POST /api/invites/<token>  — redeem; answers `{ slug }`.
 *   2. `refreshSessionClaims()`   — re-mint the JWT with the new membership.
 *   3. navigate to /t/<slug>/dashboard.
 *
 * A refusal (expired, revoked, already used, wrong account) keeps the user on
 * this page and shows the server's reason.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { InlineNotice } from '@/components/ui/inline-notice';
import { refreshSessionClaims } from '@/lib/auth/refresh-session-claims';

interface RedeemResponse {
    slug?: unknown;
    error?: { message?: unknown };
}

export function InviteAcceptButton({ token }: { token: string }) {
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
            const res = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            const body = (await res.json().catch(() => null)) as RedeemResponse | null;
            if (!res.ok || typeof body?.slug !== 'string' || !body.slug) {
                const reason = body?.error?.message;
                setError(typeof reason === 'string' && reason ? reason : t('acceptFailed'));
                setSubmitting(false);
                return;
            }
            await refreshSessionClaims();
            // `submitting` stays true: the button stays disabled until the
            // workspace loads, and a second click cannot re-post a spent token.
            router.push(`/t/${encodeURIComponent(body.slug)}/dashboard`);
        } catch {
            setError(t('acceptFailed'));
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={accept} className="space-y-default">
            {error && (
                <InlineNotice variant="error" icon={null} className="text-center">
                    {error}
                </InlineNotice>
            )}
            {/* The markup the page's form always had (and the org invite
                page's still has), so the control looks exactly as it did. */}
            <button
                type="submit"
                id="invite-accept-btn"
                disabled={submitting}
                aria-busy={submitting}
                className="w-full rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {t('acceptInvitation')}
            </button>
        </form>
    );
}
