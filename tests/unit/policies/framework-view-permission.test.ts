/**
 * `assertCanViewFrameworks` reads the PERMISSION, not the role's existence.
 *
 * It used to be `if (!ctx.role) throw forbidden('Authentication required')` —
 * an authentication check wearing authorization's clothes. `getTenantCtx`
 * always populates `ctx.role` for a real request, so the branch could never be
 * taken, and all ~14 call sites of this policy inherited that. Six API routes
 * were classified `ROLE_PRESENCE_ONLY` by
 * `tests/guardrails/api-route-has-some-authorization.test.ts` because of it.
 *
 * The guardrail proves the SHAPE is gone. These prove the BEHAVIOUR: that the
 * gate refuses the population it is meant to, and — the half that matters more
 * — that it still admits everyone who was already entitled.
 */
import { assertCanViewFrameworks } from '@/app-layer/policies/framework.policies';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';

const BUILT_IN_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER'];

function ctxWith(role: Role, overrides?: { frameworksView?: boolean }): RequestContext {
    const appPermissions = getPermissionsForRole(role);
    return {
        userId: 'u-1',
        tenantId: 't-1',
        role,
        permissions: {} as RequestContext['permissions'],
        appPermissions:
            overrides?.frameworksView === undefined
                ? appPermissions
                : {
                      ...appPermissions,
                      frameworks: { ...appPermissions.frameworks, view: overrides.frameworksView },
                  },
    } as RequestContext;
}

describe('assertCanViewFrameworks', () => {
    it.each(BUILT_IN_ROLES)('admits %s — nobody with a built-in role loses access', (role) => {
        // The load-bearing half. A gate that refuses everyone would satisfy the
        // refusal test below on its own, and would be an outage rather than a
        // fix: every built-in role carries `frameworks.view: true`, and these
        // routes back pages that READER and AUDITOR use.
        expect(() => assertCanViewFrameworks(ctxWith(role))).not.toThrow();
        expect(getPermissionsForRole(role).frameworks.view).toBe(true);
    });

    it('refuses a custom role configured with frameworks.view = false', () => {
        // The population the old check could never reach: `parsePermissionsJson`
        // lets a TenantCustomRole zero any flag, and until this policy read the
        // flag, such a member still received framework data everywhere.
        expect(() => assertCanViewFrameworks(ctxWith('READER', { frameworksView: false }))).toThrow(
            /permission to view frameworks/i,
        );
    });

    it('refuses regardless of how privileged the underlying role is', () => {
        // The permission, not the role, is the authority. An OWNER whose custom
        // role zeroes the flag is refused — otherwise the flag would be
        // advisory for exactly the members most able to ignore it.
        expect(() => assertCanViewFrameworks(ctxWith('OWNER', { frameworksView: false }))).toThrow();
    });

    it('no longer accepts a populated role as sufficient (the regression proof)', () => {
        // Pins the actual change. Under the old body this context passed,
        // because `ctx.role` was set. If someone restores a role-presence
        // check, this is what fails.
        const ctx = ctxWith('ADMIN', { frameworksView: false });
        expect(ctx.role).toBeTruthy();
        expect(() => assertCanViewFrameworks(ctx)).toThrow();
    });
});
