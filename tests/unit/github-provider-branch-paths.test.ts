/**
 * GitHub Provider — branch / error-path coverage
 *
 * Companion to `tests/unit/github-integration.test.ts` (happy paths) and
 * `tests/integration/github-provider.test.ts` (end-to-end check flow).
 *
 * This file deliberately targets the UNTAKEN branches of the three GitHub
 * modules — the ones a third-party API client only meets in anger:
 *
 *   client.ts          — every non-200 status arm of testConnection, the
 *                        `remoteId || config.branch || 'main'` resolution
 *                        ladder, the `!res.ok` throw on each verb, and the
 *                        204/404 "both acceptable" delete contract.
 *   sync.ts            — extractRemoteId / extractRemoteData fallbacks and
 *                        their null refusals, observed through the public
 *                        handleWebhookEvent refusal reasons, plus the
 *                        client/mapper wiring proven by the outbound request.
 *   legacy-provider.ts — error-body handling, non-Error throwables, the
 *                        raw-body signature contract, and the `|| 'unknown'`
 *                        evidence fallbacks.
 *
 * Every assertion is on observable output: the returned value, the thrown
 * message, the refusal reason, or the exact request put on the wire.
 */
import {
    GitHubClient,
    GitHubSyncOrchestrator,
    GitHubProvider,
    evaluateBranchProtection,
    fetchBranchProtection,
} from '@/app-layer/integrations/providers/github';
import type { GitHubConnectionConfig } from '@/app-layer/integrations/providers/github';
import type {
    GitHubBranchProtection,
    FetchFn,
} from '@/app-layer/integrations/providers/github/legacy-provider';
import type { GitHubLocalStore } from '@/app-layer/integrations/providers/github/sync';
import type {
    SyncMapping,
    SyncMappingKey,
    SyncMappingCreateData,
    SyncMappingStatusUpdate,
} from '@/app-layer/integrations/sync-types';
import type { SyncMappingStore } from '@/app-layer/integrations/sync-orchestrator';
import type { RequestContext } from '@/app-layer/types';
import type { CheckInput, ParsedAutomationKey, WebhookPayload } from '@/app-layer/integrations/types';
import { computeHmacSha256 } from '@/app-layer/integrations/webhook-crypto';
import { getPermissionsForRole } from '@/lib/permissions';

jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn().mockResolvedValue({ id: 'mock-job' }),
}));
import { enqueue } from '@/app-layer/jobs/queue';

// ─── Fixtures ────────────────────────────────────────────────────────

const ctx: RequestContext = {
    tenantId: 'tenant-1',
    userId: 'system',
    requestId: 'req-1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('ADMIN'),
};

const CONFIG: GitHubConnectionConfig = {
    owner: 'acme', repo: 'platform', branch: 'main', token: 'ghp_test',
};

/** Same config with NO `branch` — exercises the final `|| 'main'` rung. */
const CONFIG_NO_BRANCH: GitHubConnectionConfig = {
    owner: 'acme', repo: 'platform', token: 'ghp_test',
};

const REPO_URL = 'https://api.github.com/repos/acme/platform';

interface RecordedCall { url: string; init?: RequestInit }

/**
 * Fetch double that RECORDS what was put on the wire, so tests can assert
 * the URL/method/body the client actually built, not just its return value.
 */
function recordingFetch(
    status: number,
    body: unknown,
    opts?: { textThrows?: boolean },
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return {
            status,
            ok: status >= 200 && status < 300,
            json: async () => body,
            text: async () => {
                if (opts?.textThrows) throw new Error('body stream already read');
                return typeof body === 'string' ? body : JSON.stringify(body);
            },
        } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

function throwingFetch(thrown: unknown): typeof globalThis.fetch {
    return (async () => { throw thrown; }) as unknown as typeof globalThis.fetch;
}

// ═══════════════════════════════════════════════════════════════════════
// client.ts — testConnection status ladder
// ═══════════════════════════════════════════════════════════════════════

describe('GitHubClient.testConnection — non-200 status arms', () => {
    test('403 reports a permissions failure, not an auth failure', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(403, {}).fetch);
        const result = await client.testConnection();
        expect(result).toEqual({ ok: false, message: 'Token lacks required permissions' });
    });

    test('404 names the exact owner/repo that was not found', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(404, {}).fetch);
        const result = await client.testConnection();
        expect(result).toEqual({ ok: false, message: 'Repository acme/platform not found' });
    });

    test('an unmapped status is surfaced verbatim rather than swallowed', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(503, {}).fetch);
        const result = await client.testConnection();
        expect(result).toEqual({ ok: false, message: 'GitHub API returned status 503' });
    });

    test('a thrown Error becomes a failure carrying its message', async () => {
        const client = new GitHubClient(CONFIG, throwingFetch(new Error('ECONNREFUSED')));
        const result = await client.testConnection();
        expect(result.ok).toBe(false);
        expect(result.message).toBe('Connection failed: ECONNREFUSED');
    });

    test('a thrown non-Error is stringified, not rendered as [object Object]', async () => {
        const client = new GitHubClient(CONFIG, throwingFetch('socket hang up'));
        const result = await client.testConnection();
        expect(result.message).toBe('Connection failed: socket hang up');
    });

    test('200 without full_name falls back to the repo URL and reports no fullName', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(200, {}).fetch);
        const result = await client.testConnection();
        expect(result.ok).toBe(true);
        expect(result.message).toBe(`Connected to ${REPO_URL}`);
        expect(result.meta).toEqual({ fullName: undefined });
        expect(typeof result.latencyMs).toBe('number');
    });

    test('failure results carry no latency — only the success arm measures', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(401, {}).fetch);
        const result = await client.testConnection();
        expect(result).toEqual({ ok: false, message: 'Invalid or expired token' });
        expect(result.latencyMs).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// client.ts — branch resolution ladder + error throws
// ═══════════════════════════════════════════════════════════════════════

describe('GitHubClient.getRemoteObject — branch resolution and errors', () => {
    test('an empty remoteId falls back to the configured branch', async () => {
        const { fetch, calls } = recordingFetch(200, { enforce_admins: { enabled: true } });
        const client = new GitHubClient({ ...CONFIG, branch: 'develop' }, fetch);
        const obj = await client.getRemoteObject('');
        expect(calls[0].url).toBe(`${REPO_URL}/branches/develop/protection`);
        expect(obj!.remoteId).toBe('develop');
    });

    test("with neither remoteId nor configured branch it defaults to 'main'", async () => {
        const { fetch, calls } = recordingFetch(200, {});
        const client = new GitHubClient(CONFIG_NO_BRANCH, fetch);
        const obj = await client.getRemoteObject('');
        expect(calls[0].url).toBe(`${REPO_URL}/branches/main/protection`);
        expect(obj!.remoteId).toBe('main');
    });

    test('an explicit remoteId wins over the configured branch', async () => {
        const { fetch, calls } = recordingFetch(200, {});
        const client = new GitHubClient({ ...CONFIG, branch: 'develop' }, fetch);
        await client.getRemoteObject('release/1.0');
        expect(calls[0].url).toBe(`${REPO_URL}/branches/release/1.0/protection`);
    });

    test('a non-404 failure throws rather than being mistaken for "not protected"', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(500, {}).fetch);
        await expect(client.getRemoteObject('main')).rejects.toThrow('GitHub API error: 500');
    });

    test('sends the GitHub auth + API-version headers', async () => {
        const { fetch, calls } = recordingFetch(200, {});
        const client = new GitHubClient(CONFIG, fetch);
        await client.getRemoteObject('main');
        expect(calls[0].init?.headers).toEqual({
            'Authorization': 'Bearer ghp_test',
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
        });
    });
});

describe('GitHubClient.listRemoteObjects', () => {
    test('defaults to per_page=30 when no query is given', async () => {
        const { fetch, calls } = recordingFetch(200, []);
        const client = new GitHubClient(CONFIG, fetch);
        const result = await client.listRemoteObjects();
        expect(calls[0].url).toBe(`${REPO_URL}/branches?per_page=30`);
        expect(result).toEqual({ items: [], total: 0 });
    });

    test('honours an explicit limit and maps each branch to a remote object', async () => {
        const { fetch, calls } = recordingFetch(200, [
            { name: 'main', protected: true },
            { name: 'dev', protected: false },
        ]);
        const client = new GitHubClient(CONFIG, fetch);
        const result = await client.listRemoteObjects({ limit: 5 });
        expect(calls[0].url).toBe(`${REPO_URL}/branches?per_page=5`);
        expect(result.total).toBe(2);
        expect(result.items.map(i => i.remoteId)).toEqual(['main', 'dev']);
        expect(result.items[0].data).toEqual({ name: 'main', protected: true });
    });

    test('a failing list throws with the status', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(403, {}).fetch);
        await expect(client.listRemoteObjects()).rejects.toThrow('GitHub API error: 403');
    });
});

describe('GitHubClient.createRemoteObject / updateRemoteObject', () => {
    test('PUTs the payload to the branch named in the data', async () => {
        const { fetch, calls } = recordingFetch(200, { enforce_admins: { enabled: true } });
        const client = new GitHubClient(CONFIG, fetch);
        const obj = await client.createRemoteObject({ branch: 'release', enforce_admins: true });

        expect(calls[0].url).toBe(`${REPO_URL}/branches/release/protection`);
        expect(calls[0].init?.method).toBe('PUT');
        expect((calls[0].init?.headers as Record<string, string>)['Content-Type'])
            .toBe('application/json');
        expect(JSON.parse(String(calls[0].init?.body)))
            .toEqual({ branch: 'release', enforce_admins: true });
        expect(obj.remoteId).toBe('release');
    });

    test('falls back to the configured branch when the data names none', async () => {
        const { fetch, calls } = recordingFetch(200, {});
        const client = new GitHubClient({ ...CONFIG, branch: 'develop' }, fetch);
        const obj = await client.createRemoteObject({ enforce_admins: true });
        expect(calls[0].url).toBe(`${REPO_URL}/branches/develop/protection`);
        expect(obj.remoteId).toBe('develop');
    });

    test("falls back to 'main' when neither data nor config names a branch", async () => {
        const { fetch, calls } = recordingFetch(200, {});
        const client = new GitHubClient(CONFIG_NO_BRANCH, fetch);
        const obj = await client.createRemoteObject({});
        expect(calls[0].url).toBe(`${REPO_URL}/branches/main/protection`);
        expect(obj.remoteId).toBe('main');
    });

    test('a rejected create throws a create-specific message', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(422, {}).fetch);
        await expect(client.createRemoteObject({ branch: 'main' }))
            .rejects.toThrow('GitHub API error creating protection: 422');
    });

    // NOTE — the `branch` key is BOTH the URL router and part of the JSON body,
    // because createRemoteObject stringifies `data` wholesale. That is current
    // behaviour, asserted here so a fix is a visible diff; reported separately.
    test('update routes through PUT on the given remoteId (GitHub has no PATCH here)', async () => {
        const { fetch, calls } = recordingFetch(200, {});
        const client = new GitHubClient(CONFIG, fetch);
        const obj = await client.updateRemoteObject('feature-x', { enforce_admins: true });

        expect(calls[0].init?.method).toBe('PUT');
        expect(calls[0].url).toBe(`${REPO_URL}/branches/feature-x/protection`);
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            enforce_admins: true, branch: 'feature-x',
        });
        expect(obj.remoteId).toBe('feature-x');
    });
});

describe('GitHubClient.deleteRemoteObject', () => {
    test('204 resolves and issues a DELETE', async () => {
        const { fetch, calls } = recordingFetch(204, {});
        const client = new GitHubClient(CONFIG, fetch);
        await expect(client.deleteRemoteObject('main')).resolves.toBeUndefined();
        expect(calls[0].init?.method).toBe('DELETE');
        expect(calls[0].url).toBe(`${REPO_URL}/branches/main/protection`);
    });

    test('404 is treated as already-deleted, not an error', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(404, {}).fetch);
        await expect(client.deleteRemoteObject('main')).resolves.toBeUndefined();
    });

    test('any other failure throws a delete-specific message', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(500, {}).fetch);
        await expect(client.deleteRemoteObject('main'))
            .rejects.toThrow('GitHub API error deleting protection: 500');
    });

    test('a 2xx that is not 204 also resolves — only !ok is an error', async () => {
        const client = new GitHubClient(CONFIG, recordingFetch(200, {}).fetch);
        await expect(client.deleteRemoteObject('main')).resolves.toBeUndefined();
    });

    test("an empty remoteId resolves through config then 'main'", async () => {
        const { fetch, calls } = recordingFetch(204, {});
        const client = new GitHubClient(CONFIG_NO_BRANCH, fetch);
        await client.deleteRemoteObject('');
        expect(calls[0].url).toBe(`${REPO_URL}/branches/main/protection`);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// sync.ts — payload extraction fallbacks and refusals
// ═══════════════════════════════════════════════════════════════════════

class InMemoryMappingStore implements SyncMappingStore {
    mappings = new Map<string, SyncMapping>();
    private nextId = 1;

    async findByLocalEntity(
        tenantId: string, provider: string, localEntityType: string, localEntityId: string,
    ): Promise<SyncMapping | null> {
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.localEntityType === localEntityType && m.localEntityId === localEntityId) return m;
        }
        return null;
    }

    async findByRemoteEntity(
        tenantId: string, provider: string, remoteEntityType: string, remoteEntityId: string,
    ): Promise<SyncMapping | null> {
        for (const m of this.mappings.values()) {
            if (m.tenantId === tenantId && m.provider === provider
                && m.remoteEntityType === remoteEntityType && m.remoteEntityId === remoteEntityId) return m;
        }
        return null;
    }

    async findOrCreate(key: SyncMappingKey, defaults?: SyncMappingCreateData): Promise<SyncMapping> {
        const existing = await this.findByLocalEntity(
            key.tenantId, key.provider, key.localEntityType, key.localEntityId,
        );
        if (existing) return existing;
        const now = new Date();
        const id = `mapping-${this.nextId++}`;
        const mapping: SyncMapping = {
            id, tenantId: key.tenantId, provider: key.provider,
            connectionId: key.connectionId ?? null,
            localEntityType: key.localEntityType, localEntityId: key.localEntityId,
            remoteEntityType: key.remoteEntityType, remoteEntityId: key.remoteEntityId,
            syncStatus: defaults?.syncStatus ?? 'PENDING', lastSyncDirection: null,
            conflictStrategy: 'REMOTE_WINS',
            localUpdatedAt: null, remoteUpdatedAt: null, remoteDataJson: null,
            version: 1, errorMessage: defaults?.errorMessage ?? null, lastSyncedAt: null,
            createdAt: now, updatedAt: now,
        };
        this.mappings.set(id, mapping);
        return mapping;
    }

    async updateStatus(
        id: string, status: SyncMapping['syncStatus'], extra?: SyncMappingStatusUpdate,
    ): Promise<SyncMapping> {
        const existing = this.mappings.get(id);
        if (!existing) throw new Error(`Mapping ${id} not found`);
        const updated: SyncMapping = { ...existing, syncStatus: status, updatedAt: new Date() };
        if (extra?.errorMessage !== undefined) updated.errorMessage = extra.errorMessage;
        if (extra?.lastSyncDirection !== undefined) updated.lastSyncDirection = extra.lastSyncDirection;
        if (extra?.version !== undefined) updated.version = extra.version;
        this.mappings.set(id, updated);
        return updated;
    }
}

class InMemoryLocalStore implements GitHubLocalStore {
    entities = new Map<string, Record<string, unknown>>();

    async applyChanges(
        _c: RequestContext, entityType: string, entityId: string, data: Record<string, unknown>,
    ): Promise<string[]> {
        const key = `${entityType}:${entityId}`;
        this.entities.set(key, { ...(this.entities.get(key) ?? {}), ...data });
        return Object.keys(data);
    }

    async getData(
        _c: RequestContext, entityType: string, entityId: string,
    ): Promise<Record<string, unknown> | null> {
        return this.entities.get(`${entityType}:${entityId}`) ?? null;
    }
}

const MAPPING_KEY: SyncMappingKey = {
    tenantId: 'tenant-1', provider: 'github',
    localEntityType: 'control', localEntityId: 'ctrl-1',
    remoteEntityType: 'branch_protection', remoteEntityId: 'main',
};

describe('GitHubSyncOrchestrator — webhook payload extraction', () => {
    let store: InMemoryMappingStore;
    let localStore: InMemoryLocalStore;
    let orch: GitHubSyncOrchestrator;
    let calls: RecordedCall[];

    beforeEach(() => {
        (enqueue as jest.Mock).mockClear();
        store = new InMemoryMappingStore();
        localStore = new InMemoryLocalStore();
        const rec = recordingFetch(200, { enforce_admins: { enabled: true } });
        calls = rec.calls;
        orch = new GitHubSyncOrchestrator({
            config: CONFIG, store, localStore, fetchImpl: rec.fetch,
        });
    });

    test('refuses a payload with neither rule.name nor branch', async () => {
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated', payload: { repository: { id: 7 } },
        });
        expect(result.processed).toBe(false);
        expect(result.syncCount).toBe(0);
        expect(result.reason).toBe('Could not extract remote ID from updated payload');
        expect(enqueue).not.toHaveBeenCalled();
    });

    test('a rule without a name falls through to the branch fallback', async () => {
        // `rule` is present but nameless, so the `rule?.name` guard must NOT
        // short-circuit — the id has to come from the sibling `branch` field.
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated',
            payload: { rule: { enabled: true }, branch: 'main' },
        });
        expect(result.reason).toBe('No mapping found for remote branch_protection:main');
    });

    test('a branch-only payload with no protection-shaped fields is refused as dataless', async () => {
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated', payload: { branch: 'main' },
        });
        expect(result.processed).toBe(false);
        expect(result.syncCount).toBe(0);
        expect(result.reason).toBe('Could not extract remote data from updated payload');
    });

    test('a rule-less payload carrying required_status_checks is accepted as protection data', async () => {
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated',
            payload: { branch: 'main', required_status_checks: { strict: true, contexts: [] } },
        });
        // Data WAS extracted — the refusal is now about the missing mapping,
        // not about the payload shape.
        expect(result.reason).toBe('No mapping found for remote branch_protection:main');
    });

    test('a rule-less payload carrying enforce_admins is accepted and enqueues a pull', async () => {
        await store.findOrCreate(MAPPING_KEY);
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated',
            payload: { branch: 'main', enforce_admins: false },
        });
        expect(result.processed).toBe(true);
        expect(result.syncCount).toBe(1);
        expect(enqueue).toHaveBeenCalledTimes(1);
        const [jobName, jobPayload] = (enqueue as jest.Mock).mock.calls[0];
        expect(jobName).toBe('sync-pull');
        expect(jobPayload.mappingKey.remoteEntityType).toBe('branch_protection');
        expect(jobPayload.mappingKey.remoteEntityId).toBe('main');
        expect(jobPayload.remoteData).toEqual({ branch: 'main', enforce_admins: false });
    });

    test('the rule object wins over a sibling branch field when both are present', async () => {
        await store.findOrCreate({ ...MAPPING_KEY, remoteEntityId: 'from-rule' });
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated',
            payload: { rule: { name: 'from-rule', enforce_admins: true }, branch: 'from-branch' },
        });
        expect(result.processed).toBe(true);
        const [, jobPayload] = (enqueue as jest.Mock).mock.calls[0];
        expect(jobPayload.mappingKey.remoteEntityId).toBe('from-rule');
        expect(jobPayload.remoteData).toEqual({ name: 'from-rule', enforce_admins: true });
    });

    test('a delete event marks the mapping STALE under the branch_protection entity type', async () => {
        const mapping = await store.findOrCreate(MAPPING_KEY);
        const result = await orch.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'deleted', payload: { rule: { name: 'main' } },
        });
        expect(result.processed).toBe(true);
        expect(result.syncCount).toBe(1);
        expect(store.mappings.get(mapping.id)!.syncStatus).toBe('STALE');
        expect(store.mappings.get(mapping.id)!.errorMessage).toBe('Remote object was deleted');
    });

    test('constructing without a logger or fetch impl still refuses cleanly and opens no socket', async () => {
        const bare = new GitHubSyncOrchestrator({ config: CONFIG, store, localStore });
        const result = await bare.handleWebhookEvent({
            ctx, provider: 'github', eventType: 'updated', payload: {},
        });
        expect(result.processed).toBe(false);
        expect(result.reason).toBe('Could not extract remote ID from updated payload');
        expect(calls).toHaveLength(0);
    });
});

describe('GitHubSyncOrchestrator — client + mapper wiring', () => {
    test('push maps local fields to GitHub protection shape and PUTs them', async () => {
        const store = new InMemoryMappingStore();
        const rec = recordingFetch(200, {});
        const orch = new GitHubSyncOrchestrator({
            config: CONFIG, store, localStore: new InMemoryLocalStore(), fetchImpl: rec.fetch,
        });

        const result = await orch.push({
            ctx, mappingKey: MAPPING_KEY,
            localData: { requiredReviewCount: 2, status: 'IMPLEMENTED' },
            changedFields: [],
            localUpdatedAt: new Date(),
        });

        expect(result.success).toBe(true);
        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0].init?.method).toBe('PUT');
        const body = JSON.parse(String(rec.calls[0].init?.body));
        // Proves resolveMapper() really is the GitHub mapper: local field names
        // became GitHub API paths and the status enum was translated.
        expect(body.required_pull_request_reviews).toEqual({ required_approving_review_count: 2 });
        expect(body.status).toBe('enabled');
    });

    test('a remote rejection surfaces the client error message on the mapping', async () => {
        const store = new InMemoryMappingStore();
        const orch = new GitHubSyncOrchestrator({
            config: CONFIG, store, localStore: new InMemoryLocalStore(),
            fetchImpl: recordingFetch(422, {}).fetch,
        });

        const result = await orch.push({
            ctx, mappingKey: MAPPING_KEY,
            localData: { protectionEnabled: true },
            changedFields: [],
            localUpdatedAt: new Date(),
        });

        expect(result.success).toBe(false);
        expect(result.action).toBe('error');
        expect(result.errorMessage).toBe('GitHub API error creating protection: 422');
        expect(result.mapping.syncStatus).toBe('FAILED');
    });

    test('pull writes the mapped remote data through the injected local store', async () => {
        const store = new InMemoryMappingStore();
        const localStore = new InMemoryLocalStore();
        const orch = new GitHubSyncOrchestrator({
            config: CONFIG, store, localStore, fetchImpl: recordingFetch(200, {}).fetch,
        });

        const result = await orch.pull({
            ctx, mappingKey: MAPPING_KEY,
            remoteData: { enforce_admins: { enabled: true }, status: 'partial' },
            remoteUpdatedAt: new Date(),
        });

        expect(result.success).toBe(true);
        expect(localStore.entities.get('control:ctrl-1')).toEqual({
            enforceAdmins: true, status: 'IN_PROGRESS',
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// legacy-provider.ts
// ═══════════════════════════════════════════════════════════════════════

const PARSED_KEY: ParsedAutomationKey = {
    provider: 'github', checkType: 'branch_protection', raw: 'github.branch_protection',
};

function checkInput(overrides?: Partial<CheckInput>): CheckInput {
    return {
        automationKey: 'github.branch_protection',
        parsed: PARSED_KEY,
        tenantId: 'tenant-1',
        connectionConfig: { owner: 'acme', repo: 'api', branch: 'main', token: 'ghp_x' },
        triggeredBy: 'manual',
        ...overrides,
    };
}

function legacyFetch(status: number, body: unknown, opts?: { textThrows?: boolean }): FetchFn {
    return async () => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        text: async () => {
            if (opts?.textThrows) throw new Error('stream consumed');
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
    } as Response);
}

describe('fetchBranchProtection — error-body handling', () => {
    test('an unreadable error body degrades to an empty detail rather than throwing', async () => {
        const result = await fetchBranchProtection(
            'acme', 'api', 'main', 'tok', legacyFetch(500, {}, { textThrows: true }),
        );
        expect(result.protection).toBeNull();
        expect(result.status).toBe(500);
        expect(result.error).toBe('GitHub API error 500: ');
    });

    test('an oversized error body is truncated to 200 characters', async () => {
        const long = 'x'.repeat(5000);
        const result = await fetchBranchProtection(
            'acme', 'api', 'main', 'tok', legacyFetch(502, long),
        );
        expect(result.error).toBe(`GitHub API error 502: ${'x'.repeat(200)}`);
    });

    test('a non-Error throwable is stringified into the error field', async () => {
        const result = await fetchBranchProtection(
            'acme', 'api', 'main', 'tok', (async () => { throw 'dns failure'; }) as FetchFn,
        );
        expect(result).toEqual({ protection: null, status: 0, error: 'dns failure' });
    });

    test('the branch is interpolated into the protection URL', async () => {
        const seen: string[] = [];
        const spy: FetchFn = async (url) => {
            seen.push(url);
            return { status: 404, ok: false, json: async () => ({}), text: async () => '' } as Response;
        };
        const result = await fetchBranchProtection('acme', 'api', 'release', 'tok', spy);
        expect(seen[0]).toBe('https://api.github.com/repos/acme/api/branches/release/protection');
        expect(result).toEqual({ protection: null, status: 404 });
    });
});

describe('GitHubProvider.validateConnection — refusal arms', () => {
    test('missing repo is refused before any network call', async () => {
        const calls: string[] = [];
        const provider = new GitHubProvider((async (u: string) => {
            calls.push(u);
            return { status: 200 } as Response;
        }) as FetchFn);
        const result = await provider.validateConnection({ owner: 'acme' }, { token: 'tok' });
        expect(result).toEqual({ valid: false, error: 'Repository name is required' });
        expect(calls).toHaveLength(0);
    });

    test('403 is reported as a permission problem', async () => {
        const provider = new GitHubProvider(legacyFetch(403, {}));
        const result = await provider.validateConnection(
            { owner: 'acme', repo: 'api' }, { token: 'tok' },
        );
        expect(result).toEqual({ valid: false, error: 'Token lacks required permissions' });
    });

    test('an unmapped status is reported verbatim', async () => {
        const provider = new GitHubProvider(legacyFetch(500, {}));
        const result = await provider.validateConnection(
            { owner: 'acme', repo: 'api' }, { token: 'tok' },
        );
        expect(result).toEqual({ valid: false, error: 'GitHub API returned status 500' });
    });

    test('a thrown Error surfaces its message in the failure reason', async () => {
        const provider = new GitHubProvider(
            (async () => { throw new Error('ECONNRESET'); }) as FetchFn,
        );
        const result = await provider.validateConnection(
            { owner: 'acme', repo: 'api' }, { token: 'tok' },
        );
        expect(result).toEqual({ valid: false, error: 'Connection failed: ECONNRESET' });
    });

    test('a non-Error throwable is stringified into the failure reason', async () => {
        const provider = new GitHubProvider((async () => { throw 'tls handshake failed'; }) as FetchFn);
        const result = await provider.validateConnection(
            { owner: 'acme', repo: 'api' }, { token: 'tok' },
        );
        expect(result).toEqual({ valid: false, error: 'Connection failed: tls handshake failed' });
    });
});

describe('GitHubProvider.runCheck — error propagation', () => {
    test('a network failure (status 0) is an ERROR, not a FAILED check', async () => {
        const provider = new GitHubProvider((async () => { throw new Error('ETIMEDOUT'); }) as FetchFn);
        const result = await provider.runCheck(checkInput());
        expect(result.status).toBe('ERROR');
        expect(result.errorMessage).toBe('ETIMEDOUT');
        expect(result.details).toEqual({ apiStatus: 0, error: 'ETIMEDOUT' });
        expect(typeof result.durationMs).toBe('number');
    });

    test('a 404 is NOT an error — it means protection is off, so the check FAILS', async () => {
        const provider = new GitHubProvider(legacyFetch(404, {}));
        const result = await provider.runCheck(checkInput());
        expect(result.status).toBe('FAILED');
        expect(result.errorMessage).toBeUndefined();
        expect(result.details.protectionEnabled).toBe(false);
    });

    test('missing token alone is refused as a config error before any fetch', async () => {
        const provider = new GitHubProvider(legacyFetch(200, {}));
        const result = await provider.runCheck(checkInput({
            connectionConfig: { owner: 'acme', repo: 'api' },
        }));
        expect(result.status).toBe('ERROR');
        expect(result.details).toEqual({ error: 'missing_config' });
        expect(result.durationMs).toBeUndefined();
    });
});

describe('GitHubProvider.mapResultToEvidence — fallbacks and FAILED rendering', () => {
    test("absent repository/branch details render as 'unknown', not undefined", () => {
        const provider = new GitHubProvider();
        const evidence = provider.mapResultToEvidence(
            checkInput(),
            { status: 'FAILED', summary: 'nope', details: {} },
        );
        expect(evidence!.title).toBe('❌ GitHub Branch Protection: unknown:unknown');
        expect(evidence!.content).toContain('**Repository:** unknown');
        expect(evidence!.content).toContain('**Branch:** unknown');
    });

    test('a FAILED result renders every negative detail and flags allowed force pushes', () => {
        const provider = new GitHubProvider();
        const evidence = provider.mapResultToEvidence(
            checkInput({ triggeredBy: 'webhook' }),
            {
                status: 'FAILED',
                summary: 'no protection',
                details: {
                    repository: 'acme/api', branch: 'main',
                    protectionEnabled: false, requiredReviews: false,
                    requiredStatusChecks: false, enforceAdmins: false,
                    allowForcePushes: true,
                },
            },
        );
        expect(evidence!.title).toContain('❌');
        expect(evidence!.content).toContain('**Triggered by:** webhook');
        expect(evidence!.content).toContain('- Protection enabled: ❌');
        expect(evidence!.content).toContain('- Required reviews: ❌');
        expect(evidence!.content).toContain('- Status checks: ❌');
        expect(evidence!.content).toContain('- Enforce admins: ❌');
        expect(evidence!.content).toContain('- Force pushes: ⚠️ Allowed');
        expect(evidence!.category).toBe('integration');
    });
});

describe('GitHubProvider.verifyWebhookSignature — which bytes get verified', () => {
    const SECRET = 'whsec_test';

    function payload(over: Partial<WebhookPayload>): WebhookPayload {
        return {
            provider: 'github',
            eventType: 'branch_protection_rule',
            headers: {},
            body: {},
            ...over,
        } as WebhookPayload;
    }

    test('verifies against rawBody even when the parsed body would re-serialise differently', () => {
        const provider = new GitHubProvider();
        const raw = '{"action":"edited",  "rule":{"name":"main"}}'; // note the extra spacing
        const sig = `sha256=${computeHmacSha256(raw, SECRET, 'hex')}`;
        const ok = provider.verifyWebhookSignature(
            payload({
                rawBody: raw,
                body: { action: 'edited', rule: { name: 'main' } },
                headers: { 'x-hub-signature-256': sig },
            }),
            SECRET,
        );
        expect(ok).toBe(true);
    });

    test('the rawBody signature is NOT satisfied by a re-serialised equivalent', () => {
        const provider = new GitHubProvider();
        const raw = '{"action":"edited",  "rule":{"name":"main"}}';
        const reserialised = JSON.stringify({ action: 'edited', rule: { name: 'main' } });
        const sig = `sha256=${computeHmacSha256(reserialised, SECRET, 'hex')}`;
        const ok = provider.verifyWebhookSignature(
            payload({
                rawBody: raw,
                body: { action: 'edited', rule: { name: 'main' } },
                headers: { 'x-hub-signature-256': sig },
            }),
            SECRET,
        );
        expect(ok).toBe(false);
    });

    test('a string body is signed as-is when no rawBody was captured', () => {
        const provider = new GitHubProvider();
        const body = '{"action":"created"}';
        const sig = `sha256=${computeHmacSha256(body, SECRET, 'hex')}`;
        const ok = provider.verifyWebhookSignature(
            payload({
                body: body as unknown as Record<string, unknown>,
                headers: { 'x-hub-signature-256': sig },
            }),
            SECRET,
        );
        expect(ok).toBe(true);
    });

    test('an object body without rawBody falls back to JSON.stringify', () => {
        const provider = new GitHubProvider();
        const obj = { action: 'edited' };
        const sig = `sha256=${computeHmacSha256(JSON.stringify(obj), SECRET, 'hex')}`;
        const ok = provider.verifyWebhookSignature(
            payload({ body: obj, headers: { 'x-hub-signature-256': sig } }),
            SECRET,
        );
        expect(ok).toBe(true);
    });
});

describe('GitHubProvider.handleWebhook — trigger matrix', () => {
    const provider = new GitHubProvider();

    function wh(eventType: string, action?: string): WebhookPayload {
        return {
            provider: 'github', eventType, headers: {},
            body: action ? { action } : {},
        } as WebhookPayload;
    }

    test('branch_protection_rule with no action still triggers', async () => {
        const result = await provider.handleWebhook(ctx, wh('branch_protection_rule'), {});
        expect(result).toEqual({ status: 'processed', triggeredKeys: ['github.branch_protection'] });
    });

    // NOTE — these three lock in CURRENT behaviour, which is over-broad: the
    // guard is `eventType === 'branch_protection_rule' || action === 'edited'
    // || action === 'created' || action === 'deleted'`, so ANY GitHub event
    // whose body carries one of those actions (issues, pull_request, release,
    // label, …) fires a branch-protection check. Reported separately; if that
    // is tightened, these expectations change with it.
    test.each(['created', 'edited', 'deleted'])(
        "a '%s' action on an unrelated event type also triggers the check (over-broad match)",
        async (action) => {
            const result = await provider.handleWebhook(ctx, wh('repository', action), {});
            expect(result).toEqual({ status: 'processed', triggeredKeys: ['github.branch_protection'] });
        },
    );

    test('an unrelated event with an unrelated action is ignored', async () => {
        const result = await provider.handleWebhook(ctx, wh('push', 'opened'), {});
        expect(result).toEqual({ status: 'ignored' });
        expect(result.triggeredKeys).toBeUndefined();
    });

    test('an unrelated event with no action at all is ignored', async () => {
        const result = await provider.handleWebhook(ctx, wh('push'), {});
        expect(result).toEqual({ status: 'ignored' });
    });
});

describe('evaluateBranchProtection — boundary arms', () => {
    function protection(over: Partial<GitHubBranchProtection>): GitHubBranchProtection {
        return {
            url: '',
            required_status_checks: null,
            enforce_admins: null,
            required_pull_request_reviews: null,
            restrictions: null,
            required_linear_history: null,
            allow_force_pushes: null,
            allow_deletions: null,
            ...over,
        };
    }

    test('a 404 wins even when a protection object was somehow supplied', () => {
        const result = evaluateBranchProtection('acme', 'api', 'main', protection({
            required_status_checks: { strict: true, contexts: ['ci'] },
            required_pull_request_reviews: {
                required_approving_review_count: 2,
                dismiss_stale_reviews: true,
                require_code_owner_reviews: true,
            },
        }), 404);
        expect(result.status).toBe('FAILED');
        expect(result.details.protectionEnabled).toBe(false);
        expect(result.summary).toBe('Branch protection is NOT enabled on acme/api:main');
    });

    test('a reviews block requiring ZERO approvals does not count as required reviews', () => {
        const result = evaluateBranchProtection('acme', 'api', 'main', protection({
            required_status_checks: { strict: true, contexts: ['ci'] },
            required_pull_request_reviews: {
                required_approving_review_count: 0,
                dismiss_stale_reviews: false,
                require_code_owner_reviews: false,
            },
        }), 200);
        expect(result.status).toBe('FAILED');
        expect(result.details.requiredReviews).toBe(false);
        expect(result.details.reviewCount).toBe(0);
        expect(result.summary).toContain('Required reviews: 0 reviewer(s)');
    });

    test('null enforce_admins / allow_force_pushes default to false in the summary', () => {
        const result = evaluateBranchProtection('acme', 'api', 'main', protection({
            required_status_checks: { strict: true, contexts: ['ci'] },
            required_pull_request_reviews: {
                required_approving_review_count: 1,
                dismiss_stale_reviews: false,
                require_code_owner_reviews: false,
            },
        }), 200);
        expect(result.status).toBe('PASSED');
        expect(result.details.enforceAdmins).toBe(false);
        expect(result.details.allowForcePushes).toBe(false);
        expect(result.summary).toContain('Enforce admins: no');
        expect(result.summary).toContain('Force pushes: blocked');
    });

    test('absent reviews render as NOT configured with a zero count', () => {
        const result = evaluateBranchProtection('acme', 'api', 'main', protection({
            required_status_checks: { strict: false, contexts: [] },
        }), 200);
        expect(result.status).toBe('FAILED');
        expect(result.summary).toContain('Required reviews: NOT configured');
        expect(result.details.reviewCount).toBe(0);
        expect(result.details.dismissStaleReviews).toBe(false);
        expect(result.details.requireCodeOwnerReviews).toBe(false);
    });
});
