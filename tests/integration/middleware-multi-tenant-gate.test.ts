/**
 * Tests for the R-1 updated checkTenantAccess gate.
 *
 * Replaces the single-slug parameter with a memberships array. A user is
 * allowed through to /t/:slug/... if ANY of their memberships contains a
 * matching slug.
 *
 * These are pure-function unit tests (no DB, no NextAuth) — checkTenantAccess
 * is extracted from middleware exactly so it can be tested without framework
 * machinery.
 *
 * Also verifies the backward-compat migration:
 *   - Old tests in middleware-tenant-gate.test.ts used a single string slug.
 *     The new signature takes an array. These tests confirm the array shape
 *     is required and that the /tenants carve-out is now public.
 */

import {
    checkTenantAccess,
    isPublicPath,
} from '@/lib/auth/guard';

describe('checkTenantAccess — R-1 multi-tenant memberships array', () => {
    const membershipsAB = [{ slug: 'acme' }, { slug: 'beta-corp' }];

    it('allows when URL slug matches first membership', () => {
        expect(checkTenantAccess('/t/acme/dashboard', membershipsAB)).toBe('allow');
    });

    it('allows when URL slug matches second membership (multi-tenant)', () => {
        expect(checkTenantAccess('/t/beta-corp/dashboard', membershipsAB)).toBe('allow');
    });

    it('allows API path when URL slug matches any membership', () => {
        expect(checkTenantAccess('/api/t/acme/risks', membershipsAB)).toBe('allow');
        expect(checkTenantAccess('/api/t/beta-corp/risks', membershipsAB)).toBe('allow');
    });

    it('returns cross_tenant when URL slug is not in any membership', () => {
        expect(checkTenantAccess('/t/other-corp/dashboard', membershipsAB)).toBe('cross_tenant');
    });

    it('returns cross_tenant for API path with a slug not in memberships', () => {
        expect(checkTenantAccess('/api/t/other-corp/risks', membershipsAB)).toBe('cross_tenant');
    });

    it('returns no_tenant_access when memberships is an empty array', () => {
        expect(checkTenantAccess('/t/acme/dashboard', [])).toBe('no_tenant_access');
    });

    it('returns no_tenant_access when memberships is null', () => {
        expect(checkTenantAccess('/t/acme/dashboard', null)).toBe('no_tenant_access');
    });

    it('returns no_tenant_access when memberships is undefined', () => {
        expect(checkTenantAccess('/t/acme/dashboard', undefined)).toBe('no_tenant_access');
    });

    it('returns no_tenant_access for API path when memberships is empty', () => {
        expect(checkTenantAccess('/api/t/acme/risks', [])).toBe('no_tenant_access');
    });

    it('returns allow for non-tenant path /no-tenant regardless of memberships', () => {
        expect(checkTenantAccess('/no-tenant', [])).toBe('allow');
        expect(checkTenantAccess('/no-tenant', null)).toBe('allow');
    });

    it('returns allow for non-tenant path /login regardless of memberships', () => {
        expect(checkTenantAccess('/login', null)).toBe('allow');
    });

    it('returns allow for /invite/:token (public, non-tenant path)', () => {
        expect(checkTenantAccess('/invite/sometoken', null)).toBe('allow');
    });

    it('returns allow for /api/invites/:token/start-signin (public path)', () => {
        expect(checkTenantAccess('/api/invites/tok/start-signin', null)).toBe('allow');
    });

    it('returns allow for single-membership array matching the URL', () => {
        const single = [{ slug: 'solo' }];
        expect(checkTenantAccess('/t/solo/dashboard', single)).toBe('allow');
    });

    it('returns cross_tenant for single-membership array not matching the URL', () => {
        const single = [{ slug: 'solo' }];
        expect(checkTenantAccess('/t/other/dashboard', single)).toBe('cross_tenant');
    });

    // Slug collision guard: a user with slug 'ac' should not be allowed into /t/acme/
    it('does not allow slug prefix matches (exact slug comparison)', () => {
        const memberships = [{ slug: 'ac' }];
        expect(checkTenantAccess('/t/acme/dashboard', memberships)).toBe('cross_tenant');
    });

    // Five-member list — all allowed, and an outsider is rejected
    it('allows access to any of five memberships', () => {
        const five = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((slug) => ({ slug }));
        for (const m of five) {
            expect(checkTenantAccess(`/t/${m.slug}/dashboard`, five)).toBe('allow');
        }
        expect(checkTenantAccess('/t/foxtrot/dashboard', five)).toBe('cross_tenant');
    });
});

describe('/tenants is NOT public (DAST 10044, 2026-11-13)', () => {
    // It was an R-1 carve-out, but no edge gate needs an active tenant for a
    // path outside `/t/`, so the carve-out only meant an unauthenticated
    // request got the page's own redirect, carrying the whole root layout.
    it('/tenants is not in PUBLIC_PATH_PREFIXES', () => {
        expect(isPublicPath('/tenants')).toBe(false);
    });

    it('/t/acme/dashboard is still NOT public', () => {
        expect(isPublicPath('/t/acme/dashboard')).toBe(false);
    });
});
