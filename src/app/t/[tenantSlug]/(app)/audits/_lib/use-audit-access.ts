'use client';
import { useMemo } from 'react';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { ApiClientError } from '@/lib/api-client';
import { auditReadinessAccess, type AuditReadinessAccess } from '@/lib/audit-readiness/access';

/**
 * What the audits pages may offer the signed-in member, from the same role
 * predicates the server's audit-readiness policies read (#4129). Gate a control
 * on this, never on `audits.manage` / `audits.share`: those keys hold different
 * populations from the roles the server admits.
 */
export function useAuditReadinessAccess(): AuditReadinessAccess {
    const { role, appPermissions } = useTenantContext();
    return useMemo(() => auditReadinessAccess({ role, appPermissions }), [role, appPermissions]);
}

/**
 * A read refused as NOT FOUND. The audits API answers a missing cycle or pack
 * with a 404 (`notFound(...)`), which `apiGet` throws as an `ApiClientError`
 * — so it arrives as SWR's `error`, not as `data === null`, and must be told
 * apart from an outage there.
 */
export function isNotFoundError(error: unknown): boolean {
    return error instanceof ApiClientError && error.status === 404;
}
