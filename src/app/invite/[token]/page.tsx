/**
 * /invite/[token] — Invite preview page.
 *
 * Server component. Calls previewInviteByToken, then renders:
 *   - If valid + signed in as matching email: direct "Accept" button.
 *   - If valid + not matching / not signed in: "Sign in to accept" link.
 *   - If expired/revoked/not-found: friendly error message.
 *
 * PR 4 will wire middleware redirects that land users here after sign-in
 * when their JWT carry an invite token. This page is the canonical place
 * for invite UX — do not inline invite acceptance anywhere else.
 */
import { auth } from '@/auth';
import { getTranslations } from 'next-intl/server';
import { previewInviteByToken } from '@/app-layer/usecases/tenant-invites';
import { formatDateLong } from '@inflect/ui/lib/format-date';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

interface InvitePageProps {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ error?: string }>;
}

export default async function InvitePage({ params, searchParams }: InvitePageProps) {
    const { token } = await params;
    const { error: errorParam } = await searchParams;
    const session = await auth();
    const sessionEmail = session?.user?.email ?? null;

    const preview = await previewInviteByToken(token, sessionEmail);

    const t = await getTranslations('invite');
    const tRoles = await getTranslations('roles');

    if (!preview) {
        return (
            <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
                <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8 text-center">
                    <div className="text-4xl mb-4">&#x26A0;&#xFE0F;</div>
                    <Heading level={1} className="mb-2">
                        {t('notAvailableTitle')}
                    </Heading>
                    <p className="text-content-muted">
                        {t('notAvailableBody')}
                    </p>
                </div>
            </main>
        );
    }

    const roleLabel = tRoles.has(preview.role)
        ? tRoles(preview.role)
        : preview.role.charAt(0) + preview.role.slice(1).toLowerCase();
    const expiryLabel = formatDateLong(preview.expiresAt);

    // If the user is signed in as the invitee, show the direct accept button.
    // The POST goes to /api/invites/:token which calls redeemInvite and
    // returns JSON; a thin client form handles the redirect.
    const isReady = session && preview.matchesSession;

    // start-signin sets the inflect_invite_token cookie then redirects to /login.
    // After OAuth the signIn callback reads the cookie and calls redeemInvite.
    const loginUrl = `/api/invites/${token}/start-signin`;

    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8">
                <Heading level={1} className="mb-2 text-center">
                    {t('invitedTitle')}
                </Heading>
                <p className="text-content-muted text-center mb-6">
                    {t.rich('joinAs', {
                        tenant: preview.tenantName,
                        role: roleLabel,
                        b: (chunks) => (
                            <span className="font-semibold text-content-default">
                                {chunks}
                            </span>
                        ),
                    })}
                </p>
                <p className="text-xs text-content-muted text-center mb-6">
                    {t('expires', { date: expiryLabel })}
                </p>

                {errorParam && (
                    <InlineNotice
                        variant="error"
                        icon={null}
                        className="mb-4 text-center"
                    >
                        {errorParam}
                    </InlineNotice>
                )}

                {isReady ? (
                    <InviteAcceptForm token={token} label={t('acceptInvitation')} />
                ) : (
                    <a
                        href={loginUrl}
                        className="block w-full text-center rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                    >
                        {t('signInToAccept')}
                    </a>
                )}

                {session && !preview.matchesSession && (
                    <p className="mt-4 text-xs text-content-muted text-center">
                        {t.rich('wrongAccount', {
                            email: session.user?.email ?? '',
                            b: (chunks) => (
                                <span className="font-medium">{chunks}</span>
                            ),
                        })}
                    </p>
                )}
            </div>
        </main>
    );
}

/**
 * Thin client component that POSTs to the redeem endpoint and redirects.
 * Kept minimal — no heavy UI library imports needed.
 */
function InviteAcceptForm({ token, label }: { token: string; label: string }) {
    return (
        <form
            action={`/api/invites/${token}`}
            method="POST"
            onSubmit={undefined}
        >
            <button
                type="submit"
                className="w-full rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
            >
                {label}
            </button>
        </form>
    );
}
