/**
 * Epic B — Org Audit Trail (read path).
 *
 * Cursor-paginated read of the per-organization `OrgAuditLog`. The
 * write path is `appendOrgAuditEntry` in `@/lib/audit/org-audit-writer`,
 * called from every privilege-mutating org usecase.
 *
 * RBAC: callers must have already passed `canManageMembers` at the
 * route layer — this usecase does NOT re-derive permission since the
 * policy decision belongs at the API boundary.
 *
 * ## Pagination
 *
 * Cursor encodes `(occurredAt, id)`. The query orders strictly:
 *
 *     ORDER BY "occurredAt" DESC, "id" DESC
 *
 * The cursor `WHERE` clause:
 *
 *     (occurredAt < cursor.occurredAt) OR
 *     (occurredAt = cursor.occurredAt AND id < cursor.id)
 *
 * Identical shape to `src/lib/pagination.ts` but keyed on `occurredAt`
 * because that's the canonical hash-chain timestamp on this model
 * (`createdAt` doesn't exist on OrgAuditLog).
 */
import prisma from '@/lib/prisma';
import type { OrgContext } from '@/app-layer/types';
import { OrgAuditAction } from '@prisma/client';
import { encodeCursor, decodeCursor, clampLimit } from '@/lib/pagination';

export interface ListOrgAuditInput {
    cursor?: string | null;
    limit?: number;
    action?: OrgAuditAction;
}

export interface OrgAuditRow {
    id: string;
    occurredAt: string; // ISO-8601
    action: OrgAuditAction;
    actorType: string;
    actor: {
        id: string;
        email: string | null;
        name: string | null;
    } | null;
    target: {
        id: string;
        email: string | null;
        name: string | null;
    } | null;
    detailsJson: unknown;
    /**
     * The invitee an `ORG_INVITE_*` row is about, resolved at READ time from
     * `detailsJson.inviteId` (#5950): the row names the invite, never its
     * address. `null` when the row names no invite or the invite is gone.
     */
    invitee: { email: string } | null;
    requestId: string | null;
    entryHash: string;
    previousHash: string | null;
    version: number;
}

export interface ListOrgAuditResult {
    rows: OrgAuditRow[];
    nextCursor: string | null;
}

export async function listOrgAudit(
    ctx: OrgContext,
    input: ListOrgAuditInput = {},
): Promise<ListOrgAuditResult> {
    const limit = clampLimit(input.limit);

    // Cursor — base64-encoded { occurredAt, id }. Reuses the
    // pagination util's encoder/decoder; the field name is overloaded
    // because the util types it as `createdAt` for legacy reasons.
    let cursorOccurredAt: Date | null = null;
    let cursorId: string | null = null;
    if (input.cursor) {
        const decoded = decodeCursor(input.cursor);
        if (decoded) {
            cursorOccurredAt = new Date(decoded.createdAt);
            cursorId = decoded.id;
        }
    }

    const cursorWhere = cursorOccurredAt && cursorId
        ? {
              OR: [
                  { occurredAt: { lt: cursorOccurredAt } },
                  {
                      AND: [
                          { occurredAt: cursorOccurredAt },
                          { id: { lt: cursorId } },
                      ],
                  },
              ],
          }
        : null;

    const where = {
        organizationId: ctx.organizationId,
        ...(input.action ? { action: input.action } : {}),
        ...(cursorWhere ? cursorWhere : {}),
    };

    const rows = await prisma.orgAuditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
            id: true,
            occurredAt: true,
            action: true,
            actorType: true,
            actorUserId: true,
            targetUserId: true,
            detailsJson: true,
            requestId: true,
            entryHash: true,
            previousHash: true,
            version: true,
            actor: { select: { id: true, email: true, name: true } },
            target: { select: { id: true, email: true, name: true } },
        },
    });

    const hasNextPage = rows.length > limit;
    const trimmed = hasNextPage ? rows.slice(0, limit) : rows;
    const last = trimmed[trimmed.length - 1];
    // The invitee of each invite row, by the id the row carries (#5950, owner
    // decision 2026-11-25): one bounded read for the page, inside this org.
    const inviteIdOf = (detailsJson: unknown): string | null => {
        if (detailsJson === null || typeof detailsJson !== 'object' || Array.isArray(detailsJson)) return null;
        const id = (detailsJson as Record<string, unknown>).inviteId;
        return typeof id === 'string' && id !== '' ? id : null;
    };
    const inviteIds = [...new Set(trimmed.map((r) => inviteIdOf(r.detailsJson)).filter((id): id is string => id !== null))];
    const invites = inviteIds.length === 0
        ? []
        : await prisma.orgInvite.findMany({
              where: { organizationId: ctx.organizationId, id: { in: inviteIds } },
              select: { id: true, email: true },
              take: inviteIds.length,
          });
    const inviteEmail = new Map(invites.map((i) => [i.id, i.email] as const));

    const nextCursor = hasNextPage && last
        ? encodeCursor({
              createdAt: last.occurredAt.toISOString(),
              id: last.id,
          })
        : null;

    return {
        rows: trimmed.map((r): OrgAuditRow => ({
            id: r.id,
            occurredAt: r.occurredAt.toISOString(),
            action: r.action,
            actorType: r.actorType,
            actor: r.actor ?? null,
            target: r.target ?? null,
            detailsJson: r.detailsJson,
            invitee: (() => {
                const id = inviteIdOf(r.detailsJson);
                const email = id === null ? undefined : inviteEmail.get(id);
                return email === undefined ? null : { email };
            })(),
            requestId: r.requestId,
            entryHash: r.entryHash,
            previousHash: r.previousHash,
            version: r.version,
        })),
        nextCursor,
    };
}
