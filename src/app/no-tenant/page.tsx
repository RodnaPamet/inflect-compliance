/**
 * /no-tenant — Landing page for authenticated users with no active membership.
 *
 * PR 4 will wire Next.js middleware to redirect here when the JWT has no
 * `tenantId` (i.e. the user signed up / signed in but has not yet accepted
 * any invite). For now this page is reachable directly.
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
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { readSignInDestinations } from '@/lib/auth/sign-in-destinations';

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
                <div className="text-4xl mb-4">&#x1F512;</div>
                <Heading level={1} className="mb-2">
                    {t('title')}
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
