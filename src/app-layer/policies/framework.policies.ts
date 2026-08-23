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

export function assertCanInstallFrameworkPack(ctx: RequestContext) {
    // Epic 1 — OWNER is a superset of ADMIN per CLAUDE.md RBAC.
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can install framework packs');
    }
}
