/**
 * Audit Readiness Policies
 * Authorization checks for audit cycles, packs, shares, and auditor access.
 *
 * Epic 1 — OWNER is strictly superior to ADMIN per CLAUDE.md's RBAC
 * section, so every gate that historically read `'ADMIN'` now also
 * accepts `'OWNER'`. The seed admin (acme-corp) is OWNER after the
 * GAP-07 step-6 alignment, and any production tenant created via
 * `createTenantWithOwner` has its first user as OWNER.
 */
import { RequestContext } from '../types';
import { forbidden } from '@/lib/errors/types';

export function assertCanManageAuditCycles(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'EDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage audit cycles');
    }
}

export function assertCanManageAuditPacks(ctx: RequestContext) {
    if (!['OWNER', 'ADMIN', 'EDITOR'].includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage audit packs');
    }
}

export function assertCanFreezePack(ctx: RequestContext) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can freeze audit packs');
    }
}

export function assertCanSharePack(ctx: RequestContext) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can share audit packs');
    }
}

export function assertCanViewPack(ctx: RequestContext) {
    // AI_ADMIN (#3699) reads like a READER, so it views packs like one.
    if (!['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'].includes(ctx.role)) {
        throw forbidden('Cannot view audit packs');
    }
}

export function assertCanManageAuditors(ctx: RequestContext) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw forbidden('Only OWNER or ADMIN can manage auditor accounts');
    }
}
