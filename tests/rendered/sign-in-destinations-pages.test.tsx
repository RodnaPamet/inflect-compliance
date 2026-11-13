/**
 * Where a signed-in person can go: the workspace picker and /no-tenant (#4690).
 *
 *   - The picker names each workspace, not its slug (a self-registered
 *     workspace's slug reads like `acme-corp-mf3x9p`).
 *   - A member of an organisation with no workspace membership reaches the
 *     organisation, from the picker and from /no-tenant, instead of a dead end.
 *   - A deactivated member is told to ask for reactivation, not an invitation.
 */
import { render, screen } from '@testing-library/react';

class RedirectSignal extends Error {
    constructor(readonly to: string) {
        super(`NEXT_REDIRECT ${to}`);
    }
}
const routerPush = jest.fn();
const routerRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    redirect: (to: string) => {
        throw new RedirectSignal(to);
    },
    // /no-tenant renders a CLIENT component when the cookie is behind the
    // database (#5246), and it takes the router to reach the picker. Without
    // this the mock is incomplete for what the page now renders.
    useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

jest.mock('next-intl/server', () => {
    const { useTranslations: translatorFor } = jest.requireMock('next-intl') as {
        useTranslations: (ns: string) => unknown;
    };
    return {
        getTranslations: async (ns: string) => translatorFor(ns),
        getFormatter: async () => ({ list: (items: string[]) => items.join(' and ') }),
    };
});

const authMock = jest.fn();
jest.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a), signOut: jest.fn() }));

const activeRows = jest.fn();
const deactivatedRows = jest.fn();
const orgRows = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: {
            findMany: (args: { where: { status: string } }) =>
                args.where.status === 'ACTIVE' ? activeRows(args) : deactivatedRows(args),
        },
        orgMembership: { findMany: (args: unknown) => orgRows(args) },
    },
}));

import TenantsPage from '@/app/tenants/page';
import NoTenantPage from '@/app/no-tenant/page';
import { directDestination } from '@/lib/auth/sign-in-destinations';

const en = jest.requireActual('../../messages/en.json') as {
    tenants: Record<string, string>;
    noTenant: Record<string, string>;
};

const workspace = (slug: string, name: string, role = 'EDITOR') => ({ role, tenant: { slug, name } });
const org = (slug: string, name: string) => ({ organization: { slug, name } });

async function redirectOf(page: () => Promise<unknown>): Promise<string> {
    try {
        await page();
    } catch (e) {
        if (e instanceof RedirectSignal) return e.to;
        throw e;
    }
    throw new Error('expected a redirect');
}

beforeEach(() => {
    authMock.mockReset();
    // No `memberships` on the session by default — the cookie lists nothing,
    // which is what a brand-new grant looks like from the edge's side (#5246).
    authMock.mockResolvedValue({ user: { id: 'u-1', email: 'ana@example.com' } });
    routerPush.mockReset();
    routerRefresh.mockReset();
    activeRows.mockReset().mockResolvedValue([]);
    deactivatedRows.mockReset().mockResolvedValue([]);
    orgRows.mockReset().mockResolvedValue([]);
});

describe('directDestination', () => {
    const w = { slug: 'acme', name: 'Acme', role: 'EDITOR' as const };
    const o = { slug: 'group', name: 'Group' };

    it('sends one workspace straight to it, with or without organisations', () => {
        expect(directDestination({ workspaces: [w], organizations: [] })).toBe('/t/acme/dashboard');
        expect(directDestination({ workspaces: [w], organizations: [o, o] })).toBe('/t/acme/dashboard');
    });

    it('sends a person with no workspace to their one organisation, or to /no-tenant', () => {
        expect(directDestination({ workspaces: [], organizations: [o] })).toBe('/org/group');
        expect(directDestination({ workspaces: [], organizations: [] })).toBe('/no-tenant');
    });

    it('shows the picker for more than one choice', () => {
        expect(directDestination({ workspaces: [w, w], organizations: [] })).toBeNull();
        expect(directDestination({ workspaces: [], organizations: [o, o] })).toBeNull();
    });
});

describe('the workspace picker', () => {
    it('names each workspace, not its slug, and lists the organisations', async () => {
        activeRows.mockResolvedValue([workspace('acme-corp-mf3x9p', 'Acme Corp'), workspace('beta-k2', 'Beta Ltd', 'ADMIN')]);
        orgRows.mockResolvedValue([org('acme-group', 'Acme Group')]);

        render(await TenantsPage());

        expect(screen.getByRole('link', { name: /Acme Corp/ })).toHaveAttribute('href', '/t/acme-corp-mf3x9p/dashboard');
        expect(screen.queryByText('acme-corp-mf3x9p')).toBeNull();
        expect(screen.getByRole('heading', { name: en.tenants.organizationsHeading })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Acme Group/ })).toHaveAttribute('href', '/org/acme-group');
    });

    it('takes a person with no workspace to their organisation', async () => {
        orgRows.mockResolvedValue([org('acme-group', 'Acme Group')]);
        expect(await redirectOf(TenantsPage)).toBe('/org/acme-group');
    });

    it('lets a person with no workspace and two organisations choose', async () => {
        orgRows.mockResolvedValue([org('a', 'Alpha'), org('b', 'Beta')]);
        render(await TenantsPage());
        expect(screen.getByRole('heading', { name: en.tenants.chooseOrganization })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Beta/ })).toHaveAttribute('href', '/org/b');
    });

    it('still sends a person with nothing to /no-tenant', async () => {
        expect(await redirectOf(TenantsPage)).toBe('/no-tenant');
    });

    it('reads no organisation for a single-sign-on session, which reaches one workspace', async () => {
        authMock.mockResolvedValue({ user: { id: 'u-1', ssoTenantId: 't-1' } });
        activeRows.mockResolvedValue([workspace('acme', 'Acme')]);
        expect(await redirectOf(TenantsPage)).toBe('/t/acme/dashboard');
        expect(orgRows).not.toHaveBeenCalled();
        expect(activeRows.mock.calls[0][0].where).toMatchObject({ tenantId: 't-1' });
    });
});

describe('a workspace the Entra group gate refused this session (#4869)', () => {
    it('is not a destination: the picker goes straight to the one that remains', async () => {
        authMock.mockResolvedValue({
            user: { id: 'u-1', email: 'ana@example.com', entraGateDeniedTenantIds: ['t-beta'] },
        });
        activeRows.mockResolvedValue([
            { role: 'EDITOR', tenant: { id: 't-acme', slug: 'acme', name: 'Acme' } },
            { role: 'EDITOR', tenant: { id: 't-beta', slug: 'beta', name: 'Beta' } },
        ]);
        expect(await redirectOf(() => TenantsPage())).toBe('/t/acme/dashboard');
    });
});

describe('/no-tenant', () => {
    it('tells a deactivated member to ask for reactivation, naming the workspace', async () => {
        deactivatedRows.mockResolvedValue([{ tenant: { name: 'Acme Corp' } }]);
        render(await NoTenantPage());
        expect(screen.getByText(en.noTenant.deactivated.replace('{workspaces}', 'Acme Corp'))).toBeInTheDocument();
        expect(screen.queryByText(en.noTenant.helpText)).toBeNull();
    });

    it('links an organisation member to the organisation', async () => {
        orgRows.mockResolvedValue([org('acme-group', 'Acme Group')]);
        render(await NoTenantPage());
        expect(screen.getByText(en.noTenant.organizationsOnly)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: en.noTenant.goToOrganization.replace('{name}', 'Acme Group') }))
            .toHaveAttribute('href', '/org/acme-group');
    });

    it('sends a member of other workspaces back to the picker', async () => {
        activeRows.mockResolvedValue([workspace('acme', 'Acme')]);
        render(await NoTenantPage());
        expect(screen.getByText(en.noTenant.otherWorkspaceText)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: en.noTenant.goToWorkspaces })).toHaveAttribute('href', '/tenants');
    });

    it('does not tell a member of other workspaces they have no access yet (#4923)', async () => {
        activeRows.mockResolvedValue([workspace('acme', 'Acme')]);
        render(await NoTenantPage());
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(en.noTenant.titleOtherWorkspace);
        expect(screen.queryByText(en.noTenant.title)).toBeNull();
    });

    it('names a workspace the Entra group gate refused, rather than offering it (#4869)', async () => {
        authMock.mockResolvedValue({
            user: { id: 'u-1', email: 'ana@example.com', entraGateDeniedTenantIds: ['t-acme'] },
        });
        activeRows.mockResolvedValue([{ role: 'EDITOR', tenant: { id: 't-acme', slug: 'acme', name: 'Acme Corp' } }]);
        render(await NoTenantPage());
        expect(screen.getByText(en.noTenant.entraRefused.replace('{workspaces}', 'Acme Corp'))).toBeInTheDocument();
        expect(screen.queryByText(en.noTenant.otherWorkspaceText)).toBeNull();
        expect(screen.queryByRole('link', { name: en.noTenant.goToWorkspaces })).toBeNull();
    });

    it('keeps the invitation advice for a person with nothing at all', async () => {
        render(await NoTenantPage());
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(en.noTenant.title);
        expect(screen.getByText(en.noTenant.helpText)).toBeInTheDocument();
        expect(screen.queryByRole('navigation')).toBeNull();
    });

    it('draws its lock with the icon set, not an emoji', async () => {
        const { container } = render(await NoTenantPage());
        expect(container.textContent).not.toContain('\u{1F512}');
        expect(container.querySelector('svg')).not.toBeNull();
    });
});


// ─── The cookie can be behind the database (#5246) ─────────────────────────

describe('/no-tenant — offering a session refresh', () => {
    /**
     * WHY THIS EXISTS. A membership added while the person is signed in never
     * reaches the Edge gate: the jwt callback re-reads the claims, but in the
     * App Router nothing writes the re-signed cookie back, and the middleware
     * reads only the cookie. So `checkTenantAccess` keeps returning
     * `cross_tenant` for the new workspace and keeps sending the person here.
     *
     * The page compares the DATABASE (its destinations) against the COOKIE
     * (`session.user.memberships`) and offers the refresh only when the two
     * disagree — because a "check again" that changes nothing teaches the
     * person the product is broken rather than stale.
     */
    const sessionWith = (slugs: string[]) =>
        authMock.mockResolvedValue({
            user: { id: 'u-1', email: 'ana@example.com', memberships: slugs.map((slug) => ({ slug })) },
        });

    it('offers the refresh when the database holds a workspace the cookie does not', async () => {
        activeRows.mockResolvedValue([workspace('acme', 'Acme')]);
        sessionWith([]); // the cookie predates the grant
        render(await NoTenantPage());

        expect(screen.getByText(en.noTenant.refreshStale)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: en.noTenant.refreshAccess })).toBeInTheDocument();
    });

    it('does NOT offer it when the cookie already lists every workspace', async () => {
        // A genuine cross-tenant attempt: the person asked for a workspace that
        // is not theirs at all. Refreshing would change nothing, so the button
        // must not appear — this is the assertion that keeps it honest.
        activeRows.mockResolvedValue([workspace('acme', 'Acme')]);
        sessionWith(['acme']);
        render(await NoTenantPage());

        expect(screen.queryByText(en.noTenant.refreshStale)).toBeNull();
        expect(screen.queryByRole('button', { name: en.noTenant.refreshAccess })).toBeNull();
    });

    it('does NOT offer it to a person with no workspaces at all', async () => {
        // Nothing to pick up: they need an invitation, which the page already
        // says. Offering a refresh here would be a dead end.
        activeRows.mockResolvedValue([]);
        sessionWith([]);
        render(await NoTenantPage());

        expect(screen.queryByText(en.noTenant.refreshStale)).toBeNull();
        expect(screen.getByText(en.noTenant.helpText)).toBeInTheDocument();
    });

    it('still offers the picker link beside it, so neither replaces the other', async () => {
        activeRows.mockResolvedValue([workspace('acme', 'Acme')]);
        sessionWith([]);
        render(await NoTenantPage());

        expect(screen.getByRole('button', { name: en.noTenant.refreshAccess })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: en.noTenant.goToWorkspaces })).toHaveAttribute('href', '/tenants');
    });
});
