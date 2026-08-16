/**
 * Auth utilities for Inflect Compliance.
 *
 * This module bridges Auth.js v5 sessions to the existing API route
 * interface (getSession, getSessionOrThrow, requireRole, etc.).
 *
 * Role hierarchy (Chunk 1):
 *   ADMIN > EDITOR > READER
 *   AUDITOR is a special role with read-only + audit access.
 *
 * TenantMembership is now authoritative for role assignment.
 * User.role and User.tenantId are deprecated backward-compat fields.
 */
import { auth } from '@/auth';
// `next/headers` is imported DYNAMICALLY, at its single use site below — never
// statically here.
//
// This module is reachable from the BullMQ worker: every usecase imports
// `@/app-layer/context`, which imports `getSessionOrThrow` from this file. A
// top-level `import { cookies } from 'next/headers'` therefore had to resolve
// inside `scripts/worker.ts`, where `next/headers` is not resolvable — the
// worker died at module load with ERR_MODULE_NOT_FOUND before registering a
// single executor, so NO background job ran at all.
//
// `src/auth.ts:466` and `src/lib/security/session-tracker.ts:88` already do it
// this way. This file was the one that did not.
import jwt from 'jsonwebtoken';
import prisma from './prisma';
import type { Role, User } from '@prisma/client';
import { env } from '@/env';
import { unauthorized, forbidden } from '@/lib/errors/types';

export interface JwtPayload {
    userId: string;
    tenantId: string;
    email: string;
    role: Role;
}

// Legacy JWT secret — used only for reading old cookies during migration

/**
 * Get the current session by:
 * 1. Trying Auth.js session first
 * 2. Falling back to legacy JWT cookie for migration
 *
 * tenantId and role are resolved from TenantMembership (default membership).
 */
export async function getSession(): Promise<JwtPayload | null> {
    // 1. Try Auth.js session
    const session = await auth();
    if (session?.user) {
        return {
            userId: session.user.id,
            tenantId: session.user.tenantId ?? '',
            email: session.user.email ?? '',
            role: session.user.role ?? 'READER',
        };
    }

    // The legacy `token` cookie fallback used to live here, and it was a
    // SECOND session mechanism that honoured none of the first one's
    // revocation.
    //
    // It read the cookie, `jwt.verify`'d it against JWT_SECRET, and
    // returned a full session — userId, tenantId, email, role — straight
    // into `getSessionOrThrow`, which builds the RequestContext every
    // usecase runs on (src/app-layer/context.ts). It checked no
    // `sessionVersion`, no `UserSession.revokedAt`, and never called
    // `verifyAndTouchSession`.
    //
    // So a password change or reset (which bumps sessionVersion and
    // revokes every UserSession), an admin revoking a session from
    // /admin/members, and the Epic C.3 concurrent-session cap all left a
    // legacy cookie working for the rest of its 7-day life.
    //
    // Three comments asserted nothing read it — the writer's said "no
    // `cookies.get('token')` anywhere" while this function did exactly
    // that, twenty lines from its own gate. `LEGACY_JWT_SECRET` reads
    // `env.JWT_SECRET`, a core auth variable set in production, so the
    // `if` that looked like a kill switch was always true.
    //
    // Removing the reader is what makes outstanding cookies inert. The
    // writer is gone too (api/auth/register), and the signup client has
    // always called `signIn('credentials', …)` immediately afterwards, so
    // this cookie was never the session it appeared to be.
    return null;
}

export async function getSessionOrThrow(): Promise<JwtPayload> {
    const session = await getSession();
    if (!session) throw unauthorized();
    return session;
}

export async function getCurrentUser(): Promise<User | null> {
    const session = await getSession();
    if (!session) return null;
    return prisma.user.findUnique({ where: { id: session.userId } });
}

// ─── RBAC helpers (Chunk 1: unified roles) ───

/**
 * Linear hierarchy for standard roles.
 * AUDITOR is sidecar — not in the linear chain.
 */
const ROLE_HIERARCHY: Record<Role, number> = {
    OWNER: 5,
    ADMIN: 4,
    EDITOR: 3,
    AUDITOR: 2,
    READER: 1,
};

export function hasMinRole(userRole: Role, minRole: Role): boolean {
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole];
}

// ─── Permission-based helpers ───

/**
 * Can read tenant/scope data (all roles).
 *
 * Epic 1 — OWNER is strictly superior to ADMIN per CLAUDE.md's RBAC
 * section. These five legacy helpers each include OWNER explicitly
 * because OWNER is the canonical role for every tenant created via
 * `createTenantWithOwner` (and every seed tenant after the GAP-07
 * step-6 alignment). The modern `requirePermission(<key>, ...)` path
 * via `PermissionSet` already treats OWNER correctly (see
 * `src/lib/permissions.ts::getPermissionsForRole`); these helpers
 * are the legacy path used by policies + a few admin-style routes.
 */
export function canRead(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR'].includes(role);
}

/** Can write/mutate data (OWNER, ADMIN, EDITOR) */
export function canWrite(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'EDITOR'].includes(role);
}

/** Can perform admin operations (OWNER, ADMIN) */
export function canAdmin(role: Role): boolean {
    return role === 'OWNER' || role === 'ADMIN';
}

/** Can perform audit-specific operations (OWNER, ADMIN, AUDITOR) */
export function canAudit(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'AUDITOR'].includes(role);
}

/** Can export data (OWNER, ADMIN, EDITOR, AUDITOR) */
export function canExport(role: Role): boolean {
    return ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR'].includes(role);
}

/** Can edit data — alias for canWrite for backward compat */
export function canEdit(role: Role): boolean {
    return canWrite(role);
}

export function requireRole(session: JwtPayload, minRole: Role): void {
    if (!hasMinRole(session.role, minRole)) {
        throw forbidden('Forbidden: insufficient permissions');
    }
}

// ─── Membership-based role checks ───

/**
 * Check if a user has a specific role (or higher) on a tenant.
 * Resolves from TenantMembership table.
 */
export async function hasTenantRole(
    userId: string,
    tenantId: string,
    requiredRole: Role
): Promise<boolean> {
    const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
    });
    if (!membership) return false;
    return hasMinRole(membership.role, requiredRole);
}

// ─── Legacy helpers kept for backward compatibility ───

// Same ESM/CJS interop normalisation as src/lib/auth/passwords.ts.
// Without it, Node ≥ 22 returns the namespace with bcryptjs's exports
// under `.default`, and `bcrypt.compare` is undefined.
async function loadBcrypt(): Promise<typeof import('bcryptjs')> {
    const m = await import('bcryptjs');
    return (m as unknown as { default?: typeof m }).default ?? m;
}

export async function hashPassword(password: string): Promise<string> {
    const bcrypt = await loadBcrypt();
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(
    password: string,
    hash: string
): Promise<boolean> {
    const bcrypt = await loadBcrypt();
    return bcrypt.compare(password, hash);
}

// signToken / verifyToken removed with the legacy `token` cookie they
// existed for. signToken had exactly one caller (api/auth/register) and
// verifyToken had none — the deprecation note above them had already
// spelled out this deletion; what kept it from happening was the belief
// that the cookie was unread, which src/lib/auth.ts's own fallback
// disproved.

