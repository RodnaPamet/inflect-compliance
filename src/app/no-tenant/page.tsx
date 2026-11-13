/**
 * /no-tenant — where a signed-in person lands when they cannot reach the
 * workspace they asked for, or any workspace at all.
 *
 * The edge middleware redirects here when the session holds no membership,
 * and when the URL's workspace is not one of the session's memberships
 * (`checkTenantAccess`). The redirect does not carry the slug the person
 * asked for, and the page does not echo one: a slug from a link is text
 * anybody can choose, and this page must not repeat it as if it were ours.
 *
 * The page is purely informational — it tells the user what to do next
 * and provides a sign-out button so they can switch accounts.
 *
 * What it says depends on what the person does hold (#4690):
 *   - workspaces, but not the one the URL named → "no access to that
 *     workspace", and a link to the picker;
 *   - only deactivated memberships → ask an admin to reactivate them, not
 *     for an invitation;
 *   - organisations → a link to each, so an organisation member with no
 *     workspace membership can reach the organisation;
 *   - workspaces the Microsoft Entra ID group gate refused this sign-in →
 *     which ones, and to ask an administrator there (#4869).
 */
import { auth, signOut } from '@/auth';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AppIcon } from '@/components/icons/AppIcon';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { readSignInDestinations } from '@/lib/auth/sign-in-destinations';
import { RefreshAccessButton } from './RefreshAccessButton';

export default async function NoTenantPage() {
    const session = await auth();
    if (!session?.user) {
        redirect('/login');
    }

    const t = await getTranslations('noTenant');
    const format = await getFormatter();
    const email = session.user.email ?? t('yourAccount');
    const { workspaces, organizations, deactivatedWorkspaces, entraRefusedWorkspaces } = session.user.id
        ? await readSignInDestinations(
              session.user.id,
              session.user.ssoTenantId,
              session.user.entraGateDeniedTenantIds,
          )
        : { workspaces: [], organizations: [], deactivatedWorkspaces: [], entraRefusedWorkspaces: [] };
    // ── IS THE COOKIE BEHIND THE DATABASE? (#5246) ──────────────────────
    //
    // `workspaces` above comes from the DATABASE; `session.user.memberships`
    // comes from the token, which is to say from the cookie the edge gate read
    // to send this person here. A workspace present in the first and absent
    // from the second is a membership granted after this session opened — and
    // the edge will keep refusing its slug, because in the App Router nothing
    // rewrites the cookie (see the `jwt` callback in src/auth.ts).
    //
    // Offered only when a refresh would actually DO something. A button that
    // says "check again" and then changes nothing is worse than no button: it
    // teaches the person that the product is broken rather than stale.
    const cookieSlugs = new Set((session.user.memberships ?? []).map((m) => m.slug));
    const staleWorkspaces = workspaces.filter((w) => !cookieSlugs.has(w.slug));

    // A person with workspaces reached one that is not theirs: "No access
    // yet" would read as if they could reach nothing (#4923).
    const title = workspaces.length > 0 ? t('titleOtherWorkspace') : t('title');
    const help =
        workspaces.length > 0
            ? t('otherWorkspaceText')
            : entraRefusedWorkspaces.length > 0
              ? t('entraRefused', { workspaces: format.list(entraRefusedWorkspaces, { type: 'conjunction' }) })
              : organizations.length > 0
              ? t('organizationsOnly')
              : deactivatedWorkspaces.length > 0
                ? t('deactivated', { workspaces: format.list(deactivatedWorkspaces, { type: 'conjunction' }) })
                : t('helpText');

    return (
        <main className="min-h-screen bg-bg-page flex items-center justify-center p-4">
            <Card elevation="floating" className="max-w-md w-full text-center">
                <AppIcon name="lock" size={40} className="mx-auto mb-4 text-content-muted" />
                <Heading level={1} className="mb-2">
                    {title}
                </Heading>
                <p className="text-content-muted mb-2">
                    {t.rich('signedInAs', {
                        email,
                        b: (chunks) => (
                            <span className="font-medium text-content-default">
                                {chunks}
                            </span>
                        ),
                    })}
                </p>
                <p className="text-content-muted mb-6">
                    {help}
                </p>
                {(workspaces.length > 0 || organizations.length > 0) && (
                    <nav aria-label={t('whereToGo')} className="mb-6 flex flex-col gap-compact text-left">
                        {workspaces.length > 0 && (
                            <a
                                href="/tenants"
                                id="no-tenant-workspaces-link"
                                className="rounded-lg border border-border-subtle px-4 py-3 font-medium text-content-default hover:bg-bg-muted/50 transition-colors"
                            >
                                {t('goToWorkspaces')}
                            </a>
                        )}
                        {organizations.map((o) => (
                            <a
                                key={o.slug}
                                href={`/org/${o.slug}`}
                                className="rounded-lg border border-border-subtle px-4 py-3 font-medium text-content-default hover:bg-bg-muted/50 transition-colors"
                            >
                                {t('goToOrganization', { name: o.name })}
                            </a>
                        ))}
                    </nav>
                )}
                {staleWorkspaces.length > 0 && (
                    <div className="mb-6 flex flex-col gap-compact text-left">
                        <p className="text-content-muted">{t('refreshStale')}</p>
                        <RefreshAccessButton />
                    </div>
                )}
                <form
                    action={async () => {
                        'use server';
                        await signOut({ redirectTo: '/login' });
                    }}
                >
                    <Button type="submit" variant="secondary" className="w-full">
                        {t('signOut')}
                    </Button>
                </form>
            </Card>
        </main>
    );
}
