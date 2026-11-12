/**
 * `assertCanAssignTasks` and `assertCanCommentOnTasks` (task.policies.ts),
 * per role shape (#5376).
 *
 * Assign follows the file's pattern: the coarse `canWrite` floor AND the
 * granular `tasks.assign` flag. Comment does NOT — its coarse floor is
 * `role === 'READER'`, not `canWrite`, and its granular flag is
 * `tasks.edit`. The cases below pin today's behaviour of both, including the
 * two places comment diverges from the rest of the file:
 *
 *   • with no granular layer (`appPermissions` absent) an AUDITOR and an
 *     AI_ADMIN context may comment, though neither may write a task;
 *   • a custom role over AUDITOR that grants `tasks.edit` may comment but may
 *     not edit, while one over READER granting the same key may do neither.
 *
 * Whether those are intended is an OPEN OWNER QUESTION (#5376 item 5): which
 * key should gate commenting, and whether the base role should matter. These
 * tests do not decide it; they make any change to it a visible diff.
 */
import type { Role } from '@prisma/client';
import {
    assertCanAssignTasks,
    assertCanCommentOnTasks,
    assertCanWriteTasks,
} from '@/app-layer/policies/task.policies';
import { parsePermissionsJson } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';

/** A custom role over `base`, resolved the way `getTenantCtx` resolves one. */
function customRole(base: Role, json: unknown): RequestContext {
    return makeRequestContext(base, { appPermissions: parsePermissionsJson(json, base) });
}

/** The defensive branch: a context with no granular layer at all. */
function noGranular(role: Role): RequestContext {
    const ctx = makeRequestContext(role);
    return { ...ctx, appPermissions: undefined } as unknown as RequestContext;
}

const allowed = (fn: (c: RequestContext) => void, c: RequestContext) => expect(() => fn(c)).not.toThrow();
const refused = (fn: (c: RequestContext) => void, c: RequestContext) =>
    expect(() => fn(c)).toThrow(expect.objectContaining({ status: 403 }));

describe('assertCanAssignTasks', () => {
    it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)('admits built-in %s', (role) => {
        allowed(assertCanAssignTasks, makeRequestContext(role));
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)('refuses built-in %s', (role) => {
        refused(assertCanAssignTasks, makeRequestContext(role));
    });

    it('refuses a custom role that withholds tasks.assign even though canWrite is true', () => {
        const ctx = customRole('EDITOR', { tasks: { assign: false } });
        expect(ctx.permissions.canWrite).toBe(true);
        expect(ctx.appPermissions.tasks.edit).toBe(true);
        refused(assertCanAssignTasks, ctx);
        // …while the same role may still edit: assign is its own key.
        allowed(assertCanWriteTasks, ctx);
    });

    it('refuses a custom role over READER that grants tasks.assign — the coarse floor still applies', () => {
        refused(assertCanAssignTasks, customRole('READER', { tasks: { assign: true } }));
    });

    it('refuses a present-but-partial tasks object (fails closed)', () => {
        const ctx = makeRequestContext('EDITOR');
        refused(assertCanAssignTasks, {
            ...ctx,
            appPermissions: { ...ctx.appPermissions, tasks: { view: true } },
        } as unknown as RequestContext);
    });

    describe('with no granular layer, the coarse check alone decides', () => {
        it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)('admits %s', (role) => {
            allowed(assertCanAssignTasks, noGranular(role));
        });
        it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)('refuses %s', (role) => {
            refused(assertCanAssignTasks, noGranular(role));
        });
    });
});

describe('assertCanCommentOnTasks — tasks.edit alone (owner decision 2026-11-12)', () => {
    it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)('admits built-in %s', (role) => {
        allowed(assertCanCommentOnTasks, makeRequestContext(role));
    });

    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)('refuses built-in %s (none holds tasks.edit)', (role) => {
        refused(assertCanCommentOnTasks, makeRequestContext(role));
    });

    it('refuses a custom role over EDITOR that withholds tasks.edit', () => {
        refused(assertCanCommentOnTasks, customRole('EDITOR', { tasks: { edit: false } }));
    });

    it('admits a custom role over EDITOR that withholds only tasks.assign', () => {
        const ctx = customRole('EDITOR', { tasks: { assign: false } });
        allowed(assertCanCommentOnTasks, ctx);
        refused(assertCanAssignTasks, ctx);
    });

    it('admits a custom role over READER that grants tasks.edit — the key decides, as the route does', () => {
        const ctx = customRole('READER', { tasks: { edit: true } });
        expect(ctx.appPermissions.tasks.edit).toBe(true);
        allowed(assertCanCommentOnTasks, ctx);
    });

    it('admits a custom role over AUDITOR that grants tasks.edit', () => {
        const ctx = customRole('AUDITOR', { tasks: { edit: true } });
        allowed(assertCanCommentOnTasks, ctx);
    });

    describe('with no granular layer, the coarse write tier stands in', () => {
        it.each(['OWNER', 'ADMIN', 'EDITOR'] as const)('admits %s', (role) => {
            allowed(assertCanCommentOnTasks, noGranular(role));
        });
        it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)('refuses %s', (role) => {
            refused(assertCanCommentOnTasks, noGranular(role));
        });
    });
});
