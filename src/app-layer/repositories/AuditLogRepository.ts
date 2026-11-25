import { PrismaTx } from '@/lib/db-context';
import { buildCursorWhere, computePageInfo, CURSOR_ORDER_BY } from '@/lib/pagination';
import { auditPersonKey, type AuditPersonKind, type AuditPersonRef } from '@/lib/audit/audit-person';
import { RequestContext } from '../types';

export class AuditLogRepository {
    static async list(db: PrismaTx, ctx: RequestContext) {
        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: { user: { select: { name: true, email: true } } },
        });
    }

    /**
     * One page of the tenant's log, newest first, for the Audit log page.
     *
     * Cursor-paged on `(createdAt, id)` with the shared `@/lib/pagination`
     * helpers — the shape the org audit page uses — reading one row past
     * `limit`, so whether an older page exists is a fact held rather than a
     * guess. A cursor that does not decode reads the newest page.
     *
     * Selects only what the page shows: no metadata, hashes or request ids.
     * `entityId` is read because it can name the person the row is about
     * (`auditPersonRef`).
     */
    static async listPage(
        db: PrismaTx,
        ctx: RequestContext,
        input: { cursor?: string | null; limit: number },
    ) {
        const cursorWhere = buildCursorWhere(input.cursor);
        const rows = await db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, ...(cursorWhere ?? {}) },
            orderBy: CURSOR_ORDER_BY,
            take: input.limit + 1,
            select: {
                id: true,
                createdAt: true,
                action: true,
                entity: true,
                entityId: true,
                details: true,
                detailsJson: true,
                user: { select: { name: true } },
            },
        });
        const { trimmedItems, nextCursor } = computePageInfo(rows, input.limit);
        return { rows: trimmedItems, nextCursor: nextCursor ?? null };
    }

    /**
     * A label for each person a page's rows name by id (#5950): a user's or
     * an auditor's name, else their address; an employee's name; an invite's
     * or a vendor assessment's address. Resolved at READ time because the rows
     * hold ids only (owner decision 2026-11-25). A person who no longer exists
     * (erased, purged, deleted) gets no label, and the page shows the id.
     *
     * One bounded `findMany` per kind present, never one per row. Every
     * tenant-scoped kind is read inside the caller's tenant; `User` is global,
     * and the id came from this tenant's own trail.
     */
    static async resolvePeople(
        db: PrismaTx,
        ctx: RequestContext,
        refs: readonly AuditPersonRef[],
    ): Promise<Map<string, string>> {
        const idsOf = (kind: AuditPersonKind) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
        const users = idsOf('user');
        const auditors = idsOf('auditor');
        const employees = idsOf('employee');
        const invites = idsOf('invite');
        const respondents = idsOf('respondent');

        const [userRows, auditorRows, employeeRows, inviteRows, assessmentRows] = await Promise.all([
            users.length === 0
                ? []
                : db.user.findMany({
                      where: { id: { in: users } },
                      select: { id: true, name: true, email: true },
                      take: users.length,
                  }),
            auditors.length === 0
                ? []
                : db.auditorAccount.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: auditors } },
                      select: { id: true, name: true, email: true },
                      take: auditors.length,
                  }),
            employees.length === 0
                ? []
                : db.employee.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: employees } },
                      select: { id: true, fullName: true },
                      take: employees.length,
                  }),
            invites.length === 0
                ? []
                : db.tenantInvite.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: invites } },
                      select: { id: true, email: true },
                      take: invites.length,
                  }),
            respondents.length === 0
                ? []
                : db.vendorAssessment.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: respondents } },
                      select: { id: true, respondentEmail: true },
                      take: respondents.length,
                  }),
        ]);

        const labels = new Map<string, string>();
        const put = (kind: AuditPersonKind, id: string, label: string | null | undefined) => {
            if (typeof label === 'string' && label.trim() !== '') labels.set(auditPersonKey({ kind, id }), label);
        };
        for (const u of userRows) put('user', u.id, u.name || u.email);
        for (const a of auditorRows) put('auditor', a.id, a.name || a.email);
        for (const e of employeeRows) put('employee', e.id, e.fullName);
        for (const i of inviteRows) put('invite', i.id, i.email);
        for (const v of assessmentRows) put('respondent', v.id, v.respondentEmail);
        return labels;
    }
}
