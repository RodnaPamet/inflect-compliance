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
 *     That exclusion is why the two agentic VERBS (`Suspend an agent`,
 *     `Kill switch`, #2558) are Navigation rows and not Actions: a
 *     kill committed from a palette row would skip the engage modal's
 *     required reason and typed-slug tenant confirmation, which are
 *     the only things between "stop this agent" and "stop everything".
 *     A verb-labelled DESTINATION makes the word typeable and leaves
 *     the lever one click away, without eroding the rule above.
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
    /**
     * MATCH-ONLY vocabulary. Never rendered — `command-palette.tsx` draws
     * `label` and nothing else.
     *
     * This is the channel for words an operator TYPES but which must not be
     * the row's name. The agentic entries below are labelled by destination
     * rather than by acronym on purpose (see the comment at their site), so
     * with label-only matching "MCP", "autonomy" and "AI" were unreachable —
     * a word was either on screen or it found nothing, and widening the
     * labels to cover them would undo that naming fix. Keywords separate the
     * two axes: the label stays the thing a reader understands, the keywords
     * are the things a searcher tries.
     */
    keywords?: readonly string[];
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
            // labelled "MCP". Three DESTINATIONS: the register is the
            // sidebar-tier one, and the other two are the surfaces an
            // operator types their way to under time pressure — a queue
            // somebody is waiting on, and the record of what was
            // refused.
            //
            // Three was never the whole list. The prompt named two
            // VERBS alongside them — "Suspend an agent" and "Kill
            // switch" — and they were silently dropped; they ship below
            // (#2558), as Navigation rows for the reason the module
            // header gives. So: five entries, three destinations and
            // two verbs, not "three, not five".
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
            //
            // The keywords below are the OTHER half of that decision. Of
            // the five words an operator was told to be able to type —
            // AI, autonomy, MCP, kill, agent — only `agent` appears in a
            // destination label and the rest must not, so each lands on
            // the destination its typist wants: the register is where an
            // agent is suspended or killed from, the proposal queue is
            // what "approvals" means for agents, and quarantine is where
            // a blocked one is held. `kill` and `suspend` stay on the
            // register even now that the verb rows exist — the register
            // remains a truthful answer to both, and the two rows are
            // ordered so the destination comes first.
            {
                id: 'nav:agents',
                group: 'Navigation',
                label: 'Go to Agent register',
                icon: Robot,
                href: href('/agents'),
                keywords: [
                    'agent',
                    'agents',
                    'AI',
                    'autonomy',
                    'autonomous',
                    'MCP',
                    'robot',
                    'register',
                    'kill',
                    'kill switch',
                    'suspend',
                ],
            },
            {
                id: 'nav:agent-proposals',
                group: 'Navigation',
                label: 'Go to Agent proposals',
                icon: Robot,
                href: href('/agents/proposals'),
                keywords: [
                    'agent',
                    'AI',
                    'MCP',
                    'approval',
                    'approvals',
                    'review',
                    'awaiting',
                    'human',
                ],
            },
            {
                id: 'nav:agent-quarantine',
                group: 'Navigation',
                label: 'Go to Agent quarantine',
                icon: Robot,
                href: href('/agents/quarantine'),
                keywords: [
                    'agent',
                    'AI',
                    'MCP',
                    'held',
                    'blocked',
                    'provenance',
                ],
            },
            // ─── Agentic verbs (#2558) ────────────────────────────────
            //
            // The two words an operator reaches for under pressure. They
            // are labelled by VERB, which is the deliberate inverse of
            // the three rows above: there the word had to stay off the
            // label and ride the keyword channel, here the word IS the
            // label, because "kill" and "suspend" are what the operator
            // is trying to do rather than a name for a page.
            //
            // Consequence worth stating: the keywords on these two carry
            // only SYNONYMS of the verb, never the verb itself. A
            // keyword duplicating its own label buys no reach and costs
            // the only thing that proves these rows work — rename the
            // label and the typed word must stop finding the row.
            //
            // `Suspend an agent` lands on the register filtered to
            // ACTIVE because ACTIVE is exactly the suspendable set
            // (`tabs/OverviewTab.tsx`: `canSuspend = canManageRegistry
            // && agent.status === 'ACTIVE'`). `parseAgentListFilters`
            // already parses `?status=` server-side, so this is a deep
            // link into machinery that shipped, not a new route.
            //
            // `Kill switch` lands on the plain register: the engage
            // control lives in the agent detail header
            // (`AgentDetailClient.tsx` → `AgentKillSwitchAction`), and a
            // kill applies regardless of status, so the register is the
            // step before it either way. Sharing a destination with `Go
            // to Agent register` is the point — the verb exists so the
            // WORD is typeable, not because there is a second page.
            {
                id: 'nav:agent-suspend',
                group: 'Navigation',
                label: 'Suspend an agent',
                icon: Robot,
                href: href('/agents?status=ACTIVE'),
                keywords: ['pause', 'disable', 'deactivate', 'stop', 'halt'],
            },
            {
                id: 'nav:agent-kill-switch',
                group: 'Navigation',
                label: 'Kill switch',
                icon: Robot,
                href: href('/agents'),
                keywords: [
                    'agent',
                    'agents',
                    'emergency',
                    'halt',
                    'stop',
                    'shutdown',
                    'panic',
                    'disable',
                    'revoke',
                ],
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
 * Case-insensitive substring filter on the command label OR any of its
 * match-only `keywords`. cmdk's own filter is disabled at the palette level
 * (`command-palette.tsx` passes `shouldFilter={false}`, because entity search
 * is backend-filtered), so this is not one matcher of two — it is the whole
 * command-matching mechanism, and a word absent from both channels here
 * reaches the palette's empty state.
 */
export function filterPaletteCommands(
    commands: PaletteCommand[],
    query: string,
): PaletteCommand[] {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
        (c) =>
            c.label.toLowerCase().includes(q) ||
            c.keywords?.some((k) => k.toLowerCase().includes(q)),
    );
}
