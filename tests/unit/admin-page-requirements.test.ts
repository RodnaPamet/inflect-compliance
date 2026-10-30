/**
 * Who each admin server page admits, by role — `ADMIN_PAGE_REQUIREMENTS`.
 *
 * The page-by-page gate exists so that the server refuses exactly the callers
 * the client admin layout hides the page from (`admin.view`), plus whoever the
 * page's own read would refuse. For the built-in roles that is one fixed
 * matrix, and this file pins it:
 *
 *   · OWNER and ADMIN reach every gated page — no change for either;
 *   · EDITOR, READER and AI_ADMIN reach none — none holds `admin.view`;
 *   · AUDITOR reaches the audit log only (owner decision 2026-10-29: the read
 *     asserts `canAudit`, and an AUDITOR may read the log).
 *
 * A custom role is judged by its own keys, so its rows are spelled out below.
 * Every row also asks the membership's OWN role, as the edge reads it (#4581 B):
 * a custom role's keys never open an admin page to a Reader, Editor or Auditor
 * membership (the audit log aside, for an Auditor).
 */
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { AI_ADMIN_ADMIN_PATH_PREFIXES, EDGE_ADMIN_ROLES } from '@/lib/auth/guard';
import type { Role } from '@prisma/client';
import {
    ADMIN_PAGE_REQUIREMENTS,
    adminPageRouteForPath,
    admitsAdminPage,
    type AdminPageRoute,
} from '@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-requirements';

const ROUTES = Object.keys(ADMIN_PAGE_REQUIREMENTS) as AdminPageRoute[];
/** A built-in membership: its own role and its effective role are the same. */
const builtIn = (role: string) => makeRequestContext(role, { membershipRole: role as Role });
const admitted = (role: string, route: AdminPageRoute) =>
    admitsAdminPage(builtIn(role), ADMIN_PAGE_REQUIREMENTS[route]);

describe('built-in roles', () => {
    test('there is something to judge', () => {
        expect(ROUTES.length).toBeGreaterThan(0);
    });

    test.each(['OWNER', 'ADMIN'])('%s reaches every gated admin page', (role) => {
        expect(ROUTES.filter((r) => !admitted(role, r))).toEqual([]);
    });

    test.each(['EDITOR', 'READER', 'AI_ADMIN'])('%s reaches no gated admin page', (role) => {
        expect(ROUTES.filter((r) => admitted(role, r))).toEqual([]);
    });

    test('AUDITOR reaches the audit log and nothing else', () => {
        expect(ROUTES.filter((r) => admitted('AUDITOR', r))).toEqual(['/admin/audit-log']);
    });
});

describe('custom roles are judged by their own keys', () => {
    /**
     * A membership whose base role is `base`, whose stored keys are `admin` /
     * `personnel` overrides, and whose own role is `membershipRole` (ADMIN
     * unless stated: the edge admits it, so these rows test the keys).
     */
    function custom(
        base: string,
        overrides: { admin?: Partial<PermissionSet['admin']>; personnel?: Partial<PermissionSet['personnel']> },
        membershipRole: Role = 'ADMIN',
    ) {
        const set = getPermissionsForRole(base as never);
        return makeRequestContext(base, {
            membershipRole,
            appPermissions: {
                ...set,
                admin: { ...set.admin, ...overrides.admin },
                personnel: { ...set.personnel, ...overrides.personnel },
            },
        });
    }

    test('admin.view on a READER base does not reach the roster: a READER base no longer holds personnel.view', () => {
        const ctx = custom('READER', { admin: { view: true } });
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin/personnel'])).toBe(false);
    });

    test('admin.view and personnel.view on a READER base reach the roster', () => {
        const ctx = custom('READER', { admin: { view: true }, personnel: { view: true } });
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin/personnel'])).toBe(true);
    });

    test('admin.view without personnel.view does not reach the roster', () => {
        const ctx = custom('ADMIN', { personnel: { view: false } });
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin/personnel'])).toBe(false);
    });

    test('admin.view without admin.members does not reach the member list on the RBAC page', () => {
        const ctx = custom('ADMIN', { admin: { members: false } });
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin/rbac'])).toBe(false);
    });

    test('a page whose read asserts canAdmin refuses admin.view on a READER base', () => {
        const ctx = custom('READER', { admin: { view: true } });
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin/privacy'])).toBe(false);
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin/mcp'])).toBe(false);
    });

    test('an ADMIN base with admin.view switched off reaches no admin.view page', () => {
        const ctx = custom('ADMIN', { admin: { view: false } });
        const reached = ROUTES.filter((r) => admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS[r]));
        // The audit log asks `canAudit`, which the ADMIN base still carries.
        expect(reached).toEqual(['/admin/audit-log']);
    });
});

describe('the membership\'s own role, as the edge reads it (#4581 B)', () => {
    /** Every admin key true, every personnel key true, on `base`, carried by a `membershipRole` membership. */
    function everything(base: string, membershipRole: Role) {
        const set = getPermissionsForRole('ADMIN');
        return makeRequestContext(base, { membershipRole, appPermissions: { ...getPermissionsForRole(base as never), admin: set.admin, personnel: set.personnel } });
    }

    test('the default rule is the edge\'s own set', () => {
        expect([...EDGE_ADMIN_ROLES].sort()).toEqual(['ADMIN', 'OWNER']);
    });

    test.each(['READER', 'EDITOR', 'AUDITOR'] as Role[])(
        'a custom role granting every admin key opens no admin.view page to a %s membership',
        (membershipRole) => {
            for (const base of ['ADMIN', 'EDITOR', 'READER', 'AUDITOR']) {
                const ctx = everything(base, membershipRole);
                const reached = ROUTES.filter((r) => admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS[r]));
                // An AUDITOR membership keeps the audit log when its tier allows it.
                const expected = membershipRole === 'AUDITOR' && ctx.permissions.canAudit ? ['/admin/audit-log'] : [];
                expect({ base, reached }).toEqual({ base, reached: expected });
            }
        },
    );

    test('the same custom role on an ADMIN membership opens every page its keys and tier allow', () => {
        const ctx = everything('ADMIN', 'ADMIN');
        expect(ROUTES.filter((r) => !admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS[r]))).toEqual([]);
    });

    test('the audit log admits an AUDITOR membership and still refuses a READER or EDITOR one', () => {
        const row = ADMIN_PAGE_REQUIREMENTS['/admin/audit-log'];
        expect(admitsAdminPage(builtIn('AUDITOR'), row)).toBe(true);
        expect(admitsAdminPage(makeRequestContext('AUDITOR', { membershipRole: 'READER' }), row)).toBe(false);
        expect(admitsAdminPage(makeRequestContext('AUDITOR', { membershipRole: 'EDITOR' }), row)).toBe(false);
    });

    test('AI_ADMIN opens no gated page, whatever it holds', () => {
        const ctx = everything('READER', 'AI_ADMIN');
        expect(ROUTES.filter((r) => admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS[r]))).toEqual([]);
    });
});

describe('the requirement check fails closed', () => {
    test('a requirement naming nothing admits nobody, not even an OWNER', () => {
        expect(admitsAdminPage(builtIn('OWNER'), { keys: [] })).toBe(false);
    });

    test('a context with no permission set is refused', () => {
        const ctx = { ...builtIn('OWNER'), appPermissions: undefined as unknown as PermissionSet };
        expect(admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS['/admin'])).toBe(false);
    });

    test('a context with no membership role is refused, as an API key\'s is', () => {
        expect(admitsAdminPage(makeRequestContext('OWNER'), ADMIN_PAGE_REQUIREMENTS['/admin'])).toBe(false);
        expect(admitsAdminPage(makeRequestContext('OWNER'), ADMIN_PAGE_REQUIREMENTS['/admin/audit-log'])).toBe(false);
    });
});

describe('the AI_ADMIN edge carve-out', () => {
    test('no gated page sits on a path the edge admits an AI_ADMIN to', () => {
        // The edge lets an AI_ADMIN reach the agent paths under /admin
        // (`AI_ADMIN_ADMIN_PATH_PREFIXES`), and every page there is a redirect
        // to `/agents`. None of the gated pages admits an AI_ADMIN (above), so a
        // page there that started rendering behind this gate would refuse the
        // role the edge was widened for. This fails until somebody decides.
        expect(AI_ADMIN_ADMIN_PATH_PREFIXES.length).toBeGreaterThan(0);
        const inside = ROUTES.filter((route) => {
            const template = `/t/[slug]${route}`;
            return AI_ADMIN_ADMIN_PATH_PREFIXES.some((p) => template === p || template.startsWith(`${p}/`));
        });
        expect(inside).toEqual([]);
    });
});

describe('the client layout reads the same rows (adminPageRouteForPath)', () => {
    test('every row is found from its own browser path', () => {
        for (const route of ROUTES) {
            const path = `/t/acme${route.replace(/\[[^\]]+\]/g, 'x-1')}`;
            expect(adminPageRouteForPath(path)).toBe(route);
        }
    });

    test('one trailing slash is the same page', () => {
        expect(adminPageRouteForPath('/t/acme/admin/audit-log/')).toBe('/admin/audit-log');
        expect(adminPageRouteForPath('/t/acme/admin/')).toBe('/admin');
    });

    test.each([
        '/admin/audit-log',
        '/t/acme/admin/audit-log/extra',
        '/t/acme/admin/audit-log-export',
        '/t/acme/admin//audit-log',
        '/t/acme/admin/AUDIT-LOG',
        '/t/acme/admin/audit-log?x=1',
        '/t/acme/admin/members',
        '/t/acme/admin/vendor-templates//',
        '/t/acme/dashboard',
        '/t//admin/audit-log',
        '',
    ])('%j names no row, so the layout stays on admin.view', (path) => {
        expect(adminPageRouteForPath(path)).toBeNull();
    });

    test('the only rows that stand without admin.view are the audit log', () => {
        // The layout shows a page whose row admits the caller, so a row without
        // admin.view opens that page on screen to whoever the row admits. Today
        // that is one page, by owner decision; a second is a decision too.
        const withoutAdminView = ROUTES.filter(
            (r) => !(ADMIN_PAGE_REQUIREMENTS[r].keys as readonly string[]).includes('admin.view'),
        );
        expect(withoutAdminView).toEqual(['/admin/audit-log']);
    });
});
