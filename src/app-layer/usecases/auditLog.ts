import { RequestContext } from '../types';
import { AuditLogRepository } from '../repositories/AuditLogRepository';
import { assertCanAudit } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { auditPersonKey, auditPersonRef, type AuditPersonRef } from '@/lib/audit/audit-person';

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
    return runInTenantContext(ctx, async (db) => {
        const page = await AuditLogRepository.listPage(db, ctx, { cursor: input.cursor ?? null, limit: AUDIT_LOG_PAGE_SIZE });
        // Who each row is about. A row names a person by id only (#5950, owner
        // decision 2026-11-25), so the page resolves the id here, while the
        // person exists; `label` is null once they do not, and the id remains.
        const refs = page.rows.map((r) => auditPersonRef(r));
        const labels = await AuditLogRepository.resolvePeople(
            db,
            ctx,
            refs.filter((ref): ref is AuditPersonRef => ref !== null),
        );
        return {
            nextCursor: page.nextCursor,
            rows: page.rows.map((r, i) => {
                const ref = refs[i];
                return {
                    ...r,
                    person: ref === null ? null : { id: ref.id, label: labels.get(auditPersonKey(ref)) ?? null },
                };
            }),
        };
    });
}
