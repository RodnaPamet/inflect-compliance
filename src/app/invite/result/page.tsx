/**
 * /invite/result — where "Sign in to accept" lands after sign-in (#4689).
 *
 * `/api/invites/<token>/start-signin` puts the token in the HttpOnly
 * `inflect_invite_token` cookie and sends the person to
 * `/login?callbackUrl=/invite/result`. The NextAuth signIn callback redeems
 * the cookie, but it cannot answer the person: a refusal is only logged, and
 * an email mismatch has already burnt the invite. Before this page the person
 * landed on the workspace picker or "No access yet" with no word about it.
 *
 * This page reads what became of the invite (`inviteSignInOutcome`) and:
 *   - ACCEPTED: goes straight into the workspace;
 *   - PENDING: the invite is still live, so back to its own page to accept;
 *   - REFUSED: says why, in the person's language.
 *
 * With no session it sends the person to sign in; with no cookie (expired,
 * or reached directly) to their workspaces.
 */
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { inviteSignInOutcome } from '@/app-layer/usecases/tenant-invites';
import { AppIcon } from '@/components/icons/AppIcon';
import { buttonVariants } from '@/components/ui/button-variants';
import { Heading } from '@/components/ui/typography';

export default async function InviteResultPage() {
    const session = await auth();
    const userId = session?.user?.id;
    const email = session?.user?.email;
    if (!userId || !email) redirect('/login');

    const token = (await cookies()).get('inflect_invite_token')?.value;
    if (!token) redirect('/tenants');

    const outcome = await inviteSignInOutcome({ token, userId, userEmail: email });
    if (outcome.kind === 'ACCEPTED') redirect(`/t/${encodeURIComponent(outcome.slug)}/dashboard`);
    if (outcome.kind === 'PENDING') redirect(`/invite/${encodeURIComponent(token)}`);

    const t = await getTranslations('invite');

    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div
                id="invite-result"
                className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8 text-center"
            >
                <AppIcon name="warning" size={40} className="mx-auto mb-4 text-content-warning" />
                <Heading level={1} className="mb-2">
                    {t('result.title')}
                </Heading>
                <p id="invite-result-reason" className="text-content-muted mb-4">
                    {t(`refused.${outcome.reason}`)}
                </p>
                <p className="text-xs text-content-muted mb-6">
                    {t.rich('result.signedInAs', {
                        email,
                        b: (chunks) => <span className="font-medium">{chunks}</span>,
                    })}
                </p>
                <Link
                    href="/tenants"
                    id="invite-result-workspaces"
                    className={buttonVariants({ variant: 'secondary', className: 'w-full' })}
                >
                    {t('result.toWorkspaces')}
                </Link>
            </div>
        </main>
    );
}
