/**
 * /tenants — Tenant picker page (R-1 closure).
 *
 * Rendered when a user has >1 active tenant membership and needs to choose
 * which workspace to enter. Also handles the degenerate cases
 * (`directDestination`):
 *   1 membership              → that tenant's dashboard
 *   0 memberships, 1 org      → that organisation (#4690)
 *   0 memberships, 0 orgs     → /no-tenant
 *   0 memberships, >1 orgs    → the picker, listing the organisations
 * A picker with workspaces also lists the person's organisations.
 *
 * This page is listed in PUBLIC_PATH_PREFIXES in guard.ts so the
 * middleware tenant-access gate does not bounce the user trying to
 * reach the picker before an active tenant is set in the JWT.
 *
 * The membership list is queried directly from the DB, NOT read from
 * `session.user.memberships`: the JWT list is capped at
 * `MAX_JWT_MEMBERSHIPS` for cookie-size safety, but the picker is a
 * server component with no Edge constraint and must show EVERY
 * workspace the user belongs to.
 */
import { auth, signOut } from '@/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { directDestination, readSignInDestinations } from '@/lib/auth/sign-in-destinations';
import { Heading } from '@/components/ui/typography';

export default async function TenantsPage() {
    const session = await auth();

    if (!session?.user?.id) {
        redirect('/login');
    }

    // Complete, authoritative lists — see the file header.
    const destinations = await readSignInDestinations(session.user.id, session.user.ssoTenantId);
    const direct = directDestination(destinations);
    if (direct) {
        redirect(direct);
    }
    const { workspaces, organizations } = destinations;

    const t = await getTranslations('tenants');
    const tRoles = await getTranslations('roles');
    const chevron = (
        <svg
            className="h-4 w-4 text-content-muted"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M6 3l5 5-5 5" />
        </svg>
    );
    const rowClass =
        'flex items-center justify-between rounded-lg border border-border-subtle bg-bg-default px-5 py-4 hover:bg-bg-muted/50 transition-colors';

    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div className="max-w-lg w-full">
                <div className="mb-8 text-center">
                    <Heading level={1} className="mb-2">
                        {workspaces.length > 0 ? t('chooseWorkspace') : t('chooseOrganization')}
                    </Heading>
                    <p className="text-content-muted">
                        {workspaces.length > 0 ? t('multipleWorkspaces') : t('multipleOrganizations')}
                    </p>
                </div>
                {workspaces.length > 0 && (
                    <section
                        aria-labelledby={organizations.length > 0 ? 'tenants-workspaces' : undefined}
                        className="flex flex-col gap-compact"
                    >
                        {organizations.length > 0 && (
                            <Heading level={2} id="tenants-workspaces" className="text-sm text-content-muted">
                                {t('workspacesHeading')}
                            </Heading>
                        )}
                        {workspaces.map((m) => (
                            <a key={m.slug} href={`/t/${m.slug}/dashboard`} className={rowClass}>
                                <div>
                                    {/* The name a person gave it; the slug can read like `acme-corp-mf3x9p`. */}
                                    <p className="font-medium text-content-default">{m.name}</p>
                                    <p className="text-sm text-content-muted">
                                        {tRoles.has(m.role) ? tRoles(m.role) : m.role}
                                    </p>
                                </div>
                                {chevron}
                            </a>
                        ))}
                    </section>
                )}
                {organizations.length > 0 && (
                    <section
                        aria-labelledby="tenants-organizations"
                        className={workspaces.length > 0 ? 'mt-6 flex flex-col gap-compact' : 'flex flex-col gap-compact'}
                    >
                        <Heading level={2} id="tenants-organizations" className="text-sm text-content-muted">
                            {t('organizationsHeading')}
                        </Heading>
                        {organizations.map((o) => (
                            <a key={o.slug} href={`/org/${o.slug}`} className={rowClass}>
                                <p className="font-medium text-content-default">{o.name}</p>
                                {chevron}
                            </a>
                        ))}
                    </section>
                )}
                <div className="mt-6 text-center">
                    <form
                        action={async () => {
                            'use server';
                            await signOut({ redirectTo: '/login' });
                        }}
                    >
                        <button
                            type="submit"
                            className="text-sm text-content-muted hover:text-content-default transition-colors"
                        >
                            {t('signOut')}
                        </button>
                    </form>
                </div>
            </div>
        </main>
    );
}
