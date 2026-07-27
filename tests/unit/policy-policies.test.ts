/**
 * Policy Policies — role matrix + custom-role (granular) enforcement.
 *
 * These gates are the fix for the defect where a custom role's own
 * restrictions were resolved onto the request context and then never
 * consulted: every policy usecase called the GENERIC assertCanRead/Write/Admin,
 * which reads only the coarse base-role view. So `policies: { approve: false }`
 * on a `baseRole: ADMIN` role still approved, published, archived and purged.
 *
 * The matrix below therefore tests BOTH layers deliberately:
 *   - the coarse role tier (unchanged behaviour), and
 *   - the granular `appPermissions.policies.*` flags, including the
 *     fail-closed and absent-layer branches, which is where the bug lived.
 */
import {
    assertCanReadPolicies,
    assertCanCreatePolicy,
    assertCanWritePolicies,
    assertCanApprovePolicies,
    assertCanAdminPolicies,
} from '@/app-layer/policies/policy.policies';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

type Role = 'ADMIN' | 'EDITOR' | 'READER' | 'AUDITOR';

function makeCtx(
    role: Role,
    appPermissions?: PermissionSet | undefined,
    hasAppPermissions = true,
): RequestContext {
    const canWrite = role === 'ADMIN' || role === 'EDITOR';
    const canAdmin = role === 'ADMIN';
    const canAudit = role === 'AUDITOR' || role === 'ADMIN';
    return {
        requestId: 'test-req',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role,
        permissions: {
            canRead: true,
            canWrite,
            canAdmin,
            canAudit,
            canExport: canAdmin || canAudit,
        },
        // `hasAppPermissions: false` models the defensive branch where no
        // granular layer is present at all and the coarse check stands alone.
        appPermissions: hasAppPermissions
            ? appPermissions ?? getPermissionsForRole(role)
            : undefined,
    } as RequestContext;
}

/** A custom role: a base-role permission set with `policies` flags overridden. */
function withPolicyFlags(
    role: Role,
    flags: Partial<PermissionSet['policies']>,
): PermissionSet {
    const base = getPermissionsForRole(role);
    return { ...base, policies: { ...base.policies, ...flags } };
}

describe('Policy Policies — coarse role tier', () => {
    it.each(['ADMIN', 'EDITOR', 'READER', 'AUDITOR'] as const)('%s can read', (role) => {
        expect(() => assertCanReadPolicies(makeCtx(role))).not.toThrow();
    });

    it.each(['ADMIN', 'EDITOR'] as const)('%s can create / write', (role) => {
        expect(() => assertCanCreatePolicy(makeCtx(role))).not.toThrow();
        expect(() => assertCanWritePolicies(makeCtx(role))).not.toThrow();
    });

    it.each(['READER', 'AUDITOR'] as const)('%s cannot create / write', (role) => {
        expect(() => assertCanCreatePolicy(makeCtx(role))).toThrow();
        expect(() => assertCanWritePolicies(makeCtx(role))).toThrow();
    });

    it('only ADMIN may approve or manage the lifecycle', () => {
        expect(() => assertCanApprovePolicies(makeCtx('ADMIN'))).not.toThrow();
        expect(() => assertCanAdminPolicies(makeCtx('ADMIN'))).not.toThrow();
        for (const role of ['EDITOR', 'READER', 'AUDITOR'] as const) {
            expect(() => assertCanApprovePolicies(makeCtx(role))).toThrow();
            expect(() => assertCanAdminPolicies(makeCtx(role))).toThrow();
        }
    });
});

describe('Policy Policies — custom-role flags are enforced (the actual bug)', () => {
    it('an ADMIN-based custom role with policies.approve=false cannot approve', () => {
        const ctx = makeCtx('ADMIN', withPolicyFlags('ADMIN', { approve: false }));
        expect(() => assertCanApprovePolicies(ctx)).toThrow(/approve policies/i);
        // …and the flag is specific: the lifecycle gate reads `edit`, so it
        // is unaffected by revoking `approve`.
        expect(() => assertCanAdminPolicies(ctx)).not.toThrow();
    });

    it('an ADMIN-based custom role with policies.edit=false cannot publish/archive/purge', () => {
        const ctx = makeCtx('ADMIN', withPolicyFlags('ADMIN', { edit: false }));
        expect(() => assertCanAdminPolicies(ctx)).toThrow(/policy lifecycle/i);
        expect(() => assertCanWritePolicies(ctx)).toThrow(/modify policies/i);
    });

    it('policies.view=false denies reads even for a role whose base tier allows them', () => {
        const ctx = makeCtx('EDITOR', withPolicyFlags('EDITOR', { view: false }));
        expect(() => assertCanReadPolicies(ctx)).toThrow(/view policies/i);
    });

    it('policies.create=false denies creation while leaving edit intact', () => {
        const ctx = makeCtx('EDITOR', withPolicyFlags('EDITOR', { create: false }));
        expect(() => assertCanCreatePolicy(ctx)).toThrow(/create policies/i);
        expect(() => assertCanWritePolicies(ctx)).not.toThrow();
    });

    it('a granted flag NEVER widens the base role (tighten-only)', () => {
        // The route layer reads appPermissions and would let this through;
        // the usecase must still refuse, which is why the coarse check runs
        // first rather than being replaced.
        const ctx = makeCtx('READER', withPolicyFlags('READER', { edit: true, create: true }));
        expect(() => assertCanWritePolicies(ctx)).toThrow();
        expect(() => assertCanCreatePolicy(ctx)).toThrow();
    });

    it('a present-but-partial policies object fails CLOSED', () => {
        // `!== true` denies, so a malformed/partial custom-role JSON that
        // omits the flag is treated as "not granted" rather than "granted".
        const base = getPermissionsForRole('ADMIN');
        const partial = {
            ...base,
            policies: {} as unknown as PermissionSet['policies'],
        };
        expect(() => assertCanApprovePolicies(makeCtx('ADMIN', partial))).toThrow();
        expect(() => assertCanAdminPolicies(makeCtx('ADMIN', partial))).toThrow();
        expect(() => assertCanReadPolicies(makeCtx('ADMIN', partial))).toThrow();
    });

    it('an appPermissions object with NO policies key at all fails closed', () => {
        // Distinct from the empty-object case above: here `policies` is
        // absent rather than empty, which takes the `?.` branch. Both must
        // deny — a permission set that cannot answer the question is not a
        // permission set that grants it.
        const base = getPermissionsForRole('ADMIN');
        const { policies: _omitted, ...withoutPolicies } = base;
        const ctx = makeCtx('ADMIN', withoutPolicies as unknown as PermissionSet);
        expect(() => assertCanApprovePolicies(ctx)).toThrow();
        expect(() => assertCanReadPolicies(ctx)).toThrow();
    });

    it('no granular layer at all falls back to the coarse check alone', () => {
        // Defensive branch: contexts built without appPermissions must keep
        // working on the base role rather than denying everything.
        expect(() => assertCanReadPolicies(makeCtx('READER', undefined, false))).not.toThrow();
        expect(() => assertCanWritePolicies(makeCtx('EDITOR', undefined, false))).not.toThrow();
        expect(() => assertCanApprovePolicies(makeCtx('ADMIN', undefined, false))).not.toThrow();
        expect(() => assertCanAdminPolicies(makeCtx('ADMIN', undefined, false))).not.toThrow();
        expect(() => assertCanWritePolicies(makeCtx('READER', undefined, false))).toThrow();
    });
});
