/**
 * The people layer is readable by OWNER and ADMIN only (owner decision,
 * 2026-10-29).
 *
 * `personnel.view` gates the four people-layer reads — the employee roster,
 * devices, training assignments and background checks. Until this decision
 * every built-in role held it, so any member could fetch the whole roster
 * over the API although the pages that show it sit under the admin console.
 *
 * What this file proves, each half against the real `getPermissionsForRole`
 * (never a hand-built permission set, which would agree with whatever the
 * test author typed):
 *
 *   1. the role matrix — which built-in roles hold `personnel.view` and
 *      `personnel.manage`, enumerated over every `Role`, so a seventh role
 *      fails here until somebody decides;
 *   2. each GET route refuses every role but OWNER and ADMIN with a 403 and an
 *      `AUTHZ_DENIED` row naming the key, without reading a single row, and
 *      admits OWNER and ADMIN through to the read. The positive half matters:
 *      a gate that refused everybody would pass the negative half alone;
 *   3. what the change does and does not do to stored custom roles, and that
 *      API-key scopes are untouched by it.
 */

import { strictMock } from '../helpers/strict-mock';

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on a refusal. A strict mock:
// an export this factory omits throws when reached instead of resolving to
// `undefined`.
const auditSpy = jest.fn(async (_entry: unknown) => ({ recorded: 'chain' as const, auditId: 'audit-x' }));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => auditSpy(entry),
        appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'h', previousHash: null })),
    }),
);

// The REAL usecases run; only the database is replaced. Every read the four
// handlers make is recorded by table, so "was the roster read?" is a fact the
// test observes rather than one it infers from a status code.
const tablesRead: string[] = [];
function recordingTable(name: string) {
    return {
        findMany: jest.fn(async () => {
            tablesRead.push(name);
            return [];
        }),
    };
}
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            employee: recordingTable('employee'),
            device: recordingTable('device'),
            trainingAssignment: recordingTable('trainingAssignment'),
            backgroundCheck: recordingTable('backgroundCheck'),
        }),
    ),
}));

import { NextRequest } from 'next/server';
import type { Role } from '@prisma/client';

import { GET as personnelGET } from '@/app/api/t/[tenantSlug]/personnel/route';
import { GET as devicesGET } from '@/app/api/t/[tenantSlug]/devices/route';
import { GET as trainingGET } from '@/app/api/t/[tenantSlug]/training/route';
import { GET as backgroundChecksGET } from '@/app/api/t/[tenantSlug]/background-checks/route';
import {
    getPermissionsForRole,
    parsePermissionsJson,
    permissionsExceeding,
    permissionsForMembership,
    validatePermissionsJson,
    type PermissionSet,
} from '@/lib/permissions';
import { scopesToPermissions } from '@/lib/auth/api-key-auth';
import { TENANT_ROLES } from '@/lib/roles';
import { makeRequestContext } from '../helpers/make-context';

/** Who reads the people layer. Every other built-in role reads none of it. */
const READS_PEOPLE_LAYER: ReadonlySet<Role> = new Set<Role>(['OWNER', 'ADMIN']);

describe('the role matrix — personnel.view and personnel.manage', () => {
    it.each([
        ['OWNER', { view: true, manage: true }],
        ['ADMIN', { view: true, manage: true }],
        ['EDITOR', { view: false, manage: false }],
        ['AUDITOR', { view: false, manage: false }],
        ['READER', { view: false, manage: false }],
        ['AI_ADMIN', { view: false, manage: false }],
    ] as const)('%s → %j', (role, expected) => {
        expect(getPermissionsForRole(role).personnel).toEqual(expected);
    });

    it('the table above names every built-in role', () => {
        // TENANT_ROLES is compile-time exhaustive over `Role`, so a seventh
        // role lands here and has to be classified.
        expect([...TENANT_ROLES].sort()).toEqual(
            ['ADMIN', 'AI_ADMIN', 'AUDITOR', 'EDITOR', 'OWNER', 'READER'].sort(),
        );
        for (const role of TENANT_ROLES) {
            expect({ role, view: getPermissionsForRole(role).personnel.view }).toEqual({
                role,
                view: READS_PEOPLE_LAYER.has(role),
            });
        }
    });

    it('no role holds manage without view, so no write route admits a caller the reads refuse', () => {
        for (const role of TENANT_ROLES) {
            const p = getPermissionsForRole(role).personnel;
            if (p.manage) expect({ role, view: p.view }).toEqual({ role, view: true });
        }
    });
});

const ROUTES = [
    { path: 'personnel', handler: personnelGET, table: 'employee' },
    { path: 'devices', handler: devicesGET, table: 'device' },
    { path: 'training', handler: trainingGET, table: 'trainingAssignment' },
    { path: 'background-checks', handler: backgroundChecksGET, table: 'backgroundCheck' },
] as const;

type RouteGET = (req: NextRequest, args: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;

async function call(handler: RouteGET, path: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/t/acme/${path}`, { method: 'GET' });
    return handler(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
}

function deniedKeys(): unknown[] {
    return auditSpy.mock.calls.map(([entry]) => {
        const e = entry as { action?: string; detailsJson?: { permissionKeys?: unknown } };
        return e.action === 'AUTHZ_DENIED' ? e.detailsJson?.permissionKeys : undefined;
    });
}

beforeEach(() => {
    tablesRead.length = 0;
    auditSpy.mockClear();
    getTenantCtxMock.mockReset();
});

describe.each(ROUTES)('GET /api/t/:slug/$path', ({ path, handler, table }) => {
    it.each(['OWNER', 'ADMIN'] as const)('admits %s through to the read', async (role) => {
        getTenantCtxMock.mockResolvedValue(makeRequestContext(role));

        const res = await call(handler as RouteGET, path);

        expect(res.status).toBe(200);
        expect(tablesRead).toEqual([table]);
        expect(auditSpy).not.toHaveBeenCalled();
    });

    it.each(['READER', 'EDITOR', 'AUDITOR', 'AI_ADMIN'] as const)(
        'refuses %s with a 403 and an AUTHZ_DENIED row, and reads nothing',
        async (role) => {
            getTenantCtxMock.mockResolvedValue(makeRequestContext(role));

            const res = await call(handler as RouteGET, path);

            expect(res.status).toBe(403);
            expect(tablesRead).toEqual([]);
            expect(deniedKeys()).toEqual([['personnel.view']]);
            // The refusal does not name the key it wanted.
            expect(JSON.stringify(await res.json())).not.toContain('personnel');
        },
    );

    it('admits a READER-based custom role that grants personnel.view', async () => {
        const blob = { ...getPermissionsForRole('READER'), personnel: { view: true, manage: false } };
        getTenantCtxMock.mockResolvedValue(
            makeRequestContext('READER', { appPermissions: parsePermissionsJson(blob, 'READER') }),
        );

        const res = await call(handler as RouteGET, path);

        expect(res.status).toBe(200);
        expect(tablesRead).toEqual([table]);
    });
});

describe('stored custom roles', () => {
    /** A blob as the custom-role editor saves it: every domain, every action. */
    function fullBlob(base: Role, personnel: PermissionSet['personnel'] | undefined): Record<string, unknown> {
        const blob: Record<string, unknown> = { ...getPermissionsForRole(base) };
        if (personnel === undefined) delete blob.personnel;
        else blob.personnel = personnel;
        return blob;
    }

    it('a role that STATES personnel.view keeps exactly what it states, on every base', () => {
        // Every create and update goes through `validatePermissionsJson`, which
        // requires every action of every domain. A role saved from the READER
        // preset before 2026-10-29 therefore carries `view: true` explicitly,
        // and keeps the read: the change moves defaults, not stored grants.
        for (const base of ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const) {
            const granted = fullBlob(base, { view: true, manage: false });
            expect(validatePermissionsJson(granted)).toEqual([]);
            expect(parsePermissionsJson(granted, base).personnel.view).toBe(true);

            const withheld = fullBlob(base, { view: false, manage: false });
            expect(parsePermissionsJson(withheld, base).personnel.view).toBe(false);
        }
    });

    it('a role saved before the people layer existed takes its base role\'s new default', () => {
        // Only a blob with NO `personnel` domain — written before PR-4 added
        // it — reads the default, and that default is now false on every base
        // a custom role can have except ADMIN.
        expect(parsePermissionsJson(fullBlob('READER', undefined), 'READER').personnel.view).toBe(false);
        expect(parsePermissionsJson(fullBlob('EDITOR', undefined), 'EDITOR').personnel.view).toBe(false);
        expect(parsePermissionsJson(fullBlob('AUDITOR', undefined), 'AUDITOR').personnel.view).toBe(false);
        expect(parsePermissionsJson(fullBlob('ADMIN', undefined), 'ADMIN').personnel.view).toBe(true);
    });

    it('a membership with no custom role reads the built-in role, and one with a custom role reads the blob', () => {
        expect(permissionsForMembership({ role: 'READER', customRole: null }).personnel.view).toBe(false);
        expect(
            permissionsForMembership({
                role: 'READER',
                customRole: { permissionsJson: fullBlob('READER', { view: true, manage: false }), baseRole: 'READER' },
            }).personnel.view,
        ).toBe(true);
    });

    it('an ADMIN may still grant the read in a custom role; only a holder may', () => {
        const granted = parsePermissionsJson(fullBlob('READER', { view: true, manage: false }), 'READER');
        expect(permissionsExceeding(granted, getPermissionsForRole('ADMIN'))).toEqual([]);
        expect(permissionsExceeding(granted, getPermissionsForRole('EDITOR'))).toEqual(['personnel.view']);
    });
});

describe('API keys are untouched — scopes, not roles, decide a key', () => {
    it('personnel:read still grants the read, and a key without it still has none', () => {
        expect(scopesToPermissions(['personnel:read']).personnel).toEqual({ view: true, manage: false });
        expect(scopesToPermissions(['*']).personnel).toEqual({ view: true, manage: true });
        expect(scopesToPermissions(['controls:read']).personnel).toEqual({ view: false, manage: false });
    });
});
