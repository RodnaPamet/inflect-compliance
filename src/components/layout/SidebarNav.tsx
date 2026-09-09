'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantContext, useTenantHref, usePermissions } from '@/lib/tenant-context-provider';
import { Tooltip } from '@/components/ui/tooltip';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import { StartTourButton } from '@/components/ui/OnboardingTour';
import { useCommandPalette } from '@/components/command-palette/command-palette-provider';
import {
    X,
    LayoutDashboard,
    Building2,
    AlertTriangle,
    ShieldCheck,
    Paperclip,
    FileText,
    ClipboardList,
    ClipboardCheck,
    FlaskConical,
    Truck,
    BarChart3,
    Settings,
    LogOut,
    Calendar as CalendarIcon,
    Workflow,
    Menu,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useCalendarBadge } from './use-calendar-badge';
import { NavItem } from './nav-item';
import { NavSection } from './nav-section';
import { useSidebarCollapsed } from './sidebar-collapse-context';

// ─── Types ───

interface NavItemDef {
    href: string;
    label: string;
    icon: LucideIcon;
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
                { href: tenantHref('/dashboard'), label: t('dashboard'), icon: LayoutDashboard },
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
                { href: tenantHref('/assets'), label: t('assets'), icon: Building2 },
                { href: tenantHref('/risks'), label: t('risks'), icon: AlertTriangle },
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
                { href: tenantHref('/audits'), label: t('audits'), icon: ClipboardCheck },
                { href: tenantHref('/tasks'), label: t('tasks'), icon: ClipboardList },
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
                { href: tenantHref('/tests'), label: t('tests'), icon: FlaskConical },
                { href: tenantHref('/evidence'), label: t('evidence'), icon: Paperclip },
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
                { href: tenantHref('/policies'), label: t('policies'), icon: FileText },
                { href: tenantHref('/vendors'), label: t('vendors'), icon: Truck },
                // R25-PR-A — Processes canvas. Visual mapping of
                // business + IT processes with controls placed on
                // the connections between steps. Sits under Manage
                // alongside Policy + Vendor — same governance-tool
                // tier.
                { href: tenantHref('/processes'), label: t('processes'), icon: Workflow },
                { href: tenantHref('/reports'), label: t('reports'), icon: BarChart3, visible: perms.reports.view },
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
                        <Menu className="h-5 w-5 shrink-0" aria-hidden="true" />
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
                                    <Settings className="size-4" aria-hidden="true" />
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
                                <LogOut className="size-4" aria-hidden="true" />
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Mobile Drawer ───

interface MobileDrawerProps {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
}

export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
    const pathname = usePathname();
    const tn = useTranslations('nav');

    // Close on route change (always close to avoid stale open state)
    useEffect(() => {
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    // Close on Escape — routed through the shared shortcut system so
    // it respects precedence against any other Escape binding that
    // might happen to be active, and so a contributor grepping for
    // shortcut sources finds it via `useKeyboardShortcut` like every
    // other binding in the app.
    //
    // `scope: 'overlay'` + priority 5 means:
    //   - Fires only while the drawer is mounted (via the
    //     `data-sheet-overlay` marker on the backdrop below).
    //   - Beats selection-clear (priority 2) and filter-clear
    //     (priority 1) if both are somehow simultaneously active.
    //   - Loses to any modal stacking above the drawer (those
    //     override via Radix's native Escape inside their portal).
    useKeyboardShortcut('Escape', onClose, {
        enabled: open,
        scope: 'overlay',
        priority: 5,
        description: 'Close navigation drawer',
    });

    // Return focus to whatever opened the drawer.
    //
    // This is the other half of making the closed drawer `inert`, not a
    // separate nicety. Focus does not survive its own container becoming
    // inert: the browser moves it to `<body>`, so a keyboard user who opened
    // the drawer, tabbed into it and closed it lands at the top of the
    // document with no idea where they are. Before the drawer was inert the
    // focus simply STAYED on an off-screen element, which was worse and is
    // why this was not visible as a bug — one broken behaviour was hiding
    // another.
    //
    // The opener is captured rather than passed in: the trigger lives in a
    // sibling component (the header's hamburger), and threading a ref through
    // `AppShell` to reach it would couple two components that currently share
    // only `open`/`onClose`. `document.activeElement` at the moment of opening
    // is the same element in every path that can open this.
    const openerRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (open) {
            openerRef.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            return;
        }
        const opener = openerRef.current;
        openerRef.current = null;
        // Only reclaim focus the drawer is actually losing. On first mount —
        // and on any close the user did not trigger from inside — focus is
        // somewhere legitimate and stealing it would be its own bug.
        if (opener && opener.isConnected && document.activeElement === document.body) {
            opener.focus();
        }
    }, [open]);

    // Lock body scroll when open
    useEffect(() => {
        if (open) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => { document.body.style.overflow = ''; };
    }, [open]);

    return (
        <>
            {/* Backdrop.
                `data-sheet-overlay` is picked up by the shortcut
                registry's overlay selector, so while the drawer is
                open any `scope: 'global'` shortcut (filter clear,
                selection clear, etc.) stands down automatically. */}
            <div
                className={`
                    fixed inset-0 z-40 bg-black/60 backdrop-blur-sm
                    transition-opacity duration-300
                    ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
                `}
                onClick={onClose}
                aria-hidden="true"
                data-testid="nav-drawer-backdrop"
                data-sheet-overlay={open ? 'true' : undefined}
            />

            {/* Drawer.

                A CLOSED drawer stays MOUNTED — the transform below is the
                open/close animation and unmounting would delete it, along with
                the motion-language transition every overlay in this codebase
                shares — so "closed" has to be expressed to assistive tech and
                to the tab order by attribute, not by absence. Off-screen is a
                visual state and nothing more: a `translate-x` moves no element
                out of the accessibility tree and takes nothing out of the tab
                order, so before this the drawer's close button and every nav
                link in `children` were reachable by Tab from any page, and a
                screen reader was told a modal dialog was open at all times.

                `inert` is the single answer in a browser: it makes the whole
                subtree unfocusable AND hides it from the accessibility tree.
                The older recipe — `aria-hidden` plus `tabIndex={-1}` on every
                focusable descendant — is worse here for a concrete reason, not
                a stylistic one: the descendants are `children` supplied by
                `AppShell`, so the sweep would have to reach into markup this
                component does not own and be re-applied by every future caller.
                React 19 supports `inert` as a boolean prop (React 18 needed the
                `inert=""` string hack); the repo is on 19.2, so this renders.

                `aria-hidden` rides along as the compatibility half, and it is
                NOT redundant with `inert` in practice: axe's role queries,
                Playwright's role engine, jsdom/Testing-Library and pre-2022
                Safari/Firefox all honour `aria-hidden` and none of them
                implement `inert` — Playwright resolving `getByRole('dialog')`
                to this node is how the bug was found. Pairing the two is safe:
                `aria-hidden` over focusable descendants is a violation only
                while they are still focusable, and axe-core resolves `inert`
                (`isInertAncestors`) before that rule fires.

                `aria-modal` is a claim about the REST of the page — "everything
                outside me is inert" — so it is asserted only while the drawer
                is actually open. Stated unconditionally it was false in the
                state the drawer spends nearly all its life in. */}
            <div
                className={`
                    fixed inset-y-0 left-0 z-50 w-64 bg-bg-default border-r border-border-subtle
                    transform transition-transform duration-300 ease-in-out
                    ${open ? 'translate-x-0' : '-translate-x-full'}
                `}
                role="dialog"
                aria-modal={open ? true : undefined}
                aria-hidden={open ? undefined : true}
                inert={!open}
                aria-label={tn('navigationMenu')}
                data-testid="nav-drawer"
                data-open={open ? 'true' : 'false'}
            >
                {/* Close button — 44px touch target.
                    Elevation PR-3 — adds canonical focus ring + uses
                    transition-colors (motion-language compliant). */}
                <button
                    type="button"
                    className="absolute top-3 right-3 p-2 rounded-lg text-content-muted hover:text-content-emphasis hover:bg-bg-muted transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    onClick={onClose}
                    aria-label={tn('closeNavigation')}
                    data-testid="nav-drawer-close"
                >
                    <X className="w-5 h-5" />
                </button>

                {children}
            </div>
        </>
    );
}
