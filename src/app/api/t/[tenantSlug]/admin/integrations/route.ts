/**
 * Integration Connection Management API
 *
 * GET    /api/t/[tenantSlug]/admin/integrations — list connections (secrets masked)
 * POST   /api/t/[tenantSlug]/admin/integrations — create/update connection
 * PUT    /api/t/[tenantSlug]/admin/integrations — validate connection
 * DELETE /api/t/[tenantSlug]/admin/integrations — disable connection
 *
 * Admin-only. Secrets are encrypted at rest (AES-256-GCM).
 * Secrets are NEVER returned after creation — only a masked status.
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import {
    listIntegrationConnections,
    upsertIntegrationConnection,
    removeIntegrationConnection,
    listAvailableProviders,
    updateConnectionTestStatus,
} from '@/app-layer/usecases/integrations';
import { registry } from '@/app-layer/integrations/registry';
import { jsonResponse } from '@/lib/api-response';
import { publicBaseUrl } from '@/lib/http/public-base-url';

/**
 * GET — list all integration connections for this tenant.
 * Secrets are never included. Returns provider metadata too.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {

    const connections = await listIntegrationConnections(ctx) as Array<Record<string, unknown>>;

    // Build webhook endpoint URL for display
    const baseUrl = publicBaseUrl(req);

    return jsonResponse({
        connections: connections.map((c: Record<string, unknown>) => ({
            ...c,
            hasSecret: true, // secrets exist but are masked
            secretStatus: '••••••••',
            webhookUrl: `${baseUrl}/api/integrations/webhooks/${c.provider}`,
        })),
        availableProviders: listAvailableProviders(),
        webhookBaseUrl: `${baseUrl}/api/integrations/webhooks`,
    });
    }),
);

/**
 * POST — create or update an integration connection.
 * Secrets are encrypted before storage. Plaintext is never persisted.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {

    const body = await req.json() as {
        id?: string;
        provider: string;
        name: string;
        configJson?: Record<string, unknown>;
        secrets?: Record<string, unknown>;
        isEnabled?: boolean;
    };

    // Validate required fields
    if (!body.provider || typeof body.provider !== 'string') {
        return jsonResponse({ error: 'provider is required' }, { status: 400 });
    }
    if (!body.name || typeof body.name !== 'string') {
        return jsonResponse({ error: 'name is required' }, { status: 400 });
    }

    // Validate provider exists in registry
    if (!registry.getProvider(body.provider)) {
        return jsonResponse({
            error: `Unknown provider: ${body.provider}`,
            availableProviders: registry.listProviderIds(),
        }, { status: 400 });
    }

    const connection = await upsertIntegrationConnection(ctx, {
        id: body.id,
        provider: body.provider,
        name: body.name,
        configJson: body.configJson,
        secrets: body.secrets,
        isEnabled: body.isEnabled,
    });

    // Return connection WITHOUT secrets
    return jsonResponse({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        isEnabled: connection.isEnabled,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
        secretStatus: body.secrets ? 'configured' : 'unchanged',
        warning: body.secrets ? 'Secrets have been encrypted and stored. They cannot be retrieved.' : undefined,
    }, { status: body.id ? 200 : 201 });
    }),
);

/**
 * PUT — validate/test an integration connection.
 * Tests connectivity without saving changes.
 */
export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {

    const body = await req.json() as {
        connectionId?: string;
        provider: string;
        configJson?: Record<string, unknown>;
        secrets?: Record<string, unknown>;
    };

    if (!body.provider) {
        return jsonResponse({ error: 'provider is required' }, { status: 400 });
    }

    const providerImpl = registry.getProvider(body.provider);
    if (!providerImpl) {
        return jsonResponse({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
    }

    // Validate connection
    const result = await providerImpl.validateConnection(
        body.configJson ?? {},
        body.secrets ?? {}
    );

    // If validating existing connection, update test status via usecase
    if (body.connectionId) {
        await updateConnectionTestStatus(ctx, body.connectionId, result.valid ? 'ok' : 'error');
    }

    return jsonResponse({
        valid: result.valid,
        error: result.error,
        testedAt: new Date().toISOString(),
    });
    }),
);

/**
 * DELETE — disable an integration connection.
 */
export const DELETE = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {

    const { connectionId } = await req.json() as { connectionId: string };
    if (!connectionId) {
        return jsonResponse({ error: 'connectionId required' }, { status: 400 });
    }

    await removeIntegrationConnection(ctx, connectionId);

    return jsonResponse({ ok: true });
    }),
);
