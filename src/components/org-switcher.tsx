'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic O-4 — Org / Tenant context switcher.
 *
 * A header dropdown that lets the user pivot between:
 *
 *   • the **organization portfolio** — the aggregate CISO view at
 *     `/org/{orgSlug}` (overview, tenant health, drill-downs).
 *
 *   • any **individual child tenant** — the per-tenant workspace at
 *     `/t/{tenantSlug}/dashboard`. An ORG_ADMIN or ORG_OWNER holds an
 *     auto-provisioned ADMIN membership in every child tenant
 *     (`org-provisioning.ts`), which is what opens it. An ORG_READER is
 *     provisioned nothing: a tenant row opens only where they hold a
 *     membership of their own, so the switcher lists an ORG_READER only
 *     the tenants the API marks `isMember` (#5309 item 16, owner decision
 *     2026-11-15). An org admin or owner still sees every tenant.
 *
 * Visual semantics:
 *
 *   - The trigger always shows the **current context** front-and-centre
 *     (org name + "PORTFOLIO" tagline when in org chrome). A future
 *     mount inside the tenant shell would show the tenant name with a
 *     "WORKSPACE" tagline — same primitive, different copy.
 *
 *   - Inside the dropdown: a single "Portfolio overview" entry at the
 *     top (org context, distinguished by its own icon + tagline), then
 *     a divider, then a tenant list. The currently-active context is
 *     marked with the `selected` styling from the Popover primitive.
 *
 * Data:
 *
 *   - The tenant list is fetched lazily on first open from
 *     `GET /api/org/{slug}/tenants` (Epic O-2). Lazy fetch keeps the
 *     org shell's first paint cost zero for users who never open the
 *     switcher (most pageloads).
 *
 *   - We hold a tiny in-component cache so subsequent opens within the
 *     same mount don't re-fetch. The list is small (≤ a few hundred
 *     tenants per org); an explicit refetch path can be added later if
 *     a stale-list bug surfaces.
 *
 * Extending later:
 *
 *   - Mount inside the tenant shell to make it bidirectional. The
 *     `currentSlug` + `currentKind` props already disambiguate the
 *     two callsites.
 *   - Add a search box on top when an org grows past ~12 tenants —
 *     the Combobox primitive (Epic 55) is the canonical reach.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
    Building2,
    Check,
    ChevronsUpDown,
    LayoutDashboard,
    Loader2,
} from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { formatInitials } from '@/lib/format-initials';
import { isOrgAdminTier } from '@/lib/org-roles';

// ── Types ─────────────────────────────────────────────────────────────

export interface OrgSwitcherTenant {
    id: string;
    slug: string;
    name: string;
    /** The viewer holds an ACTIVE membership in this tenant (from the API). */
    isMember?: boolean;
}

export interface OrgSwitcherProps {
    /** Slug of the current organization (always known — the switcher
     *  only mounts inside an org-aware shell). */
    orgSlug: string;
    /** Display name of the current organization. */
    orgName: string;
    /**
     * The viewer's role in the organization. An admin or owner (by
     * `isOrgAdminTier`) is listed every tenant; anybody else, or a viewer
     * whose role is not given, only the tenants they are a member of.
     */
    orgRole?: string | null;
    /** Which context the user is currently viewing. */
    currentKind: 'org' | 'tenant';
    /** When `currentKind === 'tenant'`, the active tenant slug — used to
     *  mark the row as selected and to suppress the "Portfolio" active
     *  state. Ignored when `currentKind === 'org'`. */
    currentTenantSlug?: string | null;
    /** Optional initial tenant list — when supplied, the switcher renders
     *  the list immediately on first open without an API round-trip.
     *  Useful when the parent already fetched the list server-side. */
    initialTenants?: OrgSwitcherTenant[];
}

// ── Component ─────────────────────────────────────────────────────────

export function OrgSwitcher({
    orgSlug,
    orgName,
    orgRole,
    currentKind,
    currentTenantSlug,
    initialTenants,
}: OrgSwitcherProps) {
    const t = useTranslations('org');
    const [open, setOpen] = useState(false);
    const [tenants, setTenants] = useState<OrgSwitcherTenant[] | null>(
        initialTenants ?? null,
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Lazy fetch: only on first open, only when we don't have an
    // initial list. Subsequent opens reuse the cached list.
    useEffect(() => {
        if (!open) return;
        if (tenants !== null) return;
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true);
        setError(null);
        fetch(`/api/org/${orgSlug}/tenants`, { credentials: 'same-origin' })
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(t('switcher.failedLoadTenants', { status: res.status }));
                }
                return res.json() as Promise<{ tenants: OrgSwitcherTenant[] }>;
            })
            .then((body) => {
                if (cancelled) return;
                setTenants(body.tenants ?? []);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : t('switcher.failedLoadTenantsShort'));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, tenants, orgSlug, t]);

    // What the list shows: every tenant to an org admin, otherwise only the
    // tenants this viewer can open.
    const seesEveryTenant = isOrgAdminTier(orgRole);
    const listed = tenants === null
        ? null
        : seesEveryTenant ? tenants : tenants.filter((tn) => tn.isMember === true);

    const portfolioActive = currentKind === 'org';
    const close = useCallback(() => setOpen(false), []);

    const tagline = currentKind === 'org' ? t('switcher.portfolioTagline') : t('switcher.workspaceTagline');

    // Avatar monogram derived from the active org name. Falls back
    // to a neutral '?' when the name is empty/whitespace so the
    // pill never looks broken (the org-server-context guarantees a
    // non-empty name in practice; this is defence-in-depth).
    const avatarInitials = formatInitials(orgName) || '?';

    // Token-aligned row styling — mirrors Popover.Item visuals while
    // letting us render a real <Link> (so middle-click + keyboard
    // navigation work the way users expect).
    const rowClass =
        'flex w-full cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-content-default ' +
        'transition-colors duration-100 ease-out hover:bg-bg-muted hover:text-content-emphasis ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
    const rowSelectedClass = 'bg-bg-subtle text-content-emphasis';

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="start"
            side="bottom"
            sideOffset={6}
            popoverContentClassName="w-[260px] max-w-[calc(100vw-1rem)] p-1"
            content={
                <Popover.Menu aria-label={t('switcher.switchContextAria')}>
                    <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                        {orgName}
                    </p>

                    <Link
                        href={`/org/${orgSlug}`}
                        onClick={close}
                        role="menuitem"
                        data-testid="org-switcher-portfolio"
                        className={
                            portfolioActive
                                ? `${rowClass} ${rowSelectedClass}`
                                : rowClass
                        }
                    >
                        <span className="inline-flex size-4 shrink-0 items-center justify-center text-content-muted">
                            <LayoutDashboard className="size-3.5" aria-hidden="true" />
                        </span>
                        <span className="flex-1 break-words">{t('switcher.portfolioOverview')}</span>
                        {portfolioActive && (
                            <Check className="size-3.5 text-content-info" aria-hidden="true" />
                        )}
                    </Link>

                    <Popover.Separator />

                    <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                        {t('switcher.tenantWorkspaces')}
                    </p>

                    {loading && (
                        <div
                            className="flex items-center gap-tight px-2.5 py-1.5 text-xs text-content-muted"
                            role="status"
                            aria-live="polite"
                        >
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                            {t('switcher.loadingTenants')}
                        </div>
                    )}

                    {error && (
                        <p
                            className="px-2.5 py-1.5 text-xs text-content-error"
                            role="alert"
                            data-testid="org-switcher-error"
                        >
                            {error}
                        </p>
                    )}

                    {!loading && !error && listed !== null && listed.length === 0 && (
                        <p className="px-2.5 py-1.5 text-xs text-content-muted">
                            {t('switcher.emptyTenants')}
                        </p>
                    )}

                    {!loading && listed !== null &&
                        listed.map((t) => {
                            const isActive =
                                currentKind === 'tenant' && currentTenantSlug === t.slug;
                            return (
                                <Link
                                    key={t.id}
                                    href={`/t/${t.slug}/dashboard`}
                                    onClick={close}
                                    role="menuitem"
                                    data-testid={`org-switcher-tenant-${t.slug}`}
                                    className={
                                        isActive
                                            ? `${rowClass} ${rowSelectedClass}`
                                            : rowClass
                                    }
                                >
                                    <span className="inline-flex size-4 shrink-0 items-center justify-center text-content-muted">
                                        <Building2 className="size-3.5" aria-hidden="true" />
                                    </span>
                                    <span className="flex-1 break-words">{t.name}</span>
                                    {isActive && (
                                        <Check
                                            className="size-3.5 text-content-info"
                                            aria-hidden="true"
                                        />
                                    )}
                                </Link>
                            );
                        })}
                </Popover.Menu>
            }
        >
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('switcher.switchOrgContextAria')}
                data-testid="org-switcher-trigger"
                className="flex w-full items-center gap-tight rounded-lg border border-transparent px-2 py-1.5 hover:bg-bg-muted hover:border-border-subtle transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <div
                    className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-emphasis)] to-[var(--brand-default)] flex items-center justify-center flex-shrink-0"
                    aria-hidden="true"
                >
                    <span
                        className="text-content-inverted text-sm font-bold"
                        data-testid="org-switcher-avatar-initials"
                    >
                        {avatarInitials}
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-content-emphasis truncate">
                        {orgName}
                    </p>
                    <p className="text-[10px] uppercase tracking-widest text-content-subtle">
                        {tagline}
                    </p>
                </div>
                <ChevronsUpDown
                    className="size-4 text-content-subtle flex-shrink-0"
                    aria-hidden="true"
                />
            </button>
        </Popover>
    );
}
