/**
 * Epic D — /invite/org/[token]
 *
 * Org-invite acceptance page. Mirrors /invite/[token] for tenant
 * invites:
 *   - Server-rendered preview via previewOrgInviteByToken.
 *   - If valid + signed in as matching email: `OrgInviteAcceptButton`, which
 *     redeems, re-mints the session's claims and goes into the organization.
 *   - If valid + not signed in: "Sign in to accept" link → start-signin.
 *   - If valid + signed in as a different email: "Sign out and use another
 *     account". Signing in again would redeem the invitation in the sign-in
 *     callback and use it up on the email check (#4853).
 *   - If invalid/expired/revoked: friendly single-shape error.
 *
 * The page renders nothing from the query string (#4853). It used to print
 * `?error=` verbatim, so any link to a live invitation could put a sentence of
 * the link-maker's choosing beside the organization's name. The only writer of
 * that parameter was the `accept-redirect` route, and it is gone; a refusal is
 * now shown by the Accept button, from the reason the redemption names.
 */
import { auth } from '@/auth';
import { getTranslations } from 'next-intl/server';
import { previewOrgInviteByToken } from '@/app-layer/usecases/org-invites';
import { formatDateLong } from '@inflect/ui/lib/format-date';
import { Heading } from '@/components/ui/typography';
import { buttonVariants } from '@/components/ui/button-variants';
import { AppIcon } from '@/components/icons/AppIcon';
import { InviteSwitchAccountButton } from '../../_components/InviteSwitchAccountButton';
import { OrgInviteAcceptButton } from './OrgInviteAcceptButton';

interface InvitePageProps {
    params: Promise<{ token: string }>;
}

export default async function OrgInvitePage({ params }: InvitePageProps) {
    const { token } = await params;
    const session = await auth();
    const sessionEmail = session?.user?.email ?? null;

    const preview = await previewOrgInviteByToken(token, sessionEmail);

    const t = await getTranslations('invite');
    const tOrgRoles = await getTranslations('orgRoles');

    if (!preview) {
        return (
            <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
                <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8 text-center">
                    <AppIcon name="warning" size={40} className="mx-auto mb-4 text-content-warning" />
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

    const roleLabel = tOrgRoles.has(preview.role)
        ? tOrgRoles(preview.role)
        : preview.role;
    const expiryLabel = formatDateLong(preview.expiresAt);
    const isReady = session && preview.matchesSession;
    const isWrongAccount = session && !preview.matchesSession;
    const loginUrl = `/api/org/invite/${token}/start-signin`;

    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8">
                <Heading level={1} className="mb-2 text-center">
                    {t('invitedTitle')}
                </Heading>
                <p className="text-content-muted text-center mb-6">
                    {t.rich('joinOrgAs', {
                        org: preview.organizationName,
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
                    <OrgInviteAcceptButton token={token} />
                ) : isWrongAccount ? (
                    <InviteSwitchAccountButton
                        returnTo={`/invite/org/${encodeURIComponent(token)}`}
                        id="org-invite-switch-account"
                    />
                ) : (
                    <a
                        href={loginUrl}
                        id="org-invite-signin-cta"
                        className={buttonVariants({ variant: 'primary', className: 'w-full' })}
                    >
                        {t('signInToAccept')}
                    </a>
                )}

                {isWrongAccount && (
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

