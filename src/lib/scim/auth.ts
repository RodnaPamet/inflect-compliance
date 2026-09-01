/**
 * SCIM 2.0 Authentication Middleware
 *
 * Authenticates SCIM requests using tenant-scoped bearer tokens.
 * The token is hashed (SHA-256) and looked up in TenantScimToken.
 * The tenant is resolved from the token, NOT from the caller.
 *
 * Usage:
 *   const scimCtx = await authenticateScimRequest(req);
 *   // scimCtx.tenantId is the tenant that owns the token
 */
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { recordScimAuth } from '@/lib/observability/metrics';

export interface ScimContext {
    tenantId: string;
    tokenId: string;
    tokenLabel: string;
}

export class ScimAuthError extends Error {
    public readonly status: number;
    public readonly scimType: string;

    constructor(message: string, status = 401, scimType = 'invalidToken') {
        super(message);
        this.name = 'ScimAuthError';
        this.status = status;
        this.scimType = scimType;
    }
}

/**
 * An authenticated SCIM caller asking for something the SCIM surface is not
 * allowed to do at all — a 403, not a 401.
 *
 * Subclasses `ScimAuthError` on purpose: every SCIM route already catches that
 * type and renders it as a SCIM-shaped error body with the carried status, so
 * refusals reach the client correctly without touching a single route.
 */
export class ScimForbiddenError extends ScimAuthError {
    constructor(message: string, scimType = 'mutability') {
        super(message, 403, scimType);
        this.name = 'ScimForbiddenError';
    }
}

/**
 * A member `value` in a Groups write resolved to no linked identity.
 *
 * Subclasses `ScimAuthError` for the same reason `ScimForbiddenError` does:
 * every SCIM route already renders that type with its carried status, so a
 * 400 reaches the client correctly without touching a route.
 */
export class ScimUnresolvableMemberError extends ScimAuthError {
    constructor(unresolved: number, supplied: number) {
        super(
            `${unresolved} of ${supplied} member values could not be resolved to a linked identity. `
            + 'Member `value` must be the identity-provider subject identifier, not the id returned '
            + 'by GET /Groups (this SP emits its own User ids on read, per RFC 7643). '
            + 'Read-modify-write of the members array is not supported.',
            400,
            'invalidValue',
        );
        this.name = 'ScimUnresolvableMemberError';
    }
}

/**
 * Hash a bearer token with SHA-256 for lookup.
 */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Authenticate a SCIM request by extracting and validating the bearer token.
 * Returns a ScimContext with the resolved tenantId.
 *
 * Throws ScimAuthError if:
 * - No Authorization header
 * - Token not found or revoked
 */
export async function authenticateScimRequest(req: NextRequest): Promise<ScimContext> {
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        recordScimAuth({ outcome: 'failure', reason: 'missing_header' });
        throw new ScimAuthError('Missing or invalid Authorization header', 401);
    }

    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (!rawToken) {
        recordScimAuth({ outcome: 'failure', reason: 'empty_token' });
        throw new ScimAuthError('Empty bearer token', 401);
    }

    const tokenHash = hashToken(rawToken);

    const scimToken = await prisma.tenantScimToken.findUnique({
        where: { tokenHash },
        include: { tenant: { select: { id: true, slug: true } } },
    });

    if (!scimToken) {
        recordScimAuth({ outcome: 'failure', reason: 'not_found' });
        logger.warn('SCIM auth failed: token not found', { component: 'scim' });
        throw new ScimAuthError('Invalid SCIM token', 401);
    }

    if (scimToken.revokedAt) {
        recordScimAuth({ outcome: 'failure', reason: 'revoked' });
        logger.warn('SCIM auth failed: token revoked', { component: 'scim', tokenId: scimToken.id });
        throw new ScimAuthError('SCIM token has been revoked', 401);
    }

    // Update lastUsedAt (fire-and-forget, don't block the request)
    prisma.tenantScimToken.update({
        where: { id: scimToken.id },
        data: { lastUsedAt: new Date() },
    }).catch(() => { /* swallow — non-critical */ });

    recordScimAuth({ outcome: 'success', reason: 'ok' });
    logger.info('SCIM request authenticated', {
        component: 'scim',
        tenantId: scimToken.tenantId,
        tokenId: scimToken.id,
        tokenLabel: scimToken.label,
    });

    return {
        tenantId: scimToken.tenantId,
        tokenId: scimToken.id,
        tokenLabel: scimToken.label,
    };
}
