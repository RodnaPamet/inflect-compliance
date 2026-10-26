/**
 * The audits pages offer exactly what the server allows (#4129).
 *
 * The audit-readiness policies gate on the BUILT-IN role; the pages gated on
 * `audits.manage` (OWNER + ADMIN) and `audits.share` (also AUDITOR). So an
 * Editor was refused nothing by the server and offered nothing by the page
 * (Cycle, Add items, Clone), and an Auditor was offered share, resolve and
 * create-finding buttons the server always refused.
 *
 * `auditReadinessAccess` is what the pages read now. This file holds it to the
 * policies themselves, role by role: a flag the page shows must be an assert
 * the server passes, and the reverse.
 */
import type { Role } from '@prisma/client';
import {
    assertCanManageAuditCycles,
    assertCanManageAuditPacks,
    assertCanFreezePack,
    assertCanSharePack,
    assertCanManageAuditors,
} from '@/app-layer/policies/audit-readiness.policies';
import { auditReadinessAccess } from '@/lib/audit-readiness/access';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'];

const passes = (assert: (ctx: ReturnType<typeof makeRequestContext>) => void, role: Role): boolean => {
    try {
        assert(makeRequestContext(role));
        return true;
    } catch {
        return false;
    }
};

describe.each(ROLES)('%s — the page offers what the server allows', (role) => {
    const access = auditReadinessAccess({ role, appPermissions: getPermissionsForRole(role) });

    it('cycles (create, change status)', () => {
        expect(access.manageCycles).toBe(passes(assertCanManageAuditCycles, role));
    });

    it('packs (create, add and remove items, clone)', () => {
        expect(access.managePacks).toBe(passes(assertCanManageAuditPacks, role));
    });

    it('freezing', () => {
        expect(access.freezePacks).toBe(passes(assertCanFreezePack, role));
    });

    it('share links and acting on an auditor’s messages', () => {
        expect(access.sharePacks).toBe(passes(assertCanSharePack, role));
    });

    it('the auditor list', () => {
        expect(access.manageAuditors).toBe(passes(assertCanManageAuditors, role));
    });

    it('auditor grants: the policy AND the routes’ admin.manage', () => {
        expect(access.changeAuditorAccess).toBe(
            passes(assertCanManageAuditors, role) && getPermissionsForRole(role).admin.manage,
        );
    });

    it('the reliance pack: audits.manage AND admin.manage at the route, then the freeze role', () => {
        const perms = getPermissionsForRole(role);
        expect(access.assembleReliancePack).toBe(
            perms.audits.manage && perms.admin.manage && passes(assertCanFreezePack, role),
        );
    });
});

describe('the populations the issue named', () => {
    const of = (role: Role) => auditReadinessAccess({ role, appPermissions: getPermissionsForRole(role) });

    it('an Editor may create cycles and change packs, which audits.manage never offered', () => {
        expect(getPermissionsForRole('EDITOR').audits.manage).toBe(false);
        expect(of('EDITOR')).toMatchObject({ manageCycles: true, managePacks: true, freezePacks: false, sharePacks: false });
    });

    it('an Auditor holds audits.share but may not share', () => {
        expect(getPermissionsForRole('AUDITOR').audits.share).toBe(true);
        expect(of('AUDITOR')).toMatchObject({ sharePacks: false, managePacks: false, manageCycles: false });
    });

    it('a Reader may change nothing', () => {
        expect(Object.values(of('READER')).every((v) => v === false)).toBe(true);
    });

    it('a custom role without admin.manage on an ADMIN base is offered no grant or reliance pack', () => {
        const perms = getPermissionsForRole('ADMIN');
        const narrowed = { ...perms, admin: { ...perms.admin, manage: false } };
        expect(auditReadinessAccess({ role: 'ADMIN', appPermissions: narrowed })).toMatchObject({
            manageAuditors: true,
            changeAuditorAccess: false,
            assembleReliancePack: false,
        });
    });
});
