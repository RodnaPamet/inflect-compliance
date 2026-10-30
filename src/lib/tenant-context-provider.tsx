'use client';

import { createContext, useContext, useCallback } from 'react';
import type { Role } from '@prisma/client';
import type { PermissionSet } from '@/lib/permissions';

// ─── Tenant context ───

export interface TenantContextValue {
    /**
     * The authenticated user's id. Resolved server-side in the tenant layout
     * and threaded through here so client components can read it WITHOUT
     * `useSession()` — the app deliberately mounts no `<SessionProvider>`, so
     * `useSession()` returns undefined and throws on destructure.
     */
    userId: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    /** RQ3-OB-A — display currency for monetary surfaces (default €). */
    currencySymbol?: string;
    role: Role;
    /**
     * The role on the user's own membership row, before any custom role. `role`
     * is a custom role's base when the membership carries one; this is what the
     * edge's admin gate reads, so the admin layout and the sidebar's admin link
     * read it too (#4581 B). The tenant layout always sets it; absent reads as
     * "may not open the admin console".
     */
    membershipRole?: Role;
    plan?: string;
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };
    appPermissions: PermissionSet;
    /**
     * Whether the EDGE admits this session's writes to this tenant's admin API
     * outside the agent subtree — `checkAdminAccess`, which reads the
     * membership's BUILT-IN role and never a custom role (#4467). Asked on the
     * server by the tenant layout (`edgeAdmitsAdminApi`), so a client page can
     * offer an admin control only where the edge lets its request through
     * (`useOffersAdminApiWrite` in `@/lib/auth/use-offers-admin-api-write`,
     * kept out of this module so the shared bundle does not carry it).
     *
     * Optional so a provider built without it (a test) keeps every control: an
     * absent verdict is read as admitted. The server stays the authority either
     * way; the tenant layout always asks.
     */
    edgeAdmitsAdminApi?: boolean;
    /**
     * Which optional modules this tenant has.
     *
     * SEPARATE FROM `appPermissions` ON PURPOSE. A permission answers "may this
     * user do it"; a module answers "does this tenant have it at all". Folding
     * modules into the permission bag would make a surface the tenant does not
     * have look like a surface the user is not allowed — which sends a reader
     * to an administrator who has nothing to grant.
     *
     * Read server-side in the tenant layout and threaded through here, the same
     * way `appPermissions` is, so no client component fetches it.
     */
    modules: {
        /** The process canvas surface. Default OFF — see `process-canvas-module`. */
        processCanvas: boolean;
    };
}

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({
    value,
    children,
}: {
    value: TenantContextValue;
    children: React.ReactNode;
}) {
    return (
        <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
    );
}

/**
 * Which optional modules this tenant has. See `TenantContextValue.modules`.
 *
 * Returns the bag rather than a single boolean so a second module does not need
 * a second hook.
 */
export function useModules(): TenantContextValue['modules'] {
    return useTenantContext().modules;
}

export function useTenantContext(): TenantContextValue {
    const ctx = useContext(TenantContext);
    if (!ctx) {
        throw new Error('useTenantContext must be used within a TenantProvider');
    }
    return ctx;
}

/**
 * Hook to retrieve granular app permissions for UI rendering logic.
 */
export function usePermissions(): PermissionSet {
    return useTenantContext().appPermissions;
}

/**
 * The authenticated user's id — the no-SessionProvider replacement for
 * `useSession().user.id` in client components.
 */
export function useCurrentUserId(): string {
    return useTenantContext().userId;
}

/**
 * Build a tenant-scoped href: `/t/<slug>/<path>`
 */
export function useTenantHref() {
    const { tenantSlug } = useTenantContext();
    return useCallback(
        (path: string) => `/t/${tenantSlug}${path.startsWith('/') ? path : `/${path}`}`,
        [tenantSlug]
    );
}

/**
 * Build a tenant-scoped API URL: `/api/t/<slug>/<path>`
 */
export function useTenantApiUrl() {
    const { tenantSlug } = useTenantContext();
    return useCallback(
        (path: string) => `/api/t/${tenantSlug}${path.startsWith('/') ? path : `/${path}`}`,
        [tenantSlug]
    );
}

// ─── RQ3-OB-A — tenant-bound money formatter ─────────────────────────
//
// One symbol per tenant, one formatter per product. Components call
// `useMoneyFormatter()` instead of importing formatCompactCurrency
// with a hardcoded symbol — the hook closes over the tenant's
// configured currencySymbol (default €).

import { formatCompactCurrency } from '@/lib/risk-coherence';

export function useMoneyFormatter(): (v: number | null | undefined) => string {
    const ctx = useTenantContext();
    const symbol = ctx.currencySymbol ?? '€';
    return useCallback((v: number | null | undefined) => formatCompactCurrency(v, symbol), [symbol]);
}
