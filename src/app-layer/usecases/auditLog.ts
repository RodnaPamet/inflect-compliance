import { RequestContext } from '../types';
import { AuditLogRepository } from '../repositories/AuditLogRepository';
import { assertCanAudit } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';

export async function listAuditLogs(ctx: RequestContext) {
    assertCanAudit(ctx); // AUDITOR or ADMIN
    return runInTenantContext(ctx, (db) =>
        AuditLogRepository.list(db, ctx)
    );
}

/** Entries per page on the Audit log page — the page's long-standing size. */
export const AUDIT_LOG_PAGE_SIZE = 100;

/**
 * One page of the audit log for the Audit log page, newest first, with the
 * cursor of the next (older) page or `null` when this is the oldest. Same
 * gate as `listAuditLogs`.
 */
export async function listAuditLogPage(ctx: RequestContext, input: { cursor?: string | null } = {}) {
    assertCanAudit(ctx); // AUDITOR or ADMIN
    return runInTenantContext(ctx, (db) =>
        AuditLogRepository.listPage(db, ctx, { cursor: input.cursor ?? null, limit: AUDIT_LOG_PAGE_SIZE }),
    );
}
