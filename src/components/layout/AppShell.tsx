'use client';

import { useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { SidebarContent } from '@/components/layout/SidebarNav';
import { MobileNavDrawer } from '@/components/layout/MobileNavDrawer';
import { AppShellFrame } from '@/components/layout/AppShellFrame';
import { OrgSidebarContent } from '@/components/layout/OrgSidebarNav';
import { SidebarCollapseProvider } from '@/components/layout/sidebar-collapse-context';
import { BreadcrumbsProvider } from './breadcrumbs-store';
import { TopChrome } from './TopChrome';

// ─── Types ───

/**
 * User shape threaded through the shell from the server-side
 * layout (which resolves the session via `auth()`).
 *
 * The codebase deliberately does NOT mount a `<SessionProvider>`
 * client-side (see the rationale in `src/app/providers.tsx`); any
 * chrome that needs user data takes it via props. R14-PR4 +
 * R14-PR5 originally violated this by calling `useSession()` —
 * the hotfix on this branch threads the data here instead.
 */
interface AppShellUser {
    name?: string | null;
    email?: string | null;
    /**
     * Profile-photo URL. Either the OAuth `User.image` written at
     * sign-in (e.g. a Google CDN URL) or the in-app serve URL written
     * by the avatar upload flow (`/api/account/avatar/<id>`). Threaded
     * through to the user-menu avatar in the top chrome — avatar
     * roadmap P4.
     */
    image?: string | null;
    /**
     * Active tenant memberships from the JWT. Same shape as
     * `MembershipEntry` in `src/auth.ts` — `{ slug, role,
     * tenantId }`. Optional because the org variant has no
     * tenant context.
     */
    memberships?: Array<{
        slug: string;
        role: string;
        tenantId: string;
    }>;
    /**
     * B4 — active organization memberships from the JWT
     * (`OrgMembershipEntry`). Threaded into the workspace switcher
     * so the picker can show both org + tenant contexts in one
     * popover.
     */
    orgMemberships?: Array<{
        slug: string;
        role: string;
        organizationId: string;
    }>;
}

export type AppShellVariant = 'tenant' | 'org';

interface AppShellProps {
    /** Serializable user data resolved server-side */
    user: AppShellUser;
    /**
     * Pre-resolved app name (from server-side i18n).
     *
     * R14-PR12 retired the mobile-only top bar that rendered the
     * wordmark; the prop is preserved for caller compatibility
     * (the tenant + org layouts pass it from `tc('appName')`).
     * The value is no longer rendered anywhere — kept as a
     * deprecation slot until the callers can be updated in a
     * follow-up cleanup PR.
     */
    appName: string;
    /**
     * Roadmap-2 PR-1 — picks which sidebar nav this shell mounts.
     * 'tenant' = SidebarContent (Dashboard, Risks, Controls, …).
     * 'org'    = OrgSidebarContent (Portfolio, Tenants, Members, …).
     * Default: 'tenant' to preserve historical behaviour for callers
     * that omit the prop.
     */
    variant?: AppShellVariant;
    children: React.ReactNode;
}

/**
 * Client-side app shell — Roadmap-2 PR-1 unified.
 *
 * Mounts the chrome that wraps every authenticated app surface
 * (tenant `/t/:slug/(app)/**` AND org `/org/:slug/**`):
 *   • Mobile drawer toggle state.
 *   • Sign-out handler (requires next-auth/react).
 *   • Route-change auto-close for the mobile drawer.
 *
 * Variant only changes WHICH sidebar nav we mount — the chrome
 * (mobile top bar, scrolling rules, viewport-clamp behaviour,
 * keyboard-shortcut wiring through MobileDrawer) is identical so
 * the two contexts feel the same to the user.
 *
 * Receives only serializable props from the server layout.
 *
 * Note: `data-testid="nav-toggle"` and `data-testid="org-nav-toggle"`
 * differ deliberately — Playwright tests bind to the variant-specific
 * selector to assert the right shell mounted.
 */
export function AppShell({
    user,
    // appName preserved on the interface for caller compat (R14-PR12);
    // no longer rendered anywhere — see the AppShellProps doc comment.
    appName: _appName,
    variant = 'tenant',
    children,
}: AppShellProps) {
    const handleLogout = useCallback(async () => {
        await signOut({ callbackUrl: '/login' });
    }, []);

    // Item 33 — the process-map canvas (exact `/t/<slug>/processes` route) is
    // a full-bleed editor surface that must span the content area, so it opts
    // out of the centered max-w reading column. Sub-routes
    // (`/processes/governance`, …) keep the normal column.
    //
    // T07 — the test stays HERE rather than in `AppShellFrame`. The frame
    // takes a `fullBleed` boolean precisely so a route literal does not have
    // to live in a file written to be vendored byte-identical; this is the
    // routing knowledge, and it belongs with the product that has the route.
    const pathname = usePathname();
    const isCanvasFullBleed = /\/processes\/?$/.test(pathname ?? '');

    // Variant only picks WHICH sidebar nav mounts — the chrome is identical
    // so the two contexts feel the same to the user.
    const Sidebar = variant === 'org' ? OrgSidebarContent : SidebarContent;

    return (
        <AppShellFrame
            fullBleed={isCanvasFullBleed}
            sidebar={({ collapsed, onToggleCollapse }) => (
                <SidebarCollapseProvider collapsed={collapsed}>
                    <Sidebar
                        user={user}
                        onLogout={handleLogout}
                        onToggleCollapse={onToggleCollapse}
                    />
                </SidebarCollapseProvider>
            )}
            // The drawer is never collapsed — it has the width to show
            // labels, and an icon rail inside a panel the user deliberately
            // opened would be hiding what they opened it for.
            mobileNav={({ open, onClose }) => (
                <MobileNavDrawer open={open} onClose={onClose}>
                    <SidebarCollapseProvider collapsed={false}>
                        <Sidebar user={user} onLogout={handleLogout} onNavClick={onClose} />
                    </SidebarCollapseProvider>
                </MobileNavDrawer>
            )}
            topChrome={({ onMobileMenuClick }) => (
                <TopChrome
                    variant={variant}
                    user={user}
                    onMobileMenuClick={onMobileMenuClick}
                />
            )}
            // Breadcrumbs must span the chrome AND the page tree, which sit in
            // different places inside the frame — so it arrives as a wrapper
            // rather than the frame knowing the provider's name.
            mainProvider={(node) => <BreadcrumbsProvider>{node}</BreadcrumbsProvider>}
        >
            {children}
        </AppShellFrame>
    );
}
