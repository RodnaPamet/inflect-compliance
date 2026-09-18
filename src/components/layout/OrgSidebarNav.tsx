'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    FileContent,
    FolderBookmark,
    GridIcon,
    Menu3,
    OfficeBuilding,
    ShieldCheck,
    TriangleWarning,
    UserArrowRight,
    Users,
} from '@/components/ui/icons/nucleo';
import { useOrgContext, useOrgHref, useOrgPermissions } from '@/lib/org-context-provider';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { OrgSwitcher } from '@/components/org-switcher';
import { useSidebarCollapsed } from './sidebar-collapse-context';
// PR-2 — port the org sidebar to the canonical Roadmap-12 nav
// primitives that the tenant sidebar already uses. The legacy
// `nav-link` CSS approach (an `<a>` + class string) loses the
// active-state band, hover gloss, and keyboard-focus polish the
// shared <NavItem> bakes in.
import { NavItem, type NavGlyph } from './nav-item';
import { NavSection } from './nav-section';

// ─── Nav configuration ───────────────────────────────────────────────
//
// Nav entries per Epic O-4 spec, in the order the spec lists them:
//   1. Portfolio Overview
//   2. All Tenants
//   3. Non-Performing Controls   ← drill-down
//   4. Critical Risks            ← drill-down
//   5. Overdue Evidence          ← drill-down
//   6. Members
//   7. Audit Log
// (The Settings entry was removed from the sidebar; the /settings
//  route itself is unchanged.)
//
// `requiresDrillDown` flags the three drill-down entries — they're
// hidden in the sidebar when the user lacks the permission (ORG_READER
// case). Server-side authorization remains the load-bearing gate; the
// hidden item is a UX cleanup, not a security control.

interface OrgNavItemDef {
    href: string;
    label: string;
    /** Lucide OR Nucleo — see the `NavGlyph` note on `NavItemProps.icon`. */
    icon: NavGlyph;
    requiresDrillDown?: boolean;
    requiresManageMembers?: boolean;
}

interface OrgNavSectionDef {
    title?: string;
    items: OrgNavItemDef[];
}

export function useOrgNavSections(): OrgNavSectionDef[] {
    const orgHref = useOrgHref();
    const perms = useOrgPermissions();
    const t = useTranslations('org');

    const sections: OrgNavSectionDef[] = [
        {
            // Roadmap-2 PR-3 — quiet eyebrow on the primary org
            // group (mirrors "Manage" below + "Govern" on the
            // tenant sidebar). Gives the org sidebar the same
            // visual hierarchy the tenant sidebar carries.
            title: t('nav.portfolio'),
            items: [
                { href: orgHref('/'), label: t('nav.portfolioOverview'), icon: GridIcon },
                { href: orgHref('/tenants'), label: t('nav.allTenants'), icon: OfficeBuilding },
                {
                    href: orgHref('/controls'),
                    label: t('nav.nonPerformingControls'),
                    icon: ShieldCheck,
                    requiresDrillDown: true,
                },
                {
                    href: orgHref('/risks'),
                    label: t('nav.criticalRisks'),
                    icon: TriangleWarning,
                    requiresDrillDown: true,
                },
                {
                    href: orgHref('/evidence'),
                    label: t('nav.overdueEvidence'),
                    icon: FolderBookmark,
                    requiresDrillDown: true,
                },
            ],
        },
        {
            title: t('nav.manage'),
            items: [
                {
                    href: orgHref('/members'),
                    label: t('nav.members'),
                    icon: Users,
                    requiresManageMembers: true,
                },
                {
                    href: orgHref('/audit'),
                    label: t('nav.auditLog'),
                    icon: FileContent,
                    // Epic B — immutable per-org privilege ledger.
                    // Same gate as Members: ORG_ADMIN can review who
                    // was added/removed/role-changed and when.
                    requiresManageMembers: true,
                },
            ],
        },
    ];

    // Defense-in-depth client filter — fail-closed.
    return sections.map((section) => ({
        ...section,
        items: section.items.filter((item) => {
            if (item.requiresDrillDown && !perms.canDrillDown) return false;
            if (item.requiresManageMembers && !perms.canManageMembers) return false;
            return true;
        }),
    }));
}

// PR-2 — `OrgNavItem` / `OrgNavSection` retired in favour of the
// canonical `<NavItem>` / `<NavSection>` primitives (used by the
// tenant sidebar). The shared primitives carry the Roadmap-12
// active-state band, the R13 brand-gradient glow + shimmer, the
// liquid hover sweep, and the keyboard-focus polish — none of
// which the legacy `nav-link` CSS class provided.

// ─── Sidebar content (shared between desktop sidebar + mobile drawer) ─

interface OrgSidebarContentProps {
    user: { name?: string | null };
    onLogout: () => void;
    onNavClick?: () => void;
    /** Desktop only — when provided, renders the collapse/expand toggle. */
    onToggleCollapse?: () => void;
}

export function OrgSidebarContent({ user, onLogout, onNavClick, onToggleCollapse }: OrgSidebarContentProps) {
    const pathname = usePathname();
    const org = useOrgContext();
    const sections = useOrgNavSections();
    const collapsed = useSidebarCollapsed();
    const t = useTranslations('org');

    return (
        <div className="flex flex-col h-full">
            {/* Org branding doubles as the context switcher (Epic O-4). When
                collapsed, the switcher would overflow the rail — show the org
                initial; expand to switch. */}
            <div className="p-3 border-b border-border-subtle">
                {collapsed ? (
                    <div className="flex items-center justify-center">
                        <div className="w-8 h-8 rounded-lg bg-bg-muted flex items-center justify-center flex-shrink-0 text-sm font-bold text-content-emphasis">
                            {(org.orgName ?? 'O').charAt(0).toUpperCase()}
                        </div>
                    </div>
                ) : (
                    <OrgSwitcher
                        orgSlug={org.orgSlug}
                        orgName={org.orgName}
                        currentKind="org"
                    />
                )}
            </div>

            {/* Nav */}
            <nav className="flex-1 p-2 overflow-y-auto" aria-label={t('nav.ariaLabel')}>
                {sections.map((section, idx) => (
                    <NavSection
                        key={idx}
                        title={section.title}
                        isFirst={idx === 0}
                    >
                        {section.items.map((item) => {
                            // Active when the current path is exactly the item's href
                            // OR a sub-path. Special-case "/" so the overview tab
                            // doesn't light up for every other nav item.
                            const isOverview = item.href === `/org/${org.orgSlug}/`;
                            const active = isOverview
                                ? pathname === item.href.replace(/\/$/, '') ||
                                  pathname === item.href
                                : pathname.startsWith(item.href);
                            return (
                                <NavItem
                                    key={item.href}
                                    href={item.href}
                                    icon={item.icon}
                                    label={item.label}
                                    active={active}
                                    onClick={onNavClick}
                                />
                            );
                        })}
                    </NavSection>
                ))}
            </nav>

            {/* Collapse / expand toggle (desktop only). */}
            {onToggleCollapse && (
                <div className="mx-2 mb-2">
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
                        aria-pressed={collapsed}
                        data-testid="sidebar-collapse-toggle"
                        className={cn(
                            'flex w-full items-center rounded-lg border border-border-subtle bg-bg-default px-3 py-2 text-xs text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                            collapsed ? 'justify-center' : 'gap-tight',
                        )}
                    >
                        {/* ONE glyph for both states, matching the tenant sidebar.
                            Direction is not carried by the icon — it is
                            `aria-hidden`; the button's `aria-label`
                            (expand/collapse) and `aria-pressed` carry the state
                            for assistive tech. Nucleo ships no matched
                            close/open pair, and inventing a mirrored one would
                            diverge from the sibling surface for no gain. */}
                        <Menu3 className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {!collapsed && <span className="flex-1 text-left">{t('nav.collapse')}</span>}
                    </button>
                </div>
            )}

            {/* User. The theme toggle was removed in step with
                SidebarNav; theme is still toggleable from the
                command palette. Collapsed: identity text drops, sign-out
                becomes an icon button. */}
            <div className="p-3 border-t border-border-subtle">
                {!collapsed && (
                    <div className="mb-2 min-w-0">
                        <p className="text-xs font-medium text-content-default truncate">{user.name}</p>
                        <p className="text-xs text-content-muted truncate">{org.orgName}</p>
                        {/* GAP-CI-77: see SidebarNav for the same fix
                            rationale — brand orange on cream is below AA for
                            small text. */}
                        <p className="text-xs text-content-muted">{org.role}</p>
                    </div>
                )}
                {collapsed ? (
                    <Tooltip content={t('common.signOut')} side="right">
                        <button
                            type="button"
                            onClick={onLogout}
                            aria-label={t('common.signOut')}
                            data-testid="org-nav-logout"
                            className="icon-btn icon-btn-sm mx-auto flex"
                        >
                            <UserArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </Tooltip>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onLogout}
                        className="w-full text-xs"
                        data-testid="org-nav-logout"
                    >
                        <UserArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('common.signOut')}
                    </Button>
                )}
            </div>
        </div>
    );
}
