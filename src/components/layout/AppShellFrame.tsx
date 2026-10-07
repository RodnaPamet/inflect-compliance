'use client';

/**
 * The app shell's FRAME — layout, drawer state, collapse state. No content.
 *
 * T07 of #3003. `AppShell` grew every decision the authenticated chrome
 * needs, and most of them belong to the host product rather than to the
 * frame: an auth import, two named sidebars, a top bar, a breadcrumbs
 * provider, a storage key spelled inline, and a route regex. A product
 * vendoring these files byte-identical had to carry a diff through all
 * of it.
 *
 * So the frame keeps only what is true of ANY sidebar-plus-top-bar app:
 *
 *   - the viewport-clamp layout chain (the part with real load-bearing
 *     CSS, carried over comment and all — it is the reason this file is
 *     worth extracting rather than reimplementing downstream);
 *   - whether the mobile drawer is open;
 *   - whether the desktop sidebar is collapsed, persisted;
 *   - closing the drawer when the route changes.
 *
 * Everything else arrives as a slot. The slots are render props, not
 * nodes, because each one needs state the frame owns: the sidebar needs
 * `collapsed` and its toggle, the drawer needs `open`/`onClose`, the top
 * bar needs the opener.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each would break reuse:
 *
 *   no auth — `signOut` is next-auth-specific. The consumer passes
 *     whatever its sidebar slot needs.
 *   no route literals — the full-bleed escape was a route regex baked
 *     into the shell. It is now a `fullBleed` boolean, so the caller
 *     decides from its own routing.
 *   no provider knowledge — a breadcrumbs provider must wrap the top bar
 *     AND the content, which sit in different places here. Hence
 *     `mainProvider`: a wrapper the frame applies around the whole main
 *     region, so a consumer can inject context without the frame naming
 *     it.
 *   no storage key — `collapseStorageKey` defaults through
 *     `uiStorageKey`, the T01 seam, so the namespace is the one constant
 *     a downstream product changes.
 *
 * Imported by MODULE PATH rather than the `ui/hooks` barrel. The barrel
 * is the house convention for in-repo consumers and its completeness is
 * guarded; a file written to be copied out takes the path so it arrives
 * with one import to satisfy rather than a barrel to recreate. See the
 * carve-out in `src/components/ui/hooks/index.ts`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useLocalStorage } from '@inflect/ui/components/ui/hooks/use-local-storage';
import { cn } from '@inflect/ui/lib/cn';
import { uiStorageKey } from '@/lib/ui-storage';

export interface AppShellFrameProps {
    /** Desktop rail contents. Receives the collapse state it must paint. */
    sidebar: (props: { collapsed: boolean; onToggleCollapse: () => void }) => ReactNode;
    /** The phone drawer. Receives its own open state and closer. */
    mobileNav: (props: { open: boolean; onClose: () => void }) => ReactNode;
    /**
     * Top bar. Receives the opener for its hamburger, and whether the drawer
     * is open.
     *
     * `mobileNavOpen` is for a SECOND opener the host mounts from this slot
     * (a bottom tab bar's "More" tab, say). A disclosure button has to say
     * whether what it opens is open (`aria-expanded`), and the open state
     * lives here, so without it that button could only ever claim "closed".
     * Read-only on purpose: the drawer still closes itself, through
     * `mobileNav`'s `onClose`.
     */
    topChrome: (props: { onMobileMenuClick: () => void; mobileNavOpen: boolean }) => ReactNode;
    /**
     * Wraps the whole main region — top bar AND content — so a consumer
     * can supply context that must span both. Identity-stable callers
     * only: this runs on every render.
     */
    mainProvider?: (node: ReactNode) => ReactNode;
    /**
     * Drop the reading column's width cap and centering for an
     * edge-to-edge surface (a canvas, an editor). The frame does not
     * inspect the route to decide this.
     */
    fullBleed?: boolean;
    /** Defaults to `uiStorageKey('sidebar-collapsed')`. */
    collapseStorageKey?: string;
    children: ReactNode;
}

export function AppShellFrame({
    sidebar,
    mobileNav,
    topChrome,
    mainProvider,
    fullBleed = false,
    collapseStorageKey,
    children,
}: AppShellFrameProps) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    // Persisted so the choice survives navigation + reloads. The mobile
    // drawer is never collapsed.
    const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage(
        collapseStorageKey ?? uiStorageKey('sidebar-collapsed'),
        false,
    );
    const toggleSidebarCollapsed = useCallback(
        () => setSidebarCollapsed((c) => !c),
        [setSidebarCollapsed],
    );
    const closeDrawer = useCallback(() => setDrawerOpen(false), []);
    const openDrawer = useCallback(() => setDrawerOpen(true), []);

    // Close the drawer when the route changes. Compared against the
    // PREVIOUS value rather than firing on every pathname render, so a
    // drawer the user just opened on the current route stays open.
    const pathname = usePathname();
    const prevPathname = useRef(pathname);
    useEffect(() => {
        if (prevPathname.current !== pathname) {
            setDrawerOpen(false);
            prevPathname.current = pathname;
        }
    }, [pathname]);

    const main = (
        <>
            {/* Wrapped rather than prop-drilled: the chrome composes
                several bars and giving each a no-print prop would be a
                wider change than the print rule needs. */}
            <div className="no-print">{topChrome({ onMobileMenuClick: openDrawer, mobileNavOpen: drawerOpen })}</div>

            {/* Inner content container.
                Mobile: padding + max-width + centering.
                Desktop: ALSO a flex column itself, so a child shell can
                claim flex-1 to fill height. Without `md:flex md:flex-col`
                here a child falls back to natural height and this div's
                overflow-y-auto scrolls instead of the child scrolling
                internally.

                The width cap climbs at 2xl and unblocks beyond, so a 4K
                screen does not leave the page in a narrow column;
                `mx-auto` keeps it centred at every step. `fullBleed`
                drops both for an edge-to-edge surface — padding stays. */}
            {/* THE `<main>` LANDMARK SITS HERE, not on the column that
                holds both this and the top bar (#3104).

                It used to wrap both, which put `NavBar`'s
                `<header role="banner">` INSIDE the main landmark — axe
                `landmark-banner-is-top-level`, measured moderate by projectZ
                T19 on a vendored copy of this frame, which had to suppress
                the rule to stay green. A screen reader's "jump to banner"
                then lands inside "jump to main".

                The two elements swapped names and NOT classes: every flex,
                overflow and min-h-0 class stayed on the element it was on,
                so the layout chain described above is byte-identical. What
                changed is which of them is the landmark — and this is the
                honest one, because `<main>` means the page's main content,
                which is exactly what this container holds. */}
            <main
                className={cn(
                    'p-4 md:p-6 md:flex md:flex-col md:flex-1 md:min-h-0 md:overflow-y-auto md:w-full',
                    fullBleed
                        ? null
                        : 'max-w-7xl 2xl:max-w-screen-2xl 3xl:max-w-none mx-auto',
                )}
            >
                {children}
            </main>
        </>
    );

    // Layout chain:
    //   Mobile (<md): natural document scroll. `min-h-screen` on the
    //     wrapper, `overflow-auto` on the main-region column, no flex column.
    //   Desktop (md+): viewport-clamped flex chain. Wrapper is
    //     `h-full overflow-hidden`, the main-region column a flex column
    //     with `overflow-hidden`.
    //
    // "main-region column" rather than "<main>" since #3104: the element
    // carrying these classes is a plain <div>, and the `<main>` landmark is
    // the content container inside it. The classes did not move.
    //
    // Every flex parent carries `min-h-0` so children can shrink below
    // their content size — without it `flex-1` grows to content and the
    // chain breaks.
    //
    // `md:h-full` relies on the html/body height lock in globals.css.
    // `min-h-screen` is the mobile fallback: below md the body scrolls
    // naturally and this keeps the shell filling the visible viewport.
    return (
        <div className="min-h-screen md:h-full md:overflow-hidden flex">
            {/* `no-print`: the print rule hides only elements carrying
                that class, and no shell chrome carried it — so a print
                view living under this shell put the nav rail on every
                page of the artefact. Marking the chrome is narrower than
                moving the route out of the layout, which genuinely wants
                the layout's providers, just not its furniture. */}
            <aside
                className={cn(
                    'no-print',
                    'hidden md:flex bg-bg-default border-r border-border-subtle flex-col flex-shrink-0 transition-[width] duration-200 ease-out',
                    sidebarCollapsed ? 'md:w-14' : 'md:w-[180px]',
                )}
                data-collapsed={sidebarCollapsed ? 'true' : 'false'}
            >
                {sidebar({
                    collapsed: sidebarCollapsed,
                    onToggleCollapse: toggleSidebarCollapsed,
                })}
            </aside>

            {mobileNav({ open: drawerOpen, onClose: closeDrawer })}

            {/* The main REGION — top bar plus content — but deliberately not
                the `<main>` landmark; see the comment at the content
                container. `mainProvider` still wraps both, which is what its
                contract promises. */}
            <div className="flex-1 overflow-auto md:overflow-hidden md:flex md:flex-col min-w-0 md:min-h-0">
                {mainProvider ? mainProvider(main) : main}
            </div>
        </div>
    );
}
