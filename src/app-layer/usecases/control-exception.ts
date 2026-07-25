/**
 * Epic G-5 — Control Exception Register usecases.
 *
 *   • requestException     — admin-or-owner submits a new exception
 *                             in REQUESTED state.
 *   • approveException     — admin transitions REQUESTED → APPROVED.
 *   • rejectException      — admin transitions REQUESTED → REJECTED.
 *   • renewException       — creates a NEW row (REQUESTED) with
 *                             `renewedFromId` pointing at the prior
 *                             row. Renewal lineage is per-row, never
 *                             a status mutation.
 *   • getExpiringExceptions(days) — read path used by the dashboard
 *                             + the eventual expiry-monitor job.
 *
 * Lifecycle invariants (DB CHECK is the storage-layer backstop;
 * these usecases enforce the same shape at the application boundary
 * with clearer error messages):
 *
 *   - REQUESTED is the only state that transitions to APPROVED or
 *     REJECTED. Any other input → 400.
 *   - APPROVED requires `expiresAt` (the approval form supplies it).
 *   - REJECTED carries a required free-text `reason`.
 *   - REJECTED + EXPIRED are terminal — no transitions out.
 *   - Renewal can target ANY non-deleted prior row; it doesn't
 *     mutate the prior row, it links to it.
 *
 * Audit emission — every transition emits a hash-chained AuditLog
 * row (`category: 'status_change'` for transitions, `'entity_lifecycle'`
 * for create/renew). Live `Control.status` is NEVER mutated by these
 * usecases — exception state is a separate axis.
 */
import { RequestContext } from '../types';
import { ControlExceptionRepository } from '../repositories/ControlExceptionRepository';
import { assertCanAdmin, assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import {
    RequestExceptionSchema,
    ApproveExceptionSchema,
    RejectExceptionSchema,
    RenewExceptionSchema,
    type RequestExceptionInput,
    type ApproveExceptionInput,
    type RejectExceptionInput,
    type RenewExceptionInput,
} from '../schemas/control-exception.schemas';

// ─── Read paths ───────────────────────────────────────────────────────

export async function listControlExceptions(
    ctx: RequestContext,
    options: {
        take?: number;
        status?: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
        controlId?: string;
    } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        ControlExceptionRepository.list(db, ctx, options),
    );
}

export async function getControlException(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const ex = await ControlExceptionRepository.getById(db, ctx, id);
        if (!ex) throw notFound('Control exception not found');
        return ex;
    });
}

// ─── requestException ────────────────────────────────────────────────

export interface RequestExceptionResult {
    exceptionId: string;
}

/**
 * Submit a new exception. Caller must have write permission in the
 * tenant. The control must exist + live in the same tenant
 * (composite FK enforces); the optional compensating control too.
 */
export async function requestException(
    ctx: RequestContext,
    input: unknown,
): Promise<RequestExceptionResult> {
    assertCanWrite(ctx);
    const parsed: RequestExceptionInput = RequestExceptionSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // Verify the control belongs to this tenant — RLS would
        // surface a generic FK error; explicit check gives a better
        // message and keeps the user's "control not found" path
        // distinct from "wrong-tenant" leaks.
        const control = await db.control.findFirst({
            where: { id: parsed.controlId, tenantId: ctx.tenantId },
            select: { id: true, name: true },
        });
        if (!control) throw notFound('Control not found');

        if (parsed.compensatingControlId) {
            const comp = await db.control.findFirst({
                where: {
                    id: parsed.compensatingControlId,
                    tenantId: ctx.tenantId,
                },
                select: { id: true },
            });
            if (!comp) throw notFound('Compensating control not found');
        }

        // The body-supplied risk acceptor must be a real, ACTIVE member
        // of this tenant — otherwise the exception attributes risk
        // acceptance to an arbitrary (or cross-tenant) user id.
        const riskAcceptor = await db.tenantMembership.findFirst({
            where: {
                tenantId: ctx.tenantId,
                userId: parsed.riskAcceptedByUserId,
                status: 'ACTIVE',
            },
            select: { id: true },
        });
        if (!riskAcceptor) {
            throw notFound('Risk acceptor is not an active member of this tenant');
        }

        const created = await ControlExceptionRepository.create(db, ctx, {
            controlId: parsed.controlId,
            justification: sanitizePlainText(parsed.justification),
            compensatingControlId: parsed.compensatingControlId ?? null,
            riskAcceptedByUserId: parsed.riskAcceptedByUserId,
            expiresAt: parsed.expiresAt ?? null,
        });

        await logEvent(db, ctx, {
            action: 'CONTROL_EXCEPTION_REQUESTED',
            entityType: 'ControlException',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ControlException',
                operation: 'create',
                summary: `Exception requested for control "${control.name}"`,
                after: {
                    controlId: parsed.controlId,
                    compensatingControlId: parsed.compensatingControlId ?? null,
                    riskAcceptedByUserId: parsed.riskAcceptedByUserId,
                    expiresAt: parsed.expiresAt?.toISOString() ?? null,
                },
            },
        });

        return { exceptionId: created.id };
    });
}

// ─── approveException ────────────────────────────────────────────────

export interface ApproveExceptionResult {
    exceptionId: string;
    expiresAt: Date;
}

export async function approveException(
    ctx: RequestContext,
    id: string,
    input: unknown,
): Promise<ApproveExceptionResult> {
    assertCanAdmin(ctx);
    const parsed: ApproveExceptionInput = ApproveExceptionSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.controlException.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true, controlId: true, createdByUserId: true },
        });
        if (!existing) throw notFound('Control exception not found');
        // Separation of duties: the requester cannot self-approve, even
        // with admin rights. Checked after the row loads so we have the
        // authoritative createdByUserId (never trust a body-supplied one).
        if (existing.createdByUserId === ctx.userId) {
            throw forbidden(
                'You cannot approve your own exception request — separation of duties requires a different approver.',
            );
        }
        if (existing.status !== 'REQUESTED') {
            throw badRequest(
                `Cannot approve an exception in status ${existing.status}; only REQUESTED rows can be approved.`,
            );
        }
        if (parsed.expiresAt.getTime() <= Date.now()) {
            throw badRequest(
                'expiresAt must be in the future — approving an already-expired exception is not allowed.',
            );
        }

        const now = new Date();
        const count = await ControlExceptionRepository.approve(
            db,
            ctx,
            id,
            now,
            parsed.expiresAt,
        );
        if (count === 0) {
            // Concurrent transition raced us — surface a 400 rather
            // than the generic notFound so the caller can retry the
            // GET + read the new state.
            throw badRequest(
                'Exception state changed concurrently — refresh and retry.',
            );
        }

        await logEvent(db, ctx, {
            action: 'CONTROL_EXCEPTION_APPROVED',
            entityType: 'ControlException',
            entityId: id,
            detailsJson: {
                category: 'status_change',
                entityName: 'ControlException',
                fromStatus: 'REQUESTED',
                toStatus: 'APPROVED',
                summary: `Exception ${id} approved; expires ${parsed.expiresAt.toISOString()}`,
                after: {
                    controlId: existing.controlId,
                    expiresAt: parsed.expiresAt.toISOString(),
                    hasNote: Boolean(parsed.note),
                },
            },
        });

        return { exceptionId: id, expiresAt: parsed.expiresAt };
    });
}

// ─── rejectException ─────────────────────────────────────────────────

export interface RejectExceptionResult {
    exceptionId: string;
}

export async function rejectException(
    ctx: RequestContext,
    id: string,
    input: unknown,
): Promise<RejectExceptionResult> {
    assertCanAdmin(ctx);
    const parsed: RejectExceptionInput = RejectExceptionSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.controlException.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true, controlId: true, createdByUserId: true },
        });
        if (!existing) throw notFound('Control exception not found');
        // Separation of duties: the requester cannot self-reject, even
        // with admin rights. Checked after the row loads so we have the
        // authoritative createdByUserId (never trust a body-supplied one).
        if (existing.createdByUserId === ctx.userId) {
            throw forbidden(
                'You cannot reject your own exception request — separation of duties requires a different reviewer.',
            );
        }
        if (existing.status !== 'REQUESTED') {
            throw badRequest(
                `Cannot reject an exception in status ${existing.status}; only REQUESTED rows can be rejected.`,
            );
        }

        const now = new Date();
        const count = await ControlExceptionRepository.reject(
            db,
            ctx,
            id,
            now,
            sanitizePlainText(parsed.reason),
        );
        if (count === 0) {
            throw badRequest(
                'Exception state changed concurrently — refresh and retry.',
            );
        }

        await logEvent(db, ctx, {
            action: 'CONTROL_EXCEPTION_REJECTED',
            entityType: 'ControlException',
            entityId: id,
            detailsJson: {
                category: 'status_change',
                entityName: 'ControlException',
                fromStatus: 'REQUESTED',
                toStatus: 'REJECTED',
                summary: `Exception ${id} rejected`,
                after: {
                    controlId: existing.controlId,
                    hasReason: true,
                },
            },
        });

        return { exceptionId: id };
    });
}

// ─── renewException ──────────────────────────────────────────────────

export interface RenewExceptionResult {
    /// The NEW exception row's id. The prior row is untouched.
    exceptionId: string;
    /// The prior row this renewal points at.
    renewedFromId: string;
}

/**
 * Create a new REQUESTED row pointing at `id` via `renewedFromId`.
 * Audit history of the prior row is preserved verbatim — renewal is
 * never a status mutation.
 *
 * Defaults:
 *   • justification copied from prior row when not supplied
 *   • compensatingControlId copied from prior row when not supplied
 *   • riskAcceptedByUserId copied from prior row when not supplied
 *   • expiresAt left null at request time (the approver supplies it)
 */
export async function renewException(
    ctx: RequestContext,
    id: string,
    input: unknown,
): Promise<RenewExceptionResult> {
    assertCanWrite(ctx);
    const parsed: RenewExceptionInput = RenewExceptionSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const prior = await db.controlException.findFirst({
            where: { id, tenantId: ctx.tenantId, deletedAt: null },
            select: {
                id: true,
                controlId: true,
                justification: true,
                compensatingControlId: true,
                riskAcceptedByUserId: true,
                status: true,
            },
        });
        if (!prior) throw notFound('Prior exception not found');

        // Renewal target is sensible from any non-deleted state, but
        // operationally only EXPIRED + APPROVED-near-expiry make
        // sense; reject REJECTED renewals to avoid laundering a
        // declined exception through the renewal flow.
        if (prior.status === 'REJECTED') {
            throw badRequest(
                'Cannot renew a REJECTED exception — submit a fresh requestException instead.',
            );
        }

        const justification = parsed.justification
            ? sanitizePlainText(parsed.justification)
            : prior.justification;
        const compensatingControlId =
            parsed.compensatingControlId !== undefined
                ? parsed.compensatingControlId
                : prior.compensatingControlId;
        const riskAcceptedByUserId =
            parsed.riskAcceptedByUserId ?? prior.riskAcceptedByUserId;

        const created = await ControlExceptionRepository.create(db, ctx, {
            controlId: prior.controlId,
            justification,
            compensatingControlId,
            riskAcceptedByUserId,
            expiresAt: parsed.expiresAt ?? null,
            renewedFromId: prior.id,
        });

        await logEvent(db, ctx, {
            action: 'CONTROL_EXCEPTION_RENEWED',
            entityType: 'ControlException',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ControlException',
                operation: 'renew',
                summary: `Exception renewed from ${prior.id}`,
                after: {
                    renewedFromId: prior.id,
                    controlId: prior.controlId,
                    riskAcceptedByUserId,
                    compensatingControlId: compensatingControlId ?? null,
                },
            },
        });

        return { exceptionId: created.id, renewedFromId: prior.id };
    });
}

// ─── getExpiringExceptions ───────────────────────────────────────────

export interface ExpiringException {
    id: string;
    tenantId: string;
    controlId: string;
    controlName: string | null;
    controlCode: string | null;
    expiresAt: Date;
    riskAcceptedByUserId: string;
}

/**
 * Tenant-scoped — returns the caller's own approved exceptions
 * whose `expiresAt` falls within the next `days` days. Used by the
 * dashboard.
 *
 * For the system-wide expiry-monitor job (no tenantId), see the
 * `findExpiringWithin` repository helper directly — that path
 * doesn't go through assertCanRead because it runs unattended.
 */
export async function getExpiringExceptions(
    ctx: RequestContext,
    days: number,
): Promise<ExpiringException[]> {
    assertCanRead(ctx);
    if (!Number.isFinite(days) || days < 0) {
        throw badRequest(
            'days must be a non-negative finite number.',
        );
    }
    return runInTenantContext(ctx, async (db) => {
        const rows = await ControlExceptionRepository.findExpiringWithin(db, {
            now: new Date(),
            days,
            tenantId: ctx.tenantId,
        });
        return rows
            .filter((r): r is typeof r & { expiresAt: Date } => r.expiresAt !== null)
            .map((r) => ({
                id: r.id,
                tenantId: r.tenantId,
                controlId: r.controlId,
                controlName: r.control?.name ?? null,
                controlCode: r.control?.code ?? null,
                expiresAt: r.expiresAt,
                riskAcceptedByUserId: r.riskAcceptedByUserId,
            }));
    });
}

// The system-wide variant for the expiry-monitor job lives in the
// jobs module (prompt 4) — it imports the global prisma client
// directly, which the no-direct-prisma ratchet forbids in usecases.
