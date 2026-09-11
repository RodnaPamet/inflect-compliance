'use client';

/**
 * Epic 57 — navigation and action commands for the Command Palette.
 *
 * The palette hosts two tightly curated command buckets:
 *
 *   - **Navigation**: one entry per high-traffic route. These map
 *     1:1 to the sidebar so users who know the sidebar learn the
 *     palette for free. The list stays short by design — admin
 *     sub-pages and per-entity settings stay out so the palette
 *     doesn't become a route dump.
 *
 *   - **Actions**: only two, and both are universally safe —
 *     `Toggle theme` and `Sign out`. Destructive or permission-gated
 *     actions (delete, archive, publish, role changes) are
 *     deliberately excluded; running them from the palette bypasses
 *     the confirmation UX their dedicated surfaces provide.
 *
 * All navigation commands are tenant-scoped via `/t/<slug>/...` so the
 * same URL-derived slug that powers entity search powers them too.
 * Outside a tenant route this hook returns an empty list, so the
 * palette on `/login` only shows the keyboard-shortcut discoverability
 * group.
 *
 * Permissions: the palette lists admin / reports entries for every
 * user, and relies on the routes' own server-side gates to deny
 * access. This matches the sidebar's defence-in-depth posture — a
 * client-side filter is a suggestion, never a security boundary.
 */

import {
    Activity,
    Calendar as CalendarIcon,
    ClipboardList,
    FileText,
    Layers,
    LayoutDashboard,
    LogOut,
    Moon,
    Paperclip,
    Settings,
    ShieldCheck,
    Triangle,
    Truck,
    type LucideIcon,
} from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useCallback, useMemo, type ComponentType, type SVGProps } from 'react';

import { Robot } from '@/components/ui/icons/nucleo';
import { useTheme } from '@/components/theme/ThemeProvider';

export type PaletteCommandGroup = 'Navigation' | 'Actions';

/**
 * Either icon family. Nucleo components are plain
 * `(props: SVGProps<SVGSVGElement>) => Element` functions and are NOT
 * assignable to lucide's `ForwardRefExoticComponent`; the agentic entries use
 * Nucleo `Robot`, which is the canonical family and already the glyph on every
 * agent surface. See the identical widening on `NavItemProps.icon`.
 */
export type PaletteGlyph = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;

export interface PaletteCommand {
    id: string;
    group: PaletteCommandGroup;
    label: string;
    icon: PaletteGlyph;
    /** Populated for `Navigation` commands. */
    href?: string;
    /** Populated for `Actions`. Closes the palette automatically after invocation. */
    perform?: () => void;
}

function tenantPath(slug: string, path: string): string {
    return `/t/${encodeURIComponent(slug)}${path}`;
}

export function usePaletteCommands(tenantSlug: string | null): PaletteCommand[] {
    const { toggle: toggleTheme } = useTheme();
    const doSignOut = useCallback(() => {
        void signOut({ callbackUrl: '/login' });
    }, []);

    return useMemo<PaletteCommand[]>(() => {
        if (!tenantSlug) return [];
        const href = (path: string) => tenantPath(tenantSlug, path);
        return [
            // ─── Navigation ───────────────────────────────────────────
            {
                id: 'nav:dashboard',
                group: 'Navigation',
                label: 'Go to Dashboard',
                icon: LayoutDashboard,
                href: href('/dashboard'),
            },
            {
                id: 'nav:controls',
                group: 'Navigation',
                label: 'Go to Controls',
                icon: ShieldCheck,
                href: href('/controls'),
            },
            {
                id: 'nav:risks',
                group: 'Navigation',
                label: 'Go to Risks',
                icon: Triangle,
                href: href('/risks'),
            },
            {
                id: 'nav:policies',
                group: 'Navigation',
                label: 'Go to Policies',
                icon: FileText,
                href: href('/policies'),
            },
            {
                id: 'nav:evidence',
                group: 'Navigation',
                label: 'Go to Evidence',
                icon: Paperclip,
                href: href('/evidence'),
            },
            {
                id: 'nav:tasks',
                group: 'Navigation',
                label: 'Go to Tasks',
                icon: ClipboardList,
                href: href('/tasks'),
            },
            {
                id: 'nav:calendar',
                group: 'Navigation',
                label: 'Go to Calendar',
                icon: CalendarIcon,
                href: href('/calendar'),
            },
            {
                id: 'nav:frameworks',
                group: 'Navigation',
                label: 'Go to Frameworks',
                icon: Layers,
                href: href('/frameworks'),
            },
            {
                id: 'nav:vendors',
                group: 'Navigation',
                label: 'Go to Vendors',
                icon: Truck,
                href: href('/vendors'),
            },
            {
                id: 'nav:reports',
                group: 'Navigation',
                label: 'Go to Reports',
                icon: Activity,
                href: href('/reports'),
            },
            // ─── Agentic (#2440) ──────────────────────────────────────
            //
            // The palette had ZERO agentic entries, on a product whose
            // agentic surfaces were reachable only through one pill
            // labelled "MCP". Three, not five: the register is the
            // sidebar-tier destination, and the other two are the
            // surfaces an operator types their way to under time
            // pressure — a queue somebody is waiting on, and the record
            // of what was refused.
            //
            // Labelled by DESTINATION rather than by acronym. "Go to
            // MCP" was untypeable for anyone who did not already know
            // the protocol's name, which is the whole navigation defect
            // this prompt is about. Every label here carries the word
            // "agent" so one query finds all three.
            //
            // Not permission-filtered, matching every other entry in
            // this list and the sidebar's documented defence-in-depth
            // posture: each destination carries its own server-side
            // gate, and a client-side filter is a suggestion, never a
            // boundary. See the module header.
            {
                id: 'nav:agents',
                group: 'Navigation',
                label: 'Go to Agent register',
                icon: Robot,
                href: href('/agents'),
            },
            {
                id: 'nav:agent-proposals',
                group: 'Navigation',
                label: 'Go to Agent proposals',
                icon: Robot,
                href: href('/agents/proposals'),
            },
            {
                id: 'nav:agent-quarantine',
                group: 'Navigation',
                label: 'Go to Agent quarantine',
                icon: Robot,
                href: href('/agents/quarantine'),
            },
            {
                id: 'nav:admin',
                group: 'Navigation',
                label: 'Go to Admin',
                icon: Settings,
                href: href('/admin'),
            },
            // ─── Actions (safe, low-risk only) ────────────────────────
            {
                id: 'action:toggle-theme',
                group: 'Actions',
                label: 'Toggle theme',
                icon: Moon,
                perform: toggleTheme,
            },
            {
                id: 'action:sign-out',
                group: 'Actions',
                label: 'Sign out',
                icon: LogOut,
                perform: doSignOut,
            },
        ];
    }, [tenantSlug, toggleTheme, doSignOut]);
}

/**
 * Case-insensitive substring filter on the command label. cmdk's own
 * filter is disabled at the palette level (entity search is
 * backend-filtered), so the palette owns command filtering here.
 */
export function filterPaletteCommands(
    commands: PaletteCommand[],
    query: string,
): PaletteCommand[] {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
}
