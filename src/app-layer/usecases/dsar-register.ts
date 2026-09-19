/**
 * DSAR register — manual-fulfilment queue over `DataSubjectRequest`.
 *
 * This records and tracks GDPR Art. 15 (export) and Art. 17 (erasure)
 * requests. It does **not** fulfil them. `jobs/dsar-export.ts` throws
 * unconditionally and is unregistered (docs/dsar.md Stage 2).
 * `jobs/dsar-erasure.ts::eraseUser` was implemented by Stage 3 (#2287) and
 * DOES execute — but it is unregistered and nothing calls it, this module
 * included. Moving a request to COMPLETED here asserts that a human did the
 * work out-of-band — nothing in this module exports or erases anything, and
 * `exportUrl` is never written. Wiring erasure to this register is the
 * operator-entry-point decision #2287 deliberately left open; it needs an
 * answer to who may run it and with what audit record, not just a call.
 *
 * ─── THE TENANT-SCOPING HAZARD (read before editing) ───────────────────
 *
 * `DataSubjectRequest` has NO `tenantId`, deliberately: a DSAR is
 * user-scoped and spans every tenant the subject belongs to. The
 * consequence is severe and easy to miss:
 *
 *   • The model is on NEITHER isolation axis. It is not in
 *     `TENANT_SCOPED_MODELS` (no tenantId) nor `ORG_SCOPED_MODELS`, so no
 *     `tenant_isolation` RLS policy exists for this table.
 *   • `runInTenantContext` still sets `app.tenant_id` and switches to
 *     `app_user`, but NO POLICY CONSULTS IT HERE. The wrapper buys
 *     transaction scoping and audit-context plumbing — not isolation.
 *   • No guardrail covers this. `rls-coverage`, `tenant-isolation-*` and
 *     the forward-lock all iterate tenant-scoped models, so this table is
 *     invisible to them.
 *
 * Therefore `scopedToTenantMembers()` below is the ONLY thing preventing a
 * tenant admin from reading every DSAR on the platform. A `findMany` that
 * omits it returns other tenants' rights requests and **CI stays green**.
 * Never query this model without it. The two-tenant behavioural test in
 * `tests/integration/dsar-register-isolation.test.ts` is the compensating
 * control for the absent DB backstop.
 *
 * @module app-layer/usecases/dsar-register
 */
import type { Prisma, DataSubjectRequestStatus, DataSubjectRequestType } from '@prisma/client';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { DSAR_AUDIT_ACTIONS, DSAR_REJECTION_REASONS } from '@/lib/dsar';
import {
    checkDsarTransition,
    formatDsarTransitionError,
    requiresReason,
    type DsarStatus,
} from '../domain/dsar-status';

/**
 * The isolation predicate. Restricts a DSAR query to subjects who are ACTIVE
 * members of the acting tenant.
 *
 * ACTIVE only — an INVITED user has not accepted, and a DEACTIVATED or
 * REMOVED one has left. Neither should surface a rights request to this
 * tenant's staff. This is deliberately stricter than
 * `resolveTenantContext`, which tolerates INVITED for request-gating.
 */
function scopedToTenantMembers(tenantId: string): Prisma.DataSubjectRequestWhereInput {
    return {
        user: {
            tenantMemberships: {
                some: { tenantId, status: 'ACTIVE' },
            },
        },
    };
}

/** Three-state preserving sanitiser: undefined = leave, null = clear. */
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

export interface DsarRegisterRow {
    id: string;
    type: DataSubjectRequestType;
    status: DataSubjectRequestStatus;
    subject: { id: string; email: string | null; name: string | null };
    requestedAt: Date;
    verifiedAt: Date | null;
    completedAt: Date | null;
    rejectionReason: string | null;
    fulfilmentNotes: string | null;
    handledBy: { id: string; name: string | null } | null;
}

const ROW_SELECT = {
    id: true,
    type: true,
    status: true,
    requestedAt: true,
    verifiedAt: true,
    completedAt: true,
    rejectionReason: true,
    fulfilmentNotes: true,
    user: { select: { id: true, email: true, name: true } },
    handledBy: { select: { id: true, name: true } },
} satisfies Prisma.DataSubjectRequestSelect;

type RawRow = Prisma.DataSubjectRequestGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(r: RawRow): DsarRegisterRow {
    return {
        id: r.id,
        type: r.type,
        status: r.status,
        subject: { id: r.user.id, email: r.user.email, name: r.user.name },
        requestedAt: r.requestedAt,
        verifiedAt: r.verifiedAt,
        completedAt: r.completedAt,
        rejectionReason: r.rejectionReason,
        fulfilmentNotes: r.fulfilmentNotes,
        handledBy: r.handledBy ? { id: r.handledBy.id, name: r.handledBy.name } : null,
    };
}

/** List the register for the acting tenant. Requires `admin.compliance_dsar_view`. */
export async function listDsarRequests(
    ctx: RequestContext,
    filters: { status?: DsarStatus } = {},
): Promise<DsarRegisterRow[]> {
    if (!ctx.appPermissions?.admin?.compliance_dsar_view) {
        throw forbidden('Not permitted to view the data-subject-request register.');
    }

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.dataSubjectRequest.findMany({
            where: {
                ...scopedToTenantMembers(ctx.tenantId),
                ...(filters.status ? { status: filters.status } : {}),
            },
            select: ROW_SELECT,
            orderBy: [{ requestedAt: 'desc' }],
            take: 500,
        });
        return rows.map(toRow);
    });
}

/**
 * Record a request that arrived out-of-band (email, post, support ticket).
 *
 * The subject MUST be an active member of the acting tenant — staff cannot
 * file a request against a user they have no relationship with.
 */
export async function recordDsarRequest(
    ctx: RequestContext,
    input: { userId: string; type: DataSubjectRequestType; notes?: string | null },
): Promise<DsarRegisterRow> {
    if (!ctx.appPermissions?.admin?.compliance_dsar_manage) {
        throw forbidden('Not permitted to manage the data-subject-request register.');
    }

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: input.userId, status: 'ACTIVE' },
            select: { id: true },
        });
        if (!membership) {
            throw notFound('No active member of this tenant with that id.');
        }

        const created = await db.dataSubjectRequest.create({
            data: {
                userId: input.userId,
                type: input.type,
                status: 'RECEIVED',
                fulfilmentNotes: sanitizeOptional(input.notes) ?? null,
            },
            select: ROW_SELECT,
        });

        await logEvent(db, ctx, {
            action: DSAR_AUDIT_ACTIONS.REQUESTED,
            entityType: 'DataSubjectRequest',
            entityId: created.id,
            detailsJson: {
                category: 'access',
                targetUserId: input.userId,
                summary: `${input.type} request recorded for manual fulfilment`,
            },
        });

        return toRow(created);
    });
}

/**
 * Advance a request. Fulfilment is MANUAL — this records that a human did
 * something, it does not perform an export or an erasure.
 */
export async function transitionDsarRequest(
    ctx: RequestContext,
    id: string,
    input: { to: DsarStatus; reason?: string | null; notes?: string | null },
): Promise<DsarRegisterRow> {
    if (!ctx.appPermissions?.admin?.compliance_dsar_manage) {
        throw forbidden('Not permitted to manage the data-subject-request register.');
    }

    if (requiresReason(input.to)) {
        const allowed = Object.values(DSAR_REJECTION_REASONS) as string[];
        if (!input.reason || !allowed.includes(input.reason)) {
            throw badRequest(
                `A rejection requires one of: ${allowed.join(', ')}. ` +
                    '"We refused this" is not a defensible register entry without the why.',
            );
        }
    }

    return runInTenantContext(ctx, async (db) => {
        // The scoping predicate rides on the READ too — otherwise a guessed id
        // from another tenant would be transitionable.
        const existing = await db.dataSubjectRequest.findFirst({
            where: { id, ...scopedToTenantMembers(ctx.tenantId) },
            select: { id: true, status: true, userId: true },
        });
        if (!existing) throw notFound('Data-subject request not found.');

        // Enforce the state machine BEFORE any write.
        const err = checkDsarTransition(existing.status, input.to, 'admin');
        if (err) throw badRequest(formatDsarTransitionError(err));

        const now = new Date();
        const updated = await db.dataSubjectRequest.update({
            where: { id },
            data: {
                status: input.to,
                handledById: ctx.userId,
                ...(input.notes !== undefined
                    ? { fulfilmentNotes: sanitizeOptional(input.notes) ?? null }
                    : {}),
                ...(input.to === 'REJECTED' ? { rejectionReason: input.reason ?? null } : {}),
                ...(input.to === 'VERIFIED' ? { verifiedAt: now } : {}),
                ...(input.to === 'COMPLETED' ? { completedAt: now } : {}),
                // exportUrl is deliberately never set — nothing here produces a
                // bundle. See the module header.
            },
            select: ROW_SELECT,
        });

        const action =
            input.to === 'COMPLETED'
                ? DSAR_AUDIT_ACTIONS.COMPLETED
                : input.to === 'REJECTED'
                  ? DSAR_AUDIT_ACTIONS.REJECTED
                  : input.to === 'CANCELED'
                    ? DSAR_AUDIT_ACTIONS.CANCELED
                    : DSAR_AUDIT_ACTIONS.VERIFIED;

        await logEvent(db, ctx, {
            action,
            entityType: 'DataSubjectRequest',
            entityId: id,
            detailsJson: {
                category: 'access',
                targetUserId: existing.userId,
                fromStatus: existing.status,
                toStatus: input.to,
                ...(input.reason ? { reason: input.reason } : {}),
                summary: `DSAR moved ${existing.status} → ${input.to} (manual fulfilment)`,
            },
        });

        return toRow(updated);
    });
}
