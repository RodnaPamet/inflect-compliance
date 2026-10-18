/**
 * Unit tests for edge-compatible auth guard helpers.
 */
import {
    isPublicPath,
    isApiRoute,
    isAdminPath,
    checkAdminAccess,
    isTenantPath,
    sanitizeRedirectPath,
    buildLoginRedirect,
} from '@/lib/auth/guard';

// ─── isPublicPath ───

describe('isPublicPath', () => {
    it.each([
        ['/login', true],
        ['/login?next=/dashboard', true],
        ['/register', true],
        ['/api/auth/session', true],
        ['/api/auth/csrf', true],
        ['/api/auth/callback/google', true],
        ['/api/auth/signin', true],
        ['/_next/static/chunk.js', true],
        ['/_next/image?url=...', true],
        ['/favicon.ico', true],
        ['/robots.txt', true],
        ['/sitemap.xml', true],
        ['/logo.png', true],
        ['/fonts/inter.woff2', true],
        ['/icon.svg', true],
        // Invite acceptance must be reachable by signed-out users.
        ['/invite/abc123', true],
        ['/invite/org/abc123', true],
        ['/api/invites/abc123/start-signin', true],
        ['/api/org/invite/abc123/start-signin', true],
        ['/api/org/invite/abc123/accept-redirect', true],
    ])('"%s" → %s (public)', (path, expected) => {
        expect(isPublicPath(path)).toBe(expected);
    });

    it.each([
        ['/dashboard', false],
        ['/api/clauses', false],
        ['/api/assets', false],
        ['/admin', false],
        ['/admin/users', false],
        ['/settings', false],
        ['/', false],
        ['/t/acme/dashboard', false],
        ['/api/t/acme/risks', false],
        // Org invite *management* (create/list/revoke) is admin-only and
        // must NOT be caught by the public `/api/org/invite/` carve-out —
        // it lives under `/api/org/<slug>/invites/` (plural, slug-scoped).
        ['/api/org/acme/invites', false],
        ['/api/org/acme/invites/inv_123', false],
    ])('"%s" → %s (protected)', (path, expected) => {
        expect(isPublicPath(path)).toBe(expected);
    });
});

// ─── isApiRoute ───

describe('isApiRoute', () => {
    it('recognizes API routes', () => {
        expect(isApiRoute('/api/clauses')).toBe(true);
        expect(isApiRoute('/api/auth/session')).toBe(true);
        expect(isApiRoute('/api/assets/123')).toBe(true);
    });

    it('rejects non-API routes', () => {
        expect(isApiRoute('/dashboard')).toBe(false);
        expect(isApiRoute('/login')).toBe(false);
        expect(isApiRoute('/')).toBe(false);
    });
});

// ─── isAdminPath ───

describe('isAdminPath', () => {
    it('recognizes flat admin paths', () => {
        expect(isAdminPath('/admin')).toBe(true);
        expect(isAdminPath('/admin/users')).toBe(true);
        expect(isAdminPath('/api/admin/settings')).toBe(true);
    });

    it('recognizes tenant-scoped admin paths', () => {
        expect(isAdminPath('/t/acme/admin')).toBe(true);
        expect(isAdminPath('/t/acme/admin/users')).toBe(true);
        expect(isAdminPath('/api/t/acme/admin')).toBe(true);
    });

    it('rejects non-admin paths', () => {
        expect(isAdminPath('/dashboard')).toBe(false);
        expect(isAdminPath('/api/clauses')).toBe(false);
        expect(isAdminPath('/t/acme/dashboard')).toBe(false);
        expect(isAdminPath('/api/t/acme/risks')).toBe(false);
    });
});

// ─── checkAdminAccess (#3701) ───

describe('checkAdminAccess', () => {
    const memberships = [
        { slug: 'alpha', role: 'READER' },
        { slug: 'beta', role: 'OWNER' },
        { slug: 'delta', role: 'ADMIN' },
    ];

    it('judges a tenant admin path by the role held in THAT tenant, not the primary role', () => {
        expect(checkAdminAccess('/api/t/beta/admin/members', 'READER', memberships)).toBe('allow');
        expect(checkAdminAccess('/t/delta/admin', 'READER', memberships)).toBe('allow');
        expect(checkAdminAccess('/api/t/alpha/admin/members', 'OWNER', memberships)).toBe('deny');
    });

    it('denies every non-admin built-in role here', () => {
        for (const role of ['EDITOR', 'READER', 'AUDITOR']) {
            expect(checkAdminAccess('/api/t/x/admin', 'OWNER', [{ slug: 'x', role }])).toBe('deny');
        }
    });

    it('defers a tenant missing from the claim to the tenant-access gate', () => {
        expect(checkAdminAccess('/api/t/gamma/admin', 'OWNER', memberships)).toBe('defer');
        expect(checkAdminAccess('/api/t/gamma/admin', 'OWNER', [])).toBe('defer');
        expect(checkAdminAccess('/api/t/gamma/admin', 'OWNER', undefined)).toBe('defer');
    });

    it('judges a flat admin path, which names no tenant, by the primary role', () => {
        expect(checkAdminAccess('/admin', 'OWNER', memberships)).toBe('allow');
        expect(checkAdminAccess('/admin', 'ADMIN', [])).toBe('allow');
        expect(checkAdminAccess('/admin', 'READER', memberships)).toBe('deny');
        expect(checkAdminAccess('/admin', undefined, memberships)).toBe('deny');
    });
});

// ─── isTenantPath ───

describe('isTenantPath', () => {
    it('recognizes tenant-scoped paths', () => {
        expect(isTenantPath('/t/acme/dashboard')).toBe(true);
        expect(isTenantPath('/t/acme-corp/risks')).toBe(true);
        expect(isTenantPath('/t/acme/s/prod/evidence')).toBe(true);
        expect(isTenantPath('/api/t/acme/risks')).toBe(true);
        expect(isTenantPath('/api/t/acme/s/prod/evidence')).toBe(true);
    });

    it('rejects non-tenant paths', () => {
        expect(isTenantPath('/dashboard')).toBe(false);
        expect(isTenantPath('/api/risks')).toBe(false);
        expect(isTenantPath('/login')).toBe(false);
        expect(isTenantPath('/api/auth/session')).toBe(false);
    });
});

// ─── sanitizeRedirectPath ───

describe('sanitizeRedirectPath', () => {
    it('allows safe relative paths', () => {
        expect(sanitizeRedirectPath('/dashboard')).toBe('/dashboard');
        expect(sanitizeRedirectPath('/admin/users')).toBe('/admin/users');
        expect(sanitizeRedirectPath('/api/me')).toBe('/api/me');
    });

    it('returns "/" for null/undefined/empty', () => {
        expect(sanitizeRedirectPath(null)).toBe('/');
        expect(sanitizeRedirectPath(undefined)).toBe('/');
        expect(sanitizeRedirectPath('')).toBe('/');
    });

    it('blocks absolute URLs (open redirect prevention)', () => {
        expect(sanitizeRedirectPath('https://evil.com')).toBe('/');
        expect(sanitizeRedirectPath('https://evil.com/steal')).toBe('/');
        expect(sanitizeRedirectPath('http://evil.com')).toBe('/');
        expect(sanitizeRedirectPath('ftp://evil.com')).toBe('/');
    });

    it('blocks protocol-relative URLs', () => {
        expect(sanitizeRedirectPath('//evil.com')).toBe('/');
        expect(sanitizeRedirectPath('//evil.com/path')).toBe('/');
    });

    it('blocks backslash URLs', () => {
        expect(sanitizeRedirectPath('\\evil.com')).toBe('/');
    });

    it('rejects paths not starting with /', () => {
        expect(sanitizeRedirectPath('dashboard')).toBe('/');
        expect(sanitizeRedirectPath('evil.com')).toBe('/');
    });

    it('handles URL-encoded input', () => {
        expect(sanitizeRedirectPath('%2Fdashboard')).toBe('/dashboard');
        expect(sanitizeRedirectPath('https%3A%2F%2Fevil.com')).toBe('/');
    });

    it('handles double-encoded input safely', () => {
        // %252F = URL-encoded %2F → decodes to %2F → second decode gives /
        // But we only decode once, so this stays as literal text
        expect(sanitizeRedirectPath('%252Fdashboard')).toBe('/');
    });
});

// ─── buildLoginRedirect ───

describe('buildLoginRedirect', () => {
    it('builds login URL with next param', () => {
        const url = buildLoginRedirect('http://localhost:3000', '/dashboard');
        expect(url.pathname).toBe('/login');
        expect(url.searchParams.get('next')).toBe('/dashboard');
    });

    it('omits next param when path is /', () => {
        const url = buildLoginRedirect('http://localhost:3000', '/');
        expect(url.pathname).toBe('/login');
        expect(url.searchParams.has('next')).toBe(false);
    });

    it('sanitizes malicious next param', () => {
        const url = buildLoginRedirect(
            'http://localhost:3000',
            'https://evil.com/steal'
        );
        expect(url.pathname).toBe('/login');
        // Should NOT contain the evil URL
        expect(url.searchParams.has('next')).toBe(false);
    });
});
