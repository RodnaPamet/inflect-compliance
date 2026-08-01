'use client';

/**
 * IdentityPill — Roadmap-2 PR-2.
 *
 * Right-edge of the top chrome. Two variants, one per shell:
 *   • TenantIdentityPill — reads `useTenantContext` for the active
 *     tenant name; click navigates to the tenant picker.
 *   • OrgIdentityPill    — reads `useOrgContext` for the active
 *     organization name; click navigates to the org picker.
 *
 * The two pills are SEPARATE components so each one calls its own
 * context hook unconditionally — `<AppShell>` picks the right pill
 * based on its `variant` prop, so a tenant page never tries to
 * read org context (which would throw) and vice versa.
 *
 * Visual treatment is deliberately quiet: the pill announces
 * context, it does not advertise itself as primary navigation.
 * The underlying click target is large enough for accessibility
 * but the tone hugs the chrome.
 */
import Link from 'next/link';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { useOrgContext } from '@/lib/org-context-provider';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { HIT_AREA_CLASS } from '@/components/ui/hit-area';

const PILL_CLASS =
    `relative inline-flex items-center gap-tight rounded-full border border-border-subtle bg-bg-default px-3 py-1 text-xs font-medium text-content-muted transition-colors hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${HIT_AREA_CLASS}`;

export function TenantIdentityPill() {
    const { tenantName } = useTenantContext();
    return (
        <Link
            href="/tenants"
            className={PILL_CLASS}
            aria-label={`Current tenant: ${tenantName}. Click to switch.`}
            data-testid="top-chrome-tenant-pill"
        >
            <InitialsAvatar value={tenantName} />
            <span className="max-w-trunc-tight truncate">{tenantName}</span>
        </Link>
    );
}

export function OrgIdentityPill() {
    const { orgName } = useOrgContext();
    // No dedicated /orgs picker today — `/tenants` is the unified
    // post-sign-in picker (Tenant + Organization memberships both
    // surface there). Linking the org pill back to that picker
    // keeps the affordance consistent with the tenant pill while
    // a future /orgs picker would only swap the href.
    return (
        <Link
            href="/tenants"
            className={PILL_CLASS}
            aria-label={`Current organization: ${orgName}. Click to switch.`}
            data-testid="top-chrome-org-pill"
        >
            <InitialsAvatar value={orgName} />
            <span className="max-w-trunc-tight truncate">{orgName}</span>
        </Link>
    );
}
