/**
 * SharePoint Integration Client (SP-1).
 *
 * Wraps the Microsoft Graph SharePoint endpoints behind the
 * `BaseIntegrationClient` contract. SharePoint's verbs (browse sites / drives /
 * folders, download, delta change-tracking, change-notification subscriptions)
 * don't map onto the generic CRUD contract, so the abstract CRUD methods are
 * implemented thinly (getRemoteObject → getItem, listRemoteObjects → listSites)
 * and the real surface is the SharePoint-specific methods below.
 *
 * Auth: the caller injects a valid Graph `accessToken` in the config (obtained
 * + refreshed by `sharepoint-token.ts` from the connection's encrypted secret).
 * The client itself is stateless w.r.t. the token lifecycle — it just sends the
 * bearer token it was given, so it stays pure + hermetically testable.
 *
 * @module integrations/providers/sharepoint/client
 */
import {
    BaseIntegrationClient,
    type BaseConnectionConfig,
    type ConnectionTestResult,
    type RemoteObject,
    type RemoteListQuery,
    type RemoteListResult,
} from '../../base-client';
import type {
    SpSite,
    SpDrive,
    SpDriveItem,
    SpChildrenPage,
    SpDeltaPage,
    SpSubscription,
} from './types';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface SharePointConnectionConfig extends BaseConnectionConfig {
    /** AAD directory tenant ID (from the EI-1 Entra provider). */
    aadTenantId: string;
    /** Graph Site IDs the tenant admin approved IC may access. */
    allowedSiteIds: string[];
    /** Default document library for evidence imports. */
    defaultDriveId?: string;
    /** Delegated Graph access token (injected per-request by the caller). */
    accessToken: string;
    [key: string]: unknown;
}

/** Build `driveId:itemId` ↔ split helpers for the generic-CRUD remoteId. */
export function encodeRemoteId(driveId: string, itemId: string): string {
    return `${driveId}:${itemId}`;
}
export function decodeRemoteId(remoteId: string): { driveId: string; itemId: string } {
    const idx = remoteId.indexOf(':');
    if (idx < 0) throw new Error(`Invalid SharePoint remoteId: ${remoteId}`);
    return { driveId: remoteId.slice(0, idx), itemId: remoteId.slice(idx + 1) };
}

export class SharePointClient extends BaseIntegrationClient<SharePointConnectionConfig> {
    readonly providerId = 'sharepoint';
    readonly displayName = 'Microsoft SharePoint';

    /** Site IDs the tenant admin approved (read-only view of the config). */
    get allowedSiteIds(): string[] {
        return this.config.allowedSiteIds;
    }

    private get headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.config.accessToken}`,
            Accept: 'application/json',
        };
    }

    /** GET a Graph URL (absolute or path under /v1.0) and parse JSON. */
    private async graphGet<T>(urlOrPath: string): Promise<T> {
        const url = urlOrPath.startsWith('http') ? urlOrPath : `${GRAPH}${urlOrPath}`;
        const res = await this.request(url, { headers: this.headers });
        if (!res.ok) {
            throw new Error(`Graph GET ${url} → ${res.status}`);
        }
        return (await res.json()) as T;
    }

    // ── BaseIntegrationClient contract ──

    async testConnection(): Promise<ConnectionTestResult> {
        const start = Date.now();
        try {
            // Cheapest authenticated probe that also confirms SP reach: resolve
            // the first allowed site (or /sites/root if none configured yet).
            const siteId = this.config.allowedSiteIds[0];
            const path = siteId ? `/sites/${encodeURIComponent(siteId)}` : '/sites/root';
            const res = await this.request(`${GRAPH}${path}`, { headers: this.headers });
            if (res.ok) {
                const site = (await res.json()) as SpSite;
                return {
                    ok: true,
                    message: `Connected to ${site.displayName ?? site.webUrl ?? 'SharePoint'}`,
                    latencyMs: Date.now() - start,
                    meta: { siteId: site.id },
                };
            }
            if (res.status === 401) return { ok: false, message: 'Access token invalid or expired — reconnect' };
            if (res.status === 403) return { ok: false, message: 'Token lacks Sites.Read.All / Files.Read.All consent' };
            if (res.status === 404) return { ok: false, message: 'Configured site not found' };
            return { ok: false, message: `Graph returned status ${res.status}` };
        } catch (err) {
            return { ok: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    async getRemoteObject(remoteId: string): Promise<RemoteObject | null> {
        const { driveId, itemId } = decodeRemoteId(remoteId);
        try {
            const item = await this.getItem(driveId, itemId);
            return {
                remoteId,
                data: item as unknown as Record<string, unknown>,
                remoteUpdatedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : undefined,
            };
        } catch {
            return null;
        }
    }

    async listRemoteObjects(_query?: RemoteListQuery): Promise<RemoteListResult> {
        const sites = await this.listSites();
        return { items: sites.map((s) => ({ remoteId: s.id, data: s as unknown as Record<string, unknown> })) };
    }

    async createRemoteObject(_data: Record<string, unknown>): Promise<RemoteObject> {
        throw new Error('SharePoint create is not supported via the generic CRUD contract — use uploadItemContent (SP-4)');
    }

    async updateRemoteObject(_remoteId: string, _changes: Record<string, unknown>): Promise<RemoteObject> {
        throw new Error('SharePoint update is not supported via the generic CRUD contract — use uploadItemContent (SP-4)');
    }


    // ── Drive allowlist enforcement ──

    /**
     * Drive ids the connection is permitted to touch, derived from the admin's
     * approved `allowedSiteIds`.
     *
     * ── Why derived rather than stored ──────────────────────────────
     *
     * The allowlist an admin configures is a list of SITES; every write takes a
     * DRIVE id. Nothing mapped between the two, so `allowedSiteIds` was
     * consulted only by `testConnection` and `listSites`-style calls and was
     * enforced on ZERO drive operations — a caller who could name any drive id
     * had it PUT to with the tenant's app-only token.
     *
     * Resolving drives from the approved sites is a POSITIVE allowlist: an id
     * that is not in a drive of an approved site simply is not in the set. The
     * alternative — reading a `siteId` off the drive resource and comparing —
     * would trust a field on the object being validated, which is the wrong
     * direction of trust for an authorization check.
     *
     * Cached per client instance: a client is short-lived (one operation or one
     * sync), the site list is small and admin-controlled, and an upload is
     * already a network round trip.
     */
    private allowedDriveIdsCache: Set<string> | null = null;

    async allowedDriveIds(): Promise<Set<string>> {
        if (this.allowedDriveIdsCache) return this.allowedDriveIdsCache;
        const ids = new Set<string>();
        for (const siteId of this.config.allowedSiteIds) {
            const drives = await this.listDrives(siteId);
            for (const d of drives) if (d.id) ids.add(d.id);
        }
        this.allowedDriveIdsCache = ids;
        return ids;
    }

    /**
     * Throw unless `driveId` belongs to an approved site.
     *
     * Fails CLOSED on an empty allowlist. An unconfigured connection must not be
     * a wildcard — "the admin has not chosen any sites yet" and "every site is
     * fine" are opposite statements, and the previous code effectively read the
     * first as the second.
     */
    async assertDriveAllowed(driveId: string): Promise<void> {
        if (this.config.allowedSiteIds.length === 0) {
            throw new Error(
                'SharePoint connection has no approved sites, so no drive may be written to. ' +
                    'Approve a site on the integration before pushing files.',
            );
        }
        const allowed = await this.allowedDriveIds();
        if (!allowed.has(driveId)) {
            throw new Error(
                `SharePoint drive "${driveId}" is not in an approved site for this connection.`,
            );
        }
    }

    // ── SharePoint-specific surface ──

    /** List sites the connection can reach (admin site-selection). */
    async listSites(): Promise<SpSite[]> {
        const body = await this.graphGet<{ value?: SpSite[] }>('/sites?search=*');
        return body.value ?? [];
    }

    async getSite(siteId: string): Promise<SpSite> {
        return this.graphGet<SpSite>(`/sites/${encodeURIComponent(siteId)}`);
    }

    /** List document libraries (drives) for a site. */
    async listDrives(siteId: string): Promise<SpDrive[]> {
        const body = await this.graphGet<{ value?: SpDrive[] }>(
            `/sites/${encodeURIComponent(siteId)}/drives`,
        );
        return body.value ?? [];
    }

    /**
     * List one page of children of a folder (root when `itemId` omitted).
     * Returns the Graph `@odata.nextLink` so the browse route can paginate.
     */
    async listChildren(
        driveId: string,
        itemId?: string,
        pageUrl?: string,
    ): Promise<SpChildrenPage> {
        // A caller-supplied cursor must belong to THIS drive — never follow a
        // nextLink pointing at another drive (defence against a crafted cursor).
        if (pageUrl && !pageUrl.includes(`/drives/${encodeURIComponent(driveId)}`)) {
            throw new Error('pageUrl does not belong to the requested drive');
        }
        const path = pageUrl
            ? pageUrl
            : itemId
              ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`
              : `/drives/${encodeURIComponent(driveId)}/root/children`;
        const body = await this.graphGet<{ value?: SpDriveItem[]; '@odata.nextLink'?: string }>(path);
        return { items: body.value ?? [], nextLink: body['@odata.nextLink'] };
    }

    async getItem(driveId: string, itemId: string): Promise<SpDriveItem> {
        return this.graphGet<SpDriveItem>(
            `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`,
        );
    }

    /** Download a file's bytes. (ArrayBuffer — SP-3 wraps it as a File.) */
    async downloadItemContent(driveId: string, itemId: string): Promise<ArrayBuffer> {
        const url = `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
        const res = await this.request(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Graph download ${itemId} → ${res.status}`);
        return res.arrayBuffer();
    }

    /**
     * Walk the Graph delta for a drive, following `@odata.nextLink` until the
     * terminal `@odata.deltaLink`, accumulating changed items. Returns the new
     * delta token to persist for the next incremental sync.
     */
    async getDelta(driveId: string, deltaToken?: string, maxPages = 50): Promise<SpDeltaPage> {
        let url = deltaToken
            ? `${GRAPH}/drives/${encodeURIComponent(driveId)}/root/delta?token=${encodeURIComponent(deltaToken)}`
            : `${GRAPH}/drives/${encodeURIComponent(driveId)}/root/delta`;
        const items: SpDriveItem[] = [];
        let newToken: string | undefined;
        for (let pages = 0; url && pages < maxPages; pages++) {
            const body = await this.graphGet<{
                value?: SpDriveItem[];
                '@odata.nextLink'?: string;
                '@odata.deltaLink'?: string;
            }>(url);
            for (const it of body.value ?? []) items.push(it);
            if (body['@odata.deltaLink']) {
                newToken = extractDeltaToken(body['@odata.deltaLink']);
                break;
            }
            url = body['@odata.nextLink'] ?? '';
        }
        return { items, deltaToken: newToken };
    }

    /**
     * Create a NEW file under a folder (SP-5 audit-pack export). `parentItemId`
     * may be `'root'` for the drive root. Returns the created item.
     */
    async uploadNewFile(
        driveId: string,
        parentItemId: string,
        name: string,
        body: ArrayBuffer | Uint8Array,
        contentType: string,
    ): Promise<SpDriveItem> {
        await this.assertDriveAllowed(driveId);
        const parent = parentItemId === 'root' ? 'root' : `items/${encodeURIComponent(parentItemId)}`;
        const url = `${GRAPH}/drives/${encodeURIComponent(driveId)}/${parent}:/${encodeURIComponent(name)}:/content`;
        const res = await this.request(url, {
            method: 'PUT',
            headers: { ...this.headers, 'Content-Type': contentType },
            body: body as BodyInit,
        });
        if (!res.ok) throw new Error(`Graph upload new file ${name} → ${res.status}`);
        return (await res.json()) as SpDriveItem;
    }

    /** Replace a file's content (SP-4 policy push). Returns the updated item. */
    async uploadItemContent(
        driveId: string,
        itemId: string,
        body: string | ArrayBuffer,
        contentType: string,
    ): Promise<SpDriveItem> {
        await this.assertDriveAllowed(driveId);
        const url = `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
        const res = await this.request(url, {
            method: 'PUT',
            headers: { ...this.headers, 'Content-Type': contentType },
            body,
        });
        if (!res.ok) throw new Error(`Graph upload ${itemId} → ${res.status}`);
        return (await res.json()) as SpDriveItem;
    }

    // ── Graph change-notification subscriptions (SP-4) ──

    async createSubscription(input: {
        driveId: string;
        notificationUrl: string;
        clientState: string;
        expirationDateTime: string;
    }): Promise<SpSubscription> {
        const res = await this.request(`${GRAPH}/subscriptions`, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                changeType: 'updated',
                notificationUrl: input.notificationUrl,
                resource: `/drives/${input.driveId}/root`,
                expirationDateTime: input.expirationDateTime,
                clientState: input.clientState,
            }),
        });
        if (!res.ok) throw new Error(`Graph subscription create → ${res.status}`);
        return (await res.json()) as SpSubscription;
    }

    async renewSubscription(subscriptionId: string, expirationDateTime: string): Promise<SpSubscription> {
        const res = await this.request(`${GRAPH}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
            method: 'PATCH',
            headers: { ...this.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expirationDateTime }),
        });
        if (!res.ok) throw new Error(`Graph subscription renew → ${res.status}`);
        return (await res.json()) as SpSubscription;
    }

    async deleteSubscription(subscriptionId: string): Promise<void> {
        const res = await this.request(`${GRAPH}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
            method: 'DELETE',
            headers: this.headers,
        });
        if (res.status !== 204 && res.status !== 404 && !res.ok) {
            throw new Error(`Graph subscription delete → ${res.status}`);
        }
    }
}

/** Pull the opaque `token` query param out of a Graph deltaLink URL. */
export function extractDeltaToken(deltaLink: string): string | undefined {
    const m = deltaLink.match(/[?&]token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : undefined;
}
