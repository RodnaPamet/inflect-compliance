/**
 * ServiceNow Table API client (S1 — inbound).
 *
 * Reads records out of a ServiceNow instance through the REST Table API so
 * change requests, incidents and approvals can become compliance evidence.
 * Extends `BaseIntegrationClient`, so the injectable fetch means every test
 * here runs against a fake and never needs a live instance.
 *
 * AUTH is HTTP Basic against a dedicated integration user. ServiceNow also
 * supports OAuth2, and the token lifecycle would slot in behind `authHeader`
 * without touching anything else — but basic auth against a scoped integration
 * user is what the overwhelming majority of ServiceNow integrations actually
 * use, and an OAuth2 flow nobody exercises is worse than a simple one that is.
 *
 * @module integrations/providers/servicenow/client
 */
import {
    BaseIntegrationClient,
    type BaseConnectionConfig,
    type ConnectionTestResult,
    type RemoteObject,
    type RemoteListQuery,
    type RemoteListResult,
} from '../../base-client';
import { assertAllowedHost, SERVICENOW_HOSTS } from '../../allowed-host';

/** Rows per Table API request. */
export const SERVICENOW_PAGE_SIZE = 200;

/** Rows one read will accumulate before reporting itself incomplete. */
export const SERVICENOW_MAX_PER_READ = 2_000;

export interface ServiceNowConnectionConfig extends BaseConnectionConfig {
    /** Instance host, e.g. `acme.service-now.com`. Validated, not trusted. */
    instance: string;
    /** Table to read, e.g. `change_request`. */
    table: string;
    /** How far back a read looks, in days. */
    windowDays?: number;
    /** Integration user. */
    username: string;
    /** Integration user's password — from secretFields, never configJson. */
    password: string;
    [key: string]: unknown;
}

/** A Table API row, before mapping. Every value comes back as a string. */
export type ServiceNowRow = Record<string, string | { value?: string; display_value?: string }>;

/**
 * Encoded-query fragments we refuse to send.
 *
 * A ServiceNow encoded query is not an inert filter string. `javascript:` (and
 * the `gs.` server-side API it reaches) EXECUTES on the instance, evaluated
 * with the rights of the authenticated user — which for an integration account
 * is usually broader than the person configuring the connection in our UI.
 *
 * So a raw filter typed into a config field is a script-execution primitive
 * against the customer's own instance, handed to whoever has `admin.manage`
 * here. Refusing the prefix keeps the field a filter.
 *
 * Bounded on purpose: this is a deny-list over one syntactic escape hatch, not
 * a query sanitiser, and it is paired with BUILDING the time window ourselves
 * rather than accepting one.
 */
const SCRIPT_QUERY_MARKERS = ['javascript:', 'gs.'] as const;

export function assertInertQuery(filter: string): string {
    const lowered = filter.toLowerCase();
    for (const marker of SCRIPT_QUERY_MARKERS) {
        if (lowered.includes(marker)) {
            throw new Error(
                `Refusing a ServiceNow filter containing "${marker}": encoded queries can execute server-side script.`,
            );
        }
    }
    return filter;
}

/** Unwrap a Table API value, which is a string or a {value, display_value}. */
export function snValue(v: ServiceNowRow[string] | undefined): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v.display_value ?? v.value ?? '';
}

export class ServiceNowClient extends BaseIntegrationClient<ServiceNowConnectionConfig> {
    readonly providerId = 'servicenow';
    readonly displayName = 'ServiceNow';

    /**
     * Validated on every access rather than once in the constructor.
     *
     * A constructor-time check is enough only while nothing mutates the config,
     * which is not a property of `BaseConnectionConfig` — it is an index-signature
     * bag the caller still holds a reference to. Re-checking is a string compare
     * against a four-entry list; being wrong once costs the credential.
     */
    private get host(): string {
        return assertAllowedHost(this.config.instance, SERVICENOW_HOSTS);
    }

    private get authHeader(): string {
        const user = String(this.config.username ?? '');
        const pass = String(this.config.password ?? '');
        if (!user || !pass) {
            // Throw rather than sending `Basic <base64 of ":">`. ServiceNow
            // answers that with 401, `resilientFetch` turns any 401 into an
            // IntegrationAuthError, and the connection gets marked
            // credential-failed for OUR malformed request — telling an admin
            // their password was revoked when it was never sent.
            throw new Error('ServiceNow connection is missing its integration-user credentials');
        }
        return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }

    private url(path: string, params: Record<string, string> = {}): string {
        const u = new URL(`https://${this.host}${path}`);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        return u.toString();
    }

    private async getJson<T>(url: string): Promise<T> {
        const res = await this.request(url, {
            headers: { Authorization: this.authHeader, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`ServiceNow GET failed (HTTP ${res.status})`);
        return (await res.json()) as T;
    }

    /**
     * A REAL authenticated call, against the CONFIGURED TABLE.
     *
     * `sysparm_limit=1` on the table the connection will actually read, not a
     * generic ping. The three ways this connection fails in practice — bad
     * credentials, an instance that exists but is the sub-prod clone, and an
     * integration user with no ACL on the table — are indistinguishable to a
     * probe that hits anything else, and the third is the most common.
     */
    async testConnection(): Promise<ConnectionTestResult> {
        const started = Date.now();
        try {
            const table = String(this.config.table ?? '');
            if (!table) return { ok: false, message: 'No ServiceNow table configured.' };
            const body = await this.getJson<{ result?: unknown[] }>(
                this.url(`/api/now/table/${encodeURIComponent(table)}`, {
                    sysparm_limit: '1',
                    sysparm_fields: 'sys_id',
                }),
            );
            if (!Array.isArray(body.result)) {
                return { ok: false, message: 'ServiceNow returned an unexpected response shape.' };
            }
            return {
                ok: true,
                message: `Connected to ${this.host} and read ${table}.`,
                latencyMs: Date.now() - started,
            };
        } catch (e) {
            return { ok: false, message: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
        }
    }

    async getRemoteObject(remoteId: string): Promise<RemoteObject<ServiceNowRow> | null> {
        const table = String(this.config.table ?? '');
        try {
            const body = await this.getJson<{ result?: ServiceNowRow }>(
                this.url(`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(remoteId)}`, {
                    sysparm_display_value: 'all',
                }),
            );
            if (!body.result) return null;
            return toRemoteObject(body.result);
        } catch (e) {
            // A missing record is a 404, which resilientFetch raises as a
            // terminal error. `null` is the contract for "not there"; anything
            // else must keep propagating, because swallowing an auth failure
            // into `null` would read as a deleted record.
            if (e instanceof Error && /\b404\b/.test(e.message)) return null;
            throw e;
        }
    }

    /**
     * Page the table with `sysparm_offset`, newest-updated first.
     *
     * OFFSET PAGINATION OVER A LIVE TABLE IS LOSSY and the ordering is what
     * bounds the damage. Records updated while a read is in flight move within
     * the result set: with an arbitrary order a row can shift across a page
     * boundary and be skipped entirely. Ordering by `sys_updated_on` DESC means
     * a row that changes mid-read moves toward page 1 — already-read pages —
     * so it is seen twice rather than not at all. The ingest is idempotent on
     * `sys_id`, so a duplicate costs nothing and a miss would be a silent gap
     * in the evidence.
     */
    async listRemoteObjects(query?: RemoteListQuery): Promise<RemoteListResult<ServiceNowRow>> {
        const table = String(this.config.table ?? '');
        if (!table) throw new Error('ServiceNow connection has no table configured');

        const limit = Math.min(query?.limit ?? SERVICENOW_MAX_PER_READ, SERVICENOW_MAX_PER_READ);
        const startOffset = Number.parseInt(query?.cursor ?? '0', 10);
        if (Number.isNaN(startOffset) || startOffset < 0) {
            // Restarting from zero would re-read everything AND make a read
            // that never finishes look like one making steady progress.
            throw new Error(`Invalid ServiceNow cursor: ${query?.cursor}`);
        }

        const filter = this.buildQuery(query?.filters);
        const items: RemoteObject<ServiceNowRow>[] = [];
        let offset = startOffset;
        let sawFullPage = true;

        while (items.length < limit && sawFullPage) {
            const body = await this.getJson<{ result?: ServiceNowRow[] }>(
                this.url(`/api/now/table/${encodeURIComponent(table)}`, {
                    sysparm_query: filter,
                    sysparm_limit: String(SERVICENOW_PAGE_SIZE),
                    sysparm_offset: String(offset),
                    sysparm_display_value: 'all',
                }),
            );
            const rows = body.result ?? [];
            for (const r of rows) items.push(toRemoteObject(r));
            offset += rows.length;
            // Compared against the requested page size, NOT the mapped count:
            // rows dropped downstream for a missing sys_id would otherwise
            // read as the end of the table and truncate the read silently.
            sawFullPage = rows.length === SERVICENOW_PAGE_SIZE;
        }

        return sawFullPage ? { items, nextCursor: String(offset) } : { items };
    }

    /**
     * `sys_updated_on >= now - windowDays`, ordered newest first.
     *
     * The window is BUILT here from a number of days rather than accepted as an
     * encoded query, so the one field an admin types cannot become a
     * `javascript:` expression. A caller-supplied extra filter is still allowed
     * — some tables need one — but goes through `assertInertQuery` first.
     */
    private buildQuery(filters?: Record<string, unknown>): string {
        const days = Number(this.config.windowDays ?? 90);
        const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 90;
        const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
        // ServiceNow wants `YYYY-MM-DD HH:MM:SS` in UTC.
        const stamp = since.toISOString().slice(0, 19).replace('T', ' ');
        const parts = [`sys_updated_on>=${stamp}`];
        const extra = filters?.encodedQuery;
        if (typeof extra === 'string' && extra.trim()) parts.push(assertInertQuery(extra.trim()));
        parts.push('ORDERBYDESCsys_updated_on');
        return parts.join('^');
    }

    /**
     * Find a record this platform already wrote, by its correlation id.
     *
     * The half of idempotency the database cannot provide. A retry that runs
     * after the remote record was created but before its id was recorded finds
     * it here and ADOPTS it, instead of creating a second one.
     *
     * Returns null when nothing matches, which is the first-attempt case.
     * Ambiguity is treated as an error rather than resolved: see below.
     */
    async findByCorrelationId(correlationId: string): Promise<RemoteObject<ServiceNowRow> | null> {
        const table = String(this.config.table ?? '');
        if (!table) throw new Error('ServiceNow connection has no table configured');
        const body = await this.getJson<{ result?: ServiceNowRow[] }>(
            this.url(`/api/now/table/${encodeURIComponent(table)}`, {
                // `=` not LIKE. A LIKE query on a hashed id would match a
                // longer id sharing our prefix, and adopting the wrong record
                // means writing our updates onto somebody else's incident.
                sysparm_query: `correlation_id=${correlationId}`,
                sysparm_limit: '2',
                sysparm_display_value: 'all',
            }),
        );
        const rows = body.result ?? [];
        if (rows.length === 0) return null;
        if (rows.length > 1) {
            // Two records already carry this id, so a duplicate exists that we
            // did not intend. Picking one would silently pick a side and hide
            // the split. Refusing surfaces it while it is still two records
            // rather than two divergent histories.
            throw new Error(
                `ServiceNow has more than one record with correlation_id ${correlationId}; refusing to adopt either.`,
            );
        }
        return toRemoteObject(rows[0]);
    }

    /**
     * Create a record, stamped with the correlation id that makes the write
     * findable by the retry that may follow it.
     *
     * `correlationId` is REQUIRED rather than optional. An optional one would
     * be omitted by exactly the caller who most needs it — the one wiring a new
     * outbound path in a hurry — and the resulting record is unfindable
     * forever, so every subsequent retry creates another.
     */
    async createRemoteObject(
        data: Record<string, unknown>,
        correlationId?: string,
    ): Promise<RemoteObject<ServiceNowRow>> {
        if (!correlationId) {
            throw new Error('ServiceNow creates require a correlation id — an unstamped record cannot be deduplicated');
        }
        const table = String(this.config.table ?? '');
        if (!table) throw new Error('ServiceNow connection has no table configured');
        const res = await this.request(this.url(`/api/now/table/${encodeURIComponent(table)}`), {
            method: 'POST',
            headers: {
                Authorization: this.authHeader,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...data, correlation_id: correlationId }),
        });
        if (!res.ok) throw new Error(`ServiceNow create failed (HTTP ${res.status})`);
        const body = (await res.json()) as { result?: ServiceNowRow };
        if (!body.result) throw new Error('ServiceNow create returned no record');
        return toRemoteObject(body.result);
    }

    async updateRemoteObject(
        remoteId: string,
        changes: Record<string, unknown>,
    ): Promise<RemoteObject<ServiceNowRow>> {
        const table = String(this.config.table ?? '');
        if (!table) throw new Error('ServiceNow connection has no table configured');
        if (!remoteId) throw new Error('ServiceNow updates require a remote id');
        const res = await this.request(
            this.url(`/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(remoteId)}`),
            {
                method: 'PATCH',
                headers: {
                    Authorization: this.authHeader,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                // correlation_id is deliberately NOT re-sent. It is written
                // once at creation and is the record's identity to us;
                // rewriting it on every update would let a mapping edit
                // silently re-point an existing incident.
                body: JSON.stringify(changes),
            },
        );
        if (!res.ok) throw new Error(`ServiceNow update failed (HTTP ${res.status})`);
        const body = (await res.json()) as { result?: ServiceNowRow };
        if (!body.result) throw new Error('ServiceNow update returned no record');
        return toRemoteObject(body.result);
    }
}

function toRemoteObject(row: ServiceNowRow): RemoteObject<ServiceNowRow> {
    const updated = snValue(row.sys_updated_on);
    const parsed = updated ? new Date(updated.replace(' ', 'T') + 'Z') : null;
    return {
        remoteId: snValue(row.sys_id),
        data: row,
        remoteUpdatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
    };
}
