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
// The role sets live in one client-safe module so the audits pages gate their
// buttons on exactly what these assertions admit (#4129). Each assertion reads
// its set with `.includes(ctx.role)` in the condition itself, so the route
// authorization analyser (`tests/helpers/route-authorization-graph.ts`) sees a
// comparison of the role rather than a call it cannot look inside.
import {
    AUDIT_CYCLE_WRITER_ROLES, AUDIT_PACK_WRITER_ROLES, AUDIT_PACK_FREEZER_ROLES,
    AUDIT_PACK_SHARER_ROLES, AUDITOR_MANAGER_ROLES,
} from '@/lib/audit-readiness/access';

export function assertCanManageAuditCycles(ctx: RequestContext) {
    if (!AUDIT_CYCLE_WRITER_ROLES.includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage audit cycles');
    }
}

export function assertCanManageAuditPacks(ctx: RequestContext) {
    if (!AUDIT_PACK_WRITER_ROLES.includes(ctx.role)) {
        throw forbidden('Only OWNER, ADMIN, or EDITOR can manage audit packs');
    }
}

export function assertCanFreezePack(ctx: RequestContext) {
    if (!AUDIT_PACK_FREEZER_ROLES.includes(ctx.role)) {
        throw forbidden('Only OWNER or ADMIN can freeze audit packs');
    }
}

export function assertCanSharePack(ctx: RequestContext) {
    if (!AUDIT_PACK_SHARER_ROLES.includes(ctx.role)) {
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
    if (!AUDITOR_MANAGER_ROLES.includes(ctx.role)) {
        throw forbidden('Only OWNER or ADMIN can manage auditor accounts');
    }
}
