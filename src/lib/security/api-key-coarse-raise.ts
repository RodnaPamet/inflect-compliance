/**
 * The per-request raise of an API key's COARSE tier (#5306 item 3, owner
 * decision 2026-11-14).
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * A key's context carries two kinds of authority. The granular `appPermissions`
 * come from its scopes (`scopesToPermissions`). The coarse tier (`ctx.role` and
 * `ctx.permissions`: `canRead`, `canWrite`, `canAdmin`, `canAudit`, `canExport`)
 * is DERIVED from the scopes too (`keyAuthorityFromScopes`): `*` and
 * `admin:write` give ADMIN, any other `:write` or `:*` gives EDITOR, the rest
 * READER. So an `admin:*` key, whose scopes grant a superset of `admin:write`'s,
 * resolved to EDITOR: it passed `requirePermission('admin.manage')` on
 * `POST /admin/api-keys` and was then refused by the usecase's `assertCanAdmin`.
 *
 * About 300 coarse checks still need a tier for a key, so the scope-derived
 * tier cannot simply be dropped: taking the tier from the key's creator widens
 * keys, and a fixed tier either breaks integrations or widens every key.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * The scope-derived tier stays as the key's BASELINE (the decision calls it the
 * ceiling): it is what every route without a granular gate sees, unchanged. When
 * a route's `requirePermission(<keys>)` has just PASSED for an API-key context,
 * the coarse tier FOR THAT REQUEST is raised to the lowest built-in role that
 * holds the key(s) the request passed, per `getPermissionsForRole`, and to
 * exactly what `computePermissions` gives that role — never more.
 *
 *   - Only an API-key context (`ctx.apiKeyId`). A session user is untouched.
 *   - Only upward: a role at or below the baseline changes nothing.
 *   - Only what the request passed: `all` raises to the lowest role holding
 *     EVERY key, `any` to the lowest role holding ANY key this context holds.
 *     A key is never raised on a route whose gate it did not pass, because this
 *     runs only after `assertPermission` returned.
 *   - Per request: a new context object handed to the handler, never written to
 *     the key, cached, or seen by the next request.
 *   - Never from a READ-CLASS grant (`isReadClassScopeGroup`: a `read` or
 *     `*_view` scope group). The lowest role holding `admin.view` is ADMIN, and
 *     `admin.view` gates `POST /agent-runs/:id/abort` and the agent-proposal
 *     approve/reject routes, whose usecases then ask `assertCanWrite`. Raising
 *     there would let an `admin:read` key abort runs and decide proposals: a
 *     look-only key gaining writes, which the decision's own rule ("no key
 *     gains reach beyond what its scopes grant") forbids. So a passed key
 *     counts only when the scopes grant it through a non-read group: `admin:*`
 *     raises on `admin.manage` (its write group) and not on `admin.view`.
 *   - Not for an AGENT-BOUND key (`ctx.agentId`). Its context was narrowed to its
 *     human principal (`resolveAgentAuthority`: principal ∧ scopes), and the
 *     context does not carry the principal's own coarse tier, so a raise could
 *     lift it above the person it speaks for. It keeps its narrowed tier.
 *
 * The granular `appPermissions` are never touched. A key gains no granular
 * reach at all; it gains, on a route it was already admitted to by name, the
 * coarse tier the least-privileged built-in role admitted there would have.
 */
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { TENANT_ROLES } from '@/lib/roles';
import { coarseRoleLevel, computePermissions } from '@/lib/tenant-context';
import { scopesToPermissions } from '@/lib/auth/api-key-auth';
import { hasPermission, type PermissionKey } from './permission-key';
import type { PermissionMode } from './assert-permission';

/**
 * Every built-in role (`TENANT_ROLES`, compile-time exhaustive over the enum),
 * lowest coarse rung first. A tie (READER and AI_ADMIN
 * share rung 1) keeps the enum's order; it never matters, because a raise needs
 * a rung strictly above the baseline and every key context starts at rung 1 or
 * higher.
 */
const BUILT_IN_ROLES_ASCENDING: readonly Role[] = TENANT_ROLES
    .map((role, index) => ({ role, index }))
    .sort((a, b) => coarseRoleLevel(a.role) - coarseRoleLevel(b.role) || a.index - b.index)
    .map(({ role }) => role);

/**
 * The lowest built-in role holding `keys` — every one of them (`all`) or at
 * least one (`any`) — or `null` when no built-in role does.
 */
export function lowestBuiltInRoleHolding(
    keys: readonly PermissionKey[],
    mode: PermissionMode,
): Role | null {
    if (keys.length === 0) return null;
    for (const role of BUILT_IN_ROLES_ASCENDING) {
        const set = getPermissionsForRole(role);
        const holds =
            mode === 'any'
                ? keys.some((k) => hasPermission(set, k))
                : keys.every((k) => hasPermission(set, k));
        if (holds) return role;
    }
    return null;
}

/**
 * The context a handler behind `requirePermission(keys, mode)` receives, for a
 * request whose permission check has ALREADY passed. Returns `ctx` itself
 * whenever nothing is raised.
 */
export function raiseApiKeyCoarseTier(
    ctx: RequestContext,
    keys: readonly PermissionKey[],
    mode: PermissionMode,
): RequestContext {
    if (!ctx.apiKeyId) return ctx;
    if (ctx.agentId) return ctx;

    // The keys this request actually passed on. Re-read here rather than
    // trusted from the caller, so a call out of order raises nothing.
    const passed = keys.filter((k) => hasPermission(ctx.appPermissions, k));
    if (passed.length === 0) return ctx;
    if (mode === 'all' && passed.length !== keys.length) return ctx;

    // Of those, the ones the scopes grant through a group that is not
    // read-class. Only these may raise the tier.
    const raising = scopesToPermissions(ctx.apiKeyScopes ?? [], { readClassGroups: 'exclude' });
    const eligible = passed.filter((k) => hasPermission(raising, k));
    if (eligible.length === 0) return ctx;

    const role = lowestBuiltInRoleHolding(eligible, mode);
    if (!role) return ctx;
    if (coarseRoleLevel(role) <= coarseRoleLevel(ctx.role)) return ctx;

    return { ...ctx, role, permissions: computePermissions(role) };
}
