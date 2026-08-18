/**
 * SharePoint connection-management usecases (SP-1).
 *
 * Owns the connection lifecycle on top of the generic `IntegrationConnection`
 * model: completing the delegated-consent flow, building an authed
 * `SharePointClient` (with refresh-on-expiry), testing, site selection, and
 * disconnect. Admin-gated + tenant-scoped (RLS via `runInTenantContext`).
 *
 * @module integrations/providers/sharepoint/service
 */
import type { RequestContext } from '../../../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanAdmin } from '../../../policies/common';
import { logEvent } from '../../../events/audit';
import { encryptField, decryptField } from '@/lib/security/encryption';
import { notFound, badRequest } from '@/lib/errors/types';
import { validateProviderConfig } from '../../config-schema';
import { Prisma } from '@prisma/client';
import { SharePointClient, type SharePointConnectionConfig } from './client';
import {
    exchangeCodeForSharePointToken,
    resolveSharePointAccessToken,
    type SharePointSecret,
} from './token';

export const SHAREPOINT_PROVIDER = 'sharepoint';

interface SharePointConfigJson {
    aadTenantId: string;
    allowedSiteIds: string[];
    defaultDriveId?: string;
    /** Per-drive Graph delta tokens (SP-3). */
    deltaTokens?: Record<string, string>;
}

/** Complete the consent flow: exchange the code and persist a connection. */
export async function completeSharePointConnect(
    ctx: RequestContext,
    input: { code: string; redirectUri: string; name?: string },
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ id: string }> {
    assertCanAdmin(ctx);
    const secret = await exchangeCodeForSharePointToken(
        { code: input.code, redirectUri: input.redirectUri },
        { fetchImpl: deps.fetchImpl },
    );
    const config: SharePointConfigJson = {
        aadTenantId: '',
        allowedSiteIds: [],
    };

    return runInTenantContext(ctx, async (db) => {
        let row;
        try {
            // This path creates the connection row DIRECTLY, bypassing
            // upsertIntegrationConnection — so validation wired only at the
            // usecase would read as complete while leaving SharePoint uncovered.
            // tests/guards/config-write-path-coverage.test.ts enumerates every
            // configJson writer so a new bypass cannot be added silently.
            row = await db.integrationConnection.create({
                data: {
                    tenantId: ctx.tenantId,
                    provider: SHAREPOINT_PROVIDER,
                    name: input.name?.trim() || 'SharePoint',
                    configJson: validateProviderConfig(
                        SHAREPOINT_PROVIDER,
                        config as unknown as Record<string, unknown>,
                    ) as unknown as Prisma.InputJsonValue,
                    secretEncrypted: encryptField(JSON.stringify(secret)),
                    isEnabled: true,
                },
            });
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw badRequest('A SharePoint connection with this name already exists');
            }
            throw e;
        }
        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_CREATED',
            entityType: 'IntegrationConnection',
            entityId: row.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'created',
                provider: SHAREPOINT_PROVIDER,
                summary: 'Connected SharePoint',
            },
        });
        return { id: row.id };
    });
}

/**
 * Load a connection (secret + config) — internal helper.
 *
 * `isEnabled: true` is in the WHERE clause, not just the select. It used to be
 * selected and never tested — here or at any call site — so an integration an
 * admin had explicitly DISABLED still authenticated and still received pushed
 * reports. Disabling an integration has to mean it stops working; a flag that
 * only affects how the row renders is not a control.
 */
async function loadConnection(db: PrismaTx, ctx: RequestContext, connectionId: string) {
    const conn = await db.integrationConnection.findFirst({
        where: { id: connectionId, tenantId: ctx.tenantId, provider: SHAREPOINT_PROVIDER, isEnabled: true },
    });
    if (!conn) throw notFound('SharePoint connection not found or disabled');
    return conn;
}

/**
 * Build a `SharePointClient` for a connection with a valid access token,
 * refreshing + persisting the rotated token when it has expired.
 */
export async function getSharePointClient(
    ctx: RequestContext,
    connectionId: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<SharePointClient> {
    return runInTenantContext(ctx, async (db) => {
        const conn = await loadConnection(db, ctx, connectionId);
        if (!conn.secretEncrypted) throw badRequest('SharePoint connection is missing credentials — reconnect');
        const secret = JSON.parse(decryptField(conn.secretEncrypted)) as SharePointSecret;
        const config = (conn.configJson ?? {}) as unknown as SharePointConfigJson;

        const { accessToken } = await resolveSharePointAccessToken(secret, {
            persist: async (rotated) => {
                await db.integrationConnection.update({
                    where: { id: conn.id },
                    data: { secretEncrypted: encryptField(JSON.stringify(rotated)) },
                });
            },
        });

        const clientConfig: SharePointConnectionConfig = {
            aadTenantId: config.aadTenantId ?? '',
            allowedSiteIds: config.allowedSiteIds ?? [],
            defaultDriveId: config.defaultDriveId,
            accessToken,
        };
        return new SharePointClient(clientConfig, deps.fetchImpl);
    });
}

/** Test a connection and record the result on the connection row. */
export async function testSharePointConnection(
    ctx: RequestContext,
    connectionId: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; message: string }> {
    assertCanAdmin(ctx);
    const client = await getSharePointClient(ctx, connectionId, deps);
    const result = await client.testConnection();
    await runInTenantContext(ctx, (db) =>
        db.integrationConnection.update({
            where: { id: connectionId },
            data: { lastTestedAt: new Date(), lastTestStatus: result.ok ? 'ok' : 'error' },
        }),
    );
    return { ok: result.ok, message: result.message };
}

/** List the sites the connection can reach (for the allowed-sites picker). */
export async function listSharePointSites(
    ctx: RequestContext,
    connectionId: string,
    deps: { fetchImpl?: typeof fetch } = {},
) {
    assertCanAdmin(ctx);
    const client = await getSharePointClient(ctx, connectionId, deps);
    return client.listSites();
}

/** Update which sites IC is allowed to access. */
export async function updateSharePointAllowedSites(
    ctx: RequestContext,
    connectionId: string,
    siteIds: string[],
): Promise<void> {
    assertCanAdmin(ctx);
    await runInTenantContext(ctx, async (db) => {
        const conn = await loadConnection(db, ctx, connectionId);
        const config = (conn.configJson ?? {}) as unknown as SharePointConfigJson;
        const next: SharePointConfigJson = { ...config, allowedSiteIds: siteIds };
        await db.integrationConnection.update({
            where: { id: conn.id },
            data: { configJson: next as unknown as Prisma.InputJsonValue },
        });
        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_UPDATED',
            entityType: 'IntegrationConnection',
            entityId: conn.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'updated',
                provider: SHAREPOINT_PROVIDER,
                summary: `Updated SharePoint allowed sites (${siteIds.length})`,
            },
        });
    });
}

/** Disconnect: remove the connection row. (SP-4 also revokes subscriptions.) */
export async function disconnectSharePoint(ctx: RequestContext, connectionId: string): Promise<void> {
    assertCanAdmin(ctx);
    await runInTenantContext(ctx, async (db) => {
        const conn = await loadConnection(db, ctx, connectionId);
        await db.integrationConnection.delete({ where: { id: conn.id } });
        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_DELETED',
            entityType: 'IntegrationConnection',
            entityId: conn.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'deleted',
                provider: SHAREPOINT_PROVIDER,
                summary: 'Disconnected SharePoint',
            },
        });
    });
}

// ─── SP-2 — browse (practitioner-facing; no admin gate) ──────────────

/** A folder/file row for the picker (flattened from a Graph DriveItem). */
export interface SpBrowseItem {
    id: string;
    name: string;
    isFolder: boolean;
    hasChildren: boolean;
    webUrl?: string;
    size?: number;
    mimeType?: string;
    lastModified?: string;
}

/** Resolve the allowed sites + their drives for the picker's selectors. */
export async function getSharePointSitesAndDrives(
    ctx: RequestContext,
    connectionId: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ sites: Array<{ id: string; name: string }>; drives: Record<string, Array<{ id: string; name: string }>> }> {
    const client = await getSharePointClient(ctx, connectionId, deps);
    const sites: Array<{ id: string; name: string }> = [];
    const drives: Record<string, Array<{ id: string; name: string }>> = {};
    for (const siteId of client.allowedSiteIds) {
        const site = await client.getSite(siteId);
        sites.push({ id: site.id, name: site.displayName ?? site.name ?? site.webUrl ?? site.id });
        const ds = await client.listDrives(siteId);
        drives[site.id] = ds.map((d) => ({ id: d.id, name: d.name ?? 'Documents' }));
    }
    return { sites, drives };
}

/** List one page of a drive folder for the picker (lazy tree expansion). */
export async function browseSharePoint(
    ctx: RequestContext,
    input: { connectionId: string; driveId: string; itemId?: string; pageToken?: string },
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ items: SpBrowseItem[]; nextPageToken?: string }> {
    if (!input.driveId) throw badRequest('driveId is required');
    const client = await getSharePointClient(ctx, input.connectionId, deps);
    const page = await client.listChildren(input.driveId, input.itemId, input.pageToken);
    const items: SpBrowseItem[] = page.items.map((it) => ({
        id: it.id,
        name: it.name ?? '(unnamed)',
        isFolder: !!it.folder,
        hasChildren: (it.folder?.childCount ?? 0) > 0,
        webUrl: it.webUrl,
        size: it.size,
        mimeType: it.file?.mimeType,
        lastModified: it.lastModifiedDateTime,
    }));
    return { items, nextPageToken: page.nextLink };
}

/** List SharePoint connections for the tenant (no secrets). */
export async function listSharePointConnections(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider: SHAREPOINT_PROVIDER },
            select: {
                id: true,
                name: true,
                isEnabled: true,
                configJson: true,
                lastTestedAt: true,
                lastTestStatus: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        }),
    );
}
