/**
 * SCIM Token Management API
 *
 * GET    /api/t/[tenantSlug]/admin/scim — list SCIM tokens (masked)
 * POST   /api/t/[tenantSlug]/admin/scim — generate new token (returns plaintext ONCE)
 * DELETE /api/t/[tenantSlug]/admin/scim — revoke a token
 *
 * Admin-only. Tokens are stored as SHA-256 hashes. The plaintext is only
 * returned on creation and cannot be retrieved afterward.
 *
 * Minting and revoking are AUDITED (#4868). A SCIM token lets whoever holds it
 * create and deactivate members, so who issued one, and who took one away, is
 * the workspace's business in the same way an API key's is. Neither row
 * carries the token or its hash.
 */
import { NextRequest } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import prisma from '@/lib/prisma';
import { jsonResponse } from '@/lib/api-response';
import { publicBaseUrl } from '@/lib/http/public-base-url';
import { logEvent } from '@/app-layer/events/audit';
import { notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';

const MAX_LABEL = 100;
const CreateSchema = z.object({ label: z.string().max(MAX_LABEL).optional() });
const RevokeSchema = z.object({ tokenId: z.string().min(1) });

/**
 * GET — list SCIM tokens for tenant (admin.scim only).
 * Returns token metadata only (never the actual token value).
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.scim', async (req: NextRequest, _routeArgs, ctx) => {
        const tokens = await prisma.tenantScimToken.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true,
                label: true,
                lastUsedAt: true,
                revokedAt: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        // Also return the SCIM endpoint base URL for admin visibility
        const baseUrl = publicBaseUrl(req);

        return jsonResponse({
            tokens,
            scimEndpoint: `${baseUrl}/api/scim/v2`,
            isEnabled: tokens.some((t) => !t.revokedAt),
        });
    }),
);

/**
 * POST — generate a new SCIM bearer token (admin.scim only).
 * Returns the plaintext token ONCE. It is stored as a SHA-256 hash.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.scim', async (req: NextRequest, _routeArgs, ctx) => {
        const body = CreateSchema.parse(await req.json());
        const label = sanitizePlainText(body.label ?? '').trim() || 'SCIM Token';

        // Generate a cryptographically secure token
        const plaintext = `scim_${randomBytes(32).toString('base64url')}`;
        const tokenHash = createHash('sha256').update(plaintext).digest('hex');

        const token = await prisma.tenantScimToken.create({
            data: {
                tenantId: ctx.tenantId,
                label,
                tokenHash,
            },
            select: { id: true, label: true, createdAt: true },
        });

        await logEvent(prisma, ctx, {
            action: 'SCIM_TOKEN_CREATED',
            entityType: 'TenantScimToken',
            entityId: token.id,
            details: `Created SCIM token: ${label}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantScimToken',
                operation: 'created',
                after: { label },
            },
        });

        // Return the plaintext token ONCE — it cannot be retrieved again
        return jsonResponse(
            {
                ...token,
                plaintext,
                warning: 'Copy this token now. It will not be shown again.',
            },
            { status: 201 },
        );
    }),
);

/**
 * DELETE — revoke a SCIM token (admin.scim only).
 */
export const DELETE = withApiErrorHandling(
    requirePermission('admin.scim', async (req: NextRequest, _routeArgs, ctx) => {
        const { tokenId } = RevokeSchema.parse(await req.json());

        // Verify token belongs to this tenant
        const existing = await prisma.tenantScimToken.findFirst({
            where: { id: tokenId, tenantId: ctx.tenantId },
        });

        if (!existing) {
            throw notFound('This token no longer exists in this workspace.');
        }
        if (existing.revokedAt) {
            return jsonResponse({ ok: true, revokedAt: existing.revokedAt.toISOString() });
        }

        const revokedAt = new Date();
        await prisma.tenantScimToken.update({
            where: { id: tokenId },
            data: { revokedAt },
        });

        await logEvent(prisma, ctx, {
            action: 'SCIM_TOKEN_REVOKED',
            entityType: 'TenantScimToken',
            entityId: existing.id,
            details: `Revoked SCIM token: ${existing.label}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantScimToken',
                operation: 'deleted',
                summary: `Revoked SCIM token: ${existing.label}`,
            },
        });

        return jsonResponse({ ok: true, revokedAt: revokedAt.toISOString() });
    }),
);
