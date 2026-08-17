/**
 * Base Integration Client
 *
 * Abstract base class for all integration clients.
 * Each provider (Jira, ServiceNow, GitHub, etc.) extends this to
 * encapsulate all remote API interaction behind a typed contract.
 *
 * Inspired by CISO-Assistant's BaseIntegrationClient pattern:
 *   - Provider metadata (id, displayName)
 *   - Connection testing / validation
 *   - Typed CRUD for remote objects
 *   - Dependency-injectable fetch for testability
 *
 * ═══════════════════════════════════════════════════════════════════════
 * USAGE
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   class JiraClient extends BaseIntegrationClient<JiraConfig> {
 *       readonly providerId = 'jira';
 *       readonly displayName = 'Jira';
 *
 *       async testConnection(): Promise<ConnectionTestResult> { ... }
 *       async getRemoteObject(id: string) { ... }
 *       ...
 *   }
 *
 * @module integrations/base-client
 */

import { resilientFetch } from './http-resilience';

// ─── Connection Config ───────────────────────────────────────────────

/**
 * Base shape for provider connection configuration.
 * Each provider extends this with its own typed fields.
 */
export interface BaseConnectionConfig {
    /** Provider-specific settings (non-secret) */
    [key: string]: unknown;
}

/**
 * Result of a connection test.
 */
export interface ConnectionTestResult {
    /** Whether the connection succeeded */
    ok: boolean;
    /** Human-readable status message */
    message: string;
    /** Optional latency in ms */
    latencyMs?: number;
    /** Optional provider-specific metadata (e.g. API version, user info) */
    meta?: Record<string, unknown>;
}

// ─── Remote Object Types ─────────────────────────────────────────────

/**
 * A remote object returned from the external system.
 * The `remoteId` is the external system's unique identifier.
 */
export interface RemoteObject<T = Record<string, unknown>> {
    /** External system's unique ID for this object */
    remoteId: string;
    /** The raw remote data */
    data: T;
    /** When this object was last modified in the remote system (if available) */
    remoteUpdatedAt?: Date;
}

/**
 * Query parameters for listing remote objects.
 */
export interface RemoteListQuery {
    /** Free-text search */
    q?: string;
    /** Max results to return */
    limit?: number;
    /** Pagination cursor or offset */
    cursor?: string;
    /** Provider-specific filters */
    filters?: Record<string, unknown>;
}

/**
 * Paginated list result from the remote system.
 */
export interface RemoteListResult<T = Record<string, unknown>> {
    items: RemoteObject<T>[];
    /** Cursor for next page, undefined if no more pages */
    nextCursor?: string;
    /** Total count (if the API provides it) */
    total?: number;
}

// ─── Base Client ─────────────────────────────────────────────────────

/**
 * Abstract base class for all integration clients.
 *
 * @typeParam TConfig - Typed connection configuration shape
 */
export abstract class BaseIntegrationClient<
    TConfig extends BaseConnectionConfig = BaseConnectionConfig,
> {
    /** Unique provider identifier (e.g. 'jira', 'github', 'servicenow') */
    abstract readonly providerId: string;

    /** Human-readable display name */
    abstract readonly displayName: string;

    /** The active connection configuration */
    protected readonly config: TConfig;

    /** Injectable fetch for testability — defaults to globalThis.fetch */
    protected readonly fetchImpl: typeof globalThis.fetch;

    constructor(config: TConfig, fetchImpl?: typeof globalThis.fetch) {
        this.config = config;
        this.fetchImpl = fetchImpl ?? resilientFetch;
    }

    // ── Connection ──

    /**
     * Test that the connection credentials are valid and the remote
     * system is reachable. Called when an admin sets up or verifies
     * a connection.
     */
    abstract testConnection(): Promise<ConnectionTestResult>;

    // ── CRUD ──

    /**
     * Fetch a single remote object by its external ID.
     *
     * @param remoteId - The external system's identifier
     * @returns The remote object, or null if not found
     */
    abstract getRemoteObject(remoteId: string): Promise<RemoteObject | null>;

    /**
     * List remote objects, optionally filtered.
     *
     * @param query - Optional filters, search, pagination
     * @returns Paginated list of remote objects
     */
    abstract listRemoteObjects(query?: RemoteListQuery): Promise<RemoteListResult>;

    /**
     * Create a new object in the remote system from local data.
     *
     * @param data - The data to create (already mapped to remote shape)
     * @returns The newly created remote object (with its remote ID)
     */
    abstract createRemoteObject(data: Record<string, unknown>): Promise<RemoteObject>;

    /**
     * Update an existing remote object with partial changes.
     *
     * @param remoteId - The external system's identifier
     * @param changes - Partial data to update (already mapped to remote shape)
     * @returns The updated remote object
     */
    abstract updateRemoteObject(
        remoteId: string,
        changes: Record<string, unknown>,
    ): Promise<RemoteObject>;

    /**
     * Delete a remote object by its external ID.
     *
     * Default implementation throws — providers that support deletion
     * should override this method. Not all remote systems support
     * deletion of the objects we sync (e.g. GitHub branch protection
     * can be removed, but some APIs are append-only).
     *
     * @param remoteId - The external system's identifier
     * @throws Error if deletion is not supported or fails
     */
    async deleteRemoteObject(remoteId: string): Promise<void> {
        throw new Error(
            `${this.providerId} does not support deleteRemoteObject (remoteId: ${remoteId})`,
        );
    }

    // ── Utilities ──

    /**
     * Helper for making authenticated requests to the provider's API.
     * Subclasses may override to add auth headers, base URL, etc.
     */
    protected async request(
        url: string,
        init?: RequestInit,
    ): Promise<Response> {
        return this.fetchImpl(url, init);
    }
}
