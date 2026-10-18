/**
 * Shared test helper for building RequestContext fixtures.
 *
 * All test files that create mock RequestContext objects should use
 * this helper to ensure they include all required fields, including
 * appPermissions (added for custom role support in Epic 21).
 */
import type { Role } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

/**
 * Build a complete RequestContext for tests.
 *
 * @param role - The Role enum value (defaults to ADMIN)
 * @param overrides - Partial overrides to any field
 */
export function makeRequestContext(
    role: Role | string = 'ADMIN',
    overrides?: Partial<RequestContext>,
): RequestContext {
    const r = role as Role;
    return {
        requestId: 'req-test',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: r,
        permissions: {
            canRead: true,
            canWrite: r === 'OWNER' || r === 'ADMIN' || r === 'EDITOR',
            canAdmin: r === 'OWNER' || r === 'ADMIN',
            canAudit: r === 'OWNER' || r === 'ADMIN' || r === 'AUDITOR',
            // AI_ADMIN (#3699) sits on READER's rung of the coarse ladder.
            canExport: r !== 'READER' && r !== 'AI_ADMIN',
        },
        appPermissions: getPermissionsForRole(r),
        ...overrides,
    };
}

/**
 * Default ADMIN appPermissions — inline constant for test files
 * that construct RequestContext literals without using makeRequestContext.
 */
export const ADMIN_APP_PERMISSIONS = getPermissionsForRole('ADMIN');
export const EDITOR_APP_PERMISSIONS = getPermissionsForRole('EDITOR');
export const READER_APP_PERMISSIONS = getPermissionsForRole('READER');
export const AUDITOR_APP_PERMISSIONS = getPermissionsForRole('AUDITOR');
