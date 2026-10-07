'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantContext, useTenantHref, usePermissions, useModules } from '@/lib/tenant-context-provider';
import { Tooltip } from '@/components/ui/tooltip';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import { StartTourButton } from '@/components/ui/OnboardingTour';
import { useCommandPalette } from '@/components/command-palette/command-palette-provider';
import {
    BadgeCheck,
    BulletList,
    CalendarIcon,
    FileContent,
    Flask,
    FolderBookmark,
    Gear,
    GridIcon,
    Menu3,
    OfficeBuilding,
    Robot,
    ShieldCheck,
    Shop,
    SquareChart,
    TriangleWarning,
    UserArrowRight,
    Workflow,
    Xmark,
} from '@/components/ui/icons/nucleo';
import { cn } from '@inflect/ui/lib/cn';
import { useCalendarBadge } from './use-calendar-badge';
import { NavItem } from './nav-item';
// A SEPARATE type-only import on purpose. `nav-item-import-discipline` pins the
// value import's exact spelling, and folding the type into the same braces does
// not match its pattern.
//
// The reason this note does not quote that pattern is its own lesson: the first
// version did, and the quoted form was a SECOND textual occurrence in a file the
// guard reads whole — which pushed `assertion-needle-uniqueness-ratchet` over
// its Class D ceiling by exactly one. A comment quoting a needle is a survivor
// that can satisfy the assertion after the real import is deleted.
import type { NavGlyph } from './nav-item';
import { NavSection } from './nav-section';
import { useSidebarCollapsed } from './sidebar-collapse-context';

// ─── Types ───

interface NavItemDef {
    href: string;
    label: string;
    /** Lucide OR Nucleo — see the `NavGlyph` note on `NavItemProps.icon`. */
    icon: NavGlyph;
    badge?: string | number;
    /** Accessible description of what `badge` counts (see NavItem). */
    badgeLabel?: string;
    /** If set, item is only shown when this returns true */
    visible?: boolean;
}

interface NavSectionDef {
    title?: string;
    items: NavItemDef[];
}

// ─── Navigation configuration ───

export function useNavSections(): NavSectionDef[] {
    const tenantHref = useTenantHref();
    const perms = usePermissions();
    const modules = useModules();
    const tenant = useTenantContext();
    // Nav labels + section eyebrows are localised via the `nav` catalog
    // (messages/{en,bg}.json). Hrefs — and therefore `data-testid="nav-<slug>"`
    // selectors used by E2E / the onboarding tour — stay stable.
    const t = useTranslations('nav');
    // Live badge — fetched lazily; undefined when count is 0 or load fails.
    const calendarBadge = useCalendarBadge(tenant.tenantSlug);

    // R13-PR7 — tenant sidebar restructure.
    //
    //   Board (standalone, no eyebrow)   home/dashboard
    //   Workspace                        core entities: Asset / Risk / Control
    //   Comply                           daily-cadence work: Plan / Schedule / Review / Docs
    //   Manage                           governance + reporting
    //
    // Renames carry forward to labels only — hrefs (and therefore
    // `data-testid="nav-<slug>"`) stay stable so existing E2E,
    // onboarding-tour, and analytics selectors keep working.
    return [
        {
            // Board is the home link. No eyebrow — it reads as a
            // single anchor above the grouped nav, mirroring the
            // "home" item pattern in Linear / Stripe / Vercel
            // sidebars.
            items: [
                { href: tenantHref('/dashboard'), label: t('dashboard'), icon: GridIcon },
            ],
        },
        {
            // R13-PR11 — renamed from "Workspace" to "Govern" to
            // better describe the three core entities (assets,
            // risks, controls) as the surfaces compliance teams
            // govern day-to-day, distinct from the daily-cadence
            // work that sits under "Comply".
            title: t('govern'),
            items: [
                { href: tenantHref('/assets'), label: t('assets'), icon: OfficeBuilding },
                { href: tenantHref('/risks'), label: t('risks'), icon: TriangleWarning },
                { href: tenantHref('/controls'), label: t('controls'), icon: ShieldCheck },
            ],
        },
        {
            title: t('comply'),
            items: [
                // R13-PR16 — Audit moved from "Manage" to the top of
                // "Comply" because audits are a daily-cadence
                // workflow (Plan / Schedule / Review / Docs), not
                // ongoing governance configuration.
                { href: tenantHref('/audits'), label: t('audits'), icon: BadgeCheck },
                { href: tenantHref('/tasks'), label: t('tasks'), icon: BulletList },
                {
                    href: tenantHref('/calendar'),
                    label: t('calendar'),
                    icon: CalendarIcon,
                    badge: calendarBadge,
                    // The badge counts only the caller's OWN tasks (overdue
                    // + upcoming) while the page it links to is tenant-wide
                    // across every deadline source — say so rather than let
                    // a small number read as "the tenant is fine".
                    badgeLabel: t('calendarBadgeLabel'),
                },
                { href: tenantHref('/tests'), label: t('tests'), icon: Flask },
                { href: tenantHref('/evidence'), label: t('evidence'), icon: FolderBookmark },
            ],
        },
        {
            title: t('manage'),
            items: [
                // R13-PR12 — Frameworks dropped from the sidebar.
                // The page stays reachable via the Frameworks pill on
                // the Audits page header (R13-PR9) and via the command
                // palette (⌘K → "Frameworks").
                // R13-PR16 — Audit moved up to Comply (see above).
                { href: tenantHref('/policies'), label: t('policies'), icon: FileContent },
                { href: tenantHref('/vendors'), label: t('vendors'), icon: Shop },
                // AGENTIC UI 1/4 (#2423) — the agent register. Same
                // governance-tool tier as Policy and Vendor: a register of
                // what may act inside the tenant, with an owner per row.
                //
                // Placed BETWEEN vendors and processes, and gated on the same
                // key the page itself asserts. Note the filter below is
                // FAIL-CLOSED — `visible` must be strictly `true` or omitted,
                // and an item whose gate resolves to `undefined` (a permission
                // bag missing the key) silently disappears with no error, so
                // the expression is coerced rather than passed through.
                //
                // Nucleo `Robot`: already the glyph on both existing agent
                // surfaces (the admin pill and the register's own header).
                // The rest of this file followed it — every icon here is now
                // Nucleo and the file is off `LEGACY_LUCIDE_USERS`.
                {
                    href: tenantHref('/agents'),
                    label: t('agents'),
                    icon: Robot,
                    visible: perms.admin.agent_registry === true,
                },
                // R25-PR-A — Processes canvas. Visual mapping of
                // business + IT processes with controls placed on
                // the connections between steps. Sits under Manage
                // alongside Policy + Vendor — same governance-tool
                // tier.
                //
                // GATED ON A MODULE, NOT A PERMISSION, and it is the only entry
                // here that is. The surrounding items ask whether this USER may
                // open a surface the product offers everyone; this one asks
                // whether the tenant HAS the surface at all. `modules` is a
                // separate bag on the tenant context for exactly that reason.
                //
                // The same value gates the route itself (the `processes/`
                // layout calls `notFound()`), read from one place server-side —
                // so this cannot become a visible link to a 404, which is the
                // worst failure available to a nav gate.
                {
                    href: tenantHref('/processes'),
                    label: t('processes'),
                    icon: Workflow,
                    visible: modules.processCanvas === true,
                },
                { href: tenantHref('/reports'), label: t('reports'), icon: SquareChart, visible: perms.reports.view },
            ].filter(item => {
                // DEFENSE-IN-DEPTH (Layer 2 of 2):
                // Layer 1: Server layout uses noStore() to ensure fresh permissions per request.
                // Layer 2: This client-side filter removes gated items based on the resolved permissions.
                // Fail-closed: if `visible` is explicitly set, only include when strictly `true`.
                if (item.visible === undefined) return true; // no gate — always visible
                return item.visible === true;               // gated — only if permission is true
            }),
        },
    ];
}

// ─── Sidebar content (shared between desktop sidebar and mobile drawer) ───

interface SidebarContentProps {
    user: { name?: string | null };
    onLogout: () => void;
    onNavClick?: () => void;
    /** Desktop only — when provided, renders the collapse/expand toggle. */
    onToggleCollapse?: () => void;
}

export function SidebarContent({ user, onLogout, onNavClick, onToggleCollapse }: SidebarContentProps) {
    const pathname = usePathname();
    const tc = useTranslations('common');
    const tn = useTranslations('nav');
    const tenant = useTenantContext();
    const tenantHref = useTenantHref();
    const perms = usePermissions();
    const sections = useNavSections();
    const { open: openPalette } = useCommandPalette();
    // Icon-rail mode (desktop). The mobile drawer's provider always reports
    // false, so this whole branch is desktop-only in practice.
    const collapsed = useSidebarCollapsed();

    return (
        <div className="flex flex-col h-full">
            {/* Brand / collapse. On desktop the brand slot IS the collapse
                control — a hamburger that toggles the icon rail (replacing the
                old bottom-of-sidebar collapse button). The mobile drawer has no
                `onToggleCollapse`, so it keeps the static brand mark. */}
            <div className="p-4 border-b border-border-subtle">
                {onToggleCollapse ? (
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={collapsed ? tn('expandSidebar') : tn('collapseSidebar')}
                        aria-pressed={collapsed}
                        data-testid="sidebar-collapse-toggle"
                        className={cn(
                            'flex w-full items-center rounded-lg text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                            collapsed ? 'justify-center' : 'gap-tight',
                        )}
                    >
                        <Menu3 className="h-5 w-5 shrink-0" aria-hidden="true" />
                        {!collapsed && (
                            <span className="text-sm font-semibold text-content-emphasis truncate">
                                {tc('appName')}
                            </span>
                        )}
                    </button>
                ) : (
                    <div className="flex items-center gap-tight">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-emphasis)] to-[var(--brand-default)] flex items-center justify-center flex-shrink-0">
                            <span className="text-content-inverted text-sm font-bold">IC</span>
                        </div>
                        <span className="text-sm font-semibold text-content-emphasis truncate">
                            {tc('appName')}
                        </span>
                    </div>
                )}
            </div>

            {/* Nav */}
            <nav className="flex-1 p-2 overflow-y-auto" aria-label={tn('mainNavigation')}>
                {sections.map((section, idx) => (
                    <NavSection
                        key={idx}
                        title={section.title}
                        // R12-PR3 — suppress the top hairline on
                        // the first titled section (the very top
                        // of the sidebar). The solo Board section
                        // sits at idx 0 with no title; the first
                        // titled section is "Govern" at idx 1.
                        isFirst={idx === 0 || sections.findIndex((s) => s.title) === idx}
                    >
                        {section.items.map((item) => (
                            <NavItem
                                key={item.href}
                                href={item.href}
                                icon={item.icon}
                                label={item.label}
                                badge={item.badge}
                                badgeLabel={item.badgeLabel}
                                active={pathname.startsWith(item.href)}
                                onClick={onNavClick}
                            />
                        ))}
                    </NavSection>
                ))}
            </nav>

            {/* Driver.js product tour — manual restart entry.
                Renders only when the OnboardingTourProvider is
                mounted (i.e. inside the authenticated tenant
                shell). The auto-trigger handles first-login;
                this button is for the "I want to see it again"
                case. Sits above the search bar so the role row
                in the user block below is the literal last line. */}
            {!collapsed && (
                <div className="mx-2">
                    <StartTourButton />
                </div>
            )}

            {/* Roadmap-2 PR-3 — inline command-palette opener.
                Sits below the scrolling nav and above the user
                block. The chrome's `<SearchAnchor>` is the
                primary affordance on desktop; this row is the
                mobile equivalent (chrome is hidden on <md) AND
                a discoverable secondary anchor on desktop. */}
            <button
                type="button"
                onClick={() => {
                    onNavClick?.();
                    openPalette();
                }}
                className={cn(
                    'mx-2 mb-2 flex items-center rounded-lg border border-border-subtle bg-bg-default px-3 py-2 text-xs text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                    collapsed ? 'justify-center' : 'gap-tight',
                )}
                aria-label={tn('openCommandPalette')}
                data-testid="sidebar-search-anchor"
            >
                <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="7" cy="7" r="5" />
                    <path d="M11 11l3 3" />
                </svg>
                {!collapsed && <span className="flex-1 text-left">{tc('search')}</span>}
                {!collapsed && (
                    <span
                        className="hidden items-center gap-[2px] rounded border border-border-subtle bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-content-subtle md:flex"
                        aria-hidden="true"
                    >
                        <span>⌘</span>
                        <span>K</span>
                    </span>
                )}
            </button>

            {/* User. Admin + Sign-out sit on a single horizontal
                row, vertically centred against the three-line
                identity (name / tenant / role). The role row is
                the literal last line of the sidebar — the tour
                opener was moved above the search bar so nothing
                renders below the identity. Collapsed: identity text is
                dropped and the icons stack centred in the rail. */}
            <div className="p-3 border-t border-border-subtle">
                <div className={cn('flex gap-tight', collapsed ? 'flex-col items-center' : 'items-center justify-between')}>
                    {!collapsed && (
                        <div className="min-w-0">
                            <p className="text-xs font-medium text-content-default truncate">{user.name}</p>
                            <p className="text-xs text-content-muted truncate">{tenant.tenantName}</p>
                            {/* GAP-CI-77: role uses content-muted (not brand-default).
                                The PwC-orange brand colour on light cream is only
                                4.25:1 — below WCAG AA's 4.5:1 for small text — and
                                the role line is informational, not a brand
                                accent. */}
                            <p className="text-xs text-content-muted">{tenant.role}</p>
                        </div>
                    )}
                    <div className={cn('flex gap-tight', collapsed ? 'flex-col items-center' : 'items-center')}>
                        {perms.admin.view && (
                            <Tooltip content={tn('admin')} side={collapsed ? 'right' : 'top'}>
                                <Link
                                    href={tenantHref('/admin')}
                                    aria-label={tn('admin')}
                                    id="admin-icon-link-desktop"
                                    data-testid="nav-admin-icon"
                                    className="icon-btn icon-btn-sm"
                                >
                                    <Gear className="size-4" aria-hidden="true" />
                                </Link>
                            </Tooltip>
                        )}
                        <Tooltip content={tc('signOut')} side={collapsed ? 'right' : 'top'}>
                            <button
                                type="button"
                                onClick={onLogout}
                                aria-label={tc('signOut')}
                                data-testid="nav-logout"
                                className="icon-btn icon-btn-sm"
                            >
                                <UserArrowRight className="size-4" aria-hidden="true" />
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Mobile Drawer — REMOVED (T07, #3076) ───
//
// `MobileDrawer` lived here: a hand-rolled backdrop + panel + `inert`
// bookkeeping, i.e. a second overlay implementation beside the Sheet
// primitive, drifting from it. The phone drawer is now
// `MobileNavDrawer` on `Sheet direction="left"` — T03 added that
// direction for exactly this. The behaviours the hand-rolled version had
// earned did not come for free and are reinstated explicitly there; its
// header is the record of which, and why each.
//
// Nothing imports this any more, so it is gone rather than deprecated: a
// second drawer kept alive is the drift this task removed.
