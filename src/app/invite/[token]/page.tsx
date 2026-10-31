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
import { buttonVariants } from '@/components/ui/button-variants';
import { AppIcon } from '@/components/icons/AppIcon';
import { InviteAcceptButton } from './InviteAcceptButton';

interface InvitePageProps {
    params: Promise<{ token: string }>;
}

// The page renders nothing from the query string (#4689). It used to print
// `?error=` verbatim, so any link to a live invite could put a sentence of
// the link-maker's choosing beside the workspace's name; the only writer of
// that parameter was a GET route that redeemed the invite on a plain visit,
// and it is gone. A refusal is now shown by the Accept button, from the
// redemption's named reason, and by /invite/result after sign-in.
export default async function InvitePage({ params }: InvitePageProps) {
    const { token } = await params;
    const session = await auth();
    const sessionEmail = session?.user?.email ?? null;

    const preview = await previewInviteByToken(token, sessionEmail);

    const t = await getTranslations('invite');
    const tRoles = await getTranslations('roles');

    if (!preview) {
        return (
            <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
                <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8 text-center">
                    <AppIcon name="warning" size={40} className="mx-auto mb-4 text-content-warning" aria-hidden="true" />
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
    // `InviteAcceptButton` POSTs to /api/invites/:token (which calls
    // redeemInvite and returns JSON), re-mints the session's membership
    // claims, then navigates into the workspace.
    const isReady = session && preview.matchesSession;

    // start-signin sets the inflect_invite_token cookie then redirects to /login.
    // After sign-in the signIn callback reads the cookie and calls redeemInvite,
    // and the person lands on /invite/result, which says what became of it.
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

                {isReady ? (
                    <InviteAcceptButton token={token} />
                ) : (
                    <a
                        href={loginUrl}
                        id="invite-sign-in-link"
                        className={buttonVariants({ variant: 'primary', className: 'w-full' })}
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
