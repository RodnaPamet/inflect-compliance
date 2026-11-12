/**
 * Authentication-path security event emitter.
 *
 * Two sinks, picked based on how much we know about the subject of the
 * event:
 *
 *   - **Hash-chained audit trail** (`appendAuditEntry`): used whenever
 *     we can attribute the event to a known User AND a TenantId. Audit
 *     rows are per-tenant, hash-chained, tamper-evident — the right
 *     home for events a tenant admin would legitimately want to review.
 *
 *   - **Structured operational logger** (`logger.info/warn`): catches
 *     everything that doesn't fit above — unknown-email attempts,
 *     rate-limit trips on not-yet-resolvable identifiers, mailer
 *     failures. Goes to the same pino pipeline as every other app log
 *     so Grafana/Sentry can alert on auth-anomaly patterns without
 *     bloating each tenant's audit table.
 *
 * The split keeps audit tables signal-rich (one row per real, tenant-
 * attributable security event) while still giving SREs visibility into
 * cross-tenant anomalies.
 *
 * ## What is NEVER emitted
 *   - Plaintext passwords (obviously)
 *   - Raw verification / password-reset tokens
 *   - The plaintext email address in structured metadata — only a
 *     deterministic SHA-256 hash, so log pipelines can still count
 *     per-identifier volume without leaking the identifier itself
 */

import crypto from 'node:crypto';

import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';

// ── Event catalog ──────────────────────────────────────────────────────
//
// Actions are string constants so callers can't typo them. The
// `AuditLog.action` column is a plain string — we don't need a DB-level
// enum — so this is the single source of truth for event names.

export const AUTH_ACTIONS = {
    LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
    LOGIN_FAILURE: 'AUTH_LOGIN_FAILURE',
    LOGIN_RATE_LIMITED: 'AUTH_LOGIN_RATE_LIMITED',
    LOGIN_EMAIL_VERIFICATION_REQUIRED: 'AUTH_LOGIN_EMAIL_VERIFICATION_REQUIRED',
    EMAIL_VERIFICATION_ISSUED: 'AUTH_EMAIL_VERIFICATION_ISSUED',
    EMAIL_VERIFIED: 'AUTH_EMAIL_VERIFIED',
    PASSWORD_RESET_REQUESTED: 'AUTH_PASSWORD_RESET_REQUESTED',
    PASSWORD_RESET_COMPLETED: 'AUTH_PASSWORD_RESET_COMPLETED',
    PASSWORD_CHANGED: 'AUTH_PASSWORD_CHANGED',
    UNVERIFIED_ACCOUNT_CLAIMED: 'AUTH_UNVERIFIED_ACCOUNT_CLAIMED',
} as const;

export type AuthActionValue = (typeof AUTH_ACTIONS)[keyof typeof AUTH_ACTIONS];

// ── Payload types ──────────────────────────────────────────────────────

export interface AuthEventBase {
    /** Normalised (trim+lowercase) email. Used for hashing + operational
     *  logs; NEVER stored in audit detailsJson. */
    email: string;
    /** If resolved, the user row id. Forward to appendAuditEntry. */
    userId?: string | null;
    /** Resolved tenant for audit attribution. If absent, event falls
     *  back to the structured logger. */
    tenantId?: string | null;
    /** Sign-in method. */
    method: 'credentials' | 'google' | 'microsoft-entra-id' | 'sso';
    /** Correlation id from the request context. */
    requestId?: string;
    /** Free-form extras — must not contain secrets / tokens / passwords. */
    metadata?: Record<string, unknown>;
}

export interface LoginFailurePayload extends AuthEventBase {
    reason:
        | 'credentials_invalid'
        | 'email_not_verified'
        | 'rate_limited'
        | 'unknown_email';
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Deterministic hash of the normalised email for metadata / logs. Same
 * value every time so Grafana can count per-identifier attempts without
 * ever seeing the raw address.
 */
export function hashEmailForLog(email: string): string {
    const normalised = (email ?? '').trim().toLowerCase();
    return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

async function resolvePrimaryTenantId(userId: string): Promise<string | null> {
    try {
        const m = await prisma.tenantMembership.findFirst({
            where: { userId, status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
            select: { tenantId: true },
        });
        return m?.tenantId ?? null;
    } catch {
        return null;
    }
}

async function writeAudit(params: {
    action: AuthActionValue;
    userId: string;
    tenantId: string;
    email: string;
    method: AuthEventBase['method'];
    reason?: string;
    requestId?: string;
    extra?: Record<string, unknown>;
}): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId: params.tenantId,
            userId: params.userId,
            actorType: 'USER',
            entity: 'Auth',
            entityId: params.userId,
            action: params.action,
            requestId: params.requestId ?? null,
            detailsJson: {
                category: 'custom',
                auth: {
                    method: params.method,
                    // Never write the raw email into the audit row — the
                    // hash is enough for correlation across events.
                    identifierHash: hashEmailForLog(params.email),
                    reason: params.reason,
                    ...params.extra,
                },
            },
        });
    } catch (err) {
        // Audit write MUST NOT fail the auth path. Fall back to a warn
        // log so the event still leaves a trace somewhere investigable.
        logger.warn('auth audit write failed', {
            component: 'auth',
            action: params.action,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Public API ─────────────────────────────────────────────────────────

export async function recordLoginSuccess(payload: AuthEventBase): Promise<void> {
    const identifierHash = hashEmailForLog(payload.email);
    logger.info('auth login succeeded', {
        component: 'auth',
        event: 'login_success',
        method: payload.method,
        userId: payload.userId ?? undefined,
        tenantId: payload.tenantId ?? undefined,
        identifierHash,
        requestId: payload.requestId,
    });

    const userId = payload.userId ?? null;
    let tenantId = payload.tenantId ?? null;
    if (userId && !tenantId) tenantId = await resolvePrimaryTenantId(userId);
    if (!userId || !tenantId) return; // No tenant → operational log only

    await writeAudit({
        action: AUTH_ACTIONS.LOGIN_SUCCESS,
        userId,
        tenantId,
        email: payload.email,
        method: payload.method,
        requestId: payload.requestId,
    });
}

export async function recordLoginFailure(payload: LoginFailurePayload): Promise<void> {
    const identifierHash = hashEmailForLog(payload.email);
    logger.warn('auth login failed', {
        component: 'auth',
        event: 'login_failure',
        method: payload.method,
        reason: payload.reason,
        // userId intentionally omitted for unknown_email reason to avoid
        // unintentional enumeration if someone lets logs out.
        ...(payload.reason !== 'unknown_email' && payload.userId
            ? { userId: payload.userId }
            : {}),
        identifierHash,
        requestId: payload.requestId,
    });

    const userId = payload.userId ?? null;
    let tenantId = payload.tenantId ?? null;
    if (userId && !tenantId) tenantId = await resolvePrimaryTenantId(userId);
    if (!userId || !tenantId) return;

    await writeAudit({
        action:
            payload.reason === 'rate_limited'
                ? AUTH_ACTIONS.LOGIN_RATE_LIMITED
                : payload.reason === 'email_not_verified'
                  ? AUTH_ACTIONS.LOGIN_EMAIL_VERIFICATION_REQUIRED
                  : AUTH_ACTIONS.LOGIN_FAILURE,
        userId,
        tenantId,
        email: payload.email,
        method: payload.method,
        reason: payload.reason,
        requestId: payload.requestId,
    });
}

export async function recordEmailVerificationIssued(params: {
    userId: string;
    email: string;
    tenantId?: string | null;
    requestId?: string;
}): Promise<void> {
    const identifierHash = hashEmailForLog(params.email);
    logger.info('auth email verification issued', {
        component: 'auth',
        event: 'email_verification_issued',
        userId: params.userId,
        identifierHash,
        requestId: params.requestId,
    });
    const tenantId = params.tenantId ?? (await resolvePrimaryTenantId(params.userId));
    if (!tenantId) return;
    await writeAudit({
        action: AUTH_ACTIONS.EMAIL_VERIFICATION_ISSUED,
        userId: params.userId,
        tenantId,
        email: params.email,
        method: 'credentials',
        requestId: params.requestId,
    });
}

export async function recordEmailVerified(params: {
    userId: string;
    email: string;
    tenantId?: string | null;
    requestId?: string;
}): Promise<void> {
    const identifierHash = hashEmailForLog(params.email);
    logger.info('auth email verified', {
        component: 'auth',
        event: 'email_verified',
        userId: params.userId,
        identifierHash,
        requestId: params.requestId,
    });
    const tenantId = params.tenantId ?? (await resolvePrimaryTenantId(params.userId));
    if (!tenantId) return;
    await writeAudit({
        action: AUTH_ACTIONS.EMAIL_VERIFIED,
        userId: params.userId,
        tenantId,
        email: params.email,
        method: 'credentials',
        requestId: params.requestId,
    });
}

// ── Password lifecycle ─────────────────────────────────────────────────
//
// Reset/change events only ever apply to credentials accounts (OAuth-
// only users have no password), so `method` is always 'credentials'.

export async function recordPasswordResetRequested(params: {
    userId: string;
    email: string;
    tenantId?: string | null;
    requestId?: string;
}): Promise<void> {
    logger.info('auth password reset requested', {
        component: 'auth',
        event: 'password_reset_requested',
        userId: params.userId,
        identifierHash: hashEmailForLog(params.email),
        requestId: params.requestId,
    });
    const tenantId = params.tenantId ?? (await resolvePrimaryTenantId(params.userId));
    if (!tenantId) return;
    await writeAudit({
        action: AUTH_ACTIONS.PASSWORD_RESET_REQUESTED,
        userId: params.userId,
        tenantId,
        email: params.email,
        method: 'credentials',
        requestId: params.requestId,
    });
}

export async function recordPasswordResetCompleted(params: {
    userId: string;
    email: string;
    tenantId?: string | null;
    requestId?: string;
}): Promise<void> {
    logger.info('auth password reset completed', {
        component: 'auth',
        event: 'password_reset_completed',
        userId: params.userId,
        identifierHash: hashEmailForLog(params.email),
        requestId: params.requestId,
    });
    const tenantId = params.tenantId ?? (await resolvePrimaryTenantId(params.userId));
    if (!tenantId) return;
    await writeAudit({
        action: AUTH_ACTIONS.PASSWORD_RESET_COMPLETED,
        userId: params.userId,
        tenantId,
        email: params.email,
        method: 'credentials',
        requestId: params.requestId,
    });
}

export async function recordPasswordChanged(params: {
    userId: string;
    email: string;
    tenantId?: string | null;
    requestId?: string;
}): Promise<void> {
    logger.info('auth password changed', {
        component: 'auth',
        event: 'password_changed',
        userId: params.userId,
        identifierHash: hashEmailForLog(params.email),
        requestId: params.requestId,
    });
    const tenantId = params.tenantId ?? (await resolvePrimaryTenantId(params.userId));
    if (!tenantId) return;
    await writeAudit({
        action: AUTH_ACTIONS.PASSWORD_CHANGED,
        userId: params.userId,
        tenantId,
        email: params.email,
        method: 'credentials',
        requestId: params.requestId,
    });
}

/**
 * A trusted OAuth sign-in claimed an account whose email had never been
 * verified, removing the credentials anybody else could hold
 * (`src/lib/auth/oauth-email-trust.ts`). Counts only; no identifiers beyond
 * the user id and the email hash.
 */
export async function recordUnverifiedAccountClaimed(params: {
    userId: string;
    email: string;
    method: 'google' | 'microsoft-entra-id';
    removedPassword: boolean;
    removedProviderLinks: number;
    requestId?: string;
}): Promise<void> {
    logger.warn('auth unverified account claimed by verified sign-in', {
        component: 'auth',
        event: 'unverified_account_claimed',
        userId: params.userId,
        identifierHash: hashEmailForLog(params.email),
        method: params.method,
        removedPassword: params.removedPassword,
        removedProviderLinks: params.removedProviderLinks,
        requestId: params.requestId,
    });
    const tenantId = await resolvePrimaryTenantId(params.userId);
    if (!tenantId) return;
    await writeAudit({
        action: AUTH_ACTIONS.UNVERIFIED_ACCOUNT_CLAIMED,
        userId: params.userId,
        tenantId,
        email: params.email,
        method: params.method,
        requestId: params.requestId,
        extra: {
            removedPassword: params.removedPassword,
            removedProviderLinks: params.removedProviderLinks,
        },
    });
}
