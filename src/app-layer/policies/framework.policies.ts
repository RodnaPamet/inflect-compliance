/**
 * Framework Coverage Policies
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

export function assertCanViewFrameworks(ctx: RequestContext) {
    // Reads the PERMISSION, not the role's existence.
    //
    // This was `if (!ctx.role) throw forbidden('Authentication required')`,
    // which is an AUTHENTICATION check wearing authorization's clothes:
    // `getTenantCtx` always populates `ctx.role` for a real request, so the
    // branch could never be taken. Every one of this policy's ~14 call sites
    // inherited that, and `tests/guardrails/api-route-has-some-authorization.test.ts`
    // classified the routes above them as ROLE_PRESENCE_ONLY for exactly this
    // reason.
    //
    // WHO THIS CHANGES. Nobody with a built-in role: OWNER, ADMIN, EDITOR,
    // AUDITOR and READER all carry `frameworks.view: true`
    // (`getPermissionsForRole`), and system/job contexts carry a full ADMIN
    // set. The population it now refuses is the one it always should have:
    // a `TenantCustomRole` whose `permissionsJson` sets
    // `frameworks: { view: false }`, which until now still received framework
    // data from every route reaching this policy.
    //
    // API KEYS ARE A REAL BREAKING CHANGE — see the note in
    // `docs/implementation-notes/2026-08-23-framework-view-permission.md`.
    // `scopesToPermissions` derives `appPermissions` from the key's scopes, and
    // `mcp:read` maps to an EMPTY action list, so a key minted with `mcp:read`
    // and no `frameworks:read` now fails here. That matches the documented
    // model (`mcp:read` is meant to be held ALONGSIDE a resource scope, not
    // instead of one), but keys in the wild may not have been minted that way.
    if (!ctx.appPermissions.frameworks.view) {
        throw forbidden('You do not have permission to view frameworks.');
    }
}

/**
 * The tenant-scoped framework writes: installing a pack, installing one or
 * many templates, bulk-mapping controls to requirements, and the builder's
 * per-tenant requirement order.
 *
 * Reads the GRANULAR, custom-role-aware `frameworks.install` key — the same
 * flag every install button in the UI is gated on (`<RequirePermission
 * resource="frameworks" action="install">`).
 *
 * It was `ctx.role !== 'OWNER' && ctx.role !== 'ADMIN'`. For a member with a
 * custom role `ctx.role` is the membership's built-in role, not the custom
 * role, so the button and the server disagreed in both directions: a custom
 * role on an ADMIN base with install switched off saw no button but was
 * allowed, and one on an EDITOR base with install switched on saw the button
 * and was refused at the last click (#4125).
 *
 * WHO THIS CHANGES. Nobody with a built-in role: OWNER and ADMIN carry
 * `frameworks.install: true` and EDITOR, AUDITOR, READER and AI_ADMIN carry
 * `false` (`getPermissionsForRole`), which is exactly the old OWNER/ADMIN
 * line. A custom role now follows its own grant. An API key follows its
 * scopes (`frameworks:write` grants install), not the role it is assigned
 * from them.
 */
export function assertCanInstallFrameworkPack(ctx: RequestContext) {
    if (!ctx.appPermissions.frameworks.install) {
        throw forbidden('You do not have permission to install frameworks.');
    }
}
