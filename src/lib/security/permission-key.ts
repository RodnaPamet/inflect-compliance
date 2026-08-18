/**
 * Permission-key lookup, with NO edge to the request stack.
 *
 * ═══ WHY THIS IS A SEPARATE MODULE ═══
 *
 * `hasPermission` is ten lines of pure logic over a plain object, and it lived
 * in `permission-middleware.ts` — which value-imports `getTenantCtx` from
 * `@/app-layer/context`, which imports `@/lib/auth`, which imports `@/auth`,
 * which builds the NextAuth provider array at module scope.
 *
 * That chain is fine in a Next request and FATAL in the BullMQ worker, a plain
 * Node process where `next/headers` does not resolve and
 * `next-auth/providers/google` interops to a namespace rather than a callable:
 *
 *     ERR_MODULE_NOT_FOUND  file:///app/node_modules/next/headers   (at boot)
 *     TypeError: Google is not a function                    (at job execution)
 *
 * `context-system.ts` already documents that edge and states the rule it
 * exists to hold — "nothing here may import `@/lib/auth`, `@/auth`, or
 * anything else that reaches them" — after eight registered jobs dragged the
 * whole NextAuth tree in, four of them only transitively through a usecase,
 * with nothing in their own file to say so.
 *
 * The compliance-calendar aggregation reaches it the same way, through this
 * one function. Nothing has broken yet only because no JOB imports the
 * aggregation today; the first one that does is the per-user calendar push.
 *
 * ═══ WHY IT MATTERS MORE THAN IT LOOKS ═══
 *
 * `executor-registry.ts` loads each job with a dynamic `await import(...)` at
 * execution time, not at boot. So this failure does not stop the worker
 * starting and does not fail CI. It fails the first time the job actually
 * runs, in production, at whatever hour it is scheduled for — and a nightly
 * push that has never once succeeded looks exactly like a feature nobody uses.
 *
 * Cheapest possible fix for the most expensive possible failure mode, which is
 * why it lands before any calendar code rather than after the first incident.
 *
 * @module lib/security/permission-key
 */
import type { PermissionSet } from '@/lib/permissions';

/**
 * Dotted permission keys derived from `PermissionSet`, e.g.
 *   - "controls.create"
 *   - "evidence.upload"
 *   - "admin.scim"
 *
 * Compile-time exhaustive — adding an entry to `PermissionSet` widens this
 * union automatically, and a misspelled key fails to compile.
 *
 * NOTE there is a second, unrelated `PermissionKey` in `@/lib/permissions`
 * typed as bare `string`. Importing that one instead silently discards every
 * bit of key-name safety this union provides, and nothing fails. Import this.
 */
export type PermissionKey = {
    [Domain in keyof PermissionSet]: PermissionSet[Domain] extends Record<string, boolean>
        ? `${Domain & string}.${keyof PermissionSet[Domain] & string}`
        : never;
}[keyof PermissionSet];

/**
 * Look up a permission flag on a resolved `appPermissions` set.
 * Returns `false` for an unknown key — fail-closed.
 */
export function hasPermission(
    appPermissions: PermissionSet,
    key: PermissionKey,
): boolean {
    const [domain, action] = key.split('.') as [keyof PermissionSet, string];
    const bag = appPermissions[domain] as Record<string, boolean> | undefined;
    return Boolean(bag && bag[action] === true);
}
