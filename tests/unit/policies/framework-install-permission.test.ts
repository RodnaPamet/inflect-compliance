/**
 * `assertCanInstallFrameworkPack` reads the GRANULAR `frameworks.install`
 * key, as every install button does (#4125).
 *
 * It used to read `ctx.role` for OWNER/ADMIN. For a member with a custom role
 * `ctx.role` is the membership's built-in role, so the button (custom-role
 * aware) and the server disagreed both ways. These pin both directions, and —
 * the half that keeps the change from being an outage — that every built-in
 * role lands exactly where it did.
 */
import { assertCanInstallFrameworkPack } from '@/app-layer/policies/framework.policies';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../../helpers/make-context';

/** A member whose built-in role is `base` and whose custom role sets install. */
function customRole(base: Role, install: boolean): RequestContext {
    const perms = getPermissionsForRole(base);
    return makeRequestContext(base, {
        appPermissions: { ...perms, frameworks: { ...perms.frameworks, install } },
    });
}

describe('assertCanInstallFrameworkPack', () => {
    it.each<[Role, boolean]>([
        ['OWNER', true],
        ['ADMIN', true],
        ['EDITOR', false],
        ['AUDITOR', false],
        ['READER', false],
        ['AI_ADMIN', false],
    ])('built-in %s: allowed = %s (unchanged from the OWNER/ADMIN line)', (role, allowed) => {
        const call = () => assertCanInstallFrameworkPack(makeRequestContext(role));
        if (allowed) expect(call).not.toThrow();
        else expect(call).toThrow(/permission to install frameworks/i);
    });

    it('refuses a custom role on an ADMIN base with install switched off', () => {
        // Under the old body this passed: `ctx.role` is 'ADMIN'. The button
        // was hidden, but the API installed.
        const ctx = customRole('ADMIN', false);
        expect(ctx.role).toBe('ADMIN');
        expect(() => assertCanInstallFrameworkPack(ctx)).toThrow(/permission to install frameworks/i);
    });

    it('admits a custom role on an EDITOR base with install switched on', () => {
        // Under the old body this was refused: `ctx.role` is 'EDITOR'. The
        // button was shown and the wizard failed at its last click.
        const ctx = customRole('EDITOR', true);
        expect(ctx.role).toBe('EDITOR');
        expect(() => assertCanInstallFrameworkPack(ctx)).not.toThrow();
    });
});
