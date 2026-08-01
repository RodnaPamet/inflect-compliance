'use client';

/**
 * Roadmap-14 PR-4 — `<TenantSwitcher>` — replaces the passive
 * `<TenantIdentityPill>` in the top-bar's right slot.
 *
 * The pre-R14 pill was a `<Link>` to `/tenants` (the post-sign-in
 * picker). Functional, but two clicks + a page navigation for a
 * verb the user runs constantly: "show me a different workspace".
 * R14-PR4 makes the verb inline — the trigger pill stays in place,
 * a click opens a popover listing every tenant the user belongs to,
 * the active one is marked, and the choice is one keystroke away.
 *
 * Data: memberships read from the NextAuth session JWT
 * (`session.user.memberships`), shape `{ slug, role, tenantId }`.
 * Lazy: no fetch on first paint; the data is already in the JWT
 * cookie by the time the switcher mounts. The JWT list is capped at
 * `MAX_JWT_MEMBERSHIPS` (auth.ts) so the cookie stays bounded — for
 * the rare user above the cap the switcher shows the capped subset,
 * and the "Manage workspaces" link routes to the `/tenants` picker,
 * which queries the COMPLETE list server-side.
 *
 * Visual: same pill geometry as the R2 `TenantIdentityPill` (small
 * radius, brand-subtle avatar, content-muted text → emphasis on
 * hover) plus a chevron-down to advertise the popover. The eye
 * reads "this is the same surface, now it does more."
 *
 * What this component does NOT do:
 *
 *   • Show tenant DISPLAY NAMES. The JWT only carries slugs (the
 *     `/tenants` picker page has the same limitation). Names would
 *     require a new API surface; out of scope for PR-4.
 *
 *   • Manage organization context. R14-PR4 scope was "tenants
 *     only" (per the planning question). Org variant continues to
 *     mount `<OrgIdentityPill>` until a future PR extends.
 *
 *   • Live-search through memberships. The membership list is
 *     bounded by the JWT cap (`MAX_JWT_MEMBERSHIPS`); rendering all
 *     items + scroll is faster than a search-by-typing flow at
 *     that scale. The shared `<Combobox>` primitive auto-virtualizes
 *     past 50 items if a user ever exceeds — but PR-4 keeps the
 *     simpler list rendering for clarity.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { NAV_BAR_SLOT_PRESS } from './nav-bar';
import { HIT_AREA_CLASS } from '@/components/ui/hit-area';

// ─── Types ─────────────────────────────────────────────────────────

export interface TenantSwitcherMembership {
    slug: string;
    role: string;
    tenantId: string;
}

/**
 * B4 (2026-05-24) — organization memberships threaded into the
 * switcher. Pre-B4 the popover only listed tenant workspaces; orgs
 * were reachable only via the separate (hidden) `<OrgIdentityPill>`
 * surface. The combined picker makes the membership graph explicit
 * — the user sees both contexts and chooses which one to switch to.
 */
export interface TenantSwitcherOrgMembership {
    slug: string;
    role: string;
    organizationId: string;
}

export interface TenantSwitcherProps {
    /**
     * Memberships threaded from the server-side layout (via
     * `<AppShell>` → `<TopChrome>` → here). Replaces the original
     * R14-PR4 `useSession()` call that violated the project's
     * no-SessionProvider convention.
     */
    memberships: TenantSwitcherMembership[];
    /**
     * Optional. When provided + non-empty, the popover renders a
     * second section labelled "Organizations" above the workspaces
     * list. Each row links to `/org/{slug}`. The trigger pill stays
     * tenant-named (the active context is always a tenant on a
     * tenant-scoped page); B7 will revisit when the layout
     * redesign introduces a dedicated org-context affordance.
     */
    orgMemberships?: TenantSwitcherOrgMembership[];
}

// ─── Recipe (extracted so PR-11 can compose the unified slot recipe) ──

/**
 * Pill recipe — preserves the R2 `<TenantIdentityPill>` shape so
 * the visual continuity is unbroken. The chevron is the only
 * visible difference between the R2 pill and the R14 switcher.
 */
const SWITCHER_PILL_CLASS =
    // R14-PR12 — `hidden sm:inline-flex` hides the workspace
    // switcher on the narrowest viewports (mobile portrait).
    // The unified chrome puts a lot of slots in the right-hand
    // region; on a 375px iPhone SE viewport the switcher would
    // crowd the bell + avatar. Users on those viewports can
    // switch workspaces via the `/tenants` picker page (linked
    // from the user menu footer).
    // Height matches the org-mode pill (<OrgWorkspaceSwitcher>): `py-1`
    // padding rather than a fixed `h-[22px]`, so the tenant + org switchers
    // are the same height across both shells.
    `relative hidden sm:inline-flex items-center gap-tight rounded-full border border-border-subtle bg-bg-default px-3 py-1 text-xs font-medium text-content-muted transition-colors hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${NAV_BAR_SLOT_PRESS} ${HIT_AREA_CLASS}`;

const MENU_ROW_CLASS =
    'flex w-full cursor-pointer select-none items-center justify-between gap-default rounded-md px-2.5 py-1.5 text-left text-sm text-content-default transition-colors duration-100 ease-out hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

const MENU_ROW_ACTIVE_CLASS = 'bg-bg-subtle text-content-emphasis';

export function TenantSwitcher({
    memberships,
    orgMemberships,
}: TenantSwitcherProps) {
    const { tenantName, tenantSlug } = useTenantContext();
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const orgs = orgMemberships ?? [];

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={6}
            popoverContentClassName="w-[240px] p-1"
            content={
                <Popover.Menu aria-label="Switch context">
                    {/* B4 — organizations section appears above
                        workspaces when the user belongs to one or
                        more orgs. The header copy + popover aria-
                        label widen from "tenant" to "context" so
                        the surface honestly reflects both. */}
                    {orgs.length > 0 && (
                        <>
                            <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                                Organizations
                            </p>
                            {orgs.map((o) => (
                                <Link
                                    key={o.slug}
                                    href={`/org/${o.slug}`}
                                    onClick={close}
                                    role="menuitem"
                                    data-testid={`tenant-switcher-org-${o.slug}`}
                                    className={MENU_ROW_CLASS}
                                >
                                    <span className="flex items-center gap-compact min-w-0">
                                        <InitialsAvatar value={o.slug} mode="slug" />
                                        <span className="flex flex-col min-w-0">
                                            <span className="break-words text-content-emphasis">
                                                {o.slug}
                                            </span>
                                            <span className="break-words text-[10px] text-content-subtle">
                                                org · {o.role.toLowerCase().replace('org_', '')}
                                            </span>
                                        </span>
                                    </span>
                                </Link>
                            ))}
                            <Popover.Separator />
                        </>
                    )}
                    <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                        Workspaces
                    </p>

                    {memberships.length === 0 ? (
                        // Defence-in-depth: a tenant page with no
                        // membership rows in the JWT would normally
                        // 404 at the middleware gate, but if the
                        // popover renders before hydration completes
                        // we still want a graceful empty state.
                        <p className="px-2.5 py-3 text-xs text-content-muted">
                            No workspaces in this session.
                        </p>
                    ) : (
                        memberships.map((m) => {
                            const isActive = m.slug === tenantSlug;
                            return (
                                <Link
                                    key={m.slug}
                                    href={`/t/${m.slug}/dashboard`}
                                    onClick={close}
                                    role="menuitem"
                                    aria-current={isActive ? 'page' : undefined}
                                    data-testid={`tenant-switcher-row-${m.slug}`}
                                    className={`${MENU_ROW_CLASS} ${isActive ? MENU_ROW_ACTIVE_CLASS : ''}`}
                                >
                                    <span className="flex items-center gap-compact min-w-0">
                                        <InitialsAvatar value={m.slug} mode="slug" />
                                        <span className="flex flex-col min-w-0">
                                            <span className="break-words text-content-emphasis">
                                                {m.slug}
                                            </span>
                                            <span className="break-words text-[10px] text-content-subtle">
                                                {m.role.toLowerCase()}
                                            </span>
                                        </span>
                                    </span>
                                    {isActive && (
                                        <Check
                                            className="h-4 w-4 flex-shrink-0 text-[var(--brand-default)]"
                                            aria-hidden="true"
                                        />
                                    )}
                                </Link>
                            );
                        })
                    )}

                    <Popover.Separator />

                    <Link
                        href="/tenants"
                        onClick={close}
                        role="menuitem"
                        data-testid="tenant-switcher-manage"
                        className={MENU_ROW_CLASS}
                    >
                        <span className="text-content-muted">
                            Manage workspaces
                        </span>
                    </Link>
                </Popover.Menu>
            }
        >
            <button
                type="button"
                className={SWITCHER_PILL_CLASS}
                aria-label={`Current workspace: ${tenantName}. Click to switch.`}
                aria-expanded={open}
                aria-haspopup="menu"
                data-testid="top-chrome-tenant-switcher"
            >
                <InitialsAvatar value={tenantSlug} mode="slug" />
                <span className="max-w-trunc-tight truncate">{tenantName}</span>
                <ChevronsUpDown
                    className="h-3 w-3 flex-shrink-0 text-content-subtle"
                    aria-hidden="true"
                />
            </button>
        </Popover>
    );
}
